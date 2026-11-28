// Shootouts played on the ice (PlayRink kind 'so') and their rules (game/shootout.ts), the books of a played series
// (GameSim.applyShootout), and the goal mouth: a shot the model scores always crosses the line (the cage used to bounce
// a puck that ended a frame a few centimetres short of it).
// Run: npx tsx scripts/play-shootout-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { PlayRink, type PlayOut } from '../src/game/playRink';
import { GameSim } from '../src/game/engine';
import { soNext, soShooter, soTally, type SoAttempt } from '../src/game/shootout';
import type { Team } from '../src/types';

const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
const P = r.players, T = r.teams;
let pass = 0;
const test = (name: string, fn: () => void) => { const t = Date.now(); fn(); pass++; console.log('✓', name, `(${((Date.now() - t) / 1000).toFixed(1)} s)`); };
const pair = (g: number): [Team, Team] => { const H = T[g % T.length]; let A = T[(g * 5 + 3) % T.length]; if (A.id === H.id) A = T[(g + 1) % T.length]; return [H, A]; };
const fw = (t: Team) => t.lineup.F.flat().filter(Boolean) as string[];
const att = (s: string) => s.split(' ').map((x) => ({ side: (x[0] === 'h' ? 0 : 1) as 0 | 1, goal: x[1] === '+' }));

test('the KHL order: three rounds stopped once decided, then pairs until a round is won', () => {
  assert.deepEqual(soNext([]), { side: 0, round: 1 });
  assert.deepEqual(soNext(att('h+')), { side: 1, round: 1 });
  // 2:0 after two rounds — the away side cannot catch up with one shot left
  assert.equal(soNext(att('h+ a- h+ a-')), null);
  // 1:0 after five attempts: away's last shot can still level it
  assert.deepEqual(soNext(att('h+ a- h- a- h-')), { side: 1, round: 3 });
  // home 2 of 3 and away 0 of 2: done before away's third
  assert.equal(soNext(att('h+ a- h+ a- h-')), null);
  // level after three: sudden death, the second shooter always answers
  const lvl = 'h+ a+ h- a- h- a-';
  assert.deepEqual(soNext(att(lvl)), { side: 0, round: 4 });
  assert.deepEqual(soNext(att(lvl + ' h+')), { side: 1, round: 4 });
  assert.equal(soNext(att(lvl + ' h+ a-')), null);
  assert.deepEqual(soNext(att(lvl + ' h+ a+')), { side: 0, round: 5 });
  // the away side first
  assert.deepEqual(soNext([], 1), { side: 1, round: 1 });
  assert.deepEqual(soTally(att('h+ a+ h+')), [2, 1]);
  // three different men, then the list comes round again
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => soShooter(['a', 'b', 'c', 'd'], n)), ['a', 'b', 'c', 'd', 'a']);
});

test('a series played on the ice: the AI ends every one, about three attempts in ten go in, every goal counted', () => {
  let n = 0, goals = 0, outs = 0;
  for (let g = 0; g < 24; g++) {
    const [H, A] = pair(g);
    const k = new PlayRink({ home: H, away: A, players: P, lineups: [H.lineup, A.lineup], userSide: null, kind: 'so', periodMinutes: 20, seed: 4100 + g, so: { order: [fw(H), fw(A)] } });
    const out: PlayOut[] = [];
    for (let i = 0; i < 60 * 60 * 8 && !k.ended; i++) { k.advance(1 / 60); out.push(...k.drain()); }
    assert.ok(k.ended, `series ${g} ended`);
    const a = k.soAttempts;
    assert.equal(soNext(a), null, 'decided');
    const t = soTally(a);
    assert.notEqual(t[0], t[1]);
    // the series' own count: the game's score is not touched, the events match the attempts
    assert.deepEqual(k.score, [0, 0]);
    const so = out.filter((o): o is Extract<PlayOut, { type: 'soAttempt' }> => o.type === 'soAttempt');
    assert.equal(so.length, a.length);
    assert.deepEqual(so[so.length - 1].so, t);
    // the three regular rounds by three different shooters of each side
    for (const s of [0, 1]) {
      const first = a.filter((x) => x.side === s && x.round <= 3).map((x) => x.shooter);
      assert.equal(new Set(first).size, first.length, 'different shooters');
    }
    assert.equal(k.goalsFor.length, a.filter((x) => x.goal).length, 'every goal into the net is a goal of the series');
    n += a.length; goals += a.filter((x) => x.goal).length; outs += out.filter((o) => o.type === 'shot' || o.type === 'penalty').length;
  }
  assert.equal(outs, 0, 'no shots or penalties for the books of the game');
  const pct = goals / n;
  console.log(`   ${n} attempts, ${(pct * 100).toFixed(1)} % scored`);
  assert.ok(pct > 0.2 && pct < 0.42, `scoring ${pct.toFixed(3)}`);
});

