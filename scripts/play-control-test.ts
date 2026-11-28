// The playable rink (the manager controls a skater): AI-vs-AI periods give believable hockey numbers, the rules
// are called, nobody skates inside a net, men on the ice match the manpower, a scripted pad scores and checks,
// and the engine keeps the books of a played game.
// Run: npx tsx scripts/play-control-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { GameSim, type PlayedRecord } from '../src/game/engine';
import { NO_PAD, PlayRink, screenToRink, type PadState, type PlayOut } from '../src/game/playRink';
import { RINK } from '../src/game/rinkGeometry';
import type { Team } from '../src/types';

const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
const P = r.players, teams = r.teams;
let pass = 0;
const test = (name: string, fn: () => void) => { const t = Date.now(); fn(); pass++; console.log('✓', name, `(${((Date.now() - t) / 1000).toFixed(1)} s)`); };
type Priv = { skaters: (s: 0 | 1, withLeaving?: boolean) => { id: string; x: number; y: number; leaving: boolean }[]; manpower: (s: 0 | 1) => number; pulled: [boolean, boolean]; goalieOf: (s: 0 | 1) => unknown; puck: { x: number; y: number; carrier: { id: string; side: 0 | 1 } | null } };
const priv = (k: PlayRink) => k as unknown as Priv;

const pair = (g: number): [Team, Team] => { const H = teams[g % teams.length]; let A = teams[(g * 5 + 3) % teams.length]; if (A.id === H.id) A = teams[(g + 1) % teams.length]; return [H, A]; };
const make = (g: number, extra: Partial<ConstructorParameters<typeof PlayRink>[0]> = {}) => { const [H, A] = pair(g); return new PlayRink({ home: H, away: A, players: P, lineups: [H.lineup, A.lineup], userSide: null, kind: 'reg', periodMinutes: 20, seed: 1000 + g, ...extra }); };

/** Plays a block to its end (or `maxReal` seconds), calling `each` every step. */
function run(k: PlayRink, pad: (k: PlayRink) => PadState = () => NO_PAD, each?: (k: PlayRink, out: PlayOut[]) => void, maxReal = 2400) {
  const all: PlayOut[] = [];
  for (let i = 0; i < maxReal * 60 && !k.ended; i++) { k.advance(1 / 60, pad(k)); const o = k.drain(); all.push(...o); each?.(k, o); }
  return all;
}

test('AI against AI: shots, save %, goals, faceoffs, hits, penalties, icing and offside in the KHL range', () => {
  const tot = { shots: 0, saves: 0, goals: 0, miss: 0, block: 0, fo: 0, hits: 0, pen: 0, icing: 0, offside: 0, periods: 0, clockOk: 0 };
  for (let g = 0; g < 12; g++) {
    const k = make(g);
    const out = run(k);
    assert.ok(k.ended, `period ${g} ended`);
    tot.periods++;
    if (Math.abs(k.clock - 1200) < 0.5) tot.clockOk++;
    for (const o of out) {
      if (o.type === 'shot') { if (o.outcome === 'goal') tot.goals++; else if (o.outcome === 'save') tot.saves++; else if (o.outcome === 'miss') tot.miss++; else tot.block++; }
      if (o.type === 'faceoff') tot.fo++;
      if (o.type === 'hit') tot.hits++;
      if (o.type === 'penalty') tot.pen++;
      if (o.type === 'icing') tot.icing++;
      if (o.type === 'offside') tot.offside++;
    }
    assert.deepEqual(k.score, [out.filter(o => o.type === 'shot' && o.outcome === 'goal' && o.side === 0).length, out.filter(o => o.type === 'shot' && o.outcome === 'goal' && o.side === 1).length]);
    assert.equal(k.shots[0] + k.shots[1], out.filter(o => o.type === 'shot' && (o.outcome === 'goal' || o.outcome === 'save')).length, 'shots on goal = saves + goals');
  }
  const n = tot.periods, onNet = tot.saves + tot.goals;
  const per = (x: number) => (x / n).toFixed(1);
  console.log(`   per period: shots on goal ${per(onNet)}, goals ${per(tot.goals)}, save % ${(tot.saves / onNet).toFixed(3)}, missed ${per(tot.miss)}, blocked ${per(tot.block)}, faceoffs ${per(tot.fo)}, hits ${per(tot.hits)}, penalties ${per(tot.pen)}, icing ${per(tot.icing)}, offside ${per(tot.offside)}`);
  assert.equal(tot.clockOk, n, 'every period runs the full 20:00');
  assert.ok(onNet / n > 12 && onNet / n < 34, `shots on goal per period ${per(onNet)}`);
  assert.ok(tot.saves / onNet > 0.86 && tot.saves / onNet < 0.955, `save % ${(tot.saves / onNet).toFixed(3)}`);
  assert.ok(tot.goals / n > 0.6 && tot.goals / n < 3.5, `goals per period ${per(tot.goals)}`);
  assert.ok(tot.fo / n > 10 && tot.fo / n < 40, `faceoffs per period ${per(tot.fo)}`);
  assert.ok(tot.hits > 0 && tot.pen > 0 && tot.icing > 0 && tot.offside > 0, 'hits, penalties, icing and offside all happen');
  // (12 periods are a small sample: other seeds give 3.3…4.9 for the same engine, so the bound leaves room for that)
  assert.ok(tot.pen / n < 5.2, `penalties per period ${per(tot.pen)}`);
});

