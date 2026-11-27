// The played match, PR 62: hybrid icing (the race to the end-zone dots and its exceptions), the puck sliding on
// after the whistle, the goalie's freeze (the puck in his glove / covered under him, not floating), and the rest of
// the NHL 26 controls — puck protection, board play, vision control with the puck, the dump-in and the flip, the
// kick, one-touch dekes, cancelling a pass, the dive, the stick sweep, fights and goal celebrations.
// Run: npx tsx scripts/play-nhl26-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { GameSim, type PlayedRecord } from '../src/game/engine';
import { NO_PAD, PlayRink, type PadState } from '../src/game/playRink';
import { emptyTouch, gamepadPad, keyboardPad, KEYS, PAD } from '../src/components/playInput';
import type { Team } from '../src/types';

const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
const P = r.players, teams = r.teams;
let pass = 0;
const test = (name: string, fn: () => void) => { const t = Date.now(); fn(); pass++; console.log('✓', name, `(${((Date.now() - t) / 1000).toFixed(1)} s)`); };
/* eslint-disable @typescript-eslint/no-explicit-any */
const priv = (k: PlayRink) => k as any;
const pair = (g: number): [Team, Team] => { const H = teams[g % teams.length]; let A = teams[(g * 5 + 3) % teams.length]; if (A.id === H.id) A = teams[(g + 1) % teams.length]; return [H, A]; };
const make = (g: number, userSide: 0 | null = 0) => { const [H, A] = pair(g); return new PlayRink({ home: H, away: A, players: P, lineups: [H.lineup, A.lineup], userSide, kind: 'reg', periodMinutes: 20, seed: 6200 + g, autoSwitch: false }); };
function toPlay(k: PlayRink) { for (let i = 0; i < 600 && k.mode !== 'play'; i++) k.advance(1 / 60); for (let i = 0; i < 30; i++) k.advance(1 / 60); }
const pad = (x: Partial<PadState> = {}): PadState => ({ ...NO_PAD, nhl: true, ...x });
const steps = (k: PlayRink, n: number, p: PadState | ((i: number) => PadState)) => { for (let i = 0; i < n; i++) priv(k).step(typeof p === 'function' ? p(i) : p); };
const frameOf = (k: PlayRink, id: string) => k.frameAt(k.tau).skaters.find(s => s.id === id)!;

/** Everybody but `keep` parked out of the way (and held there by `pin`). */
function park(k: PlayRink, keep: any[]) {
  const spots = new Map<any, { x: number; y: number }>();
  let i = 0;
  for (const a of priv(k).onIce()) if (!keep.includes(a) && !a.goalie) { spots.set(a, { x: a.side ? 36 + (i % 3) : 14 + (i % 3), y: a.side ? 27 - (i % 2) : 3 + (i % 2) }); i++; }
  return spots;
}
function pin(spots: Map<any, { x: number; y: number }>) { for (const [a, s] of spots) { a.x = s.x; a.y = s.y; a.vx = 0; a.vy = 0; a.act = null; a.tx = s.x; a.ty = s.y; } }

/** The manager's skater with the puck at centre ice, nobody near. */
function withPuck(g: number, at = { x: 30, y: 15 }) {
  const k = make(g), p = priv(k);
  toPlay(k); p.mode = 'play';
  const me = p.skaters(0).find((a: any) => !a.kindD) ?? p.skaters(0)[0];
  p.ctl = me.id;
  const spots = park(k, [me]); pin(spots);
  Object.assign(me, { ...at, vx: 0, vy: 0, fa: -Math.PI / 2, act: null, cool: 0, stun: 0 });
  p.puck.carrier = me; p.puck.dead = false; p.puck.shot = null; p.puck.passTo = null;
  p.prevPad = NO_PAD; p.ss.rest = p.tau;
  return { k, p, me, spots };
}
/** The manager's skater close to the other team's carrier. */
function onDefence(g: number) {
  const k = make(g), p = priv(k);
  toPlay(k); p.mode = 'play';
  const me = p.skaters(0).find((a: any) => a.kindD) ?? p.skaters(0)[0], c = p.skaters(1, false)[0];
  p.ctl = me.id;
  const spots = park(k, [me, c]); pin(spots);
  Object.assign(me, { x: 30, y: 15, vx: 0, vy: 0, fa: 0, act: null, cool: 0, stun: 0 });
  Object.assign(c, { x: 31.3, y: 15, vx: 0, vy: 0, fa: Math.PI, act: null, cool: 9e9, stun: 0 });
  p.puck.carrier = c; p.puck.dead = false; p.puck.shot = null; p.puck.passTo = null;
  p.prevPad = NO_PAD;
  return { k, p, me, c, spots };
}

