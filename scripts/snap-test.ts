import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { GameSim } from '../src/game/engine';

const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
const h = r.teams[0], a = r.teams[1];
const res = new GameSim({ id: h.id, lineup: h.lineup }, { id: a.id, lineup: a.lineup }, r.players).runAll();
const evs = res.events;
const shotsOf = (e: any) => (e.snap ? e.snap.shots[0] + e.snap.shots[1] : null);
const first = evs.find((e) => e.snap);
const last = [...evs].reverse().find((e) => e.snap)!;
let mono = true, prev = -1;
for (const e of evs) { if (!e.snap) continue; const v = e.snap.shots[0] + e.snap.shots[1] + e.snap.pim[0] + e.snap.pim[1]; if (v < prev) mono = false; prev = v; }
console.log('events', evs.length, 'all have snap:', evs.every((e) => !!e.snap));
console.log('first snap shots', shotsOf(first), 'last snap shots', shotsOf(last), 'final', res.homeStats.shots + res.awayStats.shots);
console.log('monotonic:', mono);
const goalEvs = evs.filter((e) => e.type === 'goal');
if (goalEvs.length) {
  const g0 = goalEvs[0];
  const totalAfter = g0.snap!.shots[0] + g0.snap!.shots[1];
  const finalTotal = res.homeStats.shots + res.awayStats.shots;
  console.log('first goal at', g0.period, g0.time, 'shots so far', totalAfter, '<= final', finalTotal, totalAfter <= finalTotal);
  console.log('goal snapshot score', g0.snap!.score, 'matches event score', g0.score);
}
const pe = evs.filter((e) => e.type === 'period_end');
console.log('period_end score vs periodScores:', pe.map((e) => e.snap!.score.join('-')).join(' '), '|', res.periodScores.map((p) => p.join('-')).join(' '));

// chemistry: happy team vs unhappy team, identical rosters
function runWith(moraleHome: number, moraleAway: number, n = 900) {
  const P = JSON.parse(JSON.stringify(r.players));
  for (const id of h.players) P[id].morale = moraleHome;
  for (const id of a.players) P[id].morale = moraleAway;
  let gf = 0, ga = 0;
  for (let i = 0; i < n; i++) {
    const x = new GameSim({ id: h.id, lineup: h.lineup }, { id: a.id, lineup: a.lineup }, P).runAll();
    gf += x.homeScore; ga += x.awayScore;
  }
  return { gf: gf / n, ga: ga / n };
}
const flat = runWith(70, 70);
const happy = runWith(99, 45);
console.log('flat morale gf/ga', flat.gf.toFixed(3), flat.ga.toFixed(3), '| happy-vs-sad gf/ga', happy.gf.toFixed(3), happy.ga.toFixed(3));
