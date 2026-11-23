import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
// Base body: "Ultimate Modular Men" by Quaternius (CC0 1.0, https://quaternius.com) — hair removed,
// materials renamed (Jersey/Pants/Skate) and meshopt-compressed to ~150 KB. Inlined by the single-file build.
import modelUrl from '../assets/hockey-player.glb?url';

/**
 * Rigged 3D hockey players for the goal replay. One skinned template is loaded once and cloned per
 * player; the kit is painted in club colours by a tiny shader patch (stripes, yoke, sock hoops computed
 * from rest-pose coordinates, so no textures need to ship), equipment (helmet, gloves, skates, stick,
 * goalie pads) is simple geometry glued to the bones, and every pose is solved procedurally with
 * two-bone IK so skates stay on the ice and both hands stay on the stick.
 *
 * Character space (PlayerFigure.root): +y up, +z forward (the way the player faces), +x = player's left.
 */

export type Kit = {
  jersey: string; trim: string; trim2: string; pants: string; socks: string; sockTrim: string;
  helmet: string; glove: string; number: string; numberFill: string; numberStroke: string; name?: string;
  goalie?: boolean; pads?: string; crest?: T.Material;
};

type Rest = { pos: T.Vector3; quat: T.Quaternion };
type Template = { scene: T.Object3D; rest: Map<string, Rest> };

let pending: Promise<Template> | null = null;

/** Loads (once) and prepares the shared skinned template. Rejects if WebGL/GLB decoding fails. */
export function loadPlayerTemplate(): Promise<Template> {
  if (!pending) {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    pending = loader.loadAsync(modelUrl).then(gltf => prepare(gltf.scene));
    pending.catch(() => { pending = null; });
  }
  return pending;
}

function prepare(scene: T.Object3D): Template {
  scene.updateMatrixWorld(true);
  const rest = new Map<string, Rest>();
  scene.traverse(o => {
    if ((o as T.Bone).isBone) {
      const pos = new T.Vector3(), quat = new T.Quaternion(), scale = new T.Vector3();
      o.matrixWorld.decompose(pos, quat, scale);
      rest.set(o.name, { pos, quat });
    }
  });
  return { scene, rest };
}

