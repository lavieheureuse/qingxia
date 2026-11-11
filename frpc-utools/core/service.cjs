'use strict';

// Core service for the iostool "PC sync agent" uTools plugin (SPEC-SYNC v2).
//
// This is the GUI replacement for iostool/pc/frp_sync.py:
//   fetch published config from the iostool server -> `frpc verify` staging file
//   -> backup old config -> atomic replace -> restart frpc -> wait for online
//   -> POST /frp/status back to the server.
//
// v3 adds computer-side publishing: `publishProxies(proxies)` POSTs the proxy
// list to the server (the server rebuilds frps with the new remote ports), then
// forces a sync so the local frpc applies the new version immediately.
//
// createService({dataDir, host, appVersion, platform, arch, fetchImpl, internals})
// implements SPEC-SYNC §6 exactly; State follows SPEC-SYNC §5.
//
// Safety rules:
// - The pcToken is only persisted obfuscated (store.cjs) and is redacted from
//   every log line / error message produced here.
// - Network requests go through core/node-fetch.cjs (Node http/https), never the
//   renderer's global fetch: the uTools preload runs in a page whose CSP forbids
//   cross-origin fetch, so global fetch would fail on real devices.
// - A failed verify NEVER replaces the running config and never restarts frpc.
// - A 401/400/404/network failure happens before any local config file write.
// - Closing the plugin window does not kill frpc; bootstrap re-attaches by pid.

const fs = require('node:fs');
const path = require('node:path');
const {
  createStore,
  createError,
  writeFileAtomicSync,
  DEFAULT_INTERVAL_SEC,
  INTERVAL_MIN_SEC,
  INTERVAL_MAX_SEC,
} = require('./store.cjs');
const config = require('./config.cjs');
const binary = require('./binary.cjs');
const runnerlib = require('./runner.cjs');
const { nodeFetch } = require('./node-fetch.cjs');

const LOG_LIMIT = 2000;
const REQUEST_TIMEOUT_MS = 20000;
const REPORT_TIMEOUT_MS = 10000;
const HEALTH_TIMEOUT_MS = 8000;
const SYNC_LOGIN_TIMEOUT_MS = 12000;
const START_LOGIN_TIMEOUT_MS = 6000;
const SYNC_POLL_MS = 200;
const TOKEN_HINT_PREFIX = '••••';
// Error codes that belong to the plugin contract. Node/undici errors also carry
// a `code` (ECONNREFUSED, ENOTFOUND, ...) so they must not be treated as ours.
const PLUGIN_ERROR_CODES = new Set([
  'VALIDATION', 'UNAUTHORIZED', 'NOT_FOUND', 'NETWORK', 'BINARY_MISSING',
  'CONFIG_INVALID', 'SPAWN_FAILED', 'BUSY', 'NOT_RUNNING', 'INTERNAL',
]);

function isPluginError(error) {
  return !!(error && typeof error.code === 'string' && PLUGIN_ERROR_CODES.has(error.code));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFile(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch (_) { return false; }
}

function normalizeVersion(value) {
  return String(value === null || value === undefined ? '' : value).trim().replace(/^v/i, '');
}

function emptyRemote() {
  return { reachable: false, version: null, updatedAt: null, fetchedAt: null, proxies: [], error: null };
}

function emptyLastSync() {
  return { at: null, ok: null, action: null, version: null, error: null };
}

function tokenHint(token) {
  if (!token) return '';
  const tail = token.length <= 4 ? token : token.slice(-4);
  return TOKEN_HINT_PREFIX + tail;
}

const PUBLISH_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validate + normalize a proxy list for `publishProxies`.
 * Mirrors the server contract (server/frp_config_api.py validate_proxies) so bad
 * input is rejected locally before any network request or file write.
 * Throws VALIDATION with a user-presentable Chinese message.
 */
function validatePublishProxies(proxies) {
  if (!Array.isArray(proxies)) throw createError('VALIDATION', '代理列表必须是数组');
  const names = new Set();
  const enabledRemotePorts = new Map();
  const normalized = [];
  for (let index = 0; index < proxies.length; index += 1) {
    const input = proxies[index];
    const label = `第 ${index + 1} 条代理`;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw createError('VALIDATION', `${label}格式不正确`);
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!PUBLISH_NAME_RE.test(name)) {
      throw createError('VALIDATION', `代理名「${name || '(空)'}」无效：只能包含字母、数字、下划线、短横线，最长 64 个字符`);
    }
    const type = typeof input.type === 'string' ? input.type.trim().toLowerCase() : '';
    if (type !== 'tcp') throw createError('VALIDATION', `代理「${name}」类型只支持 tcp`);
    const localIp = typeof input.localIp === 'string' ? input.localIp.trim() : '';
    if (!localIp) throw createError('VALIDATION', `代理「${name}」的本地地址不能为空`);
    if (/[\r\n]/.test(localIp)) throw createError('VALIDATION', `代理「${name}」的本地地址不能包含换行符`);
    const localPort = input.localPort;
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
      throw createError('VALIDATION', `代理「${name}」的本地端口须为 1-65535 的整数`);
    }
    const remotePort = input.remotePort;
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      throw createError('VALIDATION', `代理「${name}」的远程端口须为 1-65535 的整数`);
    }
    const enabled = input.enabled === undefined ? true : input.enabled;
    if (typeof enabled !== 'boolean') {
      throw createError('VALIDATION', `代理「${name}」的启用状态必须是布尔值`);
    }
    if (names.has(name)) throw createError('VALIDATION', `代理名「${name}」重复了，请使用唯一名称`);
    names.add(name);
    if (enabled) {
      if (enabledRemotePorts.has(remotePort)) {
        throw createError('VALIDATION', `远程端口 ${remotePort} 被多个已启用代理共用（${enabledRemotePorts.get(remotePort)} 与 ${name}）`);
      }
      enabledRemotePorts.set(remotePort, name);
    }
    normalized.push({ name, type: 'tcp', localIp, localPort, remotePort, enabled });
  }
  return normalized;
}

/**
 * createService({dataDir, host, appVersion, platform, arch, fetchImpl})
 *
 * Optional `internals` is a test seam only (createRunner, detectVersion,
 * verifyConfig, downloadBinary, listVersions); preload.js passes exactly the
 * SPEC-SYNC §6 fields.
 */
