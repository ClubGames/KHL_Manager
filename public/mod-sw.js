// Serves mods installed from a .zip in the browser / the Android app (src/game/modStore.ts keeps them in IndexedDB):
// a request for ./mods/<id>/<file> is answered from the stored files; anything else goes to the network untouched.
const DB = 'khl-mods', VERSION = 1;
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('mods')) d.createObjectStore('mods', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
    };
    req.onsuccess = () => { const d = req.result; d.onversionchange = () => { d.close(); dbp = null; }; resolve(d); };
    req.onerror = () => { dbp = null; reject(req.error); };
  });
  return dbp;
}
function stored(key) {
  return db().then((d) => new Promise((resolve) => {
    const r = d.transaction('files').objectStore('files').get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => resolve(null);
  })).catch(() => null);
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const root = new URL('mods/', self.registration.scope);
  const url = new URL(req.url);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) return;
  let key;
  try { key = decodeURIComponent(url.pathname.slice(root.pathname.length)); } catch { return; }
  if (!key || !key.includes('/')) return; // mods/index.json and the like: the game's own files
  e.respondWith(stored(key).then((hit) => hit
    ? new Response(hit.blob, { status: 200, headers: { 'Content-Type': hit.type || 'application/octet-stream', 'Cache-Control': 'no-store' } })
    : fetch(req)));
});
