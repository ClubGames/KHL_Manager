// Agent-based rink (src/game/rinkAI.ts): physics, rules and the contract with the statistical engine.
// Run: npx tsx scripts/rink-ai-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { GameSim } from '../src/game/engine';
import { RINK_M, RinkAI } from '../src/game/rinkAI';
import { FACEOFF_SPOTS } from '../src/game/rinkGeometry';
import { foulMove } from '../src/game/rinkPlayback';
import type { GameEvent } from '../src/types';

const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
const H = r.teams.find(t => t.id === 'ska')!, A = r.teams.find(t => t.id === 'avangard')!;
type Frame = RinkAI['frames'][number];
let pass = 0;
const test = (name: string, fn: () => void) => { fn(); pass++; console.log('✓', name); };

// Three games = nine periods of material.
const periods: { evs: GameEvent[]; ai: RinkAI; start: number; end: number }[] = [];
for (let g = 0; g < 3; g++) {
  const sim = new GameSim(H, A, r.players);
  for (let k = 0; k < 3; k++) {
    const start = sim.sec, evs = sim.simPeriod();
    periods.push({ evs, start, end: sim.sec, ai: new RinkAI(evs, H, A, r.players, start, sim.sec).runToEnd() });
  }
}
const sideOf = (id: string) => (r.players[id]?.teamId === A.id ? 1 : 0);
const lx = (side: number, x: number) => (side ? 60 - x : x);

test('every period is played to its end; the clock never runs backwards', () => {
  for (const { ai, end } of periods) {
    assert.ok(ai.ended);
    assert.equal(ai.g, end);
    for (let i = 1; i < ai.frames.length; i++) {
      assert.ok(ai.frames[i].g >= ai.frames[i - 1].g - 1e-9);
      assert.ok(ai.frames[i].tau > ai.frames[i - 1].tau);
    }
  }
});

test('the game clock stands still from the whistle until the puck is dropped', () => {
  let faceoffFrames = 0, drops = 0;
  for (const { ai } of periods) {
    const f = ai.frames;
    for (let i = 1; i < f.length; i++) {
      if (f[i].stop && f[i - 1].stop) assert.equal(f[i].g, f[i - 1].g, `clock moved during a stoppage at tau ${f[i].tau}`);
      if (f[i].stop === 1) faceoffFrames++;
      if (f[i - 1].stop === 1 && f[i].stop === 0) drops++;
    }
  }
  assert.ok(faceoffFrames > 100, 'faceoffs are shown');
  assert.ok(drops >= periods.length * 8, `regular faceoffs (${drops})`);
});

test('every shot and goal arrives exactly at its engine second', () => {
  for (const { ai, evs } of periods) {
    for (const e of evs.filter(e => e.type === 'shot' || e.type === 'goal')) {
      const tau = ai.tauOf(e);
      assert.ok(tau !== undefined, `event ${e.type} ${e.sec} staged`);
      assert.ok(Math.abs(ai.clockAt(tau!) - e.sec) < 1e-6, 'arrives on the second');
    }
  }
});

test('nobody skates faster than physics allows; the puck never teleports', () => {
  let maxSkater = 0, puckJumps = 0, frames = 0;
  for (const { ai } of periods) {
    const f = ai.frames;
    for (let i = 1; i < f.length; i++) {
      const a = f[i - 1], b = f[i], dt = b.tau - a.tau;
      frames++;
      b.ids.forEach((id, j) => {
        const q = a.ids.indexOf(id);
        if (q < 0 || (a.flags[q] & 2) || (b.flags[j] & 2)) return; // penalty box seats are not skating
        maxSkater = Math.max(maxSkater, Math.hypot(b.pos[j * 2] - a.pos[q * 2], b.pos[j * 2 + 1] - a.pos[q * 2 + 1]) / dt);
      });
      if (!b.stop && Math.hypot(b.px - a.px, b.py - a.py) / dt > 55) puckJumps++;
    }
  }
  assert.ok(maxSkater < 11.5, `top skating speed ${maxSkater.toFixed(1)} m/s`);
  assert.ok(puckJumps / frames < 0.001, `puck faster than 200 km/h in ${puckJumps} of ${frames} frames`);
});

