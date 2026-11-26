// The match as a show: the four officials (positions, faceoff drops, the signals of their calls), the skaters
// skating to the penalty box / the bench and back (both rinks), the benches staying put when the teams switch
// ends, and the teams' entrance before the first period.
// Run: npx tsx scripts/officials-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { GameSim } from '../src/game/engine';
import { RinkAI, type RinkPlay } from '../src/game/rinkAI';
import { PlayRink } from '../src/game/playRink';
import type { LiveFrame } from '../src/game/rinkPlayback';
import { BLUE, GOAL, OfficialCrew, insideRink, penaltyGesture, type Gesture } from '../src/components/officialCrew';
import { INTRO_PACE, gateOf, introCamera, introOfficials, introPoses, introShow, lineup, planIntro, type IntroSkater } from '../src/components/matchIntro';
import { benchSeat } from '../src/components/arenaBenches';
import { GOAL_SHOW, SLOW, goalReplay, momentReplay, pickMoment, replayAngle, replayCamera, replayLength, replayTau, celebrateCamera } from '../src/components/liveShow';
import { toWorld } from '../src/components/replayCameras';

const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
const H = r.teams.find(t => t.id === 'ska')!, A = r.teams.find(t => t.id === 'avangard')!;
let pass = 0;
const test = (name: string, fn: () => void) => { const t = Date.now(); fn(); pass++; console.log('✓', name, `(${((Date.now() - t) / 1000).toFixed(1)} s)`); };
/* eslint-disable @typescript-eslint/no-explicit-any */

/** A frame with the puck at world (x, z) and skaters at world points. */
const frame = (px: number, pz: number, skaters: { id: string; side: 0 | 1; x: number; z: number }[] = [], extra: Partial<LiveFrame> = {}): LiveFrame => ({
  puck: { x: px / 60 * 100 + 50, y: pz / 30 * 100 + 50, h: 0 },
  skaters: skaters.map(s => ({ id: s.id, side: s.side, pos: { x: s.x / 60 * 100 + 50, y: s.z / 30 * 100 + 50, h: 0 } })), ...extra,
});
const run = (crew: OfficialCrew, f: LiveFrame, plays: RinkPlay[], from: number, secs: number, onStep?: (tau: number) => void) => {
  for (let t = from; t <= from + secs + 1e-9; t += 1 / 30) { crew.update(f, plays, t); onStep?.(t); }
  return from + secs;
};
const play = (tau: number, kind: RinkPlay['kind'], text: string, side: 0 | 1 | null = 0, player?: string): RinkPlay => ({ tau, g: 0, kind, side, player, text });

test('positioning: the lead referee on the goal line of the zone with the puck, the trail near the blue line; linesmen on the boards at the blue lines', () => {
  const crew = new OfficialCrew();
  run(crew, frame(20, 4), [], 0, 6);
  const [r1, r2, l1, l2] = crew.officials;
  assert.ok(r1.x > GOAL - 4 && Math.abs(r1.z) > 9, `lead ${r1.x.toFixed(1)},${r1.z.toFixed(1)}`);
  assert.ok(r2.x > 3 && r2.x < 12 && Math.abs(r2.z) > 9, `trail ${r2.x.toFixed(1)},${r2.z.toFixed(1)}`);
  assert.ok(Math.abs(l1.x - (BLUE + .7)) < 1.2 && Math.abs(l1.z) > 12, `linesman 1 ${l1.x.toFixed(1)},${l1.z.toFixed(1)}`);
  assert.ok(Math.abs(l2.x) < 3, `linesman 2 moves up to the red line with the puck deep in the other zone: ${l2.x.toFixed(1)}`);
  // diagonally across: the referees on opposite sides, the linesmen too
  assert.ok(Math.sign(r1.z) !== Math.sign(r2.z) && Math.sign(l1.z) !== Math.sign(l2.z));
  // the puck goes the other way: they swap roles
  run(crew, frame(-21, -3), [], 6.1, 7);
  assert.ok(crew.officials[1].x < -(GOAL - 4), 'the referee of the other end leads');
  assert.ok(crew.officials[0].x < -2 && crew.officials[0].x > -12, `the first referee trails: ${crew.officials[0].x.toFixed(1)}`);
});

