// The played match, PR 52: the AI defence (no easy breakaways on «профи»), the points holding the blue line, a loose
// puck picked up by the man next to it, a puck over the glass by the KHL rules (the stoppage, the faceoff spot, the
// delay-of-game minor), the new penalties (and how a power-play goal ends them), the stances the 3D figures act out
// for every gamepad action, and those actions on the keyboard and the touch screen.
// Run: npx tsx scripts/play-rules-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { NO_PAD, PlayRink, type PadState } from '../src/game/playRink';
import { COMMAND_KEYS, emptyTouch, gamepadPad, keyboardPad, KEYS, mergePads, PAD } from '../src/components/playInput';
import { penaltyGesture } from '../src/components/officialCrew';
import { glassTop, inBenchFront, FACEOFF_SPOTS, RINK } from '../src/game/rinkGeometry';
import type { Team } from '../src/types';

const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
const P = r.players, teams = r.teams;
let pass = 0;
const test = (name: string, fn: () => void) => { const t = Date.now(); fn(); pass++; console.log('✓', name, `(${((Date.now() - t) / 1000).toFixed(1)} s)`); };
/* eslint-disable @typescript-eslint/no-explicit-any */
const priv = (k: PlayRink) => k as any;
const byId = (id: string) => teams.find(t => t.id === id)!;
const pair = (g: number): [Team, Team] => { const H = teams[g % teams.length]; let A = teams[(g * 5 + 3) % teams.length]; if (A.id === H.id) A = teams[(g + 1) % teams.length]; return [H, A]; };
const make = (g: number, extra: Partial<ConstructorParameters<typeof PlayRink>[0]> = {}) => { const [H, A] = pair(g); return new PlayRink({ home: H, away: A, players: P, lineups: [H.lineup, A.lineup], userSide: null, kind: 'reg', periodMinutes: 20, seed: 5200 + g, ...extra }); };
function toPlay(k: PlayRink) { for (let i = 0; i < 600 && k.mode !== 'play'; i++) k.advance(1 / 60); for (let i = 0; i < 30; i++) k.advance(1 / 60); }
function clear(k: PlayRink, keep: any[]) { for (const a of priv(k).onIce()) if (!keep.includes(a) && !a.goalie) { a.x = a.side ? 52 : 8; a.y = a.side ? 27 : 3; a.vx = 0; a.vy = 0; a.act = null; } }
const steps = (k: PlayRink, n: number, p: PadState | ((i: number) => PadState)) => { for (let i = 0; i < n; i++) priv(k).step(typeof p === 'function' ? p(i) : p); };
const BLUE = RINK.blueLine, L = RINK.length;

test('defence on «профи»: a carrier rushing straight up the ice rarely gets in alone (the defencemen keep a gap and back in early)', () => {
  const H = byId('ska'), A = byId('avangard');
  let rushes = 0, clean = 0;
  for (let sd = 0; sd < 2; sd++) {
    const k = new PlayRink({ home: H, away: A, players: P, lineups: [H.lineup, A.lineup], userSide: 0, difficulty: 'pro', kind: 'reg', periodMinutes: 20, seed: 900 + sd }), p = priv(k);
    p.opts.userSide = null;
    let rush: { id: string; t0: number } | null = null, cool = 0;
    for (let i = 0; i < 60 * 1300 && !k.ended; i++) {
      const pk = p.puck;
      if (!rush && k.mode === 'play' && k.tau > cool && pk.carrier && pk.carrier.side === 0 && !pk.carrier.goalie && pk.carrier.x < 22) { rush = { id: pk.carrier.id, t0: k.tau }; rushes++; p.opts.userSide = 0; p.ctl = pk.carrier.id; }
      let pad: PadState = NO_PAD;
      if (rush) {
        const me = p.agents.get(rush.id);
        const end = () => { rush = null; p.opts.userSide = null; p.ctl = null; cool = k.tau + 4; };
        if (k.mode !== 'play' || !me || pk.carrier !== me) end();
        else if (me.x > 46) { if (!p.skaters(1, false).some((o: any) => o.x > me.x - 0.3 && Math.abs(o.y - me.y) < 7)) clean++; end(); }
        else if (k.tau - rush.t0 > 9) end();
        else { const dx = 54 - me.x, dy = 15 - me.y, d = Math.hypot(dx, dy); pad = { ...NO_PAD, mx: dx / d, my: dy / d, sprint: true }; }
      }
      k.advance(1 / 60, pad);
    }
  }
  console.log(`   ${clean} clean breakaways in ${rushes} rushes (${(clean / rushes * 100).toFixed(1)}%; it was 53% before)`);
  assert.ok(rushes > 60);
  assert.ok(clean / rushes < 0.15, 'not more than one rush in seven ends alone on the goalie');
});

