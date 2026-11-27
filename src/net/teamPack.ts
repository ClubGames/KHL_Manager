// Clubs travel with the match: each player picks his club from his own mods, and the club goes to the other device
// whole — players, ratings, lines, colours, the logo as a picture — so a guest without the host's mod (or with an
// older version of it) plays it all the same. Nothing is installed on the other device: the club lives for the match.
import type { Lineup, Player, Team } from '../types';
import type { NormalizedRoster } from '../game/roster';
import type { ModEntry } from '../game/mods';
import { autoLineup } from '../game/ai';
import { emptyRecord, emptyStats } from '../game/defaults';
import { getClubLogoSources } from '../game/clubColors';
import { hash36, type ModInfo, type TeamPack } from './wire';
import type { Side } from '../game/playRink';

export const modInfo = (m: Pick<ModEntry, 'id' | 'name' | 'version'>): ModInfo => ({ id: m.id, name: m.name, ...(m.version ? { version: m.version } : {}) });

/** How two devices' mods compare: the same, only here, only there, the same mod in different versions. */
export interface ModCompare { common: ModInfo[]; mine: ModInfo[]; theirs: ModInfo[]; versions: { mine: ModInfo; theirs: ModInfo }[] }
export function compareMods(mine: ModInfo[], theirs: ModInfo[]): ModCompare {
  const T = new Map(theirs.map(m => [m.id, m]));
  const M = new Map(mine.map(m => [m.id, m]));
  const out: ModCompare = { common: [], mine: [], theirs: [], versions: [] };
  for (const m of mine) {
    const t = T.get(m.id);
    if (!t) out.mine.push(m);
    else if ((t.version ?? '') !== (m.version ?? '')) out.versions.push({ mine: m, theirs: t });
    else out.common.push(m);
  }
  for (const t of theirs) if (!M.has(t.id)) out.theirs.push(t);
  return out;
}

const MAX_LOGO = 400_000;
function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(b); });
}
/** The club's own logo as a picture that needs no file (the built-in KHL logos are in every build: left as they are). */
async function logoData(t: Team): Promise<string | undefined> {
  const src = t.logo?.trim() ? getClubLogoSources(t)[0] : undefined;
  if (!src) return undefined;
  if (/^data:/i.test(src)) return src.length <= MAX_LOGO * 1.4 ? src : undefined;
  if (/^https?:/i.test(src) && typeof location !== 'undefined' && !src.startsWith(location.origin)) return src; // an address on the internet works anywhere online
  try {
    const res = await fetch(src);
    if (!res.ok) return undefined;
    const b = await res.blob();
    if (b.size > MAX_LOGO || !/^image\//.test(b.type || 'image/')) return undefined;
    return await blobToDataUrl(b);
  } catch {
    return undefined;
  }
}

/** A player as the match needs him (no photo: its file is in the mod; no career data). */
function matchPlayer(p: Player): Player {
  return {
    id: p.id, name: p.name, position: p.position, age: p.age, height: p.height, weight: p.weight, number: p.number, country: p.country, hand: p.hand,
    overall: p.overall, potential: p.potential, skills: { ...p.skills }, contract: { salary: 0, years: 1 }, injury: null, morale: 70, teamId: p.teamId, stats: emptyStats(), history: [],
  };
}

/** The club `teamId` of a loaded mod, ready to go to the other device. */
export async function packTeam(r: NormalizedRoster, teamId: string, mod: ModInfo | null): Promise<TeamPack> {
  const t = r.teams.find(x => x.id === teamId);
  if (!t) throw new Error(`клуб ${teamId} не найден`);
  const ids = t.players.filter(id => r.players[id]);
  const P: Record<string, Player> = {};
  for (const id of ids) P[id] = matchPlayer({ ...r.players[id], injury: null, inLtir: false, inVhl: false });
  const lineup = autoLineup(ids, P);
  const players = ids.map(id => P[id]);
  const team = { id: t.id, name: t.name, short: t.short, city: t.city, primaryColor: t.primaryColor, secondaryColor: t.secondaryColor };
  const hash = hash36(JSON.stringify({ team, players: players.map(p => [p.id, p.name, p.overall, p.position, p.skills]), lineup }));
  const logo = await logoData(t);
  return { mod, team: logo ? { ...team, logo } : team, players, lineup, hash };
}

/** Is it a club a match can be played with (a pack from the other device is checked before it is used)? */
export function validPack(p: unknown): p is TeamPack {
  const x = p as TeamPack;
  if (!x || typeof x !== 'object' || !x.team || typeof x.team.id !== 'string' || typeof x.team.short !== 'string' || !Array.isArray(x.players) || !x.lineup || !Array.isArray(x.lineup.F)) return false;
  const skaters = x.players.filter(pl => pl && pl.position !== 'G').length, goalies = x.players.filter(pl => pl && pl.position === 'G').length;
  return skaters >= 5 && goalies >= 1 && x.players.every(pl => pl && typeof pl.id === 'string' && pl.skills && typeof pl.skills === 'object');
}

/**
 * A pack as the club of side `side` in this match: its people get ids of their own (`0~…` / `1~…`), so two clubs
 * from different mods — or the same club on both sides — never mix up.
 */
export function matchTeam(pack: TeamPack, side: Side): { team: Team; players: Record<string, Player>; lineup: Lineup } {
  const pre = `${side}~`;
  const id = (x: string | null | undefined) => (x ? pre + x : null);
  const players: Record<string, Player> = {};
  for (const p of pack.players) players[pre + p.id] = { ...matchPlayer(p), id: pre + p.id, teamId: pre + pack.team.id };
  const L = pack.lineup;
  const lineup: Lineup = {
    F: L.F.map(l => l.map(id)), D: L.D.map(l => l.map(id)), pp1: (L.pp1 ?? []).map(id), pp2: (L.pp2 ?? []).map(id), pk1: (L.pk1 ?? []).map(id), pk2: (L.pk2 ?? []).map(id),
    starterG: id(L.starterG), backupG: id(L.backupG), u20F: id(L.u20F), u20D: id(L.u20D),
  };
  const team: Team = {
    ...pack.team, id: pre + pack.team.id, conference: 'Запад', division: '', budget: 0, players: Object.keys(players), lineup, record: emptyRecord(), seed: null,
  } as Team;
  return { team, players, lineup };
}