test('men on the ice match the manpower, nobody stands inside a net, the puck stays in the rink', () => {
  let frames = 0, tooMany = 0, inNet = 0, puckOut = 0, boxedFrames = 0;
  const cages = [
    { x0: RINK.goalLine - RINK.goalDepth, x1: RINK.goalLine, y0: 15 - RINK.goalWidth / 2, y1: 15 + RINK.goalWidth / 2 },
    { x0: 60 - RINK.goalLine, x1: 60 - RINK.goalLine + RINK.goalDepth, y0: 15 - RINK.goalWidth / 2, y1: 15 + RINK.goalWidth / 2 },
  ];
  for (let g = 0; g < 6; g++) {
    const k = make(g + 20), p = priv(k);
    run(k, undefined, () => {
      if (k.mode !== 'play') return;
      frames++;
      for (const s of [0, 1] as const) {
        const on = p.skaters(s, false).length, want = p.manpower(s) + (p.pulled[s] && !p.goalieOf(s) ? 1 : 0);
        if (on > want) tooMany++;
        if (p.manpower(s) < 5) boxedFrames++;
        for (const a of p.skaters(s)) for (const c of cages) if (a.x > c.x0 + 0.15 && a.x < c.x1 - 0.15 && a.y > c.y0 + 0.15 && a.y < c.y1 - 0.15) inNet++;
      }
      if (p.puck.x < -0.5 || p.puck.x > 60.5 || p.puck.y < -0.5 || p.puck.y > 30.5) puckOut++;
    });
  }
  console.log(`   frames ${frames}: too many men ${(100 * tooMany / frames).toFixed(2)}%, short-handed frames ${boxedFrames}, skaters inside a net ${inNet}, puck out ${puckOut}`);
  assert.ok(tooMany / frames < 0.01, 'too many men on the ice');
  assert.equal(inNet, 0, 'a skater inside a net');
  assert.equal(puckOut, 0, 'the puck left the rink');
});

test('the 3-on-3 overtime is three skaters a side and ends with the first goal', () => {
  let decided = 0, threes = 0, frames = 0;
  for (let g = 0; g < 4; g++) {
    const k = make(g + 40, { kind: 'ot3', period: 4 }), p = priv(k);
    let penalty = false;
    const out = run(k, undefined, (_k, o) => { if (o.some(e => e.type === 'penalty')) penalty = true; if (!penalty && k.mode === 'play' && p.manpower(0) === 3 && p.manpower(1) === 3) { frames++; if (p.skaters(0, false).length <= 3 && p.skaters(1, false).length <= 3) threes++; } });
    const goals = out.filter(o => o.type === 'shot' && o.outcome === 'goal').length;
    assert.ok(goals <= 1, 'sudden death: at most one goal');
    if (goals) { decided++; assert.ok(k.clock < 300, 'the goal ends the overtime early'); } else assert.ok(Math.abs(k.clock - 300) < 0.5, 'a scoreless overtime runs 5:00');
  }
  // a penalty that expires leaves 4-on-4 until the next whistle (the KHL rule): counted only before the first one
  console.log(`   decided ${decided}/4, 3-on-3 frames ${(100 * threes / Math.max(1, frames)).toFixed(1)}%`);
  assert.ok(threes / frames > 0.98, 'three skaters a side');
});

test('the manager controls a skater: the stick moves him, a held shot charges and goes on net, swap changes the man', () => {
  const k = make(60, { userSide: 0 }), p = priv(k);
  let shotsByUser = 0, goalsByUser = 0, swaps = 0, maxPower = 0, prevCtl: string | null = null, moved = 0, checks = 0;
  let phase = 0;
  const pad = (k: PlayRink): PadState => {
    phase++;
    const me = k.ctl ? p.skaters(0).find(a => a.id === k.ctl) : undefined;
    if (!me) return NO_PAD;
    const h = k.hud();
    if (h.context === 'carry') {
      // skate to the slot of the attacked net (+x for side 0, not flipped), then charge a shot for 0.5 s
      const tx = 50, ty = 15, dx = tx - me.x, dy = ty - me.y, d = Math.hypot(dx, dy);
      if (d > 3) return { ...NO_PAD, mx: dx / d, my: dy / d, sprint: d > 12 };
      return { ...NO_PAD, mx: 1, my: 0, shoot: phase % 40 < 30 };
    }
    if (h.context === 'defend') {
      const pk = p.puck, dx = pk.x - me.x, dy = pk.y - me.y, d = Math.hypot(dx, dy) || 1;
      return { ...NO_PAD, mx: dx / d, my: dy / d, sprint: true, shoot: d < 2.2 && phase % 50 < 4, deke: d < 2 && phase % 30 === 0, pass: d > 14 && phase % 120 === 0 };
    }
    return { ...NO_PAD, mx: 0.6, my: 0 };
  };
  let lastX = 0;
  run(k, pad, (k, out) => {
    const h = k.hud();
    maxPower = Math.max(maxPower, h.power);
    if (k.ctl && prevCtl && k.ctl !== prevCtl) swaps++;
    prevCtl = k.ctl;
    const me = k.ctl ? p.skaters(0).find(a => a.id === k.ctl) : undefined;
    if (me && k.mode === 'play') { if (Math.abs(me.x - lastX) > 0) moved++; lastX = me.x; }
    for (const o of out) {
      if (o.type === 'shot' && o.side === 0 && o.shooter && (o.outcome === 'goal' || o.outcome === 'save')) shotsByUser++;
      if (o.type === 'shot' && o.side === 0 && o.outcome === 'goal') goalsByUser++;
      if (o.type === 'hit' && o.side === 0) checks++;
    }
  }, 720);
  console.log(`   shots ${shotsByUser}, goals ${goalsByUser}, max power ${maxPower.toFixed(2)}, control switches ${swaps}, hits ${checks}, score ${k.score.join(':')}`);
  assert.ok(k.ctl !== null, 'a controlled skater');
  assert.ok(moved > 1000, 'the controlled skater skates');
  assert.ok(maxPower > 0.5, 'a held shot charges');
  assert.ok(shotsByUser >= 4, 'the manager\'s team shoots on net');
  assert.ok(swaps > 0, 'control follows the play (the puck carrier, the nearest defender)');
});

