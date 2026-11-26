import { useEffect, useState } from 'react';
import type { GameEvent } from '../types';
import type { ReplayClip } from './rinkPlayback';

/**
 * Goal replays of the matches the manager played (or watched) himself: the motion the rink actually produced,
 * cut while the frames were there. They are kept per game so the match card shows the very goals that were
 * scored, not a reconstruction from the box score. A separate small IndexedDB database (the clips are big
 * compared to the rest of a save and are not part of it): the last MAX_GAMES games are kept, older ones dropped.
 * Without IndexedDB they live in memory for the session.
 */
const DB_NAME = 'khl-gm-clips';
const STORE = 'clips';
const MAX_GAMES = 60;
const INDEX_KEY = 'khl-gm:clips:index';

export type GameClips = Record<string, ReplayClip>;
/** The identity of a goal inside its game (the same in the live books and in the stored result). */
export const goalClipKey = (e: Pick<GameEvent, 'period' | 'sec' | 'player'>) => `${e.period}:${e.sec}:${e.player ?? ''}`;
/** The identity of a game across careers and seasons. */
export const gameClipsKey = (saveId: string, season: number, gameId: number) => `${saveId}:${season}:${gameId}`;

const mem = new Map<string, GameClips>();
const listeners = new Set<() => void>();
let dbp: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    let done = false;
    const end = (d: IDBDatabase | null) => { if (!done) { done = true; resolve(d); } };
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) return end(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
      req.onsuccess = () => end(req.result);
      req.onerror = () => end(null);
      req.onblocked = () => end(null);
      setTimeout(() => end(null), 3000);
    } catch { end(null); }
  });
  return dbp;
}

function readIndex(): string[] {
  try { const a = JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]'); return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}
function writeIndex(keys: string[]) { try { localStorage.setItem(INDEX_KEY, JSON.stringify(keys)); } catch { /* no localStorage: no pruning list */ } }

/** Keeps the clips of a game (merged with what is stored already). */
export async function saveGameClips(key: string, clips: GameClips): Promise<void> {
  if (!Object.keys(clips).length) return;
  const all = { ...(mem.get(key) ?? {}), ...clips };
  mem.set(key, all);
  listeners.forEach((f) => f());
  const d = await db();
  if (!d) return;
  const idx = readIndex().filter((k) => k !== key);
  idx.push(key);
  const drop = idx.length > MAX_GAMES ? idx.splice(0, idx.length - MAX_GAMES) : [];
  writeIndex(idx);
  await new Promise<void>((resolve) => {
    try {
      const t = d.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put(all, key);
      for (const k of drop) { t.objectStore(STORE).delete(k); mem.delete(k); }
      t.oncomplete = () => resolve(); t.onerror = () => resolve(); t.onabort = () => resolve();
    } catch { resolve(); }
  });
}

/** The stored clips of a game (null: none). */
export async function loadGameClips(key: string): Promise<GameClips | null> {
  const m = mem.get(key);
  if (m) return m;
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => { const v = req.result as GameClips | undefined; if (v) mem.set(key, v); resolve(v ?? null); };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

/** The stored clips of a game for a component (null while loading or when there are none). */
export function useGameClips(key: string | null): GameClips | null {
  const [clips, setClips] = useState<GameClips | null>(() => (key ? mem.get(key) ?? null : null));
  useEffect(() => {
    if (!key) { setClips(null); return; }
    let alive = true;
    const read = () => { void loadGameClips(key).then((c) => { if (alive) setClips(c); }); };
    read();
    listeners.add(read);
    return () => { alive = false; listeners.delete(read); };
  }, [key]);
  return clips;
}
