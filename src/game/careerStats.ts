import type { GameKind, GameResult, GameState, Player, PlayerGameLine, PlayerStats, SeasonHistory, StatSplit } from '../types';
import { emptyStats } from './defaults';

/** Counters of {@link PlayerStats}, in display order. */
export const STAT_KEYS = ['gp', 'goals', 'assists', 'plusMinus', 'pim', 'shots', 'wins', 'losses', 'otl', 'shutouts', 'saves', 'shotsAgainst', 'minutes'] as const;
type StatKey = (typeof STAT_KEYS)[number];

/** What one committed game adds to a player's line (the same rules feed the season totals and the per-club split). */
export interface GameCredit {
  line: PlayerGameLine;
  goalie: boolean;
  won: boolean;
  /** decided in overtime or a shootout */
  beyond: boolean;
}

export function addGame(st: PlayerStats, c: GameCredit) {
  const l = c.line;
  st.gp++;
  st.goals += l.goals;
  st.assists += l.assists;
  st.plusMinus += l.plusMinus;
  st.pim += l.pim;
  st.shots += l.shots;
  if (!c.goalie) return;
  st.minutes += l.minutes;
  st.saves += l.saves;
  st.shotsAgainst += l.shotsAgainst;
  if (c.won) st.wins++;
  else if (c.beyond) st.otl++;
  else st.losses++;
  if (c.won && l.goalsAgainst === 0 && l.minutes >= 55) st.shutouts++;
}

function splitFor(p: Player, teamId: string, kind: GameKind): StatSplit {
  p.seasonSplits ??= [];
  let sp = p.seasonSplits.find((x) => x.teamId === teamId && x.kind === kind);
  if (!sp) {
    sp = { ...emptyStats(), teamId, kind };
    p.seasonSplits.push(sp);
  }
  return sp;
}

/** Credit a committed game to the player's season totals and to the split of the club they played it for. */
export function creditGame(p: Player, teamId: string, kind: GameKind, c: GameCredit) {
  addGame(p.stats, c);
  addGame(splitFor(p, teamId, kind), c);
}

function rowFrom(season: string, overall: number, sp: StatSplit): SeasonHistory {
  return {
    season,
    teamId: sp.teamId,
    kind: sp.kind,
    overall,
    gp: sp.gp,
    goals: sp.goals,
    assists: sp.assists,
    wins: sp.wins,
    shutouts: sp.shutouts,
    plusMinus: sp.plusMinus,
    pim: sp.pim,
    shots: sp.shots,
    losses: sp.losses,
    otl: sp.otl,
    saves: sp.saves,
    shotsAgainst: sp.shotsAgainst,
    minutes: sp.minutes,
  };
}

/** Regular season first (in the order the clubs were played for), then the playoffs. */
const ordered = (splits: StatSplit[]) => [...splits.filter((x) => x.kind === 'regular'), ...splits.filter((x) => x.kind === 'playoff')];

/** History rows of the current season for one player (one per club and stage; a zero row keeps the season visible). */
export function seasonRowsOf(state: GameState, p: Player): SeasonHistory[] {
  const season = state.league.season;
  const splits = ordered(p.seasonSplits ?? []).filter((x) => x.gp > 0);
  if (splits.length) return splits.map((sp) => rowFrom(season, p.overall, sp));
  if (!p.stats.gp && !p.history.length) return [];
  // A player with no split (no games, or statistics from before splits were tracked): one whole-season row.
  return [{
    season, teamId: p.teamId, kind: 'regular', overall: p.overall,
    gp: p.stats.gp, goals: p.stats.goals, assists: p.stats.assists, wins: p.stats.wins, shutouts: p.stats.shutouts,
    plusMinus: p.stats.plusMinus, pim: p.stats.pim, shots: p.stats.shots, losses: p.stats.losses, otl: p.stats.otl,
    saves: p.stats.saves, shotsAgainst: p.stats.shotsAgainst, minutes: p.stats.minutes,
  }];
}

/** Write the finished season into every player's history (once). */
export function recordSeasonHistory(state: GameState) {
  const season = state.league.season;
  for (const id in state.players) {
    const p = state.players[id];
    if (!p) continue;
    if (p.history[p.history.length - 1]?.season === season) continue;
    p.history.push(...seasonRowsOf(state, p));
  }
}