test('offside: early entries are whistled, stay rare and restart at a neutral-zone dot', () => {
  const blue = 60 - RINK_M.blueLine;
  let entries = 0, unwhistled = 0, offsides = 0, neutral = 0;
  for (const { ai } of periods) {
    const zin = [false, false];
    const f: Frame[] = ai.frames;
    const calls = ai.plays.filter(p => p.kind === 'offside');
    offsides += calls.length;
    for (const c of calls) {
      const drop = f.find(fr => fr.tau > c.tau && fr.stop === 1);
      assert.ok(drop, 'an offside is followed by a faceoff');
      const atDot = FACEOFF_SPOTS.neutral.some(d => Math.hypot(drop!.px - d.x, drop!.py - d.y) < 0.4);
      if (atDot) neutral++;
    }
    for (let i = 1; i < f.length; i++) {
      const a = f[i - 1], b = f[i];
      if (b.stop) { zin[0] = b.px > blue; zin[1] = 60 - b.px > blue; continue; }
      for (const side of [0, 1]) {
        const was = zin[side], x = lx(side, b.px);
        if (x > blue) zin[side] = true; else if (x < blue - 0.3) zin[side] = false;
        if (was || !zin[side] || a.carrier < 0 || sideOf(a.ids[a.carrier]) !== side) continue;
        entries++;
        const ahead = b.ids.some((id, j) => !(b.flags[j] & 3) && sideOf(id) === side && id !== a.ids[a.carrier] && lx(side, b.pos[j * 2]) > blue + 0.35);
        if (ahead && !calls.some(c => c.tau >= a.tau - 1e-6 && c.tau <= b.tau + 0.25)) unwhistled++;
      }
    }
  }
  assert.ok(entries > periods.length * 25, `carried entries ${entries}`);
  assert.ok(unwhistled / entries < 0.01, `unwhistled offside entries ${unwhistled}/${entries}`);
  assert.ok(offsides >= periods.length * 0.5 && offsides <= periods.length * 6, `offsides ${offsides} in ${periods.length} periods`);
  assert.equal(neutral, offsides, 'offside faceoffs are taken at a neutral-zone dot');
});

test('teams switch ends: a flipped period is the same hockey mirrored lengthwise (the benches stay where they are)', () => {
  const { evs, start, end, ai } = periods[1];
  const flipped = new RinkAI(evs, H, A, r.players, start, end, { flip: true }).runToEnd();
  // the opening faceoff is the same formation mirrored; later the line changes go to the team's own bench (it
  // does not move in the arena), so the hockey differs in detail — the engine's events stay the same
  const a = ai.frameAt(0), b = flipped.frameAt(0);
  assert.ok(Math.abs(a.puck.x + b.puck.x - 100) < 1e-6 && Math.abs(a.puck.y - b.puck.y) < 1e-6);
  a.skaters.forEach((p, i) => assert.ok(Math.abs(p.pos.x + b.skaters[i].pos.x - 100) < 1e-6));
  const goals = (x: RinkAI) => x.plays.filter(p => p.kind === 'goal').map(p => Math.round(p.g));
  assert.deepEqual(goals(ai), goals(flipped));
  const goal = evs.find(e => e.type === 'goal' && e.player);
  if (goal) {
    const c0 = ai.goalClip(goal)!, c1 = flipped.goalClip(goal)!;
    assert.equal(c0.dir, -(c1.dir ?? 0));
  }
});

test('real hockey happens around the engine events: faceoffs, takeaways, blocks, icings, line changes', () => {
  const kinds: Record<string, number> = {};
  for (const { ai } of periods) ai.plays.forEach(p => { kinds[p.kind] = (kinds[p.kind] ?? 0) + 1; });
  for (const k of ['faceoff', 'takeaway', 'block', 'icing', 'offside', 'change', 'entry', 'dump', 'save']) assert.ok((kinds[k] ?? 0) > 0, `${k} occurs`);
  const t = periods[0].ai.tally(Infinity);
  assert.ok(t.faceoff[0] + t.faceoff[1] >= 8);
});