test('officials keep out of the way: skaters and the puck, never in the crease, always on the ice', () => {
  const crew = new OfficialCrew();
  // a crowd of skaters right where the lead referee would stand
  const crowd = [{ id: 'a', side: 0 as const, x: 25.5, z: -12.5 }, { id: 'b', side: 1 as const, x: 24, z: -11.5 }, { id: 'c', side: 1 as const, x: 26, z: -10.5 }];
  run(crew, frame(20, -8, crowd), [], 0, 6);
  const r1 = crew.officials[0];
  for (const s of crowd) assert.ok(Math.hypot(r1.x - s.x, r1.z - s.z) > 1.2, `${s.id} ${Math.hypot(r1.x - s.x, r1.z - s.z).toFixed(2)}`);
  for (const o of crew.officials) { const p = insideRink(o.x, o.z, .6); assert.ok(Math.hypot(p.x - o.x, p.z - o.z) < 1e-6, 'on the ice'); assert.ok(!(Math.abs(o.x) > GOAL - 2 && Math.abs(o.z) < 2), 'not in the crease'); }
});

test('the penalty signals: delayed — the arm up until the whistle; then the infraction, the point to the box, off to the timekeepers', () => {
  const crew = new OfficialCrew();
  const plays: RinkPlay[] = [];
  const seen: Gesture[] = [];
  let tau = run(crew, frame(10, 2, [{ id: 'x', side: 1, x: 18, z: -5 }]), plays, 0, 3);
  plays.push(play(tau + .05, 'penalty', 'Отложенный штраф: Иванов — подножка', 1, 'x'));
  tau = run(crew, frame(12, 2, [{ id: 'x', side: 1, x: 18, z: -5 }]), plays, tau + 1 / 30, 4, () => { const g = crew.officials.find(o => o.gesture !== 'none'); if (g) seen.push(g.gesture); });
  const ref = crew.officials.find(o => o.gesture === 'armUp');
  assert.ok(ref && ref.role === 'ref', 'a referee holds his arm up through the delayed penalty');
  assert.ok(seen.every(g => g === 'armUp'));
  // the whistle and the call
  const stopped = frame(12, 2, [{ id: 'x', side: 1, x: 18, z: -5 }], { stopped: true });
  plays.push(play(tau + .1, 'penalty', 'Удаление: Иванов — подножка (2 мин)', 1, 'x'));
  const order: Gesture[] = [];
  run(crew, stopped, plays, tau + 1 / 30, 6, () => { if (order.at(-1) !== ref!.gesture) order.push(ref!.gesture); });
  assert.deepEqual(order.slice(0, 3), ['armUp', 'trip', 'point'], order.join(' → '));
  assert.ok(ref!.z > 8 && Math.abs(ref!.x) < 8, `he skates over to the penalty box / timekeepers: ${ref!.x.toFixed(1)},${ref!.z.toFixed(1)}`);
  // every infraction has its own signal
  assert.equal(penaltyGesture('задержка клюшкой'), 'hook');
  assert.equal(penaltyGesture('задержка руками'), 'hold');
  assert.equal(penaltyGesture('удар клюшкой'), 'slash');
  assert.equal(penaltyGesture('атака игрока без шайбы'), 'interference');
  assert.equal(penaltyGesture('толчок на борт'), 'boarding');
  assert.equal(penaltyGesture('атака с разгона'), 'charging');
  assert.equal(penaltyGesture('высота клюшки'), 'highstick');
  assert.equal(penaltyGesture('бросок клюшки'), 'fist');
});

