// Mods installed from a .zip in the browser and in the Android app. There is no mods folder to write to there, so
// the unpacked files go into IndexedDB, and a small service worker (public/mod-sw.js) answers requests for
// ./mods/<id>/… from it — the roster, the calendar, logos and photos then load from the same paths as the mods
// shipped with the game, in a new career as well as in a saved one after a restart.
// The database layout is shared with public/mod-sw.js: keep both in step.
//
// The Android app does without the service worker: a worker left registered in its WebView could keep the page from
// loading at all after the app was closed or updated (a plain coloured screen). There the files are also written into
// the app's own storage (files/mods/<id>/…) and MainActivity answers ./mods/<id>/… from there; the app deletes any
// worker registration before its WebView starts.
import { Capacitor } from '@capacitor/core';
import { modsInZip, readZip } from './zip';

export const MOD_DB = 'khl-mods';
const DB_VERSION = 1;
/** service worker script, next to index.html */
export const MOD_SW = './mod-sw.js';
const FLAG_KEY = 'khl.storedMods';

export interface StoredMod { id: string; name: string; installed: number; files: number; bytes: number }
export interface StoreResult { installed: { id: string; name: string; replaced: boolean }[]; errors: string[] }

const TYPES: Record<string, string> = { json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8' };
export const fileType = (rel: string) => TYPES[rel.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** The Android app: stored mods live on disk, no service worker. */
export function androidApp(): boolean {
  try { return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'; } catch { return false; }
}
const DISK_KEY = 'khl.modsOnDisk';
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
async function fs() { return import('@capacitor/filesystem'); }
/** Writes one stored mod's files to the app's storage (Android), replacing what was there. */
async function writeModToDisk(id: string, files: { rel: string; blob: Blob }[]): Promise<void> {
  const { Filesystem, Directory } = await fs();
  try { await Filesystem.rmdir({ path: `mods/${id}`, directory: Directory.Data, recursive: true }); } catch { /* not there yet */ }
  for (const f of files) await Filesystem.writeFile({ path: `mods/${id}/${f.rel}`, data: await blobToBase64(f.blob), directory: Directory.Data, recursive: true });
}
let diskReady: Promise<boolean> | null = null;
/**
 * Android: the stored mods are on disk (once: mods installed by an older version of the app were only in IndexedDB,
 * they are copied over). Resolves false when that failed (the mods' files will not load).
 */
export function modsOnDisk(): Promise<boolean> {
  if (diskReady) return diskReady;
  diskReady = (async () => {
    try { if (localStorage.getItem(DISK_KEY) === '1' || !hasStoredMods()) return true; } catch { return true; }
    try {
      const db = await openModDb();
      const mods = await reqP(db.transaction('mods').objectStore('mods').getAll() as IDBRequest<StoredMod[]>);
      for (const m of mods) {
        const keys = await reqP(db.transaction('files').objectStore('files').getAllKeys(prefix(m.id)));
        const files: { rel: string; blob: Blob }[] = [];
        for (const k of keys) { const b = await storedFile(m.id, String(k).slice(m.id.length + 1)); if (b) files.push({ rel: String(k).slice(m.id.length + 1), blob: b }); }
        await writeModToDisk(m.id, files);
      }
      try { localStorage.setItem(DISK_KEY, '1'); } catch { /* private mode */ }
      return true;
    } catch (e) {
      console.warn('stored mods to disk:', e);
      diskReady = null;
      return false;
    }
  })();
  return diskReady;
}

let dbp: Promise<IDBDatabase> | null = null;
export function openModDb(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Хранилище браузера недоступно (IndexedDB).')); return; }
    const req = indexedDB.open(MOD_DB, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('mods')) db.createObjectStore('mods', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
    };
    req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); dbp = null; }; resolve(db); };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB'));
    req.onblocked = () => reject(new Error('Хранилище модов занято другой вкладкой игры — закройте её и повторите.'));
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}

const done = (tx: IDBTransaction) => new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error ?? new Error('IndexedDB')); tx.onabort = () => rej(tx.error ?? new Error('Запись прервана (не хватает места?)')); });
const reqP = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const prefix = (id: string) => IDBKeyRange.bound(`${id}/`, `${id}/\uffff`);

/** Mods installed into this browser / app. */
export async function storedMods(): Promise<StoredMod[]> {
  if (!hasStoredMods()) return [];
  try {
    const db = await openModDb();
    const list = await reqP(db.transaction('mods').objectStore('mods').getAll() as IDBRequest<StoredMod[]>);
    return list.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  } catch {
    return [];
  }
}

/** One file of a stored mod (what the service worker serves; also read directly when it is not running). */
export async function storedFile(id: string, rel: string): Promise<Blob | null> {
  const db = await openModDb();
  const r = await reqP(db.transaction('files').objectStore('files').get(`${id}/${rel}`) as IDBRequest<{ blob: Blob } | undefined>);
  return r?.blob ?? null;
}