test('the skill stick (right stick / touch): pull back and flick — slap or snap, a flick — wrist shot, sideways — dekes, a circle — spin-o-rama, a flick on defence — a poke', () => {
  const k = make(61, { userSide: 0 }), p = priv(k);
  const proto = k as unknown as { shoot: (...a: unknown[]) => void; deke: (...a: unknown[]) => void; startPoke: (...a: unknown[]) => void };
  const powers: number[] = [];
  const shots: Record<string, number> = {}, dekes: Record<string, number> = {}, through: Record<string, number> = {};
  let pokes = 0;
  const shoot = proto.shoot.bind(k), deke = proto.deke.bind(k), startPoke = proto.startPoke.bind(k);
  proto.shoot = (a: unknown, ...x: unknown[]) => { if ((a as { id: string }).id === k.ctl) { const kd = String(x[3] ?? 'button'); shots[kd] = (shots[kd] ?? 0) + 1; if (gesture % 8 === 7) through[kd] = (through[kd] ?? 0) + 1; if (kd !== 'tip') powers.push(Number(x[0])); } return shoot(a, ...x); };
  proto.deke = (a: unknown, ...x: unknown[]) => { if ((a as { id: string }).id === k.ctl) { const kd = String(x[3] ?? 'side'); dekes[kd] = (dekes[kd] ?? 0) + 1; } return deke(a, ...x); };
  proto.startPoke = (a: unknown) => { if ((a as { id: string }).id === k.ctl) pokes++; return startPoke(a); };
  let f = 0, gesture = 0;
  // one gesture every 90 frames, cycling (screen terms, NHL style: down = back, up = forward): slap (held down 40
  // frames, then up), wrist flick up, side flick, side then back the other way, circle, down then sideways, fake,
  // and a slap swung straight through the centre (a frame or two at rest on the way must not make it a fake)
  const script = (t: number): [number, number] => {
    const g = gesture % 8;
    if (g === 0) return t < 10 ? [0, 0] : t < 50 ? [0, 1] : t < 56 ? [0, -1] : [0, 0];
    if (g === 1) return t < 10 ? [0, 0] : t < 15 ? [0.1, -1] : [0, 0];
    if (g === 2) return t < 10 ? [0, 0] : t < 15 ? [1, 0] : [0, 0];
    if (g === 3) return t < 10 ? [0, 0] : t < 14 ? [1, 0] : t < 17 ? [0, 0] : t < 21 ? [-1, 0] : [0, 0];
    if (g === 4) { if (t < 10 || t > 40) return [0, 0]; const a = ((t - 10) / 26) * Math.PI * 2.3; return [Math.cos(a), Math.sin(a)]; }
    if (g === 5) return t < 10 ? [0, 0] : t < 30 ? [0, 1] : t < 36 ? [1, 0] : [0, 0];
    if (g === 6) return t < 10 ? [0, 0] : t < 40 ? [0, 1] : [0, 0];
    return t < 10 ? [0, 0] : t < 35 ? [0, 1] : t < 38 ? [0, 0] : t < 44 ? [0, -1] : [0, 0];
  };
  const pad = (k: PlayRink): PadState => {
    f++;
    const me = k.ctl ? p.skaters(0).find(a => a.id === k.ctl) : undefined;
    if (!me) return NO_PAD;
    const h = k.hud();
    if (h.context === 'carry') {
      const tx = 44, ty = 15, dx = tx - me.x, dy = ty - me.y, d = Math.hypot(dx, dy);
      const t = f % 90; if (t === 0) gesture++;
      const [sx, sy] = script(t);
      return { ...NO_PAD, mx: d > 2 ? dx / d * 0.6 : 0, my: d > 2 ? dy / d * 0.6 : 0, sx, sy };
    }
    if (h.context === 'defend') {
      const pk = p.puck, dx = pk.x - me.x, dy = pk.y - me.y, d = Math.hypot(dx, dy) || 1;
      const t = f % 30;
      return { ...NO_PAD, mx: dx / d, my: dy / d, sprint: true, sx: d < 2.5 && t > 10 && t < 15 ? dx / d : 0, sy: d < 2.5 && t > 10 && t < 15 ? dy / d : 0 };
    }
    return { ...NO_PAD, mx: 0.6, my: 0 };
  };
  run(k, pad, undefined, 600);
  console.log('   shots', JSON.stringify(shots), 'through the centre', JSON.stringify(through), 'dekes', JSON.stringify(dekes), 'pokes', pokes, 'min power', Math.min(...powers).toFixed(2));
  assert.ok((shots.slap ?? 0) + (shots.snap ?? 0) > 0, 'pull back and flick: a slap / snap shot');
  assert.ok((through.slap ?? 0) + (through.snap ?? 0) > 0, 'a slap swung through the centre still goes');
  assert.ok(Math.min(...powers) >= 0.6, 'skill-stick shots are hard (no weak shot from a full gesture)');
  assert.ok((shots.wrist ?? 0) > 0, 'a forward flick: a wrist shot');
  for (const kd of ['side', 'between', 'spin', 'toe', 'fake']) assert.ok((dekes[kd] ?? 0) > 0, `skill-stick deke ${kd}`);
  assert.ok(pokes > 0, 'a flick on defence pokes');
});

