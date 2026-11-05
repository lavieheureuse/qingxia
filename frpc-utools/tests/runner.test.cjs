'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const runnerlib = require('../core/runner.cjs');
const {
  createRunner,
  parseLogLine,
  parseLogLines,
  applyHintLine,
  freshHints,
  isHintsOnline,
  formatTimestamp,
  isProcessAlive,
} = runnerlib;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frpc-runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 5000);
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  throw new Error(`等待超时：${label || '条件'}`);
}

function fmtLine(level, text, date) {
  return `${date || '2026-11-05 12:34:09.941'} [${level}] [client/service.go:335] ${text}`;
}

function killTree(pid) {
  if (!pid || !isProcessAlive(pid)) return;
  try { require('node:child_process').spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// log parsing / hints
// ---------------------------------------------------------------------------

test('parseLogLine() parses level, timestamp and message', () => {
  const entry = parseLogLine('2026-11-05 12:34:09.941 [I] [client/service.go:335] login to server success, get run id [abc]');
  assert.equal(entry.level, 'info');
  assert.equal(entry.text, 'login to server success, get run id [abc]');
  assert.equal(entry.source, 'frpc');
  assert.equal(entry.at, new Date(2026, 10, 5, 12, 34, 9, 941).getTime());
  assert.equal(parseLogLine('2026-11-05 12:34:09.941 [D] [x.go:1] debug').level, 'debug');
  assert.equal(parseLogLine('2026-11-05 12:34:09.941 [W] [x.go:1] warn').level, 'warn');
  assert.equal(parseLogLine('2026-11-05 12:34:09.941 [E] [x.go:1] err').level, 'error');
  assert.equal(parseLogLine('\x1b[1;34m2026-11-05 12:34:09.941 [I] [x.go:1] colored\x1b[0m').text, 'colored');
  assert.equal(parseLogLine('no timestamp here'), null);
});

test('parseLogLines() keeps continuation lines with the previous level', () => {
  const entries = parseLogLines([fmtLine('E', 'failed to load config'), 'toml: line 3: expected value', fmtLine('I', 'next')].join('\n'));
  assert.equal(entries.length, 3);
  assert.equal(entries[0].level, 'error');
  assert.equal(entries[1].level, 'error');
  assert.equal(entries[2].level, 'info');
});

test('formatTimestamp() matches the frpc log timestamp format', () => {
  const formatted = formatTimestamp(new Date(2026, 10, 5, 12, 34, 9, 41).getTime());
  assert.equal(formatted, '2026-11-05 12:34:09.041');
});

test('log hints detect login/proxy success and failures', () => {
  const hints = freshHints();
  assert.equal(isHintsOnline(hints), false);

  applyHintLine(hints, parseLogLine(fmtLine('I', 'login to server success, get run id [abc]')));
  assert.equal(hints.loggedIn, true);
  assert.equal(isHintsOnline(hints), true);

  applyHintLine(hints, parseLogLine(fmtLine('I', '[abc] [echo] start proxy success')));
  assert.deepEqual(hints.startedProxies, ['echo']);
  assert.equal(isHintsOnline(hints), true);

  // Local dial errors are logged at [E] level but must not mark the tunnel offline.
  applyHintLine(hints, parseLogLine(fmtLine('E', '[abc] [echo] connect to local service error: refused')));
  assert.match(hints.lastError, /connect to local service error/);
  assert.equal(isHintsOnline(hints), true, '登录成功后代理本地连接错误不影响在线判定');
});

test('login failure marks the hints offline until the next success', () => {
  const hints = freshHints();
  applyHintLine(hints, parseLogLine(fmtLine('I', 'login to server success, get run id [a]')));
  assert.equal(isHintsOnline(hints), true);
  applyHintLine(hints, parseLogLine(fmtLine('E', 'login to server failed: authorization failed')));
  assert.equal(hints.loggedIn, false);
  assert.equal(isHintsOnline(hints), false);
  applyHintLine(hints, parseLogLine(fmtLine('I', 'login to server success, get run id [b]')));
  assert.equal(isHintsOnline(hints), true);
});

// ---------------------------------------------------------------------------
// pid files + process helpers
// ---------------------------------------------------------------------------

test('pid file helpers roundtrip and tolerate damage', (t) => {
  const dir = tempDir(t);
  const pidFile = path.join(dir, 'frpc.pid');
  assert.equal(runnerlib.readPidFile(pidFile), null);
  runnerlib.writePidFile(pidFile, { pid: 1234, startedAt: 111, version: '0.71.1' });
  const data = runnerlib.readPidFile(pidFile);
  assert.equal(data.pid, 1234);
  assert.equal(data.version, '0.71.1');
  assert.ok(!fs.readFileSync(pidFile).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
  fs.writeFileSync(pidFile, 'not json', 'utf8');
  assert.equal(runnerlib.readPidFile(pidFile), null);
  runnerlib.clearPidFile(pidFile);
  assert.equal(fs.existsSync(pidFile), false);
});

test('isProcessAlive() recognizes the current process and rejects bogus pids', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(999999), false);
});

// ---------------------------------------------------------------------------
// runner capture against a real child process
// ---------------------------------------------------------------------------

test('runner captures stdout/stderr into run/frpc.log and derives hints', async (t) => {
  const dir = tempDir(t);
  const logPath = path.join(dir, 'run', 'frpc.log');
  const script = [
    "const lines = [",
    "'" + fmtLine('I', 'try to connect to server...') + "',",
    "'" + fmtLine('I', '[runid] login to server success, get run id [abc]') + "',",
    "'" + fmtLine('I', '[runid] [echo] start proxy success') + "',",
    "'" + fmtLine('E', '[runid] [echo] connect to local service error: refused') + "',",
    '];',
    'for (const line of lines) console.log(line);',
    "console.error('raw panic-like line without timestamp');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const runner = createRunner({
    exePath: process.execPath,
    configPath: path.join(dir, 'run', 'frpc.toml'),
    cwd: dir,
    logPath,
    platform: process.platform,
    spawnImpl: () => spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
    timings: { killGraceMs: 1500, treeGraceMs: 2000, exitPollMs: 20 },
  });
  const pidRef = { pid: null };
  t.after(() => {
    try { runner.dispose(); } catch (_) { /* ignore */ }
    killTree(pidRef.pid);
  });
  const events = [];
  runner.onLog((entries) => events.push(...entries));

  const { pid } = runner.start();
  pidRef.pid = pid;
  assert.ok(pid > 0);
  await waitFor(() => runner.getHints().loggedIn, 5000, 'login hint');
  await waitFor(() => runner.getHints().startedProxies.length > 0, 5000, 'proxy hint');
  await waitFor(() => events.some((entry) => /panic-like/.test(entry.text)), 5000, 'stderr line capture');

  const hints = runner.getHints();
  assert.deepEqual(hints.startedProxies, ['echo']);
  assert.match(hints.lastError, /connect to local service error/);
  assert.equal(runner.isOnline(), true, '进程存活 + login success 应判为在线');
  assert.equal(runner.hasExited(), false);

  const logText = fs.readFileSync(logPath, 'utf8');
  assert.match(logText, /login to server success/);
  assert.match(logText, /start proxy success/);
  const rawLine = logText.split('\n').find((line) => line.includes('panic-like'));
  assert.match(rawLine, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[[DIWE]\] /, '无时间戳的 stderr 行应补时间戳');

  const stopped = await runner.stop();
  assert.equal(stopped.stopped, true);
  assert.equal(isProcessAlive(pid), false);
  assert.equal(runner.getPid(), null);
});

