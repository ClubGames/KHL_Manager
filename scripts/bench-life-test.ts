// PR 60: the bench comes to life — a timeout (30 s, both teams at their benches, the men get their breath back,
// the clock stands), men stepping onto the ice stand at the boards until they are out (no sliding off the bench),
// the unit on the ice in words for the HUD, the coaches' jointed rig, and the online menu that does not stop play.
// Run: npx tsx scripts/bench-life-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from 'three';
import { parseRosterText } from '../src/game/roster';
import { HOP_DOOR, HOP_FLY, PlayRink, TIMEOUT_SEC } from '../src/game/playRink';
import { CoachRig } from '../src/components/coachRig';

const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
const H = r.teams.find(t => t.id === 'ska')!, A = r.teams.find(t => t.id === 'avangard')!;
let pass = 0;
const test = (name: string, fn: () => void) => { const t = Date.now(); fn(); pass++; console.log('✓', name, `(${((Date.now() - t) / 1000).toFixed(1)} s)`); };
/* eslint-disable @typescript-eslint/no-explicit-any */
const priv = (k: PlayRink) => k as any;
const make = (o: Partial<ConstructorParameters<typeof PlayRink>[0]> = {}) => new PlayRink({ home: H, away: A, players: r.players, lineups: [H.lineup, A.lineup], userSide: 0, kind: 'reg', periodMinutes: 20, seed: 5, ...o });
const run = (k: PlayRink, sec: number, until?: () => boolean) => { for (let i = 0; i < sec * 60; i++) { k.advance(1 / 60); if (until?.()) return true; } return false; };

test('a timeout: called in play it waits for the whistle; both teams gather at their benches, rest 30 s, the clock stands', () => {
  const k = make();
  run(k, 10, () => k.mode === 'play');
  run(k, 1);
  assert.equal(k.callTimeout(0), 'next', 'in play: at the next whistle');
  assert.equal(k.callTimeout(0), null, 'only one');
  assert.ok(run(k, 200, () => k.mode === 'timeout'), 'it comes at a stoppage');
  const out = k.drain();
  assert.ok(out.some(o => o.type === 'timeout' && o.side === 0), 'the books hear of it');
  for (const a of priv(k).skaters(0)) a.energy = 0.4;
  const clock = k.clock, t0 = k.tau;
  run(k, 12);
  assert.equal(k.clock, clock, 'the clock stands');
  for (const s of [0, 1] as const) {
    const b = priv(k).bench[s];
    for (const a of priv(k).skaters(s)) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 4.5, `side ${s}: ${a.id} at his bench (${a.x.toFixed(1)}, ${a.y.toFixed(1)})`);
  }
  assert.ok(Math.abs(k.timeoutNow()!.left - (TIMEOUT_SEC - (k.tau - t0))) < .05, 'the seconds left');
  run(k, TIMEOUT_SEC, () => k.mode !== 'timeout');
  assert.equal(k.mode, 'faceoff', 'a faceoff after it (they skate back to the dot)');
  for (const a of priv(k).skaters(0)) assert.ok(a.energy > 0.75, `rested: ${a.energy.toFixed(2)}`);
  assert.deepEqual(k.timeoutLeft, [false, true]);
});

test('a timeout at a faceoff starts at once, and the manager may end it early; a carried-over timeout is respected', () => {
  const k = make();
  run(k, 10, () => k.mode === 'faceoff');
  assert.equal(k.callTimeout(0), 'now');
  run(k, 1);
  assert.equal(k.mode, 'timeout');
  k.endTimeout(); run(k, .1);
  assert.equal(k.mode, 'faceoff');
  const k2 = make({ timeouts: [false, true] });
  assert.equal(k2.callTimeout(0), null, 'taken in an earlier period');
});

test('the AI bench takes its timeout (not too often) when its dead-tired men are pinned after an icing', () => {
  const k0 = make({ userSide: null });
  run(k0, 10, () => k0.mode === 'play');
  for (const a of priv(k0).skaters(1)) a.energy = 0.35;
  priv(k0).startStop('icing', { x: 50, y: 7 }, 0.5, 1); run(k0, 2);
  assert.notEqual(k0.mode, 'timeout', 'not in the first half of the opening period');
  let k = k0;
  for (let seed = 1; seed < 12 && k.mode !== 'timeout'; seed++) {
    k = make({ userSide: null, period: 2, seed });
    run(k, 10, () => k.mode === 'play');
    for (const a of priv(k).skaters(1)) a.energy = 0.35;
    priv(k).startStop('icing', { x: 50, y: 7 }, 0.5, 1);
    run(k, 2);
  }
  assert.equal(k.mode, 'timeout');
  assert.equal(k.timeoutNow()?.side, 1);
});

