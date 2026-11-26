// The played match, the finer moves: stick reach for a loose puck, the automatic switch to the defender on an
// attack, the faceoff button, checks that can miss (and the falls they cause), the late-hit grace of the
// interference call, and the cameras (NHL-style live cameras with their stick mapping, static replay cameras).
// Run: npx tsx scripts/play-moves-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { NO_PAD, PlayRink, screenToRink, type PadState, type PlayOut } from '../src/game/playRink';
import { autoCamera, CAMERAS, cameraPose, LIVE_CAMERAS, liveCameraPose, STATIC_CAMERAS, VIEW_LABEL, type ReplayView } from '../src/components/replayCameras';
import { detectDevice, emptyTouch, gamepadPad, keyboardPad, mergePads } from '../src/components/playInput';
import type { Team } from '../src/types';

const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
const P = r.players, teams = r.teams;
let pass = 0;
const test = (name: string, fn: () => void) => { const t = Date.now(); fn(); pass++; console.log('✓', name, `(${((Date.now() - t) / 1000).toFixed(1)} s)`); };

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnySk = any;
const pair = (g: number): [Team, Team] => { const H = teams[g % teams.length]; let A = teams[(g * 5 + 3) % teams.length]; if (A.id === H.id) A = teams[(g + 1) % teams.length]; return [H, A]; };
const make = (g: number, extra: Partial<ConstructorParameters<typeof PlayRink>[0]> = {}) => { const [H, A] = pair(g); return new PlayRink({ home: H, away: A, players: P, lineups: [H.lineup, A.lineup], userSide: null, kind: 'reg', periodMinutes: 20, seed: 2000 + g, ...extra }); };
const priv = (k: PlayRink) => k as any;
/** Steps until the puck is in play (past the opening faceoff). */
function toPlay(k: PlayRink) { for (let i = 0; i < 600 && k.mode !== 'play'; i++) k.advance(1 / 60); for (let i = 0; i < 30; i++) k.advance(1 / 60); }
/** Everybody but the listed skaters is moved far away (so nobody else plays the puck). */
function clear(k: PlayRink, keep: AnySk[]) {
  for (const a of priv(k).onIce()) if (!keep.includes(a) && !a.goalie) { a.x = a.side ? 52 : 8; a.y = a.side ? 27 : 3; a.vx = 0; a.vy = 0; a.act = null; }
}

test('a skater stretches for a puck just beyond his blade and pulls it in (the reach move)', () => {
  let got = 0, reached = 0;
  for (let trial = 0; trial < 12; trial++) {
    const k = make(trial, { userSide: 0 }), p = priv(k);
    toPlay(k);
    p.mode = 'play';
    const me = p.skaters(0)[0];
    p.ctl = me.id;
    clear(k, [me]);
    me.x = 30; me.y = 15; me.vx = 0; me.vy = 0; me.fa = 0; me.act = null; me.cool = 0; me.stun = 0; me.rolled = -1;
    const pk = p.puck;
    pk.carrier = null; pk.dead = false; pk.shot = null; pk.passTo = null; pk.passBy = null; pk.noTouch = null; pk.h = 0; pk.vh = 0;
    pk.x = 31.75; pk.y = 15; pk.vx = 0; pk.vy = 0;
    let sawReach = false;
    for (let i = 0; i < 40; i++) {
      k.advance(1 / 60, NO_PAD);
      const f = k.frameAt(k.lastTau);
      if (f.skaters.find(s => s.id === me.id)?.move === 'reach') sawReach = true;
      if (pk.carrier) break;
    }
    if (sawReach) reached++;
    if (pk.carrier === me) got++;
  }
  console.log(`   stretched ${reached}/12, got the puck ${got}/12`);
  assert.ok(reached >= 9, 'the reach move is acted out');
  assert.ok(got >= 6, 'most stretches pull the puck in');
});

