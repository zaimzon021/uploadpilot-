'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('uploadpilot', {
  config: () => ipcRenderer.invoke('config'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  openPath: p => ipcRenderer.invoke('open-path', p),
});
