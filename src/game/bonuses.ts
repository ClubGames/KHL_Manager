import type { BonusKind, ContractBonus, GameState, Player } from '../types';
import { teamStrength } from './board';
import { goalieSavePct } from './ratings';

/**
 * Achievement bonuses in player and coach contracts. They are paid from the club budget (outside the salary
 * cap) when the target is reached: individual and «playoff qualification» bonuses after the regular season,
 * playoff-round bonuses after the final.
 */
export const BONUS_DEFS: Record<BonusKind, { label: string; group: 'skater' | 'goalie' | 'any' | 'team'; targets: number[]; per68?: boolean }> = {
  goals: { label: 'Заброшенные шайбы', group: 'skater', targets: [10, 15, 20, 25, 30, 35], per68: true },
  points: { label: 'Очки (голы + передачи)', group: 'skater', targets: [20, 30, 40, 50, 60, 70], per68: true },
  games: { label: 'Сыгранные матчи', group: 'any', targets: [20, 30, 40, 50, 60], per68: true },
  wins: { label: 'Победы вратаря', group: 'goalie', targets: [10, 15, 20, 25, 30], per68: true },
  svpct: { label: 'Отражённые броски (от 20 матчей)', group: 'goalie', targets: [910, 915, 920, 925, 930] },
  shutouts: { label: 'Сухие матчи', group: 'goalie', targets: [2, 3, 5, 7], per68: true },
  playoffs: { label: 'Выход в плей-офф', group: 'team', targets: [0] },
  round2: { label: 'Проход первого раунда плей-офф', group: 'team', targets: [0] },
  confFinal: { label: 'Выход в финал конференции', group: 'team', targets: [0] },
  final: { label: 'Выход в финал Кубка Гагарина', group: 'team', targets: [0] },
  cup: { label: 'Победа в Кубке Гагарина', group: 'team', targets: [0] },
};
export const BONUS_KINDS = Object.keys(BONUS_DEFS) as BonusKind[];
const STAT_KINDS: BonusKind[] = ['goals', 'points', 'games', 'wins', 'svpct', 'shutouts'];
const REGULAR_KINDS: BonusKind[] = [...STAT_KINDS, 'playoffs'];

/** Bonus kinds that fit this player (or a coach when `p` is null). */
export function bonusKindsFor(p: Player | null): BonusKind[] {
  if (!p) return BONUS_KINDS.filter((k) => BONUS_DEFS[k].group === 'team');
  const g = p.position === 'G';
  return BONUS_KINDS.filter((k) => {
    const grp = BONUS_DEFS[k].group;
    return grp === 'team' || grp === 'any' || (grp === 'goalie') === g;
  });
}

/** Targets scaled to the league's regular-season length (the base values are for 68 games). */
export function bonusTargets(state: GameState, kind: BonusKind): number[] {
  const d = BONUS_DEFS[kind];
  if (!d.per68) return d.targets;
  const k = Math.max(0.2, (state.league.gamesPerTeam || 68) / 68);
  return [...new Set(d.targets.map((t) => Math.max(1, Math.round(t * k))))];
}

export function bonusText(b: Pick<ContractBonus, 'kind' | 'target'>): string {
  switch (b.kind) {
    case 'goals': return `${b.target}+ шайб`;
    case 'points': return `${b.target}+ очков`;
    case 'games': return `${b.target}+ матчей`;
    case 'wins': return `${b.target}+ побед`;
    case 'svpct': return `${(b.target / 1000).toFixed(3).replace(/^0/, '')}+ ОБ`;
    case 'shutouts': return `${b.target}+ сухих матчей`;
    default: return BONUS_DEFS[b.kind].label;
  }
}

/** Saved data is untrusted: keep only well-formed bonuses (at most one per kind). */
export function sanitizeBonuses(raw: unknown): ContractBonus[] {
  if (!Array.isArray(raw)) return [];
  const out: ContractBonus[] = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue;
    const { kind, target, amount } = b as ContractBonus;
    if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(BONUS_DEFS, kind) || out.some((x) => x.kind === kind)) continue;
    if (typeof amount !== 'number' || !(amount > 0) || !Number.isFinite(amount)) continue;
    out.push({ kind, target: typeof target === 'number' && Number.isFinite(target) ? Math.max(0, Math.round(target)) : 0, amount: Math.min(Math.round(amount), 1e9) });
  }
  return out;
}

/** League rank of the club by roster strength as a 0 (best) … 1 (worst) fraction. */
export function strengthFraction(state: GameState, teamId: string): number {
  const t = state.teams[teamId];
  if (!t) return 0.5;
  const mine = teamStrength(state, t);
  const better = state.teamOrder.filter((id) => id !== teamId && teamStrength(state, state.teams[id]) > mine).length;
  return better / Math.max(1, state.teamOrder.length - 1);
}

const erf = (x: number) => {
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
};
/** P(X ≥ target) for a normal estimate. */
const atLeast = (mean: number, sd: number, target: number) => Math.min(0.99, Math.max(0.01, 0.5 * (1 - erf((target - mean) / (Math.max(1e-6, sd) * Math.SQRT2)))));

/** Rank of the player in his position group at the club (0 = best), excluding himself. */
export function depthRank(state: GameState, p: Player, teamId: string): number {
  const g = (x: Player) => (x.position === 'G' ? 'G' : x.position === 'D' ? 'D' : 'F');
  const t = state.teams[teamId];
  if (!t) return 0;
  return t.players.filter((id) => id !== p.id).map((id) => state.players[id]).filter((x) => x && !x.inVhl && g(x) === g(p) && x.overall > p.overall).length;
}