test('the manager\'s control goes to the defender between the puck and the net when the other team attacks', () => {
  let switched = 0;
  for (let trial = 0; trial < 8; trial++) {
    const k = make(10 + trial, { userSide: 0 }), p = priv(k);
    toPlay(k);
    p.mode = 'play';
    const us = p.skaters(0), them = p.skaters(1);
    const far = us[0], guard = us[1], c = them[0];
    clear(k, [far, guard, c]);
    // their carrier rushes into our zone (we defend the net at x = 4); our guard is goal side, our man far up ice
    c.x = 16; c.y = 13; c.vx = -5; c.vy = 0.4; c.fa = Math.PI; c.stun = 0;
    guard.x = 10; guard.y = 14; guard.vx = 0; guard.vy = 0; guard.stun = 0;
    far.x = 42; far.y = 22; far.vx = 0; far.vy = 0; far.stun = 0; far.act = null;
    const pk = p.puck; pk.carrier = c; pk.dead = false; pk.shot = null; pk.passTo = null;
    p.ctl = far.id; p.autoAt = 0;
    for (let i = 0; i < 30 && k.ctl === far.id; i++) k.advance(1 / 60, NO_PAD);
    if (k.ctl === guard.id) switched++;
  }
  console.log(`   switched to the goal-side defender ${switched}/8`);
  assert.ok(switched >= 7, 'the defender takes over');
});

test('the faceoff button: pressed as the puck drops it wins the draw far more often than a press too early', () => {
  const rate = (timing: 'good' | 'early') => {
    let won = 0, all = 0, cues = new Set<string>();
    for (let g = 0; g < 2; g++) {
      const k = make(30 + g, { userSide: 0, periodMinutes: 6 }), p = priv(k);
      const pad = (k: PlayRink): PadState => {
        const fo = p.fo;
        if (k.mode !== 'faceoff' || !fo || fo.done) return NO_PAD;
        const cue = k.hud().foCue; if (cue) cues.add(cue);
        return { ...NO_PAD, faceoff: timing === 'good' ? k.tau >= fo.drop + 0.04 : k.tau >= fo.setAt + 0.1 && k.tau < fo.drop - 0.3 };
      };
      for (let i = 0; i < 1500 * 60 && !k.ended; i++) {
        k.advance(1 / 60, pad(k));
        for (const o of k.drain()) if (o.type === 'faceoff') { all++; if (o.side === 0) won++; }
      }
    }
    return { pct: won / Math.max(1, all), all, cues };
  };
  const good = rate('good'), early = rate('early');
  console.log(`   on time ${(good.pct * 100).toFixed(0)}% of ${good.all}, early ${(early.pct * 100).toFixed(0)}% of ${early.all}`);
  assert.ok(good.all > 10 && early.all > 10);
  assert.ok(good.pct > 0.7, 'a well-timed press wins most draws');
  assert.ok(early.pct < 0.3, 'jumping the drop loses it');
  assert.ok(good.cues.has('ready') && good.cues.has('now'), 'the HUD cues the drop');
  // every device has the button: F on the keyboard, RB / R3 on a pad, a touch button (merged into the pad state)
  assert.equal(keyboardPad(new Set(['KeyF'])).faceoff, true);
  const btn = (i: number) => Array.from({ length: 17 }, (_, j) => ({ pressed: j === i, value: j === i ? 1 : 0 }));
  assert.equal(gamepadPad([{ axes: [0, 0, 0, 0], buttons: btn(5) }]).pad.faceoff, true);
  assert.equal(gamepadPad([{ axes: [0, 0, 0, 0], buttons: btn(11) }]).pad.faceoff, true);
  assert.equal(mergePads(NO_PAD, { ...emptyTouch(), faceoff: true }).faceoff, true);
  assert.equal(detectDevice(true, true), 'gamepad');
  assert.equal(detectDevice(false, true), 'touch');
  assert.equal(detectDevice(false, false), 'keyboard');
});

