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
  assert.ok(tot.pen / n < 4, `penalties per period ${per(tot.pen)}`);
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
  }, 600);
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

console.log(`\n${pass} play-control tests passed`);
