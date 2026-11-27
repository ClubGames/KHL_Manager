// The only bridge between the game page and Windows: app info, saving files through the system dialog, the mods folder,
// the sockets of the online match.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('khlDesktop', {
  platform: 'windows',
  info: () => ipcRenderer.invoke('khl:info'),
  saveFile: ({ name, data, kind }) => ipcRenderer.invoke('khl:save-file', { name, data, kind }),
  // The «mods» folder next to the game («Hockey Simulator Manager.exe») in Explorer; resolves to its path or null.
  openModsFolder: () => ipcRenderer.invoke('khl:open-mods'),
  // «Установить мод»: unpack a .zip into the mods folder. `file` = { name, data: Uint8Array } of a dropped archive,
  // or nothing for the system «Open» dialog. Resolves to { installed: [{ id, name, replaced }], errors, dir } or null.
  installMod: (file) => ipcRenderer.invoke('khl:install-mod', file && file.data ? { name: String(file.name || 'mod.zip'), data: file.data } : undefined),
  // Online over the local network (desktop/lan.cjs, the page's side is src/net/lan.ts).
  lan: {
    host: (o) => ipcRenderer.invoke('lan:host', o),
    beacon: (o) => ipcRenderer.invoke('lan:beacon', o),
    stopHost: () => ipcRenderer.invoke('lan:stopHost'),
    join: (o) => ipcRenderer.invoke('lan:join', o),
    send: (o) => ipcRenderer.send('lan:send', o),
    close: () => ipcRenderer.invoke('lan:close'),
    scan: (o) => ipcRenderer.invoke('lan:scan', o),
    stopScan: () => ipcRenderer.invoke('lan:stopScan'),
    addresses: () => ipcRenderer.invoke('lan:addresses'),
    on: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('lan:event', h); return () => ipcRenderer.removeListener('lan:event', h); },
  },
});
