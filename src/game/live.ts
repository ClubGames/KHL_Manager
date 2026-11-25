import type { GameEvent, ScoringPlay, ShotPoint } from '../types';

/**
 * Match statistics as the viewer has seen them so far. The engine computes a whole period at once,
 * so the live screen must never read the engine's totals directly — it folds the events that have
 * already been revealed into this structure instead.
 */
export interface LiveStats {
  score: [number, number];
  shots: [number, number];
  xg: [number, number];
  dangerShots: [number, number];
  shotMap: ShotPoint[];
  hits: [number, number];
  pim: [number, number];
  ppGoals: [number, number];
  ppChances: [number, number];
  /** goals per period [home, away]; the shootout row holds shootout goals */
  periods: [number, number][];
  goalies: Record<string, { saves: number; shotsAgainst: number; goalsAgainst: number }>;
  /** absolute game second until which [home, away] is short-handed */
  penUntil: [number, number];
  /** pending penalties per team as [start, end] (absolute seconds); null until the engine reported the box */
  box: [[number, number][], [number, number][]] | null;
}

export const emptyLive = (): LiveStats => ({
  score: [0, 0],
  shots: [0, 0],
  xg: [0, 0],
  dangerShots: [0, 0],
  shotMap: [],
  hits: [0, 0],
  pim: [0, 0],
  ppGoals: [0, 0],
  ppChances: [0, 0],
  periods: [],
  goalies: {},
  penUntil: [0, 0],
  box: null,
});

function goalie(L: LiveStats, id: string) {
  return (L.goalies[id] ??= { saves: 0, shotsAgainst: 0, goalsAgainst: 0 });
}
function row(L: LiveStats, period: number): [number, number] {
  while (L.periods.length < period) L.periods.push([0, 0]);
  return L.periods[period - 1];
}
function recordShot(L: LiveStats, ti: 0 | 1, e: GameEvent, outcome: ShotPoint['outcome']) {
  const xg = e.xg ?? 0;
  L.xg[ti] = Math.round((L.xg[ti] + xg) * 1000) / 1000;
  if (xg >= 0.12) L.dangerShots[ti]++;
  if (e.x !== undefined && e.y !== undefined) {
    L.shotMap.push({
      t: ti,
      player: e.player,
      period: e.period,
      time: e.time,
      x: e.x,
      y: e.y,
      xg,
      outcome,
      zone: e.zone ?? 'slot',
      strength: e.strength ?? 'EV',
      shotType: e.shotType ?? 'wrist',
    });
  }
}

/** Add one revealed event. Mutates and returns the same object. */
export function applyEvent(L: LiveStats, e: GameEvent, homeId: string): LiveStats {
  const ti: 0 | 1 | null = e.team == null ? null : e.team === homeId ? 0 : 1;
  if (e.penUntil) L.penUntil = [e.penUntil[0], e.penUntil[1]];
  if (e.box) L.box = [e.box[0].map((x): [number, number] => [x[0], x[1]]), e.box[1].map((x): [number, number] => [x[0], x[1]])];
  switch (e.type) {
    case 'period_start':
      row(L, e.period);
      break;
    case 'period_end':
      if (e.so) L.periods[e.period - 1] = [e.so[0], e.so[1]];
      break;
    case 'goal':
      if (ti === null) break;
      L.shots[ti]++;
      recordShot(L, ti, e, 'goal');
      row(L, e.period)[ti]++;
      if (e.pp || e.strength === 'PP') L.ppGoals[ti]++;
      if (e.goalie) {
        const g = goalie(L, e.goalie);
        g.shotsAgainst++;
        g.goalsAgainst++;
      }
      break;
    case 'shot':
      if (ti === null) break;
      L.shots[ti]++;
      recordShot(L, ti, e, 'save');
      if (e.goalie) {
        const g = goalie(L, e.goalie);
        g.shotsAgainst++;
        g.saves++;
      }
      break;
    case 'miss':
      if (ti !== null) {
        L.shots[ti]++;
        recordShot(L, ti, e, 'miss');
      }
      break;
    case 'hit':
      if (ti !== null) L.hits[ti]++;
      break;
    case 'penalty':
      if (ti === null) break;
      L.pim[ti] += e.pim ?? 0;
      if (e.pp) L.ppChances[ti === 0 ? 1 : 0]++;
      break;
    case 'so_goal':
      if (ti !== null) row(L, e.period)[ti]++;
      break;
    default:
      break;
  }
  if (e.score) L.score = [e.score[0], e.score[1]];
  return L;
}

export function foldEvents(events: GameEvent[], homeId: string): LiveStats {
  const L = emptyLive();
  for (const e of events) applyEvent(L, e, homeId);
  return L;
}

export interface Manpower {
  /** who is on the power play: 0 = home, 1 = away, 'even' = short-handed on both sides (4-on-4, 3-on-3), null = full strength */
  state: 0 | 1 | 'even' | null;
  /** skaters [home, away]: 5, 4 or 3 */
  men: [number, number];
  /** seconds until the manpower changes next */
  remaining: number;
}

const menAt = (box: [[number, number][], [number, number][]], t: number): [number, number] =>
  [0, 1].map((i) => 5 - Math.min(2, box[i].filter(([a, b]) => a <= t && t < b).length)) as [number, number];

/** Manpower at the given absolute game second: two penalties at once make it 5-on-3, a third one waits its turn. */
export function manpower(L: LiveStats, sec: number): Manpower {
  let men: [number, number];
  let remaining = 0;
  if (L.box) {
    men = menAt(L.box, sec);
    // the next moment the numbers change (a penalty ends — a waiting one may start at once and keep it 3-on-5)
    const marks = [...L.box[0], ...L.box[1]].flat().filter((t) => t > sec).sort((a, b) => a - b);
    for (const t of marks) {
      const m = menAt(L.box, t);
      if (m[0] !== men[0] || m[1] !== men[1]) { remaining = t - sec; break; }
    }
  } else {
    // older events without the box: one clock per team
    const h = Math.max(0, L.penUntil[0] - sec), a = Math.max(0, L.penUntil[1] - sec);
    men = [h > 0 ? 4 : 5, a > 0 ? 4 : 5];
    remaining = h > 0 && a > 0 ? Math.min(h, a) : Math.max(h, a);
  }
  const state = men[0] === men[1] ? (men[0] === 5 ? null : 'even') : men[0] > men[1] ? 0 : 1;
  return { state, men, remaining: state === null ? 0 : remaining };
}

/** The play-by-play event of a goal from the scoring summary (null when the log was not kept, e.g. after a reload). */
export function goalEventFor(events: GameEvent[] | undefined, sc: ScoringPlay): GameEvent | null {
  return events?.find((e) => e.type === 'goal' && e.period === sc.period && e.time === sc.time && e.player === sc.scorer && e.team === sc.team) ?? null;
}