test('the manager shoots only his own attempts: control only of his shooter, nobody of his on the ice for the other side\'s', () => {
  const [H, A] = pair(3);
  const k = new PlayRink({ home: H, away: A, players: P, lineups: [H.lineup, A.lineup], userSide: 1, kind: 'so', periodMinutes: 20, seed: 77, so: { order: [fw(H), fw(A)] } });
  let mine = 0, theirs = 0;
  for (let i = 0; i < 60 * 60 * 6 && !k.ended; i++) {
    k.advance(1 / 60);
    const live = k.shootout?.live;
    if (!live) continue;
    const h = k.hud();
    if (live.side === 1) { mine++; assert.equal(h.ctl, live.shooter, 'he skates the shooter'); }
    else { theirs++; assert.equal(h.ctl, null, 'no man of his to control'); }
    const ice = k.ice();
    assert.deepEqual([ice[0].filter(Boolean).length + ice[1].filter(Boolean).length], [1], 'one skater on the ice');
  }
  assert.ok(mine > 0 && theirs > 0);
});

test('the books: applyShootout writes the series as the engine does — events, the winner\'s goal, the period line', () => {
  const [H, A] = pair(5);
  const sim = new GameSim({ id: H.id, lineup: H.lineup, name: H.name }, { id: A.id, lineup: A.lineup, name: A.name }, P, false, null);
  sim.status = 'so'; sim.period = 4;
  const o = sim.soOrders();
  assert.equal(o[0].length, sim.shootoutCandidates(0).length);
  const played: SoAttempt[] = [
    { side: 0, shooter: o[0][0], goalie: null, goal: true, round: 1 }, { side: 1, shooter: o[1][0], goalie: null, goal: false, round: 1 },
    { side: 0, shooter: o[0][1], goalie: null, goal: false, round: 2 }, { side: 1, shooter: o[1][1], goalie: null, goal: true, round: 2 },
    { side: 0, shooter: o[0][2], goalie: null, goal: false, round: 3 }, { side: 1, shooter: o[1][2], goalie: null, goal: false, round: 3 },
    { side: 0, shooter: o[0][3], goalie: null, goal: false, round: 4 }, { side: 1, shooter: o[1][3], goalie: null, goal: true, round: 4 },
  ];
  const evs = sim.applyShootout(played);
  assert.equal(sim.status, 'done');
  assert.ok(sim.hadSO);
  assert.deepEqual(sim.score, [0, 1]);
  assert.equal(evs.filter((e) => e.type === 'so_goal' || e.type === 'so_miss').length, 8);
  assert.deepEqual(evs.find((e) => e.type === 'period_end')?.so, [1, 2]);
  assert.deepEqual(sim.periodScores[sim.periodScores.length - 1], [1, 2]);
  assert.equal(sim.result().homeScore + sim.result().awayScore, 1);

  // left unfinished (the series simulated from the pause): the engine takes the rest
  const sim2 = new GameSim({ id: H.id, lineup: H.lineup, name: H.name }, { id: A.id, lineup: A.lineup, name: A.name }, P, false, null);
  sim2.status = 'so'; sim2.period = 4;
  const evs2 = sim2.applyShootout(played.slice(0, 2));
  assert.equal(sim2.status, 'done');
  const at = evs2.filter((e) => e.type === 'so_goal' || e.type === 'so_miss');
  assert.ok(at.length >= 3 && at[0].type === 'so_goal');
  assert.equal(sim2.score[0] + sim2.score[1], 1);
});

test('the goal mouth is open: every shot the model scores crosses the line (none bounced off the cage)', () => {
  let scored = 0, counted = 0;
  for (let g = 0; g < 4; g++) {
    const [H, A] = pair(g + 10);
    const k = new PlayRink({ home: H, away: A, players: P, lineups: [H.lineup, A.lineup], userSide: null, kind: 'reg', periodMinutes: 20, seed: 900 + g });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (k as any).puck;
    let last: unknown = null;
    for (let i = 0; i < 60 * 60 * 40 && !k.ended; i++) {
      k.advance(1 / 60);
      if (p.shot && p.shot !== last && p.shot.outcome === 'goal') { last = p.shot; scored++; }
      counted += k.drain().filter((o) => o.type === 'shot' && o.outcome === 'goal').length;
    }
  }
  console.log(`   ${scored} scoring shots, ${counted} goals`);
  assert.ok(scored > 3);
  assert.equal(counted, scored);
});

console.log(`${pass} played shootout tests passed`);