test('the one-timer: wound up while the pass comes, swung through as it arrives — off the pass; held — the slap from the blade; swung far too early — a whiff', () => {
  type Ag = { id: string; side: 0 | 1; x: number; y: number; fa: number; vx: number; vy: number; act: { k: string } | null; on: string; goalie: boolean; oneTimer: boolean };
  type Raw = { agents: Map<string, Ag>; puck: { x: number; y: number; vx: number; vy: number; carrier: Ag | null; passTo: Ag | null }; mode: string; tau: number; ctl: string | null; passTo: (a: Ag, m: Ag, saucer: boolean) => void; shoot: (...a: unknown[]) => void };
  const trial = (seed: number, plan: 'timed' | 'hold' | 'early' | 'button') => {
    const k = make(seed, { userSide: 0 }), raw = k as unknown as Raw;
    for (let i = 0; i < 60 * 20 && raw.mode !== 'play'; i++) k.advance(1 / 60, NO_PAD);
    assert.equal(raw.mode, 'play');
    const mine = [...raw.agents.values()].filter(a => a.side === 0 && !a.goalie && a.on === 'ice');
    const me = mine[0], mate = mine[1];
    // the slot, the passer on the half wall, the opponents out of the way
    Object.assign(me, { x: 47, y: 13, vx: 0, vy: 0, fa: 0, act: null }); Object.assign(mate, { x: 41, y: 4, vx: 0, vy: 0, fa: 1.2, act: null });
    for (const o of raw.agents.values()) if (o.side === 1 && !o.goalie && o.on === 'ice') Object.assign(o, { x: 8, y: 15, vx: 0, vy: 0 });
    raw.puck.carrier = mate; raw.puck.x = mate.x; raw.puck.y = mate.y;
    // (in the zone already: no offside on the teleported men)
    (k as unknown as { zoneIn: boolean[] }).zoneIn = [true, true];
    raw.passTo(mate, me, false); raw.ctl = me.id;
    const shots: { kind: string; power: number; at: number }[] = [];
    const shoot = raw.shoot.bind(k);
    raw.shoot = (a: unknown, ...x: unknown[]) => { if ((a as Ag).id === me.id) shots.push({ kind: String(x[3] ?? ''), power: Number(x[0]), at: raw.tau }); return shoot(a, ...x); };
    let got = -1, move: string | null = null, frames = 0;
    for (let i = 0; i < 150 && !shots.length; i++) {
      const pk = raw.puck, eta = Math.hypot(pk.x - me.x, pk.y - me.y) / Math.max(1, Math.hypot(pk.vx, pk.vy));
      const has = pk.carrier === me;
      if (has && got < 0) got = raw.tau;
      if (has && got >= 0) frames++;
      let sy = 0, shootBtn = false;
      if (plan === 'timed') sy = !has && eta > 0.12 ? 1 : -1;
      else if (plan === 'hold') sy = !has || frames < 20 ? 1 : -1;
      else if (plan === 'early') sy = i < 8 ? 1 : i < 12 ? -1 : 0;
      else shootBtn = !has || frames < 20;
      if (has && frames === 10) move = k.hud().move;
      k.advance(1 / 60, { ...NO_PAD, sx: 0, sy, shoot: shootBtn });
    }
    return { shots, got, move, frames };
  };
  const timed = trial(71, 'timed');
  assert.ok(timed.got >= 0 && timed.shots.length === 1 && timed.shots[0].at - timed.got < 0.05, `timed: off the pass (${JSON.stringify(timed)})`);
  assert.ok(timed.shots[0].power >= 0.6 && ['slap', 'snap'].includes(timed.shots[0].kind), 'a hard one-timer');
  const hold = trial(72, 'hold');
  assert.ok(hold.got >= 0 && hold.shots.length === 1 && hold.shots[0].at - hold.got > 0.25 && hold.shots[0].kind === 'slap' && hold.shots[0].power > 0.9, `held: the slap from the blade when he swings (${JSON.stringify(hold)})`);
  assert.match(hold.move ?? '', /касание/, 'the HUD says the one-timer is loaded');
  const early = trial(73, 'early');
  assert.ok(early.got >= 0 && early.shots.length === 0, `swung far too early: no shot off the pass (${JSON.stringify(early)})`);
  const button = trial(74, 'button');
  assert.ok(button.got >= 0 && button.shots.length === 1 && button.shots[0].at - button.got > 0.25, `the shot button held through the pass: the release shoots (${JSON.stringify(button)})`);
});

test('the special-teams clock: like the period, real time (a minor is two real minutes), or real time ×2 / ×4', () => {
  const rate = (pc: 'period' | 'real' | 2 | 4, mins: number, pen: boolean) => {
    const [H, A] = [teams[0], teams[1]];
    const id = H.lineup.F[0][0]!;
    const k = new PlayRink({ home: H, away: A, players: P, lineups: [H.lineup, A.lineup], userSide: null, kind: 'reg', periodMinutes: mins, seed: 7, penaltyClock: pc, box: pen ? [[[id, 600]], []] : undefined });
    for (let i = 0; i < 60 * 30 && k.mode !== 'play'; i++) k.advance(1 / 60, NO_PAD);
    const c0 = k.clock; let n = 0;
    for (let i = 0; i < 60 * 3; i++) { const was = k.mode === 'play'; const c = k.clock; k.advance(1 / 60, NO_PAD); if (was && k.mode === 'play' && k.clock > c) n++; }
    return n ? (k.clock - c0) / (n / 60) : NaN;
  };
  const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < b * 0.08, `${what}: ${a.toFixed(2)} vs ${b}`);
  near(rate('period', 5, true), 4, 'like the period: 4 clock seconds a second on a 5-minute period');
  near(rate('real', 5, true), 1, 'real time on the power play');
  near(rate(2, 5, true), 2, '×2');
  near(rate(4, 3, true), 4, '×4');
  near(rate(4, 8, true), 2.5, 'never faster than the period itself');
  near(rate('real', 5, false), 4, 'even strength: the period clock');
});

