'use strict';

// This is the only uTools/Node entry. Remote pages never run inside our renderer.
(() => {
  const path = require('node:path');
  const os = require('node:os');
  const { createStore } = require('./core/storage.cjs');
  const { createDownloader } = require('./core/download.cjs');
  const parser = require('./core/parse.cjs');
  const { createTransientResolver } = require('./core/transient.cjs');
  const { createService } = require('./core/service.cjs');
  const host = typeof utools !== 'undefined' ? utools : window.utools;
  let clipboard;
  try { clipboard = require('electron').clipboard; } catch (_) { /* Clipboard is optional. */ }
  function hostPath(name, fallback) {
    try { const value = host && host.getPath(name); return typeof value === 'string' && path.isAbsolute(value) ? value : fallback; }
    catch (_) { return fallback; }
  }
  try {
    const dataDirectory = path.join(hostPath('userData', path.join(os.homedir(), '.config')), 'shiying-douyin-plugin');
    const store = createStore(dataDirectory);
    let browserInstance = createTransientResolver({ dataDirectory, parser });
    const browser = Object.freeze({ available: (...args) => browserInstance.available(...args), resolve: (...args) => browserInstance.resolve(...args), profileVideos: (...args) => browserInstance.profileVideos(...args), openLogin: (...args) => browserInstance.openLogin(...args), setTarget: (...args) => browserInstance.setTarget(...args), dispose: (...args) => browserInstance.dispose(...args) });
    const service = createService({ host, clipboard, store, parser, browser, downloader: createDownloader(),
      defaultDirectory: path.join(hostPath('downloads', path.join(os.homedir(), 'Downloads')), '拾影'), version: '0.2.0' });
    // Neither transport injection nor arbitrary file/network access crosses this bridge.
    window.douyin = service;
    let pendingInput = null;
    function deliver(text) {
      if (!text || typeof text !== 'string') return;
      try { parser.parseShareInput(text); } catch (_) { return; }
      if (document.readyState === 'loading') { pendingInput = text; return; }
      window.dispatchEvent(new CustomEvent('douyin:input', { detail: text.slice(0, 20000) }));
    }
    document.addEventListener('DOMContentLoaded', () => { if (pendingInput) { deliver(pendingInput); pendingInput = null; } }, { once: true });
    if (host && typeof host.onPluginEnter === 'function') {
      host.onPluginEnter(action => {
        if (typeof host.setExpandHeight === 'function') host.setExpandHeight(600);
        else if (typeof host.setExpendHeight === 'function') host.setExpendHeight(600); // Legacy hosts.
        if (action && typeof action.payload === 'string') deliver(action.payload);
      });
    }
    if (host && typeof host.onPluginExit === 'function') {
      host.onPluginExit(async () => {
        const stopped = browser.dispose();
        await service.cancel();
        if (!stopped) throw new Error('浏览器未能完全停止，请稍后重试。');
      });
    }
    if (host && typeof host.onPluginExitCancelled === 'function') {
      host.onPluginExitCancelled(() => { browserInstance = createTransientResolver({ dataDirectory, parser }); });
    }
    // Do not cancel onPluginOut: users may temporarily hide uTools while downloading.
    window.addEventListener('beforeunload', () => { browser.dispose(); void service.cancel(); }, { once: true });
  } catch (error) {
    const message = `插件初始化失败：${error && error.message ? String(error.message).slice(0, 400) : '请检查本地数据目录权限。'}`;
    window.douyin = Object.freeze({ bootstrap: async () => { throw Object.assign(new Error(message), { code: 'INITIALIZATION_FAILED' }); }, onState: () => () => {} });
  }
})();