test('goal, icing, offside, faceoff: the referee points at the net, the linesman folds his arms, raises one, drops the puck', () => {
  const crew = new OfficialCrew(), plays: RinkPlay[] = [];
  let tau = run(crew, frame(27, .3), plays, 0, 3);
  plays.push(play(tau + .05, 'goal', 'ГОЛ! Петров', 0));
  tau = run(crew, frame(27.5, .2), plays, tau + 1 / 30, .5);
  const goalRef = crew.officials.find(o => o.gesture === 'goal');
  assert.ok(goalRef && goalRef.role === 'ref' && goalRef.aim && goalRef.aim.x > 25, 'a referee points at the net');
  plays.push(play(tau + .05, 'icing', 'Проброс: СКА', 0));
  tau = run(crew, frame(-26, 6), plays, tau + 1 / 30, 1.2);
  assert.ok(crew.officials.some(o => o.role === 'line' && o.gesture === 'icing'), 'icing: a linesman folds his arms');
  tau = run(crew, frame(-26, 6), plays, tau + 1 / 30, 3);
  plays.push(play(tau + .05, 'offside', 'Офсайд: Сидоров', 1));
  tau = run(crew, frame(9, 0), plays, tau + 1 / 30, .4);
  assert.ok(crew.officials.some(o => o.role === 'line' && o.gesture === 'armUp'), 'offside: a linesman raises his arm');
  // an end-zone faceoff: a linesman skates to the dot, bends over with the puck, drops it on the faceoff play
  tau = run(crew, frame(-20, 7), plays, tau + 1 / 30, 3);
  const dot = { x: -20 / 60 * 100 + 50 + 1.5, y: 7 / 30 * 100 + 50 + 5.3, h: 0 };
  const held = (h: number) => { const f = frame(-20, 7, [], { faceoff: true, stopped: true, official: dot }); f.puck.h = h; return f; };
  tau = run(crew, held(1.1), plays, tau + 1 / 30, 4);
  const dropper = crew.officials.find(o => o.gesture === 'ready');
  assert.ok(dropper && dropper.role === 'line', 'a linesman drops the puck in the zone');
  const d = toWorld(dot);
  assert.ok(Math.hypot(dropper!.x - d.x, dropper!.z - d.z) < 1.2, 'at the dot');
  // the drop as the puck leaves his hand
  run(crew, held(.9), plays, tau + 1 / 30, .2);
  assert.equal(dropper!.gesture, 'drop');
  // centre ice: a referee
  const crew2 = new OfficialCrew();
  const c = frame(0, 0, [], { faceoff: true, stopped: true, official: { x: 51.5, y: 55.3, h: 0 } }); c.puck.h = 1.1;
  run(crew2, c, [], 0, 4);
  assert.equal(crew2.officials.find(o => o.gesture === 'ready')?.role, 'ref');
});

test('the 2D rink and the 3D picture can read the crew at slightly different moments: no snapping back', () => {
  const crew = new OfficialCrew();
  run(crew, frame(10, 0), [], 0, 3);
  const before = crew.officials.map(o => ({ x: o.x, z: o.z }));
  crew.update(frame(-25, 0), [], 2.98); // the 2D rink a frame behind
  crew.officials.forEach((o, i) => assert.ok(Math.hypot(o.x - before[i].x, o.z - before[i].z) < 1e-9));
});