/* ---------------- hybrid icing ---------------- */

/** Home (side 0) clears the puck from x = 20 into the far corner; `setup` places the race, everything else stays parked. */
function icing(g: number, setup: (p: any, spots: Map<any, { x: number; y: number }>) => void) {
  const k = make(g, null), p = priv(k);
  toPlay(k); p.mode = 'play';
  const a = p.skaters(0, false)[0];
  const spots = park(k, [a]);
  spots.set(a, { x: 20, y: 22 });
  setup(p, spots); pin(spots);
  const g1 = p.goalieOf(1);
  Object.assign(a, { x: 20, y: 15, vx: 0, vy: 0, act: null });
  p.puck.carrier = a; p.puck.dead = false; p.puck.shot = null; p.puck.passTo = null; p.puck.x = 20.5; p.puck.y = 15;
  k.drain();
  p.slide(a, { x: 58, y: 4 }, 24, 0);
  spots.set(a, { x: 20, y: 22 });
  const out: any[] = [];
  for (let i = 0; i < 60 * 5 && k.mode === 'play'; i++) {
    pin(spots);
    if (g1 && !spots.has(g1)) { g1.x = 55.2; g1.y = 15; g1.vx = 0; g1.vy = 0; }
    p.step(NO_PAD); out.push(...k.drain());
  }
  return { k, p, out };
}

test('hybrid icing: a defender ahead in the race to the dots — icing as the puck crosses the goal line, the faceoff in the icing team\'s end', () => {
  const { k, p, out } = icing(1, (q, spots) => { const d = q.skaters(1, false)[0]; spots.set(d, { x: 53, y: 26 }); });
  assert.equal(k.mode, 'stop'); assert.equal(p.stopInfo.reason, 'icing');
  assert.ok(out.some(o => o.type === 'icing' && o.side === 0), 'icing called on the home team');
  assert.ok(p.stopInfo.dot.x < 15, `the faceoff at the home end (${p.stopInfo.dot.x})`);
});

test('hybrid icing: an attacker first to the dots — no icing (waved off, and told why)', () => {
  const { out, p } = icing(2, (q, spots) => { const a2 = q.skaters(0, false)[1]; spots.set(a2, { x: 51, y: 26 }); });
  assert.ok(out.some(o => o.type === 'waived' && o.side === 0 && /первым/.test(o.text)), 'waved: the attacker won the race');
  assert.ok(!out.some(o => o.type === 'icing'));
  void p;
});

test('hybrid icing: the goalie out of his crease for it, or a defender who could have played it — no icing', () => {
  const g = icing(3, (q, spots) => { const gk = q.goalieOf(1); spots.set(gk, { x: 50, y: 20 }); spots.set(q.skaters(1, false)[0], { x: 53, y: 26 }); });
  assert.ok(g.out.some(o => o.type === 'waived' && /вратарь/.test(o.text)), 'the goalie came out: waved');
  assert.ok(!g.out.some(o => o.type === 'icing'));
  const d = icing(4, (q, spots) => { spots.set(q.skaters(1, false)[1], { x: 39, y: 10.2 }); spots.set(q.skaters(1, false)[0], { x: 53, y: 26 }); });
  assert.ok(d.out.some(o => o.type === 'waived' && /мог сыграть|сыграл шайбу/.test(o.text)), 'a defender in its path: waved');
  assert.ok(!d.out.some(o => o.type === 'icing'));
});

test('hybrid icing: short-handed it is no icing; a puck stopping short of the goal line neither', () => {
  const { out } = icing(5, (q, spots) => {
    const m = q.skaters(0, false)[2]; m.on = 'box'; m.boxUntil = q.clock + 120; m.boxMin = 2; spots.delete(m);
    spots.set(q.skaters(1, false)[0], { x: 53, y: 26 });
  });
  assert.ok(!out.some(o => o.type === 'icing'), 'short-handed: no icing');
  const k = make(6, null), p = priv(k);
  toPlay(k); p.mode = 'play';
  const a = p.skaters(0, false)[0], spots = park(k, [a]); pin(spots);
  Object.assign(a, { x: 20, y: 15, vx: 0, vy: 0 }); p.puck.carrier = a; p.puck.dead = false; p.puck.x = 20.5; p.puck.y = 15;
  p.slide(a, { x: 46, y: 20 }, 9, 0);
  assert.equal(p.puck.icing, 0, 'icing pending as it leaves');
  let called = false;
  for (let i = 0; i < 60 * 6 && k.mode === 'play'; i++) { pin(spots); p.step(NO_PAD); if (k.drain().some((o: any) => o.type === 'icing')) called = true; }
  assert.equal(called, false);
});

