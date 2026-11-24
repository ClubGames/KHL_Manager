import * as T from 'three';

/**
 * Hockey kit volume for the base body, and the helmets.
 *
 * The CC0 base body is a slim civilian (32 cm waist, 28 cm chest depth). A player in full kit is far
 * broader: shoulder pads (≈60 cm across, squared off), a loose jersey over them (≈36–38 cm deep), elbow
 * pads, hockey pants (≈48 cm across the hips, thick thighs) and shin guards under the socks. `kitUp`
 * reshapes the skinned geometry in its bind pose (= rest pose), so the bulk deforms with the skeleton and
 * nothing pokes through when the IK bends the body. Measurements are in character space (metres,
 * +y up, +z forward, x lateral) of the rest pose.
 */

const smooth = (a: number, b: number, v: number) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Rest-pose landmarks of the base body (from its skeleton). */
const ARM_AXIS = { y: 1.432, z: .06 }, SHOULDER_X = .28, TORSO_Z = .05;
const HIP = { y: .964, z: .045 }, KNEE = { y: .533, z: .087 }, ANKLE = { y: .023, z: .062 }, LEG_X = .121;

type Shape = (p: T.Vector3) => void;

/** Jersey over shoulder pads and elbow pads (torso + sleeves). */
const jersey: Shape = p => {
  const ax = Math.abs(p.x), side = Math.sign(p.x) || 1;
  const arm = smooth(.2, .31, ax);
  // Torso: wider and deeper; squared, raised shoulders. The collar tapers back to the neck.
  const collar = 1 - smooth(1.49, 1.56, p.y) * (1 - smooth(.07, .13, ax));
  const shoulders = smooth(1.28, 1.4, p.y);
  const sx = 1 + collar * lerp(.36, .13, shoulders), sz = 1 + collar * lerp(.32, .36, shoulders);
  const pad = smooth(.1, .2, ax) * smooth(1.36, 1.46, p.y) * (1 - arm) * .028;
  const tx = p.x * sx, ty = p.y + pad, tz = TORSO_Z + (p.z - TORSO_Z) * sz;
  // Sleeves: thicker around the arm axis (padding at the shoulder cap and elbow), shifted with the shoulder.
  const along = ax - SHOULDER_X;
  const sa = 1.42 - .2 * smooth(.05, .3, along) + .08 * Math.exp(-(((along - .07) / .05) ** 2));
  const ay = ARM_AXIS.y + (p.y - ARM_AXIS.y) * sa, az = ARM_AXIS.z + (p.z - ARM_AXIS.z) * sa;
  const axx = p.x + side * SHOULDER_X * (sx - 1);
  p.set(lerp(tx, axx, arm), lerp(ty, ay, arm), lerp(tz, az, arm));
};

/** Hockey pants: a wide girdle at the hips, thick padded thighs. */
const pants: Shape = p => {
  const hips = smooth(.78, .95, p.y), side = Math.sign(p.x) || 1;
  // Upper part: around the body centre.
  const hx = p.x * lerp(1.3, 1.5, smooth(.9, 1.02, p.y)), hz = TORSO_Z + (p.z - TORSO_Z) * 1.42;
  // Thighs: around each leg's own axis.
  const t = (p.y - KNEE.y) / (HIP.y - KNEE.y), cz = lerp(KNEE.z, HIP.z, t), cx = side * LEG_X;
  const lx = cx * 1.12 + (p.x - cx) * 1.42, lz = cz + (p.z - cz) * 1.45;
  p.set(lerp(lx, hx, hips), p.y, lerp(lz, hz, hips));
};

/** Shin guards + socks: a thick, slightly tapered tube around the shin. */
const shins: Shape = p => {
  const side = Math.sign(p.x) || 1, cx = side * LEG_X;
  const t = Math.max(0, Math.min(1, (p.y - ANKLE.y) / (KNEE.y - ANKLE.y))), cz = lerp(ANKLE.z, KNEE.z, t);
  const s = lerp(1.3, 1.55, smooth(.15, .5, p.y));
  // The knee cap of the guard sticks forward a little.
  const cap = Math.exp(-(((p.y - .54) / .06) ** 2)) * Math.max(0, p.z - cz) * .5;
  p.set(cx * 1.1 + (p.x - cx) * s, p.y, cz + (p.z - cz) * (s + cap));
};