test('the blue line: a clear up the boards is met at the line by the point man (he stays onside, the puck stays in)', () => {
  let kept = 0, out = 0;
  for (let g = 0; g < 10; g++) {
    const k = make(g), p = priv(k);
    toPlay(k); p.mode = 'play';
    // side 0 attacks the far end (x → 60): its man is set up inside the line, the other team rims it out
    p.zoneIn[0] = true;
    const d0 = p.skaters(0).find((a: any) => a.kindD), o = p.skaters(1).find((a: any) => !a.kindD);
    clear(k, [d0, o]);
    Object.assign(o, { x: 52, y: 22, vx: 0, vy: 0, stun: 0 });
    const y = g % 2 ? 2.2 : 27.8;
    Object.assign(d0, { x: L - BLUE + 1.3, y: g % 2 ? 4.5 : 25.5, vx: 0, vy: 0, stun: 0, act: null });
    const pk = p.puck;
    Object.assign(pk, { carrier: null, dead: false, shot: null, passTo: null, passBy: null, h: 0, vh: 0, x: L - BLUE + 9, y, vx: -13, vy: 0, last: o, icing: null });
    let res = '';
    for (let i = 0; i < 150 && !res; i++) {
      k.advance(1 / 60);
      if (pk.carrier?.side === 0 || (pk.last?.side === 0 && pk.x > L - BLUE - 0.5)) res = 'kept';
      else if (pk.x < L - BLUE - 0.5) res = 'out';
    }
    if (res === 'kept') kept++; else if (res === 'out') out++;
  }
  console.log(`   kept in ${kept}, out ${out}`);
  assert.ok(kept >= 6, 'the point man holds the line most of the time');
});

test('a loose puck: the man it rolls to picks it up even with a teammate coming for it as well', () => {
  let first = 0, trials = 0;
  for (let g = 0; g < 8; g++) {
    const k = make(g), p = priv(k);
    toPlay(k); p.mode = 'play';
    const [a, b] = p.skaters(0).filter((x: any) => !x.kindD);
    clear(k, [a, b]);
    Object.assign(a, { x: 31.5, y: 15.6, vx: 0, vy: 0, stun: 0, act: null, cool: 0 });
    Object.assign(b, { x: 34.5, y: 13, vx: -2, vy: 1, stun: 0, act: null, cool: 0 });
    const pk = p.puck;
    Object.assign(pk, { carrier: null, dead: false, shot: null, passTo: null, passBy: null, h: 0, vh: 0, x: 29.5, y: 15, vx: 2.2, vy: 0.3, last: null, leg: pk.leg + 1 });
    trials++;
    for (let i = 0; i < 90 && !pk.carrier; i++) k.advance(1 / 60);
    if (pk.carrier === a) first++;
  }
  console.log(`   the near man took it ${first}/${trials}`);
  assert.ok(first >= 7);
});

test('the glass: 1.8 m on top of the boards along the sides, 2.4 m behind the nets, none in front of the benches', () => {
  assert.ok(Math.abs(glassTop(0, 15) - 2.87) < 0.01);
  assert.ok(Math.abs(glassTop(29.9, 0) - 3.47) < 0.01);
  assert.ok(inBenchFront(-6, -15) && inBenchFront(6, -15) && !inBenchFront(-6, 15) && !inBenchFront(0, -15));
  assert.equal(glassTop(-6, -15), 1.07, 'the players step over the boards at their bench');
});

