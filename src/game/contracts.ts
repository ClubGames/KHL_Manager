import type { GameState, Player } from '../types';
import { fairSalary, salaryDemand } from './ratings';
import { canHaveNmc } from './khlRules';

export interface ContractTerms {
  salary: number;
  years: number;
}

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
/** Deterministic 0..1 sequence for a text seed: the same player always gets the same numbers. */
export function seeded(seed: string): () => number {
  let a = hashStr(seed) || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (v: number) => Math.max(1_000_000, Math.round(v / 500_000) * 500_000);

/** Longest deal a player of this age will sign. */
export const maxYears = (age: number) => (age >= 35 ? 1 : age >= 32 ? 2 : age >= 30 ? 3 : 5);

/**
 * Contract for a player whose contract is missing in roster.json. Derived only from the player's own
 * data, so every launch produces the same contract until it is written into the file.
 */
export function generateContract(p: Pick<Player, 'id' | 'name' | 'age' | 'overall' | 'potential'>): ContractTerms {
  const r = seeded(`${p.id}|${p.name}`);
  const ageF = p.age <= 21 ? 0.6 : p.age <= 23 ? 0.8 : p.age <= 31 ? 1 : p.age <= 34 ? 0.9 : 0.75;
  const salary = round(fairSalary(p.overall) * ageF * (0.88 + r() * 0.24));
  const x = r();
  let years: number;
  if (p.age <= 23) years = x < 0.45 ? 2 : 3;
  else if (p.age <= 29) years = x < 0.2 ? 1 : x < 0.55 ? 2 : x < 0.85 ? 3 : 4;
  else if (p.age <= 33) years = x < 0.55 ? 1 : 2;
  else years = 1;
  return { salary, years: Math.min(years, maxYears(p.age)) };
}

/** Place in the conference by points (enough for mood purposes). */
function confPlace(state: GameState, teamId: string): { place: number; gp: number } {
  const t = state.teams[teamId];
  let place = 1;
  for (const id of state.teamOrder) {
    const o = state.teams[id];
    if (o.id !== teamId && o.conference === t.conference && o.record.points > t.record.points) place++;
  }
  return { place, gp: t.record.gp };
}

/** What the player asks from the given club for a deal of this length. */
export function askingSalary(state: GameState, p: Player, years: number, teamId: string, withNmc = false): number {
  let v = salaryDemand(p.overall, p.age, p.potential);
  // young players charge for selling their best years; veterans give a discount for security
  v *= p.age < 30 ? 1 + 0.04 * (years - 1) : 1 - 0.03 * (years - 1);
  if (p.teamId === teamId) v *= p.morale >= 75 ? 0.95 : p.morale < 50 ? 1.1 : 1;
  const { place, gp } = confPlace(state, teamId);
  if (gp >= 10) v *= place <= 4 ? 0.97 : place >= 10 ? 1.05 : 1;
  if (withNmc && canHaveNmc(p) && years >= 2) v *= 0.92;
  return round(v);
}

export const talksKey = (state: GameState) => `${state.seasonNumber}-${state.phase === 'offseason' ? 'off' : 'reg'}`;
export const TALKS = 3;
export function talksLeft(state: GameState, p: Player): number {
  return p.talks && p.talks.key === talksKey(state) ? p.talks.left : TALKS;
}

/** The lowest salary the player will really accept (hidden from the manager, fixed for the negotiation window). */
export function floorSalary(state: GameState, p: Player, years: number, teamId: string, withNmc = false): number {
  const flex = 0.87 + 0.1 * seeded(`${p.id}|${talksKey(state)}`)();
  return Math.round(askingSalary(state, p, years, teamId, withNmc) * flex);
}

export interface Verdict {
  accept: boolean;
  left: number;
  tone: 'ok' | 'close' | 'low' | 'insult' | 'closed';
  text: string;
}

/** Player's answer to an offer. A rejected offer costs patience (stored on the player). */
export function negotiate(state: GameState, p: Player, salary: number, years: number, teamId: string, withNmc = false): Verdict {
  const key = talksKey(state);
  let left = talksLeft(state, p);
  if (left <= 0) return { accept: false, left: 0, tone: 'closed', text: `${p.name} прервал переговоры. Вернуться к ним можно ${state.phase === 'offseason' ? 'в следующем сезоне' : 'в межсезонье'}.` };
  const my = maxYears(p.age);
  if (years > my) return { accept: false, left, tone: 'low', text: `${p.name} (возраст ${p.age}) не подпишет контракт дольше ${my} ${my === 1 ? 'года' : 'лет'}.` };
  const ratio = salary / floorSalary(state, p, years, teamId, withNmc);
  if (ratio >= 1) return { accept: true, left, tone: 'ok', text: `${p.name} согласен.` };
  const insult = ratio < 0.8;
  left = Math.max(0, left - (insult ? 2 : 1));
  p.talks = { key, left };
  const tail = left > 0 ? ` Осталось попыток: ${left}.` : ' Игрок прервал переговоры.';
  if (insult) return { accept: false, left, tone: 'insult', text: `${p.name} считает предложение неуважительным.${tail}` };
  if (ratio >= 0.95) return { accept: false, left, tone: 'close', text: `${p.name} отказал, но стороны очень близки.${tail}` };
  return { accept: false, left, tone: 'low', text: `${p.name} отказал: предложение заметно ниже ожиданий.${tail}` };
}

/** Seasons of salary still owed on the contract (the current season counts only for its unplayed part). */
export function remainingValue(state: GameState, p: Player): number {
  const c = p.contract;
  let seasons = c.years;
  if (state.phase !== 'offseason') {
    const reg = state.schedule.findIndex((d) => d.length > 0 && d[0].kind === 'playoff');
    const total = reg < 0 ? state.schedule.length : reg;
    const frac = state.phase === 'season' ? Math.max(0, 1 - state.day / Math.max(1, total)) : 0;
    seasons = Math.max(0, c.years - 1) + frac;
  }
  return c.salary * seasons + (c.next ? c.next.salary * c.next.years : 0);
}

/** Severance for terminating a contract: a simplified game rule — one third of what is still owed. */
export function buyoutCost(state: GameState, p: Player): number {
  return Math.round(remainingValue(state, p) / 3 / 100_000) * 100_000;
}

/** Salary commitments of a roster for this season and the following ones. */
export function commitments(ids: string[], P: Record<string, Player>, seasons = 4): number[] {
  const out = new Array(seasons).fill(0);
  for (const id of ids) {
    const c = P[id]?.contract;
    if (!c) continue;
    for (let y = 0; y < seasons; y++) {
      if (y < c.years) out[y] += c.salary;
      else if (c.next && y < c.years + c.next.years) out[y] += c.next.salary;
    }
  }
  return out;
}
