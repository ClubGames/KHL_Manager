// Mods: every folder in `mods/` next to index.html is a playable league —
//   mods/<id>/mod.json       name and description (optional)
//   mods/<id>/roster.json    clubs, players, coaches (same format as before)
//   mods/<id>/schedule.json  one shared regular-season calendar for all clubs (optional: generated when absent)
//   mods/<id>/logos/…        club logos, referenced from roster.json `teams[].logo` relative to the folder
// A static site can't list a folder, so the available mods are named in mods/index.json (the build regenerates it
// from the folders it finds).
import type { GameState, ModRef } from '../types';
import { fetchRoster } from './roster';
import type { NormalizedRoster } from './roster';
import { parseScheduleFile } from './schedule';
import { ensureModWorker, storedFile, storedMods } from './modStore';

export const MODS_ROOT = './mods';
export const DEFAULT_MOD_ID = 'KHL_2627';
const LAST_MOD_KEY = 'khl.mod';

export interface ModEntry {
  id: string;
  name: string;
  description?: string;
  author?: string;
  version?: string;
  /** folder of the mod (relative to index.html) */
  base: string;
  /** roster file, relative to the folder */
  roster: string;
  /** calendar file, relative to the folder; null — the game builds the calendar */
  schedule: string | null;
  /** league emblem / cover picture, already resolved against the folder */
  cover?: string;
  /** roster.json lying next to index.html, the way the game was modded before `mods/` existed */
  legacy?: boolean;
  /** installed from a .zip into this browser / the Android app (kept in IndexedDB, served by public/mod-sw.js) */
  stored?: boolean;
}

export const modBase = (id: string) => `${MODS_ROOT}/${encodeURIComponent(id)}`;

/** Ref of careers saved before mods existed: they were started from the roster that now lives in mods/KHL_2627. */
export const DEFAULT_MOD_REF: ModRef = { id: DEFAULT_MOD_ID, name: 'КХЛ 2026/27', base: modBase(DEFAULT_MOD_ID), roster: `${modBase(DEFAULT_MOD_ID)}/roster.json` };

/** The mod of a career (the default mod for careers saved before mods existed). */
export function careerMod(s: Pick<GameState, 'mod'> | null | undefined): ModRef {
  return s?.mod ?? DEFAULT_MOD_REF;
}

/** Path of a mod file: relative paths are inside the mod folder; URLs and absolute paths are kept as they are. */
export function modUrl(base: string, rel: string): string {
  const s = rel.trim();
  if (!s || /^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('/')) return s;
  const clean = s.replace(/^(\.\/)+/, '');
  return base === '.' || base === '' ? `./${clean}` : `${base.replace(/\/+$/, '')}/${clean}`;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const t = (await res.text()).trim();
  // static servers with an SPA fallback answer missing files with index.html
  if (!t.startsWith('{') && !t.startsWith('[')) throw new Error('файл не найден (сервер вернул не JSON)');
  try {
    return JSON.parse(t);
  } catch (e) {
    throw new Error('ошибка разбора JSON: ' + (e as Error).message);
  }
}

function entryFrom(id: string, base: string, m: any): ModEntry {
  const schedule = m?.schedule === null || m?.schedule === false ? null : str(m?.schedule) ?? 'schedule.json';
  const cover = str(m?.cover) ?? str(m?.logo);
  return {
    id,
    base,
    name: str(m?.name) ?? id.replace(/_/g, ' '),
    ...(str(m?.description) ? { description: str(m?.description) } : {}),
    ...(str(m?.author) ? { author: str(m?.author) } : {}),
    ...(m?.version !== undefined && m?.version !== null && String(m.version).trim() ? { version: String(m.version).trim() } : {}),
    roster: str(m?.roster) ?? 'roster.json',
    schedule,
    ...(cover ? { cover: modUrl(base, cover) } : {}),
  };
}

/** Mod folder names listed in mods/index.json: `{ "mods": ["KHL_2627", …] }` (or a bare array; objects with `id` work too). */
export function parseModIndex(json: unknown): string[] {
  const list: unknown = Array.isArray(json) ? json : (json as any)?.mods;
  if (!Array.isArray(list)) return [];
  const ids = list.map((x: any) => (typeof x === 'string' ? x : x?.id)).filter((x: unknown): x is string => typeof x === 'string' && !!x.trim() && !/[\\/]|^\.\.?$/.test(x.trim()));
  return [...new Set(ids.map((x) => x.trim()))];
}

