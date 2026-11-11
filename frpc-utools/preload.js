'use strict';

// 唯一的 uTools / Node 入口：把 core/service.cjs 装成 window.frpc 交给渲染进程。
// 渲染进程永远拿不到 require、网络或任意文件能力，只能调用这里白名单里的方法。
(() => {
  const path = require('node:path');
  const os = require('node:os');
  const host = typeof utools !== 'undefined' ? utools : (typeof window !== 'undefined' ? window.utools : undefined);

  function hostPath(name, fallback) {
    try {
      const value = host && host.getPath ? host.getPath(name) : undefined;
      return typeof value === 'string' && path.isAbsolute(value) ? value : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function expandHeight(height) {
    try {
      if (host && typeof host.setExpandHeight === 'function') host.setExpandHeight(height);
      else if (host && typeof host.setExpendHeight === 'function') host.setExpendHeight(height); // 旧宿主
    } catch (_) { /* 宿主不支持时忽略 */ }
  }

  // 与 core/service.cjs 约定的方法白名单（SPEC-SYNC 第 6 节）。
  const METHODS = [
    'saveConnection', 'testConnection', 'syncNow', 'setAutoSync', 'setStartOnLaunch',
    'publishProxies',
    'startFrpc', 'stopFrpc', 'restartFrpc',
    'getConfigText', 'verifyConfig',
    'listVersions', 'downloadBinary', 'pickBinary', 'setBinaryPath',
    'openFolder', 'openConfigFile', 'copyText', 'getLogs', 'clearLogs'
  ];

  let service = null;
  let initError = null;
  let appVersion = '0.1.0';
  try {
    const pkg = require('./package.json');
    if (pkg && typeof pkg.version === 'string' && pkg.version) appVersion = pkg.version;
  } catch (_) { /* 没有 package.json 时用默认值 */ }

  try {
    const { createService } = require('./core/service.cjs');
    // 注意：不能用这里的全局 fetch。uTools preload 跑在渲染进程里，全局 fetch 会受
    // 插件页面 CSP（connect-src 'none'）限制，真机上直接 Failed to fetch。
    const { nodeFetch } = require('./core/node-fetch.cjs');
    const dataDir = path.join(hostPath('userData', path.join(os.homedir(), '.config')), 'frpc-utools');
    service = createService({
      dataDir,
      binDir: path.join(__dirname, 'bin'),
      host,
      appVersion,
      platform: process.platform,
      arch: process.arch,
      fetchImpl: nodeFetch
    });
  } catch (error) {
    initError = error instanceof Error ? error : new Error(String(error));
  }

  function requireService() {
    if (service) return service;
    const detail = initError && initError.message ? String(initError.message).slice(0, 300) : '请检查本地数据目录权限。';
    const failure = new Error(`插件初始化失败：${detail}`);
    failure.code = 'INITIALIZATION_FAILED';
    throw failure;
  }

  const bridge = {};

  bridge.bootstrap = async () => {
    const svc = requireService();
    const state = await svc.bootstrap();
    expandHeight(700);
    return state;
  };

  bridge.getState = () => (service ? service.getState() : null);

  bridge.onState = (cb) => {
    if (typeof cb !== 'function' || !service) return () => {};
    return service.onState(cb);
  };

  bridge.onLog = (cb) => {
    if (typeof cb !== 'function' || !service) return () => {};
    return service.onLog(cb);
  };

  for (const name of METHODS) {
    bridge[name] = (...args) => requireService()[name](...args);
  }

  // 宿主没准备好时也给渲染进程一个可用的降级对象，避免白屏。
  window.frpc = Object.freeze(bridge);

  if (host && typeof host.onPluginEnter === 'function') {
    host.onPluginEnter(() => { expandHeight(700); });
  }

  if (host && typeof host.onPluginExit === 'function') {
    host.onPluginExit(() => service ? service.shutdown() : undefined);
  }
  if (host && typeof host.onPluginExitCancelled === 'function') {
    host.onPluginExitCancelled(() => { if (service) service.resumeAfterCancelledExit(); });
  }

  // 兼容没有退出回调的旧宿主；独立进程需在旧宿主中手动停止。
  window.addEventListener('beforeunload', () => {
    try { if (service && typeof service.dispose === 'function') service.dispose(); } catch (_) { /* 忽略 */ }
  }, { once: true });
})();