// ---- the played match: to the penalty box on skates ----
const make = (g: number) => new PlayRink({ home: H, away: A, players: r.players, lineups: [H.lineup, A.lineup], userSide: null, kind: 'reg', periodMinutes: 20, seed: 4000 + g });
test('played match: a penalized skater skates to the penalty box door (shown on the ice) and sits down; out of the box through the door', () => {
  let walked = 0;
  for (let g = 0; g < 4; g++) {
    const k = make(g), p = k as any;
    for (let i = 0; i < 600 && k.mode !== 'play'; i++) k.advance(1 / 60);
    for (let i = 0; i < 60; i++) k.advance(1 / 60);
    const off = p.skaters(1)[0], victim = p.skaters(0)[0];
    off.x = 12; off.y = 6; // far from his box
    p.puck.carrier = off; // his own team has the puck: the whistle at once
    p.foul(off, 'подножка', victim);
    const door = p.box[off.side];
    let prev = { x: off.x, y: off.y }, seat = false, onIceFrames = 0, maxStep = 0;
    for (let i = 0; i < 60 * 12 && !seat; i++) {
      k.advance(1 / 60);
      const f = k.frameAt(k.tau), me = f.skaters.find(x => x.id === off.id);
      if (off.on === 'box' && me && !me.box) onIceFrames++;
      if (off.on === 'box' && !off.boxGo) seat = true;
      else if (off.on === 'box') { maxStep = Math.max(maxStep, Math.hypot(off.x - prev.x, off.y - prev.y)); }
      prev = { x: off.x, y: off.y };
    }
    assert.ok(seat, 'he reaches the box');
    assert.ok(onIceFrames > 60, `skating there is shown on the ice (${onIceFrames} frames)`);
    assert.ok(maxStep < .2, `no teleport on the way (${maxStep.toFixed(2)} m per step)`);
    assert.ok(Math.hypot(prev.x - door.x, prev.y - door.y) > 1, 'then seated behind the boards');
    walked++;
  }
  assert.equal(walked, 4);
});

// ---- the spectator match: officials over a whole period, benches in flipped periods ----
const periods: { evs: ReturnType<GameSim['simPeriod']>; start: number; end: number; flip: boolean }[] = [];
{
  const sim = new GameSim(H, A, r.players);
  for (let k = 0; k < 3; k++) { const start = sim.sec, evs = sim.simPeriod(); periods.push({ evs, start, end: sim.sec, flip: k === 1 }); }
}
test('spectator match: over whole periods the officials stay on the ice, out of the way, signal the penalties and drop the pucks', () => {
  let near = 0, samples = 0, signals = new Set<Gesture>(), drops = 0, penalties = 0, late = 0;
  for (const per of periods) {
    const ai = new RinkAI(per.evs, H, A, r.players, per.start, per.end, { flip: per.flip }).runToEnd();
    penalties += ai.plays.filter(p => p.kind === 'penalty').length;
    const crew = new OfficialCrew();
    let wasDrop = false, readySince = NaN;
    for (let tau = 0; tau < ai.lastTau; tau += 1 / 20) {
      const f = ai.frameAt(tau);
      crew.update(f, ai.plays, tau);
      const sk = f.skaters.filter(s => !s.box).map(s => toWorld(s.pos));
      for (const o of crew.officials) {
        const p = insideRink(o.x, o.z, .6); assert.ok(Math.hypot(p.x - o.x, p.z - o.z) < 1e-6);
        const d = Math.min(...sk.map(s => Math.hypot(s.x - o.x, s.z - o.z)));
        samples++; if (d < 1.0) near++;
        if (o.gesture !== 'none' && o.gesture !== 'ready') signals.add(o.gesture);
      }
      const drop = crew.officials.some(o => o.gesture === 'drop');
      const ready = crew.officials.some(o => o.gesture === 'ready');
      if (ready && Number.isNaN(readySince)) readySince = tau;
      if (drop && !wasDrop) { drops++; if (Number.isNaN(readySince) || tau - readySince < .35) late++; }
      if (!ready && !drop) readySince = NaN;
      wasDrop = drop;
    }
  }
  assert.ok(near / samples < .06, `officials within 1 m of a skater ${(near / samples * 100).toFixed(1)}% of the time`);
  assert.ok(drops >= 10, `pucks dropped: ${drops}`);
  assert.ok(late / Math.max(1, drops) < .1, `the official at the dot, set, before the puck drops: late ${late} of ${drops}`);
  if (penalties) assert.ok([...signals].some(g => ['trip', 'hook', 'hold', 'slash', 'interference', 'boarding', 'charging', 'highstick', 'fist'].includes(g)), `penalty signals: ${[...signals].join(', ')}`);
  assert.ok(signals.has('point') || signals.has('goal') || signals.has('armUp'));
});

