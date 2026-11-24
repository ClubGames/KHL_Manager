// The only bridge between the game page and Windows: app info and saving files through the system dialog.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('khlDesktop', {
  platform: 'windows',
  info: () => ipcRenderer.invoke('khl:info'),
  saveFile: ({ name, data, kind }) => ipcRenderer.invoke('khl:save-file', { name, data, kind }),
});
