import type { GameState, Player, ScoutingState } from '../types';
import { clamp } from './ratings';

/**
 * Scouting: the manager sees exact ratings only for his own players. Everyone else is seen through
 * the scouts' eyes — an estimate with an error margin ("78 ± 6") that shrinks as the scouts watch the
 * player (assignments, games against his club) and with a better scouting department.
 */

export const emptyScouting = (): ScoutingState => ({ knowledge: {}, assignments: [] });

export function ensureScouting(state: GameState): ScoutingState {
  state.scouting ??= emptyScouting();
  state.scouting.knowledge ??= {};
  state.scouting.assignments ??= [];
  return state.scouting;
}

const scoutLevel = (state: GameState) => clamp(Math.round(state.teams[state.userTeamId]?.facilities?.scouting ?? 1), 1, 5);

/** How many scouting assignments the department can run at the same time. */
export const scoutSlots = (state: GameState) => 1 + scoutLevel(state);

/** Widest error (for a completely unknown player) by scouting department level. */
export const maxOvrError = (level: number) => [8, 7, 6, 5, 4][clamp(Math.round(level), 1, 5) - 1];

/** Stars are on TV every week: everybody knows roughly how good they are. */
function fame(p: Player): number {
  if (p.overall >= 84) return 70;
  if (p.overall >= 80) return 55;
  if (p.overall >= 75) return 35;
  if (p.overall >= 70) return 20;
  return 8;
}

export function knowledgeOf(state: GameState, p: Player): number {
  if (p.teamId && p.teamId === state.userTeamId) return 100;
  const k = state.scouting?.knowledge?.[p.id] ?? 0;
  return clamp(Math.max(k, fame(p)) + (k > 0 ? Math.min(15, fame(p) * 0.25) : 0), 0, 100);
}

/** Deterministic noise in [-1, 1] per player and season (the same misjudgement every time you look). */
function noise(id: string, salt: string): number {
  let h = 2166136261;
  const s = id + '|' + salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 20001) / 10000 - 1;
}

export interface ScoutView {
  /** rating the scouts report */
  value: number;
  /** ± margin; 0 = exact */
  err: number;
  exact: boolean;
  knowledge: number;
}

export function scoutedOvr(state: GameState, p: Player): ScoutView {
  const k = knowledgeOf(state, p);
  if (k >= 96) return { value: p.overall, err: 0, exact: true, knowledge: k };
  const err = Math.max(1, Math.round(maxOvrError(scoutLevel(state)) * (1 - k / 100)));
  const bias = Math.round(noise(p.id, state.league.season) * err * 0.75);
  return { value: clamp(p.overall + bias, 40, 99), err, exact: false, knowledge: k };
}

/** Potential is harder to judge than the current level, especially for teenagers. */
export function scoutedPotential(state: GameState, p: Player): ScoutView {
  const k = knowledgeOf(state, p);
  if (k >= 96) return { value: p.potential, err: 0, exact: true, knowledge: k };
  const youth = p.age <= 21 ? 1.6 : p.age <= 24 ? 1.3 : 1;
  const err = Math.max(1, Math.round(maxOvrError(scoutLevel(state)) * youth * (1 - k / 100)));
  const bias = Math.round(noise(p.id, state.league.season + 'pot') * err * 0.8);
  return { value: clamp(p.potential + bias, 40, 99), err, exact: false, knowledge: k };
}

/** A skill value as the scouts report it. */
export function scoutedSkill(state: GameState, p: Player, key: string, value: number): { value: number; exact: boolean } {
  const v = scoutedOvr(state, p);
  if (v.exact) return { value, exact: true };
  return { value: clamp(Math.round(value + noise(p.id, key) * v.err), 20, 99), exact: false };
}

/** "78 ± 6" */
export function ovrLabel(state: GameState, p: Player): string {
  const v = scoutedOvr(state, p);
  return v.exact ? String(v.value) : `${v.value}±${v.err}`;
}

/** A player with his rating replaced by the scouts' estimate — what the manager bases decisions on. */
export function asScouted(state: GameState, p: Player): Player {
  const v = scoutedOvr(state, p);
  return v.exact ? p : { ...p, overall: v.value, potential: scoutedPotential(state, p).value };
}

function gain(state: GameState, id: string, amount: number) {
  const sc = ensureScouting(state);
  sc.knowledge[id] = clamp((sc.knowledge[id] ?? 0) + amount, 0, 100);
}

/** Watching a game against a club teaches the scouts a bit about everybody who played. */
export function scoutGame(state: GameState, playerIds: string[]) {
  for (const id of playerIds) {
    const p = state.players[id];
    if (p && p.teamId !== state.userTeamId) gain(state, id, 12);
  }
}

export function assignScout(state: GameState, kind: 'player' | 'team', target: string): string | null {
  const sc = ensureScouting(state);
  if (sc.assignments.some((a) => a.kind === kind && a.target === target)) return 'Скаут уже работает по этому заданию';
  if (sc.assignments.length >= scoutSlots(state)) return `Все скауты заняты (${scoutSlots(state)}). Отзовите одно из заданий или улучшите скаутское бюро.`;
  if (kind === 'player') {
    const p = state.players[target];
    if (!p) return 'Игрок не найден';
    if (p.teamId === state.userTeamId) return 'Своих игроков штаб знает и так';
    if (knowledgeOf(state, p) >= 96) return 'Этот игрок уже изучен';
  } else if (!state.teams[target] || target === state.userTeamId) return 'Клуб не найден';
  sc.assignments.push({ kind, target, since: state.day });
  return null;
}

export function cancelScout(state: GameState, kind: 'player' | 'team', target: string) {
  const sc = ensureScouting(state);
  sc.assignments = sc.assignments.filter((a) => !(a.kind === kind && a.target === target));
}

/** Daily scouting work. Returns the reports that were completed today (for the news feed). */
export function stepScouting(state: GameState, days: number): string[] {
  const sc = ensureScouting(state);
  const lv = scoutLevel(state);
  const done: string[] = [];
  const keep = [];
  for (const a of sc.assignments) {
    if (a.kind === 'player') {
      const p = state.players[a.target];
      if (!p || p.teamId === state.userTeamId) continue;
      gain(state, p.id, (10 + 4 * lv) * days);
      if (knowledgeOf(state, p) >= 96) {
        const team = p.teamId ? state.teams[p.teamId]?.short ?? '' : 'свободный агент';
        done.push(`Скаутский отчёт: ${p.name} (${team}) — рейтинг ${p.overall}, потенциал ${p.potential}.`);
        continue;
      }
    } else {
      const T = state.teams[a.target];
      if (!T) continue;
      for (const id of T.players) gain(state, id, (3 + lv) * days);
      const ps = T.players.map((id) => state.players[id]).filter(Boolean);
      const avg = ps.reduce((s, p) => s + knowledgeOf(state, p), 0) / Math.max(1, ps.length);
      if (avg >= 95) {
        done.push(`Скауты закончили изучать «${T.name}»: рейтинги всех игроков клуба известны точно.`);
        continue;
      }
    }
    keep.push(a);
  }
  sc.assignments = keep;
  return done;
}

/** Ratings change over the summer: last season's reports go stale. */
export function ageScoutingReports(state: GameState) {
  const sc = ensureScouting(state);
  for (const id in sc.knowledge) {
    sc.knowledge[id] = Math.round(sc.knowledge[id] * 0.55);
    if (sc.knowledge[id] < 5) delete sc.knowledge[id];
  }
  sc.assignments = [];
}