/** The game has stored mods (a cheap check at start-up: no IndexedDB opened for players who never installed one). */
export function hasStoredMods(): boolean {
  try { return localStorage.getItem(FLAG_KEY) === '1'; } catch { return true; }
}
function setFlag(on: boolean) { try { if (on) localStorage.setItem(FLAG_KEY, '1'); else localStorage.removeItem(FLAG_KEY); } catch { /* private mode */ } }

/** Unpacks a mod archive into IndexedDB (a mod already stored under the same name is replaced). */
export async function storeModZip(data: Uint8Array, archiveName: string): Promise<StoreResult> {
  const packs = modsInZip(readZip(data), archiveName);
  const db = await openModDb();
  const result: StoreResult = { installed: [], errors: [] };
  for (const pack of packs) {
    // inflate everything first: an IndexedDB transaction closes as soon as it waits on anything else
    const files: { rel: string; blob: Blob; size: number }[] = [];
    for (const f of pack.files) {
      const bytes = await f.entry.read();
      files.push({ rel: f.rel, blob: new Blob([bytes as BlobPart], { type: fileType(f.rel) }), size: bytes.length });
    }
    let name = pack.id;
    const meta = files.find((f) => f.rel.toLowerCase() === 'mod.json');
    if (meta) {
      try {
        const m = JSON.parse((await meta.blob.text()).replace(/^\ufeff/, ''));
        if (m && typeof m.name === 'string' && m.name.trim()) name = m.name.trim();
      } catch { /* broken mod.json: the folder name */ }
    }
    const tx = db.transaction(['mods', 'files'], 'readwrite'), fin = done(tx);
    const mods = tx.objectStore('mods'), store = tx.objectStore('files');
    const old = reqP(mods.get(pack.id));
    store.delete(prefix(pack.id));
    for (const f of files) store.put({ blob: f.blob, type: fileType(f.rel) }, `${pack.id}/${f.rel}`);
    mods.put({ id: pack.id, name, installed: Date.now(), files: files.length, bytes: files.reduce((s, f) => s + f.size, 0) } satisfies StoredMod);
    const replaced = !!(await old);
    await fin;
    if (androidApp()) {
      try { await writeModToDisk(pack.id, files); }
      catch (e) { result.errors.push(`${name}: не удалось записать файлы мода в память приложения (${String((e as Error)?.message ?? e)})`); continue; }
    }
    result.installed.push({ id: pack.id, name, replaced });
  }
  if (result.installed.length) setFlag(true);
  return result;
}

/** Deletes a stored mod (careers started from it keep their saved state, but its logos and photos are gone). */
export async function removeStoredMod(id: string): Promise<void> {
  const db = await openModDb();
  const tx = db.transaction(['mods', 'files'], 'readwrite'), fin = done(tx);
  tx.objectStore('files').delete(prefix(id));
  tx.objectStore('mods').delete(id);
  await fin;
  if (androidApp()) { try { const { Filesystem, Directory } = await fs(); await Filesystem.rmdir({ path: `mods/${id}`, directory: Directory.Data, recursive: true }); } catch { /* not on disk */ } }
  const left = await reqP(db.transaction('mods').objectStore('mods').count());
  if (!left) setFlag(false);
}

/** Stored mods can be installed here: a page served over http(s) with service workers, IndexedDB and inflate. */
export function canStoreMods(): boolean {
  return typeof window !== 'undefined' && typeof navigator !== 'undefined' && (androidApp() || 'serviceWorker' in navigator) && typeof indexedDB !== 'undefined'
    && typeof DecompressionStream !== 'undefined' && /^https?:$/.test(location.protocol) && (window.isSecureContext ?? true);
}

/**
 * Starts the service worker that serves stored mods and waits until it controls the page (the first time it
 * takes over the open page itself). false: not available — stored mods cannot be loaded then.
 */
export async function ensureModWorker(timeoutMs = 5000): Promise<boolean> {
  if (!canStoreMods()) return false;
  // the Android app serves them itself (MainActivity), from disk
  if (androidApp()) return modsOnDisk();
  try {
    const sw = navigator.serviceWorker;
    await sw.register(MOD_SW, { scope: './' });
    if (sw.controller) return true;
    await new Promise<void>((res) => {
      const t = setTimeout(res, timeoutMs);
      sw.addEventListener('controllerchange', () => { clearTimeout(t); res(); }, { once: true });
    });
    return !!sw.controller;
  } catch {
    return false;
  }
}

/** At start-up: a player with stored mods gets the worker running before a saved career needs its files. */
export function initModWorker(): void {
  if (androidApp()) {
    // no worker in the app (an old registration is dropped; MainActivity deletes them before the WebView starts too)
    void navigator.serviceWorker?.getRegistrations?.().then((rs) => rs.forEach((r) => void r.unregister())).catch(() => {});
    if (hasStoredMods()) void modsOnDisk();
    return;
  }
  if (hasStoredMods() && canStoreMods()) void ensureModWorker();
}
