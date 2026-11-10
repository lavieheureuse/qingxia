'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('toolbox', { call: async (action, value) => { const result = await ipcRenderer.invoke('toolbox', action, value); if (!result.ok) throw new Error(result.message); return result.value; }, onUpdate: fn => ipcRenderer.on('updated', (_event, state) => fn(state)), onNavigate: fn => ipcRenderer.on('navigate', (_event, page) => fn(page)), onNotice: fn => ipcRenderer.on('notice', (_event, message) => fn(message)) });