test('frames, clips and replans are deterministic and consistent', () => {
  const { evs, start, end, ai } = periods[0];
  const again = new RinkAI(evs, H, A, r.players, start, end).runToEnd();
  assert.equal(again.frames.length, ai.frames.length);
  assert.deepEqual(again.frameAt(300), ai.frameAt(300));
  const goal = periods.flatMap(p => p.evs.filter(e => e.type === 'goal' && e.player).map(e => ({ e, ai: p.ai })))[0];
  if (goal) {
    const clip = goal.ai.goalClip(goal.e)!;
    assert.ok(clip.bodies && clip.tracks.some(t => t.id === goal.e.player));
    assert.ok(clip.release < clip.goal && clip.goal < 1);
    // The 3D clip is the 2D rink: the puck at the goal moment is the same point.
    const live = goal.ai.frameAt(goal.ai.tauOf(goal.e)!);
    const k = clip.puck.reduce((best, key) => (Math.abs(key.t - clip.goal) < Math.abs(best.t - clip.goal) ? key : best));
    assert.ok(Math.hypot(k.x - live.puck.x, k.y - live.puck.y) < 1.5);
  }
  // A coaching replan mid-period keeps the motion already shown and stages the new future.
  const half = new RinkAI(evs, H, A, r.players, start, end);
  half.ensure(200);
  const shown = half.frameAt(150);
  const future = evs.filter(e => e.sec <= half.g || e.type !== 'shot');
  half.setEvents(future);
  half.runToEnd();
  assert.deepEqual(half.frameAt(150), shown);
  assert.equal(half.g, end);
});

test('pulled goalie at the end: six skaters at most, never a full bench on the ice', () => {
  // Count skaters actually playing (not on their way to the bench) every recorded frame.
  type Probe = { agents: Map<string, { side: 0 | 1; on: string; goalie: boolean; leave: unknown }>; mode: string };
  const proto = RinkAI.prototype as unknown as { record: (this: Probe) => void };
  const rec0 = proto.record;
  let worst = [0, 0], tooMany = 0, pulledFrames = 0;
  proto.record = function (this: Probe) {
    rec0.call(this);
    for (const s of [0, 1] as const) {
      let sk = 0, g = 0;
      for (const a of this.agents.values()) if (a.side === s && a.on === 'ice' && !a.leave) a.goalie ? g++ : sk++;
      worst[s] = Math.max(worst[s], sk);
      if (g && sk > 5) tooMany++;
      if (!g && sk === 6) pulledFrames++;
    }
  };
  try {
    for (let g = 0; g < 8; g++) {
      const sim = new GameSim(H, A, r.players);
      sim.simPeriod(); sim.simPeriod();
      // the trailing side (or the away side when level) plays the whole third with an extra attacker
      const side = (sim.score[0] < sim.score[1] ? 0 : 1) as 0 | 1;
      sim.setForceEmptyNet(side, true);
      const start = sim.sec, evs = sim.simPeriod();
      new RinkAI(evs, H, A, r.players, start, sim.sec, { goalies: [side === 0 ? null : H.lineup.starterG, side === 1 ? null : A.lineup.starterG] }).runToEnd();
    }
  } finally {
    proto.record = rec0;
  }
  assert.ok(Math.max(...worst) <= 6, `max skaters ${worst}`);
  assert.equal(tooMany, 0, 'six skaters while the goalie is in the net');
  assert.ok(pulledFrames > 1000, `the extra attacker is actually used (${pulledFrames} frames)`);
});