/* ---------------- after the whistle ---------------- */

test('the whistle does not freeze the puck: it slides on (slowing, off the boards) until it stops', () => {
  const k = make(7, null), p = priv(k);
  toPlay(k); p.mode = 'play';
  Object.assign(p.puck, { carrier: null, x: 30, y: 15, vx: 12, vy: 3, h: 0, vh: 0, shot: null, passTo: null });
  p.startStop('offside', { x: 40, y: 22 }, 3);
  const x0 = p.puck.x, v0 = Math.hypot(p.puck.vx, p.puck.vy);
  steps(k, 30, NO_PAD);
  assert.equal(k.mode, 'stop');
  assert.ok(p.puck.x > x0 + 3, `it moved on (${x0.toFixed(1)} → ${p.puck.x.toFixed(1)})`);
  const v1 = Math.hypot(p.puck.vx, p.puck.vy);
  assert.ok(v1 < v0 && v1 > 0, `slowing (${v0.toFixed(1)} → ${v1.toFixed(1)} m/s)`);
  steps(k, 60 * 1.5, NO_PAD);
  assert.ok(p.puck.x <= 60 && p.puck.x >= 0 && p.puck.y >= 0 && p.puck.y <= 30, 'stays in the rink');
});

test('the goalie\'s freeze: a high puck held in the glove at his chest, a low one covered under him — the frame shows it, the puck goes with him', () => {
  const k = make(8), p = priv(k);
  toPlay(k); p.mode = 'play';
  const g = p.goalieOf(1), a = p.skaters(0, false)[0];
  Object.assign(a, { x: 48, y: 15, vx: 0, vy: 0, fa: 0, act: null });
  p.puck.carrier = a; p.puck.dead = false;
  p.shoot(a, 0.8, 0.3, { x: 1, y: 0 }, 'wrist');
  const shot = p.puck.shot;
  assert.ok(shot, 'a shot');
  p.puck.h = 0.9;
  const rand = p.rand; p.rand = () => 0.01;
  p.save(g, shot);
  p.rand = rand;
  assert.equal(k.mode, 'stop'); assert.equal(p.held?.kind, 'glove');
  steps(k, 20, NO_PAD);
  const f = frameOf(k, g.id);
  assert.equal(f.move, 'glove', 'the goalie\'s frame: the glove hold');
  assert.ok(Math.hypot(p.puck.x - g.x, p.puck.y - g.y) < 0.6 && p.puck.h > 0.7, `the puck at his glove (h ${p.puck.h.toFixed(2)})`);
  assert.ok(Math.abs(p.puck.vx) + Math.abs(p.puck.vy) === 0);
  // covered: an attacker near, a slow puck at his pads
  const k2 = make(9), q = priv(k2);
  toPlay(k2); q.mode = 'play';
  const g2 = q.goalieOf(0), b = q.skaters(1, false)[0];
  Object.assign(b, { x: g2.x + 1.5, y: g2.y, vx: 0, vy: 0 });
  q.puck.carrier = null; q.puck.dead = false;
  q.goalieStop(g2, 4);
  assert.equal(q.held?.kind, 'cover');
  steps(k2, 20, NO_PAD);
  assert.equal(frameOf(k2, g2.id).move, 'cover');
  assert.ok(q.puck.h < 0.1 && Math.hypot(q.puck.x - g2.x, q.puck.y - g2.y) < 0.6, 'the puck under him on the ice');
  // gone at the faceoff
  for (let i = 0; i < 600 && k2.mode === 'stop'; i++) q.step(NO_PAD);
  assert.equal(q.held, null);
});

/* ---------------- the NHL 26 controls ---------------- */

test('✕ held with the puck protects it (stance, slower, much harder to poke); △ held on the boards — board play', () => {
  const { k, p, me } = withPuck(10);
  steps(k, 12, pad({ lift: true, mx: 0.6 }));
  assert.equal(me.protect, true); assert.equal(frameOf(k, me.id).stance, 'protect');
  assert.equal(p.puck.carrier, me, 'he keeps it');
  // board play
  Object.assign(me, { x: 30, y: 1.2, vx: 0, vy: 0, act: null });
  steps(k, 12, pad({ pin: true }));
  assert.equal(me.boardPlay, true); assert.equal(frameOf(k, me.id).stance, 'board');
  steps(k, 2, pad({}));
  assert.equal(me.boardPlay, false, 'let go: over');
});