test('runner.adopt() restores hints from the existing log file', async (t) => {
  const dir = tempDir(t);
  const logPath = path.join(dir, 'run', 'frpc.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, [
    fmtLine('I', 'try to connect to server...'),
    fmtLine('I', '[runid] login to server success, get run id [abc]'),
    fmtLine('I', '[runid] [web] start proxy success'),
    '',
  ].join('\n'), 'utf8');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => { killTree(child.pid); });
  await waitFor(() => isProcessAlive(child.pid), 3000, '子进程启动');

  const runner = createRunner({
    exePath: 'ignored',
    configPath: path.join(dir, 'run', 'frpc.toml'),
    cwd: dir,
    logPath,
    platform: process.platform,
    timings: { killGraceMs: 1500, treeGraceMs: 2000, exitPollMs: 20 },
  });
  t.after(() => { try { runner.dispose(); } catch (_) { /* ignore */ } });
  runner.adopt(child.pid);
  assert.equal(runner.getPid(), child.pid);
  assert.equal(runner.getHints().loggedIn, true);
  assert.deepEqual(runner.getHints().startedProxies, ['web']);
  assert.equal(runner.isOnline(), true);
  assert.ok(runner.getRecentLines().some((line) => /login to server success/.test(line)));

  const stopped = await runner.stop();
  assert.equal(stopped.stopped, true);
  assert.equal(isProcessAlive(child.pid), false);
});

test('runner.start() surfaces spawn failures and guards double start', async (t) => {
  const dir = tempDir(t);
  const runner = createRunner({
    exePath: path.join(dir, 'missing.exe'),
    configPath: path.join(dir, 'frpc.toml'),
    cwd: dir,
    logPath: path.join(dir, 'frpc.log'),
    spawnImpl: () => { throw new Error('ENOENT simulated'); },
  });
  t.after(() => { try { runner.dispose(); } catch (_) { /* ignore */ } });
  assert.throws(() => runner.start(), (error) => {
    assert.equal(error.code, 'SPAWN_FAILED');
    assert.match(error.message, /无法启动 frpc/);
    return true;
  });

  const dir2 = tempDir(t);
  fs.writeFileSync(path.join(dir2, 'frpc.toml'), '[common]\nserver_addr = 127.0.0.1\n', 'utf8');
  const script = 'setInterval(() => {}, 1000);';
  const running = createRunner({
    exePath: process.execPath,
    configPath: path.join(dir2, 'frpc.toml'),
    cwd: dir2,
    logPath: path.join(dir2, 'frpc.log'),
    platform: process.platform,
    spawnImpl: () => spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
    timings: { killGraceMs: 1500, treeGraceMs: 2000, exitPollMs: 20 },
  });
  t.after(() => { try { running.dispose(); } catch (_) { /* ignore */ } killTree(running.getPid()); });
  const { pid } = running.start();
  t.after(() => killTree(pid));
  assert.throws(() => running.start(), /已在运行/);
  assert.equal(running.isOnline(), false, '没有 login success 日志时不算在线');
  await running.stop();
});