function createService(options) {
  const opts = options || {};
  const dataDir = typeof opts.dataDir === 'string' && opts.dataDir.trim() ? path.resolve(opts.dataDir) : null;
  if (!dataDir) throw createError('INTERNAL', '缺少插件数据目录（dataDir）');
  const host = opts.host || null;
  const appVersion = String(opts.appVersion || '0.1.0');
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : nodeFetch;
  const internals = opts.internals && typeof opts.internals === 'object' ? opts.internals : {};

  const store = createStore(dataDir);
  const dirs = {
    data: dataDir,
    run: path.join(dataDir, 'run'),
    bin: path.join(dataDir, 'bin'),
    logs: path.join(dataDir, 'logs'),
  };
  const settingsPath = store.settingsPath;
  const configPath = config.configPathFor(dirs.run);
  const backupPath = config.backupPathFor(dirs.run);
  const pidFile = path.join(dirs.run, 'frpc.pid');
  const syncLogPath = path.join(dirs.logs, 'sync.log');

  let settings = store.read();
  let disposed = false;
  let booted = false;
  let bootPromise = null;
  let queue = Promise.resolve();

  let phase = 'boot';
  let transientPhase = null;
  let remote = emptyRemote();
  let applied = { version: null, at: null, configPath, backupPath: null };
  let frpcState = {
    running: false,
    pid: null,
    startedAt: null,
    exitedAt: null,
    exitCode: null,
    logHints: { loggedIn: false, startedProxies: [], lastError: null },
  };
  let binaryInfo = {
    status: 'missing',
    path: path.join(dirs.bin, 'frpc.exe'),
    version: '',
    source: 'downloaded',
    download: null,
  };
  let autoSync = { enabled: settings.autoSync.enabled, intervalSec: settings.autoSync.intervalSec, startOnLaunch: settings.autoSync.startOnLaunch, nextAt: null };
  let lastSync = emptyLastSync();
  let lastError = null;

  let runner = null;
  let exitUnsubscribe = null;
  let logUnsubscribe = null;
  let stopping = false;
  let syncInProgress = false;
  let downloading = false;
  let lastProgressEmitAt = 0;
  let autoTimer = null;

  const stateListeners = new Set();
  const logListeners = new Set();
  const logs = [];
  let nextLogId = 1;
  const secrets = new Set();

  // --------------------------------------------------------------------
  // small helpers
  // --------------------------------------------------------------------

  function assertNotDisposed() {
    if (disposed) throw createError('INTERNAL', '插件核心服务已释放，请重新打开窗口');
  }

  function registerSecret(value) {
    if (typeof value === 'string' && value.length >= 4) secrets.add(value);
  }

  /** Remove every known secret (pcToken / frps token) from user visible text. */
  function redact(text) {
    let out = String(text === null || text === undefined ? '' : text);
    for (const secret of secrets) {
      if (!secret) continue;
      out = out.split(secret).join('••••');
    }
    return out;
  }

  function isConfigured() {
    return !!(settings.connection.apiBase && settings.connection.pcId && settings.connection.pcToken);
  }

  function setLastError(code, message) {
    lastError = { code: code || 'INTERNAL', message: redact(message), at: Date.now() };
  }

  function clearLastError() {
    lastError = null;
  }

  function syncHints() {
    if (runner) frpcState.logHints = runner.getHints();
  }

  function isFrpcOnline() {
    return !!(frpcState.running && runner && runner.isOnline());
  }

  function computePhase() {
    if (transientPhase) return transientPhase;
    if (!isConfigured()) return 'unconfigured';
    if (lastSync && lastSync.action === 'fail') return 'error';
    if (frpcState.running) return isFrpcOnline() ? 'online' : 'offline';
    if (frpcState.exitedAt && frpcState.exitCode !== null && frpcState.exitCode !== 0) return 'error';
    if (applied.version !== null) return 'offline';
    return 'idle';
  }

  function refreshPhase() {
    phase = computePhase();
  }

  function snapshot() {
    const connection = settings.connection;
    return {
      phase,
      connection: {
        apiBase: connection.apiBase,
        pcId: connection.pcId,
        hasToken: !!connection.pcToken,
        tokenHint: tokenHint(connection.pcToken),
      },
      remote: {
        reachable: !!remote.reachable,
        version: remote.version,
        updatedAt: remote.updatedAt,
        fetchedAt: remote.fetchedAt,
        proxies: remote.proxies.map((proxy) => Object.assign({}, proxy)),
        error: remote.error,
      },
      applied: {
        version: applied.version,
        at: applied.at,
        configPath: applied.configPath,
        backupPath: applied.backupPath,
        proxies: (applied.proxies || []).map((proxy) => Object.assign({}, proxy)),
      },
      frpc: {
        running: !!frpcState.running,
        pid: frpcState.pid,
        startedAt: frpcState.startedAt,
        exitedAt: frpcState.exitedAt,
        exitCode: frpcState.exitCode,
        logHints: {
          loggedIn: !!frpcState.logHints.loggedIn,
          startedProxies: frpcState.logHints.startedProxies.slice(),
          lastError: frpcState.logHints.lastError || null,
        },
        binary: {
          status: binaryInfo.status,
          path: binaryInfo.path,
          version: binaryInfo.version,
          source: binaryInfo.source,
          download: binaryInfo.download ? Object.assign({}, binaryInfo.download) : null,
        },
      },
      autoSync: {
        enabled: !!autoSync.enabled,
        intervalSec: autoSync.intervalSec,
        startOnLaunch: autoSync.startOnLaunch,
        nextAt: autoSync.nextAt,
      },
      lastSync: Object.assign({}, lastSync),
      lastError: lastError ? Object.assign({}, lastError) : null,
    };
  }

  function emitState() {
    if (!stateListeners.size) return;
    const state = snapshot();
    for (const listener of Array.from(stateListeners)) {
      try { listener(state); } catch (_) { /* isolate UI listeners */ }
    }
  }

  function appendLog(raw) {
    const entry = {
      id: nextLogId++,
      at: Number.isFinite(raw && raw.at) ? raw.at : Date.now(),
      source: raw && raw.source === 'frpc' ? 'frpc' : 'sync',
      level: ['debug', 'info', 'warn', 'error'].includes(raw && raw.level) ? raw.level : 'info',
      text: redact(String(raw && raw.text !== undefined ? raw.text : '')),
    };
    logs.push(entry);
    if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
    return entry;
  }

  function emitLogBatch(entries) {
    if (!entries.length || !logListeners.size) return;
    const batch = entries.map((entry) => Object.assign({}, entry));
    for (const listener of Array.from(logListeners)) {
      try { listener(batch); } catch (_) { /* isolate UI listeners */ }
    }
  }

  /** Plugin-side sync log: ring buffer + logs/sync.log file (never token). */
  function logSync(level, text) {
    const entry = appendLog({ at: Date.now(), level, text, source: 'sync' });
    emitLogBatch([entry]);
    try {
      fs.mkdirSync(dirs.logs, { recursive: true });
      fs.appendFileSync(syncLogPath, `${new Date().toISOString()} [${level.toUpperCase()}] ${entry.text}\n`, 'utf8');
    } catch (_) { /* logging must never break sync */ }
  }

  function ingestFrpcEntries(entries) {
    if (!Array.isArray(entries) || !entries.length) return;
    const items = entries.map((entry) => appendLog(Object.assign({}, entry, { source: 'frpc' })));
    emitLogBatch(items);
    if (!runner) return;
    const hints = runner.getHints();
    const changed = JSON.stringify(hints) !== JSON.stringify(frpcState.logHints);
    frpcState.logHints = hints;
    if (changed && frpcState.running) {
      refreshPhase();
      emitState();
    }
  }

  function enqueue(task) {
    const result = queue.then(task, task);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function ensureBooted() {
    if (disposed) throw createError('INTERNAL', '插件核心服务已释放，请重新打开窗口');
    if (!booted) {
      try {
        await bootstrap();
      } catch (error) {
        if (error && error.code) throw error;
        throw createError('INTERNAL', `初始化失败：${error && error.message ? error.message : '未知错误'}`, { cause: error });
      }
    }
  }

  // --------------------------------------------------------------------
  // binary
  // --------------------------------------------------------------------

  async function detectVersionSafe(exePath) {
    const detect = typeof internals.detectVersion === 'function' ? internals.detectVersion : binary.detectVersion;
    try { return await detect(exePath); } catch (_) { return null; }
  }

  async function initBinary() {
    const configured = settings.frpc && settings.frpc.path ? String(settings.frpc.path).trim() : '';
    const candidates = [];
    if (configured) {
      candidates.push({ path: configured, source: settings.frpc.source === 'custom' ? 'custom' : 'downloaded' });
    }
    const downloaded = path.join(dirs.bin, 'frpc.exe');
    if (!configured || path.resolve(configured) !== path.resolve(downloaded)) {
      candidates.push({ path: downloaded, source: 'downloaded' });
    }
    let found = null;
    for (const candidate of candidates) {
      if (!isFile(candidate.path)) continue;
      let version = null;
      if (path.resolve(candidate.path) === path.resolve(configured) && settings.frpc.version) {
        version = String(settings.frpc.version);
      }
      if (!version) version = await detectVersionSafe(candidate.path);
      if (!version) continue;
      found = { path: candidate.path, version, source: candidate.source };
      break;
    }
    if (found) {
      binaryInfo = { status: 'ready', path: found.path, version: found.version, source: found.source, download: binaryInfo.download };
      const changed = !settings.frpc
        || settings.frpc.path !== found.path
        || settings.frpc.version !== found.version
        || settings.frpc.source !== found.source;
      if (changed) {
        settings.frpc = { path: found.path, version: found.version, source: found.source };
        try { settings = store.write(settings); } catch (_) { /* settings remain usable in memory */ }
      }
    } else {
      binaryInfo = {
        status: 'missing',
        path: configured || downloaded,
        version: '',
        source: configured ? 'custom' : 'downloaded',
        download: binaryInfo.download,
      };
    }
  }

  function applyBinaryReady(result) {
    binaryInfo = {
      status: 'ready',
      path: result.path,
      version: result.version,
      source: result.source || 'downloaded',
      download: binaryInfo.download,
    };
    settings.frpc = { path: result.path, version: result.version, source: result.source || 'downloaded' };
    try { settings = store.write(settings); } catch (_) { /* keep in-memory */ }
  }

  function listVersions() {
    const lister = typeof internals.listVersions === 'function' ? internals.listVersions : binary.listVersions;
    return lister({ fetchImpl });
  }

  function downloadBinary(version) {
    return enqueue(async () => {
      await ensureBooted();
      const targetVersion = normalizeVersion(version);
      if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) {
        throw createError('VALIDATION', '版本号格式不正确，示例：0.71.1');
      }
      if (frpcState.running) throw createError('BUSY', '请先停止 frpc 再下载新版本');
      if (downloading) throw createError('BUSY', '正在下载中，请稍候');
      downloading = true;
      lastProgressEmitAt = 0;
      binaryInfo.download = {
        active: true,
        version: targetVersion,
        percent: 0,
        receivedBytes: 0,
        totalBytes: 0,
        error: null,
      };
      emitState();
      const downloader = typeof internals.downloadBinary === 'function' ? internals.downloadBinary : binary.download;
      try {
        const result = await downloader({
          version: targetVersion,
          arch,
          binDir: dirs.bin,
          platform,
          fetchImpl,
          onProgress: (progress) => {
            const download = binaryInfo.download;
            if (!download || !download.active) return;
            if (typeof progress.percent === 'number') download.percent = progress.percent;
            if (Number.isInteger(progress.receivedBytes)) download.receivedBytes = progress.receivedBytes;
            if (Number.isInteger(progress.totalBytes)) download.totalBytes = progress.totalBytes;
            const now = Date.now();
            if (now - lastProgressEmitAt >= 100) {
              lastProgressEmitAt = now;
              emitState();
            }
          },
        });
        if (!result || !result.path || !result.version) throw createError('NETWORK', '下载完成但未得到可用的 frpc.exe，请重试');
        const received = binaryInfo.download ? binaryInfo.download.receivedBytes : 0;
        const total = binaryInfo.download ? binaryInfo.download.totalBytes : 0;
        binaryInfo.download = { active: false, version: result.version, percent: 100, receivedBytes: received, totalBytes: total, error: null };
        applyBinaryReady({ path: result.path, version: result.version, source: 'downloaded' });
        clearLastError();
        logSync('info', `已下载并安装 frpc ${binaryInfo.version}`);
        return publish();
      } catch (error) {
        const message = redact(error && error.message ? error.message : '下载失败，请稍后重试');
        binaryInfo.download = {
          active: false,
          version: targetVersion,
          percent: -1,
          receivedBytes: binaryInfo.download ? binaryInfo.download.receivedBytes : 0,
          totalBytes: binaryInfo.download ? binaryInfo.download.totalBytes : 0,
          error: message,
        };
        setLastError('NETWORK', message);
        logSync('error', `下载 frpc 失败：${message}`);
        emitState();
        throw createError('NETWORK', message, { cause: error });
      } finally {
        downloading = false;
      }
    });
  }

  function setBinaryPath(filePath) {
    return enqueue(async () => {
      await ensureBooted();
      return setBinaryPathInternal(filePath);
    });
  }

  async function setBinaryPathInternal(filePath) {
    if (frpcState.running) throw createError('BUSY', '请先停止 frpc 再切换二进制文件');
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw createError('VALIDATION', '请选择 frpc.exe 文件');
    }
    const resolved = path.resolve(filePath.trim());
    let stat;
    try { stat = fs.statSync(resolved); } catch (_) {
      throw createError('VALIDATION', `指定的文件不存在：${resolved}`);
    }
    if (!stat.isFile()) throw createError('VALIDATION', '指定的路径不是文件');
    const version = await detectVersionSafe(resolved);
    if (!version) throw createError('VALIDATION', '无法运行该文件，请确认选择的是 frpc.exe');
    applyBinaryReady({ path: resolved, version, source: 'custom' });
    clearLastError();
    logSync('info', `已切换 frpc：${resolved}（${version}）`);
    return publish();
  }

  function hostDialog(dialogOptions) {
    if (!host || typeof host.showOpenDialog !== 'function') {
      throw createError('INTERNAL', '当前宿主不支持打开文件选择框');
    }
    return Promise.resolve(host.showOpenDialog(dialogOptions));
  }

  function pickBinary() {
    return enqueue(async () => {
      await ensureBooted();
      let selected;
      try {
        selected = await hostDialog({
          title: '选择 frpc.exe',
          properties: ['openFile'],
          filters: [{ name: 'frpc 可执行文件', extensions: ['exe', ''] }],
        });
      } catch (error) {
        throw createError('INTERNAL', `打开文件选择框失败：${redact(error.message)}`, { cause: error });
      }
      const file = Array.isArray(selected) ? selected[0] : (typeof selected === 'string' ? selected : null);
      if (!file) return snapshot();
      return setBinaryPathInternal(file);
    });
  }

  // --------------------------------------------------------------------
  // HTTP / iostool API
  // --------------------------------------------------------------------

  // Never fall back to the renderer's global fetch (CSP blocked in real uTools).
  function getFetchImpl() {
    return fetchImpl || nodeFetch;
  }

  function serverErrorText(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const text = typeof payload.error === 'string' ? payload.error : (typeof payload.message === 'string' ? payload.message : '');
    return redact(text).slice(0, 200);
  }

  async function requestJson(method, apiPath, options) {
    const requestOptions = options || {};
    const fetchFn = getFetchImpl();
    if (!fetchFn) throw createError('NETWORK', '当前运行环境不支持网络请求，请升级 uTools');
    const base = String(settings.connection.apiBase || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) throw createError('VALIDATION', 'API 地址需以 http:// 或 https:// 开头');
    const url = base + apiPath;
    const timeoutMs = requestOptions.timeoutMs || REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const headers = { Accept: 'application/json' };
      if (requestOptions.auth !== false) headers.Authorization = `Bearer ${settings.connection.pcToken}`;
      if (requestOptions.body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetchFn(url, {
        method,
        headers,
        body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
        signal: controller.signal,
        redirect: 'follow',
      });
      const status = response.status;
      let text = '';
      try { text = await response.text(); } catch (_) { /* ignore body read errors */ }
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch (_) { payload = null; }
      if (status === 401) {
        throw createError('UNAUTHORIZED', '电脑 Token 无效或与电脑 ID 不匹配（401 未授权）');
      }
      if (status === 404) {
        throw createError('NOT_FOUND', serverErrorText(payload) || '这台电脑还没有发布过的配置，请先在手机端发布');
      }
      if (status === 400) {
        const detail = serverErrorText(payload);
        throw createError('VALIDATION', detail || '请求参数不合法（HTTP 400）');
      }
      if (!response.ok) {
        const detail = serverErrorText(payload);
        throw createError('NETWORK', `服务器返回 HTTP ${status}${detail ? `：${detail}` : ''}`);
      }
      if (payload === null) throw createError('INTERNAL', '服务器返回内容不是有效 JSON');
      return payload;
    } catch (error) {
      if (isPluginError(error)) throw error;
      if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
        throw createError('NETWORK', `请求超时（${Math.round(timeoutMs / 1000)} 秒），请检查 API 地址和网络`);
      }
      throw createError('NETWORK', `无法连接服务器：${redact(error && error.message ? error.message : '网络错误')}（请检查 API 地址、网络或代理设置）`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchRemoteConfig() {
    const pcId = settings.connection.pcId;
    const payload = await requestJson('GET', `/frp/config?pcId=${encodeURIComponent(pcId)}`, { auth: true });
    const version = Number(payload.version);
    if (!Number.isInteger(version) || version < 0) {
      throw createError('INTERNAL', '服务器返回的版本号无效');
    }
    const text = typeof payload.config === 'string' ? payload.config : '';
    const parsed = config.parseIni(text);
    if (parsed.common.token) registerSecret(parsed.common.token);
    return {
      version,
      text,
      updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
      proxies: parsed.proxies,
      common: parsed.common,
    };
  }

  function applyRemoteMetadata(data) {
    remote = {
      reachable: true,
      version: data.version,
      updatedAt: data.updatedAt,
      fetchedAt: Date.now(),
      proxies: Array.isArray(data.proxies) ? data.proxies : [],
      error: null,
    };
  }

  async function reportStatus(payload) {
    if (!isConfigured()) return { ok: false, error: '尚未配置连接，跳过状态回传' };
    try {
      await requestJson('POST', '/frp/status', {
        auth: true,
        timeoutMs: REPORT_TIMEOUT_MS,
        body: {
          pcId: settings.connection.pcId,
          version: Number.isInteger(payload.version) ? payload.version : 0,
          applied: !!payload.applied,
          frpcRunning: !!payload.frpcRunning,
          error: payload.error ? redact(String(payload.error)).slice(0, 500) : null,
          checkedAt: new Date().toISOString(),
        },
      });
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: redact(error && error.message ? error.message : '状态回传失败') };
    }
  }

  // --------------------------------------------------------------------
  // startup / takeover
  // --------------------------------------------------------------------

  function restoreAppliedState() {
    const version = config.readAppliedVersion(dirs.run);
    const hasConfig = isFile(configPath);
    let backup = null;
    if (isFile(backupPath)) backup = backupPath;
    applied = { version: hasConfig ? version : null, at: null, configPath, backupPath: backup, proxies: [] };
    if (!hasConfig && version !== null) config.clearAppliedVersion(dirs.run);
    if (applied.version !== null) {
      try { applied.at = fs.statSync(config.versionPathFor(dirs.run)).mtimeMs; } catch (_) { /* ignore */ }
      applied.proxies = readAppliedProxies();
    }
  }

  /** 从本机已生效的配置里解析出代理列表（服务器不可达时 UI 可以回退展示）。 */
  function readAppliedProxies() {
    try {
      const text = config.readText(configPath);
      if (!text) return [];
      return config.parseIni(text).proxies.map((proxy) => Object.assign({}, proxy));
    } catch (_) {
      return [];
    }
  }

  function disposeRunner() {
    if (exitUnsubscribe) { try { exitUnsubscribe(); } catch (_) { /* ignore */ } }
    exitUnsubscribe = null;
    if (logUnsubscribe) { try { logUnsubscribe(); } catch (_) { /* ignore */ } }
    logUnsubscribe = null;
    if (runner) {
      try { runner.dispose(); } catch (_) { /* ignore */ }
    }
    runner = null;
  }

  function ensureRunner() {
    if (runner) return runner;
    const factory = typeof internals.createRunner === 'function' ? internals.createRunner : runnerlib.createRunner;
    runner = factory({
      exePath: binaryInfo.path,
      configPath,
      cwd: dirs.run,
      logPath: path.join(dirs.run, 'frpc.log'),
      platform,
      spawnImpl: internals.spawnImpl,
      timings: internals.timings,
      // 分离启动：插件进程（uTools）退出后 frpc 仍继续运行，
      // 日志走文件采集而不是 stdout 管道。
      detach: true,
    });
    logUnsubscribe = runner.onLog(ingestFrpcEntries);
    watchExit();
    return runner;
  }

  function watchExit() {
    if (!runner) return;
    if (exitUnsubscribe) { try { exitUnsubscribe(); } catch (_) { /* ignore */ } }
    exitUnsubscribe = runner.onExit(handleUnexpectedExit);
  }

  function handleUnexpectedExit(info) {
    if (disposed || stopping) return;
    syncHints();
    const exitCode = info && Number.isInteger(info.code) ? info.code : null;
    frpcState.running = false;
    frpcState.pid = null;
    frpcState.exitedAt = (info && info.at) || Date.now();
    frpcState.exitCode = exitCode;
    runnerlib.clearPidFile(pidFile);
    const hints = frpcState.logHints;
    const failed = !!(hints.lastError) || (exitCode !== null && exitCode !== 0);
    if (failed && (!lastSync || lastSync.action !== 'fail')) {
      const detail = hints.lastError ? `：${hints.lastError}` : '';
      const codeText = exitCode !== null ? `（退出码 ${exitCode}）` : '';
      setLastError('SPAWN_FAILED', `frpc 进程已退出${codeText}${detail}`);
      logSync('error', lastError.message);
    } else if (!failed) {
      logSync('warn', 'frpc 进程已退出');
    }
    refreshPhase();
    emitState();
    void reportStatus({
      version: applied.version === null ? 0 : applied.version,
      applied: applied.version !== null,
      frpcRunning: false,
      error: lastError ? lastError.message : null,
    });
  }

  async function takeOverExistingProcess() {
    const pidData = runnerlib.readPidFile(pidFile);
    if (!pidData) return false;
    if (!runnerlib.isProcessAlive(pidData.pid)) {
      runnerlib.clearPidFile(pidFile);
      return false;
    }
    frpcState = {
      running: true,
      pid: pidData.pid,
      startedAt: Number(pidData.startedAt) || null,
      exitedAt: null,
      exitCode: null,
      logHints: { loggedIn: false, startedProxies: [], lastError: null },
    };
    ensureRunner();
    runner.adopt(pidData.pid);
    syncHints();
    logSync('info', `已接管运行中的 frpc（pid ${pidData.pid}）`);
    return true;
  }

  async function doBootstrap() {
    assertNotDisposed();
    fs.mkdirSync(dirs.run, { recursive: true });
    fs.mkdirSync(dirs.bin, { recursive: true });
    fs.mkdirSync(dirs.logs, { recursive: true });
    settings = store.read();
    registerSecret(settings.connection.pcToken);
    autoSync = { enabled: settings.autoSync.enabled || settings.autoSync.startOnLaunch, intervalSec: settings.autoSync.intervalSec, startOnLaunch: settings.autoSync.startOnLaunch, nextAt: null };
    await initBinary();
    restoreAppliedState();
    await takeOverExistingProcess();
    refreshPhase();
    logSync('info', isConfigured()
      ? `插件已就绪（本机已应用版本：${applied.version === null ? '无' : `v${applied.version}`}）`
      : '尚未配置电脑连接，请在「连接设置」填写 API 地址、电脑 ID 与 Token');
    scheduleAutoSync(settings.autoSync.startOnLaunch);
    booted = true;
    emitState();
    return snapshot();
  }

  function bootstrap() {
    assertNotDisposed();
    if (!bootPromise) {
      bootPromise = doBootstrap().catch((error) => {
        bootPromise = null;
        if (error && error.code) throw error;
        throw createError('INTERNAL', `初始化失败：${error && error.message ? error.message : '未知错误'}`, { cause: error });
      });
    }
    return bootPromise.then(() => snapshot());
  }

  // --------------------------------------------------------------------
  // connection settings
  // --------------------------------------------------------------------

  function validateApiBase(value) {
    if (typeof value !== 'string' || !value.trim()) throw createError('VALIDATION', '请填写 API 地址');
    const text = value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/i.test(text)) throw createError('VALIDATION', 'API 地址需以 http:// 或 https:// 开头');
    if (/\s/.test(text)) throw createError('VALIDATION', 'API 地址不能包含空格');
    return text;
  }

  function validatePcId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.trim())) {
      throw createError('VALIDATION', '电脑 ID 只能包含字母、数字、下划线、短横线（最长 64 个字符）');
    }
    return value.trim();
  }

  function saveConnection(patch) {
    return enqueue(async () => {
      await ensureBooted();
      const input = patch && typeof patch === 'object' ? patch : {};
      const next = Object.assign({}, settings.connection);
      if ('apiBase' in input) next.apiBase = validateApiBase(input.apiBase);
      if ('pcId' in input) next.pcId = validatePcId(input.pcId);
      if ('pcToken' in input) {
        if (typeof input.pcToken !== 'string') throw createError('VALIDATION', '电脑 Token 必须是字符串');
        next.pcToken = input.pcToken.trim();
      }
      const changed = next.apiBase !== settings.connection.apiBase
        || next.pcId !== settings.connection.pcId
        || next.pcToken !== settings.connection.pcToken;
      settings.connection = next;
      settings = store.write(settings);
      registerSecret(next.pcToken);
      if (changed) {
        remote = emptyRemote();
        lastSync = emptyLastSync();
        clearLastError();
      }
      refreshPhase();
      logSync('info', changed ? '连接设置已更新' : '连接设置未变化');
      emitState();
      return snapshot();
    });
  }

  function testConnection() {
    return Promise.resolve().then(async () => {
      try {
        await ensureBooted();
        if (!settings.connection.pcToken) {
          throw createError('VALIDATION', '请先填写电脑 Token');
        }
        if (!settings.connection.apiBase || !settings.connection.pcId) {
          throw createError('VALIDATION', '请先填写 API 地址和电脑 ID');
        }
        await requestJson('GET', '/health', { auth: false, timeoutMs: HEALTH_TIMEOUT_MS });
        let data;
        try {
          data = await fetchRemoteConfig();
        } catch (error) {
          remote = Object.assign({}, remote, { reachable: false, fetchedAt: Date.now(), error: redact(error.message) });
          throw error;
        }
        applyRemoteMetadata(data);
        clearLastError();
        refreshPhase();
        emitState();
        logSync('info', `连接测试成功：手机已发布 v${data.version}`);
        return {
          ok: true,
          message: `连接成功，手机已发布 v${data.version}`,
          version: data.version,
          updatedAt: data.updatedAt || undefined,
        };
      } catch (error) {
        const code = error && error.code ? error.code : 'NETWORK';
        const message = redact(error && error.message ? error.message : '连接失败');
        if (code !== 'VALIDATION') {
          remote = Object.assign({}, remote, { reachable: false, error: message, fetchedAt: remote.fetchedAt });
          setLastError(code, message);
        }
        logSync('error', `连接测试失败：${message}`);
        refreshPhase();
        emitState();
        return { ok: false, code, message };
      }
    });
  }

  // --------------------------------------------------------------------
  // frpc start / stop / online waiting
  // --------------------------------------------------------------------

  async function spawnFrpc() {
    if (binaryInfo.status !== 'ready') {
      throw createError('BINARY_MISSING', '尚未安装 frpc，请先下载或手动指定 frpc.exe 路径');
    }
    if (!isFile(configPath)) {
      throw createError('CONFIG_INVALID', '还没有生效配置，请先立即同步');
    }
    disposeRunner();
    ensureRunner();
    stopping = false;
    const spawned = runner.start();
    frpcState = {
      running: true,
      pid: spawned.pid,
      startedAt: Date.now(),
      exitedAt: null,
      exitCode: null,
      logHints: { loggedIn: false, startedProxies: [], lastError: null },
    };
    runnerlib.writePidFile(pidFile, { pid: spawned.pid, startedAt: frpcState.startedAt, version: binaryInfo.version });
    logSync('info', `frpc 已启动（pid ${spawned.pid}）`);
    emitState();
    return frpcState.pid;
  }

  async function stopFrpcProcess() {
    const currentPid = frpcState.pid;
    stopping = true;
    try {
      if (runner) await runner.stop();
    } finally {
      stopping = false;
    }
    if (currentPid && runnerlib.isProcessAlive(currentPid)) {
      await runnerlib.taskkillTree(currentPid, 3000);
    }
    if (currentPid && runnerlib.isProcessAlive(currentPid)) {
      const message = `无法终止 frpc 进程 ${currentPid}，请以管理员身份手动结束该进程`;
      setLastError('INTERNAL', message);
      logSync('error', message);
      throw createError('INTERNAL', message);
    }
    runnerlib.clearPidFile(pidFile);
    syncHints();
    frpcState = {
      running: false,
      pid: null,
      startedAt: null,
      exitedAt: Date.now(),
      exitCode: null,
      logHints: frpcState.logHints,
    };
    logSync('info', 'frpc 已停止');
    return snapshot();
  }

  async function waitForFrpcOnline(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (disposed) return false;
      if (!frpcState.running) {
        syncHints();
        return false;
      }
      const hints = runner ? runner.getHints() : frpcState.logHints;
      const changed = JSON.stringify(hints) !== JSON.stringify(frpcState.logHints);
      frpcState.logHints = hints;
      if (runner && runner.isOnline()) {
        refreshPhase();
        emitState();
        return true;
      }
      if (changed) {
        refreshPhase();
        emitState();
      }
      await sleep(SYNC_POLL_MS);
    }
    syncHints();
    return false;
  }

  async function startFrpcInternal() {
    if (frpcState.running) throw createError('BUSY', 'frpc 已在运行');
    if (binaryInfo.status !== 'ready') {
      throw createError('BINARY_MISSING', '尚未安装 frpc，请先下载或手动指定 frpc.exe 路径');
    }
    if (!isFile(configPath)) throw createError('CONFIG_INVALID', '还没有生效配置，请先立即同步');
    transientPhase = 'applying';
    lastError = null;
    refreshPhase();
    emitState();
    try {
      await spawnFrpc();
      const online = await waitForFrpcOnline(START_LOGIN_TIMEOUT_MS);
      transientPhase = null;
      if (!online && !frpcState.running) {
        const message = lastError ? lastError.message : 'frpc 启动后已退出，请查看 frpc 日志';
        lastSync = { at: Date.now(), ok: false, action: 'fail', version: applied.version, error: message };
        setLastError('SPAWN_FAILED', message);
        logSync('error', message);
        refreshPhase();
        emitState();
        throw createError('SPAWN_FAILED', message);
      }
      lastSync = {
        at: Date.now(),
        ok: true,
        action: 'report',
        version: applied.version,
        error: online ? null : 'frpc 已启动，但尚未确认登录成功',
      };
      if (online) clearLastError();
      else logSync('warn', 'frpc 已启动，但尚未确认登录成功，请查看 frpc 日志');
      refreshPhase();
      emitState();
      const report = await reportStatus({
        version: applied.version === null ? 0 : applied.version,
        applied: applied.version !== null,
        frpcRunning: frpcState.running,
        error: online ? null : 'frpc 已启动，但尚未确认登录成功',
      });
      if (!report.ok) {
        setLastError('NETWORK', `状态回传失败：${report.error}`);
        logSync('warn', `状态回传失败：${report.error}`);
        refreshPhase();
        emitState();
      }
      return snapshot();
    } catch (error) {
      transientPhase = null;
      const code = error && error.code ? error.code : 'SPAWN_FAILED';
      if (!lastSync || lastSync.action !== 'fail') {
        const message = redact(error && error.message ? error.message : 'frpc 启动失败');
        lastSync = { at: Date.now(), ok: false, action: 'fail', version: applied.version, error: message };
        setLastError(code, message);
        logSync('error', message);
      }
      refreshPhase();
      emitState();
      throw error && error.code ? error : createError('SPAWN_FAILED', redact(error && error.message ? error.message : 'frpc 启动失败'));
    }
  }

  function startFrpc() {
    return enqueue(async () => {
      await ensureBooted();
      if (!isConfigured()) throw createError('VALIDATION', '请先在「连接设置」填写 API 地址、电脑 ID 和 Token');
      return startFrpcInternal();
    });
  }

  function stopFrpc() {
    return enqueue(async () => {
      await ensureBooted();
      if (!frpcState.running) throw createError('NOT_RUNNING', 'frpc 当前未运行');
      transientPhase = 'applying';
      refreshPhase();
      emitState();
      let result;
      try {
        result = await stopFrpcProcess();
      } finally {
        transientPhase = null;
      }
      lastSync = { at: Date.now(), ok: true, action: 'report', version: applied.version, error: null };
      clearLastError();
      refreshPhase();
      emitState();
      const report = await reportStatus({
        version: applied.version === null ? 0 : applied.version,
        applied: applied.version !== null,
        frpcRunning: false,
        error: null,
      });
      if (!report.ok) {
        setLastError('NETWORK', `状态回传失败：${report.error}`);
        logSync('warn', `状态回传失败：${report.error}`);
        refreshPhase();
        emitState();
      }
      return snapshot();
    });
  }

  function restartFrpc() {
    return enqueue(async () => {
      await ensureBooted();
      if (!isConfigured()) throw createError('VALIDATION', '请先在「连接设置」填写 API 地址、电脑 ID 和 Token');
      transientPhase = 'applying';
      refreshPhase();
      emitState();
      transientPhase = null;
      try {
        if (frpcState.running) await stopFrpcProcess();
        return await startFrpcInternal();
      } finally {
        transientPhase = null;
        refreshPhase();
        emitState();
      }
    });
  }

  // --------------------------------------------------------------------
  // sync
  // --------------------------------------------------------------------

  function verifyStagingFile(stagingPath) {
    const verify = typeof internals.verifyConfig === 'function' ? internals.verifyConfig : config.verifyConfig;
    return verify(stagingPath, binaryInfo.path);
  }

  async function failSync(payload) {
    const message = redact(payload.message);
    transientPhase = null;
    lastSync = {
      at: Date.now(),
      ok: false,
      action: 'fail',
      version: Number.isInteger(payload.version) ? payload.version : null,
      error: message,
    };
    setLastError(payload.code || 'INTERNAL', message);
    logSync('error', message);
    if (payload.reportIt) {
      const report = await reportStatus({
        version: Number.isInteger(payload.version) ? payload.version : 0,
        applied: !!payload.appliedFlag,
        frpcRunning: !!frpcState.running,
        error: message,
      });
      if (!report.ok) logSync('warn', `状态回传失败：${report.error}`);
    }
    refreshPhase();
    emitState();
  }

  async function restartFrpcForSync() {
    if (frpcState.running) {
      stopping = true;
      try {
        if (runner) await runner.stop();
      } finally {
        stopping = false;
      }
      runnerlib.clearPidFile(pidFile);
      frpcState = { running: false, pid: null, startedAt: null, exitedAt: Date.now(), exitCode: null, logHints: frpcState.logHints };
    }
    await spawnFrpc();
  }

  async function syncInternal(options) {
    const syncOptions = options || {};
    assertNotDisposed();
    if (syncInProgress) throw createError('BUSY', '正在同步中，请稍候');
    if (!isConfigured()) throw createError('VALIDATION', '请先在「连接设置」填写 API 地址、电脑 ID 和 Token');
    if (binaryInfo.status !== 'ready') {
      throw createError('BINARY_MISSING', '尚未安装 frpc，请先下载或手动指定 frpc.exe 路径');
    }
    syncInProgress = true;
    transientPhase = 'syncing';
    lastSync = { at: Date.now(), ok: null, action: null, version: null, error: null };
    refreshPhase();
    emitState();
    let remoteData = null;
    try {
      try {
        remoteData = await fetchRemoteConfig();
      } catch (error) {
        const message = redact(error && error.message ? error.message : '拉取配置失败');
        remote = Object.assign({}, remote, { reachable: false, fetchedAt: Date.now(), error: message });
        lastSync = { at: Date.now(), ok: false, action: 'fail', version: null, error: message };
        setLastError(error && error.code ? error.code : 'NETWORK', message);
        logSync('error', `拉取配置失败：${message}`);
        throw error;
      }
      applyRemoteMetadata(remoteData);
      const version = remoteData.version;

      if (!remoteData.text || !remoteData.text.trim()) {
        const message = '服务器返回的配置为空，本次不应用';
        await failSync({ version, code: 'CONFIG_INVALID', message, appliedFlag: applied.version !== null, reportIt: true });
        throw createError('CONFIG_INVALID', message);
      }

      // Same version already applied and frpc alive -> skip (SPEC-SYNC §3/§8).
      // `force` (publishProxies / "从服务器恢复") bypasses the shortcut and
      // re-verifies + reinstalls + restarts even when the version is unchanged.
      if (!syncOptions.force && applied.version === version && frpcState.running) {
        lastSync = { at: Date.now(), ok: true, action: 'skip', version, error: null };
        transientPhase = null;
        refreshPhase();
        emitState();
        logSync('info', `v${version} 已是当前版本且 frpc 运行中，跳过应用`);
        return snapshot();
      }

      transientPhase = 'applying';
      refreshPhase();
      emitState();
      logSync('info', syncOptions.force
        ? `强制重新应用 v${version} 配置`
        : `发现新版本 v${version}，开始校验配置`);

      config.writeTempConfig(dirs.run, remoteData.text);
      let verifyResult;
      try {
        verifyResult = await verifyStagingFile(config.tempPathFor(dirs.run));
      } catch (error) {
        verifyResult = { ok: false, message: redact(error && error.message ? error.message : '校验过程异常') };
      }
      if (!verifyResult || !verifyResult.ok) {
        config.removeTempConfig(dirs.run);
        const detail = redact((verifyResult && verifyResult.message) || '未知错误');
        const message = `v${version} 配置校验失败：${detail}`;
        await failSync({ version, code: 'CONFIG_INVALID', message, appliedFlag: false, reportIt: true });
        throw createError('CONFIG_INVALID', message);
      }

      // Verify passed: keep a backup, then atomically replace the live config.
      const installed = config.installConfig(dirs.run, remoteData.text);
      applied = {
        version,
        at: Date.now(),
        configPath: installed.configPath,
        backupPath: installed.backupPath,
        proxies: config.parseIni(remoteData.text).proxies.map((proxy) => Object.assign({}, proxy)),
      };
      config.writeAppliedVersion(dirs.run, version);
      logSync('info', `已应用 v${version} 配置${installed.backupPath ? '，旧配置已备份' : ''}`);

      let spawnError = null;
      try {
        await restartFrpcForSync();
      } catch (error) {
        spawnError = error;
      }
      if (spawnError) {
        const message = `v${version} 配置已写入，但 frpc 启动失败：${redact(spawnError.message)}`;
        await failSync({ version, code: spawnError.code || 'SPAWN_FAILED', message, appliedFlag: true, reportIt: true });
        throw createError('SPAWN_FAILED', message, { cause: spawnError });
      }

      const online = await waitForFrpcOnline(SYNC_LOGIN_TIMEOUT_MS);
      if (!online) {
        const message = frpcState.running
          ? `v${version} 配置已写入、frpc 已启动，但 ${Math.round(SYNC_LOGIN_TIMEOUT_MS / 1000)} 秒内未确认登录成功，请查看 frpc 日志`
          : `v${version} 配置已写入，但 frpc 启动后已退出，请查看 frpc 日志`;
        await failSync({ version, code: 'SPAWN_FAILED', message, appliedFlag: true, reportIt: true });
        throw createError('SPAWN_FAILED', message);
      }

      lastSync = { at: Date.now(), ok: true, action: 'apply', version, error: null };
      transientPhase = null;
      clearLastError();
      refreshPhase();
      emitState();
      logSync('info', `v${version} 已生效，frpc 运行中（pid ${frpcState.pid}）`);
      const report = await reportStatus({
        version,
        applied: true,
        frpcRunning: frpcState.running,
        error: null,
      });
      if (!report.ok) {
        lastSync = { at: Date.now(), ok: true, action: 'report', version, error: `状态回传失败：${report.error}` };
        setLastError('NETWORK', `状态回传失败：${report.error}`);
        logSync('warn', `状态回传失败：${report.error}`);
        refreshPhase();
        emitState();
      }
      return snapshot();
    } finally {
      syncInProgress = false;
      transientPhase = null;
      if (!disposed) {
        if (phase === 'syncing' || phase === 'applying') refreshPhase();
        emitState();
      }
    }
  }

  function syncNow(options) {
    const syncOptions = options && typeof options === 'object' ? options : {};
    return enqueue(async () => {
      await ensureBooted();
      return syncInternal({ manual: true, force: syncOptions.force === true });
    });
  }

  /**
   * publishProxies(proxies) -> Promise<State>
   *
   * Publishes the full proxy list for this pcId through the server's publish
   * endpoint using the pcToken (the server owns frps container port publishing),
   * then forces a sync so the new version is verified/applied/restarted and the
   * status is reported back immediately.
   *
   * Error mapping: 401 -> UNAUTHORIZED, 400 -> VALIDATION (server `error` text),
   * network/timeout -> NETWORK. Nothing is written locally before the server
   * accepts the publish.
   */
  function publishProxies(proxies) {
    return enqueue(async () => {
      await ensureBooted();
      if (!isConfigured()) {
        throw createError('VALIDATION', '请先在「连接设置」填写 API 地址、电脑 ID 和 Token');
      }
      if (syncInProgress) throw createError('BUSY', '正在同步中，请稍候');
      const normalized = validatePublishProxies(proxies);
      logSync('info', `正在发布 ${normalized.length} 条代理配置到服务器…`);
      let published;
      try {
        published = await requestJson('POST', '/frp/config', {
          auth: true,
          body: {
            pcId: settings.connection.pcId,
            proxies: normalized,
          },
        });
      } catch (error) {
        const message = redact(error && error.message ? error.message : '发布配置失败');
        setLastError(error && error.code ? error.code : 'NETWORK', message);
        logSync('error', `发布配置失败：${message}`);
        refreshPhase();
        emitState();
        throw error;
      }
      const version = Number(published && published.version);
      if (!Number.isInteger(version) || version <= 0) {
        const message = '服务器返回的发布版本号无效，无法确认发布结果';
        setLastError('INTERNAL', message);
        logSync('error', message);
        refreshPhase();
        emitState();
        throw createError('INTERNAL', message);
      }

      // Reflect the just-published version immediately; the forced sync below
      // fetches the authoritative config/version from the server.
      remote = {
        reachable: true,
        version,
        updatedAt: typeof published.updatedAt === 'string' ? published.updatedAt : remote.updatedAt,
        fetchedAt: Date.now(),
        proxies: normalized.map((proxy) => Object.assign({}, proxy)),
        error: null,
      };
      transientPhase = 'syncing';
      refreshPhase();
      emitState();
      logSync('info', `已发布 v${version}，开始同步应用`);
      return syncInternal({ manual: true, force: true });
    });
  }

  // --------------------------------------------------------------------
  // auto sync
  // --------------------------------------------------------------------

  function scheduleAutoSync(immediate = false) {
    if (autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }
    if (disposed || !autoSync.enabled) {
      autoSync.nextAt = null;
      return;
    }
    const delay = immediate ? 0 : Math.max(INTERVAL_MIN_SEC, autoSync.intervalSec) * 1000;
    autoSync.nextAt = Date.now() + delay;
    autoTimer = setTimeout(runAutoSyncTick, delay);
    if (typeof autoTimer.unref === 'function') autoTimer.unref();
  }

  function runAutoSyncTick() {
    autoTimer = null;
    if (disposed || !autoSync.enabled) return;
    autoSync.nextAt = null;
    enqueue(async () => {
      if (disposed || !autoSync.enabled) return;
      if (binaryInfo.status !== 'ready') {
        lastSync = { at: Date.now(), ok: false, action: 'skip', version: remote.version, error: '尚未安装 frpc' };
        refreshPhase();
        emitState();
      } else if (!isConfigured()) {
        lastSync = { at: Date.now(), ok: false, action: 'skip', version: null, error: '尚未配置电脑连接' };
        refreshPhase();
        emitState();
      } else {
        try {
          await syncInternal({ manual: false });
        } catch (_) {
          // syncInternal already recorded lastSync/lastError and reported when possible.
        }
      }
      if (autoSync.enabled && !disposed) scheduleAutoSync();
      else refreshPhase();
      emitState();
    }).catch(() => {});
  }

  function setStartOnLaunch(enabled) {
    return enqueue(async () => {
      await ensureBooted();
      if (typeof enabled !== 'boolean') throw createError('VALIDATION', '启动时自动同步开关必须是布尔值');
      settings.autoSync.startOnLaunch = enabled;
      settings = store.write(settings);
      autoSync.startOnLaunch = enabled;
      emitState();
      return snapshot();
    });
  }

  function setAutoSync(enabled, intervalSec) {
    return enqueue(async () => {
      await ensureBooted();
      if (typeof enabled !== 'boolean') throw createError('VALIDATION', '自动同步开关必须是布尔值');
      const interval = intervalSec === undefined || intervalSec === null
        ? settings.autoSync.intervalSec
        : Number(intervalSec);
      if (!Number.isInteger(interval) || interval < INTERVAL_MIN_SEC || interval > INTERVAL_MAX_SEC) {
        throw createError('VALIDATION', `同步间隔须为 ${INTERVAL_MIN_SEC}-${INTERVAL_MAX_SEC} 秒`);
      }
      settings.autoSync = { ...settings.autoSync, enabled, intervalSec: interval };
      settings = store.write(settings);
      autoSync.enabled = enabled;
      autoSync.intervalSec = interval;
      scheduleAutoSync();
      logSync('info', enabled ? `自动同步已开启（每 ${interval} 秒）` : '自动同步已关闭');
      refreshPhase();
      emitState();
      return snapshot();
    });
  }

  // --------------------------------------------------------------------
  // config / host / logs
  // --------------------------------------------------------------------

  function publish() {
    emitState();
    return snapshot();
  }

  function getConfigText() {
    return Promise.resolve().then(() => {
      let text = '';
      try { text = fs.readFileSync(configPath, 'utf8'); } catch (_) { text = ''; }
      return { text, path: configPath, version: applied.version, format: 'ini' };
    });
  }

  function verifyConfig() {
    return enqueue(async () => {
      await ensureBooted();
      if (binaryInfo.status !== 'ready') {
        throw createError('BINARY_MISSING', '尚未安装 frpc，请先下载或手动指定 frpc.exe 路径');
      }
      let text = '';
      try { text = fs.readFileSync(configPath, 'utf8'); } catch (_) { text = ''; }
      if (!text.trim()) {
        return { ok: false, message: '还没有生效配置，请先立即同步或等待自动同步' };
      }
      config.writeTempConfig(dirs.run, text);
      try {
        const result = await verifyStagingFile(config.tempPathFor(dirs.run));
        return {
          ok: !!(result && result.ok),
          message: result && result.ok ? '配置校验通过' : redact((result && result.message) || '配置校验失败'),
        };
      } finally {
        config.removeTempConfig(dirs.run);
      }
    });
  }

  function openHostPath(target, label) {
    const openPath = (host && typeof host.shellOpenPath === 'function' ? host.shellOpenPath : null)
      || (host && host.shell && typeof host.shell.openPath === 'function' ? host.shell.openPath : null)
      || (host && typeof host.openPath === 'function' ? host.openPath : null);
    if (!openPath) throw createError('INTERNAL', '当前宿主不支持打开文件或文件夹');
    return Promise.resolve(openPath.call(host, target)).then((result) => {
      if (typeof result === 'string' && result.trim()) {
        throw createError('INTERNAL', `无法打开${label}：${result.trim()}`);
      }
    });
  }

  function openConfigFile() {
    return Promise.resolve().then(async () => {
      await ensureBooted();
      if (!isFile(configPath)) throw createError('NOT_FOUND', '配置文件还不存在，请先立即同步');
      await openHostPath(configPath, '配置文件');
    });
  }

  function openFolder(kind) {
    return Promise.resolve().then(async () => {
      await ensureBooted();
      const map = { data: dirs.data, bin: dirs.bin, log: dirs.logs, run: dirs.run };
      if (!Object.prototype.hasOwnProperty.call(map, kind)) {
        throw createError('VALIDATION', '只能打开 data/bin/log/run 四种目录');
      }
      const target = map[kind];
      fs.mkdirSync(target, { recursive: true });
      await openHostPath(target, '文件夹');
    });
  }

  function copyText(text) {
    return Promise.resolve().then(() => {
      if (typeof text !== 'string') throw createError('VALIDATION', '复制内容必须是字符串');
      const copy = host && typeof host.copyText === 'function' ? host.copyText : null;
      if (!copy) throw createError('INTERNAL', '当前宿主不支持复制到剪贴板');
      copy.call(host, text);
    });
  }

  function getLogs(filter) {
    return Promise.resolve().then(() => {
      if (filter !== undefined && filter !== 'sync' && filter !== 'frpc') {
        throw createError('VALIDATION', '日志筛选只能是 sync 或 frpc');
      }
      return logs
        .filter((entry) => filter === undefined || entry.source === filter)
        .map((entry) => Object.assign({}, entry));
    });
  }

  function clearLogs() {
    return enqueue(async () => {
      logs.length = 0;
      return publish();
    });
  }

  function getState() {
    return snapshot();
  }

  function onState(callback) {
    if (typeof callback !== 'function') return () => {};
    stateListeners.add(callback);
    return () => stateListeners.delete(callback);
  }

  function onLog(callback) {
    if (typeof callback !== 'function') return () => {};
    logListeners.add(callback);
    return () => logListeners.delete(callback);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = null;
    if (exitUnsubscribe) { try { exitUnsubscribe(); } catch (_) { /* ignore */ } }
    exitUnsubscribe = null;
    if (logUnsubscribe) { try { logUnsubscribe(); } catch (_) { /* ignore */ } }
    logUnsubscribe = null;
    // Deliberately does NOT kill frpc: the pid file lets the next window re-attach.
    if (runner) {
      try { runner.dispose(); } catch (_) { /* ignore */ }
    }
    runner = null;
    stateListeners.clear();
    logListeners.clear();
    bootPromise = null;
  }

  function shutdown() {
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = null;
    return enqueue(async () => {
      if (disposed) return;
      await ensureBooted();
      if (autoTimer) clearTimeout(autoTimer);
      autoTimer = null;
      if (frpcState.running) await stopFrpcProcess();
    });
  }

  return {
    // lifecycle
    bootstrap,
    dispose,
    shutdown,
    resumeAfterCancelledExit: scheduleAutoSync,
    getState,
    onState,
    onLog,
    // connection
    saveConnection,
    testConnection,
    // sync
    syncNow,
    publishProxies,
    setAutoSync,
    setStartOnLaunch,
    // frpc process
    startFrpc,
    stopFrpc,
    restartFrpc,
    // config
    getConfigText,
    verifyConfig,
    // binary
    listVersions,
    downloadBinary,
    pickBinary,
    setBinaryPath,
    // hosts / utilities
    openFolder,
    openConfigFile,
    copyText,
    getLogs,
    clearLogs,
    // extras (not part of the bridge contract, harmless)
    appVersion,
    dataDir,
    settingsPath,
  };
}

module.exports = { createService };