test('L2 held with the puck keeps his facing while he skates any way; a quick tap is a spin-o-rama', () => {
  const { k, me } = withPuck(11);
  steps(k, 40, pad({ vision: true, mx: 1 }));
  assert.ok(me.vx > 2, 'he skates to the right');
  assert.ok(Math.abs(me.fa + Math.PI / 2) < 0.25, `still facing up (${me.fa.toFixed(2)})`);
  steps(k, 3, pad({}));
  Object.assign(me, { act: null, cool: 0 });
  steps(k, 4, pad({ vision: true })); steps(k, 1, pad({}));
  assert.equal(me.act?.k === 'deke' && me.act.kind, 'spin', 'a tap: the spin-o-rama');
});

test('R1 + the right stick up (or the shot): a dump-in to the corner; R1 held a while first — a flip over the sticks', () => {
  const a = withPuck(12, { x: 33, y: 15 });
  steps(a.k, 2, pad({ poke: true }));
  steps(a.k, 2, pad({ poke: true, sx: 0, sy: -1 }));
  assert.equal(a.p.puck.carrier, null, 'it is gone');
  assert.ok(a.p.puck.vx > 8, 'into the zone');
  assert.equal(a.p.puck.icing, null, 'from the attacking half: no icing pending');
  const b = withPuck(13, { x: 26, y: 15 });
  steps(b.k, 36, pad({ poke: true, mx: 1 }));
  steps(b.k, 1, pad({ poke: true, mx: 1, shoot: true }));
  assert.equal(b.p.puck.carrier, null);
  assert.ok(b.p.puck.vh > 3 && b.p.puck.saucer, 'lobbed up');
  let top = 0; for (let i = 0; i < 60; i++) { b.p.step(NO_PAD); top = Math.max(top, b.p.puck.h); }
  assert.ok(top > 1.6, `over the sticks (${top.toFixed(2)} m)`);
});

test('R3 kicks the puck off the skate and he gathers it on his stick; L1 + a flick of the left stick — a one-touch deke; L1 calls off a loading pass', () => {
  const { k, p, me } = withPuck(14);
  Object.assign(me, { vx: 0, vy: -4 });
  steps(k, 1, pad({ my: -1, r3: true }));
  assert.equal(p.puck.carrier, null); assert.equal(me.act?.k, 'kick');
  assert.equal(frameOf(k, me.id).move, 'kick');
  let back = false; for (let i = 0; i < 60 && !back; i++) { p.step(pad({ my: -1 })); back = p.puck.carrier === me; }
  assert.ok(back, 'back on his stick');
  // one-touch deke
  Object.assign(me, { act: null, cool: 0 });
  steps(k, 3, pad({ lb: true }));
  steps(k, 1, pad({ lb: true, mx: 1 }));
  assert.equal(me.act?.k, 'deke', 'L1 + a flick: a deke');
  // the pass called off
  steps(k, 40, pad({}));
  Object.assign(me, { act: null, cool: 0 }); p.puck.carrier = me;
  steps(k, 4, pad({ pass: true }));
  assert.equal(me.act?.k, 'windup');
  steps(k, 1, pad({ pass: true, lb: true }));
  steps(k, 2, pad({ lb: true }));
  assert.equal(p.puck.carrier, me, 'he keeps the puck');
  assert.ok(p.plays.some((x: any) => /пас отменён/.test(x.text)));
});

test('defence: L1 + R1 a dive (a wide body down on the ice); R1 held a stick sweep along the ice', () => {
  const d = onDefence(15);
  steps(d.k, 1, pad({ lb: true, poke: true }));
  assert.ok(d.me.diveUntil > d.p.tau, 'down in a dive');
  steps(d.k, 3, pad({ lb: true, poke: true }));
  assert.equal(frameOf(d.k, d.me.id).move, 'dive');
  const s = onDefence(16);
  Object.assign(s.c, { x: 33.5 });
  steps(s.k, 40, (i) => { Object.assign(s.c, { x: 33.5, y: 15, vx: 0, vy: 0 }); return pad({ poke: true }); });
  assert.equal(s.me.act?.k, 'sweep', 'sweeping');
  assert.equal(frameOf(s.k, s.me.id).stance, 'sweep');
  steps(s.k, 2, pad({}));
  assert.notEqual(s.me.act?.k, 'sweep', 'let go: over');
});