/** Every mod the game can find: the folders named in mods/index.json, plus a legacy roster.json next to index.html. */
export async function listMods(): Promise<ModEntry[]> {
  let ids: string[] = [];
  let indexed = true;
  try {
    ids = parseModIndex(await fetchJson(`${MODS_ROOT}/index.json`));
  } catch {
    // no index file at all (a hand-made folder on a static server): look for a mods/KHL_2627 folder, if it is there
    indexed = false;
    ids = [DEFAULT_MOD_ID];
  }
  // the game ships without a league: an empty list is fine — the start screen offers to install a mod or pick a roster file
  const found = await Promise.all(
    ids.map(async (id): Promise<ModEntry | null> => {
      const base = modBase(id);
      let manifest: unknown = {};
      try {
        manifest = await fetchJson(`${base}/mod.json`);
      } catch {
        /* mod.json is optional — but a guessed folder without one is taken as absent */
        if (!indexed) return null;
      }
      return entryFrom(id, base, manifest);
    })
  );
  const mods = found.filter((m): m is ModEntry => m !== null);
  // mods installed from a .zip on this device (a stored one replaces a shipped mod of the same name)
  for (const sm of await storedMods()) {
    let manifest: unknown = { name: sm.name };
    try {
      const f = await storedFile(sm.id, 'mod.json');
      if (f) manifest = JSON.parse((await f.text()).replace(/^\ufeff/, ''));
    } catch { /* broken mod.json: the stored name */ }
    const e = { ...entryFrom(sm.id, modBase(sm.id), manifest), stored: true };
    const at = mods.findIndex((m) => m.id === sm.id);
    if (at >= 0) mods[at] = e; else mods.push(e);
  }
  try {
    const legacy = await fetchJson('./roster.json');
    if (legacy && typeof legacy === 'object') {
      const lg = (legacy as any).league ?? legacy;
      const label = [str(lg?.name), str(lg?.season)].filter(Boolean).join(' ');
      mods.push({ id: 'roster.json', base: '.', name: label ? `${label} (roster.json)` : 'roster.json рядом с игрой', description: 'Файл roster.json, лежащий рядом с index.html.', roster: 'roster.json', schedule: null, legacy: true });
    }
  } catch {
    /* no legacy roster */
  }
  return mods;
}

/** Relative logo and photo paths of a mod's roster point into the mod folder. */
export function rebaseRosterAssets(r: NormalizedRoster, base: string): void {
  const fix = (v: string | undefined) => (v && !/^data:/i.test(v) ? modUrl(base, v) : v);
  for (const t of r.teams) {
    if (t.logo) t.logo = fix(t.logo);
    for (const c of t.coaches ?? []) if (c.face) c.face = fix(c.face);
  }
  for (const p of Object.values(r.players)) if (p.face) p.face = fix(p.face);
  for (const c of r.freeCoaches ?? []) if (c.face) c.face = fix(c.face);
}

/** Roster of a mod with its assets resolved (what a running career is kept in line with). */
export async function loadModRoster(ref: Pick<ModRef, 'base' | 'roster'>): Promise<NormalizedRoster> {
  if (!ref.roster) throw new Error('у карьеры нет файла ростера');
  const r = await fetchRoster(ref.roster);
  rebaseRosterAssets(r, ref.base);
  return r;
}

/** Everything a new career needs from a mod: roster, assets and the league calendar. */
export async function loadMod(m: ModEntry): Promise<NormalizedRoster> {
  if (m.stored && !(await ensureModWorker())) throw new Error('мод установлен в память браузера, но служебный обработчик (service worker) не запустился — перезагрузите страницу');
  const rosterUrl = modUrl(m.base, m.roster);
  let r: NormalizedRoster;
  try {
    r = await loadModRoster({ base: m.base, roster: rosterUrl });
  } catch (e) {
    throw new Error(`${rosterUrl}: ${(e as Error)?.message ?? e}`);
  }
  if (m.schedule) {
    const url = modUrl(m.base, m.schedule);
    let json: unknown;
    try {
      json = await fetchJson(url);
    } catch {
      json = undefined; // no calendar file: the game builds one
    }
    if (json !== undefined) {
      try {
        const sch = parseScheduleFile(json, r.teams.map((t) => t.id), r.season, 1);
        r.schedule = { days: sch.days, nextId: sch.nextId };
        r.warnings.push(...sch.warnings);
        if (sch.gamesPerTeam !== null && sch.gamesPerTeam !== r.gamesPerTeam) {
          r.warnings.push(`Календарь: ${sch.gamesPerTeam} матчей на клуб (в ростере указано ${r.gamesPerTeam}) — используется календарь`);
          r.gamesPerTeam = sch.gamesPerTeam;
        }
      } catch (e) {
        r.warnings.push(`Календарь ${m.schedule} не подошёл (${(e as Error).message}) — календарь составлен автоматически`);
      }
    }
  }
  r.mod = { id: m.id, name: m.name, base: m.base, roster: rosterUrl };
  return r;
}

export function lastModId(): string | null {
  try {
    return localStorage.getItem(LAST_MOD_KEY);
  } catch {
    return null;
  }
}
export function rememberMod(id: string): void {
  try {
    localStorage.setItem(LAST_MOD_KEY, id);
  } catch {
    /* private mode */
  }
}
