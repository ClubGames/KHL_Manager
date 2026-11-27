// The gamepad's NHL 25/26 scheme in a played match (playInput.ts → playRink.ts): the button map, RT pass (tap soft,
// hold harder, LB + RT saucer), RT held + right stick = stickhandling without dekes, LB + right stick special dekes,
// L3 hustle, defence on RB / A / Y / LB / LT and the right stick (push check up, shoulder check down-then-up),
// the d-pad line changes (forwards only / defence only) and the forecheck / breakout calls.
// Run: npx tsx scripts/play-nhl-pad-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { NO_PAD, PlayRink, type PadState } from '../src/game/playRink';
import { gamepadPad, keyboardPad, mergePads, PAD } from '../src/components/playInput';
import type { Team } from '../src/types';

const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
const P = r.players, teams = r.teams;
let pass = 0;
const test = (name: string, fn: () => void) => { const t = Date.now(); fn(); pass++; console.log('✓', name, `(${((Date.now() - t) / 1000).toFixed(1)} s)`); };
/* eslint-disable @typescript-eslint/no-explicit-any */
const priv = (k: PlayRink) => k as any;
const pair = (g: number): [Team, Team] => { const H = teams[g % teams.length]; let A = teams[(g * 5 + 3) % teams.length]; if (A.id === H.id) A = teams[(g + 1) % teams.length]; return [H, A]; };
const make = (g: number) => { const [H, A] = pair(g); return new PlayRink({ home: H, away: A, players: P, lineups: [H.lineup, A.lineup], userSide: 0, kind: 'reg', periodMinutes: 20, seed: 3000 + g, autoSwitch: false }); };
function toPlay(k: PlayRink) { for (let i = 0; i < 600 && k.mode !== 'play'; i++) k.advance(1 / 60); for (let i = 0; i < 30; i++) k.advance(1 / 60); }
function clear(k: PlayRink, keep: any[]) { for (const a of priv(k).onIce()) if (!keep.includes(a) && !a.goalie) { a.x = a.side ? 52 : 8; a.y = a.side ? 27 : 3; a.vx = 0; a.vy = 0; a.act = null; } }
const btns = (...on: number[]) => Array.from({ length: 17 }, (_, j) => ({ pressed: on.includes(j), value: on.includes(j) ? 1 : 0 }));
const gp = (axes: number[], ...on: number[]) => gamepadPad([{ axes, buttons: btns(...on) }]);
/** The pad as the gamepad would give it (nhl on) with these fields. */
const pad = (x: Partial<PadState> = {}): PadState => ({ ...NO_PAD, nhl: true, ...x });
const steps = (k: PlayRink, n: number, p: PadState | ((i: number) => PadState)) => { for (let i = 0; i < n; i++) priv(k).step(typeof p === 'function' ? p(i) : p); };

/** The manager's skater with the puck at centre ice, nobody near. */
function withPuck(g: number) {
  const k = make(g), p = priv(k);
  toPlay(k); p.mode = 'play';
  const me = p.skaters(0).find((a: any) => !a.kindD) ?? p.skaters(0)[0];
  p.ctl = me.id; clear(k, [me]);
  Object.assign(me, { x: 30, y: 15, vx: 0, vy: 0, fa: -Math.PI / 2, act: null, cool: 0, stun: 0 });
  p.puck.carrier = me; p.puck.dead = false; p.puck.shot = null; p.puck.passTo = null;
  p.prevPad = NO_PAD; p.ss.rest = p.tau;
  return { k, p, me };
}
/** The manager's skater a stick length from the carrier of the other team. */
function onDefence(g: number) {
  const k = make(g), p = priv(k);
  toPlay(k); p.mode = 'play';
  const me = p.skaters(0)[0], c = p.skaters(1).find((a: any) => !a.goalie);
  p.ctl = me.id; clear(k, [me, c]);
  Object.assign(c, { x: 30, y: 15, vx: 0, vy: 0, fa: Math.PI, act: null, cool: 9e9, stun: 0, decideAt: 9e9 });
  Object.assign(me, { x: 28.9, y: 15, vx: 0, vy: 0, fa: 0, act: null, cool: 0, stun: 0 });
  p.puck.carrier = c; p.puck.dead = false; p.puck.shot = null; p.puck.passTo = null;
  p.prevPad = NO_PAD; p.ss.rest = p.tau;
  return { k, p, me, c };
}

