'use strict';
const { ipcRenderer, clipboard } = require('electron');
const path = require('node:path');
const args = name => decodeURIComponent((process.argv.find(x => x.startsWith(name)) || '').slice(name.length));
const preload = args('--toolbox-plugin=');
const browser = args('--toolbox-browser=');
let exitHandler;
let exitCancelledHandler;
ipcRenderer.on('host-plugin-exit-cancelled', () => { try { if (exitCancelledHandler) exitCancelledHandler(); } catch (error) { console.error('恢复插件失败:', error); } });
ipcRenderer.on('host-plugin-exit', async (_event, id) => {
  try { if (exitHandler) await exitHandler(); ipcRenderer.send('host-plugin-exit-result', id, ''); }
  catch (error) { ipcRenderer.send('host-plugin-exit-result', id, String(error && error.message || error)); }
});
window.utools = {
  getPath: name => ipcRenderer.sendSync('host-path', name),
  showOpenDialog: options => ipcRenderer.invoke('host-dialog', options),
  shellOpenPath: file => ipcRenderer.invoke('host-open', file),
  shellShowItemInFolder: file => ipcRenderer.invoke('host-show', file),
  copyText: text => clipboard.writeText(text),
  setExpandHeight: () => {}, setExpendHeight: () => {},
  setPluginBusy: value => ipcRenderer.sendSync('host-plugin-busy', !!value),
  onPluginEnter: callback => window.addEventListener('DOMContentLoaded', () => callback({ code: args('--toolbox-code='), type: 'over' }), { once: true }),
  onPluginExit: callback => { if (typeof callback !== 'function') throw new TypeError('退出回调必须是函数'); exitHandler = callback; ipcRenderer.send('host-plugin-exit-ready'); },
  onPluginExitCancelled: callback => { if (typeof callback !== 'function') throw new TypeError('退出取消回调必须是函数'); exitCancelledHandler = callback; }
};
try {
  if (!preload) return;
  const modulePath = path.join(path.dirname(preload), 'core', 'transient.cjs');
  if (require('node:fs').existsSync(modulePath)) {
    const transient = require(modulePath); const original = transient.createTransientResolver;
    transient.createTransientResolver = options => original({ ...options, engineFinder: () => browser });
  }
  require(preload);
} catch (error) { console.error('插件加载失败', error); }