test('checks can miss: a skater slips one or rides it out; hits put men down on their back, face first or sideways', () => {
  const outcomes = { slip: 0, ride: 0, hit: 0 };
  const kinds = new Set<string>();
  for (let g = 0; g < 4; g++) {
    const k = make(40 + g);
    let seen = 0;
    for (let i = 0; i < 1500 * 60 && !k.ended; i++) {
      k.advance(1 / 60);
      const plays = k.plays;
      for (const pl of plays.slice(Math.max(0, plays.length - 3))) {
        if (pl.tau <= seen) continue;
        seen = pl.tau;
        if (pl.text.includes('увернулся')) outcomes.slip++;
        else if (pl.text.includes('устоял')) outcomes.ride++;
      }
      for (const o of k.drain()) if (o.type === 'hit') outcomes.hit++;
      if (i % 15 === 0) for (const s of k.frameAt(k.lastTau).skaters) if (s.fall && s.fallKind) kinds.add(s.fallKind);
    }
  }
  console.log(`   hits ${outcomes.hit}, slipped ${outcomes.slip}, ridden out ${outcomes.ride}, falls: ${[...kinds].join(', ')}`);
  assert.ok(outcomes.slip > 0 && outcomes.ride > 0, 'not every check lands');
  assert.ok(outcomes.hit > outcomes.slip + outcomes.ride, 'most checks still land');
  assert.ok(kinds.has('back') && kinds.has('side'), 'different falls');
});

test('interference: no call on a man who just lost the puck (the grace after it), a late hit far from the play is called', () => {
  const k = make(50), p = priv(k);
  toPlay(k);
  p.mode = 'play';
  const a = p.skaters(0)[0], t = p.skaters(1)[0];
  clear(k, [a, t]);
  const calls = (since: number, onPuck = false) => {
    let n = 0, landed = 0;
    for (let i = 0; i < 400; i++) {
      p.pending = [];
      a.x = 30; a.y = 15; a.vx = 4; a.vy = 0; a.fa = 0; a.stun = 0; a.stagger = 0;
      t.x = 30.8; t.y = 15; t.vx = 1; t.vy = 0; t.fa = 0; t.stun = 0; t.fall = 0; t.stagger = 0; t.act = null;
      const pk = p.puck; pk.carrier = null; pk.dead = false; pk.shot = null; pk.passTo = null; pk.x = 50; pk.y = 25; pk.vx = 0; pk.vy = 0;
      t.ownAt = p.tau - since;
      a.act = { k: 'check', t0: p.tau, tgt: t, done: true, kind: 'shoulder', onPuck };
      const hits = p.hits[0];
      p.resolveCheck(a, t);
      if (p.hits[0] > hits) landed++;
      if (p.pending.some((x: { reason: string }) => x.reason === 'атака игрока без шайбы')) n++;
    }
    return { n, landed };
  };
  const justLost = calls(0.5), onPuck = calls(5, true), late = calls(4);
  console.log(`   interference calls: just lost the puck ${justLost.n}/${justLost.landed} hits, began on the carrier ${onPuck.n}/${onPuck.landed}, a late hit ${late.n}/${late.landed}`);
  assert.equal(justLost.n, 0, 'a man who just lost the puck may be hit');
  assert.equal(onPuck.n, 0, 'a check that began while he had the puck is fair');
  assert.ok(late.n > late.landed * 0.3, 'a hit on a man long without the puck is interference');
  p.pending = [];
});

