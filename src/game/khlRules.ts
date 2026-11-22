import type { GameState, Player, RfaOfferSheet, Team, WaiverItem } from '../types';
import { clamp, fairSalary, formatMoney } from './ratings';
import { countRosterLegionnaires, isLegionnaire, teamForeignLimit } from './legionnaires';

/** KHL Unrestricted Free Agent age threshold (28+ = НСА, < 28 = ОСА). */
export const UFA_MIN_AGE = 28;
/** Maximum KHL cap relief per player assigned to the VHL farm club. */
export const MAX_VHL_RELIEF_PER_PLAYER = 35_000_000;
/** Share of salary relieved under KHL cap while in VHL. */
export const VHL_RELIEF_SHARE = 0.6;
/** Maximum players a club can keep in VHL simultaneously. */
export const MAX_VHL_PLAYERS = 10;
/** Maximum age for two-way KHL/VHL/MHL movement without passing through waivers. */
export const WAIVER_EXEMPT_MAX_AGE = 22;
/** Duration of KHL waivers in calendar days (48 hours). */
export const WAIVER_DAYS = 2;

export function isRfaEligibleAge(age: number): boolean {
  return age < UFA_MIN_AGE;
}

export function playerStatusTag(p: Player): 'ОСА' | 'НСА' {
  return p.age < UFA_MIN_AGE ? 'ОСА' : 'НСА';
}

/** Qualifying offer salary to retain KHL RFA sports rights (105% of expiring salary or 85% of fair value). */
export function qualifyingOfferSalary(p: Player): number {
  const base = p.contract.salary > 0 ? p.contract.salary * 1.05 : fairSalary(p.overall) * 0.85;
  return Math.max(2_000_000, Math.round(base / 500_000) * 500_000);
}

/** Monetary compensation paid to the rights-holding club when signing an RFA via offer sheet in KHL. */
export function offerSheetCompensation(salary: number, overall: number): number {
  const tier = overall >= 83 ? 0.45 : overall >= 78 ? 0.32 : overall >= 74 ? 0.22 : 0.14;
  return Math.max(3_000_000, Math.round((salary * tier) / 500_000) * 500_000);
}

/** Whether a player is eligible to ask for / accept a No-Move Clause (ЗНО) in contract talks. */
export function canHaveNmc(p: Player): boolean {
  return p.age >= UFA_MIN_AGE && p.overall >= 79;
}

/** Whether a player is willing to sign a two-way KHL/VHL contract (U23 or depth player <= 76 OVR). */
export function canSignTwoWay(p: Player): boolean {
  return p.age <= 23 || p.overall <= 76;
}

/** True when a player holds an active two-way KHL/VHL contract (explicit `contract.twoWay`, or U22 youth contract unless explicitly `twoWay: false`). */
export function hasTwoWayContract(p: Player | undefined): boolean {
  if (!p) return false;
  if (typeof p.contract.twoWay === 'boolean') return p.contract.twoWay;
  return p.age <= WAIVER_EXEMPT_MAX_AGE;
}

/** Cap relief granted for one player assigned to the VHL farm club: 100% on two-way contracts, 60% (up to 35M) on one-way contracts. */
export function vhlPlayerCapRelief(p: Player | undefined): number {
  if (!p || !p.inVhl || p.contract.salary <= 0) return 0;
  if (hasTwoWayContract(p)) return p.contract.salary;
  return Math.min(MAX_VHL_RELIEF_PER_PLAYER, Math.round((p.contract.salary * VHL_RELIEF_SHARE) / 100_000) * 100_000);
}

/** Total KHL cap relief from all players of a club currently assigned to VHL. */
export function teamVhlCapRelief(ids: string[], P: Record<string, Player>): number {
  let relief = 0;
  for (const id of ids) {
    relief += vhlPlayerCapRelief(P[id]);
  }
  return relief;
}

/** Players occupying an active KHL main-squad roster slot (excludes VHL farm club and LTIR). */
export function activeKhlCount(ids: string[], P: Record<string, Player>): number {
  let n = 0;
  for (const id of ids) {
    const p = P[id];
    if (p && !p.inVhl && !p.inLtir) n++;
  }
  return n;
}

/** Players currently assigned to the VHL farm club. */
export function vhlCount(ids: string[], P: Record<string, Player>): number {
  let n = 0;
  for (const id of ids) {
    if (P[id]?.inVhl) n++;
  }
  return n;
}

/** Exempt from 48-hour KHL waivers when sent to VHL: any player on a two-way KHL/VHL contract (or <= 22 unless explicitly one-way). */
export function isWaiverExempt(p: Player): boolean {
  return hasTwoWayContract(p);
}

export function isOnWaivers(state: GameState, playerId: string): boolean {
  return (state.waivers ?? []).some((w) => w.playerId === playerId);
}

