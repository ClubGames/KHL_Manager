/**
 * Nothing of the arena stands between a camera and the ice: rays through the picture of every live and replay
 * camera (all zooms, portrait to ultra-wide screens, the play all over the rink) must reach the ice before any
 * opaque part of the building — the scoreboard steps aside under the high cameras, the low camera sits inside
 * the glass, the benches and penalty boxes stay out of every shot. The near boards may hide a strip at the very
 * bottom of the far cameras (as on TV); that strip is bounded. Also: the benches are built (coaches, players).
 */
import assert from 'node:assert/strict';
import * as T from 'three';
(globalThis as any).document = { createElement: () => ({ width: 0, height: 0, getContext: () => null }) };
const { buildArena } = await import('../src/components/replayArena');
const { benchSeat, boxSeat, BENCH } = await import('../src/components/arenaBenches');
const { liveCameraPose, LIVE_CAMERAS, cameraPose, CAMERAS } = await import('../src/components/replayCameras');
const { RINK } = await import('../src/game/rinkGeometry');

let pass = 0;
const test = (name: string, fn: () => void) => { const t = Date.now(); fn(); pass++; console.log(`✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`); };
const team = (id: string, c: string) => ({ id, name: id, short: id, primaryColor: c, secondaryColor: '#ffffff' }) as any;
const scene = new T.Scene();
const arena = buildArena(scene, team('A', '#c00000'), team('B', '#0000c0'), 1);
scene.updateMatrixWorld(true);
const meshes: T.Mesh[] = [];
scene.traverse(o => { if ((o as T.Mesh).isMesh) meshes.push(o as T.Mesh); });
const ice = arena.reflectionHidden[0];
const visible = (o: T.Object3D) => { for (let x: T.Object3D | null = o; x; x = x.parent) if (!x.visible) return false; return true; };
const opaque = (o: T.Object3D) => { const m = (o as T.Mesh).material as T.Material | T.Material[]; return !(Array.isArray(m) ? m.every(x => x.transparent) : m.transparent); };
const benches = new Set<T.Object3D>(); arena.benchCrowd.parent!.traverse(o => benches.add(o));
const rc = new T.Raycaster();
const HW = RINK.width / 2;

type Tally = { rays: number; boards: number; other: number; ex: string };
function look(name: string, pose: { pos: { x: number; y: number; z: number }; look: { x: number; y: number; z: number }; fov: number }, aspect: number, t: Tally) {
  const cam = new T.PerspectiveCamera(pose.fov, aspect, .05, 250);
  cam.position.set(pose.pos.x, pose.pos.y, pose.pos.z); cam.lookAt(pose.look.x, pose.look.y, pose.look.z); cam.updateMatrixWorld(true);
  arena.view(cam);
  for (const sx of [-.8, -.4, 0, .4, .8]) for (const sy of [-.8, -.4, 0, .4, .8]) {
    rc.setFromCamera(new T.Vector2(sx, sy), cam);
    const hits = rc.intersectObjects(meshes, false).filter(h => visible(h.object));
    const onIce = hits.find(h => h.object === ice);
    if (!onIce) continue;
    t.rays++;
    // the goals stand on the ice: they are part of the play, not of the building
    const inRink = (q: T.Vector3) => q.y < 1.6 && Math.abs(q.z) < HW - .05 && Math.abs(q.x) < RINK.length / 2 - .05;
    const block = hits.find(h => h.distance < onIce.distance - .01 && h.object !== ice && opaque(h.object) && !inRink(h.point));
    if (!block) continue;
    // the near boards (and their glass rail / stanchions) cutting a strip off the bottom of the picture
    const nearBoards = block.point.y < 3.6 && sy <= -.4 && (Math.abs(block.point.z) > HW - .3 || Math.abs(block.point.x) > RINK.length / 2 - 9);
    if (nearBoards) t.boards++;
    else { t.other++; t.ex ||= `${name} scr ${sx},${sy} pos ${pose.pos.x.toFixed(1)},${pose.pos.y.toFixed(1)},${pose.pos.z.toFixed(1)} hit y ${block.point.y.toFixed(2)} ${benches.has(block.object) ? '(bench)' : ''}`; }
  }
}