test('benches stay in the arena when the teams switch ends: changes go through the team\'s own bench door (both rinks)', () => {
  for (const flip of [false, true]) {
    const k = new PlayRink({ home: H, away: A, players: r.players, lineups: [H.lineup, A.lineup], userSide: null, kind: 'reg', periodMinutes: 20, seed: 77, flip }) as any;
    const f = k.frameAt(0);
    void f;
    // bench of the home team in world metres: −6 (arenaBenches), whichever way the teams attack
    const home = k.bench[0], world = toWorld({ x: (flip ? 60 - home.x : home.x) / .6, y: home.y / .3, h: 0 });
    assert.ok(Math.abs(world.x + 6) < .6 && world.z < -13, `played, flip ${flip}: ${world.x.toFixed(1)}`);
    const box = k.box[1], bw = toWorld({ x: (flip ? 60 - box.x : box.x) / .6, y: box.y / .3, h: 0 });
    assert.ok(bw.x > 1.5 && bw.z > 13, `visitors' box, flip ${flip}`);
    const per = periods[flip ? 1 : 0];
    const ai = new RinkAI(per.evs, H, A, r.players, per.start, per.end, { flip }) as any;
    const hb = ai.bench[0], hw = toWorld({ x: (flip ? 60 - hb.x : hb.x) / .6, y: hb.y / .3, h: 0 });
    assert.ok(Math.abs(hw.x + 6) < .6, `spectator, flip ${flip}: ${hw.x.toFixed(1)}`);
  }
});