test('the manager\'s poke check takes the puck onto his stick; the skill stick carries the puck; the aim marker follows the mouse', () => {
  const k = make(63, { userSide: 0 }), p = priv(k);
  type Ag = { id: string; side: 0 | 1; x: number; y: number; fa: number; vx: number; vy: number; act: unknown; cool: number; manual: boolean; stun: number; on: string; goalie: boolean };
  const raw = k as unknown as { agents: Map<string, Ag>; puck: { x: number; y: number; carrier: Ag | null; dead: boolean }; resolvePoke: (a: Ag) => void; mode: string; tau: number };
  run(k, () => NO_PAD, undefined, 3);
  const mine = [...raw.agents.values()].filter(a => a.side === 0 && !a.goalie && a.on === 'ice'), theirs = [...raw.agents.values()].filter(a => a.side === 1 && !a.goalie && a.on === 'ice');
  const me = mine[0], c = theirs[0];
  let took = 0, loose = 0;
  for (let i = 0; i < 60; i++) {
    c.x = 30; c.y = 15; c.fa = Math.PI; c.vx = c.vy = 0; c.act = null; c.stun = 0;
    me.x = 31.6; me.y = 15; me.fa = Math.PI; me.vx = me.vy = 0; me.manual = true; me.stun = 0;
    raw.puck.carrier = c; raw.puck.dead = false; raw.puck.x = 29.3; raw.puck.y = 15; raw.mode = 'play';
    // facing the carrier from in front: a poke, not a lift
    me.x = 28.4; me.fa = 0;
    me.act = { k: 'poke', t0: raw.tau, done: true, lift: false };
    raw.resolvePoke(me);
    if (raw.puck.carrier === me) took++; else if (raw.puck.carrier === null) loose++;
  }
  console.log(`   pokes: onto his stick ${took}, knocked loose ${loose}`);
  assert.ok(took > 0 && took > loose, 'a successful poke mostly gives the puck to the poker');
  // stickhandling and the aim marker: his man with the puck in the zone
  k.ctl = me.id; me.x = 48; me.y = 15; me.fa = 0; me.vx = me.vy = 0; me.act = null; me.cool = 0;
  raw.puck.carrier = me; raw.puck.dead = false; raw.mode = 'play';
  // skating down the screen (across the rink): the stick eased to the right of the screen (a quick flick would be
  // a deke) puts the puck on that side
  const lateral = (sx: number) => {
    for (let i = 0; i < 45; i++) {
      me.x = 48; me.y = 15; me.fa = Math.PI / 2; me.vx = me.vy = 0; me.act = null; raw.puck.carrier = me; raw.mode = 'play';
      k.advance(1 / 60, { ...NO_PAD, sx: i < 5 ? 0 : Math.sign(sx) * Math.min(Math.abs(sx), 0.3 + (i - 5) * 0.015), sy: 0 });
    }
    return raw.puck.x - me.x;
  };
  const r = lateral(0.9), l = lateral(-0.9);
  console.log(`   stickhandling: stick right ${r.toFixed(2)}, left ${l.toFixed(2)}`);
  assert.ok(r > 0.25 && l < -0.25, 'the skill stick held to a side carries the puck there');
  const marker = (y: number) => { me.x = 48; me.y = 15; me.vx = me.vy = 0; raw.puck.carrier = me; raw.mode = 'play'; k.advance(1 / 60, { ...NO_PAD, aimAt: { x: 56, y } }); return k.aimMarker(); };
  const up = marker(12), down = marker(18);
  assert.ok(up && down, 'the aim marker is shown with the puck in the zone');
  assert.ok(up!.z < -0.3 && down!.z > 0.3, `the marker follows the cursor across the net (${up!.z.toFixed(2)} / ${down!.z.toFixed(2)})`);
  assert.ok(Math.abs(Math.abs(up!.x) - (RINK.length / 2 - RINK.goalLine)) < 0.01, 'the marker sits on the goal line');
});

test('skating backwards: back first (not side-on); the manager\'s defender backs up by himself before a rush and turns once beaten', () => {
  const k = make(64, { userSide: 0, autoSwitch: false });
  run(k, () => NO_PAD, undefined, 3);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const raw = k as any;
  const mine = [...raw.agents.values()].filter((a: any) => a.side === 0 && !a.goalie && a.on === 'ice'), theirs = [...raw.agents.values()].filter((a: any) => a.side === 1 && !a.goalie && a.on === 'ice');
  const me = mine[0], c = theirs[0];
  for (const a of [...mine, ...theirs]) if (a !== me && a !== c) { a.x = a.side ? 55 : 5; a.y = a.side ? 28 : 2; a.vx = a.vy = 0; }
  const ang = (x: number, y: number) => { let d = y - x; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return Math.abs(d); };
  const setup = () => {
    raw.mode = 'play'; raw.ctl = me.id; raw.puck.dead = false; raw.puck.shot = null; raw.puck.passTo = null;
    me.x = 24; me.y = 15; me.vx = -3; me.vy = 0; me.fa = Math.PI; me.act = null; me.stun = 0; me.fall = 0; me.cool = 9e9;
    c.x = 36; c.y = 15; c.vx = -6; c.vy = 0; c.fa = Math.PI; c.act = null; c.stun = 0; c.cool = 9e9;
    raw.puck.carrier = c;
  };
  // a rush coming at him, the stick pulled back toward his own net: he turns round and backs up, facing the man
  setup();
  let backed = 0;
  for (let i = 0; i < 60; i++) {
    c.x = 36 - 6 * (i + 1) / 60; c.y = 15; c.vx = -6; c.vy = 0; c.act = null; raw.puck.carrier = c; raw.puck.x = c.x - 0.8; raw.puck.y = 15;
    k.advance(1 / 60, { ...NO_PAD, mx: -1, my: 0 });
    if (me.back) backed++;
  }
  assert.ok(backed > 50, `backs up by himself before the rush (${backed}/60)`);
  assert.ok(Math.cos(me.fa) > 0.8, `facing up the ice at the man (fa ${me.fa.toFixed(2)})`);
  // beaten: the carrier level with him — he turns and races back forwards
  c.x = me.x - 1.5; raw.puck.x = c.x - 0.8;
  for (let i = 0; i < 60; i++) { c.x -= 6 / 60; c.vx = -6; raw.puck.carrier = c; raw.puck.x = c.x - 0.8; k.advance(1 / 60, { ...NO_PAD, mx: -1, my: 0 }); }
  assert.ok(!me.back, 'beaten, he skates forwards again');
  assert.ok(Math.cos(me.fa) < -0.8, `turned toward his own net (fa ${me.fa.toFixed(2)})`);
  // the stick up the ice at the carrier: he goes to meet him forwards
  setup(); me.vx = 0;
  for (let i = 0; i < 30; i++) { c.x = 36; c.vx = -1.5; raw.puck.carrier = c; k.advance(1 / 60, { ...NO_PAD, mx: 1, my: 0 }); }
  assert.ok(!me.back, 'stepping up to the man is skating forwards');
  // backing up across the ice (vision control held): his back the way he goes, not side-on to it
  setup(); me.vx = 0; me.vy = 0; me.fa = 0;
  for (let i = 0; i < 90; i++) { c.x = 36; c.y = 15; c.vx = 0; c.vy = 0; raw.puck.carrier = c; k.advance(1 / 60, { ...NO_PAD, mx: -0.3, my: 1, vision: true }); }
  const rev = Math.atan2(-me.vy, -me.vx);
  console.log(`   backing up across: moving ${Math.atan2(me.vy, me.vx).toFixed(2)}, facing ${me.fa.toFixed(2)} (puck at ${Math.atan2(15 - me.y, 36 - me.x).toFixed(2)})`);
  assert.ok(ang(me.fa, rev) < 0.45, 'his back the way he goes');
});

