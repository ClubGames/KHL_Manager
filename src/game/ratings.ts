import type { Player, PosCode } from '../types';

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export const isForward = (p: Player) => p.position === 'C' || p.position === 'LW' || p.position === 'RW';
export const isDefense = (p: Player) => p.position === 'D';
export const isGoalie = (p: Player) => p.position === 'G';
export const isSkater = (p: Player) => p.position !== 'G';
export const points = (p: Player) => p.stats.goals + p.stats.assists;

export const POS_RU: Record<PosCode, string> = { C: 'Ц', LW: 'ЛК', RW: 'ПК', D: 'З', G: 'В' };
export const POS_NAME: Record<PosCode, string> = {
  C: 'Центральный нападающий',
  LW: 'Левый крайний нападающий',
  RW: 'Правый крайний нападающий',
  D: 'Защитник',
  G: 'Вратарь',
};

export const SKATER_KEYS = ['skating', 'shooting', 'passing', 'puckControl', 'checking', 'defense'] as const;
export const GOALIE_KEYS = ['reflexes', 'positioning', 'reboundControl', 'puckHandling', 'endurance'] as const;
export const SKILL_LABELS: Record<string, string> = {
  skating: 'Катание',
  shooting: 'Бросок',
  passing: 'Пас',
  puckControl: 'Владение шайбой',
  checking: 'Силовая игра',
  defense: 'Оборона',
  reflexes: 'Рефлексы',
  positioning: 'Позиционная игра',
  reboundControl: 'Контроль отскоков',
  puckHandling: 'Игра клюшкой',
  endurance: 'Выносливость',
};

const F_W: Record<string, number> = { skating: 0.2, shooting: 0.25, passing: 0.2, puckControl: 0.2, checking: 0.07, defense: 0.08 };
const D_W: Record<string, number> = { skating: 0.15, shooting: 0.1, passing: 0.15, puckControl: 0.15, checking: 0.2, defense: 0.25 };
const G_W: Record<string, number> = { reflexes: 0.3, positioning: 0.3, reboundControl: 0.2, puckHandling: 0.1, endurance: 0.1 };

export function skillList(p: Player): { key: string; label: string; value: number }[] {
  const keys = isGoalie(p) ? GOALIE_KEYS : SKATER_KEYS;
  return keys.map((k) => ({ key: k, label: SKILL_LABELS[k], value: p.skills[k] ?? 65 }));
}

export function computeOverall(p: Player): number {
  const w = isGoalie(p) ? G_W : isDefense(p) ? D_W : F_W;
  let s = 0;
  const sk = p.skills as Record<string, number | undefined>;
  for (const k in w) s += (sk[k] ?? 65) * w[k];
  return clamp(Math.round(s), 1, 99);
}

export function attackRating(p: Player | null): number {
  if (!p || isGoalie(p)) return 20;
  const s = p.skills;
  return 0.25 * (s.skating ?? 65) + 0.3 * (s.shooting ?? 65) + 0.25 * (s.passing ?? 65) + 0.2 * (s.puckControl ?? 65);
}

export function defenseRating(p: Player | null): number {
  if (!p || isGoalie(p)) return 20;
  const s = p.skills;
  return 0.35 * (s.defense ?? 65) + 0.3 * (s.checking ?? 65) + 0.2 * (s.skating ?? 65) + 0.15 * (s.passing ?? 65);
}

const REPL = 50;

function fill(ids: (string | null)[] | undefined, n: number, P: Record<string, Player>, skatersOnly = true): (Player | null)[] {
  const out: (Player | null)[] = [];
  for (let i = 0; i < n; i++) {
    const id = ids && ids[i];
    const p = id ? P[id] : undefined;
    out.push(p && (!skatersOnly || isSkater(p)) && !p.injury ? p : null);
  }
  return out;
}

export function lineAttack(ids: (string | null)[] | undefined, P: Record<string, Player>) {
  return mean(fill(ids, 3, P).map((p) => (p ? attackRating(p) : REPL)));
}
export function lineDefense(ids: (string | null)[] | undefined, P: Record<string, Player>) {
  return mean(fill(ids, 3, P).map((p) => (p ? defenseRating(p) : REPL)));
}
export function pairAttack(ids: (string | null)[] | undefined, P: Record<string, Player>) {
  return mean(fill(ids, 2, P).map((p) => (p ? attackRating(p) : REPL)));
}
export function pairDefense(ids: (string | null)[] | undefined, P: Record<string, Player>) {
  return mean(fill(ids, 2, P).map((p) => (p ? defenseRating(p) : REPL)));
}
export function unitAttack(ids: (string | null)[] | undefined, n: number, P: Record<string, Player>) {
  return mean(fill(ids, n, P).map((p) => (p ? attackRating(p) : REPL)));
}
export function unitDefense(ids: (string | null)[] | undefined, n: number, P: Record<string, Player>) {
  return mean(fill(ids, n, P).map((p) => (p ? defenseRating(p) : REPL)));
}

export function goalieSavePct(ovr: number): number {
  return 0.925 + (ovr - 75) * 0.0016;
}

export function overallColor(v: number): string {
  if (v >= 85) return '#F2B544';
  if (v >= 80) return '#E5323E';
  if (v >= 75) return '#8FD8F0';
  if (v >= 70) return '#B9C7DA';
  return '#7F8FA6';
}

export function overallTier(v: number): string {
  if (v >= 85) return 'Звезда';
  if (v >= 80) return 'Лидер';
  if (v >= 75) return ' Top-4';
  if (v >= 70) return 'Основной';
  return 'Рольевой';
}

export function fairSalary(ovr: number): number {
  return Math.round(Math.pow(Math.max(1, ovr - 50), 2) * 0.045) * 1_000_000;
}

export function salaryDemand(ovr: number, age: number, potential: number): number {
  let f = 1;
  if (age <= 23) f = potential > ovr ? 1.15 : 1.0;
  else if (age <= 29) f = 1.05;
  else if (age <= 32) f = 0.9;
  else if (age <= 35) f = 0.7;
  else f = 0.5;
  return Math.round(fairSalary(ovr) * f / 500_000) * 500_000 || 500_000;
}

export function formatMoney(v: number): string {
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (a >= 1_000_000_000) return `${sign}${(a / 1_000_000_000).toFixed(2).replace('.', ',')} млрд ₽`;
  if (a >= 1_000_000) return `${sign}${(a / 1_000_000).toFixed(1).replace('.', ',')} млн ₽`;
  if (a >= 1_000) return `${sign}${Math.round(a / 1_000)} тыс. ₽`;
  return `${sign}${a} ₽`;
}

export function payroll(team: string[], P: Record<string, Player>): number {
  return team.reduce((s, id) => s + (P[id]?.contract.salary ?? 0), 0);
}