/** Sends the puck from `from` (a skater of `side`, at local x) at the boards on the penalty-box side, high. */
function overGlass(opts: { side: 0 | 1; x: number; y?: number; h?: number; defl?: boolean; toY?: number }) {
  const k = make(3), p = priv(k);
  toPlay(k); p.mode = 'play';
  const a = p.skaters(opts.side).find((x: any) => !x.kindD);
  const wx = opts.side ? L - opts.x : opts.x, wy = opts.y ?? 20;
  Object.assign(a, { x: wx, y: wy, vx: 0, vy: 0 });
  const pk = p.puck, toY = opts.toY ?? 30;
  Object.assign(pk, { carrier: null, dead: false, shot: null, passTo: null, passBy: null, x: wx, y: toY > 15 ? 28.5 : 1.5, h: opts.h ?? 3.4, vh: 0, vx: 0, vy: toY > 15 ? 8 : -8, last: a, icing: null });
  p.zoneIn[opts.side] = opts.x > L - BLUE;
  p.released(a, !!opts.defl);
  p.puck.rel.x = wx; p.puck.rel.y = wy;
  for (let i = 0; i < 20 && k.mode === 'play'; i++) priv(k).step(NO_PAD);
  return { k, p, a };
}

test('over the glass from his own zone, straight out: a delay-of-game minor, the faceoff in his end', () => {
  const { k, p, a } = overGlass({ side: 0, x: 10 });
  assert.equal(k.mode, 'stop');
  assert.equal(p.stopInfo.reason, 'penalty');
  const pen = k.drain().find((o: any) => o.type === 'penalty') as any;
  assert.ok(pen && pen.player === a.id && pen.reason.startsWith('выброс шайбы') && pen.min === 2, 'the minor is called at once');
  assert.ok(p.stopInfo.dot.x < 30, 'the faceoff is in the offending team\'s end');
  assert.ok(k.plays.some((q: any) => q.kind === 'out' && q.text.includes('за стекло')));
  assert.equal(penaltyGesture(pen.reason), 'delay');
});

test('out of play without a penalty: deflected, into a players\' bench, or sent out by the attacking team (faceoff in the neutral zone)', () => {
  const d = overGlass({ side: 0, x: 10, defl: true });
  assert.equal(d.p.stopInfo.reason, 'out', 'a deflection is no penalty');
  assert.ok(!d.k.drain().some((o: any) => o.type === 'penalty'));
  const all = [FACEOFF_SPOTS.center, ...FACEOFF_SPOTS.end, ...FACEOFF_SPOTS.neutral];
  const near = all.reduce((b, q) => (Math.hypot(q.x - 10, q.y - 20) < Math.hypot(b.x - 10, b.y - 20) ? q : b));
  assert.deepEqual(d.p.stopInfo.dot, { x: near.x, y: near.y }, 'the dot nearest to where it was last played');
  const bench = overGlass({ side: 0, x: 26, y: 8, toY: 0, h: 1.5 });
  assert.equal(bench.p.stopInfo.reason, 'out', 'into the bench (no glass there): play stops, no penalty');
  assert.ok(bench.k.plays.some((q: any) => q.kind === 'out' && q.text.includes('скамейки')));
  const att = overGlass({ side: 0, x: 50 });
  assert.equal(att.p.stopInfo.reason, 'out');
  assert.ok(Math.abs(att.p.stopInfo.dot.x - (L - RINK.neutralDot)) < 0.01, 'the attacking team put it out from the attacking zone: the neutral-zone dot');
  // under the top of the glass it just comes back off it
  const low = overGlass({ side: 0, x: 10, h: 2.2 });
  assert.equal(low.k.mode, 'play', 'off the glass, still in play');
});