test('stepping onto the ice: he stands at the boards (the frames say so) before he skates; not at the opening faceoff', () => {
  const k = make({ userSide: null });
  assert.ok(k.frameAt(0).skaters.every(s => !s.hop), 'the opening line-up is in place already');
  run(k, 10, () => k.mode === 'play');
  const s = 0 as const, b = priv(k).bench[s];
  const man = [...priv(k).agents.values()].find((a: any) => a.side === s && a.on === 'bench' && !a.goalie);
  priv(k).stepOn(man, b.x, b.y + 1, false);
  const x0 = man.x, y0 = man.y;
  run(k, HOP_FLY * 0.8);
  assert.ok(Math.hypot(man.x - x0, man.y - y0) < 0.01, 'still at the boards');
  const f = k.frameAt(k.lastTau).skaters.find(q => q.id === man.id)!;
  assert.ok(f.hop! > 0, `the frame carries the climb (${f.hop})`);
  run(k, HOP_FLY * 0.4 + 0.6);
  assert.equal(man.hopTo, undefined, 'out: he skates');
  assert.ok(HOP_DOOR > HOP_FLY, 'through the door takes longer than over the boards');
});

test('the unit on the ice in words: lines and pairs, special teams', () => {
  const k = make();
  run(k, 3);
  assert.equal(k.lineOn(0), '1-е звено · 1-я пара');
  priv(k).setGroup(0, 'F', 2); priv(k).setGroup(0, 'D', 1); priv(k).setUnit(0, true, false);
  assert.equal(k.lineOn(0), '3-е звено · 2-я пара');
  const pen = [...priv(k).agents.values()].find((a: any) => a.side === 1 && a.on === 'ice' && !a.goalie);
  pen.on = 'box'; pen.boxUntil = k.clock + 120;
  priv(k).setUnit(0, true, false); priv(k).setUnit(1, true, false);
  assert.match(k.lineOn(0), /бригада большинства|большинство/);
  assert.match(k.lineOn(1), /бригада меньшинства|меньшинство/);
});

test('the coach rig: the hands reach where the pose wants them (two-bone IK), the joints stay attached, rest() restores', () => {
  const root = new T.Group();
  const rig = new CoachRig(root, .05, 'clip', { suit: '#222', tie: '#a00', skin: '#e3b796', hair: '#333' }, (p, node) => p.build(node, (g, m, parent) => { const x = new T.Mesh(g, m); parent.add(x); return x; }, () => new T.MeshBasicMaterial()), 1);
  const parts = root.children as T.Group[];
  assert.ok(parts.length >= 8, `legs, body, two upper and two lower arms, the card (${parts.length})`);
  for (const mood of ['play', 'stop', 'goalFor', 'goalAgainst', 'timeout'] as const) for (const t of [0.3, 1.7, 4.2]) {
    rig.update({ t, dt: 1, puck: { x: 3, z: 8 }, mood, moodT: t, excite: .5, head: true });
    root.updateMatrixWorld(true);
    const [, , , up0, fo0, up1, fo1] = parts;
    for (const [up, fo] of [[up0, fo0], [up1, fo1]]) {
      const elbow = new T.Vector3(0, -.29, 0).applyMatrix4(up.matrix);
      assert.ok(elbow.distanceTo(fo.position) < 1e-3, `${mood}: the forearm hangs from the elbow`);
      assert.ok(fo.position.y > .5 && fo.position.y < 2.3, `${mood}: the elbow at a human height (${fo.position.y.toFixed(2)})`);
    }
  }
  rig.update({ t: 1, dt: .016, puck: { x: 0, z: 5 }, mood: 'play', moodT: 99, excite: 0, walk: { phase: 1, w: 1 } });
  rig.rest();
  assert.ok(Math.abs(parts[0].rotation.x) < 1e-6, 'standing again');
});

console.log(`\n${pass} bench-life tests passed`);
