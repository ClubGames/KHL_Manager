// 3D replay motion (src/components/replayMotion.ts): passes, shots, dekes and goalie saves planned from the clips.
// Run: npx tsx scripts/replay-motion-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { GameSim } from '../src/game/engine';
import { RinkAI } from '../src/game/rinkAI';
import { buildReplayClip, samplePath, sampleSmooth, type ReplayClip } from '../src/game/rinkPlayback';
import { toWorld } from '../src/components/replayCameras';
import { carrierAt, dekeAt, planMotion, releaseAt, releaseHeading, shotKind, type MotionPlan } from '../src/components/replayMotion';

const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
const H = r.teams.find(t => t.id === 'ska')!, A = r.teams.find(t => t.id === 'avangard')!;
let pass = 0;
const test = (name: string, fn: () => void) => { fn(); pass++; console.log('✓', name); };
const angleDiff = (a: number, b: number) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; };

// Goal clips of the agent rink (the ones the game shows), several games' worth.
const clips: { clip: ReplayClip; plan: MotionPlan }[] = [];
for (let g = 0; g < 8 && clips.length < 20; g++) {
  const sim = new GameSim(H, A, r.players);
  for (let k = 0; k < 3; k++) {
    const start = sim.sec, evs = sim.simPeriod();
    const ai = new RinkAI(evs, H, A, r.players, start, sim.sec).runToEnd();
    for (const e of evs) if (e.type === 'goal' && e.player) { const clip = ai.goalClip(e); if (clip) clips.push({ clip, plan: planMotion(clip) }); }
  }
}
console.log(`${clips.length} goal clips`);

test('the agent rink records who had the puck and the shot type', () => {
  assert.ok(clips.length >= 6);
  for (const { clip } of clips) {
    assert.ok(Array.isArray(clip.touches), 'possession recorded');
    for (const t of clip.touches!) assert.ok(t.t0 <= t.t1 && t.t0 >= 0 && t.t1 <= 1);
    assert.ok(clip.shot);
  }
  // (a goal straight off a faceoff or a scramble can have nobody carrying the puck in the last seven seconds)
  assert.ok(clips.filter(c => c.clip.touches!.length > 0).length >= clips.length * .8);
});

test('every goal is a release of the scorer at the release time, aimed at where the puck goes in', () => {
  for (const { clip, plan } of clips) {
    const g = plan.releases.filter(x => x.goal);
    assert.equal(g.length, 1);
    assert.equal(g[0].id, clip.scorer);
    assert.equal(g[0].t, clip.release);
    assert.equal(g[0].kind, shotKind(clip));
    assert.ok(Math.abs(g[0].tx) > 20, 'target at a net');
  }
});

test('passes are animated: carriers who move the puck to a teammate wind up and release', () => {
  const passes = clips.flatMap(c => c.plan.releases.filter(x => x.kind === 'pass'));
  assert.ok(passes.length >= clips.length / 2, `${passes.length} passes`);
  for (const { plan } of clips) for (const x of plan.releases) { assert.ok(x.windup > 0 && x.windup <= .6); assert.ok(x.follow > 0); }
});

test('nobody shoots with his back to the net: at the release the body is at most side-on to the target', () => {
  for (const { clip, plan } of clips) {
    for (const rel of plan.releases) {
      const tr = clip.tracks.find(t => t.id === rel.id)!;
      for (const hand of [1, -1] as const) {
        const w = toWorld(sampleSmooth(tr.keys, rel.t));
        const h = releaseHeading(rel, w.x, w.z, hand, 0), aim = Math.atan2(-(rel.tz - w.z), rel.tx - w.x);
        assert.ok(Math.abs(angleDiff(h, aim)) < 1.0, `${rel.kind}: ${angleDiff(h, aim).toFixed(2)}`);
        // forehand: a right shot (+1) has the target on his left (heading to the right of the aim), a left shot the other way
        if (rel.kind !== 'backhand' && rel.kind !== 'tip') assert.equal(Math.sign(angleDiff(h, aim)), hand);
      }
      const at = releaseAt(plan, rel.id, rel.t, clip.duration)!;
      assert.ok(at && Math.abs(at.s) < 1e-6 && at.aim > .99, 'fully turned at the release');
      const before = releaseAt(plan, rel.id, rel.t - (rel.windup * .5) / clip.duration, clip.duration)!;
      assert.ok(before.s < 0 && before.s > -1, 'winding up before it');
    }
  }
});

test('the goalie reacts to the goal shot: a save attempt where the puck passes him', () => {
  let n = 0;
  for (const { clip, plan } of clips) {
    const defending = clip.tracks.find(t => t.goalie && t.side !== clip.attacking);
    if (!defending) continue; // empty net
    const saves = plan.saves.get(defending.id) ?? [];
    const s = saves.find(x => x.t >= clip.release - 1e-9 && (x.t - clip.goal) * clip.duration < .25);
    if (!s) {
      // only a goalie far from the puck (pulled out of his crease) makes no save
      let near = Infinity;
      for (let t = clip.release; t <= clip.goal; t += .002) {
        const p = toWorld(samplePath(clip.puck, t)), w = toWorld(sampleSmooth(defending.keys, t));
        near = Math.min(near, Math.hypot(p.x - w.x, p.z - w.z));
      }
      assert.ok(near > 3.9, `save on the goal shot (puck ${near.toFixed(1)} m from him)`);
      continue;
    }
    assert.ok(Math.abs(s!.x) > 22, 'near his net');
    n++;
  }
  assert.ok(n > 0);
});

test('stickhandling: carriers deke defenders in some clips, never during a release, never on a flying puck', () => {
  let deked = 0;
  for (const { clip, plan } of clips) {
    let any = false;
    for (let t = 0; t <= 1; t += .01) {
      const d = dekeAt(clip, plan, t);
      if (!d) continue;
      any = true;
      assert.equal(d.id, carrierAt(plan, t)?.id);
      assert.ok(Math.abs(d.offset) <= .43);
      assert.ok(Math.abs(Math.hypot(d.lx, d.lz) - 1) < 1e-6);
      const rel = releaseAt(plan, d.id, t, clip.duration);
      if (rel) assert.ok(rel.aim < .999);
    }
    if (any) deked++;
  }
  assert.ok(deked > 0, 'some dekes');
});

test('reconstructed clips (no possession data) still get touches, passes and the goal shot', () => {
  const ids = (t: typeof H) => [...t.lineup.F[0], ...t.lineup.D[0]].filter((id): id is string => !!id);
  const h = ids(H), a = ids(A);
  for (const shotType of ['wrist', 'snap', 'slap', 'tip', 'rebound', 'backhand'] as const) {
    const clip = buildReplayClip({ sec: 481, period: 1, time: '11:59', type: 'goal', team: H.id, player: h[0], players: [h[1], h[2]], goalie: A.lineup.starterG, ice: [h, a], x: 82, y: 34, shotType, strength: 'EV', score: [1, 0], text: 'Гол' }, H, A, r.players)!;
    assert.equal(clip.shot, shotType);
    const plan = planMotion(clip);
    assert.ok(plan.touches.length > 0);
    assert.ok(plan.releases.some(x => x.goal && x.id === h[0]));
  }
});

console.log(`\n${pass} checks passed`);