test('the new penalties: holding, high-sticking (2+2 with blood), goalie interference, elbowing, head, from behind, kneeing, roughing, too many men, delay of game', () => {
  const reasons: Record<string, number> = {};
  let periods = 0, total = 0, mins = new Set<number>();
  // (12 periods — and more while a rare call has not come yet: a hold, a beaten man grabbing or a pin kept too long,
  // comes about once in four periods, so 12 of them now and then have none)
  for (let g = 0; g < 12 || (g < 30 && !(reasons['задержка соперника'] && reasons['игра высоко поднятой клюшкой'])); g++) {
    const k = make(g); k.runToEnd(); periods++;
    for (const o of k.drain() as any[]) if (o.type === 'penalty') { reasons[o.reason] = (reasons[o.reason] ?? 0) + 1; total++; mins.add(o.min); }
  }
  console.log(`   ${(total / periods).toFixed(1)} per period:`, JSON.stringify(reasons));
  assert.ok(Object.keys(reasons).length >= 8, 'many kinds of penalties are called');
  for (const k of ['игра высоко поднятой клюшкой', 'задержка соперника']) assert.ok(reasons[k], k);
  assert.ok(total / periods > 2 && total / periods < 5, 'about as many as in the KHL');
  // every reason has the referee's signal (and the new ones their own)
  assert.equal(penaltyGesture('удар локтем'), 'elbow');
  assert.equal(penaltyGesture('удар в голову'), 'head');
  assert.equal(penaltyGesture('атака сзади'), 'behind');
  assert.equal(penaltyGesture('удар коленом'), 'knee');
  assert.equal(penaltyGesture('помеха вратарю'), 'interference');
  assert.equal(penaltyGesture('задержка руками'), 'hold');
  assert.equal(penaltyGesture('высота клюшки'), 'highstick');
  // the KHL's wording of the played match's calls
  assert.equal(penaltyGesture('задержка соперника'), 'hold');
  assert.equal(penaltyGesture('игра высоко поднятой клюшкой'), 'highstick');
  assert.equal(penaltyGesture('атака игрока, не владеющего шайбой'), 'interference');
  assert.equal(penaltyGesture('атака в голову или шею'), 'head');
  assert.equal(penaltyGesture('выброс шайбы за пределы площадки'), 'delay');
});

test('goalie interference: an attacker running into the goalie in his crease is called; too many men when the early man plays the puck', () => {
  let called = 0;
  for (let g = 0; g < 10; g++) {
    const k = make(g), p = priv(k);
    toPlay(k); p.mode = 'play';
    const gk = p.goalieOf(1), a = p.skaters(0).find((x: any) => !x.kindD);
    clear(k, [a]);
    p.puck.carrier = p.skaters(1).find((x: any) => x !== gk && !x.goalie); p.puck.carrier.x = 40; p.puck.carrier.y = 5;
    Object.assign(a, { x: gk.x - 1.2, y: gk.y, vx: 7, vy: 0, stun: 0, gi: -9 });
    for (let i = 0; i < 20; i++) priv(k).step(NO_PAD);
    if (p.pending.some((q: any) => q.reason === 'помеха вратарю') || k.plays.some((q: any) => q.text.includes('помеха вратарю'))) called++;
  }
  console.log(`   goalie interference called ${called}/10`);
  assert.ok(called >= 1 && called <= 6, 'called some of the time (not every bump)');
  // too many men
  const k = make(4), p = priv(k);
  toPlay(k); p.mode = 'play';
  const off = p.skaters(0)[1];
  p.nextUnit(0, 'all');
  off.leaving = true; Object.assign(off, { x: p.bench[0].x + 9, y: 3 }); // (well clear of the bench door and the stretch he would hop over at)
  p.jumpEarly(off);
  const early = p.early[0];
  assert.ok(early, 'the next man jumped on early');
  const man = p.agents.get(early.id);
  p.puck.carrier = man; p.puck.dead = false;
  // (called three times in four: tried until it is — the team has the puck, so the whistle goes at once)
  let called2 = false;
  for (let i = 0; i < 12 && !called2; i++) {
    p.tooManyMen();
    called2 = (k.drain() as any[]).some(o => o.type === 'penalty' && o.reason === 'нарушение численного состава' && o.player === off.id);
    if (!called2) { p.early[0] = early; off.leaving = true; off.on = 'ice'; p.puck.carrier = man; }
  }
  assert.ok(called2, 'too many men: a bench minor, served by the man who was late off');
});

