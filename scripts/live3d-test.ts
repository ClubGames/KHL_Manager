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
import { ANNOUNCE, announceCamera, announceGesture, BUMP, bumpPlan, bumpPose, bumpReach, FACEOFF_CAM, faceoffCamera, mixCam, penaltyCaption, penaltyReplay, replayLength } from '../src/components/liveShow';
import { goalLines, plural, seasonLine } from '../src/components/statLines';
import { NO_PAD, PlayRink, FO_DROP } from '../src/game/playRink';
import { emptyStats } from '../src/game/defaults';

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

test('the faceoff camera: from high over the dot down to it, then the match camera; a penalty: the call, the replay, the box', () => {
  const dot = { x: -20, z: 7 };
  const hi = faceoffCamera(dot, 0), lo = faceoffCamera(dot, 1), mid = faceoffCamera(dot, .5);
  assert.ok(hi.pos.y > 14 && Math.hypot(hi.pos.x - dot.x, hi.pos.z - dot.z) < 2 && Math.hypot(hi.look.x - dot.x, hi.look.z - dot.z) < .1, 'straight above the circle');
  assert.ok(lo.pos.y < 5 && lo.pos.y < mid.pos.y && mid.pos.y < hi.pos.y && Math.hypot(lo.look.x - dot.x, lo.look.z - dot.z) < .5, 'down to the dot');
  for (let k = 0; k <= 1; k += .05) { const c = faceoffCamera(dot, k), n = faceoffCamera(dot, k + .05); assert.ok(Math.hypot(c.pos.x - n.pos.x, c.pos.y - n.pos.y, c.pos.z - n.pos.z) < 1.6, 'smooth'); }
  const game = { pos: { x: 0, y: 9, z: 22 }, look: { x: -10, y: 0, z: 0 }, fov: 45 };
  assert.deepEqual(mixCam(lo, game, 0), lo); assert.deepEqual(mixCam(lo, game, 1), game);
  assert.ok(FACEOFF_CAM.descend > 2 && FACEOFF_CAM.handover > .5);
  // the referee's call: the arm up, the signal, the point to the box, on a close camera in front of him
  assert.deepEqual([.1, ANNOUNCE.armUp + .1, ANNOUNCE.armUp + ANNOUNCE.signal + .1].map(t => announceGesture(t).phase), ['armUp', 'signal', 'point']);
  const ref = { x: 5, z: -10, heading: -Math.PI / 2 }, c = announceCamera(ref, 1); // facing +z (heading: facing (cos h, −sin h))
  assert.ok(Math.hypot(c.pos.x - ref.x, c.pos.z - ref.z) < 5 && c.fov < 36 && c.pos.z > ref.z, 'in front of him');
  assert.deepEqual(penaltyCaption('Удаление: Иванов — подножка, 2 мин'), { name: 'Иванов', reason: 'подножка (2 мин)' });
  assert.deepEqual(penaltyCaption('Удаление: Петров — задержка клюшкой (2 мин)'), { name: 'Петров', reason: 'задержка клюшкой (2 мин)' });
  assert.deepEqual(penaltyCaption('Удаление: Сидоров, 2 мин'), { name: 'Сидоров', reason: '2 мин' });
  const r = penaltyReplay(100, 96, 'x', 'p');
  assert.equal(r.kind, 'penalty'); assert.ok(r.from < 96 && r.to > 96 && r.to <= 100.6 && replayLength(r) > 3, 'the infraction itself, slowed');
});

