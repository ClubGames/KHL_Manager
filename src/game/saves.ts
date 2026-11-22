import type { GameState } from '../types';

const INDEX_KEY = 'khl-gm-slots-v2';
const SLOT_PREFIX = 'khl-gm-slot-v2:';
const LEGACY_KEYS = ['khl-gm-save-v1'];
export const SAVE_VERSION = 2;
export const MAX_SLOTS = 8;

export interface SlotMeta {
  id: string;
  name: string;
  savedAt: number;
  version: number;
  teamId: string;
  teamName: string;
  teamShort: string;
  color: string;
  season: string;
  phase: string;
  day: number;
  totalDays: number;
  points: number;
  gp: number;
  wins: number;
  losses: number;
  budget: number;
  trophies: number;
  size: number;
  auto: boolean;
}

const listeners = new Set<() => void>();
export function subscribeSlots(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const notify = () => {
  for (const l of listeners) l();
};

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string) {
  localStorage.setItem(k, v);
}
function safeDel(k: string) {
  try {
    localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/* ---------- packing: gzip when the platform supports it ---------- */
const B64_CHUNK = 0x8000;
function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  return btoa(s);
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function pack(json: string): Promise<string> {
  if (typeof CompressionStream !== 'undefined' && typeof Blob !== 'undefined') {
    try {
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
      const buf = await new Response(stream).arrayBuffer();
      return 'z' + bytesToB64(new Uint8Array(buf));
    } catch {
      /* fall through */
    }
  }
  return 'p' + bytesToB64(new TextEncoder().encode(json));
}

export async function unpack(payload: string): Promise<string> {
  if (payload.startsWith('z') && typeof DecompressionStream !== 'undefined') {
    const bytes = b64ToBytes(payload.slice(1));
    const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  if (payload.startsWith('p')) return new TextDecoder().decode(b64ToBytes(payload.slice(1)));
  return payload;
}

/** Keep saves small: match logs are not needed after a game is committed. */
export function compactState(state: GameState): GameState {
  return {
    ...state,
    news: state.news.slice(0, 60),
    schedule: state.schedule.map((day) =>
      day.map((g) => (g.result ? { ...g, result: { ...g.result, events: [], lines: {} } } : g))
    ),
  };
}

function metaFor(state: GameState, id: string, name: string, size: number, auto: boolean): SlotMeta {
  const t = state.teams[state.userTeamId];
  const r = t?.record;
  return {
    id,
    name,
    savedAt: Date.now(),
    version: SAVE_VERSION,
    teamId: state.userTeamId,
    teamName: t?.name ?? '—',
    teamShort: t?.short ?? '—',
    color: t?.primaryColor ?? '#0A4FA3',
    season: state.league.season,
    phase: state.phase,
    day: state.day,
    totalDays: state.schedule.length,
    points: r?.points ?? 0,
    gp: r?.gp ?? 0,
    wins: r ? r.w + r.otw + r.sow : 0,
    losses: r ? r.l + r.otl + r.sol : 0,
    budget: t?.budget ?? 0,
    trophies: state.trophies.length,
    size,
    auto,
  };
}

let migrated = false;
function migrateLegacy(): void {
  if (migrated) return;
  migrated = true;
  for (const key of LEGACY_KEYS) {
    const raw = safeGet(key);
    if (!raw) continue;
    try {
      const state = JSON.parse(raw) as GameState;
      if (!state || state.version !== SAVE_VERSION || !state.teams) throw new Error('bad');
      const id = `slot-${Date.now().toString(36)}-legacy`;
      const meta = metaFor(state, id, 'Старое сохранение', raw.length, false);
      safeSet(SLOT_PREFIX + id, JSON.stringify({ meta, payload: 'p' + bytesToB64(new TextEncoder().encode(raw)) }));
      writeIndex([meta, ...readIndex()]);
    } catch {
      /* corrupted legacy save */
    }
    safeDel(key);
  }
}

function readIndex(): SlotMeta[] {
  try {
    const raw = safeGet(INDEX_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((x) => x && typeof x.id === 'string' && x.version === SAVE_VERSION) : [];
  } catch {
    return [];
  }
}
function writeIndex(list: SlotMeta[]) {
  try {
    safeSet(INDEX_KEY, JSON.stringify(list.slice(0, MAX_SLOTS)));
  } catch {
    /* ignore */
  }
}

export function listSlots(): SlotMeta[] {
  migrateLegacy();
  return readIndex().sort((a, b) => b.savedAt - a.savedAt);
}

export function slotKey(id: string) {
  return SLOT_PREFIX + id;
}

export function hasSlot(id: string): boolean {
  return readIndex().some((x) => x.id === id);
}

export function readSlotMeta(id: string): SlotMeta | null {
  return readIndex().find((x) => x.id === id) ?? null;
}

/** Autosave re-anchors to a matching slot instead of silently spawning duplicates. */
export function findReusableSlot(state: GameState): string | null {
  const t = state.teams[state.userTeamId];
  const label = `${t?.name ?? ''} · ${state.league.season}`;
  const match = readIndex().find((x) => x.teamId === state.userTeamId && x.season === state.league.season);
  return match ? match.id : readIndex().find((x) => x.name === label)?.id ?? null;
}

export function newSlotId(): string {
  return `slot-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export async function writeSlot(state: GameState, id: string, name?: string, auto = true): Promise<SlotMeta> {
  migrateLegacy();
  const list = readIndex();
  const prev = list.find((x) => x.id === id);
  const label = (name ?? prev?.name ?? `${state.teams[state.userTeamId]?.name ?? 'Карьера'} · ${state.league.season}`).trim().slice(0, 48);
  const payload = await pack(JSON.stringify(compactState(state)));
  try {
    safeSet(slotKey(id), JSON.stringify({ meta: metaFor(state, id, label, payload.length, auto), payload }));
  } catch {
    throw new Error('Хранилище браузера переполнено — удалите часть сохранений или выгрузите их в файл.');
  }
  const meta = metaFor(state, id, label, payload.length, auto);
  const next = [meta, ...list.filter((x) => x.id !== id)].slice(0, MAX_SLOTS);
  for (const dropped of list.filter((x) => !next.some((n) => n.id === x.id))) safeDel(slotKey(dropped.id));
  writeIndex(next);
  notify();
  return meta;
}

export async function readSlot(id: string): Promise<GameState | null> {
  const raw = safeGet(slotKey(id));
  if (!raw) return null;
  try {
    const wrapped = JSON.parse(raw);
    const json = typeof wrapped?.payload === 'string' ? await unpack(wrapped.payload) : JSON.stringify(wrapped?.state ?? wrapped);
    const state = JSON.parse(json) as GameState;
    if (!state || state.version !== SAVE_VERSION || !state.teams) return null;
    return state;
  } catch {
    return null;
  }
}

export function deleteSlot(id: string) {
  safeDel(slotKey(id));
  writeIndex(readIndex().filter((x) => x.id !== id));
  notify();
}

export function renameSlot(id: string, name: string) {
  const list = readIndex();
  const item = list.find((x) => x.id === id);
  if (!item) return;
  item.name = name.slice(0, 48) || item.name;
  writeIndex(list);
  notify();
}

/** Raw (packed) payload of a slot, for downloading as a .json file. */
export function exportSlotRaw(id: string): string | null {
  const raw = safeGet(slotKey(id));
  if (!raw) return null;
  try {
    const wrapped = JSON.parse(raw);
    return typeof wrapped?.payload === 'string' ? wrapped.payload : JSON.stringify(wrapped?.state ?? wrapped);
  } catch {
    return null;
  }
}

export async function stateToExport(state: GameState): Promise<string> {
  return pack(JSON.stringify(compactState(state)));
}

export async function readSavedFile(text: string): Promise<GameState | null> {
  let payload = text.trim();
  if (payload.startsWith('{')) {
    try {
      const wrapped = JSON.parse(payload);
      const st = (wrapped?.state ?? wrapped) as GameState;
      return st && st.version === SAVE_VERSION ? st : null;
    } catch {
      return null;
    }
  }
  try {
    const json = await unpack(payload);
    const wrapped = JSON.parse(json);
    const st = (wrapped?.state ?? wrapped) as GameState;
    return st && st.version === SAVE_VERSION ? st : null;
  } catch {
    return null;
  }
}

export async function importFileAsSlot(file: File, id = newSlotId()): Promise<SlotMeta> {
  const text = await file.text();
  const state = await readSavedFile(text);
  if (!state) throw new Error('Файл не является сохранением этой версии игры');
  return writeSlot(state, id, file.name.replace(/\.json$/i, '').slice(0, 48), false);
}
