'use strict';

// 轻匣插件唯一预加载入口：只向渲染进程暴露白名单方法，严格隔离数据目录并注册生命周期清理。
(() => {
  const path = require('node:path');
  const os = require('node:os');
  const host = typeof utools !== 'undefined' ? utools : (typeof window !== 'undefined' ? window.utools : undefined);

  function resolvePluginDataDir() {
    const candidates = ['pluginData', 'userData'];
    for (const key of candidates) {
      try {
        const value = host && typeof host.getPath === 'function' ? host.getPath(key) : '';
        if (typeof value === 'string' && path.isAbsolute(value)) {
          return path.join(value, 'com.qingxia.tailscale');
        }
      } catch (_) {
        /* 尝试下一个回退路径 */
      }
    }
    return path.join(os.homedir(), '.qingxia', 'com.qingxia.tailscale');
  }

  let service = null;
  let initError = null;

  try {
    const { nodeFetch } = require('./core/node-fetch.cjs');
    const winPs = require('./core/win-ps.cjs');
    const { createStore } = require('./core/config.cjs');
    const binary = require('./core/binary.cjs');
    const { createDaemonManager } = require('./core/daemon.cjs');
    const { createService } = require('./core/service.cjs');

    const dataDir = resolvePluginDataDir();
    const store = createStore({
      dataDir,
      protectSecret: winPs.protectSecret,
      unprotectSecret: winPs.unprotectSecret,
    });
    const daemon = createDaemonManager({ dataDir, ps: winPs });
    service = createService({
      dataDir,
      host,
      platform: process.platform,
      arch: process.arch,
      fetchImpl: nodeFetch,
      store,
      binary,
      daemon,
      ps: winPs,
    });
  } catch (error) {
    initError = error instanceof Error ? error : new Error(String(error));
  }

  function requireService() {
    if (service) return service;
    const detail = initError && initError.message ? String(initError.message).slice(0, 300) : '请检查数据目录权限';
    throw new Error(`插件初始化失败：${detail}`);
  }

  const METHODS = [
    'bootstrap',
    'getState',
    'startTunnel',
    'stopTunnel',
    'logout',
    'refreshStatus',
    'pingPeer',
    'saveConfig',
    'clearSavedAuthKey',
    'checkLatestRelease',
    'downloadKernel',
    'pickLocalKernelDir',
    'openAuthUrl',
    'copyText',
    'openDataDir',
    'getLogs',
    'clearLogs',
    'setWindowVisible',
  ];

  const bridge = {
    onState(cb) {
      return service && typeof cb === 'function' ? service.onState(cb) : () => {};
    },
    onLog(cb) {
      return service && typeof cb === 'function' ? service.onLog(cb) : () => {};
    },
  };

  for (const name of METHODS) {
    bridge[name] = (...args) => requireService()[name](...args);
  }

  window.tailscalePlugin = Object.freeze(bridge);

  if (host && typeof host.onPluginEnter === 'function') {
    host.onPluginEnter(() => {
      try {
        if (host.setExpandHeight) host.setExpandHeight(720);
      } catch (_) {
        /* 忽略 */
      }
    });
  }

  if (host && typeof host.onPluginExit === 'function') {
    host.onPluginExit(() => (service ? service.shutdown() : undefined));
  }

  if (host && typeof host.onPluginExitCancelled === 'function') {
    host.onPluginExitCancelled(() => {
      if (service) service.resumeAfterCancelledExit();
    });
  }

  window.addEventListener('beforeunload', () => {
    try {
      if (service && typeof service.dispose === 'function') service.dispose();
    } catch (_) {
      /* 忽略 */
    }
  }, { once: true });
})();
