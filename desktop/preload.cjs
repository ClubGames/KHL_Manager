// The only bridge between the game page and Windows: app info, saving files through the system dialog, the mods folder.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('khlDesktop', {
  platform: 'windows',
  info: () => ipcRenderer.invoke('khl:info'),
  saveFile: ({ name, data, kind }) => ipcRenderer.invoke('khl:save-file', { name, data, kind }),
  // The «mods» folder next to the game (KHL-GM.exe) in Explorer; resolves to its path or null.
  openModsFolder: () => ipcRenderer.invoke('khl:open-mods'),
  // «Установить мод»: unpack a .zip into the mods folder. `file` = { name, data: Uint8Array } of a dropped archive,
  // or nothing for the system «Open» dialog. Resolves to { installed: [{ id, name, replaced }], errors, dir } or null.
  installMod: (file) => ipcRenderer.invoke('khl:install-mod', file && file.data ? { name: String(file.name || 'mod.zip'), data: file.data } : undefined),
});
