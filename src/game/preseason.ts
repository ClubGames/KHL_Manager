import type { GameState, Lineup, PreseasonGame, PreseasonState } from '../types';
import { GameSim } from './engine';
import { buildSimTeam } from './simTeam';
import { autoLineup, lineupConstraintsFor, prepareLineup, sanitizeLineup } from './ai';
import { recordLineupChemistryGP } from './chemistry';
import { isYouthPlayer } from './training';
import { clamp } from './ratings';
import { seasonStartYear } from './schedule';

/**
 * August preseason tournaments. Names follow the traditional KHL summer tournaments; the field is
 * built around the host and the manager's club. Games do not count anywhere — they are for trying
 * lines, giving youngsters minutes and building chemistry before the season opener.
 */
interface TournamentDef {
  name: string;
  host: string;
  city: string;
}

export const PRESEASON_TOURNAMENTS: TournamentDef[] = [
  { name: 'Мемориал Ромазана', host: 'metallurg-mg', city: 'Магнитогорск' },
  { name: 'Кубок Республики Башкортостан', host: 'salavat', city: 'Уфа' },
  { name: 'Кубок Минска', host: 'dinamo-mn', city: 'Минск' },
  { name: 'Кубок Губернатора Нижегородской области', host: 'torpedo', city: 'Нижний Новгород' },
  { name: 'Турнир памяти Николая Пучкова', host: 'ska', city: 'Санкт-Петербург' },
  { name: 'Кубок Мэра Москвы', host: 'cska', city: 'Москва' },
  { name: 'Sochi Hockey Open', host: 'sochi', city: 'Сочи' },
  { name: 'Кубок Блинова', host: 'avangard', city: 'Омск' },
  { name: 'Кубок Татнефти', host: 'akbars', city: 'Казань' },
  { name: 'Кубок Президента Республики Казахстан', host: 'barys', city: 'Астана' },
];

const MOSCOW = ['cska', 'spartak', 'dinamo-msk'];

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Pick the tournament the club travels to and its four-team field. */
export function createPreseason(state: GameState): PreseasonState | null {
  const U = state.teams[state.userTeamId];
  if (!U) return null;
  const valid = PRESEASON_TOURNAMENTS.filter((t) => state.teams[t.host]);
  let def: TournamentDef | undefined =
    valid.find((t) => t.host === U.id) ?? (MOSCOW.includes(U.id) ? valid.find((t) => t.host === 'cska') : undefined);
  if (!def) {
    const sameConf = valid.filter((t) => state.teams[t.host].conference === U.conference);
    def = shuffle(sameConf.length ? sameConf : valid)[0];
  }
  let name: string, host: string, city: string;
  if (def) ({ name, host, city } = def);
  else {
    host = U.id;
    city = U.city;
    name = `Кубок города ${U.city}`;
  }
  if (host === 'cska' && MOSCOW.includes(U.id)) host = U.id;
  const pool = shuffle(state.teamOrder.filter((id) => id !== U.id && id !== host));
  const near = pool.filter((id) => state.teams[id].conference === state.teams[host].conference);
  const others = [...near, ...pool.filter((id) => !near.includes(id))];
  const teams = [host, ...(host === U.id ? [] : [U.id]), ...others].slice(0, 4);
  const year = seasonStartYear(state.league.season);
  const dates = [`${16} авг ${year}`, `${18} авг ${year}`, `${20} авг ${year}`];
  const [a, b, c, d] = teams;
  const pairs: [string, string][][] = [
    [[a, b], [c, d]],
    [[a, c], [b, d]],
    [[a, d], [b, c]],
  ];
  const games: PreseasonGame[] = [];
  pairs.forEach((round, r) => round.forEach(([h, aw]) => games.push({ home: h, away: aw, date: dates[r] })));
  return { season: state.league.season, name, host, city, teams, games, done: false, tested: [] };
}

export interface PreseasonRow {
  id: string;
  gp: number;
  pts: number;
  gf: number;
  ga: number;
}

/** 3 points for a regulation win, 2 for an OT/SO win, 1 for an OT/SO loss. */
export function preseasonTable(ps: PreseasonState): PreseasonRow[] {
  const rows: Record<string, PreseasonRow> = {};
  for (const id of ps.teams) rows[id] = { id, gp: 0, pts: 0, gf: 0, ga: 0 };
  for (const g of ps.games) {
    if (!g.result) continue;
    const r = g.result;
    const H = rows[g.home], A = rows[g.away];
    H.gp++; A.gp++;
    H.gf += r.home; H.ga += r.away; A.gf += r.away; A.ga += r.home;
    const beyond = !!(r.ot || r.so);
    const hw = r.home > r.away;
    (hw ? H : A).pts += beyond ? 2 : 3;
    if (beyond) (hw ? A : H).pts += 1;
  }
  return Object.values(rows).sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf);
}