// ---- the entrance ----
/** Two dressed teams: the starting goalie and five, 16 more skaters, the backup goalie; the visitors' captain is not in the starting five. */
const dressed = (): IntroSkater[] => {
  const out: IntroSkater[] = [];
  for (const side of [0, 1] as const) {
    const end = side ? 1 : -1;
    for (let i = 0; i < 23; i++) {
      const start = i < 6, goalie = i === 0 || i === 22;
      out.push({ id: `${side}-${i}`, side, goalie, start, x: start ? end * (i === 0 ? 26 : 2 + i * 1.5) : 0, z: start ? (i === 0 ? 0 : (i - 3) * 3) : 0,
        seat: start ? null : benchSeat(side, i - 6), captain: side ? i === 9 : i === 3, rating: 60 + ((i * 7) % 23) });
    }
  }
  return out;
};
test('the entrance: the whole team out (visitors first), warm-up laps at an easy pace, the reserves to the bench, the starters and the captain in line', () => {
  const s = dressed(), plan = planIntro(s), T = plan.t;
  const at = (t: number) => introPoses(plan, t);
  const out = (t: number, side: 0 | 1) => s.filter(x => x.side === side && at(t).get(x.id)!.visible).length;
  assert.equal(out(T.away - .1, 1), 0); assert.equal(out(T.away - .1, 0), 0);
  assert.ok(out(T.away + 1, 1) >= 2 && out(T.away + 1, 0) === 0, 'the visitors come out first');
  assert.equal(out(T.home - .1, 0), 0, 'the home team after them');
  // everybody dressed comes out, one after another (the starting goalie first, the backup last)
  assert.equal(lineup(s, 1)[0].id, '1-0'); assert.equal(lineup(s, 1).at(-1)!.id, '1-22');
  const away = s.filter(x => x.side === 1);
  for (const x of away) { const r = plan.route.get(x.id)!; assert.ok(at(r.out + .3).get(x.id)!.visible, `${x.id} skates out`); }
  const first = at(plan.route.get('1-0')!.out + .05).get('1-0')!, gate = gateOf(1);
  assert.ok(Math.hypot(first.x - gate.x, first.z - gate.z) < 1, 'out of the gate');
  // an easy pace: never a sprint, and long strides (the scene paces the legs by the distance)
  let top = 0;
  for (const x of s) { let prev = at(0).get(x.id)!; for (let t = 1 / 30; t < T.length; t += 1 / 30) { const p = at(t).get(x.id)!; if (prev.visible && p.visible && !p.sit && !prev.sit && p.y < .02 && prev.y < .02) { const v = Math.hypot(p.x - prev.x, p.z - prev.z) * 30; top = Math.max(top, v); assert.ok(v < 8.5, `${x.id} at ${t.toFixed(2)}: ${v.toFixed(1)} m/s`); } prev = p; } }
  assert.ok(INTRO_PACE.lap < 6 && top > 3, `pace ${top.toFixed(1)}`);
  // before the presentation: the reserves on their seats, the starters (and the captain who does not start) in line on the blue lines
  const lined = at(T.present + .1);
  for (const x of s) {
    const p = lined.get(x.id)!;
    if (x.start || x.captain) { assert.ok(p.visible && !p.sit && Math.abs(Math.abs(p.x) - (BLUE + .9)) < .3 && p.speed === 0, `${x.id} in line: ${p.x.toFixed(1)}`); assert.equal(Math.sign(p.x), x.side ? 1 : -1); }
    else { assert.ok(p.sit, `${x.id} on the bench`); assert.ok(Math.hypot(p.x - x.seat!.x, p.z - x.seat!.z) < .05); }
  }
  const inLine = s.filter(x => x.start || x.captain);
  for (const a of inLine) for (const b of inLine) if (a !== b) { const p = lined.get(a.id)!, q = lined.get(b.id)!; assert.ok(Math.hypot(p.x - q.x, p.z - q.z) > 1.2); }
  // the close-ups: the visitors' goalie, captain and leader, then the home team's
  assert.deepEqual(plan.shots.map(x => `${x.side}:${x.kind}`), ['1:goalie', '1:captain', '1:leader', '0:goalie', '0:captain', '0:leader']);
  assert.equal(plan.shots[1].id, '1-9'); assert.equal(plan.shots[4].id, '0-3');
  // the captains shake hands with both referees and with each other
  const places = [{ x: 10, z: -12 }, { x: -10, z: 12 }, { x: 8, z: 13 }, { x: -8, z: -13 }];
  const met = new Set<string>();
  for (let t = T.hands; t < T.settle; t += .1) {
    const p = at(t), refs = introOfficials(plan, t, places), ch = p.get('0-3')!, ca = p.get('1-9')!;
    for (const [c, n] of [[ch, 'h'], [ca, 'a']] as const) refs.slice(0, 2).forEach((r, i) => { if (Math.hypot(c.x - r.x, c.z - r.z) < 1.1 && c.shake > .6 && r.gesture === 'shake') met.add(`${n}${i}`); });
    if (Math.hypot(ch.x - ca.x, ch.z - ca.z) < 1.2 && ch.shake > .6 && ca.shake > .6) met.add('caps');
  }
  assert.deepEqual([...met].sort(), ['a0', 'a1', 'caps', 'h0', 'h1'], [...met].join(' '));
  // at the end: the starters exactly at the faceoff places, the visitors' captain on the bench, the officials at their places
  const end = at(T.length);
  for (const x of s) {
    const p = end.get(x.id)!;
    if (x.start) assert.ok(Math.hypot(p.x - x.x, p.z - x.z) < .05, x.id);
    else assert.ok(p.sit, `${x.id} seated at the end`);
  }
  introOfficials(plan, T.length, places).forEach((p, i) => assert.ok(Math.hypot(p.x - places[i].x, p.z - places[i].z) < .05));
  // a smooth skate: no jumps between 30 fps frames (stepping over the boards included)
  for (const x of s) { let prev = at(0).get(x.id)!; for (let t = 1 / 30; t < T.length; t += 1 / 30) { const p = at(t).get(x.id)!; if (prev.visible && p.visible) assert.ok(Math.hypot(p.x - prev.x, p.z - prev.z) < .4, `${x.id} at ${t.toFixed(2)}`); prev = p; } }
  // the show: dark through the entrance, the lights back for the faceoff; whose colours
  assert.ok(introShow(plan, T.home + 1).level > .95 && introShow(plan, T.length).level < .01);
  assert.equal(introShow(plan, T.away + 1).team, 1); assert.equal(introShow(plan, T.home + 1).team, 0);
  // the camera: inside the arena; close to the man in his close-up
  for (let t = 0; t < T.length; t += .25) { const c = introCamera(plan, t); assert.ok(c.pos.y > 1 && Math.abs(c.pos.x) < 40 && Math.abs(c.pos.z) < 32, `camera at ${t}`); }
  for (const shot of plan.shots) { const t = (shot.t0 + shot.t1) / 2, c = introCamera(plan, t), p = at(t).get(shot.id)!; assert.ok(Math.hypot(c.pos.x - p.x, c.pos.z - p.z) < 4.5 && c.fov < 34, shot.kind); }
  assert.ok(T.length > 45, `a proper show (${T.length.toFixed(0)} s), skippable`);
});