test('difficulty changes only the opponents: a star AI beats a rookie AI more often', () => {
  let rookieGoals = 0, starGoals = 0;
  for (let g = 0; g < 4; g++) {
    for (const d of ['rookie', 'star'] as const) {
      const k = make(70 + g, { userSide: 0, difficulty: d });
      run(k, () => NO_PAD, undefined, 1300);
      if (d === 'rookie') rookieGoals += k.score[1]; else starGoals += k.score[1];
    }
  }
  console.log(`   opponents' goals against an idle manager: rookie ${rookieGoals}, star ${starGoals}`);
  assert.ok(starGoals >= rookieGoals, 'the star AI is at least as dangerous');
});

test('presentation: frames, flip mirroring, the clock, goal clips and the 3D stick mapping', () => {
  const k = make(80, { flip: true });
  let goalTau = -1;
  run(k, undefined, (k, out) => { for (const o of out) if (o.type === 'shot' && o.outcome === 'goal' && goalTau < 0) goalTau = k.tau; }, 1300);
  const f = k.frameAt(k.tau - 1);
  assert.ok(f.skaters.length >= 8, 'skaters drawn');
  assert.ok(f.puck.x >= -2 && f.puck.x <= 102 && f.puck.y >= -2 && f.puck.y <= 102, 'puck in rink percent');
  const g0 = f.skaters.find(s => s.goalie && s.side === 0);
  if (g0) assert.ok(g0.pos.x > 50, 'flipped: the home goalie is drawn at the right end');
  assert.ok(k.clockAt(k.tau) <= 1200 && k.clockAt(k.tau / 2) < k.clockAt(k.tau), 'clock grows');
  assert.deepEqual(screenToRink(1, 0, 'broadcast', 50), { x: 1, y: 0 });
  const e = screenToRink(0, -1, 'end', 80);
  assert.ok(Math.abs(e.x - -1) < 1e-9 && Math.abs(e.y) < 1e-9, 'end camera: up the screen is along the rink');
  if (goalTau >= 0 && k.tau - goalTau < 11) {
    const g = k.goalsFor[k.goalsFor.length - 1];
    const clip = k.goalClip(g.tau);
    assert.ok(clip && clip.tracks.length >= 6 && clip.goal > 0.5, 'goal clip');
  }
});

test('the engine keeps the books of a played game: periods, shots, goals, penalties, result', () => {
  const [H, A] = pair(90);
  const sim = new GameSim(H, A, P);
  let box: [[string, number][], [string, number][]] | undefined;
  for (let per = 1; per <= 3; per++) {
    sim.beginPlayed('reg');
    const blockStart = sim.sec;
    const k = new PlayRink({ home: H, away: A, players: P, lineups: [H.lineup, A.lineup], userSide: null, kind: 'reg', periodMinutes: 20, seed: 900 + per, flip: per === 2, period: per, score: [sim.score[0], sim.score[1]], box: box && [box[0].map(([id, end]) => [id, end - blockStart]), box[1].map(([id, end]) => [id, end - blockStart])] });
    run(k, undefined, (k, out) => {
      for (const o of out) {
        if (o.type === 'shot') sim.recordPlayed(k.clock, { ...o, shotType: o.shotType === 'rebound' ? 'wrist' : o.shotType } as PlayedRecord);
        else if (o.type === 'penalty' || o.type === 'hit') sim.recordPlayed(k.clock, o as PlayedRecord);
      }
    });
    sim.endPlayed(1200);
    box = sim.playedBox();
    assert.deepEqual([sim.score[0], sim.score[1]], k.score, 'the books match the rink');
  }
  assert.equal(sim.period, 3);
  assert.ok(sim.status === 'done' || sim.status === 'ot', `status ${sim.status}`);
  if (sim.status === 'ot') { sim.beginPlayed('ot3'); sim.endPlayed(300); if (sim.status === 'so') sim.simShootout(); }
  const res = sim.result();
  assert.ok(res.homeScore !== res.awayScore, 'a winner');
  assert.ok(res.homeStats.shots > 10 && res.awayStats.shots > 10, `shots ${res.homeStats.shots}:${res.awayStats.shots}`);
  const goals = sim.events.filter(e => e.type === 'goal').length;
  assert.ok(goals >= Math.min(res.homeScore, res.awayScore), 'goal events');
});

test('a played period followed by simulated ones (the manager hands the rest of the match to the engine)', () => {
  const [H, A] = pair(91);
  const sim = new GameSim(H, A, P);
  sim.beginPlayed('reg');
  const k = new PlayRink({ home: H, away: A, players: P, lineups: [H.lineup, A.lineup], userSide: 0, kind: 'reg', periodMinutes: 3, seed: 5, period: 1 });
  run(k, () => ({ ...NO_PAD, mx: 1 }), (k, out) => { for (const o of out) if (o.type === 'shot' || o.type === 'penalty' || o.type === 'hit') sim.recordPlayed(k.clock, o as PlayedRecord); }, 30);
  k.runToEnd();
  for (const o of k.drain()) if (o.type === 'shot' || o.type === 'penalty' || o.type === 'hit') sim.recordPlayed(k.clock, o as PlayedRecord);
  assert.ok(k.ended && Math.abs(k.clock - 1200) < 0.5, 'runToEnd finishes the period');
  sim.endPlayed(k.clock);
  assert.deepEqual([sim.score[0], sim.score[1]], k.score);
  let guard = 0;
  while (sim.status !== 'done' && guard++ < 12) { if (sim.status === 'playing') sim.simPeriod(); else if (sim.status === 'ot') sim.simOT(); else sim.simShootout(); }
  const res = sim.result();
  assert.equal(res.periodScores.length >= 3, true);
  assert.ok(res.homeScore !== res.awayScore);
  assert.ok(res.periodScores[0][0] === k.score[0] && res.periodScores[0][1] === k.score[1], 'the played period is in the box score');
});

