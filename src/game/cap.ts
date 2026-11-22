import type { GameState, Phase, Player, Team, TeamRecord } from '../types';
import { isGoalie, payroll } from './ratings';
import { teamVhlCapRelief } from './khlRules';

/** Days at the start of the regular season given to clear an inherited cap overrun before sanctions hit. */
export const CAP_GRACE_DAYS = 7;
/** Share of annual salary that remains as a dead-cap charge for the rest of the season after a buyout. */
export const BUYOUT_DEAD_CAP_SHARE = 0.2;
/** Matches played in cap violation before each 2-point standings deduction. */
export const CAP_GAMES_PER_POINT_DEDUCTION = 5;

export function teamBasePayroll(ids: string[], P: Record<string, Player>, phase: Phase = 'season'): number {
  if (phase === 'offseason') {
    return ids.reduce((s, id) => s + ((P[id]?.contract.years ?? 0) > 0 ? P[id].contract.salary : 0), 0);
  }
  return payroll(ids, P);
}

export function effectivePayroll(team: Pick<Team, 'players' | 'deadCap'>, P: Record<string, Player>, phase: Phase = 'season'): number {
  const base = teamBasePayroll(team.players, P, phase);
  const vhlRelief = phase === 'offseason' ? 0 : teamVhlCapRelief(team.players, P);
  return Math.max(0, base - vhlRelief + (phase === 'offseason' ? 0 : (team.deadCap ?? 0)));
}

export function buyoutDeadCap(salary: number): number {
  return Math.round((salary * BUYOUT_DEAD_CAP_SHARE) / 100_000) * 100_000;
}

export function capExcess(state: GameState, teamId: string): number {
  const t = state.teams[teamId];
  if (!t) return 0;
  return Math.max(0, effectivePayroll(t, state.players, state.phase) - state.league.salaryCap);
}

export function dailyCapFine(excess: number): number {
  if (excess <= 0) return 0;
  return Math.max(500_000, Math.round(((excess / 170) * 3) / 100_000) * 100_000);
}

export function recomputePoints(r: TeamRecord): number {
  const earned = 2 * (r.w + r.otw + r.sow) + r.otl + r.sol;
  return Math.max(0, earned - (r.capPenaltyPoints ?? 0));
}

/**
 * Players barred by the league from dressing for matches while the club exceeds the salary cap
 * after the grace window: highest-paid contracts are frozen until the active roster fits under the cap.
 */
export function capSuspendedPlayers(state: GameState, teamId: string): string[] {
  if (state.phase === 'offseason' || state.day < CAP_GRACE_DAYS) return [];
  const excess = capExcess(state, teamId);
  if (excess <= 0) return [];
  const t = state.teams[teamId];
  const P = state.players;
  const healthyGoalies = t.players.filter((id) => P[id] && isGoalie(P[id]) && !P[id].injury && !P[id].inVhl);
  const candidates = t.players
    .map((id) => P[id])
    .filter((p): p is Player => !!p && !p.injury && !p.inVhl && p.contract.salary > 0)
    .sort((a, b) => b.contract.salary - a.contract.salary || a.overall - b.overall);

  const suspended: string[] = [];
  let covered = 0;
  let goaliesLeft = healthyGoalies.length;
  for (const p of candidates) {
    if (covered >= excess) break;
    // Leave at least one healthy goalie if possible so the match can still be played
    if (isGoalie(p) && goaliesLeft <= 1) continue;
    if (isGoalie(p)) goaliesLeft--;
    suspended.push(p.id);
    covered += p.contract.salary;
  }
  return suspended;
}

export interface CapSummary {
  basePayroll: number;
  vhlRelief: number;
  deadCap: number;
  totalPayroll: number;
  cap: number;
  space: number;
  excess: number;
  over: boolean;
  sanctionsActive: boolean;
  graceDaysLeft: number;
  suspendedIds: string[];
  dailyFine: number;
  violationDays: number;
  violationGames: number;
  pointsDeducted: number;
  finesTotal: number;
}

export function getCapSummary(state: GameState, teamId: string): CapSummary {
  const t = state.teams[teamId];
  const cap = state.league.salaryCap;
  const basePayroll = teamBasePayroll(t.players, state.players, state.phase);
  const vhlRelief = state.phase === 'offseason' ? 0 : teamVhlCapRelief(t.players, state.players);
  const deadCap = state.phase === 'offseason' ? 0 : (t.deadCap ?? 0);
  const totalPayroll = Math.max(0, basePayroll - vhlRelief + deadCap);
  const excess = Math.max(0, totalPayroll - cap);
  const over = excess > 0;
  const graceDaysLeft = state.phase === 'season' ? Math.max(0, CAP_GRACE_DAYS - state.day) : 0;
  const sanctionsActive = over && state.phase !== 'offseason' && state.day >= CAP_GRACE_DAYS;
  const suspendedIds = sanctionsActive ? capSuspendedPlayers(state, teamId) : [];
  return {
    basePayroll,
    vhlRelief,
    deadCap,
    totalPayroll,
    cap,
    space: cap - totalPayroll,
    excess,
    over,
    sanctionsActive,
    graceDaysLeft,
    suspendedIds,
    dailyFine: over && state.phase !== 'offseason' ? dailyCapFine(excess) : 0,
    violationDays: t.capViolationDays ?? 0,
    violationGames: t.capViolationGames ?? 0,
    pointsDeducted: t.record.capPenaltyPoints ?? 0,
    finesTotal: t.capFinesTotal ?? 0,
  };
}
