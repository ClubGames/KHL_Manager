// Penalty rules (IIHF / KHL): every penalty has its own clock — two at once make it 5-on-3, a third waits for a free
// slot, a power-play goal frees one minor (a double minor in its first half restarts as two minutes), majors are
// served in full. Also: the live scoreboard and the rink follow the same numbers.
// Run: npx tsx scripts/penalty-test.ts
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { GameSim, type Pen } from '../src/game/engine';
import { applyEvent, emptyLive, manpower } from '../src/game/live';
import { autoLineup } from '../src/game/ai';
import type { GameEvent } from '../src/types';

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
for (const t of r.teams) t.lineup = autoLineup(t.players, r.players);
const H = r.teams[0], A = r.teams[1];
const mk = () => new GameSim({ id: H.id, lineup: H.lineup, name: H.name }, { id: A.id, lineup: A.lineup, name: A.name }, r.players);
// private helpers of the engine, reached for the rule checks
type Priv = { sec: number; pens: [Pen[], Pen[]]; men(t?: number): [number, number]; penSlot(i: 0 | 1): number; releaseOnPPGoal(o: 0 | 1): void };
const add = (s: Priv, i: 0 | 1, at: number, min: number, player = `p${at}`) => {
  s.sec = at;
  s.pens[i] = s.pens[i].filter((x) => x.end > at);
  const start = s.penSlot(i);
  s.pens[i].push({ player, min, start, end: start + min * 60 });
};
const men = (s: Priv, t: number) => s.men(t).join('x');

/* ---------- the rules, case by case ---------- */
{
  const s = mk() as unknown as Priv;
  add(s, 0, 100, 2);
  add(s, 0, 130, 2);
  check('two penalties at once: 3 on 5', men(s, 140) === '3x5', men(s, 140));
  check('the first one ends: back to 4 on 5', men(s, 225) === '4x5', men(s, 225));
  check('both served: full strength', men(s, 255) === '5x5', men(s, 255));
}
{
  const s = mk() as unknown as Priv;
  add(s, 0, 100, 2); add(s, 0, 130, 2); add(s, 0, 150, 2);
  const third = s.pens[0][2];
  check('a third penalty waits until one of the two ends', third.start === 220 && third.end === 340, `${third.start}–${third.end}`);
  check('…so the team stays at three, never two', men(s, 160) === '3x5' && men(s, 230) === '3x5', `${men(s, 160)}, ${men(s, 230)}`);
  check('…then 4 on 5 until the third is served', men(s, 260) === '4x5' && men(s, 345) === '5x5', `${men(s, 260)}, ${men(s, 345)}`);
}
{
  const s = mk() as unknown as Priv;
  add(s, 0, 100, 2); add(s, 0, 130, 2); add(s, 0, 150, 2);
  s.sec = 160; s.releaseOnPPGoal(0);
  check('a power-play goal frees one minor (the one ending first)', s.pens[0].length === 2 && !s.pens[0].some((x) => x.player === 'p100'), s.pens[0].map((x) => x.player).join(','));
  const third = s.pens[0].find((x) => x.player === 'p150')!;
  check('…and the waiting penalty starts at once', third.start === 160 && third.end === 280 && men(s, 170) === '3x5', `${third.start}–${third.end}, ${men(s, 170)}`);
}
{
  const s = mk() as unknown as Priv;
  add(s, 1, 100, 4);
  s.sec = 150; s.releaseOnPPGoal(1);
  const d = s.pens[1][0];
  check('double minor, goal in its first half: two fresh minutes remain', d.end === 270, `${d.end}`);
  s.sec = 200; s.releaseOnPPGoal(1);
  check('…second goal ends it', s.pens[1].length === 0);
  add(s, 1, 400, 5);
  s.sec = 420; s.releaseOnPPGoal(1);
  check('a major is served in full', s.pens[1].length === 1 && s.pens[1][0].end === 700);
  add(s, 0, 430, 2);
  check('4 on 4, then a 4-on-3 after another penalty', men(s, 440) === '4x4', men(s, 440));
  add(s, 1, 450, 2);
  check('…two against one: 4 on 3', men(s, 455) === '4x3', men(s, 455));
}