test('live cameras: the ice is never hidden by the scoreboard, the benches or the penalty boxes; the near boards only clip the bottom edge', () => {
  for (const [mode] of LIVE_CAMERAS) {
    const t: Tally = { rays: 0, boards: 0, other: 0, ex: '' };
    for (const aspect of [.46, 1, 1.78, 2.17]) for (const zoom of [.45, .7, 1, 1.4, 1.8]) for (const fx of [-28, -14, 0, 14, 28]) for (const fz of [-12, 0, 12])
      look(mode, liveCameraPose(mode, { x: fx, z: fz }, zoom, aspect, { attack: 1, speed: 10 }), aspect, t);
    console.log(`   ${mode.padEnd(10)} rays ${t.rays}, near boards ${(100 * t.boards / t.rays).toFixed(1)} %, other ${t.other}`);
    assert.equal(t.other, 0, `${mode}: something stands in the way — ${t.ex}`);
    assert.ok(t.boards / t.rays < (mode === 'ice' ? .001 : .03), `${mode}: the boards hide too much (${t.boards}/${t.rays})`);
  }
});

test('replay cameras: the same on a goal clip at either end', () => {
  const bad: string[] = [];
  for (const dir of [1, -1] as const) {
    const k = (t: number, x: number, y: number) => ({ t, x, y, h: 0 });
    const xs = dir > 0 ? [40, 62, 80, 89] : [60, 38, 20, 11];
    const clip: any = { label: 'g', duration: 6, release: .7, goal: .78, scorer: 'p1', attacking: dir > 0 ? 0 : 1, dir,
      puck: xs.map((x, i) => k(i / 3, x, 50 + (i - 1.5) * 8)), tracks: [{ id: 'p1', side: 0, keys: xs.map((x, i) => k(i / 3, x - dir * 1, 50 + (i - 1.5) * 8)) }] };
    for (const [view] of CAMERAS) {
      if (view === 'auto') continue;
      const t: Tally = { rays: 0, boards: 0, other: 0, ex: '' };
      for (const aspect of [.46, 1.78, 2.17]) for (const zoom of [.45, 1, 1.8]) for (const time of [.1, .45, .7, .76, .9])
        look(view, cameraPose(clip, time, view as any, zoom, aspect), aspect, t);
      if (!t.rays) continue;
      if (t.other) bad.push(`${view}: something stands in the way (${t.other}) — ${t.ex}`);
      if (t.boards / t.rays >= .05) bad.push(`${view}: the boards hide too much (${t.boards}/${t.rays})`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the high cameras put the scoreboard away, the broadcast keeps it', () => {
  const shown = (mode: any, zoom: number) => {
    const p = liveCameraPose(mode, { x: 0, z: 0 }, zoom, 1.78, { attack: 1, speed: 0 });
    const cam = new T.PerspectiveCamera(p.fov, 1.78, .05, 250); cam.position.set(p.pos.x, p.pos.y, p.pos.z); cam.lookAt(p.look.x, p.look.y, p.look.z); cam.updateMatrixWorld(true);
    arena.view(cam);
    let on = false; scene.traverse(o => { if ((o as T.Mesh).isMesh && Math.abs(o.position.y - 15.5) < .01 && !o.position.x) on = o.visible; });
    return on;
  };
  assert.equal(shown('overhead', 1), false, 'overhead');
  assert.equal(shown('high', 1), false, 'high');
  assert.equal(shown('broadcast', 1), true, 'broadcast');
});

test('benches: seats for a whole bench on each side and the boxes across the ice, coaches and players built', () => {
  for (const side of [0, 1] as const) {
    const seats = Array.from({ length: BENCH.slots }, (_, i) => benchSeat(side, i));
    for (const s of seats) { assert.ok(s.z < -HW - .5 && s.z > -HW - 2.5, 'behind the far boards'); assert.ok(Math.sign(s.x) === (side ? 1 : -1), 'own half of the bench'); }
    for (let i = 1; i < seats.length; i++) assert.ok(seats[i].x - seats[i - 1].x > .45, 'shoulder room');
    for (let i = 0; i < 3; i++) { const b = boxSeat(side, i); assert.ok(b.z > HW + .5, 'the box across the ice'); }
  }
  let crowd = 0; arena.benchCrowd.traverse(o => { if ((o as T.Mesh).isMesh) crowd += ((o as T.Mesh).geometry.getAttribute('position').count); });
  assert.ok(crowd > 5000, `the seated players have bodies (${crowd} vertices)`);
  assert.ok([...benches].filter(o => (o as T.Mesh).isMesh).length < 60, 'merged per colour: few draw calls');
});

console.log(`\n${pass} arena view tests passed`);