test('a power-play goal: a minor ends, a double minor loses its first two minutes, a major is served in full', () => {
  const k = make(5), p = priv(k);
  toPlay(k); p.mode = 'play';
  const [a, b] = p.skaters(1);
  for (const [x, min] of [[a, 5], [b, 4]] as [any, 2 | 4 | 5][]) p.assess({ side: 1, player: x, reason: 'тест', min });
  const shooter = p.skaters(0)[0];
  p.puck.carrier = null; p.puck.shot = { by: shooter, side: 0, t0: k.tau, outcome: 'goal', kind: 'wrist', from: { x: 50, y: 15 }, xg: 0.1, zone: 'slot', goalie: p.goalieOf(1), strength: 'PP', ice: p.ice(), assists: [], post: false };
  const left = (x: any) => x.boxUntil - p.clock;
  assert.ok(left(b) > 230);
  p.goal(0, { x: L - RINK.goalLine, y: 15, h: 0.3 });
  assert.ok(Math.abs(left(b) - 120) < 1, 'the double minor drops to its second two minutes');
  assert.ok(left(a) > 290, 'the major stays');
});

test('the 3D stances: block (LB), one-timer, calling for the puck, vision (LT), hustle (L3), stickhandling, a push check, a saucer pass', () => {
  const base = (g: number) => { const k = make(g, { userSide: 0, autoSwitch: false }), p = priv(k); toPlay(k); p.mode = 'play'; p.prevPad = NO_PAD; return { k, p }; };
  const frameOf = (k: PlayRink, id: string) => k.frameAt(k.tau).skaters.find(s => s.id === id)!;
  // defence: LB held — the block stance; LT held while backing up — vision; push
  {
    const { k, p } = base(1);
    const me = p.skaters(0)[0], c = p.skaters(1).find((x: any) => !x.goalie);
    p.ctl = me.id; clear(k, [me, c]);
    Object.assign(c, { x: 30, y: 15, vx: 0, vy: 0, fa: Math.PI, act: null, cool: 9e9, stun: 0, decideAt: 9e9 });
    Object.assign(me, { x: 27, y: 15, vx: 0, vy: 0, fa: 0, act: null, cool: 0, stun: 0 });
    p.puck.carrier = c; p.puck.dead = false;
    steps(k, 15, { ...NO_PAD, lb: true });
    const f = frameOf(k, me.id);
    assert.equal(f.stance, 'block'); assert.ok((f.stanceT ?? 0) > 0.9);
    steps(k, 2, NO_PAD);
    steps(k, 15, { ...NO_PAD, vision: true, mx: -1, my: 0 });
    assert.equal(frameOf(k, me.id).stance, 'vision');
    Object.assign(me, { x: 29, y: 15, vx: 0, vy: 0, fa: 0, act: null, cool: 0 });
    steps(k, 1, NO_PAD); steps(k, 4, { ...NO_PAD, push: true });
    assert.equal(frameOf(k, me.id).move, 'push', 'the push check is acted out');
  }
  // offence without the puck: shot held — one-timer; pass — «Пас!»
  {
    const { k, p } = base(2);
    const [me, c] = p.skaters(0).filter((x: any) => !x.goalie);
    p.ctl = me.id; clear(k, [me, c]);
    Object.assign(c, { x: 40, y: 10, vx: 0, vy: 0, act: null, cool: 9e9, decideAt: 9e9 });
    Object.assign(me, { x: 48, y: 18, vx: 0, vy: 0, act: null, cool: 0 });
    p.puck.carrier = c; p.puck.dead = false; p.zoneIn[0] = true; // (the zone was entered: no offside)
    steps(k, 12, { ...NO_PAD, shoot: true });
    assert.equal(frameOf(k, me.id).stance, 'oneTimer');
    steps(k, 2, NO_PAD); steps(k, 2, { ...NO_PAD, pass: true }); steps(k, 8, NO_PAD);
    assert.equal(frameOf(k, me.id).stance, 'call');
  }
  // with the puck: hustle, stickhandling, the saucer pass release
  {
    const { k, p } = base(3);
    const [me, m2] = p.skaters(0).filter((x: any) => !x.goalie);
    p.ctl = me.id; clear(k, [me, m2]);
    Object.assign(me, { x: 20, y: 15, vx: 7, vy: 0, fa: 0, act: null, cool: 0, energy: 1 });
    Object.assign(m2, { x: 34, y: 20, vx: 0, vy: 0, act: null });
    p.puck.carrier = me; p.puck.dead = false;
    steps(k, 1, { ...NO_PAD, mx: 1, hustle: true }); steps(k, 20, { ...NO_PAD, mx: 1 });
    assert.equal(frameOf(k, me.id).stance, 'hustle');
    // (turned to skate up the screen: the right stick to the side moves the puck across him — down would load a shot)
    Object.assign(me, { x: 30, y: 24, vx: 0, vy: -6, fa: -Math.PI / 2, act: null, cool: 0 });
    steps(k, 15, { ...NO_PAD, my: -0.3, sx: 1, sy: 0 });
    assert.ok(Math.abs(frameOf(k, me.id).handle ?? 0) > 0.3, 'the stickhandling side reaches the figure');
    steps(k, 4, NO_PAD);
    Object.assign(me, { act: null, cool: 0 }); // (the sideways flick above went off as a deke: let it finish)
    steps(k, 10, { ...NO_PAD, pass: true, lb: true, mx: 1, my: 0.35 }); steps(k, 2, { ...NO_PAD, lb: true, mx: 1, my: 0.35 });
    const rel = k.motion.releaseAt(me.id, k.tau);
    assert.equal(rel?.rel.kind, 'saucer', 'the saucer pass has its own follow-through');
  }
});