export const nextPreseasonRound = (ps: PreseasonState): number => {
  const i = ps.games.findIndex((g) => !g.result);
  return i < 0 ? -1 : Math.floor(i / 2);
};

/** Line-up for a summer game: 'youth' gives the U23 players the minutes of the established veterans. */
export function preseasonLineup(state: GameState, mode: 'main' | 'youth'): Lineup {
  const U = state.teams[state.userTeamId];
  const P = state.players;
  const opts = lineupConstraintsFor(state, U.id);
  const base = sanitizeLineup(U.lineup, U.players, P, opts);
  if (mode === 'main') return base;
  const young = U.players.filter((id) => P[id] && isYouthPlayer(P[id]) && !P[id].injury);
  if (!young.length) return base;
  // Rest the oldest regulars so that every healthy U23 player dresses.
  const vets = U.players
    .map((id) => P[id])
    .filter((p) => p && !isYouthPlayer(p) && p.position !== 'G')
    .sort((a, b) => b.age - a.age)
    .slice(0, Math.min(6, young.length))
    .map((p) => p.id);
  const pool = U.players.filter((id) => !vets.includes(id) && !P[id]?.injury);
  return autoLineup(pool, P, opts);
}

function play(state: GameState, g: PreseasonGame, userLineup: Lineup | null): string[] {
  const U = state.userTeamId;
  const lh = g.home === U && userLineup ? userLineup : prepareLineup(state, g.home);
  const la = g.away === U && userLineup ? userLineup : prepareLineup(state, g.away);
  const sim = new GameSim(buildSimTeam(state, g.home, lh), buildSimTeam(state, g.away, la), state.players, false, null);
  sim.quiet = true;
  const res = sim.runAll();
  g.result = {
    home: res.homeScore,
    away: res.awayScore,
    ot: res.ot || undefined,
    so: res.so || undefined,
    scorers: res.scorers.filter((x) => x.team === U).map((x) => x.scorer),
  };
  return [...res.homeDressed, ...res.awayDressed];
}

export interface PreseasonOutcome {
  text: string;
  finished: boolean;
}

/** Play the next round (the user's game and the other game). */
export function playPreseasonRound(state: GameState, mode: 'main' | 'youth'): PreseasonOutcome | null {
  const ps = state.preseason;
  if (!ps || ps.done) return null;
  const round = nextPreseasonRound(ps);
  if (round < 0) return null;
  const U = state.teams[state.userTeamId];
  const P = state.players;
  const lineup = preseasonLineup(state, mode);
  let text = '';
  for (const g of ps.games.slice(round * 2, round * 2 + 2)) {
    if (g.result) continue;
    const mine = g.home === U.id || g.away === U.id;
    const dressed = play(state, g, mine ? lineup : null);
    if (!mine) continue;
    recordLineupChemistryGP(U, lineup);
    const used = dressed.filter((id) => P[id]?.teamId === U.id);
    for (const id of used) {
      const p = P[id];
      if (!ps.tested.includes(id)) ps.tested.push(id);
      if (isYouthPlayer(p)) {
        p.trainingXp = clamp((p.trainingXp ?? 0) + (mode === 'youth' ? 9 : 4), 0, 99);
        p.morale = clamp(p.morale + (mode === 'youth' ? 4 : 1), 30, 99);
      }
    }
    const r = g.result!;
    const us = g.home === U.id ? r.home : r.away;
    const them = g.home === U.id ? r.away : r.home;
    const opp = state.teams[g.home === U.id ? g.away : g.home];
    text = `${ps.name}: ${U.short} — ${opp.short} ${us}:${them}${r.so ? ' (Б)' : r.ot ? ' (ОТ)' : ''}`;
  }
  return { text, finished: finishIfDone(state) };
}

function finishIfDone(state: GameState): boolean {
  const ps = state.preseason;
  if (!ps || ps.done || ps.games.some((g) => !g.result)) return false;
  ps.done = true;
  ps.champion = preseasonTable(ps)[0]?.id;
  const U = state.teams[state.userTeamId];
  if (ps.champion === U.id) {
    state.fans = clamp((state.fans ?? 60) + 4, 0, 100);
    if (state.board) state.board.confidence = clamp(state.board.confidence + 3, 5, 100);
    for (const id of U.players) if (state.players[id]) state.players[id].morale = clamp(state.players[id].morale + 3, 30, 99);
  }
  return true;
}

/** The manager skipped ahead: play the remaining summer games with the regular line-up. */
export function autoFinishPreseason(state: GameState): boolean {
  const ps = state.preseason;
  if (!ps || ps.done) return false;
  let guard = 0;
  while (!ps.done && guard++ < 5) if (!playPreseasonRound(state, 'main')) break;
  return ps.done;
}

/** Is it still August, i.e. can the summer tournament be played? */
export const preseasonOpen = (state: GameState) =>
  !!state.preseason && !state.preseason.done && state.phase === 'season' && state.day === 0;