/* ---------- full matches (at least 300, and until 10 hours of 5-on-3 for a stable rate): what really happens ---------- */
let games = 0, pens = 0, fiveThree = 0, threeOnFiveShots = 0, threeOnFiveBadIce = 0, ppGoals = 0, ppChances = 0, below3 = 0, mpWrong = 0, mpChecked = 0;
let fiveThreeGoals = 0, fiveThreeSec = 0, ppSec = 0, ppGoals54 = 0, liveBad = 0, waited = 0;
for (let n = 0; n < 3000 && (n < 300 || fiveThreeSec < 36000); n++) {
  const sim = mk();
  const live = emptyLive();
  let guard = 0;
  const all: GameEvent[] = [];
  while (sim.status !== 'done' && guard++ < 20) {
    const evs = sim.status === 'ot' ? sim.simOT() : sim.status === 'so' ? sim.simShootout() : sim.simPeriod();
    all.push(...evs);
  }
  games++;
  for (const e of all) {
    // what the scoreboard said right before the event
    const mp = manpower(live, e.sec);
    if ((e.type === 'shot' || e.type === 'goal' || e.type === 'miss') && e.ice && e.period <= 3 && e.strength !== 'EN') {
      mpChecked++;
      const n0 = e.ice[0].filter(Boolean).length, n1 = e.ice[1].filter(Boolean).length;
      if (n0 !== mp.men[0] || n1 !== mp.men[1]) mpWrong++;
      const ti = e.team === H.id ? 0 : 1;
      if (Math.min(mp.men[0], mp.men[1]) === 3 && Math.max(mp.men[0], mp.men[1]) === 5) {
        threeOnFiveShots++;
        const short = mp.men[0] === 3 ? 0 : 1;
        if (e.ice[short].filter(Boolean).length !== 3) threeOnFiveBadIce++;
        if (e.type === 'goal' && ti !== short) fiveThreeGoals++;
      } else if (e.type === 'goal' && e.strength === 'PP') ppGoals54++;
    }
    if (e.type === 'penalty') {
      pens++;
      if (e.text.includes('начнётся, когда')) waited++;
      if (e.pp) ppChances++;
    }
    if (e.type === 'goal' && e.strength === 'PP') ppGoals++;
    applyEvent(live, e, H.id);
    const after = manpower(live, e.sec);
    if (after.men[0] < 3 || after.men[1] < 3) below3++;
    if (after.state !== null && after.remaining <= 0) liveBad++;
  }
  // manpower time on the clock
  for (let t = 0; t < 3600; t += 5) {
    const box = (all.filter((e) => e.sec <= t && e.box).pop()?.box) ?? [[], []];
    const m = [0, 1].map((i) => 5 - Math.min(2, box[i].filter(([a, b]) => a <= t && t < b).length));
    if (Math.abs(m[0] - m[1]) === 2) { fiveThreeSec += 5; fiveThree += 5 / 120; }
    else if (m[0] !== m[1]) ppSec += 5;
  }
}
const pp = ppGoals / Math.max(1, ppChances);
console.log(`  ${games} матчей: ${(pens / games).toFixed(1)} удалений за матч, большинство ${(100 * pp).toFixed(1)}%, 5×3 — ${(fiveThreeSec / games).toFixed(0)} с за матч, голов в 5×3: ${fiveThreeGoals} (за ${(fiveThreeSec / 60).toFixed(0)} мин), в 5×4/4×3: ${ppGoals54} (за ${(ppSec / 60).toFixed(0)} мин); «ждущих» удалений: ${waited}`);
check('5-on-3 happens in a season worth of games', fiveThreeSec > 0 && threeOnFiveShots > 0, `${(fiveThreeSec / 60).toFixed(0)} мин, ${threeOnFiveShots} бросков`);
check('three on five: only three skaters on the ice', threeOnFiveBadIce === 0, `${threeOnFiveBadIce} из ${threeOnFiveShots}`);
check('the scoreboard numbers equal the engine’s skaters on every shot', mpWrong === 0, `${mpWrong} из ${mpChecked}`);
check('never fewer than three skaters', below3 === 0);
check('the penalty clock never shows a finished penalty', liveBad === 0, `${liveBad}`);
check('power play stays KHL-like (15–27%)', pp > 0.15 && pp < 0.27, `${(100 * pp).toFixed(1)}%`);
const rate53 = fiveThreeGoals / Math.max(1, fiveThreeSec / 60), rate54 = ppGoals54 / Math.max(1, ppSec / 60);
check('5-on-3 is clearly more dangerous than 5-on-4', rate53 > rate54 * 1.25, `${rate53.toFixed(3)} vs ${rate54.toFixed(3)} гола/мин`);

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL PENALTY CHECKS PASSED');
process.exit(failed ? 1 : 0);