/** Start of a new season: splits are cleared together with the season totals. */
export function resetSeasonSplits(state: GameState) {
  for (const id in state.players) delete state.players[id].seasonSplits;
  state.splitsSeason = state.league.season;
}

/* ---------------- rebuilding splits for older saves ---------------- */

type Recon = { teamId: string; kind: GameKind; st: PlayerStats };

/**
 * Per-club statistics of the current season from the committed results that saves keep (dressed players, goal
 * scorers, goalies, team shots). Saves drop the per-player box scores, so +/−, penalty minutes, shots and the
 * goalies' exact saves are shared out later in proportion to games played.
 */
function reconstruct(state: GameState): Map<string, Recon[]> {
  const out = new Map<string, Recon[]>();
  const rowOf = (pid: string, teamId: string, kind: GameKind) => {
    let rows = out.get(pid);
    if (!rows) out.set(pid, (rows = []));
    let r = rows.find((x) => x.teamId === teamId && x.kind === kind);
    if (!r) rows.push((r = { teamId, kind, st: emptyStats() }));
    return r.st;
  };
  for (const day of state.schedule)
    for (const g of day) {
      const res: GameResult | null = g.played ? g.result : null;
      if (!res) continue;
      const kind: GameKind = g.kind === 'playoff' ? 'playoff' : 'regular';
      const beyond = res.ot || res.so;
      const homeWon = res.homeScore > res.awayScore;
      const mins = res.so ? 65 : beyond ? 65 : 60;
      for (const side of [0, 1] as const) {
        const teamId = side === 0 ? g.home : g.away;
        const dressed = side === 0 ? res.homeDressed : res.awayDressed;
        const goalie = side === 0 ? res.homeGoalie : res.awayGoalie;
        const won = side === 0 ? homeWon : !homeWon;
        const oppShots = (side === 0 ? res.awayStats : res.homeStats)?.shots ?? 0;
        const oppGoals = (side === 0 ? res.awayScore : res.homeScore) - (res.so && !won ? 1 : 0);
        for (const pid of dressed ?? []) {
          const p = state.players[pid];
          if (!p) continue;
          if (p.position === 'G') {
            if (pid !== goalie) continue;
            const st = rowOf(pid, teamId, kind);
            st.gp++;
            st.minutes += mins;
            st.shotsAgainst += oppShots;
            st.saves += Math.max(0, oppShots - oppGoals);
            if (won) st.wins++;
            else if (beyond) st.otl++;
            else st.losses++;
            if (won && oppGoals === 0) st.shutouts++;
          } else rowOf(pid, teamId, kind).gp++;
        }
      }
      for (const sc of res.scorers ?? []) {
        if (state.players[sc.scorer]) rowOf(sc.scorer, sc.team, kind).goals++;
        for (const a of sc.assists) if (state.players[a]) rowOf(a, sc.team, kind).assists++;
      }
    }
  return out;
}

/** Share `total` out in proportion to `weights` (integers, the remainder goes to the heaviest row). */
function share(total: number, weights: number[]): number[] {
  const W = weights.reduce((a, b) => a + b, 0);
  if (!weights.length) return [];
  const heavy = weights.indexOf(Math.max(...weights));
  if (W <= 0) return weights.map((_, i) => (i === heavy ? total : 0));
  const res = weights.map((w) => Math.round((total * w) / W));
  res[heavy] += total - res.reduce((a, b) => a + b, 0);
  return res;
}