test('a fight (△ twice, or its own key): the whistle, the two square off, five minutes each — and the teams stay at full strength', () => {
  const k = make(17), p = priv(k);
  toPlay(k); p.mode = 'play';
  const me = p.skaters(0, false)[0], o = p.skaters(1, false)[0];
  p.ctl = me.id;
  Object.assign(me, { x: 30, y: 15, vx: 0, vy: 0, stun: 0 }); Object.assign(o, { x: 31.5, y: 15, vx: 0, vy: 0, stun: 0 });
  const rand = p.rand; p.rand = () => 0.1;
  steps(k, 1, pad({ pin: true })); steps(k, 2, pad({})); steps(k, 1, pad({ pin: true }));
  p.rand = rand;
  assert.equal(k.mode, 'stop', 'the whistle');
  assert.ok(p.fightOn, 'a fight under way');
  steps(k, 60, NO_PAD);
  assert.equal(frameOf(k, me.id).move === 'fight' || frameOf(k, o.id).move === 'fight', true, 'the frame shows it');
  const outs: any[] = [];
  for (let i = 0; i < 60 * 10 && k.mode === 'stop'; i++) { p.step(NO_PAD); outs.push(...k.drain()); }
  assert.equal(outs.filter(x => x.type === 'penalty' && x.min === 5 && x.coin).length, 2, 'two coincidental majors');
  assert.equal(me.on, 'box'); assert.equal(o.on, 'box');
  assert.equal(me.boxMin, 5); assert.equal(o.boxMin, 5);
  assert.equal(p.manpower(0), 5); assert.equal(p.manpower(1), 5);
  // the season sim books them as coincidental: penalty minutes, no power play, the next period starts 5 on 5
  const [H, A] = pair(17), sim = new GameSim(H, A, P);
  sim.beginPlayed('reg');
  for (const id of [me.id, o.id]) sim.recordPlayed(p.clock, { type: 'penalty', side: id === me.id ? 0 : 1, player: id, min: 5, reason: 'драка', coin: true });
  assert.deepEqual(sim.men(), [5, 5], 'the sim: full strength');
  const box = sim.playedBox();
  assert.equal(box[0][0]?.[2], true, 'carried over as coincidental');
  // served: to the bench, not back onto the ice
  for (let i = 0; i < 60 * 20 && k.mode !== 'play'; i++) p.step(NO_PAD);
  assert.equal(p.skaters(0, false).length, 5, 'five skaters a side on the ice after the fight');
  assert.equal(p.skaters(1, false).length, 5);
  me.boxUntil = p.clock; o.boxUntil = p.clock;
  for (let i = 0; i < 10; i++) p.step(NO_PAD);
  assert.equal(me.on, 'bench'); assert.equal(o.on, 'bench');
});

test('goal celebrations: after his team\'s goal the buttons pick the scorer\'s celebration (R3 adds fist pumps on top of riding the stick)', () => {
  const k = make(18), p = priv(k);
  toPlay(k); p.mode = 'play';
  const me = p.skaters(0, false)[0];
  p.ctl = me.id; p.puck.last = me; p.puck.carrier = null; p.puck.shot = null;
  p.goal(0, { x: 57, y: 15, h: 0.2 });
  assert.equal(k.hud().context, 'celebrate');
  steps(k, 2, NO_PAD); steps(k, 1, pad({ lift: true }));
  assert.equal(frameOf(k, me.id).move, 'cel1');
  steps(k, 2, NO_PAD); steps(k, 1, pad({ vision: true }));
  assert.equal(frameOf(k, me.id).move, 'celStick');
  steps(k, 2, NO_PAD); steps(k, 1, pad({ r3: true }));
  assert.equal(frameOf(k, me.id).move, 'celStickPump');
  assert.equal(k.celebrating(0), true);
});

test('the bindings: R3, ○ and □ on the pad (B no longer shoots); R3, the fight, ○ and □ on the keyboard and the touch screen', () => {
  const btns = (...on: number[]) => Array.from({ length: 17 }, (_, j) => ({ pressed: on.includes(j), value: on.includes(j) ? 1 : 0 }));
  const gp = (...on: number[]) => gamepadPad([{ axes: [0, 0, 0, 0], buttons: btns(...on) }]).pad;
  assert.equal(gp(PAD.R3).r3, true); assert.equal(gp(PAD.B).o, true); assert.equal(gp(PAD.X).sq, true); assert.equal(gp(PAD.B).shoot, false);
  for (const a of ['r3', 'fight', 'o', 'sq'] as const) {
    assert.ok(KEYS[a].length, `a key for ${a}`);
    assert.equal(keyboardPad(new Set([KEYS[a][0]]))[a], true);
  }
  const t = emptyTouch();
  assert.equal(t.r3 || t.fight || t.o || t.sq, false);
  const all = Object.values(KEYS).flat();
  assert.equal(new Set(all).size, all.length, 'every key does one thing');
});

console.log(`\n${pass} PR 62 NHL 26 tests passed`);
