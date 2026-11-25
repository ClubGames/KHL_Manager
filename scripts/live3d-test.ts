// The live 3D match: same frames as the 2D rink, playback pace independent of the look-ahead, passes and
// shots found for the windups, goals for the lamp and celebrations, cameras inside the arena.
// Run: npx tsx scripts/live3d-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { GameSim } from '../src/game/engine';
import { RinkAI } from '../src/game/rinkAI';
import { LiveMotion, LOOKAHEAD, puckVelocity, shownSkaters } from '../src/components/liveMotion';
import { LIVE_CAMERAS, liveCameraPose, toWorld } from '../src/components/replayCameras';
import { NET_X } from '../src/components/replayMotion';

const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
const H = r.teams.find(t => t.id === 'ska')!, A = r.teams.find(t => t.id === 'avangard')!;
let pass = 0;
const test = (name: string, fn: () => void) => { fn(); pass++; console.log('✓', name); };

const periods: { evs: ReturnType<GameSim['simPeriod']>; start: number; end: number; flip: boolean }[] = [];
for (let g = 0; g < 2; g++) {
  const sim = new GameSim(H, A, r.players);
  for (let k = 0; k < 3; k++) { const start = sim.sec, evs = sim.simPeriod(); periods.push({ evs, start, end: sim.sec, flip: k === 1 }); }
}
const make = (p: typeof periods[number]) => new RinkAI(p.evs, H, A, r.players, p.start, p.end, { flip: p.flip });

/** The match screen's loop: presentation time advances by the pace of the moment (×2 speed, 60 fps). */
function play(ai: RinkAI, ahead: number, onFrame?: (tau: number) => void) {
  let tau = 0, pace: number = RinkAI.PACE.cold;
  const taus: number[] = [];
  for (let i = 0; i < 400000; i++) {
    const want = ai.paceAt(tau);
    pace += (want - pace) * Math.min(1, (1 / 60) * 5);
    tau = Math.min(tau + (1 / 60) * 2 * pace, ai.ended ? ai.lastTau : Infinity);
    ai.ensure(tau);
    if (ahead) ai.ensure(tau + ahead);
    onFrame?.(tau);
    if (i % 30 === 0) taus.push(tau);
    if (ai.ended && tau >= ai.lastTau) break;
  }
  return taus;
}

test('looking ahead for the 3D picture changes neither the pace of the match nor a single frame of the 2D rink', () => {
  for (const p of periods.slice(0, 3)) {
    const plain = make(p), ahead = make(p);
    const a = play(plain, 0), b = play(ahead, LOOKAHEAD);
    assert.equal(a.length, b.length);
    a.forEach((t, i) => assert.ok(Math.abs(t - b[i]) < 1e-9, `presentation time drifts at sample ${i}: ${t} vs ${b[i]}`));
    for (let t = 0; t < plain.lastTau; t += 0.7) assert.deepEqual(plain.frameAt(t), ahead.frameAt(t));
  }
});

test('the 3D picture is the 2D frame: every skater on the ice, nobody from the box, the puck at the same spot', () => {
  const ai = make(periods[0]);
  play(ai, LOOKAHEAD, (tau) => {
    const f = ai.frameAt(tau), shown = shownSkaters(f);
    assert.ok(shown.every(p => !p.box));
    assert.ok(shown.filter(p => !p.goalie).length <= 16, 'two units plus the men skating off in a change');
    for (const p of shown) { const w = toWorld(p.pos); assert.ok(Math.abs(w.x) <= 30.5 && Math.abs(w.z) <= 15.5, `${p.id} outside the rink`); }
  });
});

test('passes and shots are found with a windup before the puck leaves the blade; shots aim at the attacked net', () => {
  let releases = 0, shots = 0, windups = 0, flipped = 0;
  for (const p of periods) {
    const ai = make(p), m = new LiveMotion(ai);
    const seen = new Set<string>();
    play(ai, LOOKAHEAD, (tau) => {
      m.update();
      for (const rel of m.releases) {
        const key = `${rel.id}@${rel.t.toFixed(3)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        releases++;
        assert.ok(rel.windup >= 0.08 && rel.windup <= 0.56 && rel.follow > 0);
        // known before the windup starts on screen (the rink runs ahead of the picture)
        if (rel.t - rel.windup > tau - 1e-6) windups++;
        if (rel.kind !== 'pass') {
          shots++;
          assert.equal(Math.abs(rel.tx), NET_X);
          assert.equal(rel.tx, m.netX(rel.side));
          if (p.flip) flipped++;
        }
        const at = m.releaseAt(rel.id, rel.t);
        assert.ok(at && Math.abs(at.s) < 1e-6, 'the release moment is shot phase 0');
        const before = m.releaseAt(rel.id, rel.t - rel.windup);
        // (a quick give-and-go: his previous release may still be closer at that moment)
        assert.ok(before && (before.rel !== rel || before.s <= -0.99), 'the windup starts at -1');
      }
      m.prune(tau);
    });
  }
  assert.ok(releases > 600, `releases ${releases}`);
  assert.ok(shots > 40 && shots < releases * 0.4, `shots ${shots} of ${releases}`);
  assert.ok(windups / releases > 0.9, `windups known in time: ${windups} of ${releases}`);
  assert.ok(flipped > 0, 'shots after the teams switch ends aim at the other net');
});

test('goals light the lamp behind the net that was scored on', () => {
  let goals = 0;
  for (const p of periods) {
    const ai = make(p), m = new LiveMotion(ai);
    play(ai, 0);
    for (const pl of ai.plays.filter(x => x.kind === 'goal')) {
      goals++;
      const g = m.goalAt(pl.tau + 0.5)!;
      assert.ok(g && g.side === pl.side);
      assert.equal(g.netX, m.netX(pl.side!));
      // the puck ends up in that net
      const puck = toWorld(ai.frameAt(pl.tau).puck);
      assert.ok(Math.sign(puck.x) === Math.sign(g.netX) && Math.abs(puck.x) > 22, `puck at ${puck.x.toFixed(1)} for a goal on ${g.netX}`);
    }
  }
  assert.ok(goals > 0, 'some goals were scored');
});

test('puck velocity follows the frames (a shot flies, a carried puck skates)', () => {
  const ai = make(periods[0]);
  play(ai, 0);
  let fast = 0, n = 0;
  for (let t = 1; t < ai.lastTau; t += 0.25) { const v = puckVelocity(ai, t); const s = Math.hypot(v.x, v.z); assert.ok(s < 60, `puck at ${s.toFixed(0)} m/s`); if (s > 14) fast++; n++; }
  assert.ok(fast > 0 && fast < n * 0.3, `fast puck samples ${fast}/${n}`);
});

test('every live camera stays in the arena, above the ice, and looks at the play', () => {
  for (const [cam] of LIVE_CAMERAS) for (const fx of [-30, -12, 0, 12, 30]) for (const fz of [-15, 0, 15]) for (const zoom of [0.45, 1, 1.8]) for (const aspect of [0.5, 1.78, 2.4]) {
    const p = liveCameraPose(cam, { x: fx, z: fz }, zoom, aspect);
    assert.ok(p.pos.y > 0.5 && p.pos.y < 60, `${cam} height ${p.pos.y}`);
    assert.ok(Math.abs(p.pos.x) < 45 && Math.abs(p.pos.z) < 45, `${cam} outside the arena`);
    assert.ok(p.fov >= 15 && p.fov <= 80);
    assert.ok(Math.abs(p.look.x) <= 30 && Math.abs(p.look.z) <= 15);
  }
});

console.log(`\n${pass} live 3D checks passed`);