const SHAPES: [RegExp, Shape][] = [[/Body_1$/, jersey], [/Legs_2$/, pants], [/Legs_1$/, shins]];

/**
 * Applies the kit volume to the skinned template (once; clones share the geometry). Positions are rewritten
 * as float32 (the quantised int16 range cannot hold the grown body).
 */
export function kitUp(scene: T.Object3D) {
  scene.updateMatrixWorld(true);
  scene.traverse(o => {
    const mesh = o as T.SkinnedMesh;
    if (!mesh.isSkinnedMesh || mesh.userData.kitUp) return;
    const shape = SHAPES.find(([re]) => re.test(mesh.name))?.[1];
    if (!shape) return;
    mesh.skeleton.update();
    const src = mesh.geometry.getAttribute('position');
    const out = new Float32Array(src.count * 3), v = new T.Vector3();
    const skinIndex = mesh.geometry.getAttribute('skinIndex'), skinWeight = mesh.geometry.getAttribute('skinWeight');
    const bones = mesh.skeleton.bones, inverses = mesh.skeleton.boneInverses;
    const blend = new T.Matrix4(), bone = new T.Matrix4(), full = new T.Matrix4();
    for (let i = 0; i < src.count; i++) {
      // Per-vertex skinning transform at the rest pose (model → world), as the shader computes it.
      blend.multiplyScalar(0).elements.fill(0);
      for (let k = 0; k < 4; k++) {
        const w = skinWeight.getComponent(i, k); if (!w) continue;
        const j = skinIndex.getComponent(i, k);
        bone.multiplyMatrices(bones[j].matrixWorld, inverses[j]);
        for (let e = 0; e < 16; e++) blend.elements[e] += bone.elements[e] * w;
      }
      full.copy(mesh.matrixWorld).multiply(mesh.bindMatrixInverse).multiply(blend).multiply(mesh.bindMatrix);
      v.fromBufferAttribute(src, i).applyMatrix4(full);
      shape(v);
      v.applyMatrix4(full.invert());
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    }
    mesh.geometry.setAttribute('position', new T.BufferAttribute(out, 3));
    mesh.geometry.computeBoundingBox(); mesh.geometry.computeBoundingSphere();
    mesh.userData.kitUp = true;
  });
}

/* ------------------------------------------------------------------------------------------------ helmets */

/** Head landmarks (rest pose, relative to the Head bone at (0, 1.587, 0.043)). */
const SKULL = { y: .108, z: .012, ax: .127, ay: .136, az: .152 };

type ShellSpec = {
  /** Lowest polar angle covered (0 = top, π = bottom) as a function of the azimuth (0 = front, ±π = back). */
  edge: (phi: number) => number;
  /** Optional cut-out (goalie mask eye opening). */
  hole?: (phi: number, theta: number) => boolean;
  thickness: number; segments?: number; rings?: number;
  /** Superellipse exponent of the horizontal section (2 = ellipse, higher = boxier sides). */
  boxy?: number;
  scale?: [number, number, number];
};

/** A point on the helmet surface (head-bone space). */
export function skull(phi: number, theta: number, grow = 0, spec?: Pick<ShellSpec, 'boxy' | 'scale'>) {
  const n = spec?.boxy ?? 3.1, [kx, ky, kz] = spec?.scale ?? [1, 1, 1];
  const sp = Math.sin(phi), cp = Math.cos(phi), st = Math.sin(theta);
  const sx = Math.sign(sp) * Math.abs(sp) ** (2 / n), sz = Math.sign(cp) * Math.abs(cp) ** (2 / n);
  // The back of a helmet drops lower and fuller than the front (occipital lock).
  const back = Math.max(0, -cp), down = theta > Math.PI / 2 ? back * .015 : 0;
  return new T.Vector3(
    (SKULL.ax + grow) * kx * st * sx,
    SKULL.y + (SKULL.ay + grow) * ky * Math.cos(theta) - down,
    SKULL.z + (SKULL.az + grow) * kz * st * sz + (theta > .9 ? back * -.006 : 0),
  );
}