/** Make reconstructed counts add up to the season totals: the difference goes to the busiest rows, never below 0. */
function fit(total: number, recon: number[], weights: number[]): number[] {
  const res = [...recon];
  let diff = total - res.reduce((a, b) => a + b, 0);
  const order = weights.map((w, i) => [w, i]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
  for (const i of order) {
    if (!diff) break;
    const d = diff > 0 ? diff : Math.max(diff, -res[i]);
    res[i] += d;
    diff -= d;
  }
  return res;
}

const COUNTED: StatKey[] = ['gp', 'goals', 'assists', 'wins', 'losses', 'otl', 'shutouts'];

function splitsFrom(p: Player, rows: Recon[], fallbackTeam: string | null, fallbackKind: GameKind): StatSplit[] {
  if (!rows.length) {
    if (!p.stats.gp || !fallbackTeam) return [];
    return [{ ...p.stats, teamId: fallbackTeam, kind: fallbackKind }];
  }
  const gp = rows.map((r) => r.st.gp);
  const fitted = gp.length ? fit(p.stats.gp, gp, gp) : [];
  const weights = fitted.map((g, i) => g || gp[i]);
  const col: Partial<Record<StatKey, number[]>> = { gp: fitted };
  for (const k of STAT_KEYS) {
    if (k === 'gp') continue;
    const recon = rows.map((r) => r.st[k]);
    const known = COUNTED.includes(k) || (p.position === 'G' && (k === 'saves' || k === 'shotsAgainst' || k === 'minutes'));
    col[k] = known && recon.some((v) => v > 0) ? (COUNTED.includes(k) ? fit(p.stats[k], recon, weights) : share(p.stats[k], recon)) : share(p.stats[k], weights);
  }
  return rows.map((r, i) => {
    const sp: StatSplit = { ...emptyStats(), teamId: r.teamId, kind: r.kind };
    for (const k of STAT_KEYS) sp[k] = col[k]![i];
    return sp;
  });
}

/**
 * Older saves (and every save before this version) have no per-club splits: rebuild them for the current season from
 * the schedule. When the season was already written into the history as a single whole-season row, that row is
 * replaced by the per-club rows while the schedule is still there (the offseason).
 */
export function ensureSeasonSplits(state: GameState) {
  if (state.splitsSeason === state.league.season) return;
  const recon = reconstruct(state);
  const season = state.league.season;
  const fallbackKind: GameKind = state.phase === 'playoffs' ? 'playoff' : 'regular';
  for (const id in state.players) {
    const p = state.players[id];
    if (!p) continue;
    const last = p.history[p.history.length - 1];
    if (last?.season === season) {
      if (last.kind || !recon.has(id)) continue;
      const splits = splitsFrom(p, recon.get(id)!, last.teamId, 'regular');
      if (!splits.length) continue;
      p.history.pop();
      p.history.push(...ordered(splits).filter((x) => x.gp > 0).map((sp) => rowFrom(season, last.overall, sp)));
      continue;
    }
    const splits = splitsFrom(p, recon.get(id) ?? [], p.teamId, fallbackKind);
    if (splits.length) p.seasonSplits = ordered(splits);
    else delete p.seasonSplits;
  }
  state.splitsSeason = season;
}

/* ---------------- views ---------------- */

export interface CareerRow extends SeasonHistory {
  /** the season in progress (not yet written into the history) */
  current?: boolean;
}

/** The full career table: the history plus the season in progress. */
export function careerRows(state: GameState, p: Player): CareerRow[] {
  const rows: CareerRow[] = [...p.history];
  const season = state.league.season;
  if (p.history[p.history.length - 1]?.season !== season) rows.push(...seasonRowsOf(state, p).map((r) => ({ ...r, current: true })));
  return rows;
}

/** Totals of the given rows. */
export function sumRows(rows: SeasonHistory[]): Required<Omit<SeasonHistory, 'season' | 'teamId' | 'kind' | 'overall'>> {
  const t = { gp: 0, goals: 0, assists: 0, wins: 0, shutouts: 0, plusMinus: 0, pim: 0, shots: 0, losses: 0, otl: 0, saves: 0, shotsAgainst: 0, minutes: 0 };
  for (const r of rows) for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += r[k] ?? 0;
  return t;
}

/** Whole-season totals of past seasons (regular season, or the old whole-season rows), newest last. */
export function pastSeasonTotals(p: Player): { season: string; gp: number; goals: number; assists: number }[] {
  const by = new Map<string, { season: string; gp: number; goals: number; assists: number }>();
  for (const h of p.history) {
    if (h.kind === 'playoff') continue;
    const t = by.get(h.season) ?? { season: h.season, gp: 0, goals: 0, assists: 0 };
    t.gp += h.gp;
    t.goals += h.goals;
    t.assists += h.assists;
    by.set(h.season, t);
  }
  return [...by.values()];
}

/** Clubs of the career in order, with the seasons spent at each (consecutive seasons merged). */
export function careerClubs(state: GameState, p: Player): { teamId: string; from: string; to: string; gp: number }[] {
  const out: { teamId: string; from: string; to: string; gp: number }[] = [];
  for (const r of careerRows(state, p)) {
    if (!r.teamId) continue;
    const prev = out[out.length - 1];
    if (prev?.teamId === r.teamId) {
      prev.to = r.season;
      prev.gp += r.gp;
    } else out.push({ teamId: r.teamId, from: r.season, to: r.season, gp: r.gp });
  }
  return out;
}
