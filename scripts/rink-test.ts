// npx tsx scripts/rink-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { buildReplayClip, liveRinkFrame, samplePath } from '../src/game/rinkPlayback';
import type { GameEvent } from '../src/types';
const r = parseRosterText(readFileSync('roster.json', 'utf8'));
const home = r.teams.find(t => t.id === 'ska')!, away = r.teams.find(t => t.id === 'avangard')!;
const ids = (t: typeof home) => [...t.lineup.F[0], ...t.lineup.D[0]].filter((id): id is string => !!id);
const h = ids(home), a = ids(away);
const base: GameEvent = { sec: 481, period: 1, time: '11:59', type: 'goal', team: home.id, player: h[0], players: [h[1], h[2]], goalie: away.lineup.starterG, ice: [h, a], x: 82, y: 34, shotType: 'wrist', strength: 'EV', score: [1, 0], text: 'Гол' };
let checks = 0;
function test(name: string, fn: () => void) { fn(); checks++; console.log(`ok ${name}`); }
const clip = (change: Partial<GameEvent> = {}) => buildReplayClip({ ...base, ...change }, home, away, r.players)!;

test('deterministic reconstruction never changes engine event or roster', () => {
  const before = JSON.stringify({ base, home, away, p: r.players });
  assert.deepEqual(clip(), clip());
  assert.equal(JSON.stringify({ base, home, away, p: r.players }), before);
});
test('release is the actual shot location, scorer and on-ice identities preserved', () => {
  const c = clip(); const p = samplePath(c.puck, c.release);
  assert.equal(p.x, base.x); assert.equal(p.y, base.y);
  assert.equal(c.scorer, base.player);
  assert.deepEqual(c.tracks.filter(t => t.side === 0).map(t => t.id).sort(), [...h].sort());
  assert.deepEqual(samplePath(c.tracks.find(t => t.id === base.player)!.keys, c.release), { x: 82, y: 34, h: 0 });
});
test('six shot types have distinct paths, labels and elevated shots', () => {
  const types = ['wrist', 'snap', 'slap', 'tip', 'rebound', 'backhand'] as const;
  assert.equal(new Set(types.map(type => clip({ shotType: type }).label)).size, 6);
  assert.equal(new Set(types.map(type => JSON.stringify(clip({ shotType: type }).puck))).size, 6);
  assert.notDeepEqual(clip({ shotType: 'tip' }).puck, clip({ shotType: 'rebound' }).puck);
  assert.notDeepEqual(clip({ shotType: 'backhand' }).tracks[0].keys, clip({ shotType: 'wrist' }).tracks[0].keys);
  assert.ok(clip({ shotType: 'slap' }).puck.some(k => k.h > .3));
});
test('assists meet moving recipients; unassisted carrier owns the puck until release', () => {
  const c = clip({ players: [] });
  for (const t of [0, .12, .32, .45, .54, .66]) assert.deepEqual(samplePath(c.puck, t), samplePath(c.tracks[0].keys, t));
  const assisted = clip();
  assert.deepEqual(samplePath(assisted.puck, .29), samplePath(assisted.tracks.find(t => t.id === h[1])!.keys, .29));
  assert.deepEqual(samplePath(assisted.puck, .56), samplePath(assisted.tracks[0].keys, .56));
});
test('away attacks left and crosses the opposite goal line', () => {
  const c = clip({ team: away.id, player: a[0], players: [a[1]], goalie: home.lineup.starterG, x: 18 });
  assert.equal(samplePath(c.puck, c.release).x, 18);
  assert.ok(samplePath(c.puck, c.goal).x < 7);
  assert.ok(samplePath(c.puck, 1).x < 7);
});
test('goal crossing occurs after release, between posts and beneath the crossbar', () => {
  for (const shotType of ['wrist', 'slap', 'tip', 'rebound', 'backhand'] as const) {
    const c = clip({ shotType });
    assert.ok(c.release < c.goal);
    const p = samplePath(c.puck, c.goal); assert.ok(p.x > 93 && p.y > 46.95 && p.y < 53.05 && p.h < 1.22);
    assert.ok(samplePath(c.puck, c.release).x < 93);
  }
});
test('goalie stays in crease and moves toward the shot target, not out of the way', () => {
  const c = clip(); const g = c.tracks.find(t => t.goalie)!;
  assert.ok(g); const target = samplePath(c.puck, c.goal), before = samplePath(g.keys, c.release), after = samplePath(g.keys, c.goal);
  assert.ok(Math.abs(after.y - target.y) < Math.abs(before.y - target.y));
  assert.ok(g.keys.every(k => k.x >= 89 && k.x <= 92 && k.y >= 45.5 && k.y <= 54.5));
});
test('empty net removes the goalie, including explicit null in older events', () => {
  assert.ok(!clip({ strength: 'EN', goalie: null }).tracks.some(t => t.goalie));
  assert.ok(!clip({ goalie: null }).tracks.some(t => t.goalie));
});
test('3v3, 4v4 and special teams use actual participants without inventing five skaters', () => {
  for (const [nh, na, strength, period] of [[3, 3, 'EV', 4], [5, 4, 'PP', 2], [4, 5, 'SH', 2], [4, 4, '4v4', 2]] as const) {
    const c = clip({ ice: [h.slice(0, nh), a.slice(0, na)], players: [], strength, period });
    assert.equal(c.tracks.filter(t => !t.goalie && t.side === 0).length, nh);
    assert.equal(c.tracks.filter(t => !t.goalie && t.side === 1).length, na);
  }
});
test('all sampled tracks finite, no instantaneous duplicate times; different events vary', () => {
  for (const c of [clip(), clip({ shotType: 'tip' }), clip({ shotType: 'rebound' }), clip({ strength: 'SH' })]) {
    for (const keys of [c.puck, ...c.tracks.map(t => t.keys)]) {
      assert.ok(keys.every((k, i) => i === 0 || k.t > keys[i - 1].t));
      for (let i = 0; i <= 100; i++) { const p = samplePath(keys, i / 100); assert.ok(Number.isFinite(p.x + p.y + p.h)); assert.ok(p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100); }
    }
  }
  assert.notDeepEqual(clip().puck, clip({ sec: 512 }).puck);
});
test('missing legacy coordinates and ice have safe fallbacks; missing scorer returns null', () => {
  assert.ok(clip({ x: undefined, y: undefined, ice: undefined }).tracks.length > 1);
  assert.equal(buildReplayClip({ ...base, player: undefined }, home, away, r.players), null);
});
test('live display advances only with the shared clock and uses supplied ice/empty nets', () => {
  const args = [h, a] as [string[], string[]];
  const f = liveRinkFrame(500, args, [home.lineup.starterG, away.lineup.starterG], base, home.id);
  assert.deepEqual(f, liveRinkFrame(500, args, [home.lineup.starterG, away.lineup.starterG], base, home.id));
  assert.notDeepEqual(f, liveRinkFrame(510, args, [home.lineup.starterG, away.lineup.starterG], base, home.id));
  const short = liveRinkFrame(500, [h.slice(0, 3), a.slice(0, 4)], [null, away.lineup.starterG], null, home.id);
  assert.equal(short.skaters.length, 8);
  assert.equal(short.skaters.filter(s => s.goalie).length, 1);
  const future = { ...base, sec: 700 };
  assert.deepEqual(liveRinkFrame(500, args, [null, null], future, home.id), liveRinkFrame(500, args, [null, null], null, home.id));
});
console.log(`PASS: ${checks} rink playback checks`);
