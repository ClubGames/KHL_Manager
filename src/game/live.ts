import type { GameEvent } from '../types';

/**
 * Match statistics as the viewer has seen them so far. The engine computes a whole period at once,
 * so the live screen must never read the engine's totals directly — it folds the events that have
 * already been revealed into this structure instead.
 */
export interface LiveStats {
  score: [number, number];
  shots: [number, number];
  hits: [number, number];
  pim: [number, number];
  ppGoals: [number, number];
  ppChances: [number, number];
  /** goals per period [home, away]; the shootout row holds shootout goals */
  periods: [number, number][];
  goalies: Record<string, { saves: number; shotsAgainst: number; goalsAgainst: number }>;
  /** absolute game second until which [home, away] is short-handed */
  penUntil: [number, number];
}

export const emptyLive = (): LiveStats => ({
  score: [0, 0],
  shots: [0, 0],
  hits: [0, 0],
  pim: [0, 0],
  ppGoals: [0, 0],
  ppChances: [0, 0],
  periods: [],
  goalies: {},
  penUntil: [0, 0],
});

function goalie(L: LiveStats, id: string) {
  return (L.goalies[id] ??= { saves: 0, shotsAgainst: 0, goalsAgainst: 0 });
}
function row(L: LiveStats, period: number): [number, number] {
  while (L.periods.length < period) L.periods.push([0, 0]);
  return L.periods[period - 1];
}

/** Add one revealed event. Mutates and returns the same object. */
export function applyEvent(L: LiveStats, e: GameEvent, homeId: string): LiveStats {
  const ti: 0 | 1 | null = e.team == null ? null : e.team === homeId ? 0 : 1;
  if (e.penUntil) L.penUntil = [e.penUntil[0], e.penUntil[1]];
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
      if (e.goalie) {
        const g = goalie(L, e.goalie);
        g.shotsAgainst++;
        g.saves++;
      }
      break;
    case 'miss':
      if (ti !== null) L.shots[ti]++;
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

/** Who is on the power play at the given absolute game second: 0 = home, 1 = away, 'even' = 4-on-4, null = full strength. */
export function manpower(L: LiveStats, sec: number): { state: 0 | 1 | 'even' | null; remaining: number } {
  const h = Math.max(0, L.penUntil[0] - sec);
  const a = Math.max(0, L.penUntil[1] - sec);
  if (h > 0 && a > 0) return { state: 'even', remaining: Math.min(h, a) };
  if (h > 0) return { state: 1, remaining: h };
  if (a > 0) return { state: 0, remaining: a };
  return { state: null, remaining: 0 };
}
