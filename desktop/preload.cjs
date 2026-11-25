// The only bridge between the game page and Windows: app info, saving files through the system dialog, the mods folder.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('khlDesktop', {
  platform: 'windows',
  info: () => ipcRenderer.invoke('khl:info'),
  saveFile: ({ name, data, kind }) => ipcRenderer.invoke('khl:save-file', { name, data, kind }),
  // Documents\Hockey Simulator Manager\mods in Explorer (created on first use); resolves to its path or null.
  openModsFolder: () => ipcRenderer.invoke('khl:open-mods'),
});