// ---- the broadcast between the plays: goal celebrations and replays ----
test('replays: the real frames again with slow motion around the key moment; the moments worth one; TV angles', () => {
  const g = goalReplay(100, 26.6, 'ГОЛ! Петров', 'p');
  assert.equal(replayTau(g, 0), g.from); assert.ok(Math.abs(replayTau(g, replayLength(g)) - g.to) < 1e-9);
  let prev = -Infinity;
  for (let t = 0; t <= replayLength(g); t += .02) { const v = replayTau(g, t); assert.ok(v >= prev - 1e-9); prev = v; }
  // slow around the goal, real time in the build-up
  assert.ok(Math.abs((replayTau(g, 1.1) - replayTau(g, 1)) / .1 - 1) < 1e-6);
  const k = replayLength(g) - (g.to - g.key - SLOW.after) - SLOW.after / SLOW.rate - .1;
  assert.ok(Math.abs((replayTau(g, k + .05) - replayTau(g, k)) / .05 - SLOW.rate) < 1e-6);
  assert.ok(replayLength(g) > GOAL_SHOW.before + GOAL_SHOW.after + 2);
  // which moment: a shot off the post beats a save; nothing when a goal is in the window, nor for routine plays
  const plays: RinkPlay[] = [play(10, 'save', 'Сейв: Иванов', 1), play(11, 'wide', 'Штанга!', 0), play(12, 'freeze', 'Иванов накрывает шайбу', 1)];
  assert.equal(pickMoment(plays, 5, 13)?.kind2, 'post');
  assert.equal(pickMoment([...plays, play(12.5, 'goal', 'ГОЛ!', 0)], 5, 13), null);
  assert.equal(pickMoment([play(10, 'takeaway', 'Отбор', 0), play(11, 'block', 'Блок-шот', 1)], 5, 13), null);
  assert.equal(pickMoment([play(10, 'hit', 'Силовой приём — соперник на льду', 0)], 5, 13)?.kind2, 'hit');
  const m = momentReplay(pickMoment(plays, 5, 13)!, 26.6, 12.4);
  assert.ok(m.from < m.key && m.to <= 12.4 && m.key === 11);
  // the angles: along the play from the side, then the close one behind the net
  assert.equal(replayAngle(g, g.from + .5), 'side'); assert.equal(replayAngle(g, g.key), 'close');
  const side = replayCamera(g, g.from + .5, { x: 10, z: 2 }), close = replayCamera(g, g.key, { x: 24, z: 1 });
  assert.ok(side.pos.z > 12 && side.pos.y < 6, 'a low side camera');
  assert.ok(close.pos.x > 27 && close.pos.x < 30, 'behind the net, inside the glass');
  const c = celebrateCamera(1, { x: 20, z: -5 });
  assert.ok(Math.hypot(c.pos.x - 20, c.pos.z + 5) < 5 && c.pos.y < 2.5, 'the scorer in close-up');
});

console.log(`\n${pass} officials / entrance / replay checks passed`);