test('special teams: the power play sets up and holds the zone, the penalty killers box the slot and clear', () => {
  let ppF = 0, ppOz = 0, evF = 0, evOz = 0, poss = 0, own = 0, pkD = 0, pkN = 0, evD = 0, evN = 0;
  const games = [...periods];
  for (let g = 0; g < 4; g++) {
    const sim = new GameSim(H, A, r.players);
    for (let k = 0; k < 3; k++) { const start = sim.sec, evs = sim.simPeriod(); games.push({ evs, start, end: sim.sec, ai: new RinkAI(evs, H, A, r.players, start, sim.sec).runToEnd() }); }
  }
  for (const { ai } of games) for (const f of ai.frames) {
    if (f.stop) continue;
    const sk: { s: number; x: number; y: number }[] = []; let gk = 0;
    f.ids.forEach((id, i) => { if (f.flags[i] & 2) return; if (f.flags[i] & 1) gk++; else sk.push({ s: sideOf(id), x: f.pos[i * 2], y: f.pos[i * 2 + 1] }); });
    if (gk < 2) continue;
    const n0 = sk.filter(p => p.s === 0).length, n1 = sk.length - n0;
    // distance of the defenders to their own net while the puck is in their zone
    const def = (s: number, acc: (d: number) => void) => { if (lx(1 - s, f.px) > 37.14) for (const p of sk) if (p.s === s) acc(Math.hypot(lx(s, p.x) - 4.5, p.y - 15)); };
    if (n0 === n1) {
      evF += 2; evOz += +(lx(0, f.px) > 37.14) + +(lx(1, f.px) > 37.14);
      def(0, d => { evD += d; evN++; }); def(1, d => { evD += d; evN++; });
      continue;
    }
    const pp = n0 > n1 ? 0 : 1;
    ppF++; if (lx(pp, f.px) > 37.14) ppOz++;
    if (f.carrier >= 0) { poss++; if (sideOf(f.ids[f.carrier]) === pp) own++; }
    def(1 - pp, d => { pkD += d; pkN++; });
  }
  assert.ok(ppF > 5000, `power-play frames ${ppF}`);
  const ozPP = ppOz / ppF, ozEV = evOz / evF;
  assert.ok(ozPP > ozEV + 0.08, `the power play lives in the zone (${ozPP.toFixed(2)} vs ${ozEV.toFixed(2)} at even strength)`);
  assert.ok(own / poss > 0.68, `the power play owns the puck (${(own / poss).toFixed(2)})`);
  assert.ok(pkD / pkN < evD / evN - 0.3, `penalty killers stay tighter to the net (${(pkD / pkN).toFixed(1)} m vs ${(evD / evN).toFixed(1)} m)`);
});

