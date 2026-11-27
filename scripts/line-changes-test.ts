// Line changes in the played match: at a whistle the forwards and the defence each go to their freshest line / pair
// (single tired men for a fresh one off the bench; the team that iced the puck stays out), on the fly a tired line
// goes only when it is safe, the forwards and the defencemen never change at the same time, and one man out of
// breath can go off on his own for the freshest man of his kind.
// Run: npx tsx scripts/line-changes-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { PlayRink } from '../src/game/playRink';

const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
const P = r.players, teams = r.teams;
let pass = 0;
const test = (name: string, fn: () => void) => { const t = Date.now(); fn(); pass++; console.log('✓', name, `(${((Date.now() - t) / 1000).toFixed(1)} s)`); };
/* eslint-disable @typescript-eslint/no-explicit-any */
const priv = (k: PlayRink) => k as any;
const byId = (id: string) => teams.find(t => t.id === id)!;
const H = byId('ska'), A = byId('avangard');
const make = (seed = 77) => new PlayRink({ home: H, away: A, players: P, lineups: [H.lineup, A.lineup], userSide: null, kind: 'reg', periodMinutes: 20, seed });
function toPlay(k: PlayRink) { for (let i = 0; i < 600 && k.mode !== 'play'; i++) k.advance(1 / 60); for (let i = 0; i < 30; i++) k.advance(1 / 60); }
const Lu = H.lineup;
const energy = (k: PlayRink, ids: (string | null)[], e: number) => { for (const id of ids) if (id) { const a = priv(k).agents.get(id); if (a) a.energy = e; } };
const onIce = (k: PlayRink, s: 0 | 1) => priv(k).skaters(s).map((a: any) => a.id).sort();
const ids = (xs: (string | null)[]) => xs.filter((x): x is string => !!x).sort();
const whistle = (k: PlayRink, icing: 0 | 1 | null = null) => priv(k).setupFaceoff({ x: 30, y: 15 }, icing, false);
const check = (k: PlayRink) => { priv(k).changeCheck = 0; priv(k).changes(); };

test('a whistle: tired forwards go to the freshest line, fresh defencemen stay; the team that iced it cannot change', () => {
  const k = make(), p = priv(k);
  toPlay(k);
  assert.deepEqual(onIce(k, 0), ids([...Lu.F[0], ...Lu.D[0]]), 'the first line and pair start');
  energy(k, Lu.F[0], 0.6); energy(k, Lu.F[1], 0.7); energy(k, Lu.F[2], 1); energy(k, Lu.F[3], 0.95);
  energy(k, Lu.D[0], 0.95); energy(k, Lu.D[1], 1); energy(k, Lu.D[2], 1);
  // iced it: nobody changes
  whistle(k, 0);
  assert.deepEqual(onIce(k, 0), ids([...Lu.F[0], ...Lu.D[0]]), 'the icing team stays out');
  whistle(k);
  assert.equal(p.lineIdx[0], 2, 'the freshest line (not simply the next one)');
  assert.deepEqual(onIce(k, 0), ids([...Lu.F[2], ...Lu.D[0]]), 'line 3 with the same pair');
});

test('a whistle: one man out of breath in a line that stays goes for the freshest forward on the bench', () => {
  const k = make(78), p = priv(k);
  toPlay(k);
  // the other lines no fresher than this one: it stays
  for (const g of [...Lu.F, ...Lu.D]) energy(k, g, 0.7);
  energy(k, Lu.F[0], 1); energy(k, Lu.D[0], 0.9);
  const worn = Lu.F[0][1]!;
  energy(k, [worn], 0.3);
  energy(k, [Lu.F[1][0]], 1);
  whistle(k);
  assert.equal(p.lineIdx[0], 0, 'the line stays');
  const now = onIce(k, 0);
  assert.ok(!now.includes(worn), 'the tired man is off');
  assert.ok(now.includes(Lu.F[1][0]!), 'the freshest forward from the bench took his place');
  assert.ok(Lu.F[0].filter(x => x !== worn).every(x => now.includes(x!)), 'his linemates stay');
  assert.ok(Lu.D[0].every(x => now.includes(x!)), 'the pair stays');
});

