'use strict';

// 核心业务协调层：管理连接状态、轮询、UAC Busy 锁、退出清理与退出取消恢复。
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_CONFIG, DEFAULT_SOCKET, DEFAULT_TUN, validateAuthKeyInput, validateAuthUrl } = require('./config.cjs');
const { parseStatusJson, parsePingOutput, extractAuthUrlFromText } = require('./status.cjs');
const { analyzeDiagnostics } = require('./diagnostics.cjs');
const { redactError, redactText } = require('./redact.cjs');

const POLL_INTERVAL_MS = 3000;
const MAX_PLUGIN_LOGS = 200;

function createService(deps) {
  const {
    dataDir,
    host,
    platform = process.platform,
    arch = process.arch,
    fetchImpl,
    store,
    binary,
    daemon,
    ps,
    supportsExit = Boolean(host && typeof host.onPluginExit === 'function'),
  } = deps;

  if (!dataDir) throw new Error('dataDir 不能为空');

  const pluginLogFile = path.join(dataDir, 'logs', 'plugin.log');
  const stateListeners = new Set();
  const logListeners = new Set();

  let state = {
    initialized: false,
    platformSupported: platform === 'win32',
    supportsExit,
    exiting: false,
    busy: false,
    busyMessage: '',
    phase: 'stopped', // stopped | starting | needs_login | connected | error
    backendState: 'Stopped',
    daemonRunning: false,
    pid: null,
    socket: DEFAULT_SOCKET,
    tunName: DEFAULT_TUN,
    tun: false,
    tunWarning: false,
    needsMachineAuth: false,
    authUrl: '',
    tailnetName: '',
    version: '',
    self: { hostName: '', dnsName: '', ipv4: '', ips: [], os: '', online: false },
    peers: [],
    summary: { totalPeers: 0, onlinePeers: 0, directPeers: 0, derpPeers: 0 },
    health: [],
    config: Object.assign({}, DEFAULT_CONFIG),
    binaryInfo: { ready: false, dir: path.join(dataDir, 'bin'), missing: ['tailscaled.exe', 'tailscale.exe', 'wintun.dll'], version: null },
    latestRelease: null,
    downloadProgress: null,
    conflicts: { hasConflict: false, officialServiceRunning: false, officialServiceStatus: '', externalProcesses: [], adapters: [] },
    diagnostics: [],
    lastPing: null,
    lastError: '',
    pluginLogs: [],
  };

  let transition = Promise.resolve();
  let busyCounter = 0;
  let pollTimer = null;
  let pollInFlight = false;
  let activeUpTask = null;
  let disposed = false;

  function appendLog(level, message) {
    const clean = redactText(message);
    if (!clean) return;
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = `[${time}] [${String(level || 'info').toUpperCase()}] ${clean}`;
    state.pluginLogs = [...state.pluginLogs, line].slice(-MAX_PLUGIN_LOGS);
    try {
      fs.mkdirSync(path.dirname(pluginLogFile), { recursive: true });
      fs.appendFileSync(pluginLogFile, `${line}\n`, 'utf8');
    } catch (_) {
      /* ignore file log errors */
    }
    for (const cb of logListeners) {
      try {
        cb(line);
      } catch (_) {
        /* ignore */
      }
    }
  }

  function recomputeDiagnostics() {
    const daemonLogs = daemon.readDaemonLogs ? daemon.readDaemonLogs(60) : { stdout: [], stderr: [] };
    const combinedLogs = [...state.pluginLogs, ...(daemonLogs.stderr || []), ...(daemonLogs.stdout || [])];
    state.diagnostics = analyzeDiagnostics({
      status: state,
      conflicts: state.conflicts,
      binaryInfo: state.binaryInfo,
      logs: combinedLogs,
      adapters: state.conflicts && state.conflicts.adapters,
      lastError: state.lastError,
    });
  }

  function getSnapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  function emitState() {
    recomputeDiagnostics();
    const snap = getSnapshot();
    for (const cb of stateListeners) {
      try {
        cb(snap);
      } catch (_) {
        /* ignore */
      }
    }
  }

  function setHostBusy(flag) {
    if (flag) {
      busyCounter += 1;
      if (busyCounter === 1 && host && typeof host.setPluginBusy === 'function') {
        try {
          host.setPluginBusy(true);
        } catch (_) {
          /* ignore */
        }
      }
    } else {
      busyCounter = Math.max(0, busyCounter - 1);
      if (busyCounter === 0 && host && typeof host.setPluginBusy === 'function') {
        try {
          host.setPluginBusy(false);
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  async function withBusy(message, fn) {
    state.busy = true;
    state.busyMessage = message || '处理中…';
    setHostBusy(true);
    emitState();
    try {
      return await fn();
    } finally {
      setHostBusy(false);
      state.busy = false;
      state.busyMessage = '';
      emitState();
    }
  }

  function runTransition(action) {
    const next = transition.catch(() => {}).then(action);
    transition = next;
    return next;
  }

  function getEffectiveBinDir(cfg) {
    return cfg && cfg.customBinaryDir ? cfg.customBinaryDir : path.join(dataDir, 'bin');
  }

  async function inspectConfiguredBinary(cfg) {
    const dir = getEffectiveBinDir(cfg || state.config);
    state.binaryInfo = await binary.inspectBinaryDir(dir);
    return state.binaryInfo;
  }

  async function refreshDaemonStatus({ silent = false } = {}) {
    if (disposed) return getSnapshot();
    const procState = await daemon.getProcessState();
    state.daemonRunning = procState.running;
    state.pid = procState.record ? procState.record.pid : null;

    if (!procState.running) {
      stopPolling();
      state.phase = state.lastError ? 'error' : 'stopped';
      state.backendState = 'Stopped';
      state.tun = false;
      state.tunWarning = false;
      state.needsMachineAuth = false;
      state.authUrl = '';
      state.self = { hostName: '', dnsName: '', ipv4: '', ips: [], os: '', online: false };
      state.peers = [];
      state.summary = { totalPeers: 0, onlinePeers: 0, directPeers: 0, derpPeers: 0 };
      state.health = [];
      try {
        state.conflicts = await daemon.checkConflicts(null);
      } catch (_) {
        /* ignore conflict query errors during idle */
      }
      if (!silent) emitState();
      return getSnapshot();
    }

    if (state.binaryInfo && state.binaryInfo.tailscalePath) {
      const cliRes = await daemon.runCli(state.binaryInfo.tailscalePath, ['status', '--json'], {
        timeout: 10000,
        allowNonZero: true,
      });
      const stdout = String(cliRes.stdout || '').trim();
      if (stdout.includes('{')) {
        try {
          const parsed = parseStatusJson(stdout, { fallbackAuthUrl: state.authUrl });
          state.phase = parsed.phase;
          state.backendState = parsed.backendState;
          state.version = parsed.version || state.binaryInfo.version || '';
          state.tun = parsed.tun;
          state.tunWarning = parsed.tunWarning;
          state.needsMachineAuth = parsed.needsMachineAuth;
          state.authUrl = parsed.authUrl || (parsed.phase === 'connected' ? '' : state.authUrl);
          state.tailnetName = parsed.tailnetName;
          state.self = parsed.self;
          state.peers = parsed.peers;
          state.summary = parsed.summary;
          state.health = parsed.health;
          if (parsed.phase === 'connected') state.lastError = '';
        } catch (err) {
          appendLog('warn', `解析状态失败：${redactError(err)}`);
        }
      } else if (cliRes.exitCode !== 0 && cliRes.stderr) {
        const errUrl = extractAuthUrlFromText(cliRes.stderr);
        if (errUrl) {
          state.phase = 'needs_login';
          state.authUrl = errUrl;
        }
      }
    }

    try {
      state.conflicts = await daemon.checkConflicts(state.pid);
    } catch (_) {
      /* ignore */
    }
    if (!silent) emitState();
    return getSnapshot();
  }

  function startPolling() {
    if (pollTimer || disposed) return;
    pollTimer = setInterval(async () => {
      if (pollInFlight || state.exiting || disposed) return;
      pollInFlight = true;
      try {
        await refreshDaemonStatus({ silent: false });
      } catch (err) {
        appendLog('warn', `状态轮询异常：${redactError(err)}`);
      } finally {
        pollInFlight = false;
      }
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function startTunnelInternal({ authKey = '' } = {}) {
    if (state.exiting) throw new Error('插件正在退出，无法启动连接');
    if (platform !== 'win32') throw new Error('Tailscale 异地组网插件仅支持 Windows 系统');

    state.lastError = '';
    const loaded = await store.load({ includeSecret: true });
    state.config = loaded.config;
    const binInfo = await inspectConfiguredBinary(loaded.config);
    if (!binInfo.ready) {
      throw new Error(`缺少内核文件（${binInfo.missing.join('、')}），请先在“内核管理”下载官方内核或指定本地目录`);
    }

    const explicitKey = validateAuthKeyInput(authKey);
    const effectiveAuthKey = explicitKey || loaded.authKey || '';

    state.phase = 'starting';
    emitState();

    await daemon.startDaemon({ binaryInfo: binInfo, config: loaded.config });
    startPolling();

    // 等待 LocalAPI 管道就绪（最多 8 秒）后再执行 tailscale up
    if (binInfo.tailscalePath) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (state.exiting || disposed) return getSnapshot();
        const probe = await daemon.runCli(binInfo.tailscalePath, ['status', '--json'], { timeout: 2500, allowNonZero: true });
        if (String(probe.stdout || '').includes('{')) break;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    await refreshDaemonStatus({ silent: false });

    if (activeUpTask) {
      activeUpTask.cancel();
      activeUpTask = null;
    }

    // 节点已经过登录认证时不再重复传递已保存的 Auth Key，直接以 --unattended 重连；未登录或手工传入新 Key 时才使用
    const needsAuth = state.backendState === 'NeedsLogin' || state.backendState === 'NoState' || !state.self.ipv4;
    const upAuthKey = explicitKey || (needsAuth ? effectiveAuthKey : '');

    let capturedAuthUrl = '';
    const task = daemon.startInteractiveUp({
      tailscalePath: binInfo.tailscalePath,
      config: loaded.config,
      authKey: upAuthKey,
      onAuthUrl: (rawUrl) => {
        try {
          const safe = validateAuthUrl(rawUrl, loaded.config.loginServer);
          if (safe !== state.authUrl) {
            capturedAuthUrl = safe;
            state.authUrl = safe;
            state.phase = 'needs_login';
            appendLog('info', `获取到登录授权链接：${safe}`);
            emitState();
          }
        } catch (err) {
          appendLog('warn', `忽略不安全的授权链接：${redactError(err)}`);
        }
      },
      onLog: (line) => appendLog('info', line),
    });
    activeUpTask = task;

    try {
      const upResult = await task.promise;
      if (upResult && upResult.cancelled) return getSnapshot();
    } catch (error) {
      // 如果 tailscale up 因未完成登录超时退出，但已获取到 AuthURL 或状态为 NeedsLogin，则不视作致命错误
      await refreshDaemonStatus({ silent: true });
      if (state.phase === 'needs_login' || capturedAuthUrl || state.authUrl) {
        if (!state.authUrl && capturedAuthUrl) state.authUrl = capturedAuthUrl;
        state.phase = 'needs_login';
        emitState();
        return getSnapshot();
      }
      throw error;
    } finally {
      if (activeUpTask === task) activeUpTask = null;
    }

    await refreshDaemonStatus({ silent: false });
    return getSnapshot();
  }

  async function stopTunnelInternal() {
    stopPolling();
    if (activeUpTask) {
      activeUpTask.cancel();
      activeUpTask = null;
    }
    const binInfo = await inspectConfiguredBinary(state.config);
    await daemon.stopDaemon({ binaryInfo: binInfo });
    state.lastError = '';
    state.authUrl = '';
    await refreshDaemonStatus({ silent: false });
    return getSnapshot();
  }

  async function bootstrap() {
    return runTransition(async () => {
      const loaded = await store.load({ includeSecret: false });
      state.config = loaded.config;
      await inspectConfiguredBinary(loaded.config);
      await refreshDaemonStatus({ silent: true });
      if (state.daemonRunning) {
        startPolling();
      }
      state.initialized = true;
      emitState();

      if (
        loaded.config.autoConnect
        && !state.daemonRunning
        && state.binaryInfo.ready
        && !state.conflicts.hasConflict
        && platform === 'win32'
        && !state.exiting
      ) {
        appendLog('info', '已开启自动连接，正在尝试拉起 Tailscale 隧道…');
        try {
          await withBusy('正在自动连接 Tailscale（请允许管理员授权）…', () => startTunnelInternal({}));
        } catch (error) {
          state.lastError = redactError(error);
          state.phase = 'error';
          appendLog('error', `自动连接失败：${state.lastError}`);
          emitState();
        }
      }
      return getSnapshot();
    });
  }

  async function startTunnel(opts = {}) {
    return runTransition(async () => {
      try {
        return await withBusy('正在启动 Tailscale 虚拟网卡并连接（可能需要管理员授权）…', () => startTunnelInternal(opts));
      } catch (error) {
        state.lastError = redactError(error);
        if (!state.daemonRunning) state.phase = 'error';
        appendLog('error', `启动失败：${state.lastError}`);
        emitState();
        throw new Error(state.lastError);
      }
    });
  }

  async function stopTunnel() {
    return runTransition(async () => {
      try {
        return await withBusy('正在停止 Tailscale 隧道并清理虚拟网卡（可能需要管理员授权）…', () => stopTunnelInternal());
      } catch (error) {
        state.lastError = redactError(error);
        appendLog('error', `停止失败：${state.lastError}`);
        emitState();
        throw new Error(state.lastError);
      }
    });
  }

  async function logout() {
    return runTransition(async () => {
      if (state.exiting) throw new Error('插件正在退出');
      return withBusy('正在注销当前 Tailscale 账号…', async () => {
        const binInfo = await inspectConfiguredBinary(state.config);
        if (!binInfo.tailscalePath) throw new Error('未找到 tailscale.exe');
        if (!state.daemonRunning) {
          await daemon.startDaemon({ binaryInfo: binInfo, config: state.config });
        }
        await daemon.runCli(binInfo.tailscalePath, ['logout'], { timeout: 15000 });
        appendLog('info', '已注销当前 Tailscale 节点账号');
        state.authUrl = '';
        await daemon.stopDaemon({ binaryInfo: binInfo });
        await refreshDaemonStatus({ silent: false });
        return getSnapshot();
      });
    });
  }

  async function refreshStatus() {
    return runTransition(async () => {
      await inspectConfiguredBinary(state.config);
      return refreshDaemonStatus({ silent: false });
    });
  }

  async function pingPeer(targetIp) {
    const cleanIp = String(targetIp || '').trim();
    if (!/^[a-zA-Z0-9.:-]+$/.test(cleanIp)) {
      throw new Error('目标节点地址无效');
    }
    const binInfo = await inspectConfiguredBinary(state.config);
    if (!state.daemonRunning || !binInfo.tailscalePath) {
      throw new Error('请先启动 Tailscale 隧道');
    }
    const res = await daemon.runCli(binInfo.tailscalePath, ['ping', '-c', '1', '--timeout=5s', cleanIp], {
      timeout: 8000,
      allowNonZero: true,
    });
    const parsed = parsePingOutput(`${res.stdout}\n${res.stderr}`);
    state.lastPing = Object.assign({ target: cleanIp, time: new Date().toISOString() }, parsed);
    appendLog('info', `Ping ${cleanIp}：${parsed.ok ? `${parsed.via} (${parsed.latencyMs}ms)` : (parsed.raw || '无响应')}`);
    emitState();
    return state.lastPing;
  }

  async function saveConfig(patch = {}) {
    return runTransition(async () => {
      if (state.exiting) throw new Error('插件正在退出');
      const saved = await store.save(patch);
      state.config = saved;
      await inspectConfiguredBinary(saved);
      appendLog('info', '设置已保存');
      emitState();
      return getSnapshot();
    });
  }

  async function clearSavedAuthKey() {
    return saveConfig({ saveAuthKey: false, clearAuthKey: true });
  }

  async function checkLatestRelease() {
    const release = await binary.fetchLatestRelease({ arch, fetchImpl });
    state.latestRelease = release;
    emitState();
    return release;
  }

  async function downloadKernel() {
    return runTransition(async () => {
      if (state.exiting) throw new Error('插件正在退出');
      if (state.daemonRunning) {
        throw new Error('请先停止 Tailscale 隧道，再下载或更新内核');
      }
      return withBusy('正在下载并校验官方 Tailscale Windows 内核…', async () => {
        const binDir = path.join(dataDir, 'bin');
        const result = await binary.downloadAndInstall({
          binDir,
          arch,
          fetchImpl,
          onProgress: (progress) => {
            state.downloadProgress = progress;
            emitState();
          },
        });
        const saved = await store.save({ customBinaryDir: '' });
        state.config = saved;
        state.downloadProgress = null;
        await inspectConfiguredBinary(saved);
        appendLog('info', `已安装官方 Tailscale 内核 v${result.version}`);
        emitState();
        return getSnapshot();
      });
    });
  }

  async function pickLocalKernelDir() {
    if (!host || typeof host.showOpenDialog !== 'function') {
      throw new Error('当前宿主不支持文件夹选择对话框');
    }
    return runTransition(async () => withBusy('正在选择本地 Tailscale 目录…', async () => {
      const picked = await host.showOpenDialog({
        title: '选择包含 tailscaled.exe、tailscale.exe 与 wintun.dll 的目录',
        properties: ['openDirectory'],
      });
      if (!picked || !picked[0]) return null;
      const chosenDir = picked[0];
      const info = await binary.inspectBinaryDir(chosenDir);
      if (!info.ready) {
        throw new Error(`所选目录缺少必需文件：${info.missing.join('、')}`);
      }
      const saved = await store.save({ customBinaryDir: chosenDir });
      state.config = saved;
      await inspectConfiguredBinary(saved);
      appendLog('info', `已切换本地内核目录：${chosenDir}`);
      emitState();
      return getSnapshot();
    }));
  }

  async function openAuthUrl(rawUrl) {
    const target = rawUrl || state.authUrl;
    const safeUrl = validateAuthUrl(target, state.config.loginServer);
    await ps.openExternalHttpsUrl(safeUrl);
    return safeUrl;
  }

  function copyText(text) {
    const value = String(text || '');
    if (!value) return false;
    if (host && typeof host.copyText === 'function') {
      host.copyText(value);
      return true;
    }
    return false;
  }

  async function openDataDir() {
    fs.mkdirSync(dataDir, { recursive: true });
    if (host && typeof host.shellOpenPath === 'function') {
      return host.shellOpenPath(dataDir);
    }
    return '';
  }

  function getLogs() {
    const daemonLogs = daemon.readDaemonLogs ? daemon.readDaemonLogs(120) : { stdout: [], stderr: [] };
    return {
      plugin: [...state.pluginLogs],
      stdout: daemonLogs.stdout || [],
      stderr: daemonLogs.stderr || [],
    };
  }

  function clearLogs() {
    state.pluginLogs = [];
    try {
      if (fs.existsSync(pluginLogFile)) fs.writeFileSync(pluginLogFile, '', 'utf8');
    } catch (_) {
      /* ignore */
    }
    if (daemon.clearDaemonLogs) daemon.clearDaemonLogs();
    emitState();
  }

  async function shutdown() {
    state.exiting = true;
    stopPolling();
    if (activeUpTask) {
      activeUpTask.cancel();
      activeUpTask = null;
    }
    emitState();
    return runTransition(async () => {
      try {
        return await withBusy('正在停止 Tailscale 隧道并释放虚拟网卡…', async () => {
          const binInfo = await inspectConfiguredBinary(state.config);
          await daemon.stopDaemon({ binaryInfo: binInfo });
          await refreshDaemonStatus({ silent: false });
          return { stopped: true };
        });
      } catch (error) {
        state.exiting = false;
        state.lastError = redactError(error);
        appendLog('error', `退出清理失败：${state.lastError}`);
        startPolling();
        emitState();
        throw new Error(`停止 Tailscale 失败：${state.lastError}`);
      }
    });
  }

  function resumeAfterCancelledExit() {
    state.exiting = false;
    if (state.daemonRunning) startPolling();
    emitState();
  }

  function dispose() {
    disposed = true;
    stopPolling();
    if (activeUpTask) {
      activeUpTask.cancel();
      activeUpTask = null;
    }
    stateListeners.clear();
    logListeners.clear();
  }

  return {
    bootstrap,
    getState: getSnapshot,
    onState(cb) {
      if (typeof cb !== 'function') return () => {};
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    onLog(cb) {
      if (typeof cb !== 'function') return () => {};
      logListeners.add(cb);
      return () => logListeners.delete(cb);
    },
    startTunnel,
    stopTunnel,
    logout,
    refreshStatus,
    pingPeer,
    saveConfig,
    clearSavedAuthKey,
    checkLatestRelease,
    downloadKernel,
    pickLocalKernelDir,
    openAuthUrl,
    copyText,
    openDataDir,
    getLogs,
    clearLogs,
    shutdown,
    resumeAfterCancelledExit,
    dispose,
  };
}

module.exports = {
  POLL_INTERVAL_MS,
  createService,
};
