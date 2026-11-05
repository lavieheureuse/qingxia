'use strict';

// frpc process runner for the sync-proxy model (SPEC-SYNC v2).
//
// The server-delivered config has no webServer section, so there is NO admin API.
// Instead the runner captures frpc's stdout/stderr, appends it to run/frpc.log
// (timestamps normalised to the frpc log format) and derives online hints from
// the log lines:
//   `login to server success`, `[<proxy>] start proxy success`,
//   `start error`, `login to server failed`.
//
// It also owns the pid file helpers and the ordered stop sequence
// (kill -> wait -> taskkill /T /F) and can adopt a process started by a
// previous plugin window (stop works from the pid alone).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createError, writeFileAtomicSync } = require('./store.cjs');

const LOG_LEVELS = { D: 'debug', I: 'info', W: 'warn', E: 'error' };
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const LOG_TAIL_BYTES = 512 * 1024;
const RECENT_LINE_LIMIT = 20;
const DEFAULT_TIMINGS = {
  killGraceMs: 2000,
  treeGraceMs: 3000,
  exitPollMs: 100,
};

const LOG_LINE_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s+\[([DIWE])\]\s+(?:\[([^\]]+)\]\s*)?(.*)$/;
const TIMESTAMPED_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[.,]\d{3}\s+\[[DIWE]\]/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad(value, length) {
  return String(value).padStart(length, '0');
}

