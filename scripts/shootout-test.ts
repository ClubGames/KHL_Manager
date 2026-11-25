// KHL shootout rules, the manager's shooter order, and the match report of simulated games (goal events kept for
// replays, also through a save).  npx tsx scripts/shootout-test.ts
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { GameSim } from '../src/game/engine';
import * as G from '../src/game/state';
import { compactState } from '../src/game/saves';
import { goalEventFor } from '../src/game/live';
import type { GameEvent, GameState } from '../src/types';

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));

const attemptsOf = (ev: GameEvent[]) => ev.filter((e) => e.type === 'so_goal' || e.type === 'so_miss');
let n = 0, att = 0, goals = 0, early = 0, sudden = 0, bad: string[] = [];
let orderOk = true;
for (let i = 0; n < 400 && i < 6000; i++) {
  const h = r.teams[i % r.teams.length], a = r.teams[(i * 5 + 1) % r.teams.length];
  if (h === a) continue;
  const sim = new GameSim({ id: h.id, lineup: h.lineup }, { id: a.id, lineup: a.lineup }, r.players);
  const pickH = sim.shootoutCandidates(0).slice(-3).reverse(); // the three weakest shooters, to see the order is obeyed
  sim.soOrder[0] = pickH;
  const res = sim.runAll();
  if (!res.so) continue;
  n++;
  const ev = attemptsOf(res.events);
  att += ev.length;
  goals += ev.filter((e) => e.type === 'so_goal').length;
  const so: [number, number] = [0, 0];
  const taken: [number, number] = [0, 0];
  // Replay the rules on the log.
  ev.forEach((e, k) => {
    const ti = e.team === h.id ? 0 : 1;
    if (e.round !== Math.floor(k / 2) + 1) bad.push(`round ${e.round} at ${k}`);
    if ((k % 2 === 0) !== (ti === 0)) bad.push('order of teams');
    if (k > 0 && e.round! <= 3) {
      // nobody shoots after the result was already certain
      const decided = so[0] > so[1] + (3 - taken[1]) || so[1] > so[0] + (3 - taken[0]);
      if (decided) bad.push(`attempt after decided ${so} ${taken}`);
    }
    if (e.round! > 3 && k % 2 === 0 && so[0] !== so[1]) bad.push('sudden death round after a winner');
    if (e.type === 'so_goal') so[ti]++;
    taken[ti]++;
    if (!e.so || e.so[0] !== so[0] || e.so[1] !== so[1]) bad.push('tally on the event');
  });
  if (so[0] === so[1]) bad.push('shootout ended level');
  const winner = res.homeScore > res.awayScore ? 0 : 1;
  if ((so[0] > so[1] ? 0 : 1) !== winner) bad.push('winner does not match the shootout');
  if (ev.length < 6) early++;
  if (ev.some((e) => (e.round ?? 0) > 3)) sudden++;
  const homeFirst3 = ev.filter((e) => e.team === h.id && e.round! <= 3).map((e) => e.player);
  if (homeFirst3.some((id, k) => id !== pickH[k])) orderOk = false;
  const firstThree = new Set(ev.filter((e) => e.team === a.id && e.round! <= 3).map((e) => e.player));
  if (firstThree.size !== ev.filter((e) => e.team === a.id && e.round! <= 3).length) bad.push('repeat shooter in the first three rounds');
}
check('shootouts follow the KHL format (3 rounds, early end, sudden death pairs, never level)', bad.length === 0, bad.slice(0, 4).join('; '));
check('some shootouts end early and some go to sudden death', early > n * 0.15 && sudden > n * 0.15, `${n} shootouts: early ${early}, sudden death ${sudden}`);
check('shootout conversion is realistic (25–36%)', goals / att > 0.25 && goals / att < 0.36, `${((goals / att) * 100).toFixed(1)}%`);
check("the manager's first three shooters shoot in the chosen order", orderOk);

/* ---------- simulated games of the manager keep a report ---------- */
G.store.set(G.createGameState(r, 'ska'));
let tries = 0;
let found: { id: number } | null = null;
while (tries++ < 12) {
  G.simulateToNextUserGame(false);
  G.simulateDay(true);
  const s = G.store.get()!;
  const g = s.schedule.flat().filter((x) => x.played && (x.home === 'ska' || x.away === 'ska')).pop();
  if (g?.result && g.result.scorers.length) found ??= g;
}
const s = G.store.get()!;
const userGames = s.schedule.flat().filter((x) => x.played && (x.home === 'ska' || x.away === 'ska'));
const withGoals = userGames.filter((g) => g.result!.scorers.length);
check("simulated games of the manager have a goal event for every goal (3D replay)", withGoals.length > 0 && withGoals.every((g) => g.result!.scorers.every((sc) => goalEventFor(g.result!.events, sc)?.ice)), `${withGoals.length} games`);
const other = s.schedule.flat().find((x) => x.played && x.home !== 'ska' && x.away !== 'ska');
check('other clubs keep no play-by-play beyond their shootout attempts', !!other && s.schedule.flat().filter((x) => x.played && x.home !== 'ska' && x.away !== 'ska').every((g) => g.result!.events.every((e) => e.type === 'so_goal' || e.type === 'so_miss' || (e.type === 'period_end' && !!e.so))));
const otherSO = s.schedule.flat().filter((x) => x.played && x.home !== 'ska' && x.away !== 'ska' && x.result!.so);
check("other clubs' shootouts are recorded attempt by attempt", otherSO.length > 0 && otherSO.every((g) => { const a = g.result!.events.filter((e) => e.type === 'so_goal' || e.type === 'so_miss'); const last = g.result!.periodScores[g.result!.periodScores.length - 1]; return a.length >= 2 && a.filter((e) => e.type === 'so_goal' && e.team === g.home).length === last[0] && a.filter((e) => e.type === 'so_goal' && e.team === g.away).length === last[1]; }), `${otherSO.length} games`);
const saved = JSON.parse(JSON.stringify(compactState(s))) as GameState;
const sg = saved.schedule.flat().filter((x) => x.played && (x.home === 'ska' || x.away === 'ska'));
const savedOtherSO = saved.schedule.flat().filter((x) => x.played && x.home !== 'ska' && x.away !== 'ska' && x.result!.so);
check("a save keeps other clubs' shootout attempts", savedOtherSO.length > 0 && savedOtherSO.every((g) => g.result!.events.length >= 2 && g.result!.events.every((e) => e.type === 'so_goal' || e.type === 'so_miss')));
check('a save keeps only goal and shootout events of the manager’s games, with the replay geometry', sg.every((g) => g.result!.events.every((e) => ['goal', 'so_goal', 'so_miss'].includes(e.type))) && sg.filter((g) => g.result!.scorers.length).every((g) => g.result!.scorers.every((sc) => { const e = goalEventFor(g.result!.events, sc); return !!e && !!e.ice && e.x !== undefined; })));
const size = JSON.stringify(saved).length, bare = JSON.stringify({ ...saved, schedule: saved.schedule.map((d) => d.map((g) => (g.result ? { ...g, result: { ...g.result, events: [] } } : g))) }).length;
check('kept events add little to the save', size - bare < 4000 * Math.max(1, sg.length), `${((size - bare) / 1024).toFixed(1)} KB for ${sg.length} games`);

console.log(failed ? `${failed} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