test('the button map: RT pass, B ○ / X □ (no shot button: the right stick shoots), R3, RB poke (and the draw), A lift, Y pin, LB, LT vision, L3 hustle; the d-pad does not skate', () => {
  assert.equal(gp([0, 0, 0, 0], PAD.RT).pad.pass, true);
  assert.equal(gp([0, 0, 0, 0], PAD.A).pad.pass, false, 'A is not the pass any more');
  assert.equal(gp([0, 0, 0, 0], PAD.B).pad.shoot, false, 'B is not a shot any more');
  assert.equal(gp([0, 0, 0, 0], PAD.B).pad.o, true);
  assert.equal(gp([0, 0, 0, 0], PAD.X).pad.sq, true);
  assert.equal(gp([0, 0, 0, 0], PAD.R3).pad.r3, true);
  assert.equal(gp([0, 0, 0, 0], PAD.RT).pad.shoot, false, 'RT is not a shot');
  const rb = gp([0, 0, 0, 0], PAD.RB).pad;
  assert.ok(rb.poke && rb.faceoff, 'RB: poke check, and the draw at a faceoff');
  assert.equal(gp([0, 0, 0, 0], PAD.A).pad.lift, true);
  assert.equal(gp([0, 0, 0, 0], PAD.Y).pad.pin, true);
  assert.equal(gp([0, 0, 0, 0], PAD.LB).pad.lb, true);
  assert.equal(gp([0, 0, 0, 0], PAD.LT).pad.vision, true);
  assert.equal(gp([0, 0, 0, 0], PAD.L3).pad.hustle, true);
  assert.equal(gp([0, 0, 0, 0], PAD.LB).pad.swap, false, 'LB does not switch');
  assert.equal(gp([0, 0, 0, 0], PAD.LT).pad.sprint, false, 'LT is not a sprint');
  assert.equal(gp([0, 0, 0.9, 0]).pad.faceoff, true, 'the right stick takes a draw');
  for (const d of [PAD.UP, PAD.DOWN, PAD.LEFT, PAD.RIGHT]) { const q = gp([0, 0, 0, 0], d).pad; assert.ok(q.mx === 0 && q.my === 0, 'the d-pad does not skate'); }
  assert.ok(gp([0, 0, 0, 0], PAD.RIGHT).commands.has('changeF'));
  assert.ok(gp([0, 0, 0, 0], PAD.LEFT).commands.has('changeD'));
  assert.ok(gp([0, 0, 0, 0], PAD.UP).commands.has('forecheck'));
  assert.ok(gp([0, 0, 0, 0], PAD.DOWN).commands.has('breakout'));
  assert.ok(gp([0, 0, 0, 0], PAD.START).commands.has('pause'));
  assert.ok(gp([0, 0, 0, 0], PAD.BACK).commands.has('pull'));
  // merged with the keyboard the NHL fields survive; the keyboard alone has none
  const m = mergePads(keyboardPad(new Set()), gp([0, 0, 0, 0], PAD.RB, PAD.LB).pad);
  assert.ok(m.nhl && m.poke && m.lb);
  assert.equal(mergePads(keyboardPad(new Set(['Space']))).nhl, undefined);
});

test('RT: a tap is a soft pass, a long hold a hard one; LB + RT a saucer pass', () => {
  const speed = (hold: number, lb = false) => {
    const { k, p } = withPuck(1);
    const mate = p.skaters(0).find((a: any) => a !== p.puck.carrier);
    Object.assign(mate, { x: 40, y: 15, vx: 0, vy: 0, stun: 0 });
    steps(k, hold, pad({ pass: true, mx: 1, lb }));
    steps(k, 1, pad({ mx: 1, lb }));
    return { v: Math.hypot(p.puck.vx, p.puck.vy), saucer: p.puck.saucer, to: p.puck.passTo };
  };
  const soft = speed(3), hard = speed(50), sau = speed(10, true);
  assert.ok(soft.to && hard.to, 'both passes go');
  assert.ok(hard.v > soft.v * 1.25, `held harder: ${soft.v.toFixed(1)} → ${hard.v.toFixed(1)} m/s`);
  assert.equal(soft.saucer, false);
  assert.equal(sau.saucer, true, 'LB + RT is a saucer pass');
});