/** Kit shader: base colour + bands defined in rest-pose space. kind 0 jersey, 1 socks, 2 pants. */
function kitMaterial(kind: 0 | 1 | 2, base: string, trim: string, trim2: string) {
  const material = new T.MeshStandardMaterial({ color: base, roughness: kind === 2 ? .55 : .72 });
  const uniforms = { uTrim: { value: new T.Color(trim) }, uTrim2: { value: new T.Color(trim2) }, uKind: { value: kind } };
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      // COLOR_0 carries rest-pose |x| and y/2 (baked offline), declared by hand: USE_COLOR stays off.
      .replace('#include <common>', '#include <common>\nattribute vec3 color;\nvarying vec3 vRest;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = vec3(color.r, color.g * 2., 0.);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRest;\nuniform vec3 uTrim;\nuniform vec3 uTrim2;\nuniform float uKind;\nfloat band(float v, float a, float b) { return step(a, v) * step(v, b); }')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float ax = abs(vRest.x), y = vRest.y;
        if (uKind < .5) {
          float t1 = band(y, 1.065, 1.115) * step(ax, .3) + band(ax, .435, .48) + step(1.475, y) * step(ax, .29) * step(.04, ax);
          float t2 = band(y, 1.13, 1.15) * step(ax, .3) + band(ax, .495, .512);
          diffuseColor.rgb = mix(mix(diffuseColor.rgb, uTrim, clamp(t1, 0., 1.)), uTrim2, clamp(t2, 0., 1.));
        } else if (uKind < 1.5) {
          diffuseColor.rgb = mix(mix(diffuseColor.rgb, uTrim, band(y, .34, .40)), uTrim2, band(y, .42, .445));
        } else {
          diffuseColor.rgb = mix(diffuseColor.rgb, uTrim, band(y, .645, .675) + band(ax, .175, .2) * step(.7, y));
        }`);
  };
  material.customProgramCacheKey = () => 'khl-kit-1';
  return material;
}

const _a = new T.Vector3(), _b = new T.Vector3(), _c = new T.Vector3(), _d = new T.Vector3(), _e = new T.Vector3();
const _q = new T.Quaternion(), _wq = new T.Quaternion(), _pq = new T.Quaternion(), _bq = new T.Quaternion();
const Y = new T.Vector3(0, 1, 0), X = new T.Vector3(1, 0, 0);
const LIFT = .06; // skate blade height: the rig stands on its blades
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (v: number) => { const t = clamp01(v); return t * t * (3 - 2 * t); };
const vec = (x: number, y: number, z: number) => new T.Vector3(x, y, z);
const mixV = (a: T.Vector3, b: T.Vector3, t: number) => a.clone().lerp(b, t);

/** Rotate a bone so the direction to its child points at `target` (minimal rotation, world space). */
function aim(bone: T.Object3D, child: T.Object3D, target: T.Vector3) {
  const b = _a.setFromMatrixPosition(bone.matrixWorld), c = _b.setFromMatrixPosition(child.matrixWorld);
  const from = c.sub(b).normalize(), to = _c.copy(target).sub(b);
  if (to.lengthSq() < 1e-8) return;
  _q.setFromUnitVectors(from, to.normalize());
  bone.getWorldQuaternion(_wq).premultiply(_q);
  bone.parent!.getWorldQuaternion(_pq).invert();
  bone.quaternion.copy(_pq.multiply(_wq));
  bone.updateMatrixWorld(true);
}

/** Analytic two-bone IK (shoulder-elbow-wrist, hip-knee-ankle) with a pole direction for the middle joint. */
function solveLimb(upper: T.Object3D, lower: T.Object3D, end: T.Object3D, target: T.Vector3, pole: T.Vector3, joint?: T.Vector3, jointWeight = 0) {
  const s = new T.Vector3().setFromMatrixPosition(upper.matrixWorld);
  const m = new T.Vector3().setFromMatrixPosition(lower.matrixWorld);
  const e = new T.Vector3().setFromMatrixPosition(end.matrixWorld);
  const a = s.distanceTo(m), b = m.distanceTo(e);
  const dir = _d.copy(target).sub(s); const dist = Math.max(.01, Math.min(dir.length(), (a + b) * .999)); dir.normalize();
  const cosA = Math.max(-1, Math.min(1, (a * a + dist * dist - b * b) / (2 * a * dist))), sinA = Math.sqrt(1 - cosA * cosA);
  const n = _e.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (n.lengthSq() < 1e-6) n.set(0, 0, 1); n.normalize();
  const elbow = s.clone().addScaledVector(dir, a * cosA).addScaledVector(n, a * sinA);
  const reach = s.clone().addScaledVector(dir, dist);
  if (joint && jointWeight > 0) elbow.lerp(joint, jointWeight);
  aim(upper, lower, elbow);
  aim(lower, end, reach);
}

export class PlayerFigure {
  readonly root = new T.Group();
  private rig: T.Object3D;
  private bones: Record<string, T.Bone> = {};
  private restLocal = new Map<T.Bone, T.Quaternion>();
  private restRig: Map<string, Rest>;
  private shaft: T.Mesh; private blade: T.Mesh; private paddle?: T.Mesh;
  private stickLength: number;
  private owned: { geometries: T.BufferGeometry[]; materials: T.Material[]; textures: T.Texture[] } = { geometries: [], materials: [], textures: [] };

  constructor(template: Template, private kit: Kit) {
    this.restRig = template.rest;
    this.rig = cloneSkinned(template.scene);
    this.root.add(this.rig);
    this.rig.position.y = LIFT;
    const own = <M extends T.Material>(m: M) => { this.owned.materials.push(m); return m; };
    const std = (color: string, extra: T.MeshStandardMaterialParameters = {}) => own(new T.MeshStandardMaterial({ color, roughness: .6, ...extra }));
    const jersey = own(kitMaterial(0, kit.jersey, kit.trim, kit.trim2));
    const socks = own(kitMaterial(1, kit.socks, kit.sockTrim, kit.trim2));
    const pants = own(kitMaterial(2, kit.pants, kit.trim, kit.trim2));
    const boot = std('#16191f', { roughness: .45 });
    this.rig.traverse(o => {
      const bone = o as T.Bone;
      if (bone.isBone) { this.bones[bone.name] = bone; this.restLocal.set(bone, bone.quaternion.clone()); }
      const mesh = o as T.SkinnedMesh;
      if (mesh.isSkinnedMesh) {
        mesh.castShadow = !/Head_[23]/.test(mesh.name); mesh.frustumCulled = false;
        if (/Body_1/.test(mesh.name)) mesh.material = jersey;
        else if (/Legs_1/.test(mesh.name)) mesh.material = socks;
        else if (/Legs_2/.test(mesh.name)) mesh.material = pants;
        else if (/Feet/.test(mesh.name)) mesh.material = boot;
      }
    });
    // Gloved fists: the base model's open hands are shrunk inside the gloves.
    this.bones.HandL.scale.setScalar(.6); this.bones.HandR.scale.setScalar(.6);
    this.rig.updateMatrixWorld(true);
    const helmet = std(kit.helmet, { roughness: .35 }), glove = std(kit.glove), steel = std('#c9d6de', { metalness: .7, roughness: .3 });
    const trim = std(kit.trim), black = std('#111418', { roughness: .5 });
    const geo = <G extends T.BufferGeometry>(g: G) => { this.owned.geometries.push(g); return g; };
    // Props glued to a bone: a holder cancels the bone's rest rotation & scale, so offsets are in character space.
    const holder = (name: string) => {
      const bone = this.bones[name], r = this.restRig.get(name)!;
      const h = new T.Group(); h.quaternion.copy(r.quat).invert();
      const s = new T.Vector3(); bone.matrixWorld.decompose(new T.Vector3(), new T.Quaternion(), s);
      h.scale.set(1 / s.x, 1 / s.y, 1 / s.z); bone.add(h); return h;
    };
    const part = (parent: T.Object3D, g: T.BufferGeometry, m: T.Material, x = 0, y = 0, z = 0) => {
      const mesh = new T.Mesh(geo(g), m); mesh.position.set(x, y, z); parent.add(mesh); return mesh; // props skip the shadow pass (draw calls on phones)
    };
    const head = holder('Head');
    if (kit.goalie) {
      const mask = part(head, new T.SphereGeometry(.142, 14, 10), helmet, 0, .09, .045); mask.scale.set(.95, 1.08, 1.1);
      const cage = std('#d9dee3', { metalness: .6, roughness: .3, wireframe: true });
      const grill = part(head, new T.SphereGeometry(.12, 7, 5, -Math.PI * .35, Math.PI * .7, Math.PI * .3, Math.PI * .45), cage, 0, .07, .09); grill.scale.set(1, 1.1, 1.15);
    } else {
      const shell = part(head, new T.SphereGeometry(.138, 14, 9, 0, Math.PI * 2, 0, Math.PI * .58), helmet, 0, .088, .047); shell.scale.set(.98, 1.05, 1.12);
      const visor = part(head, new T.CylinderGeometry(.128, .128, .05, 12, 1, true, -Math.PI * .32, Math.PI * .64), own(new T.MeshStandardMaterial({ color: '#9fc7dd', transparent: true, opacity: .45, roughness: .1, metalness: .3 })), 0, .07, .05);
      visor.scale.set(1, 1, 1.13); visor.castShadow = false;
    }
    for (const side of ['L', 'R'] as const) {
      const s = side === 'L' ? 1 : -1, hand = holder('Hand' + side);
      if (kit.goalie && side === 'L') { part(hand, new T.SphereGeometry(.13, 10, 8), glove, s * .09, 0, .02).scale.set(1.15, .72, 1.25); part(hand, new T.BoxGeometry(.1, .13, .15), trim, s * -.01, 0, .01); }
      else if (kit.goalie) { part(hand, new T.BoxGeometry(.28, .2, .035), glove, s * .08, .02, -.07); part(hand, new T.BoxGeometry(.12, .1, .12), glove, s * .03, 0, 0); }
      else { part(hand, new T.BoxGeometry(.19, .11, .12), glove, s * .1, 0, .01); part(hand, new T.BoxGeometry(.08, .13, .14), trim, s * -.02, 0, .01); }
      const foot = holder('Foot' + side);
      part(foot, new T.BoxGeometry(.018, .04, .32), steel, 0, -LIFT * .55, .115);
      part(foot, new T.BoxGeometry(.06, .025, .26), black, 0, -LIFT * .2, .115);
      if (kit.goalie) {
        const pads = std(kit.pads ?? '#f2f4f6');
        const shin = holder('LowerLeg' + side);
        part(shin, new T.BoxGeometry(.2, .62, .13), pads, s * .01, -.25, .1).castShadow = true;
        part(shin, new T.BoxGeometry(.205, .05, .135), trim, s * .01, -.08, .1);
        part(shin, new T.BoxGeometry(.205, .05, .135), trim, s * .01, -.38, .1);
        part(holder('UpperLeg' + side), new T.BoxGeometry(.2, .26, .1), pads, s * .01, -.2, .12);
      } else {
        // Shoulder pads and hockey pants bulk out the slim base body.
        part(holder('Chest'), new T.SphereGeometry(.085, 8, 6), jersey, s * .15, .07, .03).scale.set(1.2, .6, 1.3);
        part(holder('LowerLeg' + side), new T.CylinderGeometry(.072, .058, .4, 8), socks, 0, -.23, .018);
      }
      part(holder('UpperLeg' + side), new T.CylinderGeometry(.1, .085, .3, 9), pants, s * .01, -.15, .01);
    }
    const hips = holder('Hips');
    part(hips, new T.CylinderGeometry(.19, .18, .2, 12), pants, 0, 0, -.005).scale.set(1, 1, .8);
    if (kit.goalie) { part(holder('Chest'), new T.SphereGeometry(.15, 12, 8), jersey, 0, .02, .03).scale.set(1.75, 1.05, 1.3); }
    // Back number (+ name) and chest crest, painted on canvas.
    const chest = holder('Chest');
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      if (kit.name) { ctx.font = 'bold 19px Oswald, sans-serif'; ctx.fillStyle = kit.numberFill; ctx.strokeStyle = kit.numberStroke; ctx.lineWidth = 4; ctx.strokeText(kit.name.toUpperCase(), 64, 18, 120); ctx.fillText(kit.name.toUpperCase(), 64, 18, 120); }
      ctx.font = 'bold 82px Oswald, sans-serif'; ctx.lineWidth = 9; ctx.fillStyle = kit.numberFill; ctx.strokeStyle = kit.numberStroke;
      ctx.strokeText(kit.number, 64, 78); ctx.fillText(kit.number, 64, 78);
      const tex = new T.CanvasTexture(canvas); tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = 4; this.owned.textures.push(tex);
      const back = part(chest, new T.PlaneGeometry(kit.goalie ? .36 : .3, kit.goalie ? .36 : .3), own(new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })), 0, kit.goalie ? -.02 : -.07, kit.goalie ? -.178 : -.118);
      back.rotation.y = Math.PI; back.castShadow = false;
    }
    if (kit.crest) { const crest = part(chest, new T.PlaneGeometry(.17, .17), kit.crest, 0, kit.goalie ? -.02 : -.07, kit.goalie ? .24 : .165); crest.castShadow = false; crest.rotation.x = -.12; }
    // Stick (character space, not bone-attached: the hands are solved onto it).
    this.stickLength = kit.goalie ? 1.32 : 1.48;
    this.shaft = part(this.root, new T.CylinderGeometry(.016, .016, 1, 6), black);
    this.blade = part(this.root, kit.goalie ? new T.BoxGeometry(.38, .09, .02) : new T.BoxGeometry(.31, .065, .018), black);
    if (kit.goalie) this.paddle = part(this.root, new T.BoxGeometry(.08, .62, .025), black);
    this.rig.updateMatrixWorld(true);
  }

  private reset() { this.restLocal.forEach((q, bone) => bone.quaternion.copy(q)); }

  /** Rotate a bone by a rotation expressed in character space (relative to the rest pose). */
  private turn(name: string, q: T.Quaternion) {
    const bone = this.bones[name], r = this.restRig.get(name);
    if (!bone || !r) return;
    _bq.copy(r.quat).invert().multiply(q).multiply(r.quat);
    bone.quaternion.copy(this.restLocal.get(bone)!).multiply(_bq);
  }

  private world(v: T.Vector3) { return this.root.localToWorld(v.clone()); }
  private dirWorld(v: T.Vector3) { return v.clone().applyQuaternion(this.root.getWorldQuaternion(new T.Quaternion())).normalize(); }

  private legs(feet: [T.Vector3, T.Vector3], poles: [T.Vector3, T.Vector3], yaw: [number, number], knees?: [T.Vector3, T.Vector3], kneeWeight = 0) {
    (['L', 'R'] as const).forEach((side, i) => {
      const b = this.bones;
      solveLimb(b['UpperLeg' + side], b['LowerLeg' + side], b['Foot' + side], this.world(feet[i]), this.dirWorld(poles[i]), knees && this.world(knees[i]), kneeWeight);
      // Keep the blade flat on the ice whatever the shin angle.
      const foot = b['Foot' + side], r = this.restRig.get('Foot' + side)!;
      _wq.copy(this.root.getWorldQuaternion(new T.Quaternion())).multiply(_q.setFromAxisAngle(Y, yaw[i])).multiply(r.quat);
      foot.parent!.getWorldQuaternion(_pq).invert(); foot.quaternion.copy(_pq.multiply(_wq)); foot.updateMatrixWorld(true);
    });
  }

  /** Places the stick (heel on/near the ice, shaft towards `top`) and returns the two grip points. */
  private stick(heel: T.Vector3, top: T.Vector3, toeSign = 1) {
    const dir = top.clone().sub(heel).normalize(), L = this.stickLength;
    this.shaft.position.copy(heel).addScaledVector(dir, L / 2); this.shaft.quaternion.setFromUnitVectors(Y, dir); this.shaft.scale.set(1, L, 1);
    const flat = vec(dir.x, 0, dir.z); if (flat.lengthSq() < 1e-4) flat.set(0, 0, -1); flat.normalize();
    let toe = vec(-flat.z, 0, flat.x); if (toe.z * toeSign < 0 || (Math.abs(toe.z) < .05 && toe.x * toeSign < 0)) toe.negate();
    const half = this.kit.goalie ? .17 : .14;
    this.blade.position.copy(heel).addScaledVector(toe, half); this.blade.position.y = Math.max(heel.y, 0) + .035;
    this.blade.quaternion.setFromUnitVectors(X, toe);
    if (this.paddle) { this.paddle.position.copy(heel).addScaledVector(dir, .36); this.paddle.quaternion.copy(this.shaft.quaternion); }
    return { top: heel.clone().addScaledVector(dir, L * (this.kit.goalie ? .6 : .97)), low: heel.clone().addScaledVector(dir, L * .6), dir };
  }

  private arms(left: T.Vector3, right: T.Vector3, leftPole: T.Vector3, rightPole: T.Vector3) {
    const b = this.bones;
    solveLimb(b.UpperArmL, b.LowerArmL, b.HandL, this.world(left), this.dirWorld(leftPole));
    solveLimb(b.UpperArmR, b.LowerArmR, b.HandR, this.world(right), this.dirWorld(rightPole));
  }

  /**
   * Skater pose. phase: stride phase (rad); amp 0..1 skating effort; shot: undefined, or time relative to
   * the release in shot units (-1 windup start, 0 puck leaves the blade, >0 follow-through);
   * cheer 0..1 goal celebration (stick up).
   */
  skate(phase: number, amp: number, shot?: number, cheer = 0) {
    this.reset();
    const crouch = lerp(.1 + .07 * amp, .02, cheer);
    this.rig.position.set(.035 * Math.sin(phase) * amp * (1 - cheer), LIFT - crouch, 0);
    // Shot profile: load (stick back, shoulders closed), whip through the puck, follow through high.
    const s = shot === undefined ? -9 : shot;
    const load = s < -1 ? 0 : s < -.35 ? smooth((s + 1) / .65) : s < 0 ? 1 - smooth((s + .35) / .35) : 0;
    const follow = s < 0 ? 0 : s < .5 ? smooth(s / .5) : 1 - smooth((s - 1.1) / .8);
    const twist = -.55 * load + .4 * follow;
    const lean = lerp(.2 + .14 * amp + .1 * load, -.05, cheer);
    this.turn('Abdomen', _q.setFromAxisAngle(X, lean * .55));
    this.turn('Torso', new T.Quaternion().setFromAxisAngle(Y, twist * .6).multiply(_q.setFromAxisAngle(X, lean * .3)));
    this.turn('Chest', new T.Quaternion().setFromAxisAngle(Y, twist * .4).multiply(_q.setFromAxisAngle(X, lean * .25)));
    this.turn('Neck', _q.setFromAxisAngle(X, -lean * .8));
    this.root.updateMatrixWorld(true);
    const feet: [T.Vector3, T.Vector3] = [vec(0, 0, 0), vec(0, 0, 0)], yaw: [number, number] = [0, 0];
    [1, -1].forEach((side, i) => {
      const ph = phase + (i ? Math.PI : 0), push = Math.max(0, Math.sin(ph)), back = Math.sin(ph);
      const wide = (.17 + .19 * push * amp) * side + (follow + load) * .06 * side;
      feet[i].set(wide, .023 + LIFT * .2 + .07 * amp * Math.max(0, -Math.sin(ph + .6)), .07 - .26 * amp * back);
      yaw[i] = side * (.12 + .3 * amp * push);
    });
    this.legs(feet, [vec(.25, -.1, 1), vec(-.25, -.1, 1)], yaw);
    // Stick: blade on the ice at the forehand side (≈1 m ahead, 0.55 m right, where the 2D path puts the puck).
    const carry = vec(-.52 + .07 * Math.sin(phase) * amp, .0, .98), carryTop = vec(.1, 1.02 - crouch, .3);
    let heel = carry, top = carryTop;
    if (load > 0) { heel = mixV(carry, vec(-.82, .3, -.15), load); top = mixV(carryTop, vec(.12, 1.12, .02), load); }
    if (follow > 0) { heel = mixV(carry, vec(-.08, 1.0, 1.25), follow); top = mixV(carryTop, vec(.36, .98, .6), follow); }
    if (cheer > 0) { heel = mixV(heel, vec(-.2, 2.25, .45), smooth(cheer)); top = mixV(top, vec(.2, 1.12, .3), smooth(cheer)); }
    const grip = this.stick(heel, top);
    this.arms(grip.top, grip.low, vec(1, -.6, -.6), vec(-1, -.8, -.3));
  }

  /** Goalie pose: stance → butterfly as `drop` goes 0..1; shuffle -1..1 leans toward the glove/blocker side. */
  goalie(drop: number, shuffle = 0) {
    this.reset();
    const d = smooth(drop), crouch = lerp(.2, .5, d);
    this.rig.position.set(shuffle * .05, LIFT - crouch, -.08 * d);
    const lean = lerp(.4, .18, d);
    this.turn('Abdomen', _q.setFromAxisAngle(X, lean * .55));
    this.turn('Torso', _q.setFromAxisAngle(X, lean * .3));
    this.turn('Chest', _q.setFromAxisAngle(X, lean * .2));
    this.turn('Neck', _q.setFromAxisAngle(X, -lean * .9));
    this.root.updateMatrixWorld(true);
    const feet: [T.Vector3, T.Vector3] = [vec(lerp(.36, .62, d), lerp(.025 + LIFT * .2, .08, d), lerp(0, -.12, d)), vec(-lerp(.36, .62, d), lerp(.025 + LIFT * .2, .08, d), lerp(0, -.12, d))];
    // Butterfly: knees together on the ice in front, pads flared out flat along the goal line.
    this.legs(feet, [vec(.4, 0, 1), vec(-.4, 0, 1)], [lerp(.25, 1.1, d), -lerp(.25, 1.1, d)], [vec(.12, .1, .26), vec(-.12, .1, .26)], d);
    const heel = vec(-.04, 0, lerp(.62, .52, d)), top = vec(-.3, lerp(.95, .8, d), .3);
    const grip = this.stick(heel, top, -1);
    this.arms(vec(.5, lerp(.9, .85, d) - crouch * .45 + .2 * d, .38), grip.top, vec(1, -.8, -.3), vec(-1, -.8, -.3));
  }

  dispose() {
    this.owned.geometries.forEach(g => g.dispose()); this.owned.materials.forEach(m => m.dispose()); this.owned.textures.forEach(t => t.dispose());
    this.root.removeFromParent();
  }
}
