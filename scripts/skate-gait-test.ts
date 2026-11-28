// How a skater skates, read from his motion (src/components/skateGait.ts): an explosive start, a hard stop, crossovers,
// backwards, a shuffle, one hand off the stick at top speed — and nothing of it while he does something else.
// Run: npx tsx scripts/skate-gait-test.ts
import assert from 'node:assert/strict';
import { newGait, stepGait, strideRate, styleOf, type Kinematics } from '../src/components/skateGait';
import { steer } from '../src/game/skating';

let pass = 0;
const test = (name: string, fn: () => void) => { fn(); pass++; console.log('✓', name); };
const K = (k: Partial<Kinematics>): Kinematics => ({ speed: 0, prevSpeed: 0, fwd: 0, lat: 0, turn: 0, carrier: false, busy: false, ...k });
/** Runs `sec` seconds of a motion given as speed(t) and the rest of the kinematics. */
function run(sec: number, speed: (t: number) => number, k: Partial<Kinematics> = {}) {
  const g = newGait(); const dt = 1 / 30;
  for (let t = 0; t < sec; t += dt) { const v = speed(t); stepGait(g, K({ speed: v, prevSpeed: speed(Math.max(0, t - .1)), fwd: v, ...k }), dt); }
  return g;
}

test('a start from a standstill: an explosive burst, gone once he is up to speed', () => {
  const g = run(0.5, t => Math.min(7.5, t * 6.5));
  assert.ok(g.burst > 0.6, `burst ${g.burst}`);
  assert.ok(strideRate(g) > 1.8, 'short, quick strides');
  const up = run(3, t => Math.min(7.5, t * 6.5));
  assert.ok(up.burst < 0.15, `over at speed: ${up.burst}`);
});
test('a hard stop: the hips across, held a moment, no strides; over once stopped', () => {
  const g = run(0.5, t => Math.max(0, 8 - t * 14));
  assert.ok(g.stop > 0.8, `stop ${g.stop}`);
  assert.ok(strideRate(g) < 0.4);
  const after = run(1.6, t => Math.max(0, 8 - t * 14));
  assert.ok(after.stop < 0.2, `over: ${after.stop}`);
});
test('turning at speed: crossovers toward the turn; at top speed straight: one hand off the stick (not with the puck)', () => {
  assert.ok(run(1, () => 6, { turn: 1.4 }).cross > 0.6);
  assert.ok(run(1, () => 6, { turn: -1.4 }).cross < -0.6);
  assert.ok(run(1, () => 1.5, { turn: 1.4 }).cross < 0.1, 'not when slow');
  assert.ok(run(2, () => 7.8).oneHand > 0.7);
  assert.ok(run(2, () => 7.8, { carrier: true }).oneHand < 0.05, 'both hands on it with the puck');
});
test('backwards and the shuffle from the motion in his own frame; nothing while busy', () => {
  assert.ok(run(1, () => 4, { fwd: -4 }).back > 0.7);
  assert.ok(run(1, () => 2, { fwd: 0.2, lat: 2 }).shuffle > 0.6);
  assert.ok(run(1, () => 2, { fwd: 0.2, lat: -2 }).shuffle < -0.6);
  const busy = run(0.5, t => Math.max(0, 8 - t * 14), { busy: true });
  assert.ok(busy.stop < 0.05 && busy.burst < 0.05);
});
test('every man his own style: the same for the same man, not the same for all', () => {
  assert.deepEqual(styleOf('ska-c01'), styleOf('ska-c01'));
  const ws = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map(x => styleOf('ska-' + x).wide.toFixed(2)));
  assert.ok(ws.size > 3);
});
/** Skates `sec` s from velocity (vx, 0) wanting (wx, wy) with acceleration 5.5 m/s²; returns the end state. */
function skate(vx: number, wx: number, wy: number, sec: number) {
  let x = 0, y = 0, v = { x: vx, y: 0 }, stops = 0;
  for (let t = 0; t < sec; t += 1 / 60) { const s = steer(v.x, v.y, wx, wy, 1 / 60, { acc: 5.5 }); v = { x: v.x + s.dvx, y: v.y + s.dvy }; x += v.x / 60; y += v.y / 60; if (s.stop) stops++; }
  return { x, y, v, speed: Math.hypot(v.x, v.y), stops };
}
test('skates, not wheels: no right angle at speed (an arc that keeps his speed), a hard stop to go back, a quick start', () => {
  const arc = skate(8, 0, 8, 0.4);
  assert.ok(Math.atan2(arc.v.y, arc.v.x) < 1.2, `still turning after 0.4 s: ${Math.atan2(arc.v.y, arc.v.x).toFixed(2)} rad`);
  assert.ok(arc.speed > 7.2, `kept his speed through the arc: ${arc.speed.toFixed(2)}`);
  assert.ok(arc.x > 2, 'carried on the way he was going');
  const back = skate(8, -8, 0, 1.0);
  assert.ok(back.stops > 20, 'a hard stop');
  assert.ok(Math.abs(back.y) < 0.05, 'straight, not a U-turn arc');
  const halt = skate(8, -8, 0, 0.45);
  assert.ok(halt.speed < 3.5, `the stop bites: ${halt.speed.toFixed(2)}`);
  const go = skate(0, 8, 0, 0.5), cruise = skate(5, 8, 0, 0.5);
  assert.ok(go.speed > 3.2, `explosive start: ${go.speed.toFixed(2)}`);
  assert.ok(go.speed - 0 > (cruise.speed - 5) * 1.15, 'the first pushes are the hardest');
});
console.log(`\n${pass} skate gait tests passed`);