test('RT held + right stick: stickhandling only — no deke, no shot; let go with the stick out: no pass', () => {
  const { k, p, me } = withPuck(2);
  let dekes = 0;
  // RT held, the right stick flicked hard from side to side and up — moves that would deke and shoot otherwise
  steps(k, 90, (i) => { const ph = Math.floor(i / 6) % 3; const sx = ph === 0 ? 1 : ph === 1 ? -1 : 0, sy = ph === 2 ? -1 : 0; if (me.act?.k === 'deke') dekes++; return pad({ pass: true, sx, sy }); });
  assert.equal(dekes, 0, 'no deke');
  assert.equal(p.puck.carrier, me, 'no shot, no pass: he still has it');
  assert.ok(p.handleSwing > 0, 'the side-to-side counts as quick stickhandling');
  steps(k, 1, pad({ sx: 1 }));
  assert.equal(p.puck.carrier, me, 'RT let go with the stick out: no pass');
  // without RT the same flick dekes
  const b = withPuck(2);
  let d2 = 0;
  steps(b.k, 30, (i) => { if (b.me.act?.k === 'deke') d2++; return pad({ sx: i < 4 ? 1 : 0 }); });
  assert.ok(d2 > 0, 'without RT a sideways flick is a deke');
});

test('LB + right stick: sideways a toe drag, back between the legs, up a shot fake', () => {
  const kindOf = (sx: number, sy: number) => {
    const { k, me } = withPuck(3);
    steps(k, 2, pad({ lb: true }));
    let kind: string | null = null;
    steps(k, 6, (i) => { if (me.act?.k === 'deke' && !kind) kind = me.act.kind; return pad({ lb: true, sx: i < 4 ? sx : 0, sy: i < 4 ? sy : 0 }); });
    return kind;
  };
  assert.equal(kindOf(1, 0), 'toe');
  assert.equal(kindOf(0, 1), 'between');
  assert.equal(kindOf(0, -1), 'fake');
});

test('L3 hustle: a click keeps the burst while he skates, letting go of the stick ends it', () => {
  const { k, me } = withPuck(4);
  steps(k, 1, pad({ mx: 1, hustle: true }));
  steps(k, 20, pad({ mx: 1 }));
  assert.equal(me.sprint, true, 'still bursting after the click');
  steps(k, 3, pad({}));
  steps(k, 3, pad({ mx: 1 }));
  assert.equal(me.sprint, false, 'the stick let go ends it');
});

test('defence: RB poke, A stick lift, Y board pin, right stick up a push check, down then up a shoulder check', () => {
  { const { k, me } = onDefence(5); steps(k, 1, pad({ poke: true })); assert.equal(me.act?.k, 'poke'); }
  { const { k, me } = onDefence(5); steps(k, 1, pad({ lift: true })); assert.ok(me.act?.k === 'poke' && me.act.lift, 'A: a stick lift even from the front'); }
  { const { k, me } = onDefence(5); steps(k, 1, pad({ pin: true })); assert.ok(me.act?.k === 'check' && me.act.kind === 'pin', 'Y: a board pin'); }
  { const { k, me } = onDefence(5); steps(k, 3, pad({ sy: -1 })); assert.ok(me.act?.k === 'check' && me.act.light, 'right stick up: a push check'); }
  { const { k, me } = onDefence(5); steps(k, 8, pad({ sy: 1 })); steps(k, 3, pad({ sy: -1 })); assert.ok(me.act?.k === 'check' && me.act.kind === 'shoulder' && !me.act.light, 'down then up: a shoulder check'); }
  // the keyboard keeps its buttons on defence (the shot key checks, the deke key pokes)
  { const { k, me } = onDefence(5); steps(k, 1, { ...NO_PAD, shoot: true }); assert.equal(me.act?.k, 'check'); }
  { const { k, me } = onDefence(5); steps(k, 1, { ...NO_PAD, deke: true }); assert.equal(me.act?.k, 'poke'); }
});