test('every action on every device: the keyboard has the gamepad\'s extra buttons, the touch screen too, no key does two things', () => {
  const kb = (code: string) => keyboardPad(new Set([code]));
  assert.ok(kb('KeyU').lb && kb('KeyZ').lb, 'the modifier (block / saucer / special dekes)');
  assert.ok(kb('KeyI').lift && kb('KeyO').pin && kb('KeyH').push && kb('KeyM').vision && kb('KeyN').hustle);
  const merged = mergePads(kb('KeyU'), NO_PAD);
  assert.ok(merged.lb && !merged.nhl, 'merged without turning on the NHL scheme');
  const touch = mergePads(NO_PAD, { ...emptyTouch(), lift: true, vision: true, lb: true });
  assert.ok(touch.lift && touch.vision && touch.lb);
  const pad = gamepadPad([{ axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, j) => ({ pressed: j === PAD.LB || j === PAD.A, value: 0 })) }]).pad;
  assert.ok(pad.lb && pad.lift && pad.nhl, 'the gamepad keeps its map');
  const codes = [...Object.values(KEYS).flat(), ...Object.values(COMMAND_KEYS).flat()];
  assert.equal(new Set(codes).size, codes.length, 'each key does one thing');
  // the keyboard's modifier makes the saucer pass and the block stance like LB
  const k = make(6, { userSide: 0, autoSwitch: false }), p = priv(k);
  toPlay(k); p.mode = 'play'; p.prevPad = NO_PAD;
  const me = p.skaters(0)[0], c = p.skaters(1).find((x: any) => !x.goalie);
  p.ctl = me.id; clear(k, [me, c]);
  Object.assign(c, { x: 30, y: 15, act: null, cool: 9e9, decideAt: 9e9 }); Object.assign(me, { x: 27, y: 15, act: null });
  p.puck.carrier = c; p.puck.dead = false;
  steps(k, 3, kb('KeyU'));
  assert.equal(p.blockBy, me, 'U on defence: the block stance');
});

console.log(`\n${pass} PR 52 rules / AI / controls tests passed`);
