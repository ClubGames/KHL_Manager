import * as T from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Team } from '../types';
import { FACEOFF_SPOTS, RINK } from '../game/rinkGeometry';
import { getClubLogoSources } from '../game/clubColors';

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
};
/** Texture detail of the static arena: `hi` doubles the ice/crowd/board canvases (sharper markings and ads). */
export type ArenaOptions = { detail?: 'normal' | 'hi' };

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

type ProfilePoint = { o: number; y: number; v: number };
/** Sweeps profile segments around the rink: one merged geometry, u = metres along the outline / uMetres. */
function sweep(segments: [ProfilePoint, ProfilePoint][], uMetres: number, seg = 14) {
  const parts = segments.map(([a, b]) => {
    const ra = outline(a.o, seg), rb = outline(b.o, seg);
    const pos: number[] = [], uv: number[] = [], index: number[] = [];
    ra.forEach((p, i) => {
      const q = rb[i];
      pos.push(p.x, a.y, p.z, q.x, b.y, q.z);
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
    ctx.fillStyle = '#9fb6c4'; ctx.font = `bold ${X(2.2)}px Oswald, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('КХЛ', w / 2, h / 2);
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
  const panels = [['КХЛ', '#c8243a'], [home.name, home.primaryColor], ['ХОККЕЙ', '#1d58a8'], [away.name, away.primaryColor]];
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  panels.forEach(([text, color], i) => {
    const x0 = (i / panels.length) * w;
    ctx.fillStyle = i % 2 ? '#ffffff' : '#eef3f7'; ctx.fillRect(x0 + 4 * (w / 1536), h * .12, w / panels.length - 8 * (w / 1536), h * .66);
    ctx.fillStyle = color; ctx.font = `bold ${Math.round(h * .38)}px Oswald, sans-serif`;
    ctx.fillText(text.toUpperCase(), x0 + w / panels.length / 2, h * .46, w / panels.length - 24);
  });
}

/** Spectators: rows of tiny shirts, most of them in the home club's colours. */
function paintCrowd(ctx: CanvasRenderingContext2D, w: number, h: number, home: Team) {
  ctx.fillStyle = '#121c28'; ctx.fillRect(0, 0, w, h);
  const rand = rng(5), rows = 22, rh = h / rows, u = w / 1024;
  const palette = [home.primaryColor, home.primaryColor, home.secondaryColor, '#d9dde2', '#2a3644', '#55606d', '#8a6d5a', '#c9a27e'];
  for (let r = 0; r < rows; r++) {
    ctx.fillStyle = r % 2 ? '#1b2735' : '#172230'; ctx.fillRect(0, r * rh, w, rh);
    for (let x = 0; x < w; x += (4 + rand() * 2) * u) {
      if (rand() < .1) continue; // empty seat
      ctx.fillStyle = palette[Math.floor(rand() * palette.length)];
      ctx.fillRect(x, r * rh + rh * .35, 3 * u, rh * .55);
      ctx.fillStyle = rand() < .5 ? '#e0b896' : '#c79a78';
      ctx.fillRect(x + .5 * u, r * rh + rh * .12, 2 * u, rh * .25);
    }
  }
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
export function buildArena(scene: T.Scene, home: Team, away: Team, anisotropy: number, onChange: () => void = () => {}, options: ArenaOptions = {}): Arena {
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
  // Glass: 1.8 m along the sides (2.4 m behind the nets in real arenas; one height keeps it to a single mesh).
  bowl(mesh(sweep([[{ o: .1, y: 1.07, v: 0 }, { o: .1, y: 3.0, v: 1 }]], 10, 20), mat(new T.MeshStandardMaterial({ color: '#cfe8f4', transparent: true, opacity: .12, roughness: .05, metalness: .1, depthWrite: false, side: T.DoubleSide })), false));
  // Glass stanchions: one instanced mesh.
  const ring = outline(.1, 20), posts: T.Vector3[] = [];
  for (let i = 1, acc = 0; i < ring.length; i++) { acc += ring[i].u - ring[i - 1].u; if (acc > 2.4) { acc = 0; posts.push(new T.Vector3(ring[i].x, 2.03, ring[i].z)); } }
  const postGeo = new T.BoxGeometry(.05, 1.9, .05); own.geometries.push(postGeo);
  const stanchions = new T.InstancedMesh(postGeo, mat(new T.MeshStandardMaterial({ color: '#b7c4cc', metalness: .4, roughness: .4 })), posts.length);
  const m4 = new T.Matrix4(); posts.forEach((p, i) => stanchions.setMatrixAt(i, m4.makeTranslation(p.x, p.y, p.z)));
  group.add(stanchions);
  // Stands: a stepped crowd bowl (texture) above a dark wall with an LED ribbon.
  const crowdCanvas = canvas(1024 * K, 256 * K);
  if (crowdCanvas.ctx) paintCrowd(crowdCanvas.ctx, 1024 * K, 256 * K, home);
  const crowdTex = tex(crowdCanvas.c, true);
  bowl(mesh(sweep([[{ o: 5, y: -.02, v: 0 }, { o: 5, y: 1.4, v: 1 }]], 20), mat(new T.MeshStandardMaterial({ color: '#0d1620', roughness: .8, side: T.DoubleSide }))));
  bowl(mesh(sweep([[{ o: 5, y: 1.4, v: 0 }, { o: 5.2, y: 1.9, v: 1 }]], 20), mat(new T.MeshBasicMaterial({ color: home.primaryColor, side: T.DoubleSide })), false));
  bowl(mesh(sweep([[{ o: 5.2, y: 1.9, v: 0 }, { o: 21, y: 12.5, v: 1 }]], 20, 20), mat(new T.MeshStandardMaterial({ map: crowdTex, roughness: .95, side: T.DoubleSide })), false));
  bowl(mesh(sweep([[{ o: 21, y: 12.5, v: 0 }, { o: 21, y: 22, v: 1 }]], 20, 20), mat(new T.MeshBasicMaterial({ color: '#070d15', side: T.DoubleSide })), false));

  // Team benches (the side the 2D rink draws them on) and the penalty boxes opposite, merged per material.
  const boxes: Record<string, T.BufferGeometry[]> = {};
  const block = (color: string, sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
    const b = new T.BoxGeometry(sx, sy, sz); b.translate(x, y, z); (boxes[color] ??= []).push(b);
  };
  for (const [x, team] of [[-6, home], [6, away]] as const) {
    block('#1d2731', 9, .05, 2.2, x, .02, -(HALF_W + 1.4));
    block('#3a4654', 8.6, .45, .45, x, .23, -(HALF_W + 2.2));
    block(team.primaryColor, 9, 1.2, .1, x, .6, -(HALF_W + 2.55));
  }
  for (const x of [-2.6, 2.6]) {
    block('#1d2731', 3.6, .05, 1.8, x, .02, HALF_W + 1.2);
    block('#3a4654', 3.2, .45, .45, x, .23, HALF_W + 1.9);
    block('#16304d', 3.6, 1.2, .1, x, .6, HALF_W + 2.2);
  }
  Object.entries(boxes).forEach(([color, list]) => { const g = mergeGeometries(list, false)!; list.forEach(b => b.dispose()); mesh(g, mat(new T.MeshStandardMaterial({ color, roughness: .8 }))); });

  // Scoreboard cube over centre ice.
  const scoreCanvas = canvas(512, 256);
  if (scoreCanvas.ctx) {
    const c = scoreCanvas.ctx; c.fillStyle = '#05080d'; c.fillRect(0, 0, 512, 256);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = home.primaryColor; c.fillRect(16, 60, 230, 120); c.fillStyle = away.primaryColor; c.fillRect(266, 60, 230, 120);
    c.fillStyle = '#ffffff'; c.font = 'bold 58px Oswald, sans-serif'; c.fillText(home.short ?? home.name, 131, 122, 210); c.fillText(away.short ?? away.name, 381, 122, 210);
    c.fillStyle = '#f5b942'; c.font = 'bold 34px Oswald, sans-serif'; c.fillText('ПОВТОР', 256, 222); c.fillStyle = '#9fb6c4'; c.fillText('КХЛ', 256, 30);
  }
  const screen = mat(new T.MeshBasicMaterial({ map: tex(scoreCanvas.c) })), frame = mat(new T.MeshStandardMaterial({ color: '#1a1f27', roughness: .6 }));
  const cube = mesh(new T.BoxGeometry(6.4, 3.4, 4.4), [screen, screen, frame, frame, screen, screen] as unknown as T.Material, false);
  cube.position.set(0, 15.5, 0); hidden.push(cube, stanchions);

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
    dispose: () => { disposed = true; own.geometries.forEach(g => g.dispose()); own.materials.forEach(m => m.dispose()); own.textures.forEach(t => t.dispose()); group.removeFromParent(); },
  };
}
