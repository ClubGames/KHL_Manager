// Season-level calibration report (compare with real KHL: ~2.6 goals and ~30 shots per team per game, save% ~.920, power play ~20%).
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { createGameState, store, simulateDay, rankAll } from '../src/game/state';
const r = parseRosterText(readFileSync('public/roster.json', 'utf8'));
store.set(createGameState(r, 'ska'));
const t0 = Date.now();
while (store.get()!.phase === 'season') simulateDay(true);
const s = store.get()!;
let g = 0, sh = 0, ppg = 0, ppc = 0, pim = 0, n = 0, ot = 0, so = 0, hw = 0, en = 0, shg = 0;
for (const d of s.schedule) for (const x of d) { const q = x.result; if (!q || x.kind !== 'regular') continue; n++; g += q.homeScore + q.awayScore - (q.so ? 1 : 0); sh += q.homeStats.shots + q.awayStats.shots; ppg += q.homeStats.ppGoals + q.awayStats.ppGoals; ppc += q.homeStats.ppChances + q.awayStats.ppChances; pim += q.homeStats.pim + q.awayStats.pim; if (q.so) so++; else if (q.ot) ot++; if (q.homeScore > q.awayScore) hw++; for (const sc of q.scorers) { if (sc.strength === 'EN') en++; if (sc.strength === 'SH') shg++; } }
const all = rankAll(s);
const sk = Object.values(s.players).filter((p) => p.teamId && p.position !== 'G').sort((a, b) => b.stats.goals + b.stats.assists - (a.stats.goals + a.stats.assists));
console.log(`${n} games in ${Date.now() - t0} ms`);
console.log(`goals/team/game ${(g / n / 2).toFixed(2)} | shots ${(sh / n / 2).toFixed(1)} | save% ${(100 * (1 - (g - en) / (sh))).toFixed(1)} | PP ${(100 * ppg / ppc).toFixed(1)}% on ${(ppc / n / 2).toFixed(2)} chances | PIM/team ${(pim / n / 2).toFixed(1)} | OT ${(100 * ot / n).toFixed(1)}% SO ${(100 * so / n).toFixed(1)}% | home win ${(100 * hw / n).toFixed(1)}% | PP share of goals ${(100 * ppg / g).toFixed(0)}% | SH goals/100 games ${(100 * shg / n).toFixed(0)} | EN ${(100 * en / n).toFixed(0)}`);
console.log(`points: first ${all[0].record.points}, 8th-in-conf approx ${all[15].record.points}, last ${all[all.length - 1].record.points} | top scorer ${sk[0].stats.goals}+${sk[0].stats.assists} in ${sk[0].stats.gp}`);
process.exit(0);
