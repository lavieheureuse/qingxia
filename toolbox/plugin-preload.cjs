'use strict';
const { ipcRenderer, clipboard } = require('electron');
const path = require('node:path');
const args = name => decodeURIComponent((process.argv.find(x => x.startsWith(name)) || '').slice(name.length));
const preload = args('--toolbox-plugin=');
const browser = args('--toolbox-browser=');
window.utools = {
  getPath: name => ipcRenderer.sendSync('host-path', name),
  showOpenDialog: options => ipcRenderer.invoke('host-dialog', options),
  shellOpenPath: file => ipcRenderer.invoke('host-open', file),
  shellShowItemInFolder: file => ipcRenderer.invoke('host-show', file),
  copyText: text => clipboard.writeText(text),
  setExpandHeight: () => {}, setExpendHeight: () => {},
  onPluginEnter: callback => window.addEventListener('DOMContentLoaded', () => callback({ code: args('--toolbox-code='), type: 'over' }), { once: true })
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
