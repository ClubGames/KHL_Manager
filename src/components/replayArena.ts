import * as T from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Team } from '../types';
import { FACEOFF_SPOTS, RINK } from '../game/rinkGeometry';
import { getClubLogoSources } from '../game/clubColors';
import { LG } from '../brand';
import { buildBenches, type BenchKit } from './arenaBenches';

const _ray = new T.Ray(), _pt = new T.Vector3(), _frustum = new T.Frustum(), _pv = new T.Matrix4(), _origin = new T.Vector3();
/**
 * Does the box stand between the camera and the ice? Lines of sight from the camera to a grid of points over the
 * rink (those in the picture): one that crosses the box is a piece of the play the box would hide.
 */
export function scoreboardBlocks(camera: T.Camera, box: T.Box3): boolean {
  camera.updateMatrixWorld();
  _origin.setFromMatrixPosition(camera.matrixWorld);
  if (_origin.y < box.min.y - 6) return false; // from below it hides nothing but the roof
  _frustum.setFromProjectionMatrix(_pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  for (let i = 0; i <= 20; i++) for (let j = 0; j <= 10; j++) {
    _pt.set(-RINK.length / 2 + i * RINK.length / 20, 0, -RINK.width / 2 + j * RINK.width / 10);
    if (!_frustum.containsPoint(_pt)) continue;
    _ray.set(_origin, _pt.sub(_origin).normalize());
    if (_ray.intersectsBox(box)) return true;
  }
  return false;
}

/**
 * Static arena for the 3D goal replay, built for few draw calls:
 *  - the ice is ONE mesh with all markings painted on a canvas texture in real IIHF/KHL proportions;
 *  - boards, glass, the stands and the floor are each one swept mesh around the rounded rink outline;
 *  - each goal is a handful of tubes plus one alpha-tested net mesh.
 * World space: metres, origin at centre ice, +x along the rink, +z across it, +y up.
 */

const HALF_L = RINK.length / 2, HALF_W = RINK.width / 2, CORNER = RINK.corner;

export type Arena = {
  group: T.Group; dispose: () => void; refresh: () => void;
  /** Hidden while the planar ice reflection is rendered (the ice itself, the bowl and other things the ice cannot mirror visibly). */
  reflectionHidden: T.Object3D[];
  /** Ice reflection inputs: texture, world → reflection-texture matrix, strength (0 = off). */
  iceReflection: { texture: { value: T.Texture | null }; matrix: { value: T.Matrix4 }; strength: { value: number } };
  /** The low-poly players on the benches (the live match on the higher presets seats the real figures instead). */
  benchCrowd: T.Group;
  /** Call before each render (after the reflection pass): hides what would stand between this camera and the ice (the scoreboard under the high cameras). */
  view: (camera: T.Camera) => void;
};
/** Texture detail of the static arena: `hi` doubles the ice/crowd/board canvases (sharper markings and ads). */
export type ArenaOptions = { detail?: 'normal' | 'hi'; /** kit colours of the low-poly bench players (home, away) */ benchKits?: [BenchKit, BenchKit] };

type Owned = { geometries: T.BufferGeometry[]; materials: T.Material[]; textures: T.Texture[] };

/** Points around the rounded rink outline pushed out by `offset` (same parametrisation for every offset). */
function outline(offset: number, seg = 14) {
  const pts: { x: number; z: number; nx: number; nz: number; u: number }[] = [];
  const cx = HALF_L - CORNER, cz = HALF_W - CORNER, r = CORNER + offset;
  const corners: [number, number, number][] = [[cx, cz, 0], [-cx, cz, Math.PI / 2], [-cx, -cz, Math.PI], [cx, -cz, Math.PI * 1.5]];
  for (const [x0, z0, a0] of corners) for (let i = 0; i <= seg; i++) {
    const a = a0 + (i / seg) * Math.PI / 2, nx = Math.cos(a), nz = Math.sin(a);
    pts.push({ x: x0 + nx * r, z: z0 + nz * r, nx, nz, u: 0 });
  }
  pts.push({ ...pts[0] });
  for (let i = 1; i < pts.length; i++) pts[i].u = pts[i - 1].u + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return pts;
}

/** `y` may depend on the position around the rink (e.g. taller glass behind the nets). */
type ProfilePoint = { o: number; y: number | ((x: number, z: number) => number); v: number };
/** Sweeps profile segments around the rink: one merged geometry, u = metres along the outline / uMetres. */
function sweep(segments: [ProfilePoint, ProfilePoint][], uMetres: number, seg = 14) {
  const parts = segments.map(([a, b]) => {
    const ra = outline(a.o, seg), rb = outline(b.o, seg);
    const pos: number[] = [], uv: number[] = [], index: number[] = [];
    ra.forEach((p, i) => {
      const q = rb[i];
      const ya = typeof a.y === 'function' ? a.y(p.x, p.z) : a.y, yb = typeof b.y === 'function' ? b.y(q.x, q.z) : b.y;
      pos.push(p.x, ya, p.z, q.x, yb, q.z);
      uv.push(ra[i].u / uMetres, a.v, ra[i].u / uMetres, b.v);
      if (i) { const k = i * 2; index.push(k - 2, k - 1, k, k - 1, k + 1, k); }
    });
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    g.setIndex(index); g.computeVertexNormals();
    return g;
  });
  const merged = mergeGeometries(parts, false)!;
  parts.forEach(g => g.dispose());
  return merged;
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  return { c, ctx: c.getContext('2d') };
}

function rng(seed: number) {
  let a = seed | 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Ice markings painted at 34 px per metre. Canvas x = rink length, canvas y = world z (top = z −15). */
function paintIce(ctx: CanvasRenderingContext2D, w: number, h: number, logo?: HTMLImageElement) {
  const k = w / RINK.length, X = (m: number) => m * k, Y = (m: number) => m * k, u = w / 2048;
  const grad = ctx.createRadialGradient(w / 2, h / 2, h * .1, w / 2, h / 2, w * .6);
  grad.addColorStop(0, '#f4fafd'); grad.addColorStop(1, '#dbe9f0');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
  // skate scratches and snow: very faint, so the ice does not look like plastic
  const rand = rng(77);
  ctx.globalAlpha = .05; ctx.strokeStyle = '#7d99a8'; ctx.lineWidth = u;
  for (let i = 0; i < 900; i++) {
    const x = rand() * w, y = rand() * h, a = (rand() - .5) * .8 + (rand() < .5 ? 0 : Math.PI), l = (20 + rand() * 90) * u;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + Math.cos(a) * l * .5 + (rand() - .5) * 20 * u, y + Math.sin(a) * l * .5, x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const line = (x: number, width: number, color: string) => { ctx.fillStyle = color; ctx.fillRect(X(x) - Math.max(2.5 * u, X(width)) / 2, 0, Math.max(2.5 * u, X(width)), h); };
  const ring = (x: number, y: number, r: number, color: string, width = .05) => { ctx.strokeStyle = color; ctx.lineWidth = Math.max(3 * u, X(width)); ctx.beginPath(); ctx.arc(X(x), Y(y), X(r), 0, Math.PI * 2); ctx.stroke(); };
  const dot = (x: number, y: number, r: number, color: string) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(X(x), Y(y), X(r), 0, Math.PI * 2); ctx.fill(); };
  const RED = '#c8243a', BLUE = '#1d58a8';
  // centre logo first, under the lines
  if (logo && logo.naturalWidth) {
    const s = X(5.2), r = logo.naturalWidth / logo.naturalHeight;
    ctx.globalAlpha = .9; ctx.drawImage(logo, w / 2 - (r >= 1 ? s : s * r) / 2, h / 2 - (r >= 1 ? s / r : s) / 2, r >= 1 ? s : s * r, r >= 1 ? s / r : s); ctx.globalAlpha = 1;
  } else {
    ctx.fillStyle = '#9fb6c4'; ctx.font = `bold ${X(2.2)}px Oswald, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(LG(), w / 2, h / 2);
  }
  for (const x of [RINK.goalLine, RINK.length - RINK.goalLine]) line(x, RINK.lineWidth, RED);
  for (const x of [RINK.blueLine, RINK.length - RINK.blueLine]) line(x, RINK.blueWidth, BLUE);
  line(HALF_L, RINK.redWidth, RED);
  ring(HALF_L, HALF_W, RINK.circleR, BLUE); dot(HALF_L, HALF_W, .15, BLUE);
  for (const d of FACEOFF_SPOTS.end) {
    ring(d.x, d.y, RINK.circleR, RED); dot(d.x, d.y, RINK.dotR, RED);
    ctx.strokeStyle = RED; ctx.lineWidth = 3 * u;
    for (const sy of [-1, 1]) for (const sx of [-1, 1]) {
      // hash marks on the circle and the double "L" next to the spot
      ctx.beginPath(); ctx.moveTo(X(d.x + sx * .85), Y(d.y + sy * (RINK.circleR - .05))); ctx.lineTo(X(d.x + sx * .85), Y(d.y + sy * (RINK.circleR + .6))); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X(d.x + sx * .6), Y(d.y + sy * .9)); ctx.lineTo(X(d.x + sx * .6), Y(d.y + sy * .45)); ctx.lineTo(X(d.x + sx * 1.8), Y(d.y + sy * .45)); ctx.stroke();
    }
  }
  for (const d of FACEOFF_SPOTS.neutral) dot(d.x, d.y, RINK.dotR, RED);
  for (const [gx, s] of [[RINK.goalLine, 1], [RINK.length - RINK.goalLine, -1]] as const) {
    ctx.fillStyle = '#7fc3e6'; ctx.strokeStyle = RED; ctx.lineWidth = 3 * u;
    ctx.beginPath(); ctx.moveTo(X(gx), Y(HALF_W - RINK.crease)); ctx.arc(X(gx), Y(HALF_W), X(RINK.crease), -Math.PI / 2, Math.PI / 2, s < 0); ctx.closePath(); ctx.fill(); ctx.stroke();
    // the two short "goalkeeper" ticks inside the crease
    for (const sy of [-1, 1]) { ctx.beginPath(); ctx.moveTo(X(gx + s * 1.22), Y(HALF_W + sy * 1.22)); ctx.lineTo(X(gx + s * 1.22), Y(HALF_W + sy * 1.07)); ctx.stroke(); }
  }
  // the ice gets a little snowy along the boards
  const edge = ctx.createLinearGradient(0, 0, 0, h);
  edge.addColorStop(0, 'rgba(200,214,222,.35)'); edge.addColorStop(.04, 'rgba(200,214,222,0)'); edge.addColorStop(.96, 'rgba(200,214,222,0)'); edge.addColorStop(1, 'rgba(200,214,222,.35)');
  ctx.fillStyle = edge; ctx.fillRect(0, 0, w, h);
}

/** Boards: yellow kick plate, white dasher with advertising panels, dark top rail. 12 m per repeat. */
function paintBoards(ctx: CanvasRenderingContext2D, w: number, h: number, home: Team, away: Team) {
  ctx.fillStyle = '#f6f8fa'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#e8b52f'; ctx.fillRect(0, h * .83, w, h * .17);
  ctx.fillStyle = '#16304d'; ctx.fillRect(0, 0, w, h * .07);
  const panels = [[LG(), '#c8243a'], [home.name, home.primaryColor], ['ХОККЕЙ', '#1d58a8'], [away.name, away.primaryColor]];
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  panels.forEach(([text, color], i) => {
    const x0 = (i / panels.length) * w;
    ctx.fillStyle = i % 2 ? '#ffffff' : '#eef3f7'; ctx.fillRect(x0 + 4 * (w / 1536), h * .12, w / panels.length - 8 * (w / 1536), h * .66);
    ctx.fillStyle = color; ctx.font = `bold ${Math.round(h * .38)}px Oswald, sans-serif`;
    ctx.fillText(text.toUpperCase(), x0 + w / panels.length / 2, h * .46, w / panels.length - 24);
  });
}

/** Mix of two #rrggbb colours (t = 0 → a). */
function mix(a: string, b: string, t: number) {
  const pa = new T.Color(a), pb = new T.Color(b);
  return '#' + pa.lerp(pb, t).getHexString();
}

/**
 * Spectators: rows of tiny shirts (most in the home club's colours) on seats in the club colour, with stair aisles
 * every sector. `rows` rows over the texture height; `empty` = share of free seats.
 */
function paintCrowd(ctx: CanvasRenderingContext2D, w: number, h: number, home: Team, seed = 5, rows = 22, empty = .1) {
  ctx.fillStyle = '#121c28'; ctx.fillRect(0, 0, w, h);
  const rand = rng(seed), rh = h / rows, u = w / 1024;
  const palette = [home.primaryColor, home.primaryColor, home.secondaryColor, '#d9dde2', '#2a3644', '#55606d', '#8a6d5a', '#c9a27e'];
  const seat = mix(home.primaryColor, '#0b121a', .55), seatBack = mix(home.primaryColor, '#0b121a', .35);
  const sectors = 3, aisle = 14 * u;
  for (let r = 0; r < rows; r++) {
    const y0 = r * rh;
    ctx.fillStyle = r % 2 ? '#1b2735' : '#172230'; ctx.fillRect(0, y0, w, rh);
    // step edge (light concrete line at the front of every row)
    ctx.fillStyle = '#2b3846'; ctx.fillRect(0, y0 + rh * .92, w, rh * .08);
    for (let x = 0; x < w; x += (4 + rand() * 1.2) * u) {
      if ((x + aisle) % (w / sectors) < aisle * 2) continue; // stairs
      ctx.fillStyle = seatBack; ctx.fillRect(x, y0 + rh * .3, 3.4 * u, rh * .45);
      ctx.fillStyle = seat; ctx.fillRect(x, y0 + rh * .7, 3.4 * u, rh * .18);
      if (rand() < empty) continue; // empty seat
      ctx.fillStyle = palette[Math.floor(rand() * palette.length)];
      ctx.fillRect(x, y0 + rh * .35, 3 * u, rh * .55);
      ctx.fillStyle = rand() < .5 ? '#e0b896' : '#c79a78';
      ctx.fillRect(x + .5 * u, y0 + rh * .12, 2 * u, rh * .25);
    }
  }
  // stair aisles: grey steps with a yellow nosing, a hand rail down the middle
  for (let k = 0; k < sectors; k++) {
    const x0 = ((k + 1) * w) / sectors - aisle;
    for (let r = 0; r < rows * 2; r++) {
      const y0 = (r * rh) / 2;
      ctx.fillStyle = r % 2 ? '#3a4652' : '#46525e'; ctx.fillRect(x0, y0, aisle * 2, rh / 2);
      ctx.fillStyle = '#b8962e'; ctx.fillRect(x0, y0 + rh / 2 - rh * .06, aisle * 2, rh * .06);
    }
    ctx.fillStyle = '#9aa6b0'; ctx.fillRect(x0 + aisle - u, 0, 2 * u, h);
  }
}

/** VIP boxes between the tiers: a dark ring with lit glass fronts and the club colour stripe. */
function paintSuites(ctx: CanvasRenderingContext2D, w: number, h: number, home: Team) {
  ctx.fillStyle = '#0c131c'; ctx.fillRect(0, 0, w, h);
  const rand = rng(11), n = 16, bw = w / n;
  for (let i = 0; i < n; i++) {
    const x = i * bw;
    const g = ctx.createLinearGradient(0, h * .18, 0, h * .78);
    const lit = rand();
    g.addColorStop(0, lit > .25 ? '#e8d3a2' : '#2a3442'); g.addColorStop(1, lit > .25 ? '#8a7350' : '#18202b');
    ctx.fillStyle = g; ctx.fillRect(x + bw * .06, h * .18, bw * .88, h * .6);
    ctx.fillStyle = 'rgba(10,16,24,.55)'; ctx.fillRect(x + bw * .06, h * .18, bw * .88, h * .08); // shade under the roof
    if (lit > .25) for (let k = 0; k < 4; k++) { // silhouettes
      ctx.fillStyle = 'rgba(20,24,30,.7)';
      const px = x + bw * (.15 + k * .2 + rand() * .05);
      ctx.fillRect(px, h * .45, bw * .07, h * .33); ctx.fillRect(px + bw * .01, h * .36, bw * .05, h * .09);
    }
  }
  ctx.fillStyle = home.primaryColor; ctx.fillRect(0, h * .84, w, h * .1);
  ctx.fillStyle = '#d9dee4'; ctx.fillRect(0, h * .8, w, h * .04);
}

function buildGoal(parent: T.Object3D, dir: 1 | -1, own: Owned, mats: { red: T.Material; white: T.Material; net: T.Material; skirt: T.Material }) {
  const g = new T.Group(); g.position.x = dir * (HALF_L - RINK.goalLine); g.scale.x = dir; parent.add(g);
  const add = (geo: T.BufferGeometry, mat: T.Material, cast = true) => { own.geometries.push(geo); const m = new T.Mesh(geo, mat); m.castShadow = cast; m.receiveShadow = true; g.add(m); return m; };
  const W2 = RINK.goalWidth / 2 + .03, H = RINK.goalHeight, D = RINK.goalDepth, R = .03;
  // posts and crossbar (red, 6 cm), on the goal line; +x local = into the net
  for (const z of [-W2, W2]) add(new T.CylinderGeometry(R, R, H, 12), mats.red).position.set(0, H / 2, z);
  const bar = add(new T.CylinderGeometry(R, R, W2 * 2 + R * 2, 12), mats.red); bar.rotation.x = Math.PI / 2; bar.position.y = H;
  // base frame along the ice and the top frame behind the crossbar (white)
  const base = new T.CatmullRomCurve3([[0, -W2], [.45, -W2 - .06], [.9, -.82], [D, 0], [.9, .82], [.45, W2 + .06], [0, W2]].map(([x, z]) => new T.Vector3(x, .025, z)));
  const top = new T.CatmullRomCurve3([[0, -W2], [.28, -W2 + .01], [.46, -.6], [.5, 0], [.46, .6], [.28, W2 - .01], [0, W2]].map(([x, z]) => new T.Vector3(x, H - .03 - x * .08, z)));
  add(new T.TubeGeometry(base, 48, .022, 6, false), mats.white);
  add(new T.TubeGeometry(top, 40, .018, 6, false), mats.white);
  // net: lofted between the crossbar (roof) / top frame and the base frame
  const N = 48, loft = (a: (t: number) => T.Vector3, b: (t: number) => T.Vector3, cells: number, vScale: number, mat: T.Material) => {
    const pos: number[] = [], uv: number[] = [], index: number[] = [];
    let len = 0, prev = a(0);
    for (let i = 0; i <= N; i++) {
      const t = i / N, p = a(t), q = b(t);
      len += p.distanceTo(prev); prev = p;
      pos.push(p.x, p.y, p.z, q.x, q.y, q.z);
      uv.push(len * cells, 0, len * cells, p.distanceTo(q) * vScale);
      if (i) { const k = i * 2; index.push(k - 2, k - 1, k, k - 1, k + 1, k); }
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    geo.setIndex(index); geo.computeVertexNormals();
    return add(geo, mat, false);
  };
  const crossbar = (t: number) => new T.Vector3(0, H, -W2 + t * W2 * 2);
  loft(crossbar, t => top.getPoint(t), 14, 14, mats.net);
  loft(t => top.getPoint(t), t => base.getPoint(t).setY(.02), 14, 14, mats.net);
  // white padding skirt along the inside of the base frame
  loft(t => base.getPoint(t).setY(.24), t => base.getPoint(t).setY(.02), 1, 1, mats.skirt);
  return g;
}

/** `onChange`: called when a late asset (the centre-ice logo) changed a texture, so a paused replay redraws. */
export function buildArena(scene: T.Object3D, home: Team, away: Team, anisotropy: number, onChange: () => void = () => {}, options: ArenaOptions = {}): Arena {
  const hi = options.detail === 'hi', K = hi ? 2 : 1;
  const own: Owned = { geometries: [], materials: [], textures: [] };
  let disposed = false;
  const group = new T.Group(); scene.add(group);
  const mat = <M extends T.Material>(m: M) => { own.materials.push(m); return m; };
  const tex = (c: HTMLCanvasElement, repeat = false) => {
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; t.anisotropy = anisotropy;
    if (repeat) { t.wrapS = T.RepeatWrapping; }
    own.textures.push(t); return t;
  };
  const mesh = (geo: T.BufferGeometry, m: T.Material, receive = true) => { own.geometries.push(geo); const x = new T.Mesh(geo, m); x.receiveShadow = receive; group.add(x); return x; };

  // Ice: one shape, all markings in the texture.
  const shape = new T.Shape();
  const cx = HALF_L - CORNER, cz = HALF_W - CORNER;
  shape.moveTo(-cx, -HALF_W); shape.lineTo(cx, -HALF_W); shape.absarc(cx, -cz, CORNER, -Math.PI / 2, 0, false); shape.lineTo(HALF_L, cz);
  shape.absarc(cx, cz, CORNER, 0, Math.PI / 2, false); shape.lineTo(-cx, HALF_W); shape.absarc(-cx, cz, CORNER, Math.PI / 2, Math.PI, false);
  shape.lineTo(-HALF_L, -cz); shape.absarc(-cx, -cz, CORNER, Math.PI, Math.PI * 1.5, false);
  const iceCanvas = canvas(2048 * K, 1024 * K);
  const iceTex = tex(iceCanvas.c);
  iceTex.repeat.set(1 / RINK.length, 1 / RINK.width); iceTex.offset.set(.5, .5);
  let logo: HTMLImageElement | undefined;
  const paint = () => { if (iceCanvas.ctx) { paintIce(iceCanvas.ctx, 2048 * K, 1024 * K, logo); iceTex.needsUpdate = true; } };
  paint();
  // Ice material: the painted texture, plus an optional planar reflection of the players (blurred, fresnel-weighted).
  const iceReflection = { texture: { value: null as T.Texture | null }, matrix: { value: new T.Matrix4() }, strength: { value: 0 } };
  const iceMat = mat(new T.MeshStandardMaterial({ map: iceTex, roughness: .3, metalness: 0 }));
  iceMat.onBeforeCompile = shader => {
    shader.uniforms.uRefl = iceReflection.texture; shader.uniforms.uReflMat = iceReflection.matrix; shader.uniforms.uReflOn = iceReflection.strength;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 uReflMat;\nvarying vec4 vRefl;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvRefl = uReflMat * modelMatrix * vec4(transformed, 1.0);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uRefl;\nuniform float uReflOn;\nvarying vec4 vRefl;')
      .replace('#include <opaque_fragment>', `if (uReflOn > 0.0) {
          vec2 ruv = vRefl.xy / vRefl.w;
          vec4 r = texture2D(uRefl, ruv) * .36
            + (texture2D(uRefl, ruv + vec2(.0025, .0)) + texture2D(uRefl, ruv - vec2(.0025, .0))
             + texture2D(uRefl, ruv + vec2(.0, .004)) + texture2D(uRefl, ruv - vec2(.0, .004))) * .16;
          float ndv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
          float f = uReflOn * (.12 + .3 * pow(1.0 - ndv, 3.0)) * r.a;
          outgoingLight = mix(outgoingLight, r.rgb / max(r.a, .001), f);
        }
        #include <opaque_fragment>`);
  };
  iceMat.customProgramCacheKey = () => 'khl-ice-reflect-1';
  const ice = mesh(new T.ShapeGeometry(shape, 24), iceMat);
  ice.rotation.x = -Math.PI / 2;
  // Home logo at centre ice once it has loaded (same-origin logos only: a tainted canvas cannot be uploaded).
  const sources = getClubLogoSources(home);
  const tryLogo = (i: number) => {
    if (i >= sources.length || typeof Image === 'undefined') return;
    const img = new Image(); img.decoding = 'async'; img.crossOrigin = 'anonymous';
    img.onload = () => { if (disposed) return; logo = img; paint(); onChange(); };
    img.onerror = () => tryLogo(i + 1);
    img.src = sources[i];
  };
  tryLogo(0);

  // Floor around the rink.
  const hidden: T.Object3D[] = [ice];
  const bowl = (m: T.Mesh) => { hidden.push(m); return m; };
  bowl(mesh(sweep([[{ o: .2, y: -.02, v: 0 }, { o: 5, y: -.02, v: 1 }]], 10), mat(new T.MeshStandardMaterial({ color: '#2a3542', roughness: .9 }))));
  // Boards: inner face with advertising, white cap, dark outside.
  const boardCanvas = canvas(1536 * K, 136 * K);
  if (boardCanvas.ctx) paintBoards(boardCanvas.ctx, 1536 * K, 136 * K, home, away);
  const boardTex = tex(boardCanvas.c, true);
  const boards = mesh(sweep([
    [{ o: 0, y: 0, v: 0 }, { o: 0, y: 1.07, v: 1 }],
    [{ o: 0, y: 1.07, v: .985 }, { o: .2, y: 1.07, v: .985 }],
    [{ o: .2, y: 1.07, v: .985 }, { o: .2, y: 0, v: .985 }],
  ], 12, 20), mat(new T.MeshStandardMaterial({ map: boardTex, roughness: .5, side: T.DoubleSide })));
  boards.castShadow = false;
  // Glass: 1.8 m along the sides, rising through the corners to 2.4 m behind the nets (as in KHL arenas).
  const glassTop = (x: number) => 1.07 + 1.8 + .6 * T.MathUtils.smoothstep(Math.abs(x), HALF_L - CORNER - 1, HALF_L - CORNER * .35);
  bowl(mesh(sweep([[{ o: .1, y: 1.07, v: 0 }, { o: .1, y: glassTop, v: 1 }]], 10, 20), mat(new T.MeshStandardMaterial({ color: '#cfe8f4', transparent: true, opacity: .12, roughness: .05, metalness: .1, depthWrite: false, side: T.DoubleSide })), false));
  // Thin aluminium top rail along the glass edge.
  bowl(mesh(sweep([[{ o: .07, y: glassTop, v: 0 }, { o: .13, y: glassTop, v: 1 }]], 10, 20), mat(new T.MeshStandardMaterial({ color: '#c3ced6', metalness: .5, roughness: .35, side: T.DoubleSide })), false));
  // Glass stanchions: one instanced mesh, each as tall as the glass where it stands.
  const ring = outline(.1, 20), posts: { x: number; z: number; top: number }[] = [];
  for (let i = 1, acc = 0; i < ring.length; i++) { acc += ring[i].u - ring[i - 1].u; if (acc > 2.4) { acc = 0; posts.push({ x: ring[i].x, z: ring[i].z, top: glassTop(ring[i].x) }); } }
  const postGeo = new T.BoxGeometry(.05, 1, .05); own.geometries.push(postGeo);
  const stanchions = new T.InstancedMesh(postGeo, mat(new T.MeshStandardMaterial({ color: '#b7c4cc', metalness: .4, roughness: .4 })), posts.length);
  const m4 = new T.Matrix4();
  posts.forEach((p, i) => { const hgt = p.top - 1.07; stanchions.setMatrixAt(i, m4.makeScale(1, hgt, 1).setPosition(p.x, 1.07 + hgt / 2, p.z)); });
  group.add(stanchions);
  // Stands: two crowd tiers (seats in the club colour, stair aisles) above a dark wall with an LED ribbon,
  // a ring of lit VIP boxes between the tiers, a dark upper wall and the roof.
  const crowdCanvas = canvas(1024 * K, 256 * K);
  if (crowdCanvas.ctx) paintCrowd(crowdCanvas.ctx, 1024 * K, 256 * K, home, 5, 11, .08);
  const crowdTex = tex(crowdCanvas.c, true);
  const upperCanvas = canvas(1024 * K, 256 * K);
  if (upperCanvas.ctx) paintCrowd(upperCanvas.ctx, 1024 * K, 256 * K, home, 9, 11, .18);
  const upperTex = tex(upperCanvas.c, true);
  const suiteCanvas = canvas(1024 * K, 64 * K);
  if (suiteCanvas.ctx) paintSuites(suiteCanvas.ctx, 1024 * K, 64 * K, home);
  const suiteTex = tex(suiteCanvas.c, true);
  bowl(mesh(sweep([[{ o: 5, y: -.02, v: 0 }, { o: 5, y: 1.4, v: 1 }]], 20), mat(new T.MeshStandardMaterial({ color: '#0d1620', roughness: .8, side: T.DoubleSide }))));
  bowl(mesh(sweep([[{ o: 5, y: 1.4, v: 0 }, { o: 5.2, y: 1.9, v: 1 }]], 20), mat(new T.MeshBasicMaterial({ color: home.primaryColor, side: T.DoubleSide })), false));
  bowl(mesh(sweep([[{ o: 5.2, y: 1.9, v: 0 }, { o: 12.6, y: 6.9, v: 1 }]], 20, 20), mat(new T.MeshStandardMaterial({ map: crowdTex, roughness: .95, side: T.DoubleSide })), false));
  bowl(mesh(sweep([
    [{ o: 12.6, y: 6.9, v: 0 }, { o: 12.6, y: 7.25, v: 0 }], // front rail of the lower tier
    [{ o: 12.6, y: 7.25, v: 0 }, { o: 12.9, y: 7.25, v: 0 }],
  ], 20, 20), mat(new T.MeshStandardMaterial({ color: '#202b37', roughness: .7, side: T.DoubleSide })), false));
  bowl(mesh(sweep([[{ o: 12.9, y: 7.25, v: 1 }, { o: 12.9, y: 8.75, v: 0 }]], 10, 20), mat(new T.MeshBasicMaterial({ map: suiteTex, side: T.DoubleSide })), false));
  bowl(mesh(sweep([[{ o: 12.9, y: 8.75, v: 0 }, { o: 13.5, y: 8.75, v: 1 }]], 20, 20), mat(new T.MeshStandardMaterial({ color: '#141d27', roughness: .8, side: T.DoubleSide })), false));
  bowl(mesh(sweep([[{ o: 13.5, y: 8.75, v: 0 }, { o: 21, y: 13.6, v: 1 }]], 20, 20), mat(new T.MeshStandardMaterial({ map: upperTex, roughness: .95, side: T.DoubleSide })), false));
  bowl(mesh(sweep([[{ o: 21, y: 13.6, v: 0 }, { o: 21, y: 22, v: 1 }]], 20, 20), mat(new T.MeshBasicMaterial({ color: '#070d15', side: T.DoubleSide })), false));
  // Roof: a dark ceiling over the bowl and two lighting rigs (catwalk + rows of lamps) above the ice. Single-sided,
  // facing down: seen from the ice and the low cameras, culled for the high «Сверху» / zoomed-out views.
  const downOnly = (g: T.BufferGeometry) => (g.getAttribute('normal').getY(0) > 0 ? T.BackSide : T.FrontSide);
  const roofGeo = sweep([[{ o: 21, y: 22, v: 0 }, { o: -CORNER + .5, y: 23.5, v: 1 }]], 20, 20);
  bowl(mesh(roofGeo, mat(new T.MeshBasicMaterial({ color: '#05090f', side: downOnly(roofGeo) })), false));
  const rig: T.BufferGeometry[] = [], lamps: T.BufferGeometry[] = [];
  const down = (w: number, d: number, x: number, y: number, z: number) => { const g = new T.PlaneGeometry(w, d); g.rotateX(Math.PI / 2); g.translate(x, y, z); return g; };
  for (const z of [-7.5, 7.5]) {
    rig.push(down(HALF_L * 1.8, 1, 0, 19.2, z));
    for (let x = -HALF_L * .85; x <= HALF_L * .85 + .01; x += HALF_L * .85 / 5) for (const dz of [-.26, .26]) lamps.push(down(.7, .42, x, 19.15, z + dz));
  }
  for (const x of [-HALF_L * .55, 0, HALF_L * .55]) rig.push(down(.5, 15.9, x, 19.25, 0));
  const rigGeo = mergeGeometries(rig, false)!, lampGeo = mergeGeometries(lamps, false)!;
  [...rig, ...lamps].forEach(b => b.dispose());
  bowl(mesh(rigGeo, mat(new T.MeshBasicMaterial({ color: '#141b24' })), false));
  bowl(mesh(lampGeo, mat(new T.MeshBasicMaterial({ color: '#fff6e0' })), false));

  // Team benches with the coaches and the players who are not on the ice, the penalty boxes and the timekeepers.
  const benches = new T.Group(), benchCrowd = new T.Group();
  benches.add(benchCrowd); group.add(benches); hidden.push(benches);
  buildBenches({
    home, away, kits: options.benchKits, group: benches, crowd: benchCrowd, mat, canvas, texture: c => tex(c),
    mesh: (geo, m, parent) => { own.geometries.push(geo); const x = new T.Mesh(geo, m); x.receiveShadow = true; parent.add(x); return x; },
  });

  // Scoreboard cube over centre ice.
  const scoreCanvas = canvas(512, 256);
  if (scoreCanvas.ctx) {
    const c = scoreCanvas.ctx; c.fillStyle = '#05080d'; c.fillRect(0, 0, 512, 256);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = home.primaryColor; c.fillRect(16, 60, 230, 120); c.fillStyle = away.primaryColor; c.fillRect(266, 60, 230, 120);
    c.fillStyle = '#ffffff'; c.font = 'bold 58px Oswald, sans-serif'; c.fillText(home.short ?? home.name, 131, 122, 210); c.fillText(away.short ?? away.name, 381, 122, 210);
    c.fillStyle = '#f5b942'; c.font = 'bold 34px Oswald, sans-serif'; c.fillText('ПОВТОР', 256, 222); c.fillStyle = '#9fb6c4'; c.fillText(LG(), 256, 30);
  }
  const screen = mat(new T.MeshBasicMaterial({ map: tex(scoreCanvas.c) })), frame = mat(new T.MeshStandardMaterial({ color: '#1a1f27', roughness: .6 }));
  const cube = mesh(new T.BoxGeometry(6.4, 3.4, 4.4), [screen, screen, frame, frame, screen, screen] as unknown as T.Material, false);
  cube.position.set(0, 15.5, 0); hidden.push(cube, stanchions);
  // LED rings above and below the screens (club colour), a smaller lower tier with the league name, the hoist.
  const ledCanvas = canvas(512, 32);
  if (ledCanvas.ctx) {
    const c = ledCanvas.ctx; c.fillStyle = home.primaryColor; c.fillRect(0, 0, 512, 32);
    c.fillStyle = '#ffffff'; c.font = 'bold 22px Oswald, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let i = 0; i < 2; i++) c.fillText(`${LG()} · ${home.short ?? home.name} — ${away.short ?? away.name}`, 128 + i * 256, 17, 240);
  }
  const ledTex = tex(ledCanvas.c, true); ledTex.repeat.set(2, 1);
  const led = mat(new T.MeshBasicMaterial({ map: ledTex }));
  const rings: T.Mesh[] = [];
  for (const y of [17.45, 13.55]) { const ringMesh = mesh(new T.BoxGeometry(6.6, .42, 4.6), [led, led, frame, frame, led, led] as unknown as T.Material, false); ringMesh.position.set(0, y, 0); hidden.push(ringMesh); rings.push(ringMesh); }
  const lowCanvas = canvas(256, 64);
  if (lowCanvas.ctx) {
    const c = lowCanvas.ctx; c.fillStyle = '#05080d'; c.fillRect(0, 0, 256, 64);
    c.fillStyle = home.primaryColor; c.fillRect(0, 0, 256, 6); c.fillRect(0, 58, 256, 6);
    c.fillStyle = '#e8eef5'; c.font = 'bold 30px Oswald, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(LG(), 128, 33, 230);
  }
  const lowScreen = mat(new T.MeshBasicMaterial({ map: tex(lowCanvas.c) }));
  const low = mesh(new T.CylinderGeometry(2.1, 2.1, 1, 8, 1, true), lowScreen, false); low.position.set(0, 12.75, 0); hidden.push(low);
  const hoist = mesh(new T.CylinderGeometry(.06, .06, 4.6, 6), frame, false); hoist.position.set(0, 19.9, 0); hidden.push(hoist);
  // The scoreboard hangs over centre ice: from the high cameras it would hide the play, so it steps aside then.
  const scoreboard = [cube, low, hoist, ...rings];
  const boardBox = new T.Box3(new T.Vector3(-3.35, 12.2, -2.35), new T.Vector3(3.35, 22.3, 2.35));

  // Goals.
  const netCanvas = canvas(64, 64);
  if (netCanvas.ctx) { const c = netCanvas.ctx; c.clearRect(0, 0, 64, 64); c.strokeStyle = '#ffffff'; c.lineWidth = 6; c.strokeRect(0, 0, 64, 64); }
  const netTex = tex(netCanvas.c); netTex.wrapS = netTex.wrapT = T.RepeatWrapping; netTex.colorSpace = T.NoColorSpace;
  const goalMats = {
    red: mat(new T.MeshStandardMaterial({ color: '#d3243c', roughness: .35, metalness: .2 })),
    white: mat(new T.MeshStandardMaterial({ color: '#f2f5f7', roughness: .5 })),
    net: mat(new T.MeshStandardMaterial({ color: '#f4f6f8', alphaMap: netTex, alphaTest: .35, side: T.DoubleSide, roughness: .9 })),
    skirt: mat(new T.MeshStandardMaterial({ color: '#fbfcfd', side: T.DoubleSide, roughness: .9 })),
  };
  buildGoal(group, 1, own, goalMats); buildGoal(group, -1, own, goalMats);

  // Static geometry: no per-frame matrix updates.
  group.updateMatrixWorld(true);
  group.traverse(o => { o.matrixAutoUpdate = false; });
  return {
    group,
    refresh: paint,
    reflectionHidden: hidden,
    iceReflection,
    benchCrowd,
    view: camera => { const show = !scoreboardBlocks(camera, boardBox); scoreboard.forEach(o => { o.visible = show; }); },
    dispose: () => { disposed = true; own.geometries.forEach(g => g.dispose()); own.materials.forEach(m => m.dispose()); own.textures.forEach(t => t.dispose()); group.removeFromParent(); },
  };
}