test('lines: the right number of skaters, defensemen on the blue line, quick changes; defenders skate and stay goal-side', () => {
  type Ag = { id: string; side: 0 | 1; on: string; goalie: boolean; leave: null | 'bench' | 'box'; role: string; x: number; y: number; vx: number; vy: number };
  type Probe = { agents: Map<string, Ag>; mode: string; baseSkaters: [number, number]; lastGoalie: [string | null, string | null]; puck: { carrier: Ag | null }; g: number; players: typeof r.players };
  const proto = RinkAI.prototype as unknown as { record: (this: Probe) => void };
  const rec0 = proto.record;
  const BENCH = [{ x: 24, y: 0.8 }, { x: 36, y: 0.8 }], BOX = [{ x: 27, y: 29.2 }, { x: 33, y: 29.2 }];
  const d2 = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const ppIds = [H, A].map(T => new Set([...T.lineup.pp1, ...T.lineup.pp2]));
  const st = { frames: 0, over: 0, under: 0, noChange: 0, fwdAsD: 0, dAsFwd: 0, gapN: 0, goalSide: 0, spdN: 0, spd: 0, stall: 0, holdSum: 0, holds: 0 };
  let lastAI: unknown = null, carrier: Ag | null = null, holdStart = 0, stallRun = 0;
  proto.record = function (this: Probe) {
    rec0.call(this);
    if (lastAI !== this) { lastAI = this; carrier = null; }
    if (this.mode !== 'play') return;
    st.frames++;
    const even = this.baseSkaters[0] === this.baseSkaters[1] && this.lastGoalie[0] !== null && this.lastGoalie[1] !== null;
    for (const s of [0, 1] as const) {
      const all = [...this.agents.values()].filter(a => a.side === s && a.on === 'ice' && !a.goalie);
      const act = all.filter(a => !a.leave);
      // a man skating off counts until he is at the gate
      const visible = all.filter(a => !a.leave || d2(a, a.leave === 'box' ? BOX[s] : BENCH[s]) > 3).length;
      if (visible > this.baseSkaters[s] + (this.lastGoalie[s] === null ? 1 : 0)) st.over++;
      if (act.length < this.baseSkaters[s]) { st.under++; if (all.length === act.length) st.noChange++; }
      if (!even) continue;
      const ds = act.filter(b => b.role === 'LD' || b.role === 'RD').length;
      for (const a of act) {
        const pos = this.players[a.id]?.position, dRole = a.role === 'LD' || a.role === 'RD';
        if (dRole && pos !== 'D' && !act.every(b => ppIds[s].has(b.id))) st.fwdAsD++;
        if (!dRole && pos === 'D' && ds < 2) st.dAsFwd++;
      }
    }
    const c = this.puck.carrier;
    if (c !== carrier) { if (carrier) { st.holdSum += this.g - holdStart; st.holds++; } carrier = c; holdStart = this.g; stallRun = 0; }
    if (!c) return;
    stallRun = Math.hypot(c.vx, c.vy) < 1.5 ? stallRun + 1 : 0;
    if (stallRun > 20) st.stall++;
    const s = (1 - c.side) as 0 | 1, net = s === 0 ? { x: 4, y: 15 } : { x: 56, y: 15 };
    const lxC = lx(c.side, c.x);
    const defs = [...this.agents.values()].filter(a => a.side === s && a.on === 'ice' && !a.goalie && !a.leave);
    if (!defs.length) return;
    if (lxC > 22 && lxC < 45) { const near = defs.reduce((p, q) => (d2(p, c) < d2(q, c) ? p : q)); st.gapN++; if (d2(near, net) < d2(c, net)) st.goalSide++; }
    if (lxC > 30) for (const a of defs) { st.spd += Math.hypot(a.vx, a.vy); st.spdN++; }
  };
  try {
    for (let g = 0; g < 2; g++) {
      const sim = new GameSim(H, A, r.players);
      for (let k = 0; k < 3; k++) { const start = sim.sec, evs = sim.simPeriod(); new RinkAI(evs, H, A, r.players, start, sim.sec).runToEnd(); }
    }
  } finally { proto.record = rec0; }
  const f = (n: number) => n / st.frames;
  assert.ok(f(st.over) < 0.005, `too many skaters on the ice in ${(100 * f(st.over)).toFixed(2)}% of frames`);
  assert.ok(f(st.under) < 0.06, `a team is short a skater in ${(100 * f(st.under)).toFixed(2)}% of frames`);
  assert.ok(f(st.noChange) < 0.002, `short-handed with nobody changing in ${(100 * f(st.noChange)).toFixed(2)}% of frames`);
  assert.ok(f(st.fwdAsD) < 0.005 && f(st.dAsFwd) < 0.002, `wrong roles: F as D ${(100 * f(st.fwdAsD)).toFixed(2)}%, D as F ${(100 * f(st.dAsFwd)).toFixed(2)}%`);
  assert.ok(st.goalSide / st.gapN > 0.62, `the nearest defender is goal-side of the carrier ${(100 * st.goalSide / st.gapN).toFixed(0)}% of the time`);
  // not statues: defenders keep moving (≈3.4 m/s on average — they skate backwards at 84 % speed, keep a gap and absorb contacts)
  assert.ok(st.spd / st.spdN > 3.15, `defenders in their end move at ${(st.spd / st.spdN).toFixed(2)} m/s`);
  assert.ok(f(st.stall) < 0.01 && st.holdSum / st.holds < 1.6, `stalling carriers ${(100 * f(st.stall)).toFixed(2)}%, average hold ${(st.holdSum / st.holds).toFixed(2)} s`);
});

test('penalties are acted out by the offender (a hit to the head, a trip, a slash…), not only announced', () => {
  let called = 0, shown = 0, offIce = 0;
  const kinds = new Set<string>();
  for (const { evs, ai } of periods) for (const e of evs) {
    if (e.type !== 'penalty' || !e.player) continue;
    const mv = foulMove(e.text.includes('—') ? e.text.split('—').pop()!.trim() : '');
    if (!mv) continue;
    called++;
    const t = ai.tauOf(e);
    if (t === undefined || t === null) continue;
    let seen = false, there = false;
    for (let dt = -1; dt <= 1; dt += 1 / 30) {
      const f = ai.frameAt(t + dt).skaters.find(x => x.id === e.player);
      if (f && !f.box) there = true;
      if (f?.move === mv) { seen = true; kinds.add(mv); break; }
    }
    // (the staging's lines are not always the engine's: a man who is not out there at the call cannot act it out)
    if (!there) { called--; offIce++; continue; }
    if (seen) shown++;
  }
  console.log(`   infractions acted out: ${shown}/${called} [${[...kinds].join(', ')}] (${offIce} offenders not on the ice at the call)`);
  assert.ok(called > 0 && shown >= called * 0.5, 'most infractions are acted out by the offender at the call');
});

console.log(`\n${pass} rink AI tests passed`);
