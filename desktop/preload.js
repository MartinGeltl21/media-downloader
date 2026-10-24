const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  chooseFolder: (kind) => ipcRenderer.invoke('settings:choose-folder', kind),
  showItem: (filePath) => ipcRenderer.invoke('shell:show-item', filePath),
  readClipboardUrl: () => ipcRenderer.invoke('clipboard:read-url'),
  onPreset: (callback) => ipcRenderer.on('preset', (_event, preset) => callback(preset)),
});