test('defence: RT switches the player, LT keeps him facing the puck, LB blocks shots far better', () => {
  { const { k, p, me } = onDefence(6); steps(k, 1, pad({ pass: true })); assert.notEqual(p.ctl, me.id, 'RT on defence: another skater'); }
  { const { k, me, c } = onDefence(6); c.x = 30; c.y = 15; me.x = 25; me.y = 15; me.fa = 0; steps(k, 40, pad({ vision: true, mx: -1 }));
    const toPuck = Math.atan2(c.y - me.y, c.x - me.x); assert.ok(Math.cos(me.fa - toPuck) > 0.9, 'LT: skating away he still faces the puck'); }
  // shots straight at a man standing a little off the lane: blocked far more often in the stance
  const blocks = (stance: boolean) => {
    let n = 0;
    for (let t = 0; t < 40; t++) {
      const { k, p, me, c } = onDefence(100 + t);
      Object.assign(c, { x: 34, y: 15, fa: Math.PI, cool: 0 });
      Object.assign(me, { x: 28, y: 15.8, fa: 0 });
      p.puck.x = 33.1; p.puck.y = 15;
      p.blockBy = null;
      p.shoot(c, 0.9, 0.3, { x: -1, y: 0 }, 'wrist');
      for (let i = 0; i < 40; i++) { priv(k).step(pad({ lb: stance })); if (!p.puck.shot) break; }
      if (k.drain().some((o: any) => o.type === 'shot' && o.outcome === 'block' && o.blocker === me.id)) n++;
    }
    return n;
  };
  const plain = blocks(false), stance = blocks(true);
  console.log(`   blocks of 40 shots: standing ${plain}, LB stance ${stance}`);
  assert.ok(stance > plain + 8, 'the stance blocks many more');
});

test('d-pad: right changes the forwards only, left the defence pair only; up / down call the forecheck and breakout', () => {
  const k = make(7), p = priv(k);
  toPlay(k); p.mode = 'play';
  const before = p.skaters(0, false).map((a: any) => a.id);
  // keep the puck in the other end so a change is safe
  const c = p.skaters(0).find((a: any) => !a.goalie);
  Object.assign(c, { x: 45, y: 15 }); p.puck.carrier = c; p.puck.x = 45.6; p.puck.y = 15;
  k.requestChange(0, 'F');
  p.changeCheck = 0; p.changes();
  const leaving = p.skaters(0).filter((a: any) => a.leaving);
  assert.ok(leaving.length > 0, 'somebody heads off');
  assert.ok(leaving.every((a: any) => !a.kindD), 'only forwards go');
  void before;
  const k2 = make(8), p2 = priv(k2);
  toPlay(k2); p2.mode = 'play';
  const c2 = p2.skaters(0).find((a: any) => !a.goalie); Object.assign(c2, { x: 45, y: 15 }); p2.puck.carrier = c2; p2.puck.x = 45.6; p2.puck.y = 15;
  k2.requestChange(0, 'D'); p2.changeCheck = 0; p2.changes();
  const l2 = p2.skaters(0).filter((a: any) => a.leaving);
  assert.ok(l2.length > 0 && l2.every((a: any) => a.kindD), 'only the defence pair goes');
  assert.match(k.cycleForecheck(0), /агрессивный/);
  assert.equal(k.forecheck[0], 1);
  assert.match(k.cycleForecheck(0), /пассивный/);
  assert.match(k.cycleForecheck(0), /сбалансированный/);
  assert.match(k.cycleBreakout(0), /длинный/);
  assert.match(k.cycleBreakout(0), /надёжный/);
  assert.match(k.cycleBreakout(0), /стандартный/);
});

console.log(`\n${pass} NHL gamepad tests passed`);