test('cameras: NHL-style live cameras stay in the arena, the vertical one turns the stick; static replay cameras stand still', () => {
  assert.ok(LIVE_CAMERAS.length >= 8, 'eight live cameras');
  for (const [cam] of LIVE_CAMERAS) for (const attack of [1, -1] as const) for (const speed of [0, 25]) for (const fx of [-30, 0, 30]) for (const zoom of [0.45, 1.8]) for (const aspect of [0.5, 2.4]) {
    const q = liveCameraPose(cam, { x: fx, z: 10 }, zoom, aspect, { attack, speed });
    assert.ok(q.pos.y > 0.5 && q.pos.y < 60 && Math.abs(q.pos.x) < 45 && Math.abs(q.pos.z) < 45, `${cam} outside`);
    assert.ok(q.fov >= 15 && q.fov <= 80, `${cam} fov`);
    // the camera looks at the play from somewhere else (no degenerate pose)
    assert.ok(Math.hypot(q.pos.x - q.look.x, q.pos.y - q.look.y, q.pos.z - q.look.z) > 3, `${cam} too close to its target`);
  }
  // the vertical camera sits behind the manager's own end and looks the way he attacks
  const v = liveCameraPose('vertical', { x: 0, z: 0 }, 1, 1.78, { attack: 1 });
  assert.ok(v.pos.x < v.look.x, 'vertical: looks toward +x when attacking +x');
  // its stick: up the screen is the attack direction, right on the screen is to the right of the attack
  const up = screenToRink(0, -1, 'vertical', 50, 1), right = screenToRink(1, 0, 'vertical', 50, 1);
  assert.ok(Math.abs(up.x - 1) < 1e-9 && Math.abs(up.y) < 1e-9, 'up = attack (+x)');
  assert.ok(Math.abs(right.y - 1) < 1e-9 && Math.abs(right.x) < 1e-9, 'right = +y (down the screen in 2D) when attacking +x');
  const up2 = screenToRink(0, -1, 'vertical', 50, -1);
  assert.ok(Math.abs(up2.x + 1) < 1e-9, 'up = attack (−x)');
  for (const cam of ['overhead', 'dynamic', 'zone', 'broadcast'] as const) assert.deepEqual(screenToRink(0.3, -0.4, cam, 20, -1), { x: 0.3, y: -0.4 });
  // the dynamic camera pulls back as the play speeds up
  const slow = liveCameraPose('dynamic', { x: 0, z: 0 }, 1, 1.78, { speed: 0 }), fast = liveCameraPose('dynamic', { x: 0, z: 0 }, 1, 1.78, { speed: 25 });
  assert.ok(fast.pos.z > slow.pos.z + 3, 'dynamic: wider on a rush');

  // replay cameras on a goal clip of a played period
  const k = make(60);
  let clip = null as ReturnType<PlayRink['goalClip']>;
  for (let i = 0; i < 1500 * 60 && !k.ended && !clip; i++) {
    k.advance(1 / 60);
    const o: PlayOut[] = k.drain();
    if (o.some(x => x.type === 'shot' && x.outcome === 'goal')) { for (let j = 0; j < 240; j++) k.advance(1 / 60); const g = k.goalsFor[k.goalsFor.length - 1]; clip = k.goalClip(g.tau); }
  }
  assert.ok(clip, 'a goal clip');
  const views = CAMERAS.map(([c]) => c).filter(c => c !== 'auto') as ReplayView[];
  assert.ok(views.length >= 13 && STATIC_CAMERAS.size >= 4, 'more replay cameras, some static');
  for (const view of views) {
    const a = cameraPose(clip!, 0.2, view, 1, 1.78), b = cameraPose(clip!, 0.8, view, 1, 1.78);
    for (const q of [a, b]) {
      assert.ok(q.pos.y > 0.3 && q.pos.y < 60 && Math.abs(q.pos.x) < 45 && Math.abs(q.pos.z) < 45, `${view} outside`);
      assert.ok(q.fov >= 10 && q.fov <= 85, `${view} fov ${q.fov}`);
    }
    if (STATIC_CAMERAS.has(view)) assert.deepEqual([a.pos, a.look], [b.pos, b.look], `${view} is static`);
  }
  // the auto director always picks a real camera (every seed: the hash is unsigned)
  for (let i = 0; i < 300; i++) {
    const c = { ...clip!, scorer: `p${i}`, goal: 0.6 + (i % 7) * 0.03 };
    for (const t of [0.05, 0.3, 0.55, 0.62, 0.7, 0.95]) { const v = autoCamera(c, t); assert.ok(v in VIEW_LABEL, `auto camera ${String(v)}`); assert.ok(cameraPose(c, t, v, 1, 1.78).pos, `pose of ${v}`); }
  }
  assert.ok(Math.hypot(cameraPose(clip!, 0.2, 'rail', 1, 1.78).pos.x - cameraPose(clip!, 0.9, 'rail', 1, 1.78).pos.x) > 0.5, 'the rail camera rides with the puck');
});

console.log(`\n${pass} play-moves tests passed`);