test('a short period: the faceoff button skips the walk-up to the dot; without it the men skate there', () => {
  type Fo = { mode: string; tau: number; fo: { gather: boolean; spots: Map<string, { x: number; y: number }> } | null; agents: Map<string, { x: number; y: number; on: string }> };
  const gathers = (skip: boolean) => {
    const k = make(0, { periodMinutes: 5, userSide: 0 }), p = k as unknown as Fo;
    const out: number[] = []; let t0 = -1;
    for (let i = 0; i < 60 * 60 * 5 && !k.ended; i++) {
      k.advance(1 / 60, { ...NO_PAD, faceoff: skip && p.mode === 'faceoff' && !!p.fo?.gather && i % 2 === 0 });
      if (p.mode === 'faceoff' && p.fo?.gather && t0 < 0) t0 = p.tau;
      if (t0 >= 0 && (p.mode !== 'faceoff' || !p.fo?.gather)) {
        out.push(p.tau - t0); t0 = -1;
        if (p.fo) for (const [id, sp] of p.fo.spots) { const a = p.agents.get(id)!; if (a.on === 'ice') assert.ok(Math.hypot(a.x - sp.x, a.y - sp.y) < 1.3, 'set at his place'); }
      }
    }
    return out.slice(1);
  };
  const slow = gathers(false), fast = gathers(true);
  assert.ok(slow.length >= 3 && fast.length >= 3, `${slow.length} / ${fast.length} faceoffs`);
  assert.ok(slow.reduce((a, b) => a + b, 0) / slow.length > 2, 'they skate to the dot');
  assert.ok(Math.max(...fast) < 0.1, `skipped: ${fast.map(x => x.toFixed(2)).join(' ')}`);
});

test('the manager\'s aim: the mouse on the net puts the shot there (height too); the stick\'s shot goes where the marker showed', () => {
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const one = (trial: number, mouse: boolean) => {
    const k = make(trial, { userSide: 0, autoSwitch: false }), p = k as any;
    for (let i = 0; i < 600 && k.mode !== 'play'; i++) k.advance(1 / 60);
    const me = p.skaters(0).find((x: any) => !x.kindD);
    p.ctl = me.id;
    for (const a of p.onIce()) if (a !== me && !a.goalie) { a.x = a.side ? 52 : 8; a.y = a.side ? 27 : 3; a.vx = 0; a.vy = 0; a.act = null; }
    const gx = RINK.length - RINK.goalLine;
    Object.assign(me, { x: gx - 9 - (trial % 4) * 2, y: 15 + (trial % 3 - 1) * 4, vx: 4, vy: 0, fa: 0, act: null, cool: 0, stun: 0 });
    p.puck.carrier = me; p.puck.dead = false; p.puck.passTo = null; p.mode = 'play';
    const aimAt = { x: gx, y: 15 + ((trial * 7) % 5 - 2) * 0.3, h: 0.3 + (trial % 4) * 0.2 };
    let shot = null, mark: { x: number; y: number; z: number } | null = null;
    for (let i = 0; i < 90 && !shot; i++) {
      mark = k.aimMarker() ?? mark;
      k.advance(1 / 60, mouse ? { ...NO_PAD, aimAt, shoot: i < 3 } : { ...NO_PAD, mx: 0.6, my: [-0.9, -0.5, 0, 0.5, 0.9][trial % 5], shoot: i < (trial % 2 ? 3 : 40) });
      shot = p.puck.shot;
    }
    assert.ok(shot && mark, 'shot with the marker up');
    const q = p.puck, T = (gx - q.x) / q.vx, y = q.y + q.vy * T, h = q.h + q.vh * T - 0.5 * 9.81 * T * T, w = p.world({ x: gx, y });
    return mouse ? { lat: Math.abs(y - aimAt.y), up: Math.abs(h - aimAt.h) } : { lat: Math.hypot(w.x - mark!.x, w.z - mark!.z), up: Math.abs(h - mark!.y) };
  };
  for (const mouse of [true, false]) {
    const r = Array.from({ length: 30 }, (_, i) => one(i, mouse));
    const lat = avg(r.map(x => x.lat)), up = avg(r.map(x => x.up));
    console.log(`   ${mouse ? 'mouse' : 'stick'}: off the aim by ${lat.toFixed(2)} m across, ${up.toFixed(2)} m in height`);
    assert.ok(lat < 0.14 && up < 0.12, 'close to the aim');
  }
});

test('a shot pressed while he cannot shoot yet (the end of a deke) still goes off as soon as he can — not lost', () => {
  let fired = 0;
  for (let trial = 0; trial < 8; trial++) {
    const k = make(trial, { userSide: 0, autoSwitch: false }), p = k as any;
    for (let i = 0; i < 600 && k.mode !== 'play'; i++) k.advance(1 / 60);
    const me = p.skaters(0).find((x: any) => !x.kindD);
    p.ctl = me.id;
    for (const a of p.onIce()) if (a !== me && !a.goalie) { a.x = a.side ? 52 : 8; a.y = a.side ? 27 : 3; a.vx = 0; a.vy = 0; a.act = null; }
    Object.assign(me, { x: 44, y: 15, vx: 3, vy: 0, fa: 0, act: null, cool: 0, stun: 0 });
    p.puck.carrier = me; p.puck.dead = false; p.puck.passTo = null; p.mode = 'play';
    k.advance(1 / 60, { ...NO_PAD, deke: true }); k.advance(1 / 60, NO_PAD);
    assert.ok(me.cool > p.tau, 'in the deke');
    // a quick tap 0.15 s before he could shoot again
    while (me.cool - p.tau > 0.15) k.advance(1 / 60, NO_PAD);
    k.advance(1 / 60, { ...NO_PAD, shoot: true }); k.advance(1 / 60, { ...NO_PAD, shoot: true }); k.advance(1 / 60, NO_PAD);
    for (let i = 0; i < 40 && !p.puck.shot; i++) k.advance(1 / 60, NO_PAD);
    if (p.puck.shot?.by === me) fired++;
  }
  assert.equal(fired, 8, `${fired}/8 shots`);
});