test('on the fly: never while the other team comes at them; forwards and defencemen not together', () => {
  const k = make(79), p = priv(k);
  toPlay(k); p.mode = 'play';
  energy(k, Lu.F[0], 0.4); energy(k, Lu.D[0], 0.42);
  const opp = p.skaters(1)[0], mine = p.skaters(0).find((a: any) => !a.kindD);
  // the other team carries it into our end: nobody goes
  p.puck.carrier = opp; Object.assign(opp, { x: 15, y: 15 }); Object.assign(p.puck, { x: 15, y: 15 });
  check(k);
  assert.ok(!p.skaters(0).some((a: any) => a.leaving), 'no change with the puck coming at them');
  // our puck, out past centre ice: the forwards go first, the defence stays
  p.puck.carrier = mine; Object.assign(mine, { x: 36, y: 15 }); Object.assign(p.puck, { x: 36, y: 15 });
  check(k);
  const leaving = () => p.skaters(0).filter((a: any) => a.leaving);
  assert.ok(leaving().length >= 2 && leaving().every((a: any) => !a.kindD), `forwards change (${leaving().map((a: any) => a.id)})`);
  // the forwards are off and on again: a moment later the defence is still out
  for (const a of leaving()) p.swapAtBench(a);
  check(k);
  assert.equal(leaving().length, 0, 'the defence does not go right after the forwards');
  p.changedAt[0].F = k.tau - 6;
  p.puck.carrier = p.skaters(0).find((a: any) => !a.kindD); Object.assign(p.puck.carrier, { x: 40, y: 15 }); Object.assign(p.puck, { x: 40, y: 15 });
  check(k);
  assert.ok(leaving().length >= 1 && leaving().every((a: any) => a.kindD), 'then the defencemen');
  // a defence change needs the puck past centre ice
  const k2 = make(80), p2 = priv(k2);
  toPlay(k2); p2.mode = 'play';
  energy(k2, Lu.D[0], 0.4);
  const m2 = p2.skaters(0).find((a: any) => !a.kindD);
  p2.puck.carrier = m2; Object.assign(m2, { x: 27, y: 15 }); Object.assign(p2.puck, { x: 27, y: 15 });
  check(k2);
  assert.ok(!p2.skaters(0).some((a: any) => a.leaving), 'defencemen stay with the puck short of centre');
});

test('on the fly: a single tired man goes off alone and the freshest forward comes on for him', () => {
  const k = make(81), p = priv(k);
  toPlay(k); p.mode = 'play';
  for (const g of [...Lu.F, ...Lu.D]) energy(k, g, 0.85);
  const worn = p.agents.get(Lu.F[0][2]!);
  worn.energy = 0.25;
  const fresh = p.agents.get(Lu.F[2][1]!);
  fresh.energy = 1;
  const mine = p.skaters(0).find((a: any) => a !== worn && !a.kindD);
  p.puck.carrier = mine; Object.assign(mine, { x: 40, y: 15 }); Object.assign(p.puck, { x: 40, y: 15 });
  check(k);
  assert.deepEqual(p.skaters(0).filter((a: any) => a.leaving).map((a: any) => a.id), [worn.id], 'only the tired man goes');
  p.swapAtBench(worn);
  assert.ok(onIce(k, 0).includes(fresh.id), 'the freshest forward came on');
  assert.equal(onIce(k, 0).length, 5);
});

test('a whole period: changes keep the men out there fresher, never the forwards and the defence in the same moment', () => {
  const k = make(82), p = priv(k);
  const last: Record<string, number> = {}, was = new Set<string>();
  let both = 0, changes = 0, low = 0, samples = 0;
  for (let i = 0; i < 60 * 1300 && !k.ended; i++) {
    k.advance(1 / 60); k.drain();
    if (p.manpower(0) !== p.manpower(1)) continue;
    for (const a of p.agents.values() as Iterable<any>) {
      if (a.goalie) continue;
      if (a.on === 'ice' && i % 60 === 0) { samples++; if (a.energy < 0.1) low++; }
      if (a.leaving && !was.has(a.id)) {
        was.add(a.id); changes++;
        const other = `${a.side}${a.kindD ? 'F' : 'D'}`;
        if (k.tau - (last[other] ?? -9) < 1.5) both++;
        last[`${a.side}${a.kindD ? 'D' : 'F'}`] = k.tau;
      }
      if (!a.leaving) was.delete(a.id);
    }
  }
  console.log(`   ${changes} men changed on the fly, F and D together ${both}, out of breath ${(low / samples * 100).toFixed(1)}% of the time`);
  assert.ok(changes > 40, 'they do change');
  assert.ok(both <= 2, 'forwards and defence change apart');
  assert.ok(low / samples < 0.03, 'nobody stays out until he is spent');
});

console.log(`\n${pass} line-change tests passed`);
