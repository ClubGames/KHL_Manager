// Save-slot storage. Primary backend is IndexedDB (no practical size limit); if it is unavailable the
// module falls back to localStorage. Saves found in localStorage are moved to IndexedDB when possible,
// so the list is always complete regardless of which backend wrote them.

export interface SaveMeta {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  teamShort: string;
  city: string;
  primaryColor: string;
  secondaryColor: string;
  league: string;
  season: string;
  seasonNumber: number;
  phase: 'season' | 'playoffs' | 'offseason';
  day: number;
  totalDays: number;
  gp: number;
  gamesPerTeam: number;
  wins: number;
  losses: number;
  points: number;
  place: number;
  conference: string;
  trophies: number;
  createdAt: number;
  updatedAt: number;
}

export type Backend = 'indexeddb' | 'localStorage' | 'none';

const DB_NAME = 'khl-gm';
const DB_VERSION = 1;
const LS_INDEX = 'khl-gm:index';
const LS_PREFIX = 'khl-gm:save:';
const LEGACY_KEY = 'khl-gm-save-v1';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    let settled = false;
    const done = (db: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      resolve(db);
    };
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) return done(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('states')) db.createObjectStore('states');
      };
      req.onsuccess = () => done(req.result);
      req.onerror = () => done(null);
      req.onblocked = () => done(null);
      setTimeout(() => done(null), 3000);
    } catch {
      done(null);
    }
  });
  return dbPromise;
}

function run<T = undefined>(db: IDBDatabase, mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(['meta', 'states'], mode);
    let result: T | undefined;
    t.oncomplete = () => resolve(result as T);
    t.onerror = () => reject(t.error ?? new Error('Ошибка IndexedDB'));
    t.onabort = () => reject(t.error ?? new Error('Запись в IndexedDB прервана'));
    const req = fn(t);
    if (req)
      req.onsuccess = () => {
        result = req.result;
      };
  });
}

function ls(): Storage | null {
  try {
    const s = window.localStorage;
    const k = 'khl-gm:probe';
    s.setItem(k, '1');
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}

function lsIndex(s: Storage): SaveMeta[] {
  try {
    const raw = s.getItem(LS_INDEX);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? (arr as SaveMeta[]) : [];
  } catch {
    return [];
  }
}

const isQuota = (e: unknown) => {
  const n = (e as { name?: string } | null)?.name ?? '';
  return n === 'QuotaExceededError' || n === 'NS_ERROR_DOM_QUOTA_REACHED';
};

export function storageError(e: unknown): string {
  if (isQuota(e)) return 'В хранилище браузера закончилось место — удалите лишние сохранения';
  const m = (e as { message?: string } | null)?.message;
  return m ? String(m) : 'Не удалось обратиться к хранилищу браузера';
}

export async function getBackend(): Promise<Backend> {
  if (await openDb()) return 'indexeddb';
  return ls() ? 'localStorage' : 'none';
}

export async function writeSave(meta: SaveMeta, state: unknown): Promise<void> {
  const db = await openDb();
  if (db) {
    await run(db, 'readwrite', (t) => {
      t.objectStore('states').put(state, meta.id);
      t.objectStore('meta').put(meta);
    });
    return;
  }
  const s = ls();
  if (!s) throw new Error('Хранилище браузера недоступно — сохранения отключены (режим инкогнито или запрет в настройках)');
  s.setItem(LS_PREFIX + meta.id, JSON.stringify(state));
  const idx = lsIndex(s).filter((m) => m.id !== meta.id);
  idx.push(meta);
  s.setItem(LS_INDEX, JSON.stringify(idx));
}

export async function writeMeta(meta: SaveMeta): Promise<void> {
  const db = await openDb();
  if (db) {
    await run(db, 'readwrite', (t) => {
      t.objectStore('meta').put(meta);
    });
    return;
  }
  const s = ls();
  if (!s) throw new Error('Хранилище браузера недоступно');
  s.setItem(LS_INDEX, JSON.stringify(lsIndex(s).map((m) => (m.id === meta.id ? meta : m))));
}

export async function readSave(id: string): Promise<unknown | null> {
  const db = await openDb();
  if (db) {
    const v = await run<unknown>(db, 'readonly', (t) => t.objectStore('states').get(id));
    if (v != null) return v;
  }
  const s = ls();
  if (!s) return null;
  const raw = s.getItem(LS_PREFIX + id);
  return raw ? JSON.parse(raw) : null;
}

export async function deleteSave(id: string): Promise<void> {
  const db = await openDb();
  if (db) {
    await run(db, 'readwrite', (t) => {
      t.objectStore('states').delete(id);
      t.objectStore('meta').delete(id);
    });
  }
  const s = ls();
  if (s) {
    s.removeItem(LS_PREFIX + id);
    const idx = lsIndex(s);
    if (idx.some((m) => m.id === id)) s.setItem(LS_INDEX, JSON.stringify(idx.filter((m) => m.id !== id)));
  }
}

/** All saves, newest first. Saves left in localStorage are moved into IndexedDB when it is available. */
export async function listMetas(): Promise<SaveMeta[]> {
  const db = await openDb();
  const s = ls();
  let metas: SaveMeta[] = [];
  if (db) {
    if (s) {
      const pending = lsIndex(s);
      const failed: SaveMeta[] = [];
      for (const m of pending) {
        try {
          const raw = s.getItem(LS_PREFIX + m.id);
          if (raw) {
            const state = JSON.parse(raw);
            await run(db, 'readwrite', (t) => {
              t.objectStore('states').put(state, m.id);
              t.objectStore('meta').put(m);
            });
          }
          s.removeItem(LS_PREFIX + m.id);
        } catch {
          failed.push(m);
        }
      }
      if (pending.length) {
        if (failed.length) s.setItem(LS_INDEX, JSON.stringify(failed));
        else s.removeItem(LS_INDEX);
      }
      metas = failed;
    }
    const stored = await run<SaveMeta[]>(db, 'readonly', (t) => t.objectStore('meta').getAll() as IDBRequest<SaveMeta[]>);
    metas = [...metas.filter((m) => !stored.some((x) => x.id === m.id)), ...stored];
  } else if (s) {
    metas = lsIndex(s);
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Raw single-slot save written by the first version of the game (before save slots existed). */
export function readLegacy(): string | null {
  try {
    return ls()?.getItem(LEGACY_KEY) ?? null;
  } catch {
    return null;
  }
}
export function clearLegacy() {
  try {
    ls()?.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
}
