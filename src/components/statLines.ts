import type { Player } from '../types';

/**
 * The numbers the broadcast puts under a close-up: a skater's or a goalie's season (games, goals + assists, points,
 * plus/minus; wins, save percentage, goals against average) and, at a goal, what the scorer has done in this match.
 * Pure: the tests run it in Node.
 */
export function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/** The season so far (`extra`: this match's goals / assists not yet in the season's totals). */
export function seasonLine(p: Player | undefined, extra: { goals?: number; assists?: number } = {}): string | undefined {
  const s = p?.stats;
  if (!p || !s) return undefined;
  const isGoalie = p.position === 'G';
  if (isGoalie) {
    if (!s.gp) return 'Сезон: первая игра';
    const sv = s.shotsAgainst > 0 ? (s.saves / s.shotsAgainst * 100).toFixed(1).replace('.', ',') : '—';
    const gaa = s.minutes > 0 ? ((s.shotsAgainst - s.saves) * 60 / s.minutes).toFixed(2).replace('.', ',') : '—';
    return `Сезон: ${s.gp} ${plural(s.gp, 'игра', 'игры', 'игр')} · ${s.wins} ${plural(s.wins, 'победа', 'победы', 'побед')} · ${sv}% · КН ${gaa}${s.shutouts ? ` · ${s.shutouts} «${plural(s.shutouts, 'сухарь', 'сухаря', 'сухарей')}»` : ''}`;
  }
  const g = s.goals + (extra.goals ?? 0), a = s.assists + (extra.assists ?? 0), gp = s.gp + (extra.goals !== undefined || extra.assists !== undefined ? 1 : 0); // a goal: this match counts
  if (!gp) return 'Сезон: первая игра';
  return `Сезон: ${gp} ${plural(gp, 'игра', 'игры', 'игр')} · ${g}+${a}=${g + a} · ${signed(s.plusMinus)}`;
}

/** At a goal: the scorer's match (this goal included) and his season with it. */
export function goalLines(p: Player | undefined, matchGoals: number): string[] {
  if (!p) return [];
  const n = Math.max(1, matchGoals);
  const match = n >= 3 ? `В матче: ${n} ${plural(n, 'гол', 'гола', 'голов')} — хет-трик!` : n === 2 ? 'В матче: 2 гола — дубль!' : 'В матче: 1 гол';
  const season = seasonLine(p, { goals: n });
  const s = p.stats;
  const nth = s ? s.goals + n : n;
  return [match, ...(season ? [season] : []), ...(s ? [`${nth}-й гол в сезоне`] : [])];
}