/** Decide whether an AI club matches an offer sheet on its RFA. */
export function aiShouldMatchOfferSheet(
  state: GameState,
  rightsTeam: Team,
  p: Player,
  salary: number,
  currentTeamPayroll: number
): boolean {
  if (activeKhlCount(rightsTeam.players, state.players) >= 30) return false;
  if (rightsTeam.budget < salary) return false;
  if (currentTeamPayroll + salary > state.league.salaryCap) return false;
  const fl = teamForeignLimit(rightsTeam, state.league.foreignLimit);
  if (fl !== null && isLegionnaire(p) && countRosterLegionnaires(rightsTeam.players, state.players) >= fl) return false;
  const fair = fairSalary(p.overall);
  if (salary > fair * 1.32) return false;
  if (p.overall >= 79 || p.potential >= 84) return true;
  if (p.overall >= 74 && salary <= fair * 1.12) return Math.random() < 0.65;
  return false;
}

/** Generate an occasional AI offer sheet on one of the user's unsigned RFAs during the offseason. */
export function maybeGenerateAiRfaOffer(state: GameState, nextOfferId: number): RfaOfferSheet | null {
  const U = state.userTeamId;
  const P = state.players;
  const existing = new Set((state.rfaOffers ?? []).map((o) => o.playerId));
  const userRfas = state.freeAgents
    .map((id) => P[id])
    .filter((p): p is Player => !!p && p.rightsTeamId === U && !existing.has(p.id) && p.overall >= 72);
  if (!userRfas.length) return null;
  const target = userRfas.sort((a, b) => b.overall - a.overall)[0];
  const salary = clamp(Math.round((fairSalary(target.overall) * (1.06 + Math.random() * 0.14)) / 500_000) * 500_000, 8_000_000, 110_000_000);
  const years = target.age <= 24 ? 2 : 3;

  const suitors = state.teamOrder
    .filter((tid) => tid !== U)
    .map((tid) => state.teams[tid])
    .filter((t) => {
      if (t.players.length >= 28 || t.budget < salary * 1.5) return false;
      const pay = t.players.reduce((s, id) => s + ((P[id]?.contract.years ?? 0) > 0 ? P[id].contract.salary : 0), 0);
      if (pay + salary > state.league.salaryCap - 15_000_000) return false;
      const fl = teamForeignLimit(t, state.league.foreignLimit);
      if (fl !== null && isLegionnaire(target) && countRosterLegionnaires(t.players, P) >= fl) return false;
      return true;
    });
  if (!suitors.length) return null;
  const from = suitors[Math.floor(Math.random() * suitors.length)];
  const comp = offerSheetCompensation(salary, target.overall);
  return {
    id: nextOfferId,
    playerId: target.id,
    fromTeamId: from.id,
    rightsTeamId: U,
    salary,
    years,
    compensation: comp,
    day: state.day,
  };
}

/** Resolve expired waiver entries (48h / 2 days): lower-ranked AI clubs may claim, otherwise player enters VHL. */
export function processDailyWaivers(
  state: GameState,
  rankedTeamsWorstFirst: Team[],
  effectivePayrollFn: (t: Team) => number,
  onNews: (text: string, teamId?: string) => void
) {
  if (!state.waivers?.length) return;
  const P = state.players;
  const remaining: WaiverItem[] = [];
  for (const w of state.waivers) {
    const p = P[w.playerId];
    const fromTeam = state.teams[w.fromTeamId];
    if (!p || !fromTeam || p.teamId !== w.fromTeamId) continue;
    if (state.day < w.expiresDay) {
      remaining.push(w);
      continue;
    }
    // Check AI claims (worst-record club gets priority)
    let claimedBy: Team | null = null;
    for (const cand of rankedTeamsWorstFirst) {
      if (cand.id === w.fromTeamId || cand.id === state.userTeamId) continue;
      if (cand.players.length >= 29) continue;
      if (p.overall < 73) continue;
      if (effectivePayrollFn(cand) + p.contract.salary > state.league.salaryCap) continue;
      const rawPay = cand.players.reduce((s, id) => s + ((P[id]?.contract.years ?? 0) > 0 ? P[id].contract.salary : 0), 0);
      if (rawPay + p.contract.salary > state.league.salaryCap) continue;
      const fl = teamForeignLimit(cand, state.league.foreignLimit);
      if (fl !== null && isLegionnaire(p) && countRosterLegionnaires(cand.players, P) >= fl) continue;
      const fair = fairSalary(p.overall);
      if (p.contract.salary <= fair * 1.18 && Math.random() < 0.55) {
        claimedBy = cand;
        break;
      }
    }
    if (claimedBy) {
      fromTeam.players = fromTeam.players.filter((id) => id !== p.id);
      p.teamId = claimedBy.id;
      p.inVhl = false;
      claimedBy.players.push(p.id);
      onNews(
        `Драфт отказов КХЛ: «${claimedBy.name}» забрал ${p.name} (${formatMoney(p.contract.salary)}) из «${fromTeam.name}»!`,
        w.fromTeamId === state.userTeamId ? state.userTeamId : claimedBy.id
      );
    } else {
      p.inVhl = true;
      if (w.fromTeamId === state.userTeamId) {
        onNews(
          `${p.name} прошёл драфт отказов КХЛ без претензий и командирован в фарм-клуб ВХЛ (разгрузка ФОТ: ${formatMoney(vhlPlayerCapRelief(p))}).`,
          state.userTeamId
        );
      }
    }
  }
  state.waivers = remaining;
}