/** Realistic chance (0..1) to earn the bonus over a full season at this club. */
export function bonusChance(state: GameState, b: Pick<ContractBonus, 'kind' | 'target'>, teamId: string, p: Player | null): number {
  const r = strengthFraction(state, teamId);
  const playoffs = Math.min(0.97, Math.max(0.05, 0.97 - 0.85 * r));
  const round2 = playoffs * (0.75 - 0.5 * r), confFinal = round2 * (0.7 - 0.45 * r), final = confFinal * (0.65 - 0.35 * r), cup = final * (0.6 - 0.2 * r);
  switch (b.kind) {
    case 'playoffs': return playoffs;
    case 'round2': return round2;
    case 'confFinal': return confFinal;
    case 'final': return final;
    case 'cup': return cup;
    default: break;
  }
  if (!p) return 0;
  const G = state.league.gamesPerTeam || 68;
  const rank = depthRank(state, p, teamId);
  if (p.position === 'G') {
    const share = rank === 0 ? 0.82 : rank === 1 ? 0.25 : 0.06;
    const games = G * share;
    if (b.kind === 'games') return atLeast(games, G * 0.1, b.target - 0.5);
    if (b.kind === 'wins') return atLeast(games * (0.5 + (0.5 - r) * 0.3), Math.sqrt(games * 0.5) + 1, b.target - 0.5);
    if (b.kind === 'shutouts') { const m = games * Math.max(0.02, Math.min(0.12, 0.05 + (p.overall - 72) * 0.004)); return atLeast(m, Math.sqrt(m * 1.3) + 0.7, b.target - 0.5); }
    if (b.kind === 'svpct') return atLeast(goalieSavePct(p.overall) * 1000 - 14, 8, b.target) * (games >= 24 ? 1 : 0.3);
    return 0;
  }
  const top = p.position === 'D' ? 4 : 6, dressed = p.position === 'D' ? 6 : 12;
  const games = G * (rank < top ? 0.93 : rank < dressed ? 0.82 : 0.45);
  if (b.kind === 'games') return atLeast(games, G * 0.12, b.target - 0.5);
  const d = p.position === 'D';
  // Per-game rates calibrated on simulated seasons of this engine.
  let goals = d ? 0.002 * (p.overall - 60) + 0.01 : 0.0125 * (p.overall - 60) + 0.047;
  let pts = d ? 0.021 * (p.overall - 60) + 0.095 : 0.0235 * (p.overall - 60) + 0.1;
  const last = [...(p.history ?? [])].reverse().find((h) => h.gp >= 20);
  if (last) { goals = (goals + last.goals / last.gp) / 2; pts = (pts + (last.goals + last.assists) / last.gp) / 2; }
  const role = rank < top / 2 ? 1.12 : rank < top ? 1 : 0.8;
  const m = Math.max(0.2, (b.kind === 'goals' ? goals : pts) * role * games);
  return atLeast(m, Math.sqrt(m * 1.4) + 1, b.target - 0.5);
}

/** Has this bonus been earned (judged at the end of its stage)? */
export function bonusEarned(state: GameState, b: ContractBonus, teamId: string, p: Player | null): boolean {
  const s = p?.stats;
  const series = state.playoffs?.series ?? [];
  const inSeries = (round: number) => series.some((x) => x.round === round && (x.high === teamId || x.low === teamId));
  switch (b.kind) {
    case 'goals': return !!s && s.goals >= b.target;
    case 'points': return !!s && s.goals + s.assists >= b.target;
    case 'games': return !!s && s.gp >= b.target;
    case 'wins': return !!s && s.wins >= b.target;
    case 'shutouts': return !!s && s.shutouts >= b.target;
    case 'svpct': return !!s && s.gp >= 20 && s.shotsAgainst > 0 && (s.saves / s.shotsAgainst) * 1000 >= b.target;
    case 'playoffs': return inSeries(0);
    case 'round2': return inSeries(1);
    case 'confFinal': return inSeries(2);
    case 'final': return inSeries(3);
    case 'cup': return state.playoffs?.champion === teamId;
  }
}

/**
 * Pay the user club's earned bonuses for a stage. Regular season: individual stats and playoff qualification;
 * playoffs: the playoff-round bonuses. Returns one line per payment.
 */
export function settleBonuses(state: GameState, stage: 'regular' | 'playoffs'): { lines: string[]; total: number } {
  const t = state.teams[state.userTeamId];
  const lines: string[] = [];
  let total = 0;
  if (!t) return { lines, total };
  const due = (b: ContractBonus) => (stage === 'regular') === REGULAR_KINDS.includes(b.kind);
  const pay = (who: string, list: ContractBonus[] | undefined, p: Player | null) => {
    for (const b of list ?? []) {
      if (!due(b) || !bonusEarned(state, b, t.id, p)) continue;
      total += b.amount;
      lines.push(`${who} — «${bonusText(b)}»`);
    }
  };
  for (const id of t.players) { const p = state.players[id]; if (p) pay(p.name, p.contract.bonuses, p); }
  for (const c of t.coaches ?? []) pay(c.name, c.contract?.bonuses, null);
  t.budget -= total;
  return { lines, total };
}