test('a shot from his own end: not a lob that drops onto the net — a low slider that often misses, or a clear where he aims', () => {
  for (const mode of ['net', 'wide'] as const) {
    const res: Record<string, number> = {}; let peak = 0;
    for (let trial = 0; trial < 30; trial++) {
      const k = make(trial, { userSide: 0, autoSwitch: false }), p = k as any;
      for (let i = 0; i < 600 && k.mode !== 'play'; i++) k.advance(1 / 60);
      const me = p.skaters(0).find((x: any) => !x.kindD);
      p.ctl = me.id;
      for (const a of p.onIce()) if (a !== me && !a.goalie) { a.x = a.side ? 52 : 8; a.y = a.side ? 27 : 3; a.vx = 0; a.vy = 0; a.act = null; }
      Object.assign(me, { x: 8 + (trial % 4) * 4, y: 8 + (trial % 5) * 3.5, vx: 3, vy: 0, fa: 0, act: null, cool: 0, stun: 0 });
      p.puck.carrier = me; p.puck.dead = false; p.puck.passTo = null; p.mode = 'play';
      const pad = mode === 'net' ? { ...NO_PAD, mx: 1, my: 0 } : { ...NO_PAD, mx: 0.5, my: trial % 2 ? 0.9 : -0.9 };
      let out = 'none';
      for (let i = 0; i < 60 * 6; i++) {
        k.advance(1 / 60, { ...pad, shoot: i > 2 && i < 30 });
        if (p.puck.shot) peak = Math.max(peak, p.puck.h);
        for (const e of k.drain()) if (e.type === 'shot') out = e.outcome;
        if (k.mode !== 'play' && out !== 'none') break;
      }
      res[out] = (res[out] ?? 0) + 1;
    }
    console.log(`   ${mode}: ${JSON.stringify(res)}, highest ${peak.toFixed(2)} m`);
    assert.ok(peak < 0.5, 'low, not lobbed');
    assert.ok(!res.goal, 'no goal from his own end on a goalie in his net');
    if (mode === 'net') assert.ok((res.miss ?? 0) >= 6, 'it often misses the net');
    else assert.ok(!res.save && !res.miss, 'aimed away from the net: a clear, not a shot');
  }
});

test('passes lead the receiver: a man skating on takes it in stride (keeps most of his speed), the puck in front of him', () => {
  let n = 0, keep = 0, ahead = 0, all = 0, done = 0;
  for (let g = 0; g < 2; g++) {
    const k = make(g + 70), p = k as any;
    const sent = new Map<string, { v: number; vx: number; vy: number; leg: number }>();
    const oPass = p.passTo.bind(p), oTake = p.take.bind(p);
    p.passTo = (a: any, m: any, s: boolean, pw?: number) => { const had = p.puck.carrier === a; oPass(a, m, s, pw); if (had && p.puck.passTo === m) { all++; sent.set(m.id, { v: Math.hypot(m.vx, m.vy), vx: m.vx, vy: m.vy, leg: p.puck.leg }); } };
    p.take = (a: any, i: boolean) => {
      const q = p.puck, r = sent.get(a.id);
      if (r && q.passTo === a && q.passBy?.side === a.side && r.leg === q.leg) {
        sent.delete(a.id); done++;
        if (r.v > 2.5) { n++; keep += Math.hypot(a.vx, a.vy) / r.v; if ((q.x - a.x) * r.vx + (q.y - a.y) * r.vy > 0) ahead++; }
      }
      oTake(a, i);
    };
    k.runToEnd();
  }
  console.log(`   ${all} passes, ${done} straight onto the stick; to men skating: ${n}, speed kept ${(keep / n * 100).toFixed(0)}%, the puck in front ${(ahead / n * 100).toFixed(0)}%`);
  assert.ok(n > 200);
  assert.ok(keep / n > 0.6, 'taken in stride, not stopping for it');
  assert.ok(ahead / n > 0.5, 'the puck in front of him');
  assert.ok(done / all > 0.55, 'most passes arrive');
});

test('the goalie: a save is made where the puck gets to him (no jump into his glove, none metres away), a goal does not fly through him', () => {
  let saves = 0, maxJump = 0, goals = 0, through = 0, held = 0;
  for (let g = 0; g < 4; g++) {
    const k = make(g + 90), p = k as any;
    const oSave = p.save.bind(p);
    p.save = (gk: any, s: any) => {
      const q = p.puck, x = q.x, y = q.y;
      assert.ok(Math.hypot(x - gk.x, y - gk.y) < 1.6, `saved within his reach (${Math.hypot(x - gk.x, y - gk.y).toFixed(2)} m)`);
      oSave(gk, s); saves++;
      maxJump = Math.max(maxJump, Math.hypot(q.x - x, q.y - y));
      if (p.held) held++;
    };
    let shot: any = null, crossed = false;
    for (let i = 0; i < 60 * 60 * 22 && !k.ended; i++) {
      const q = p.puck;
      if (q.shot && q.shot !== shot) { shot = q.shot; crossed = false; }
      const bx = q.x, by = q.y, bh = q.h;
      k.advance(1 / 60);
      if (shot && shot.outcome === 'goal' && shot.goalie && !crossed && (bx - shot.goalie.x) * (q.x - shot.goalie.x) <= 0 && bx !== q.x) {
        crossed = true; goals++;
        const u = (shot.goalie.x - bx) / (q.x - bx), y = by + (q.y - by) * u, h = bh + (q.h - bh) * u;
        if (Math.abs(y - shot.goalie.y) < 0.38 && h < 0.85) through++;
      }
    }
  }
  console.log(`   ${saves} saves (${held} frozen), the puck moved at most ${maxJump.toFixed(2)} m at a save; ${goals} goals past a goalie, ${through} through him`);
  assert.ok(saves > 60 && held > 10);
  assert.ok(maxJump < 0.9, 'the puck stays where he stopped it');
  assert.equal(through, 0, 'no goal through the goalie');
});

console.log(`\n${pass} play-control tests passed`);