/** Thick shell (outer + inner surface + rolled rim along the lower edge), UVs = (azimuth, polar) for decals. */
export function shellGeometry(spec: ShellSpec): T.BufferGeometry {
  const S = spec.segments ?? 56, R = spec.rings ?? 22, pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const grid = (grow: number, flip: boolean) => {
    const base = pos.length / 3;
    for (let i = 0; i <= S; i++) {
      const phi = -Math.PI + (i / S) * Math.PI * 2, edge = spec.edge(phi);
      for (let j = 0; j <= R; j++) {
        const theta = (j / R) * edge, p = skull(phi, theta, grow, spec);
        pos.push(p.x, p.y, p.z); uv.push(i / S, theta / Math.PI);
      }
    }
    for (let i = 0; i < S; i++) for (let j = 0; j < R; j++) {
      const phi = -Math.PI + ((i + .5) / S) * Math.PI * 2, theta = ((j + .5) / R) * spec.edge(phi);
      if (spec.hole?.(phi, theta)) continue;
      const a = base + i * (R + 1) + j, b = a + R + 1, c = b + 1, d = a + 1;
      if (flip) idx.push(a, d, b, b, d, c); else idx.push(a, b, d, b, c, d);
    }
    return base;
  };
  const outer = grid(0, false), inner = grid(-spec.thickness, true);
  // Rim: joins the outer and inner lower edges (the visible thickness of the shell).
  for (let i = 0; i < S; i++) {
    const a = outer + i * (R + 1) + R, b = outer + (i + 1) * (R + 1) + R, c = inner + (i + 1) * (R + 1) + R, d = inner + i * (R + 1) + R;
    idx.push(a, d, b, b, d, c);
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

/** Player helmet edge: high over the eyes, cut up around the temples, down over the ears and the occiput. */
const helmetEdge = (phi: number) => {
  const a = Math.abs(phi);
  const front = .43 * Math.PI, temple = .5 * Math.PI, ear = .66 * Math.PI, back = .69 * Math.PI;
  if (a < .55) return lerp(front, temple, smooth(.25, .55, a));
  if (a < 1.25) return lerp(temple, ear, smooth(.55, 1.25, a));
  return lerp(ear, back, smooth(1.25, 2.4, a));
};

/** A small part oriented to the helmet surface at (phi, theta). */
function onSkull(mesh: T.Object3D, phi: number, theta: number, grow: number, spin = 0, spec?: Pick<ShellSpec, 'boxy' | 'scale'>) {
  const p = skull(phi, theta, grow, spec), n = skull(phi, theta, grow + .01, spec).sub(p).normalize();
  const along = skull(phi, theta + .02, grow, spec).sub(p).normalize(); // down the surface
  const side = new T.Vector3().crossVectors(along, n).normalize();
  const basis = new T.Matrix4().makeBasis(side, n, along.clone().negate());
  mesh.quaternion.setFromRotationMatrix(basis);
  if (spin) mesh.rotateY(spin);
  mesh.position.copy(p);
  return mesh;
}

type GearKit = { helmet: string; trim: string; glove: string; crest?: T.Material; goalie?: boolean };

/**
 * Builds the helmet (skater: shell with vents, ear guards, chin strap and a half visor; goalie: a mask with
 * a cat-eye cage and a throat guard). Everything is returned in head-bone space; owned resources are pushed
 * to `own` so the figure can dispose of them.
 */
export function buildHelmet(kit: GearKit, own: { geometries: T.BufferGeometry[]; materials: T.Material[]; textures?: T.Texture[] }): T.Group {
  const group = new T.Group();
  const geo = <G extends T.BufferGeometry>(g: G) => { own.geometries.push(g); return g; };
  const mat = <M extends T.Material>(m: M) => { own.materials.push(m); return m; };
  const add = (g: T.BufferGeometry, m: T.Material, cast = false) => { const mesh = new T.Mesh(geo(g), m); mesh.castShadow = cast; group.add(mesh); return mesh; };
  // Glossy painted plastic.
  const shell = mat(new T.MeshPhysicalMaterial({ color: kit.helmet, roughness: .32, metalness: 0, clearcoat: .8, clearcoatRoughness: .15, side: T.DoubleSide }));
  const rubber = mat(new T.MeshStandardMaterial({ color: '#15181d', roughness: .7 }));
  const steel = mat(new T.MeshStandardMaterial({ color: '#cfd6dc', roughness: .25, metalness: .85 }));
  const light = new T.Color(kit.helmet).getHSL({ h: 0, s: 0, l: 0 }).l > .55;
  const vent = mat(new T.MeshStandardMaterial({ color: light ? '#2a2f36' : '#07090c', roughness: .8 }));

  if (!kit.goalie) {
    add(shellGeometry({ edge: helmetEdge, thickness: .012 }), shell, true);
    // Vent slots: two rows on top, one at the back.
    const slot = geo(new T.CapsuleGeometry(.0065, .022, 3, 6));
    for (const [phi, theta, spin] of [[.32, .38, 0], [-.32, .38, 0], [.55, .62, .3], [-.55, .62, -.3], [2.75, .78, 0], [-2.75, .78, 0], [Math.PI, .62, Math.PI / 2]] as const) {
      const m = new T.Mesh(slot, vent); m.scale.set(1, 1, .45); onSkull(m, phi, theta, -.002, spin); m.rotateX(Math.PI / 2); group.add(m);
    }
    // Ear guards (with holes), cheek screws and the chin strap.
    for (const side of [1, -1]) {
      const phi = side * Math.PI / 2;
      const guard = new T.Mesh(geo(new T.SphereGeometry(.034, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2)), shell);
      onSkull(guard, phi * 1.02, .6 * Math.PI, -.008); guard.scale.set(1, .35, 1.15); guard.castShadow = false; group.add(guard);
      const hole = new T.Mesh(geo(new T.CircleGeometry(.011, 10)), vent);
      onSkull(hole, phi * 1.02, .6 * Math.PI, .008); hole.rotateX(-Math.PI / 2); group.add(hole);
      for (const [dp, th] of [[.42, .47], [-.5, .5]] as const) {
        const screw = new T.Mesh(geo(new T.CylinderGeometry(.007, .007, .006, 8)), steel); onSkull(screw, phi - side * dp, th * Math.PI, .002); group.add(screw);
      }
      // Strap: from below the ear guard, under the chin.
      const a = skull(phi * 1.02, .68 * Math.PI, -.012), b = new T.Vector3(side * .052, -.05, .06), c = new T.Vector3(0, -.068, .088);
      add(new T.TubeGeometry(new T.CatmullRomCurve3([a, a.clone().lerp(b, .5).add(new T.Vector3(side * .006, 0, 0)), b, c]), 12, .0035, 4), rubber);
    }
    // Half visor: clear polycarbonate from temple to temple, eyes to the tip of the nose, black edge trim.
    const visorPts: number[] = [], visorIdx: number[] = [];
    const VS = 24, VR = 6;
    for (let i = 0; i <= VS; i++) {
      const phi = lerp(-1.0, 1.0, i / VS);
      for (let j = 0; j <= VR; j++) {
        // Tucked under the front edge of the shell, curving slightly outward at the bottom.
        const y = lerp(.142, .058, j / VR), k = j / VR;
        const p = skull(phi, helmetEdge(phi) - .04, .004);
        visorPts.push(p.x * (1 + .02 * k), y, SKULL.z + (p.z - SKULL.z) * (1 + .06 * k));
      }
    }
    for (let i = 0; i < VS; i++) for (let j = 0; j < VR; j++) { const a = i * (VR + 1) + j, b = a + VR + 1; visorIdx.push(a, b, a + 1, b, b + 1, a + 1); }
    const vg = new T.BufferGeometry(); vg.setAttribute('position', new T.Float32BufferAttribute(visorPts, 3)); vg.setIndex(visorIdx); vg.computeVertexNormals();
    add(vg, mat(new T.MeshPhysicalMaterial({ color: '#cfe3ee', roughness: .05, metalness: 0, transparent: true, opacity: .28, side: T.DoubleSide, depthWrite: false, clearcoat: 1 })));
    const trimPts: T.Vector3[] = [];
    for (let i = 0; i <= VS; i++) { const k = (i * (VR + 1) + VR) * 3; trimPts.push(new T.Vector3(visorPts[k], visorPts[k + 1], visorPts[k + 2])); }
    add(new T.TubeGeometry(new T.CatmullRomCurve3(trimPts), 32, .0025, 4), rubber);
    // Club crest stickers on both sides.
    if (kit.crest) for (const side of [1, -1]) {
      const decal = new T.Mesh(geo(new T.PlaneGeometry(.05, .05)), kit.crest);
      onSkull(decal, side * 1.95, .42 * Math.PI, .004); decal.rotateX(-Math.PI / 2); decal.rotateZ(Math.PI); group.add(decal);
    }
    return group;
  }

  // Goalie mask: one shell from the crown to the chin with a cat-eye opening covered by the cage.
  const maskSpec: ShellSpec = {
    edge: phi => { const a = Math.abs(phi); return a < 1.4 ? .86 * Math.PI : lerp(.86 * Math.PI, .7 * Math.PI, smooth(1.4, 2.4, a)); },
    hole: (phi, theta) => Math.abs(phi) < .78 && theta > .43 * Math.PI && theta < .74 * Math.PI,
    thickness: .012, boxy: 2.2, scale: [1.02, 1.06, 1.08],
  };
  // Painted mask: club trim stripes over the crown, from the cage back to the neck (drawn in shell UV space).
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  let paintMap: T.Texture | null = null;
  const ctx = canvas?.getContext('2d');
  if (canvas && ctx) {
    const W = 512, H = 256;
    canvas.width = W; canvas.height = H;
    ctx.fillStyle = kit.helmet; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = kit.trim;
    for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
      const phi = -Math.PI + ((px + .5) / W) * Math.PI * 2, theta = ((py + .5) / H) * Math.PI;
      const p = skull(phi, theta, 0, maskSpec), ax = Math.abs(p.x);
      if ((ax > .03 && ax < .052 && theta < .72 * Math.PI) || (theta > .8 * Math.PI && theta < .84 * Math.PI)) ctx.fillRect(px, py, 1, 1);
    }
    paintMap = new T.CanvasTexture(canvas); paintMap.flipY = false; paintMap.colorSpace = T.SRGBColorSpace; paintMap.anisotropy = 4;
    own.textures?.push(paintMap);
  }
  const maskMat = mat(new T.MeshPhysicalMaterial({ color: paintMap ? '#ffffff' : kit.helmet, map: paintMap, roughness: .3, clearcoat: .8, clearcoatRoughness: .15, side: T.DoubleSide }));
  add(shellGeometry(maskSpec), maskMat, true);
  // Cage: frame around the opening + vertical and horizontal bars, slightly proud of the shell.
  const frame: T.Vector3[] = [];
  const at = (phi: number, theta: number) => skull(phi, theta, .022, maskSpec);
  for (let k = 0; k <= 40; k++) {
    const u = (k / 40) * Math.PI * 2, phi = .8 * Math.sin(u), theta = (.585 + .16 * Math.cos(u)) * Math.PI;
    frame.push(at(phi, theta));
  }
  add(new T.TubeGeometry(new T.CatmullRomCurve3(frame, true), 48, .005, 5, true), steel);
  for (let i = -3; i <= 3; i++) {
    const phi = i * .2, span = .16 * Math.sqrt(Math.max(0, 1 - (phi / .8) ** 2));
    const pts = [0, .5, 1].map(k => at(phi, (.585 + lerp(-span, span, k)) * Math.PI));
    add(new T.TubeGeometry(new T.CatmullRomCurve3(pts), 8, .0032, 4), steel);
  }
  for (const th of [.52, .6, .68]) {
    const w = .8 * Math.sqrt(Math.max(0, 1 - ((th - .585) / .16) ** 2));
    const pts = [-1, -.5, 0, .5, 1].map(k => at(k * w, th * Math.PI));
    add(new T.TubeGeometry(new T.CatmullRomCurve3(pts), 12, .0032, 4), steel);
  }
  // Throat guard.
  const guard = add(new T.CylinderGeometry(.06, .07, .07, 16, 1, true, -Math.PI / 2, Math.PI), mat(new T.MeshPhysicalMaterial({ color: '#dfe7ee', roughness: .1, transparent: true, opacity: .55, side: T.DoubleSide, depthWrite: false })));
  guard.position.set(0, -.15, .09); guard.rotation.x = -.25;
  if (kit.crest) for (const side of [1, -1]) {
    const decal = new T.Mesh(geo(new T.PlaneGeometry(.06, .06)), kit.crest);
    onSkull(decal, side * 1.75, .45 * Math.PI, .006, 0, maskSpec); decal.rotateX(-Math.PI / 2); decal.rotateZ(Math.PI); group.add(decal);
  }
  return group;
}
