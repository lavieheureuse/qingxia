(() => {
  'use strict';

  // Host contract: window.frpc v2 (SPEC-SYNC §6). This view is a read-only
  // mirror of what the phone published: it never edits proxies, never sees the
  // frps token, and only talks to the host through window.frpc.
  const $ = (id) => document.getElementById(id);
  const bridge = window.frpc && typeof window.frpc === 'object' ? window.frpc : null;
  const has = (name) => !!bridge && typeof bridge[name] === 'function';

  const APP_VERSION = '0.1.6';
  const PHASES = ['unconfigured', 'idle', 'syncing', 'applying', 'online', 'offline', 'error'];
  const SYNC_ACTIONS = ['apply', 'skip', 'fail', 'report'];
  const LOG_LIMIT = 2000;
  const LOG_SOURCE_LABEL = { sync: '同步', frpc: 'frpc' };
  const LEVEL_MARK = { debug: 'D', info: 'I', warn: 'W', error: 'E' };
  const PC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const PROXY_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const INTERVALS = [30, 45, 60, 120];
  const COLLAPSE_KEY = 'frpc.ui.proxiesCollapsed';

  const ui = {
    state: emptyState(),
    host: false,
    booted: false,
    hostError: '',
    action: null,
    renderQueued: false,
    connectionSeeded: false,
    testResult: null,
    versions: null,
    versionLoading: false,
    downloadPending: false,
    autoScroll: true,
    logTab: 'sync',
    logs: [],
    logIds: new Set(),
    pendingLogs: [],
    logRaf: 0,
    toastTimer: 0,
    proxiesCollapsed: false,
    draft: null,
    draftDirty: false,
    editingProxyName: null,
    confirm: null,
    suppressSyncToast: false,
  };

  // ---------- shapes ----------
  function emptyState() {
    return {
      phase: 'unconfigured',
      connection: { apiBase: '', pcId: '', hasToken: false, tokenHint: '' },
      remote: { reachable: false, version: null, updatedAt: null, fetchedAt: null, proxies: [], error: null },
      applied: { version: null, at: null, configPath: '', backupPath: null },
      frpc: {
        running: false, pid: null, startedAt: null, exitedAt: null, exitCode: null,
        logHints: { loggedIn: false, startedProxies: [], lastError: null },
        binary: { status: 'missing', path: '', version: '', source: 'downloaded', download: null },
      },
      autoSync: { enabled: false, intervalSec: 45, startOnLaunch: false, nextAt: null },
      lastSync: { at: null, ok: null, action: null, version: null, error: null },
      lastError: null,
    };
  }
  function str(value, max = 2000) { return typeof value === 'string' ? value.slice(0, max) : ''; }
  function num(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
  function bool(value, fallback = false) { return typeof value === 'boolean' ? value : fallback; }
  function intOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
  }
  function exitCodeOf(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  }
  function normalizeConnection(raw) {
    const connection = raw && typeof raw === 'object' ? raw : {};
    return {
      apiBase: str(connection.apiBase, 500).trim(),
      pcId: str(connection.pcId, 64).trim(),
      hasToken: bool(connection.hasToken, false),
      tokenHint: str(connection.tokenHint, 80),
    };
  }
  function normalizeProxy(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = str(raw.name, 64);
    if (!name) return null;
    return {
      name,
      type: str(raw.type, 16) || 'tcp',
      localIp: str(raw.localIp, 100) || '127.0.0.1',
      localPort: Math.round(num(raw.localPort, 0)),
      remotePort: Math.round(num(raw.remotePort, 0)),
      enabled: bool(raw.enabled, true),
    };
  }
  function normalizeState(raw) {
    const base = emptyState();
    if (!raw || typeof raw !== 'object') return base;
    const remote = raw.remote && typeof raw.remote === 'object' ? raw.remote : {};
    const applied = raw.applied && typeof raw.applied === 'object' ? raw.applied : {};
    const frpc = raw.frpc && typeof raw.frpc === 'object' ? raw.frpc : {};
    const hints = frpc.logHints && typeof frpc.logHints === 'object' ? frpc.logHints : {};
    const binary = frpc.binary && typeof frpc.binary === 'object' ? frpc.binary : {};
    const autoSync = raw.autoSync && typeof raw.autoSync === 'object' ? raw.autoSync : {};
    const lastSync = raw.lastSync && typeof raw.lastSync === 'object' ? raw.lastSync : {};
    const download = binary.download && typeof binary.download === 'object'
      ? {
        active: bool(binary.download.active, false),
        version: str(binary.download.version, 40),
        percent: Number.isFinite(Number(binary.download.percent)) ? Number(binary.download.percent) : -1,
        receivedBytes: Math.max(0, num(binary.download.receivedBytes, 0)),
        totalBytes: Math.max(0, num(binary.download.totalBytes, 0)),
        error: str(binary.download.error, 500) || null,
      }
      : null;
    const lastError = raw.lastError && typeof raw.lastError === 'object'
      ? { code: str(raw.lastError.code, 60), message: str(raw.lastError.message, 600), at: num(raw.lastError.at, 0) }
      : null;
    return {
      phase: PHASES.includes(raw.phase) ? raw.phase : 'idle',
      connection: normalizeConnection(raw.connection),
      remote: {
        reachable: bool(remote.reachable, false),
        version: intOrNull(remote.version),
        updatedAt: str(remote.updatedAt, 60) || null,
        fetchedAt: intOrNull(remote.fetchedAt),
        proxies: Array.isArray(remote.proxies) ? remote.proxies.map(normalizeProxy).filter(Boolean) : [],
        error: str(remote.error, 500) || null,
      },
      applied: {
        version: intOrNull(applied.version),
        at: intOrNull(applied.at),
        configPath: str(applied.configPath, 1000),
        backupPath: str(applied.backupPath, 1000) || null,
        proxies: Array.isArray(applied.proxies) ? applied.proxies.map(normalizeProxy).filter(Boolean) : [],
      },
      frpc: {
        running: bool(frpc.running, false),
        pid: intOrNull(frpc.pid),
        startedAt: intOrNull(frpc.startedAt),
        exitedAt: intOrNull(frpc.exitedAt),
        exitCode: exitCodeOf(frpc.exitCode),
        logHints: {
          loggedIn: bool(hints.loggedIn, false),
          startedProxies: Array.isArray(hints.startedProxies) ? hints.startedProxies.map((item) => str(item, 64)).filter(Boolean).slice(0, 100) : [],
          lastError: str(hints.lastError, 500) || null,
        },
        binary: {
          status: binary.status === 'ready' ? 'ready' : 'missing',
          path: str(binary.path, 1000),
          version: str(binary.version, 40),
          source: binary.source === 'custom' ? 'custom' : 'downloaded',
          download,
        },
      },
      autoSync: {
        enabled: bool(autoSync.enabled, false),
        intervalSec: INTERVALS.includes(Number(autoSync.intervalSec)) ? Number(autoSync.intervalSec) : 45,
        startOnLaunch: bool(autoSync.startOnLaunch, false),
        nextAt: intOrNull(autoSync.nextAt),
      },
      lastSync: {
        at: intOrNull(lastSync.at),
        ok: typeof lastSync.ok === 'boolean' ? lastSync.ok : null,
        action: SYNC_ACTIONS.includes(lastSync.action) ? lastSync.action : null,
        version: intOrNull(lastSync.version),
        error: str(lastSync.error, 600) || null,
      },
      lastError,
    };
  }
  function isState(value) {
    return !!value && typeof value === 'object'
      && typeof value.phase === 'string' && !!value.connection && !!value.frpc;
  }
  function msgOf(error, fallback = '操作未完成，请稍后重试。') {
    return str(error && error.message, 600) || fallback;
  }

  // ---------- helpers ----------
  function configured() {
    const connection = ui.state.connection;
    return !!connection.apiBase && !!connection.pcId && connection.hasToken;
  }
  function configuredWithInputs() {
    const connection = ui.state.connection;
    const apiBase = $('api-base').value.trim() || connection.apiBase;
    const pcId = $('pc-id').value.trim() || connection.pcId;
    const tokenInput = $('pc-token').value.trim();
    return !!apiBase && !!pcId && (connection.hasToken || !!tokenInput);
  }
  function hostOf(apiBase) {
    try {
      const url = new URL(apiBase);
      return url.host || apiBase;
    } catch (_) { return apiBase || ''; }
  }
  function binaryReady() { return ui.state.frpc.binary.status === 'ready'; }
  function syncingPhase() {
    return ui.state.phase === 'syncing' || ui.state.phase === 'applying';
  }
  function locked() {
    return !ui.host || ui.action !== null || syncingPhase();
  }
  function makeIcon(name, className = 'icon') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }
  function makeEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function syncValue(element, value) {
    if (!element) return;
    if (document.activeElement === element) return;
    const next = String(value);
    if (element.value !== next) element.value = next;
  }
  function syncChecked(element, value) {
    if (!element) return;
    if (element.checked !== !!value) element.checked = !!value;
  }
  function setTitle(element, text) {
    if (!element) return;
    if (text) element.title = text; else element.removeAttribute('title');
  }
  function pad(value) { return String(value).padStart(2, '0'); }
  function formatTime(value) {
    const date = new Date(num(value, 0));
    if (Number.isNaN(date.getTime())) return '--:--:--';
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
  function formatDateTime(value) {
    if (value === null || value === undefined || value === '') return '';
    const date = value instanceof Date ? value : new Date(typeof value === 'string' ? value : num(value, 0));
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    if (sameDay) return time;
    return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  }
  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    if (total < 60) return `${total} 秒`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes} 分 ${total % 60} 秒`;
    return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
  }
  function bytes(value) {
    const size = num(value, 0);
    if (!Number.isFinite(size) || size < 0) return '';
    if (size < 1024) return `${Math.round(size)} B`;
    if (size < 1048576) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1073741824) return `${(size / 1048576).toFixed(1)} MB`;
    return `${(size / 1073741824).toFixed(2)} GB`;
  }
  function notify(message, options = {}) {
    const toast = $('toast');
    if (!toast) return;
    clearTimeout(ui.toastTimer);
    toast.textContent = message;
    toast.classList.toggle('is-error', options.error === true);
    toast.hidden = false;
    ui.toastTimer = setTimeout(() => { toast.hidden = true; }, options.error === true ? 5200 : 3200);
  }
  function scheduleRender() {
    if (ui.renderQueued) return;
    ui.renderQueued = true;
    requestAnimationFrame(() => { ui.renderQueued = false; render(); });
  }

  // ---------- bridge ----------
  async function callBridge(name, args = [], options = {}) {
    if (!has(name)) {
      const message = '宿主未连接，暂时无法执行该操作。';
      return { ok: false, error: { code: 'NO_HOST', message }, message };
    }
    if (ui.action !== null) {
      return { ok: false, error: { code: 'BUSY', message: '正在处理上一个操作' }, message: '正在处理上一个操作，请稍候。' };
    }
    ui.action = options.action || name;
    scheduleRender();
    try {
      const value = await bridge[name](...args);
      if (options.applyState !== false && isState(value)) applyState(value);
      return { ok: true, value };
    } catch (error) {
      const message = msgOf(error, options.fallback || '操作未完成，请稍后重试。');
      if (options.silent !== true) notify(message, { error: true });
      return { ok: false, error, message };
    } finally {
      ui.action = null;
      scheduleRender();
    }
  }

  function applyState(raw) {
    const previous = ui.state;
    ui.state = normalizeState(raw);
    if (ui.host && !ui.connectionSeeded) {
      ui.connectionSeeded = true;
      if (!configured()) $('connection-panel').open = true;
    }
    ui.downloadPending = false;
    reconcileDownloadDialog();
    // 代理草稿：没有未发布修改时跟随服务器；有修改时保留本地编辑。
    if (has('publishProxies') && configured()) {
      if (!ui.draftDirty || !ui.draft) ui.draft = cloneProxies(publishedProxies());
    } else {
      ui.draft = null;
      ui.draftDirty = false;
    }
    if (ui.booted && !ui.suppressSyncToast && ui.state.lastSync.at && ui.state.lastSync.at !== previous.lastSync.at) {
      const sync = ui.state.lastSync;
      if (sync.ok === false) {
        notify(`同步失败：${sync.error || '请查看同步日志'}`, { error: true });
      } else if (sync.action === 'apply') {
        notify(`已同步并应用 v${sync.version === null ? '' : sync.version}`.trim());
      } else if (sync.action === 'skip') {
        notify('已是最新配置，无需重启 frpc。');
      }
    }
    scheduleRender();
  }

  // ---------- derived status ----------
  function deriveStatus() {
    const state = ui.state;
    if (!bridge) {
      return { tone: 'unconfigured', title: '宿主未连接', subtitle: '请通过 uTools 打开本插件；当前仅展示界面骨架。' };
    }
    if (ui.hostError) {
      return { tone: 'error', title: '宿主连接失败', subtitle: '请重新打开插件。', error: ui.hostError };
    }
    if (!configured()) {
      return { tone: 'unconfigured', title: '未配置连接', subtitle: '在下方填写 API 地址、电脑 ID 与 Token，然后测试连接。' };
    }
    if (state.phase === 'syncing') {
      return { tone: 'syncing', title: '同步中…', subtitle: '正在从服务器拉取手机发布的配置。' };
    }
    if (state.phase === 'applying') {
      return { tone: 'syncing', title: '正在应用配置…', subtitle: '校验配置并重启 frpc，请稍候。' };
    }
    const syncError = state.lastSync.ok === false && state.lastSync.error ? state.lastSync.error : null;
    if (state.phase === 'error') {
      return {
        tone: 'error',
        title: '同步失败',
        subtitle: '配置未应用，旧的配置与 frpc 进程仍然保留。',
        error: syncError || (state.lastError && state.lastError.message) || '同步未完成，请查看同步日志。',
      };
    }
    if (syncError) {
      return { tone: 'error', title: '同步失败', subtitle: '配置未应用，旧的配置与 frpc 进程仍然保留。', error: syncError };
    }
    const appliedVersion = state.applied.version;
    const remoteVersion = state.remote.version;
    if (appliedVersion === null) {
      if (remoteVersion !== null) {
        return { tone: 'waiting', title: '等待首次同步', subtitle: `手机已发布 v${remoteVersion}，点击「立即同步」或开启自动同步。` };
      }
      if (state.remote.error) {
        return { tone: 'error', title: '无法连接服务器', subtitle: '请检查 API 地址、网络与 Token 后重试。', error: state.remote.error };
      }
      return { tone: 'waiting', title: '等待首次同步', subtitle: '尚未从服务器拉取配置，点击「立即同步」。' };
    }
    if (remoteVersion !== null && remoteVersion > appliedVersion) {
      return { tone: 'waiting', title: `有新版本 v${remoteVersion}`, subtitle: `手机已发布 v${remoteVersion}，本机仍是 v${appliedVersion}，等待同步。` };
    }
    if (!state.frpc.running) {
      const exit = state.frpc.exitCode !== null ? `（退出码 ${state.frpc.exitCode}）` : '';
      return { tone: 'offline', title: 'frpc 未运行', subtitle: `配置已应用 v${appliedVersion}，但 frpc 未在运行${exit}。` };
    }
    if (!state.remote.reachable) {
      const neverFetched = state.remote.fetchedAt === null && !state.remote.error;
      return {
        tone: 'online',
        title: `已生效 v${appliedVersion}`,
        subtitle: neverFetched
          ? 'frpc 运行中；正在等待首次拉取服务器配置。'
          : 'frpc 运行中；暂时无法连接服务器，稍后会自动重试。',
      };
    }
    return { tone: 'online', title: `已生效 v${appliedVersion}`, subtitle: '手机发布版本与本机一致，frpc 运行中。' };
  }

  // ---------- render ----------
  function render() {
    renderHost();
    renderConnectionBadge();
    renderStatus();
    renderConnection();
    renderProxies();
    renderConfig();
    renderBinary();
    renderLogs();
    renderFooter();
    renderDialogs();
  }

  function renderHost() {
    const notice = $('host-notice');
    let text = '';
    if (!bridge) text = '宿主未连接：请通过 uTools 打开本插件。当前为界面骨架，所有操作已停用。';
    else if (ui.hostError) text = `宿主连接失败：${ui.hostError}`;
    notice.hidden = !text;
    if (text) $('host-notice-text').textContent = text;
    document.body.classList.toggle('no-host', !bridge);
  }

  function renderConnectionBadge() {
    const badge = $('connection-badge');
    const state = ui.state;
    let cls = 'is-unconfigured';
    let label = '未配置';
    let addr = '';
    if (!bridge) {
      cls = 'is-offline';
      label = '宿主未连接';
    } else if (ui.action === 'testConnection') {
      cls = 'is-checking';
      label = '正在测试';
      addr = hostOf(state.connection.apiBase);
    } else if (!configured()) {
      cls = 'is-unconfigured';
      label = '未配置';
    } else if (state.remote.reachable) {
      cls = 'is-connected';
      label = '已连接';
      addr = hostOf(state.connection.apiBase);
    } else {
      cls = 'is-offline';
      label = state.remote.error ? '未连接' : '待连接';
      addr = hostOf(state.connection.apiBase);
    }
    badge.className = `phase-badge ${cls}`;
    $('connection-label').textContent = label;
    $('connection-addr').textContent = addr;
    setTitle(badge, addr ? `服务器 ${addr}` : '尚未配置连接');
  }

  function renderStatus() {
    const state = ui.state;
    const status = deriveStatus();
    const indicator = $('status-indicator');
    indicator.className = `status-indicator is-${status.tone}`;
    $('status-heading').textContent = status.title;
    $('status-subtitle').textContent = status.subtitle;

    const chip = $('status-version');
    if (state.autoSync.enabled) {
      chip.hidden = false;
      chip.textContent = `自动同步 ${state.autoSync.intervalSec} 秒`;
      chip.className = 'chip chip-ok';
    } else if (syncingPhase()) {
      chip.hidden = false;
      chip.textContent = '进行中';
      chip.className = 'chip chip-warn';
    } else {
      chip.hidden = true;
      chip.textContent = '';
    }

    // facts
    $('fact-remote').textContent = state.remote.version === null ? '—' : `v${state.remote.version}`;
    if (state.remote.updatedAt) {
      $('fact-remote-sub').textContent = `更新于 ${formatDateTime(state.remote.updatedAt)}`;
    } else if (state.remote.error) {
      $('fact-remote-sub').textContent = '拉取失败';
    } else {
      $('fact-remote-sub').textContent = '尚未拉取';
    }
    $('fact-applied').textContent = state.applied.version === null ? '—' : `v${state.applied.version}`;
    $('fact-applied-sub').textContent = state.applied.at ? `同步于 ${formatDateTime(state.applied.at)}` : '从未同步';
    renderFrpcFact();

    // actions
    const syncButton = $('sync-now');
    const syncLabel = $('sync-label');
    const syncIcon = $('sync-icon');
    const syncing = syncingPhase() || ui.action === 'syncNow';
    if (syncing) {
      syncLabel.textContent = '同步中…';
      syncIcon.setAttribute('href', '#i-sync');
      syncButton.classList.add('is-loading');
    } else {
      syncLabel.textContent = '立即同步';
      syncIcon.setAttribute('href', '#i-sync');
      syncButton.classList.remove('is-loading');
    }
    syncButton.disabled = !ui.host || !configured() || ui.action !== null || syncingPhase();
    setTitle(syncButton, !bridge ? '请在 uTools 中运行'
      : !configured() ? '请先完成连接设置'
        : !binaryReady() ? '请先下载 frpc 程序'
          : syncing ? '正在同步' : '立即从服务器拉取并应用最新配置');

    const toggle = $('toggle-frpc');
    const frpcLabel = $('frpc-label');
    const frpcIcon = $('frpc-icon');
    const running = state.frpc.running;
    if (ui.action === 'startFrpc') {
      frpcLabel.textContent = '启动中…';
      frpcIcon.setAttribute('href', '#i-restart');
      toggle.classList.add('is-loading');
    } else if (ui.action === 'stopFrpc') {
      frpcLabel.textContent = '停止中…';
      frpcIcon.setAttribute('href', '#i-restart');
      toggle.classList.add('is-loading');
    } else {
      frpcLabel.textContent = running ? '停止 frpc' : '启动 frpc';
      frpcIcon.setAttribute('href', running ? '#i-stop' : '#i-play');
      toggle.classList.remove('is-loading');
    }
    toggle.disabled = !ui.host || !configured() || ui.action !== null || syncingPhase()
      || (!running && !binaryReady());
    setTitle(toggle, running ? '停止 frpc 进程' : !binaryReady() ? '请先下载 frpc 程序' : '启动 frpc 进程');

    const restart = $('restart-frpc');
    restart.disabled = !ui.host || !configured() || !running || ui.action !== null || syncingPhase();
    setTitle(restart, running ? '重启 frpc 进程' : 'frpc 未运行');

    // auto sync
    const auto = $('autosync');
    syncChecked(auto, state.autoSync.enabled);
    auto.disabled = !ui.host || !configured() || ui.action !== null;
    const startup = $('start-on-launch');
    syncChecked(startup, state.autoSync.startOnLaunch);
    startup.disabled = !ui.host || ui.action !== null;
    const interval = $('sync-interval');
    syncValue(interval, String(state.autoSync.intervalSec));
    interval.disabled = !ui.host || !configured() || ui.action !== null;
    updateCountdown();
    updateLastSyncText();

    // error banner
    const errorBox = $('status-error');
    const errorText = status.error || '';
    errorBox.hidden = !errorText;
    if (errorText) $('status-error-text').textContent = errorText;
  }

  function renderFrpcFact() {
    const frpc = ui.state.frpc;
    const fact = $('fact-frpc');
    const sub = $('fact-frpc-sub');
    if (frpc.running) {
      fact.textContent = '运行中';
      const bits = [];
      if (frpc.pid) bits.push(`PID ${frpc.pid}`);
      if (frpc.startedAt) bits.push(`已运行 ${formatDuration(Date.now() - frpc.startedAt)}`);
      sub.textContent = bits.join(' · ') || '运行中';
    } else if (frpc.exitedAt || frpc.exitCode !== null) {
      fact.textContent = '已退出';
      sub.textContent = frpc.exitCode !== null ? `退出码 ${frpc.exitCode}` : `退出于 ${formatDateTime(frpc.exitedAt)}`;
    } else {
      fact.textContent = '未运行';
      sub.textContent = binaryReady() ? '点击「启动 frpc」' : '缺少 frpc 程序';
    }
  }

  function updateCountdown() {
    const auto = ui.state.autoSync;
    const element = $('next-sync');
    if (!ui.host) {
      element.textContent = '自动同步不可用';
      return;
    }
    if (!configured()) {
      element.textContent = '配置连接后启用';
      return;
    }
    if (!auto.enabled) {
      element.textContent = '自动同步已关闭';
      return;
    }
    if (!auto.nextAt) {
      element.textContent = '等待下一次检查';
      return;
    }
    const seconds = Math.max(0, Math.ceil((auto.nextAt - Date.now()) / 1000));
    element.textContent = seconds > 0 ? `${seconds} 秒后自动同步` : '正在自动同步…';
  }

  function updateLastSyncText() {
    const sync = ui.state.lastSync;
    const element = $('last-sync');
    if (!sync.at) {
      element.textContent = '尚未同步';
      return;
    }
    const actionLabel = { apply: '已应用', skip: '无变化', fail: '失败', report: '已回传' }[sync.action] || '已同步';
    const version = sync.version !== null ? ` v${sync.version}` : '';
    element.textContent = `上次同步 ${formatTime(sync.at)} · ${actionLabel}${version}`;
    setTitle(element, sync.error || element.textContent);
  }

  // ---------- connection settings ----------
  function renderConnection() {
    const state = ui.state;
    const connection = state.connection;
    const ready = configured();
    $('connection-summary').textContent = connection.apiBase && connection.pcId
      ? `${connection.pcId} @ ${connection.apiBase}`
      : '未配置连接';
    $('connection-flag').hidden = ready;
    $('connection-panel').dataset.attention = String(!ready && !!bridge);
    syncValue($('api-base'), connection.apiBase);
    syncValue($('pc-id'), connection.pcId);
    const token = $('pc-token');
    token.placeholder = connection.hasToken
      ? `已保存 ${connection.tokenHint || '••••'}，留空表示不修改`
      : '必填，仅保存在本机';
    const editable = !!bridge;
    for (const id of ['api-base', 'pc-id', 'pc-token']) $(id).disabled = !editable;
    $('toggle-token').disabled = !editable;
    const hint = $('connection-hint');
    hint.textContent = connection.hasToken
      ? 'Token 只保存在本机，不会出现在日志或界面里。'
      : '默认服务器 http://103.47.80.133、电脑 ID pc-home；Token 由 iostool 生成，只保存在本机。';

    const test = $('test-connection');
    const testLabel = $('test-label');
    if (ui.action === 'testConnection') {
      testLabel.textContent = '测试中…';
      test.classList.add('is-loading');
    } else {
      testLabel.textContent = '测试连接';
      test.classList.remove('is-loading');
    }
    test.disabled = !ui.host || ui.action !== null || !configuredWithInputs();
    setTitle(test, !bridge ? '请在 uTools 中运行' : !configuredWithInputs() ? '请先填写 API 地址、电脑 ID 与 Token' : '调用 /health 与 /frp/config 检查连通性');
    renderTestResult();
  }

  function renderTestResult() {
    const element = $('test-result');
    const result = ui.testResult;
    if (!result) {
      element.textContent = '';
      element.className = 'test-result';
      return;
    }
    element.className = `test-result ${result.ok ? 'is-ok' : 'is-bad'}`;
    element.textContent = result.ok
      ? `连接成功${result.detail ? ` · ${result.detail}` : ''}`
      : `连接失败：${result.message}`;
  }

  // ---------- proxies ----------
  function canEditProxies() {
    return has('publishProxies') && configured();
  }
  function cloneProxies(list) {
    return (Array.isArray(list) ? list : []).map((proxy) => ({
      name: proxy.name,
      type: 'tcp',
      localIp: proxy.localIp,
      localPort: Number(proxy.localPort),
      remotePort: Number(proxy.remotePort),
      enabled: proxy.enabled === true,
    }));
  }
  function publishedProxies() {
    const remote = ui.state.remote.proxies;
    if (remote.length > 0) return remote;
    return ui.state.applied.version !== null ? ui.state.applied.proxies : [];
  }
  function currentProxies() {
    if (!canEditProxies()) return publishedProxies();
    if (!ui.draft) ui.draft = cloneProxies(publishedProxies());
    return ui.draft;
  }
  function sameProxies(left, right) {
    const one = Array.isArray(left) ? left : [];
    const two = Array.isArray(right) ? right : [];
    if (one.length !== two.length) return false;
    for (let index = 0; index < one.length; index += 1) {
      const a = one[index];
      const b = two[index];
      if (!a || !b) return false;
      if (a.name !== b.name || a.type !== b.type || a.localIp !== b.localIp) return false;
      if (Number(a.localPort) !== Number(b.localPort)) return false;
      if (Number(a.remotePort) !== Number(b.remotePort)) return false;
      if ((a.enabled === true) !== (b.enabled === true)) return false;
    }
    return true;
  }
  function markDraft(next) {
    ui.draft = next;
    ui.draftDirty = !sameProxies(next, publishedProxies());
    scheduleRender();
  }
  function toPublishShape(list) {
    return list.map((proxy) => ({
      name: proxy.name,
      type: 'tcp',
      localIp: proxy.localIp,
      localPort: Number(proxy.localPort),
      remotePort: Number(proxy.remotePort),
      enabled: proxy.enabled === true,
    }));
  }
  function newRemotePorts(next) {
    const known = new Set(publishedProxies().filter((proxy) => proxy.enabled).map((proxy) => Number(proxy.remotePort)));
    return [...new Set(next.filter((proxy) => proxy.enabled).map((proxy) => Number(proxy.remotePort)))]
      .filter((port) => !known.has(port));
  }
  function changedProxyCount() {
    const base = new Map(publishedProxies().map((proxy) => [proxy.name, proxy]));
    const next = new Map(currentProxies().map((proxy) => [proxy.name, proxy]));
    let count = 0;
    for (const [name, proxy] of next) {
      const old = base.get(name);
      if (!old || !sameProxies([old], [proxy])) count += 1;
    }
    for (const name of base.keys()) if (!next.has(name)) count += 1;
    return count;
  }
  function summarizeProxyChanges() {
    const base = new Map(publishedProxies().map((proxy) => [proxy.name, proxy]));
    const next = new Map(currentProxies().map((proxy) => [proxy.name, proxy]));
    const lines = [];
    for (const [name, proxy] of next) {
      const old = base.get(name);
      if (!old) lines.push(`＋ 新增 ${name} · 远程 :${proxy.remotePort}`);
      else if (!sameProxies([old], [proxy])) lines.push(`～ 修改 ${name} · 远程 :${old.remotePort} → :${proxy.remotePort}`);
    }
    for (const [name] of base) if (!next.has(name)) lines.push(`－ 删除 ${name}`);
    if (!lines.length) lines.push('代理列表没有变化');
    return lines.join('\n');
  }
  function readCollapsedState() {
    try { return window.localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (_) { return false; }
  }
  function writeCollapsedState(value) {
    try { window.localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0'); } catch (_) { /* storage closed */ }
  }
  function setProxiesCollapsed(value) {
    ui.proxiesCollapsed = value === true;
    writeCollapsedState(ui.proxiesCollapsed);
    scheduleRender();
  }
  function copyAddressOf(proxy) {
    const host = hostOf(ui.state.connection.apiBase);
    if (!host) return '';
    return `${host}:${proxy.remotePort}`;
  }
  function renderProxies() {
    const state = ui.state;
    const capable = has('publishProxies') && !!bridge;
    const editable = capable && configured();
    const proxies = editable ? currentProxies() : publishedProxies();
    const stale = state.remote.proxies.length === 0 && proxies.length > 0;
    const list = $('proxy-list');
    const empty = $('proxies-empty');

    $('proxy-count').textContent = String(proxies.length);
    const mode = $('proxy-mode');
    if (editable) {
      mode.className = 'chip chip-editable';
      mode.replaceChildren(makeIcon('edit'), document.createTextNode('可编辑'));
    } else {
      mode.className = 'chip chip-readonly';
      mode.replaceChildren(makeIcon('phone'), document.createTextNode('只读'));
    }
    $('proxy-dirty').hidden = !(editable && ui.draftDirty);

    const collapsed = ui.proxiesCollapsed;
    $('proxy-body').hidden = collapsed;
    const toggle = $('toggle-proxies');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.classList.toggle('is-collapsed', collapsed);
    toggle.setAttribute('aria-label', collapsed ? '展开代理列表' : '折叠代理列表');
    setTitle(toggle, collapsed ? '展开代理列表' : '折叠代理列表');

    empty.hidden = proxies.length > 0;
    list.hidden = proxies.length === 0;
    if (!configured()) {
      empty.querySelector('h3').textContent = '配置连接后查看代理';
      empty.querySelector('p').textContent = '填写 API 地址、电脑 ID 与 Token 后，点击「立即同步」拉取。';
    } else if (proxies.length === 0 && state.remote.reachable === false) {
      // 服务器暂时不可达时，不能显示成「手机端还没发布」，那是误导。
      empty.querySelector('h3').textContent = '暂时无法连接服务器';
      empty.querySelector('p').textContent = state.remote.error || '请检查网络后点「立即同步」重试；已生效的配置仍在运行。';
    } else if (proxies.length === 0) {
      if (editable) {
        empty.querySelector('h3').textContent = '还没有代理';
        empty.querySelector('p').textContent = '点下方「新增代理」填写本地与远程端口，发布后立即生效。';
      } else {
        empty.querySelector('h3').textContent = '手机端还没有发布代理';
        empty.querySelector('p').textContent = '去 iostool 的「FRP 客户端」添加并发布，电脑端会自动同步。';
      }
    }
    if (!configured()) {
      $('proxy-source').textContent = capable ? '配置连接后可编辑并发布' : '来自手机发布，电脑只读';
    } else if (stale) {
      $('proxy-source').textContent = `本机已生效 v${state.applied.version} · 服务器${state.remote.fetchedAt === null ? '尚未拉取' : '暂不可达'}`;
    } else {
      $('proxy-source').textContent = state.remote.version !== null
        ? `来自手机发布 · v${state.remote.version}${state.remote.updatedAt ? ` · ${formatDateTime(state.remote.updatedAt)}` : ''}`
        : (state.remote.reachable === false ? '服务器暂不可达，等待重试' : '来自手机发布，电脑只读');
    }

    const dirty = editable && ui.draftDirty;
    const add = $('add-proxy');
    add.hidden = !editable;
    add.disabled = locked();
    const publish = $('publish-proxies');
    const publishing = ui.action === 'publishProxies';
    publish.hidden = !dirty;
    publish.disabled = locked();
    publish.classList.toggle('is-loading', publishing);
    $('publish-label').textContent = publishing ? '发布中…' : '发布修改';
    const publishCount = $('publish-count');
    publishCount.hidden = !dirty;
    publishCount.textContent = dirty ? String(changedProxyCount()) : '';
    const restore = $('restore-proxies');
    restore.hidden = !dirty;
    restore.disabled = locked();
    $('proxy-foot-hint').textContent = editable
      ? (dirty ? '有未发布的修改：发布后写入服务器并立即生效。' : '修改代理后点「发布修改」，手机端同步后也会看到。')
      : (capable ? '请先完成连接设置，然后可以编辑并发布代理。' : '代理由手机端编辑；这里只能查看与复制远程地址。');

    // keyed rows, in-place updates (no focus/scroll jump)
    const seen = new Set();
    let previous = null;
    for (const proxy of proxies) {
      seen.add(proxy.name);
      let row = list.querySelector(`[data-proxy="${cssEscape(proxy.name)}"]`);
      if (!row) {
        row = buildProxyRow(proxy);
        list.append(row);
      }
      updateProxyRow(row, proxy, editable);
      if (previous === null) {
        if (list.firstElementChild !== row) list.insertBefore(row, list.firstElementChild);
      } else if (previous.nextElementSibling !== row) {
        list.insertBefore(row, previous.nextElementSibling);
      }
      previous = row;
    }
    for (const row of [...list.children]) {
      if (!seen.has(row.dataset.proxy)) row.remove();
    }
  }
  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }
  function buildProxyRow(proxy) {
    const row = makeEl('li', 'proxy-row');
    row.dataset.proxy = proxy.name;
    const badge = makeEl('span', 'type-badge');
    const body = makeEl('div', 'proxy-body');
    const head = makeEl('div', 'proxy-head');
    const name = makeEl('span', 'proxy-name');
    const enabled = makeEl('span', 'chip');
    head.append(name, enabled);
    const route = makeEl('p', 'proxy-route');
    const local = makeEl('code');
    const arrow = makeEl('span', 'route-arrow', '→');
    const remote = makeEl('code');
    route.append(local, arrow, remote);
    body.append(head, route);
    const actions = makeEl('div', 'proxy-actions');
    const copy = makeEl('button', 'icon-button proxy-copy');
    copy.type = 'button';
    copy.append(makeIcon('copy'));
    copy.addEventListener('click', () => copyProxyAddress(row.dataset.proxy));
    const edit = makeEl('button', 'icon-button proxy-edit');
    edit.type = 'button';
    edit.append(makeIcon('edit'));
    edit.addEventListener('click', () => {
      const current = currentProxies().find((item) => item.name === row.dataset.proxy);
      if (current) openProxyDialog(current);
    });
    const remove = makeEl('button', 'icon-button proxy-delete');
    remove.type = 'button';
    remove.append(makeIcon('trash'));
    remove.addEventListener('click', () => openProxyDelete(row.dataset.proxy));
    actions.append(copy, edit, remove);
    row.append(badge, body, actions);
    return row;
  }
  function updateProxyRow(row, proxy, editable) {
    row.querySelector('.type-badge').textContent = proxy.type.toUpperCase();
    row.querySelector('.proxy-name').textContent = proxy.name;
    row.querySelector('.proxy-name').title = proxy.name;
    const enabled = row.querySelector('.chip');
    enabled.textContent = proxy.enabled ? '启用' : '已停用';
    enabled.className = proxy.enabled ? 'chip chip-ok' : 'chip chip-muted';
    row.querySelector('.proxy-route code:first-child').textContent = `本地 ${proxy.localIp}:${proxy.localPort}`;
    row.querySelector('.proxy-route code:last-child').textContent = `远程 :${proxy.remotePort}`;
    const copy = row.querySelector('.proxy-copy');
    const address = copyAddressOf(proxy);
    copy.disabled = !address || ui.action !== null;
    copy.setAttribute('aria-label', `复制代理 ${proxy.name} 的远程地址`);
    setTitle(copy, address ? `复制 ${address}` : '缺少服务器地址');
    const edit = row.querySelector('.proxy-edit');
    const remove = row.querySelector('.proxy-delete');
    const canEdit = editable === true;
    edit.hidden = !canEdit;
    remove.hidden = !canEdit;
    edit.disabled = locked();
    remove.disabled = locked();
    edit.setAttribute('aria-label', `编辑代理 ${proxy.name}`);
    remove.setAttribute('aria-label', `删除代理 ${proxy.name}`);
    setTitle(edit, '编辑代理');
    setTitle(remove, '删除代理');
  }
  async function copyProxyAddress(name) {
    const proxy = currentProxies().find((item) => item.name === name);
    if (!proxy) return;
    const address = copyAddressOf(proxy);
    if (!address) { notify('缺少服务器地址，无法生成远程地址。', { error: true }); return; }
    const result = await callBridge('copyText', [address], { applyState: false, action: 'copyText' });
    if (result.ok) notify(`已复制 ${address}`);
  }

  // ---------- proxy editor + publish ----------
  function clearProxyErrors() {
    setFieldError('proxy-name', 'proxy-name-error', '');
    setFieldError('proxy-local-ip', 'proxy-local-ip-error', '');
    setFieldError('proxy-local-port', 'proxy-local-port-error', '');
    setFieldError('proxy-remote-port', 'proxy-remote-port-error', '');
    const formError = $('proxy-form-error');
    formError.hidden = true;
    formError.textContent = '';
  }
  function openProxyDialog(proxy) {
    if (!canEditProxies() || locked()) return;
    ui.editingProxyName = proxy ? proxy.name : null;
    $('proxy-dialog-title').textContent = proxy ? '编辑代理' : '新增代理';
    $('proxy-dialog-desc').textContent = proxy
      ? '修改后点「保存并发布」，服务器与本机会立即更新。'
      : '保存后会发布到服务器，本机与手机端都会看到同一份代理列表。';
    $('proxy-name').value = proxy ? proxy.name : '';
    $('proxy-type').value = 'tcp';
    $('proxy-local-ip').value = proxy ? proxy.localIp : '127.0.0.1';
    $('proxy-local-port').value = proxy ? String(proxy.localPort) : '';
    $('proxy-remote-port').value = proxy ? String(proxy.remotePort) : '';
    $('proxy-enabled').checked = proxy ? proxy.enabled : true;
    $('proxy-enabled-text').textContent = $('proxy-enabled').checked ? '已启用' : '已停用';
    clearProxyErrors();
    const dialog = $('proxy-dialog');
    if (!dialog.open) dialog.showModal();
    $('proxy-name').focus();
  }
  function openProxyDelete(name) {
    if (!has('publishProxies') || locked()) return;
    const proxy = currentProxies().find((item) => item.name === name);
    if (!proxy) return;
    openConfirm('delete', { name });
  }
  function readProxyForm() {
    return {
      name: $('proxy-name').value.trim(),
      type: $('proxy-type').value,
      localIp: $('proxy-local-ip').value.trim() || '127.0.0.1',
      localPort: Number($('proxy-local-port').value),
      remotePort: Number($('proxy-remote-port').value),
      enabled: $('proxy-enabled').checked,
    };
  }
  function validateProxyValues(values, originalName) {
    const errors = {};
    const others = currentProxies().filter((proxy) => proxy.name !== originalName);
    if (!values.name) errors.name = '请填写代理名称。';
    else if (!PROXY_NAME_RE.test(values.name)) errors.name = '只能使用字母、数字、下划线或短横线，最长 64 个字符。';
    else if (others.some((proxy) => proxy.name.toLowerCase() === values.name.toLowerCase())) {
      errors.name = `代理名「${values.name}」已存在，请换一个。`;
    }
    if (values.type !== 'tcp') errors.type = '首版只支持 TCP 类型。';
    if (!values.localIp) errors.localIp = '请填写本地地址，例如 127.0.0.1。';
    else if (/\s/.test(values.localIp)) errors.localIp = '本地地址不能包含空格。';
    if (!Number.isInteger(values.localPort) || values.localPort < 1 || values.localPort > 65535) {
      errors.localPort = '本地端口需为 1-65535 的整数。';
    }
    if (!Number.isInteger(values.remotePort) || values.remotePort < 1 || values.remotePort > 65535) {
      errors.remotePort = '远程端口需为 1-65535 的整数。';
    } else if (values.enabled && others.some((proxy) => proxy.enabled && Number(proxy.remotePort) === values.remotePort)) {
      errors.remotePort = `远程端口 ${values.remotePort} 已被其它已启用代理占用。`;
    }
    return errors;
  }
  function showProxyErrors(errors) {
    setFieldError('proxy-name', 'proxy-name-error', errors.name || '');
    setFieldError('proxy-local-ip', 'proxy-local-ip-error', errors.localIp || '');
    setFieldError('proxy-local-port', 'proxy-local-port-error', errors.localPort || '');
    setFieldError('proxy-remote-port', 'proxy-remote-port-error', errors.remotePort || '');
    const formError = $('proxy-form-error');
    formError.hidden = true;
    formError.textContent = '';
    const map = { name: 'proxy-name', localIp: 'proxy-local-ip', localPort: 'proxy-local-port', remotePort: 'proxy-remote-port' };
    const first = Object.keys(map).find((key) => errors[key]);
    if (first) $(map[first]).focus();
  }
  function submitProxyForm(event) {
    if (event) event.preventDefault();
    if (!has('publishProxies') || ui.action !== null) return;
    const values = readProxyForm();
    const errors = validateProxyValues(values, ui.editingProxyName);
    showProxyErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const next = currentProxies().map((proxy) => ({ ...proxy }));
    const index = next.findIndex((proxy) => proxy.name === ui.editingProxyName);
    if (index >= 0) next[index] = values; else next.push(values);
    markDraft(next);
    $('proxy-dialog').close();
    openConfirm('publish');
  }
  function openConfirm(kind, payload) {
    if (kind !== 'restore' && !has('publishProxies')) return;
    const name = payload && payload.name ? payload.name : '';
    const proxy = name ? currentProxies().find((item) => item.name === name) : null;
    ui.confirm = { kind, payload: payload || null };
    const icon = $('confirm-icon');
    icon.className = 'dialog-icon is-accent';
    icon.replaceChildren(makeIcon(kind === 'delete' ? 'trash' : kind === 'restore' ? 'restart' : 'sync'));
    const title = $('confirm-title');
    const desc = $('confirm-desc');
    const detail = $('confirm-detail');
    const warning = $('confirm-warning');
    if (kind === 'restore') {
      title.textContent = '从服务器恢复？';
      desc.textContent = '将放弃本机未发布的修改，重新从服务器拉取当前配置并应用。';
      detail.textContent = `未发布的修改：${changedProxyCount()} 处`;
      detail.hidden = false;
      warning.hidden = true;
    } else if (kind === 'delete') {
      title.textContent = '删除代理并发布？';
      desc.textContent = '删除后会立即发布剩余代理列表，手机端同步后也会移除这条代理。';
      detail.textContent = proxy
        ? `将删除「${proxy.name}」· 本地 ${proxy.localIp}:${proxy.localPort} → 远程 :${proxy.remotePort}`
        : '';
      detail.hidden = !proxy;
      warning.hidden = false;
      warning.textContent = '发布后会自动校验并重启 frpc，隧道会短暂断开；失败时旧配置与旧进程保留。';
    } else {
      title.textContent = '发布代理修改？';
      desc.textContent = '发布会写入服务器配置，手机端同步后也能看到同一份代理；本机会立即拉取并生效。';
      detail.textContent = summarizeProxyChanges();
      detail.hidden = false;
      const ports = newRemotePorts(currentProxies());
      warning.hidden = false;
      warning.textContent = ports.length
        ? `本次新增远程端口 ${ports.map((port) => `:${port}`).join('、')}：服务器会在几秒内重建 frps，期间隧道会短暂断开，完成后自动生效。`
        : '发布后会自动校验并重启 frpc，通常几秒内生效；失败时旧配置与旧进程保留。';
    }
    $('confirm-ok').textContent = kind === 'delete' ? '删除并发布' : kind === 'restore' ? '从服务器恢复' : '发布';
    $('confirm-cancel').disabled = false;
    const dialog = $('confirm-dialog');
    if (!dialog.open) dialog.showModal();
    renderConfirmDialog();
  }
  function closeConfirm() {
    const dialog = $('confirm-dialog');
    if (!dialog.open) { ui.confirm = null; return; }
    ui.confirm = null;
    dialog.close();
    scheduleRender();
  }
  function renderConfirmDialog() {
    const dialog = $('confirm-dialog');
    if (!dialog.open) return;
    const busy = ui.action !== null;
    $('confirm-cancel').disabled = busy;
    $('confirm-ok').disabled = busy;
    if (ui.action === 'publishProxies') $('confirm-ok').textContent = '发布中…';
    else if (ui.action === 'syncNow') $('confirm-ok').textContent = '同步中…';
    else if (ui.confirm) {
      $('confirm-ok').textContent = ui.confirm.kind === 'delete'
        ? '删除并发布'
        : ui.confirm.kind === 'restore' ? '从服务器恢复' : '发布';
    }
  }
  async function publishDraft() {
    ui.suppressSyncToast = true;
    let result;
    try {
      result = await callBridge('publishProxies', [toPublishShape(currentProxies())], {
        action: 'publishProxies', silent: true, fallback: '发布失败，请稍后重试。',
      });
    } finally {
      ui.suppressSyncToast = false;
    }
    if (!result.ok) {
      notify(result.message || '发布失败，请稍后重试。', { error: true });
      closeConfirm();
      scheduleRender();
      return;
    }
    const state = result.value && isState(result.value) ? normalizeState(result.value) : ui.state;
    ui.draft = cloneProxies(publishedProxies());
    ui.draftDirty = false;
    closeConfirm();
    const version = state.remote.version !== null ? state.remote.version : state.applied.version;
    notify(version === null ? '已发布并生效' : `已发布 v${version} 并生效`);
  }
  async function restoreDraftFromServer() {
    ui.suppressSyncToast = true;
    let result;
    try {
      result = await callBridge('syncNow', [{ force: true }], { action: 'syncNow', silent: true, fallback: '从服务器恢复失败。' });
    } finally {
      ui.suppressSyncToast = false;
    }
    if (!result.ok) {
      notify(result.message || '从服务器恢复失败。', { error: true });
      closeConfirm();
      return;
    }
    ui.draft = cloneProxies(publishedProxies());
    ui.draftDirty = false;
    closeConfirm();
    notify('已从服务器恢复最新配置');
  }
  async function onConfirmOk() {
    const confirm = ui.confirm;
    if (!confirm || ui.action !== null) return;
    if (confirm.kind === 'publish') { await publishDraft(); return; }
    if (confirm.kind === 'delete') {
      const name = confirm.payload && confirm.payload.name;
      const next = currentProxies().filter((proxy) => proxy.name !== name);
      ui.draft = next;
      ui.draftDirty = !sameProxies(next, publishedProxies());
      await publishDraft();
      return;
    }
    if (confirm.kind === 'restore') await restoreDraftFromServer();
  }

  // ---------- config ----------
  function renderConfig() {
    const applied = ui.state.applied;
    $('config-version').textContent = applied.version === null ? 'v—' : `v${applied.version}`;
    $('config-version').className = applied.version === null ? 'chip chip-muted' : 'chip chip-ok';
    $('config-path').textContent = applied.configPath || '尚未生成配置';
    setTitle($('config-path'), applied.configPath || '');
    $('config-note').textContent = applied.backupPath
      ? '已保留上一版备份'
      : applied.version === null ? '同步成功后写入' : '当前生效的配置';
    const ready = applied.version !== null && !!applied.configPath;
    const view = $('view-config');
    view.disabled = !ui.host || !ready || ui.action !== null;
    setTitle(view, ready ? '查看服务器下发的配置内容' : '同步成功后可查看');
    const verify = $('verify-config');
    verify.disabled = !ui.host || !ready || !binaryReady() || ui.action !== null;
    setTitle(verify, !binaryReady() ? '需要先准备 frpc 程序' : '用 frpc verify 校验当前配置');
    const open = $('open-config-dir');
    open.disabled = !ui.host || !ready || ui.action !== null;
    setTitle(open, '打开运行目录');
  }

  // ---------- binary ----------
  function renderBinary() {
    const binary = ui.state.frpc.binary;
    const chip = $('binary-chip');
    const source = $('binary-source');
    const path = $('binary-path');
    const note = $('binary-note');
    if (binary.status === 'ready') {
      chip.textContent = `已就绪${binary.version ? ` · v${binary.version}` : ''}`;
      chip.className = 'chip chip-ok';
      source.hidden = false;
      source.textContent = binary.source === 'custom' ? '自定义路径' : '自动下载';
      source.className = 'chip chip-muted';
      path.textContent = binary.path || '已就绪';
      note.textContent = '启动与同步都需要它';
    } else {
      chip.textContent = '缺失';
      chip.className = 'chip chip-warn';
      source.hidden = true;
      path.textContent = binary.path ? `未找到可执行文件：${binary.path}` : '未检测到 frpc，请先下载';
      note.textContent = '首次使用需下载';
    }
    setTitle(path, binary.path || '');
    const downloading = !!(binary.download && binary.download.active);
    const download = $('download-binary');
    download.hidden = binary.status === 'ready' && !downloading;
    download.disabled = !ui.host || ui.action !== null || downloading || !configured();
    setTitle(download, !configured() ? '请先完成连接设置' : downloading ? '正在下载' : '从 GitHub 下载 frpc 并校验版本');
    const pick = $('pick-binary');
    pick.textContent = binary.status === 'ready' ? '更换路径' : '指定路径';
    pick.disabled = !ui.host || ui.action !== null || !configured();
    setTitle(pick, !configured() ? '请先完成连接设置' : '选择本机已有的 frpc.exe');
    renderDownloadBox();
  }

  function fillProgress(element, percent) {
    if (!element) return;
    if (Number.isFinite(percent) && percent >= 0) element.value = Math.max(0, Math.min(100, percent));
    else element.removeAttribute('value');
  }
  function renderDownloadBox() {
    const download = ui.state.frpc.binary.download;
    const box = $('download-box');
    const active = !!(download && download.active);
    const failed = !!(download && download.error);
    box.hidden = !active && !failed;
    if (!active && !failed) return;
    const title = $('download-title');
    const percentText = $('download-percent');
    const bar = $('download-progress');
    const detail = $('download-detail');
    if (failed && !active) {
      title.textContent = '下载失败';
      percentText.textContent = '';
      fillProgress(bar, null);
      detail.textContent = download.error;
      return;
    }
    title.textContent = `正在下载 frpc ${download.version || ''}`.trim();
    const percent = download.percent;
    fillProgress(bar, percent >= 0 ? percent : null);
    if (percent >= 0) {
      percentText.textContent = `${percent.toFixed(1)}%`;
      setTitle(bar, `${percent.toFixed(1)}%`);
    } else {
      percentText.textContent = '计算中…';
      setTitle(bar, '总大小未知');
    }
    const received = bytes(download.receivedBytes);
    const total = bytes(download.totalBytes);
    detail.textContent = received ? (total ? `${received} / ${total}` : `已接收 ${received}`) : '正在连接下载源…';
  }

  // ---------- logs ----------
  function normalizeLog(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const text = str(raw.text, 4000);
    if (!text) return null;
    return {
      id: Number.isFinite(Number(raw.id)) ? Number(raw.id) : null,
      at: num(raw.at, Date.now()),
      source: raw.source === 'frpc' ? 'frpc' : 'sync',
      level: ['debug', 'info', 'warn', 'error'].includes(raw.level) ? raw.level : 'info',
      text,
    };
  }
  function listFor(source) { return $(source === 'frpc' ? 'log-frpc-list' : 'log-sync-list'); }
  function queueLogs(entries) {
    if (!Array.isArray(entries) || !entries.length) return;
    let added = false;
    for (const raw of entries) {
      const entry = normalizeLog(raw);
      if (!entry) continue;
      if (entry.id !== null) {
        if (ui.logIds.has(entry.id)) continue;
        ui.logIds.add(entry.id);
      }
      ui.pendingLogs.push(entry);
      added = true;
    }
    if (!added) return;
    if (ui.logRaf) return;
    ui.logRaf = requestAnimationFrame(flushLogs);
  }
  function buildLogLine(entry) {
    const line = makeEl('li', `log-line is-${entry.level}`);
    line.dataset.source = entry.source;
    line.append(makeEl('span', 'log-time', formatTime(entry.at)));
    line.append(makeEl('span', 'log-level', LEVEL_MARK[entry.level] || 'I'));
    line.append(makeEl('span', 'log-text', entry.text));
    return line;
  }
  function flushLogs() {
    ui.logRaf = 0;
    const batch = ui.pendingLogs;
    ui.pendingLogs = [];
    if (!batch.length) return;
    const fragments = { sync: document.createDocumentFragment(), frpc: document.createDocumentFragment() };
    for (const entry of batch) {
      ui.logs.push(entry);
      fragments[entry.source].append(buildLogLine(entry));
    }
    listFor('sync').append(fragments.sync);
    listFor('frpc').append(fragments.frpc);
    if (ui.logs.length > LOG_LIMIT) ui.logs = ui.logs.slice(-LOG_LIMIT);
    const syncList = listFor('sync');
    const frpcList = listFor('frpc');
    let overflow = syncList.childElementCount + frpcList.childElementCount - LOG_LIMIT;
    while (overflow > 0) {
      const target = syncList.childElementCount >= frpcList.childElementCount ? syncList : frpcList;
      if (!target.firstElementChild) break;
      target.firstElementChild.remove();
      overflow -= 1;
    }
    if (ui.logIds.size > 8000) {
      ui.logIds = new Set(ui.logs.map((entry) => entry.id).filter((id) => id !== null));
    }
    renderLogs();
    scrollLogsToBottom();
  }
  function activeList() { return listFor(ui.logTab); }
  function activeCount() { return activeList().childElementCount; }
  function scrollLogsToBottom() {
    if (!ui.autoScroll) return;
    const view = $('log-view');
    view.scrollTop = view.scrollHeight;
  }
  function renderLogs() {
    const syncCount = listFor('sync').childElementCount;
    const frpcCount = listFor('frpc').childElementCount;
    $('sync-count').textContent = String(syncCount);
    $('frpc-count').textContent = String(frpcCount);
    const empty = $('log-empty');
    empty.hidden = activeCount() > 0;
    empty.textContent = ui.logTab === 'sync'
      ? '暂无同步日志。点击「立即同步」后这里会显示拉取、校验与重启过程。'
      : '暂无 frpc 日志。frpc 启动后这里会实时显示输出。';
    $('copy-logs').disabled = activeCount() === 0 || ui.action !== null;
    $('clear-logs').disabled = (syncCount + frpcCount) === 0 || ui.action !== null;
    $('open-log-folder').disabled = !has('openFolder') || ui.action !== null;
    syncChecked($('autoscroll'), ui.autoScroll);
  }
  function selectLogTab(tab, focus = false) {
    ui.logTab = tab === 'frpc' ? 'frpc' : 'sync';
    for (const name of ['sync', 'frpc']) {
      const button = $(`tab-${name}`);
      const active = name === ui.logTab;
      button.setAttribute('aria-selected', String(active));
      button.classList.toggle('is-active', active);
      button.tabIndex = active ? 0 : -1;
      listFor(name).hidden = !active;
    }
    if (focus) $(`tab-${ui.logTab}`).focus();
    renderLogs();
    scrollLogsToBottom();
  }
  function clearLogDom() {
    ui.logs = [];
    ui.logIds = new Set();
    ui.pendingLogs = [];
    if (ui.logRaf) {
      cancelAnimationFrame(ui.logRaf);
      ui.logRaf = 0;
    }
    listFor('sync').replaceChildren();
    listFor('frpc').replaceChildren();
    renderLogs();
  }
  function logTextOf(entry) {
    return `${formatTime(entry.at)} [${LEVEL_MARK[entry.level] || 'I'}] ${entry.text}`;
  }

  // ---------- footer / dialogs ----------
  function renderFooter() {
    for (const id of ['open-data-folder', 'open-run-folder', 'open-log-folder-2', 'open-bin-folder', 'open-log-folder']) {
      const button = $(id);
      if (!button) continue;
      button.disabled = !has('openFolder') || ui.action !== null;
    }
  }
  const APP_VERSION_LABEL = () => {
    const version = str(bridge && bridge.appVersion, 40) || APP_VERSION;
    $('app-version').textContent = `v${version}`;
  };

  function renderDialogs() {
    const downloading = !!(ui.state.frpc.binary.download && ui.state.frpc.binary.download.active);
    const selected = $('version-select').value;
    const start = $('download-start');
    start.disabled = !has('downloadBinary') || downloading || ui.action !== null || !selected;
    start.textContent = downloading ? '下载中…' : '开始下载';
    $('download-manual').disabled = !has('pickBinary') || downloading || ui.action !== null;
    const progressBox = $('download-dialog-progress');
    const download = ui.state.frpc.binary.download;
    if ($('download-dialog').open && download && (download.active || download.error)) {
      progressBox.hidden = false;
      $('download-dialog-title-text').textContent = download.active
        ? `正在下载 frpc ${download.version || ''}`.trim()
        : '上次下载失败';
      const percent = download.percent;
      fillProgress($('download-dialog-bar'), download.active && percent >= 0 ? percent : null);
      $('download-dialog-percent').textContent = download.active && percent >= 0 ? `${percent.toFixed(1)}%` : '';
      const received = bytes(download.receivedBytes);
      const total = bytes(download.totalBytes);
      $('download-dialog-detail').textContent = download.active
        ? (received ? (total ? `${received} / ${total}` : `已接收 ${received}`) : '正在连接下载源…')
        : (download.error || '');
    } else if (!download || (!download.active && !download.error)) {
      progressBox.hidden = true;
    }
    $('proxy-save').disabled = ui.action !== null || !has('publishProxies');
    renderConfirmDialog();
  }
  function setFieldError(inputId, errorId, message) {
    const input = $(inputId);
    const error = $(errorId);
    if (!input || !error) return;
    error.textContent = message || '';
    error.hidden = !message;
    if (message) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', errorId);
    } else {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }
  }

  // ---------- connection actions ----------
  function validateApiBase(showError) {
    const value = $('api-base').value.trim();
    if (!value) {
      if (showError) setFieldError('api-base', 'api-base-error', '请填写 API 地址，例如 http://103.47.80.133。');
      return false;
    }
    let url;
    try { url = new URL(value); } catch (_) {
      if (showError) setFieldError('api-base', 'api-base-error', '地址格式不正确，需要以 http:// 或 https:// 开头。');
      return false;
    }
    if (!/^https?:$/.test(url.protocol)) {
      if (showError) setFieldError('api-base', 'api-base-error', '只支持 http:// 或 https:// 地址。');
      return false;
    }
    if (showError) setFieldError('api-base', 'api-base-error', '');
    return true;
  }
  function validatePcId(showError) {
    const value = $('pc-id').value.trim();
    if (!value) {
      if (showError) setFieldError('pc-id', 'pc-id-error', '请填写电脑 ID，例如 pc-home。');
      return false;
    }
    if (!PC_ID_RE.test(value)) {
      if (showError) setFieldError('pc-id', 'pc-id-error', '只能使用字母、数字、下划线或短横线，最长 64 个字符。');
      return false;
    }
    if (showError) setFieldError('pc-id', 'pc-id-error', '');
    return true;
  }
  function currentConnectionPatch() {
    const connection = ui.state.connection;
    const patch = {
      apiBase: $('api-base').value.trim() || connection.apiBase,
      pcId: $('pc-id').value.trim() || connection.pcId,
    };
    const token = $('pc-token').value.trim();
    if (token) patch.pcToken = token;
    return patch;
  }
  function flashConnectionHint(message) {
    const hint = $('connection-hint');
    const original = ui.state.connection.hasToken
      ? 'Token 只保存在本机，不会出现在日志或界面里。'
      : '默认服务器 http://103.47.80.133、电脑 ID pc-home；Token 由 iostool 生成，只保存在本机。';
    hint.textContent = message;
    clearTimeout(ui.connectionHintTimer);
    ui.connectionHintTimer = setTimeout(() => { hint.textContent = original; }, 2400);
  }
  async function saveConnection(options = {}) {
    if (!bridge || ui.action !== null) return { ok: false };
    const patch = currentConnectionPatch();
    const result = await callBridge('saveConnection', [patch], { action: 'saveConnection', silent: true, fallback: '连接设置保存失败。' });
    if (result.ok) {
      ui.testResult = null;
      flashConnectionHint(options.hint || '连接设置已保存');
      if (patch.pcToken) $('pc-token').value = '';
    } else {
      notify(result.message, { error: true });
      if (result.error && result.error.code === 'VALIDATION') {
        setFieldError('api-base', 'api-base-error', result.message);
      }
      scheduleRender();
    }
    return result;
  }
  async function testConnection() {
    if (!bridge || ui.action !== null) return;
    if (!validateApiBase(true) || !validatePcId(true)) return;
    if (!configuredWithInputs()) {
      setFieldError('pc-token', 'pc-token-error', '请先填写电脑 Token。');
      return;
    }
    setFieldError('pc-token', 'pc-token-error', '');
    ui.testResult = null;
    const result = await callBridge('testConnection', [], { applyState: false, action: 'testConnection', silent: true, fallback: '连接测试失败。' });
    if (!result.ok) {
      ui.testResult = { ok: false, message: result.message };
      notify(result.message, { error: true });
    } else {
      const payload = result.value && typeof result.value === 'object' ? result.value : {};
      const version = Number.isFinite(Number(payload.version)) ? Number(payload.version) : null;
      const detail = payload.ok
        ? (version !== null ? `已发布 v${version}` : (payload.message || ''))
        : (payload.message || '服务器不可用');
      ui.testResult = { ok: payload.ok === true, message: detail, detail };
      if (payload.ok !== true) notify(payload.message || '连接测试未通过。', { error: true });
      else notify('连接测试通过。');
    }
    scheduleRender();
  }

  // ---------- binary actions ----------
  function populateVersions(payload) {
    ui.versions = payload && typeof payload === 'object' ? payload : null;
    const select = $('version-select');
    const versions = Array.isArray(payload && payload.versions)
      ? payload.versions.map((item) => str(item, 40)).filter(Boolean).slice(0, 40)
      : [];
    const recommended = str(payload && payload.recommended, 40);
    const latest = str(payload && payload.latest, 40);
    const ordered = [];
    if (recommended) ordered.push(recommended);
    for (const version of versions) if (!ordered.includes(version)) ordered.push(version);
    if (!ordered.length && latest) ordered.push(latest);
    select.replaceChildren();
    for (const version of ordered) {
      const option = document.createElement('option');
      option.value = version;
      option.textContent = version === recommended ? `${version}（推荐）` : version === latest ? `${version}（最新）` : version;
      select.append(option);
    }
    select.disabled = ordered.length === 0;
    if (ordered.length) select.value = recommended || ordered[0];
    const note = $('version-note');
    note.textContent = ordered.length
      ? `推荐 ${recommended || ordered[0]}：需与服务端 frps 同 minor 版本（frps 0.71 → frpc 0.71.x）。`
      : '未能获取版本列表，请改用「手动指定 frpc.exe」。';
  }
  async function loadVersions() {
    if (ui.versionLoading) return;
    if (ui.versions) { populateVersions(ui.versions); return; }
    ui.versionLoading = true;
    $('version-select').disabled = true;
    $('version-note').textContent = '正在获取版本列表…';
    try {
      const payload = has('listVersions') ? await bridge.listVersions() : null;
      populateVersions(payload);
    } catch (error) {
      populateVersions(null);
      $('version-note').textContent = msgOf(error, '获取版本列表失败，可改用「手动指定 frpc.exe」。');
    } finally {
      ui.versionLoading = false;
      renderDialogs();
    }
  }
  function openDownloadDialog() {
    if (!bridge) return;
    const dialog = $('download-dialog');
    $('download-dialog-error').hidden = true;
    if (!dialog.open) dialog.showModal();
    renderDialogs();
    loadVersions();
  }
  function closeDownloadDialog() {
    const dialog = $('download-dialog');
    if (dialog.open) dialog.close();
  }
  // frpc 一旦就绪（下载完成、手动指定路径、或外部安装），就把下载弹窗收掉，
  // 避免出现「已经就绪还让用户安装」的状态。
  function reconcileDownloadDialog() {
    const dialog = $('download-dialog');
    if (!dialog.open) return false;
    const binary = ui.state.frpc.binary;
    const download = binary.download;
    const downloading = !!(download && download.active);
    const failed = !!(download && download.error);
    if (binary.status === 'ready' && !downloading && !failed) {
      closeDownloadDialog();
      return true;
    }
    return false;
  }

  // ---------- events ----------
  function bindEvents() {
    // status actions
    $('sync-now').addEventListener('click', async () => {
      if (locked()) return;
      const result = await callBridge('syncNow', [], { action: 'syncNow', fallback: '同步失败，请查看同步日志。' });
      if (result.ok) scheduleRender();
    });
    $('toggle-frpc').addEventListener('click', async () => {
      if (locked()) return;
      if (ui.state.frpc.running) await callBridge('stopFrpc', [], { action: 'stopFrpc', fallback: '停止 frpc 失败。' });
      else await callBridge('startFrpc', [], { action: 'startFrpc', fallback: '启动 frpc 失败，请查看日志。' });
    });
    $('restart-frpc').addEventListener('click', async () => {
      if (locked()) return;
      await callBridge('restartFrpc', [], { action: 'restartFrpc', fallback: '重启 frpc 失败。' });
    });
    $('autosync').addEventListener('change', async () => {
      if (locked()) return;
      const enabled = $('autosync').checked;
      const interval = Number($('sync-interval').value) || ui.state.autoSync.intervalSec;
      const result = await callBridge('setAutoSync', [enabled, interval], { action: 'setAutoSync', fallback: '自动同步设置失败。' });
      if (result.ok) notify(enabled ? `已开启自动同步（${interval} 秒）` : '已关闭自动同步');
      else syncChecked($('autosync'), ui.state.autoSync.enabled);
    });
    $('start-on-launch').addEventListener('change', async () => {
      if (locked()) return;
      const enabled = $('start-on-launch').checked;
      const result = await callBridge('setStartOnLaunch', [enabled], { action: 'setStartOnLaunch', fallback: '启动时自动同步设置失败。' });
      if (result.ok) notify(enabled ? '已开启启动时自动同步' : '已关闭启动时自动同步');
      else syncChecked($('start-on-launch'), ui.state.autoSync.startOnLaunch);
    });
    $('sync-interval').addEventListener('change', async () => {
      if (locked()) return;
      const interval = Number($('sync-interval').value);
      if (!INTERVALS.includes(interval)) return;
      const result = await callBridge('setAutoSync', [ui.state.autoSync.enabled, interval], { action: 'setAutoSync', fallback: '自动同步间隔保存失败。' });
      if (result.ok) notify(`自动同步间隔已改为 ${interval} 秒`);
    });

    // connection
    $('connection-form').addEventListener('submit', (event) => event.preventDefault());
    $('api-base').addEventListener('change', () => {
      if (validateApiBase(true)) saveConnection({ hint: 'API 地址已保存' });
    });
    $('pc-id').addEventListener('change', () => {
      if (validatePcId(true)) saveConnection({ hint: '电脑 ID 已保存' });
    });
    $('pc-token').addEventListener('change', () => {
      const value = $('pc-token').value.trim();
      if (!value) {
        setFieldError('pc-token', 'pc-token-error', '');
        return;
      }
      if (value.length < 8) {
        setFieldError('pc-token', 'pc-token-error', 'Token 看起来太短，请从 iostool 复制完整 token。');
        return;
      }
      setFieldError('pc-token', 'pc-token-error', '');
      saveConnection({ hint: 'Token 已保存' });
    });
    $('toggle-token').addEventListener('click', () => {
      const input = $('pc-token');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      $('toggle-token').textContent = show ? '隐藏' : '显示';
      $('toggle-token').setAttribute('aria-pressed', String(show));
      $('toggle-token').setAttribute('aria-label', show ? '隐藏 token' : '显示 token');
    });
    $('test-connection').addEventListener('click', () => testConnection());

    // config
    $('view-config').addEventListener('click', async () => {
      if (ui.action !== null || !has('getConfigText')) return;
      ui.action = 'getConfigText';
      scheduleRender();
      try {
        const payload = await bridge.getConfigText();
        const text = str(payload && payload.text, 200000) || '（配置为空）';
        const path = str(payload && payload.path, 1000);
        const version = Number.isFinite(Number(payload && payload.version)) ? Number(payload.version) : null;
        $('config-text').textContent = text;
        $('config-dialog-title').textContent = `生效配置${version !== null ? ` · v${version}` : ''}`;
        $('config-dialog-note').textContent = path ? `路径：${path}` : '';
        $('config-dialog').showModal();
      } catch (error) {
        notify(msgOf(error, '读取配置失败。'), { error: true });
      } finally {
        ui.action = null;
        scheduleRender();
      }
    });
    $('config-close').addEventListener('click', () => $('config-dialog').close());
    $('config-copy').addEventListener('click', async () => {
      const text = $('config-text').textContent || '';
      if (!text) return;
      const result = await callBridge('copyText', [text], { applyState: false, action: 'copyText', silent: true });
      if (result.ok) notify('配置内容已复制。');
      else notify(result.message, { error: true });
    });
    $('verify-config').addEventListener('click', async () => {
      if (locked()) return;
      const result = await callBridge('verifyConfig', [], { applyState: false, action: 'verifyConfig', silent: true, fallback: '配置校验失败。' });
      if (!result.ok) { notify(result.message, { error: true }); return; }
      const payload = result.value && typeof result.value === 'object' ? result.value : {};
      if (payload.ok) notify('配置校验通过。');
      else notify(`配置校验未通过：${str(payload.message, 600) || '请查看配置内容。'}`, { error: true });
    });
    $('open-config-dir').addEventListener('click', () => openFolder('run'));

    // binary
    $('download-binary').addEventListener('click', openDownloadDialog);
    $('pick-binary').addEventListener('click', async () => {
      if (locked()) return;
      const result = await callBridge('pickBinary', [], { action: 'pickBinary', silent: true, fallback: '选择 frpc 可执行文件失败。' });
      if (result.ok) {
        if (ui.state.frpc.binary.status === 'ready') notify(`已使用 ${ui.state.frpc.binary.version || 'frpc'}。`);
      } else if (result.message && !/取消|未选择/.test(result.message)) {
        notify(result.message, { error: true });
      }
    });
    $('download-start').addEventListener('click', async () => {
      const version = $('version-select').value;
      if (!version || ui.action !== null) return;
      ui.downloadPending = true;
      $('download-dialog-error').hidden = true;
      const result = await callBridge('downloadBinary', [version], { action: 'downloadBinary', silent: true, fallback: '下载 frpc 失败。' });
      if (!result.ok) {
        ui.downloadPending = false;
        const error = $('download-dialog-error');
        error.textContent = result.message || '下载失败，可改用「手动指定 frpc.exe」。';
        error.hidden = false;
        scheduleRender();
        return;
      }
      // 下载成功：立刻收弹窗并提示，避免「已就绪还让安装」。
      ui.downloadPending = false;
      const binary = ui.state.frpc.binary;
      if (binary.status === 'ready') {
        closeDownloadDialog();
        notify(`frpc ${binary.version || version} 已就绪`);
        return;
      }
      // 状态还没推过来时也把弹窗收掉，下一次状态更新会补齐。
      closeDownloadDialog();
    });
    $('download-later').addEventListener('click', closeDownloadDialog);
    $('download-manual').addEventListener('click', async () => {
      if (!has('pickBinary') || ui.action !== null) return;
      closeDownloadDialog();
      await callBridge('pickBinary', [], { action: 'pickBinary', silent: true, fallback: '选择 frpc 可执行文件失败。' });
    });
    $('download-dialog').addEventListener('close', () => {
      const error = $('download-dialog-error');
      error.hidden = true;
      error.textContent = '';
    });

    // proxies: collapse, edit, publish
    $('toggle-proxies').addEventListener('click', () => setProxiesCollapsed(!ui.proxiesCollapsed));
    $('add-proxy').addEventListener('click', () => openProxyDialog(null));
    $('publish-proxies').addEventListener('click', () => { if (ui.draftDirty) openConfirm('publish'); });
    $('restore-proxies').addEventListener('click', () => openConfirm('restore'));
    $('proxy-form').addEventListener('submit', submitProxyForm);
    $('proxy-cancel').addEventListener('click', () => $('proxy-dialog').close());
    $('proxy-enabled').addEventListener('change', () => {
      $('proxy-enabled-text').textContent = $('proxy-enabled').checked ? '已启用' : '已停用';
    });
    $('proxy-dialog').addEventListener('close', () => {
      ui.editingProxyName = null;
      clearProxyErrors();
    });
    $('confirm-cancel').addEventListener('click', closeConfirm);
    $('confirm-ok').addEventListener('click', onConfirmOk);
    $('confirm-dialog').addEventListener('close', () => {
      ui.confirm = null;
      scheduleRender();
    });

    // logs
    $('tab-sync').addEventListener('click', () => selectLogTab('sync'));
    $('tab-frpc').addEventListener('click', () => selectLogTab('frpc'));
    document.querySelector('.log-tabs').addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'sync' : event.key === 'End' ? 'frpc' : ui.logTab === 'sync' ? 'frpc' : 'sync';
      selectLogTab(next, true);
    });
    $('autoscroll').addEventListener('change', () => {
      ui.autoScroll = $('autoscroll').checked;
      scrollLogsToBottom();
    });
    $('log-view').addEventListener('scroll', () => {
      if (!ui.autoScroll) return;
      const view = $('log-view');
      if (view.scrollHeight - view.scrollTop - view.clientHeight > 28) {
        ui.autoScroll = false;
        $('autoscroll').checked = false;
      }
    });
    $('clear-logs').addEventListener('click', async () => {
      if (ui.action !== null) return;
      if (has('clearLogs')) {
        const result = await callBridge('clearLogs', [], { action: 'clearLogs', fallback: '清空日志失败。' });
        if (!result.ok) return;
      }
      clearLogDom();
      notify('日志已清空。');
    });
    $('copy-logs').addEventListener('click', async () => {
      if (ui.action !== null) return;
      const lines = [...activeList().children].map((line) => {
        const time = line.querySelector('.log-time').textContent;
        const level = line.querySelector('.log-level').textContent;
        const text = line.querySelector('.log-text').textContent;
        return `${time} [${level}] ${text}`;
      });
      if (!lines.length) { notify('当前日志为空。'); return; }
      const result = await callBridge('copyText', [lines.join('\n')], { applyState: false, action: 'copyText' });
      if (result.ok) notify(`已复制 ${lines.length} 行${LOG_SOURCE_LABEL[ui.logTab]}日志。`);
    });
    for (const id of ['open-log-folder', 'open-log-folder-2']) {
      $(id).addEventListener('click', () => openFolder('log'));
    }
    $('open-data-folder').addEventListener('click', () => openFolder('data'));
    $('open-run-folder').addEventListener('click', () => openFolder('run'));
    $('open-bin-folder').addEventListener('click', () => openFolder('bin'));
  }

  async function openFolder(kind) {
    if (!has('openFolder')) {
      notify('宿主未连接，无法打开目录。', { error: true });
      return;
    }
    const result = await callBridge('openFolder', [kind], { applyState: false, action: 'openFolder', silent: true, fallback: '无法打开目录。' });
    if (!result.ok) notify(result.message, { error: true });
  }

  // ---------- ticker ----------
  function startClock() {
    setInterval(() => {
      if (!bridge) return;
      updateCountdown();
      renderFrpcFact();
    }, 1000);
  }

  // ---------- boot ----------
  async function initialize() {
    ui.proxiesCollapsed = readCollapsedState();
    bindEvents();
    APP_VERSION_LABEL();
    if (!bridge) {
      scheduleRender();
      return;
    }
    ui.host = true;
    if (has('onState')) {
      try { bridge.onState((next) => { if (isState(next)) applyState(next); }); } catch (_) { /* ignore */ }
    }
    if (has('onLog')) {
      try { bridge.onLog((entries) => queueLogs(entries)); } catch (_) { /* ignore */ }
    }
    try {
      const initial = await bridge.bootstrap();
      if (isState(initial)) applyState(initial);
      else throw { message: '宿主返回的数据不可用，请重新打开插件。' };
    } catch (error) {
      ui.hostError = msgOf(error, '宿主连接失败，请重新打开插件。');
      notify(ui.hostError, { error: true });
      scheduleRender();
    }
    if (has('getLogs')) {
      try {
        const logs = await bridge.getLogs();
        if (Array.isArray(logs)) queueLogs(logs);
      } catch (_) { /* logs are optional on boot */ }
    }
    ui.booted = true;
    scheduleRender();
    startClock();
  }

  initialize();
})();