test('after a goal: the scorers skate along their bench, the scorer first, the bench reaches out for the fist bumps', () => {
  const plan = bumpPlan(['s', 'a', 'b', 'c'], -6);
  assert.ok(plan.length > 4 && plan.length < 9, `${plan.length.toFixed(1)} s`);
  const seen = new Map<string, number>();
  let prev = bumpPose(plan, 0);
  for (let t = 0; t <= plan.length; t += 1 / 30) {
    const p = bumpPose(plan, t);
    p.forEach((q, id) => {
      const o = prev.get(id)!;
      assert.ok(Math.hypot(q.x - o.x, q.z - o.z) < .2, 'skating, not jumping');
      assert.ok(q.z > -15 && (Math.abs(q.x + 6) > 4.6 || q.z < -13.9), 'along the bench boards');
      if (Math.abs(q.x + 6) < 3) seen.set(id, Math.max(seen.get(id) ?? 0, q.bump));
    });
    const s = p.get('s')!, a = p.get('a')!;
    assert.ok(s.x < a.x, 'the scorer leads');
    prev = p;
  }
  assert.equal(seen.size, 4); seen.forEach(v => assert.ok(v > .9, 'the glove out in front of the bench'));
  const mid = bumpPose(plan, (plan.x0 - plan.benchX) / BUMP.pace);
  assert.ok(bumpReach(mid, plan.benchX) > .8 && bumpReach(mid, plan.benchX + 12) === 0, 'the man he passes reaches out, not the far end');
});

test('the close-up numbers: the season, at a goal the match and the season with it', () => {
  assert.equal(plural(1, 'гол', 'гола', 'голов'), 'гол'); assert.equal(plural(3, 'гол', 'гола', 'голов'), 'гола'); assert.equal(plural(12, 'гол', 'гола', 'голов'), 'голов'); assert.equal(plural(21, 'игра', 'игры', 'игр'), 'игра');
  const p = { ...Object.values(r.players).find(x => x.position !== 'G')!, stats: { ...emptyStats(), gp: 20, goals: 9, assists: 7, plusMinus: 4 } };
  assert.equal(seasonLine(p), 'Сезон: 20 игр · 9+7=16 · +4');
  assert.deepEqual(goalLines(p, 2), ['В матче: 2 гола — дубль!', 'Сезон: 21 игра · 11+7=18 · +4', '11-й гол в сезоне']);
  const g = { ...Object.values(r.players).find(x => x.position === 'G')!, stats: { ...emptyStats(), gp: 10, wins: 6, saves: 270, shotsAgainst: 290, minutes: 600, shutouts: 1 } };
  assert.equal(seasonLine(g), 'Сезон: 10 игр · 6 побед · 93,1% · КН 2,00 · 1 «сухарь»');
  assert.equal(seasonLine({ ...p, stats: emptyStats() }), 'Сезон: первая игра');
});

test('faceoffs in the played match: lined up from the first frame, at a whistle they skate to the dot (no jumps), the windup, the throw, the battle', () => {
  const k = new PlayRink({ home: H, away: A, players: r.players, lineups: [H.lineup, A.lineup], userSide: null, kind: 'reg', periodMinutes: 20, seed: 11 });
  const W = (p: { x: number; y: number }) => ({ x: (p.x - 50) * .6, z: (p.y - 50) * .3 });
  const f0 = k.frameAt(0);
  assert.ok(f0.skaters.filter(s => !s.goalie).every(s => Math.abs(W(s.pos).z) < 9), 'the opening faceoff: everybody at his place at once');
  let last = new Map<string, { x: number; z: number }>(), worst = 0, hMax = 0, rose = 0, faceoffs = 0, wasFace = false;
  for (let i = 0; i < 240 * 60 && !k.ended; i++) {
    k.advance(1 / 60, NO_PAD); k.drain();
    const f = k.frameAt(k.lastTau);
    for (const s of f.skaters) { const w = W(s.pos), l = last.get(s.id); if (l && !s.box) worst = Math.max(worst, Math.hypot(w.x - l.x, w.z - l.z)); }
    last = new Map(f.skaters.filter(s => !s.box).map(s => [s.id, W(s.pos)]));
    if (f.faceoff) { hMax = Math.max(hMax, f.puck.h); if (f.puck.h > 1.25) rose++; if (!wasFace) faceoffs++; assert.ok(f.dot, 'the dot is known'); }
    wasFace = !!f.faceoff;
  }
  assert.ok(worst < 1, `nobody jumps (${worst.toFixed(2)} m in a frame)`);
  assert.ok(faceoffs > 3 && hMax > 1.3 && rose > 0, `the windup lifts the puck (${hMax.toFixed(2)} m)`);
  assert.ok(FO_DROP.windup > .2 && FO_DROP.battle > .3);
});

console.log(`\n${pass} live 3D checks passed`);