/** Local `YYYY-MM-DD HH:mm:ss.SSS` — the timestamp format frpc itself uses. */
function formatTimestamp(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)} `
    + `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.`
    + `${pad(date.getMilliseconds(), 3)}`;
}

function stripAnsi(line) {
  return String(line === null || line === undefined ? '' : line).replace(ANSI_RE, '');
}

/** Parse one frpc log line: `2026-11-05 12:34:09.941 [I] [file.go:line] msg`. */
function parseLogLine(line, fallbackAt) {
  const raw = stripAnsi(line);
  const match = LOG_LINE_RE.exec(raw);
  if (!match) return null;
  const at = new Date(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]), Number(match[7]),
  ).getTime();
  return {
    at: Number.isFinite(at) ? at : (fallbackAt || Date.now()),
    level: LOG_LEVELS[match[8]] || 'info',
    text: String(match[10] || '').trim(),
    source: 'frpc',
  };
}

/**
 * Parse a chunk of log text. Unrecognised non-empty lines (stack traces, panic
 * output) inherit the previous level so errors stay readable.
 */
function parseLogLines(text, options) {
  const opts = options || {};
  const fallbackAt = opts.fallbackAt || Date.now();
  const entries = [];
  for (const line of String(text || '').split('\n')) {
    const cleaned = stripAnsi(line).replace(/\r$/, '');
    if (!cleaned.trim()) continue;
    const parsed = parseLogLine(cleaned, fallbackAt);
    if (parsed) {
      entries.push(parsed);
      continue;
    }
    const previous = entries[entries.length - 1];
    entries.push({
      at: fallbackAt,
      level: previous ? previous.level : 'info',
      text: cleaned.trim(),
      source: 'frpc',
    });
  }
  return entries;
}

/** Fresh online-detection hints; reset on every new frpc start. */
function freshHints() {
  return {
    loggedIn: false,
    startedProxies: [],
    lastError: null,
    lastLoginSuccessAt: null,
    lastLoginFailAt: null,
    lastSuccessAt: null,
    lastFatalAt: null,
    lastErrorAt: null,
  };
}

/** Update hints from one parsed log entry. */
function applyHintLine(hints, entry) {
  const text = entry.text;
  const at = entry.at;
  if (/login to server success/i.test(text)) {
    hints.loggedIn = true;
    hints.lastLoginSuccessAt = at;
    hints.lastSuccessAt = at;
  } else if (/login to server failed/i.test(text)) {
    hints.loggedIn = false;
    hints.lastLoginFailAt = at;
    hints.lastError = text;
    hints.lastErrorAt = at;
  }
  const proxyStart = /\[([^\[\]]+)\]\s+start proxy success/i.exec(text);
  if (proxyStart) {
    const name = proxyStart[1];
    if (!hints.startedProxies.includes(name)) hints.startedProxies.push(name);
    hints.lastSuccessAt = at;
  }
  if (/start (?:proxy )?error|proxy start error/i.test(text)) {
    hints.lastError = text;
    hints.lastFatalAt = at;
    hints.lastErrorAt = at;
  }
  if (entry.level === 'error') {
    hints.lastError = text;
    hints.lastErrorAt = at;
  }
}

function shortHints(hints) {
  return {
    loggedIn: !!hints.loggedIn,
    startedProxies: hints.startedProxies.slice(),
    lastError: hints.lastError || null,
  };
}

function isHintsOnline(hints) {
  if (!hints) return false;
  const hasSuccess = hints.loggedIn || hints.startedProxies.length > 0;
  if (!hasSuccess) return false;
  if (hints.lastLoginFailAt && (!hints.lastLoginSuccessAt || hints.lastLoginFailAt > hints.lastLoginSuccessAt)) return false;
  return true;
}

function readFileTail(filePath, maxBytes) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return ''; }
  if (!stat.isFile() || stat.size === 0) return '';
  const start = Math.max(0, stat.size - maxBytes);
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    const read = fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, read).toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline >= 0 ? text.slice(newline + 1) : '';
    }
    return text;
  } catch (_) {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!(error && error.code === 'EPERM');
  }
}

/** Terminate a single pid; returns true when the process is gone (or was already). */
function killProcess(pid) {
  if (!isProcessAlive(pid)) return true;
  try {
    process.kill(pid);
  } catch (_) {
    return !isProcessAlive(pid);
  }
  return !isProcessAlive(pid);
}

async function waitForExit(pid, timeoutMs, pollMs) {
  const interval = Number.isInteger(pollMs) ? pollMs : 100;
  const deadline = Date.now() + (Number.isInteger(timeoutMs) ? timeoutMs : 2000);
  for (;;) {
    if (!isProcessAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(interval);
  }
}

/** Windows force tree kill: `taskkill /PID <pid> /T /F` (no-op elsewhere). */
function taskkillTree(pid, timeoutMs) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      try { process.kill(pid, 'SIGKILL'); } catch (_) { /* ignore */ }
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch (_) {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* ignore */ }
      finish(false);
    }, Number.isInteger(timeoutMs) ? timeoutMs : 3000);
    if (typeof timer.unref === 'function') timer.unref();
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

// ---------------------------------------------------------------------------
// pid file helpers (run/frpc.pid per SPEC-SYNC §4)
// ---------------------------------------------------------------------------

function readPidFile(pidFile) {
  try {
    const data = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    if (!data || !Number.isInteger(data.pid) || data.pid <= 0) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function writePidFile(pidFile, data) {
  try {
    writeFileAtomicSync(pidFile, JSON.stringify(data, null, 2) + '\n');
  } catch (_) {
    // A missing pid file only loses re-attach support; never fail the start.
  }
}

function clearPidFile(pidFile) {
  try { fs.rmSync(pidFile, { force: true }); } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

/**
 * createRunner({exePath, configPath, cwd, logPath, platform, spawnImpl, timings})
 * Methods: start(), adopt(pid), stop(), getPid(), isAlive(), hasExited(),
 * getExitInfo(), getHints(), isOnline(), getRecentLines(), onExit(cb),
 * onLog(cb), dispose().
 */
function createRunner(options) {
  const opts = options || {};
  const timings = Object.assign({}, DEFAULT_TIMINGS, opts.timings || {});
  const spawnImpl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : spawn;
  const platform = opts.platform || process.platform;
  const logPath = opts.logPath;
  // detach=true：frpc 以分离进程启动，stdout/stderr 直接重定向到 logPath，
  // 父进程（uTools 插件进程）退出后 frpc 仍能继续跑；日志通过轮询文件增量采集。
  const detach = opts.detach === true;

  let child = null;
  let pid = null;
  let exitInfo = null;
  let disposed = false;
  let hints = freshHints();
  const recentLines = [];
  const exitListeners = new Set();
  const logListeners = new Set();
  const pendingByStream = { stdout: '', stderr: '' };
  let logPollTimer = null;
  let logOffset = 0;
  let filePending = '';

  function emitExit(info) {
    if (exitInfo) return;
    exitInfo = info;
    for (const listener of Array.from(exitListeners)) {
      try { listener(info); } catch (_) { /* listener errors are isolated */ }
    }
  }

  function emitLogs(entries) {
    if (!entries.length || !logListeners.size) return;
    const batch = entries.map((entry) => Object.assign({}, entry));
    for (const listener of Array.from(logListeners)) {
      try { listener(batch); } catch (_) { /* listener errors are isolated */ }
    }
  }

  function appendLogLine(text) {
    if (!logPath) return;
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, text + '\n', 'utf8');
    } catch (_) { /* logging must never break the runner */ }
  }

  function recordLine(rawLine) {
    const cleaned = stripAnsi(rawLine).replace(/\r$/, '');
    const text = cleaned.trim();
    if (!text) return null;
    const formatted = TIMESTAMPED_RE.test(text) ? text : `${formatTimestamp(Date.now())} [I] [stdout] ${text}`;
    // 分离模式下 frpc 直接把日志写进 logPath，不能重复追加。
    if (!detach) appendLogLine(formatted);
    const entry = parseLogLine(formatted) || { at: Date.now(), level: 'info', text: formatted, source: 'frpc' };
    applyHintLine(hints, entry);
    recentLines.push(entry.text);
    if (recentLines.length > RECENT_LINE_LIMIT) recentLines.shift();
    return entry;
  }

  /** 读取日志文件自 logOffset 起的新增内容，按行解析。文件被截断则从头读。 */
  function readNewLogLines() {
    if (!logPath) return [];
    let stat;
    try { stat = fs.statSync(logPath); } catch (_) { return []; }
    if (stat.size < logOffset) { logOffset = 0; filePending = ''; }
    if (stat.size === logOffset) return [];
    const length = stat.size - logOffset;
    const buffer = Buffer.alloc(length);
    let fd = null;
    try {
      fd = fs.openSync(logPath, 'r');
      const read = fs.readSync(fd, buffer, 0, length, logOffset);
      logOffset += read;
      if (read < length) filePending += buffer.subarray(0, read).toString('utf8');
      else filePending += buffer.toString('utf8');
    } catch (_) {
      return [];
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
    }
    const parts = filePending.split('\n');
    filePending = parts.pop();
    const entries = [];
    for (const part of parts) {
      const entry = recordLine(part);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  function stopFileCapture() {
    if (logPollTimer) clearInterval(logPollTimer);
    logPollTimer = null;
  }

  function startFileCapture(fromOffset) {
    stopFileCapture();
    logOffset = Number.isFinite(fromOffset) ? fromOffset : 0;
    filePending = '';
    logPollTimer = setInterval(() => {
      try {
        const entries = readNewLogLines();
        if (entries.length) emitLogs(entries);
      } catch (_) { /* 采集失败不影响进程管理 */ }
    }, Number.isFinite(timings.logPollMs) ? timings.logPollMs : 300);
    if (typeof logPollTimer.unref === 'function') logPollTimer.unref();
  }

  function flushPending(streamName) {
    const pending = pendingByStream[streamName];
    if (!pending) return null;
    pendingByStream[streamName] = '';
    return recordLine(pending);
  }

  function attachStream(stream, streamName) {
    if (!stream || typeof stream.on !== 'function') return;
    if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      try {
        let text = pendingByStream[streamName] + String(chunk);
        const parts = text.split('\n');
        pendingByStream[streamName] = parts.pop();
        const entries = [];
        for (const part of parts) {
          const entry = recordLine(part);
          if (entry) entries.push(entry);
        }
        emitLogs(entries);
      } catch (_) { /* capture must never crash the runner */ }
    });
  }

  function attach(spawned) {
    child = spawned;
    pid = Number.isInteger(spawned.pid) && spawned.pid > 0 ? spawned.pid : null;
    spawned.on('exit', (code, signal) => {
      for (const streamName of ['stdout', 'stderr']) {
        const entry = flushPending(streamName);
        if (entry) emitLogs([entry]);
      }
      emitExit({ code, signal, at: Date.now() });
    });
    spawned.on('error', (error) => {
      emitExit({ code: null, signal: null, at: Date.now(), error });
    });
    attachStream(spawned.stdout, 'stdout');
    attachStream(spawned.stderr, 'stderr');
  }

  function start() {
    if (disposed) throw createError('INTERNAL', '运行器已释放');
    if (pid) throw createError('BUSY', 'frpc 已在运行');
    if (!opts.exePath) throw createError('BINARY_MISSING', '尚未安装 frpc，请先下载或手动指定路径');
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, '');
    } catch (_) { /* log capture best effort */ }
    hints = freshHints();
    recentLines.length = 0;
    pendingByStream.stdout = '';
    pendingByStream.stderr = '';
    exitInfo = null;
    let spawned;
    let logFd = null;
    try {
      if (detach && logPath) {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        logFd = fs.openSync(logPath, 'a');
      }
      const stdio = detach
        ? ['ignore', logFd === null ? 'ignore' : logFd, logFd === null ? 'ignore' : logFd]
        : ['ignore', 'pipe', 'pipe'];
      spawned = spawnImpl(opts.exePath, ['-c', opts.configPath], {
        cwd: opts.cwd,
        windowsHide: true,
        detached: detach,
        stdio,
      });
    } catch (error) {
      throw createError('SPAWN_FAILED', `无法启动 frpc：${error.message}`, { cause: error });
    } finally {
      if (logFd !== null) { try { fs.closeSync(logFd); } catch (_) { /* ignore */ } }
    }
    attach(spawned);
    if (!pid) {
      throw createError('SPAWN_FAILED', '无法启动 frpc：进程创建失败（请检查二进制路径）');
    }
    if (detach) {
      try { spawned.unref(); } catch (_) { /* ignore */ }
      startFileCapture(0);
    }
    return { pid };
  }

  /** Take over a process started by a previous plugin window (no child handle). */
  function adopt(existingPid) {
    pid = Number.isInteger(existingPid) && existingPid > 0 ? existingPid : null;
    child = null;
    exitInfo = null;
    hints = freshHints();
    recentLines.length = 0;
    const tail = readFileTail(logPath, LOG_TAIL_BYTES);
    if (tail) {
      const entries = parseLogLines(tail);
      for (const entry of entries) {
        applyHintLine(hints, entry);
        recentLines.push(entry.text);
      }
      while (recentLines.length > RECENT_LINE_LIMIT) recentLines.shift();
    }
    // 接管后继续采集日志文件的新增部分（分离进程不再有 stdout 管道）。
    let offset = 0;
    try { offset = fs.statSync(logPath).size; } catch (_) { offset = 0; }
    startFileCapture(offset);
    return pid;
  }

  function getPid() { return pid; }
  function getExitInfo() { return exitInfo; }
  function hasExited() { return exitInfo !== null || (pid !== null && !isProcessAlive(pid)); }
  function isAlive() { return pid !== null && isProcessAlive(pid); }
  function getHints() { return shortHints(hints); }
  function getRecentLines() { return recentLines.slice(); }
  function isOnline() { return pid !== null && isProcessAlive(pid) && isHintsOnline(hints); }

  function onExit(listener) {
    if (typeof listener !== 'function') return () => {};
    exitListeners.add(listener);
    return () => exitListeners.delete(listener);
  }

  function onLog(listener) {
    if (typeof listener !== 'function') return () => {};
    logListeners.add(listener);
    return () => logListeners.delete(listener);
  }

  async function waitGone(targetPid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (exitInfo) return true;
      if (!isProcessAlive(targetPid)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(timings.exitPollMs);
    }
  }

  /**
   * Stop frpc: graceful kill -> wait 2s -> taskkill /T /F -> wait. Clears the
   * local pid afterwards; returns {stopped, forced}.
   */
  async function stop() {
    const targetPid = pid;
    if (!targetPid) return { stopped: true, forced: false };
    let forced = false;
    try {
      if (child && typeof child.kill === 'function') child.kill();
      else killProcess(targetPid);
    } catch (_) { /* fall through to taskkill */ }
    if (!(await waitGone(targetPid, timings.killGraceMs))) {
      forced = true;
      if (platform === 'win32') await taskkillTree(targetPid, timings.treeGraceMs);
      else try { process.kill(targetPid, 'SIGKILL'); } catch (_) { /* ignore */ }
      await waitGone(targetPid, timings.treeGraceMs);
    }
    const gone = !isProcessAlive(targetPid);
    pid = null;
    child = null;
    stopFileCapture();
    return { stopped: gone, forced };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    exitListeners.clear();
    logListeners.clear();
    stopFileCapture();
    if (child) {
      try { child.removeAllListeners('exit'); } catch (_) { /* ignore */ }
      try { child.removeAllListeners('error'); } catch (_) { /* ignore */ }
      if (child.stdout && typeof child.stdout.removeAllListeners === 'function') child.stdout.removeAllListeners('data');
      if (child.stderr && typeof child.stderr.removeAllListeners === 'function') child.stderr.removeAllListeners('data');
      // Do NOT kill frpc: the pid file lets the next plugin window re-attach.
    }
    child = null;
  }

  return {
    start,
    adopt,
    stop,
    getPid,
    isAlive,
    hasExited,
    getExitInfo,
    getHints,
    isOnline,
    getRecentLines,
    onExit,
    onLog,
    dispose,
  };
}

module.exports = {
  createRunner,
  parseLogLine,
  parseLogLines,
  applyHintLine,
  freshHints,
  isHintsOnline,
  isProcessAlive,
  killProcess,
  taskkillTree,
  waitForExit,
  readPidFile,
  writePidFile,
  clearPidFile,
  readFileTail,
  formatTimestamp,
  LOG_LEVELS,
};
