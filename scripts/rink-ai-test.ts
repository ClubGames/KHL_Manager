// Agent-based rink (src/game/rinkAI.ts): physics, rules and the contract with the statistical engine.
// Run: npx tsx scripts/rink-ai-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { GameSim } from '../src/game/engine';
import { RINK_M, RinkAI } from '../src/game/rinkAI';
import { FACEOFF_SPOTS } from '../src/game/rinkGeometry';
import type { GameEvent } from '../src/types';

const r = parseRosterText(readFileSync('public/rostfdfer.json', 'utf8'));
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

test('teams switch ends: a flipped period is the same hockey mirrored lengthwise', () => {
  const { evs, start, end, ai } = periods[1];
  const flipped = new RinkAI(evs, H, A, r.players, start, end, { flip: true }).runToEnd();
  const a = ai.frameAt(250), b = flipped.frameAt(250);
  assert.ok(Math.abs(a.puck.x + b.puck.x - 100) < 1e-6 && Math.abs(a.puck.y - b.puck.y) < 1e-6);
  a.skaters.forEach((p, i) => assert.ok(Math.abs(p.pos.x + b.skaters[i].pos.x - 100) < 1e-6));
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

console.log(`\n${pass} rink AI tests passed`);
