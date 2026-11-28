import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
// Base body: "Ultimate Modular Men" by Quaternius (CC0 1.0, https://quaternius.com) — hair removed,
// materials renamed (Jersey/Pants/Skate) and meshopt-compressed to ~150 KB. Inlined by the single-file build.
import modelUrl from '../assets/hockey-player.glb?url';
import { buildHelmet, kitUp } from './playerGear';
import type { ReleaseKind } from './replayMotion';
import type { LiveMove, LiveStance } from '../game/rinkPlayback';
import { NO_GAIT, type Gait, type SkateStyle } from './skateGait';

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
  /** Skaters: the stick hand (L — blade on the left). Goalies: the catching hand (L — glove on the left). Default L. */
  hand?: 'L' | 'R';
  /** an on-ice official instead of a player: black-and-white stripes, no stick; referees wear orange armbands */
  official?: 'ref' | 'line';
};

/** What an official's arms do (see officialCrew): the IIHF signals, the faceoff drop, a point. */
export type OfficialPose = {
  phase: number; amp: number;
  gesture: 'none' | 'armUp' | 'point' | 'goal' | 'trip' | 'hook' | 'hold' | 'slash' | 'interference' | 'boarding' | 'charging' | 'highstick' | 'fist' | 'icing' | 'washout' | 'ready' | 'drop' | 'shake' | 'elbow' | 'head' | 'behind' | 'knee' | 'delay';
  /** seconds into the gesture */ t: number;
  /** a pointing arm's target in character space */ aim?: T.Vector3 | null;
  /** head turn toward the play (rad, + to his left) */ look?: number;
  /** at a faceoff ('ready'): the windup before the throw 0…1 — the hand with the puck comes up */ windup?: number;
  /** walking on the skates off the ice (out of the officials' corridor) 0…1; `phase` then counts steps (matchIntro's WALK_CYCLE) */ walk?: number;
};

/** The body over a walking stride: lowest as the weight lands on a foot, up over the standing leg. */
const walkCrouch = (phase: number) => .05 + .018 * Math.cos(phase * 2);
/**
 * One foot of a walk on skates (character space, side +1 left / -1 right): forward and back under the hip, lifted
 * clear of the floor as it swings through (the blade must not drag), set down flat — not the skating push out sideways.
 */
function walkFoot(ph: number, side: number): { foot: T.Vector3; yaw: number } {
  const swing = Math.max(0, Math.cos(ph));
  return { foot: vec(.13 * side, .023 + LIFT * .2 + .14 * Math.pow(swing, 1.5), .02 + .3 * Math.sin(ph)), yaw: side * .07 };
}

/** Goalie pose. Points are in character space (+x the goalie's left, +z out of the net). */
export type GoaliePose = {
  /** 0 stance … 1 butterfly */
  drop: number;
  /** sideways movement −1..1 (+ toward his left): shuffle, T-push when fast */
  lateral?: number;
  /** where the puck reaches him, and how far into the save he is (0..1) */
  save?: T.Vector3 | null; saveWeight?: number;
  /** poke check at a puck in front of him */
  poke?: T.Vector3 | null; pokeWeight?: number;
  /** head and shoulders follow the puck beyond his body angle (rad, + to his left) */
  look?: number;
  /** the frozen puck: caught in the glove (held up at the chest) or covered on the ice under him, 0..1 into it */
  hold?: 'glove' | 'cover' | null; holdW?: number;
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
  kitUp(scene); // shoulder pads, pants, shin guards: the slim base body in full hockey kit
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

/** Kit shader: base colour + bands defined in rest-pose space. kind 0 jersey, 1 socks, 2 pants, 3 referee's
 *  shirt (stripes, orange armbands), 4 linesman's shirt (stripes). */
function kitMaterial(kind: 0 | 1 | 2 | 3 | 4, base: string, trim: string, trim2: string) {
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
        if (uKind > 2.5) {
          // officials: 5 cm black stripes down the shirt, a black collar; the referee's orange armbands
          float st = step(.5, fract(ax * 9.0 + .25)) * step(ax, .3) + step(.5, fract(y * 9.0)) * step(.3, ax);
          diffuseColor.rgb = mix(diffuseColor.rgb, uTrim, clamp(st + step(1.46, y) * step(ax, .29) * step(.03, ax), 0., 1.));
          if (uKind < 3.5) diffuseColor.rgb = mix(diffuseColor.rgb, uTrim2, band(ax, .3, .36));
        } else if (uKind < .5) {
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
const Y = new T.Vector3(0, 1, 0), X = new T.Vector3(1, 0, 0), Z = new T.Vector3(0, 0, 1);
const _t1 = new T.Quaternion(), _t2 = new T.Quaternion(), _q2 = new T.Quaternion();
const LIFT = .06; // skate blade height: the rig stands on its blades
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** The steepest a skater's stick stands with its blade on the ice (the sine of the shaft's rise): the knob about waist high. */
const STICK_MAX_RISE = .7;
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

const _m0 = new T.Matrix4(), _m1 = new T.Matrix4(), _f = new T.Vector3(), _g = new T.Vector3(), _h = new T.Vector3();
/**
 * Like `aim`, but with the twist about the bone held: the bone's own `bendLocal` axis (the way the next joint
 * folds, in the bone's frame) is turned onto `bend`. A minimal rotation leaves the twist to chance — an arm
 * swung from the T-pose across the chest to the stick came out rolled over, the shoulder pad wrung (the top hand).
 */
function aimTwist(bone: T.Object3D, child: T.Object3D, target: T.Vector3, bend: T.Vector3, bendLocal: T.Vector3) {
  const b = _a.setFromMatrixPosition(bone.matrixWorld), c = _b.setFromMatrixPosition(child.matrixWorld);
  const d0 = c.sub(b).normalize(), d1 = _c.copy(target).sub(b);
  if (d1.lengthSq() < 1e-8) return;
  d1.normalize();
  bone.getWorldQuaternion(_wq);
  const b0 = _f.copy(bendLocal).applyQuaternion(_wq); b0.addScaledVector(d0, -b0.dot(d0));
  const b1 = _g.copy(bend); b1.addScaledVector(d1, -b1.dot(d1));
  if (b0.lengthSq() < 1e-6 || b1.lengthSq() < 1e-6) { aim(bone, child, target); return; }
  b0.normalize(); b1.normalize();
  _m0.makeBasis(d0, b0, _h.crossVectors(d0, b0));
  _m1.makeBasis(d1, b1, _e.crossVectors(d1, b1));
  _q.setFromRotationMatrix(_m1.multiply(_m0.transpose()));
  _wq.premultiply(_q);
  bone.parent!.getWorldQuaternion(_pq).invert();
  bone.quaternion.copy(_pq.multiply(_wq));
  bone.updateMatrixWorld(true);
}

/** Analytic two-bone IK (shoulder-elbow-wrist, hip-knee-ankle) with a pole direction for the middle joint.
 *  `bendLocal`: the upper bone's fold axis in its own frame — its twist is then solved too (the arms). */
function solveLimb(upper: T.Object3D, lower: T.Object3D, end: T.Object3D, target: T.Vector3, pole: T.Vector3, joint?: T.Vector3, jointWeight = 0, bendLocal?: T.Vector3) {
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
  if (bendLocal) {
    // the way the forearm folds off the upper arm (for a straight arm: away from the pole)
    const fold = reach.clone().sub(elbow), up = elbow.clone().sub(s).normalize();
    fold.addScaledVector(up, -fold.dot(up));
    if (fold.lengthSq() < 1e-5) fold.copy(n).negate();
    aimTwist(upper, lower, elbow, fold, bendLocal);
  } else aim(upper, lower, elbow);
  aim(lower, end, reach);
}

export class PlayerFigure {
  readonly root = new T.Group();
  private rig: T.Object3D;
  private bones: Record<string, T.Bone> = {};
  private restLocal = new Map<T.Bone, T.Quaternion>();
  private restRig: Map<string, Rest>;
  /** the upper arms' fold axis in their own bone frames: the T-pose elbow folds the forearm forward (+z) */
  private fold: Record<'L' | 'R', T.Vector3> = { L: new T.Vector3(), R: new T.Vector3() };
  private shaft: T.Mesh; private blade: T.Mesh; private paddle?: T.Mesh;
  /** the shaft's flex this frame (m at its middle) and the bow its geometry has now; its straight vertices */
  private flex = 0; private bent = 0; private shaftRest?: Float32Array;
  private stickLength: number;
  private owned: { geometries: T.BufferGeometry[]; materials: T.Material[]; textures: T.Texture[] } = { geometries: [], materials: [], textures: [] };

  /** +1: the rig's natural side (skater: blade on the right, a right shot; goalie: glove on the left). −1: mirrored. */
  private hand: 1 | -1;

  constructor(template: Template, private kit: Kit) {
    this.hand = kit.goalie ? (kit.hand === 'R' ? -1 : 1) : (kit.hand === 'L' ? -1 : 1);
    this.restRig = template.rest;
    this.rig = cloneSkinned(template.scene);
    this.root.add(this.rig);
    this.rig.position.y = LIFT;
    const own = <M extends T.Material>(m: M) => { this.owned.materials.push(m); return m; };
    const std = (color: string, extra: T.MeshStandardMaterialParameters = {}) => own(new T.MeshStandardMaterial({ color, roughness: .6, ...extra }));
    const jersey = own(kitMaterial(kit.official === 'ref' ? 3 : kit.official ? 4 : 0, kit.jersey, kit.trim, kit.trim2));
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
    for (const sd of ['L', 'R'] as const) {
      const r = this.restRig.get('UpperArm' + sd);
      if (r) this.fold[sd].copy(Z).applyQuaternion(r.quat.clone().invert());
    }
    // Gloved fists: the base model's open hands are shrunk inside the gloves.
    this.bones.HandL.scale.setScalar(.6); this.bones.HandR.scale.setScalar(.6);
    this.rig.updateMatrixWorld(true);
    const glove = std(kit.glove), steel = std('#c9d6de', { metalness: .7, roughness: .3 });
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
    holder('Head').add(buildHelmet(kit, this.owned));
    for (const side of ['L', 'R'] as const) {
      const s = side === 'L' ? 1 : -1, hand = holder('Hand' + side);
      const gloveSide = kit.hand === 'R' ? 'R' : 'L';
      if (kit.goalie && side === gloveSide) { part(hand, new T.SphereGeometry(.13, 10, 8), glove, s * .09, 0, .02).scale.set(1.15, .72, 1.25); part(hand, new T.BoxGeometry(.1, .13, .15), trim, s * -.01, 0, .01); }
      else if (kit.goalie) { part(hand, new T.BoxGeometry(.28, .2, .035), glove, s * .08, .02, -.07); part(hand, new T.BoxGeometry(.12, .1, .12), glove, s * .03, 0, 0); }
      else if (kit.official) part(hand, new T.BoxGeometry(.12, .09, .1), glove, s * .07, 0, .01); // thin gloves
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
      }
    }
    if (kit.goalie) { part(holder('Chest'), new T.SphereGeometry(.15, 12, 8), jersey, 0, 0, .02).scale.set(1.5, 1.0, .95); }
    // Back number (+ name) and chest crest, painted on canvas.
    const chest = holder('Chest');
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (ctx && !kit.official) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      if (kit.name) { ctx.font = 'bold 19px Oswald, sans-serif'; ctx.fillStyle = kit.numberFill; ctx.strokeStyle = kit.numberStroke; ctx.lineWidth = 4; ctx.strokeText(kit.name.toUpperCase(), 64, 18, 120); ctx.fillText(kit.name.toUpperCase(), 64, 18, 120); }
      ctx.font = 'bold 82px Oswald, sans-serif'; ctx.lineWidth = 9; ctx.fillStyle = kit.numberFill; ctx.strokeStyle = kit.numberStroke;
      ctx.strokeText(kit.number, 64, 78); ctx.fillText(kit.number, 64, 78);
      const tex = new T.CanvasTexture(canvas); tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = 4; this.owned.textures.push(tex);
      const back = part(chest, new T.PlaneGeometry(kit.goalie ? .38 : .34, kit.goalie ? .38 : .34), own(new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })), 0, kit.goalie ? -.02 : -.05, kit.goalie ? -.2 : -.152);
      back.rotation.y = Math.PI; back.castShadow = false;
    }
    if (kit.crest) { const crest = part(chest, new T.PlaneGeometry(.19, .19), kit.crest, 0, kit.goalie ? -.02 : -.08, kit.goalie ? .26 : .19); crest.castShadow = false; crest.rotation.x = -.12; }
    // Stick (character space, not bone-attached: the hands are solved onto it).
    this.stickLength = kit.goalie ? 1.32 : 1.48;
    this.shaft = part(this.root, new T.CylinderGeometry(.016, .016, 1, 6, 6), black);
    this.blade = part(this.root, kit.goalie ? new T.BoxGeometry(.38, .09, .02) : new T.BoxGeometry(.31, .065, .018), black);
    if (kit.goalie) this.paddle = part(this.root, new T.BoxGeometry(.08, .62, .025), black);
    if (kit.official) this.shaft.visible = this.blade.visible = false;
    this.rig.updateMatrixWorld(true);
  }

  private reset() { this.restLocal.forEach((q, bone) => bone.quaternion.copy(q)); this.flex = 0; }
  /** The stick in his hands (or not: thrown away after the Cup, the Cup in his hands). */
  private props(on: boolean) { if (this.kit.official) return; this.shaft.visible = this.blade.visible = on; if (this.paddle) this.paddle.visible = on; }

  /** Where a trophy held in both hands sits (world): between the gloves. */
  cupPoint(out: T.Vector3): T.Vector3 {
    const a = this.bones.HandL.getWorldPosition(new T.Vector3()), b = this.bones.HandR.getWorldPosition(new T.Vector3());
    return out.copy(a).add(b).multiplyScalar(.5);
  }

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

  /** World position of the middle of the stick blade (after the pose of this frame). */
  bladeWorld(out: T.Vector3): T.Vector3 { return this.blade.getWorldPosition(out); }

  /** Places the stick (heel on/near the ice, shaft towards `top`) and returns the two grip points. */
  private stick(heel: T.Vector3, top: T.Vector3, toeSign = 1, xSign = toeSign) {
    const dir = top.clone().sub(heel).normalize(), L = this.stickLength;
    let choke = 0;
    // a skater's stick never stands up straight with the blade on the ice (the knob — and the top hand on it — would
    // go up over his head): a puck in close to his skates, the shaft keeps its lie and the top hand goes out to the side
    // by his hip (toward the top hand's side), the stick angled across him, and both hands slide down the shaft (he
    // chokes up on it, the knob sticking out past the top hand)
    if (!this.kit.goalie && !this.kit.official && heel.y < .3 && dir.y > STICK_MAX_RISE) {
      const u = clamp01((dir.y - STICK_MAX_RISE) / .15), hx = dir.x, hz = dir.z, hl = Math.hypot(hx, hz);
      const sx = this.hand * .6, sz = -.8;
      let nx = (hl > 1e-4 ? hx / hl : sx) * (1 - u) + sx * u, nz = (hl > 1e-4 ? hz / hl : sz) * (1 - u) + sz * u;
      const nl = Math.hypot(nx, nz) || 1, flat = Math.sqrt(1 - STICK_MAX_RISE * STICK_MAX_RISE);
      nx /= nl; nz /= nl;
      dir.set(nx * flat, STICK_MAX_RISE, nz * flat);
      choke = u;
    }
    this.shaft.position.copy(heel).addScaledVector(dir, L / 2); this.shaft.quaternion.setFromUnitVectors(Y, dir); this.shaft.scale.set(1, L, 1);
    // the flex: the shaft bowed back (its middle behind the line from the blade to the hands)
    const bow = vec(0, 0, -1).addScaledVector(dir, dir.z); if (bow.lengthSq() < 1e-4) bow.set(1, 0, 0); bow.normalize();
    this.bend(this.flex, bow.clone().applyQuaternion(this.shaft.quaternion.clone().invert()));
    const flat = vec(dir.x, 0, dir.z); if (flat.lengthSq() < 1e-4) flat.set(0, 0, -1); flat.normalize();
    let toe = vec(-flat.z, 0, flat.x); if (toe.z * toeSign < 0 || (Math.abs(toe.z) < .05 && toe.x * xSign < 0)) toe.negate();
    const half = this.kit.goalie ? .17 : .14;
    this.blade.position.copy(heel).addScaledVector(toe, half); this.blade.position.y = Math.max(heel.y, 0) + .035;
    this.blade.quaternion.setFromUnitVectors(X, toe);
    if (this.paddle) { this.paddle.position.copy(heel).addScaledVector(dir, .36); this.paddle.quaternion.copy(this.shaft.quaternion); }
    return { top: heel.clone().addScaledVector(dir, L * (this.kit.goalie ? .6 : .97 - .26 * choke)), low: heel.clone().addScaledVector(dir, L * (.6 - .14 * choke)).addScaledVector(bow, this.flex * Math.sin(Math.PI * .6)), dir };
  }
  /** Bows the shaft by `amount` (m at its middle) along `dirLocal` (the shaft's own frame); straight again at 0. */
  private bend(amount: number, dirLocal: T.Vector3) {
    if (amount === 0 && this.bent === 0) return;
    const pos = this.shaft.geometry.getAttribute('position') as T.BufferAttribute;
    this.shaftRest ??= Float32Array.from(pos.array as Float32Array);
    const r = this.shaftRest;
    for (let i = 0; i < pos.count; i++) {
      const y = r[i * 3 + 1], k = amount * Math.sin(Math.PI * (y + .5));
      pos.setXYZ(i, r[i * 3] + dirLocal.x * k, y, r[i * 3 + 2] + dirLocal.z * k);
    }
    pos.needsUpdate = true; this.bent = amount;
  }

  private arms(left: T.Vector3, right: T.Vector3, leftPole: T.Vector3, rightPole: T.Vector3) {
    this.arm('L', this.world(left), this.dirWorld(leftPole));
    this.arm('R', this.world(right), this.dirWorld(rightPole));
  }
  /** One arm onto a world point, the elbow toward a world pole, the upper arm's twist solved with it. */
  private arm(side: 'L' | 'R', target: T.Vector3, pole: T.Vector3) {
    const b = this.bones, sg = side === 'L' ? 1 : -1;
    // the collarbone goes with the arm: down when the hand is low (the T-pose pad stood up in a peak over a hanging
    // arm), forward when it reaches in front or across the body
    const tl = this.root.worldToLocal(target.clone()), sh = b['UpperArm' + side].getWorldPosition(_f), shl = this.root.worldToLocal(sh);
    const drop = clamp01((shl.y - tl.y) / .55) - clamp01((tl.y - shl.y) / .4) * .8, fwd = clamp01(tl.z / .55) * .7 + clamp01((.12 - sg * tl.x) / .35) * .5;
    this.turn('Shoulder' + side, _t1.setFromAxisAngle(Z, -.34 * drop * sg).multiply(_t2.setFromAxisAngle(Y, -.26 * fwd * sg)));
    b['Shoulder' + side].updateMatrixWorld(true);
    solveLimb(b['UpperArm' + side], b['LowerArm' + side], b['Hand' + side], target, pole, undefined, 0, this.fold[side]);
  }

  /** Mirror a character-space point across the body (left ↔ right) for a figure of the other hand. */
  private mir(v: T.Vector3) { if (this.hand < 0) v.x = -v.x; return v; }

  /** Both hands on the stick: the top hand on the knob, the other one lower down (sides swap with the hand). */
  private grip(heel: T.Vector3, top: T.Vector3, topPole: T.Vector3, lowPole: T.Vector3, toeSign = 1) {
    const g = this.stick(this.mir(heel), this.mir(top), toeSign, toeSign * this.hand);
    this.mir(topPole); this.mir(lowPole);
    if (this.hand > 0) this.arms(g.top, g.low, topPole, lowPole); else this.arms(g.low, g.top, lowPole, topPole);
  }

  /**
   * Skater pose. phase: stride phase (rad); amp 0..1 skating effort; shot: undefined, or time relative to
   * the release in shot units (-1 windup start, 0 puck leaves the blade, >0 follow-through, over at 1.9);
   * cheer 0..1 goal celebration (stick up).
   * opts.kind: what is released — shots (wrist, snap, slap, backhand, tip) or a pass;
   * opts.bank: lean into a turn (rad, + = toward the player's left); opts.reach: a puck point in character
   * space the blade should cup (weight opts.reachWeight 0..1), so a carried puck sits on the blade;
   * opts.deke: sideways stickhandling offset of the puck (m, + = his left) — shoulders and head sell the fake.
   * opts.check 0..1: a body check — low, the lead shoulder driven forward, stick down and tight;
   * opts.poke 0..1: a poke check — lunge with the stick shot out along the ice at arm's length.
   * opts.move/moveT: a named move and its progress 0..1 — a toe drag (the blade turned over pulls the puck back
   * to the skates and across), between the legs (forehand → through the feet → backhand), a spin-o-rama (low and
   * tucked, the turn itself is the group's yaw), a shot fake (a full windup that never comes down), a hip check
   * (hips swung into the man), a board pin (tall, chest and gloves on the man), a shoulder check, a stick lift
   * (the blade comes up under his stick), a stretch (reach: the stick shot out one-handed to a puck beyond the
   * blade, the body lunging after it); opts.stagger 0..1: knocked off balance after a hit — a wobble, arms out;
   * opts.down 0..1: on the ice after a fall (the group itself is tipped over by the caller) — knees bent, arms
   * thrown out to break the fall, the stick flung wide, the head up.
   * opts.shake 0..1: the right hand out for a handshake (the stick stays in the other one), shaking with opts.t;
   * opts.pump 0..1: a goal scorer's fist pump with the free (right) arm, in time with opts.t; opts.kneel 0..1:
   * down on one knee, sliding (the celebration after a goal).
   * After the final siren: opts.slump 0..1 — a loser's head down, shoulders sunk, the stick dragged; opts.noStick —
   * the stick gone (thrown away): the gloves at his sides, or both fists up with `cheer`; opts.trophy 0..1 — a Cup in
   * both hands, .5 at the chest, 1 high over his head (no stick; `cupPoint` is where the Cup goes).
   * Contact and traffic: opts.jolt — the way a hit knocked him (character space, x his left, z ahead) and how hard 0…1,
   * scaled by `stagger`: a catch step that way, the body thrown with it, a big one sideways puts a glove down on the ice;
   * opts.threat — where the nearest checker is (character space): protecting the puck turns his back or side to him,
   * low and wide, the puck out at arm's length on the far side, the near arm barring him off; opts.tight 0…1 — a man on
   * him with the puck: the stick in close, compact, the body leaning into him; opts.fallReach 0…1 — going down, the
   * stick shot out one-handed at the puck (opts.reach).
   * Shots: the weight goes from the back skate onto the front one (the back skate comes off the ice in the follow-
   * through), the hips open with the shoulders and the shaft flexes as the blade loads into the ice.
   * Everything is solved for a right shot and mirrored for a left one.
   */
  skate(phase: number, amp: number, shot?: number, cheer = 0, opts: { bank?: number; reach?: T.Vector3 | null; reachWeight?: number; kind?: ReleaseKind; deke?: number; check?: number; poke?: number; move?: LiveMove; moveT?: number; stagger?: number; down?: number; shake?: number; pump?: number; kneel?: number; bump?: number; t?: number; stance?: LiveStance; stanceT?: number; handle?: number; now?: number; walk?: number; slump?: number; noStick?: boolean; trophy?: number; pitch?: number; pitchLift?: number; gait?: Gait; style?: SkateStyle; jolt?: { x: number; z: number; k: number } | null; threat?: T.Vector3 | null; tight?: number; fallReach?: number } = {}) {
    this.reset();
    const slump = smooth(clamp01(opts.slump ?? 0)), trophy = clamp01(opts.trophy ?? 0), noStick = !!opts.noStick || trophy > 0;
    this.props(!noStick);
    const m = this.hand, kind = opts.kind ?? 'wrist';
    // walking on the skates (off the ice: out of the tunnel, over the bench floor): upright, a step with each foot
    const walk = smooth(clamp01(opts.walk ?? 0));
    const chk = smooth(clamp01(opts.check ?? 0)), poke = smooth(clamp01(opts.poke ?? 0));
    let bank = clamp01(Math.abs(opts.bank ?? 0) / .4) * .4 * Math.sign(opts.bank ?? 0) * (1 - cheer);
    const deke = (opts.deke ?? 0) * m; // in the right-shot frame
    // named moves: a bell over the move (in, hold, out) and its progress
    const mv = opts.move, mu = clamp01(opts.moveT ?? 0), bell = mv ? Math.sin(Math.PI * mu) : 0;
    const w = (k: LiveMove) => (mv === k ? bell : 0);
    const toe = w('toe'), btw = w('between'), spin = w('spin'), fake = w('fake'), hip = w('hip'), pin = w('pin'), lift = w('lift'), rch = w('reach');
    // infractions (see FoulMove): a quick rise into the act, held, then out (`fw` the envelope of each)
    const fw = (k: LiveMove) => (mv === k ? smooth(clamp01(mu / .22)) * (1 - smooth(clamp01((mu - .72) / .28))) : 0);
    const fHead = fw('fHead'), fElbow = fw('fElbow'), fKnee = fw('fKnee'), fSlash = fw('fSlash'), fHigh = fw('fHigh'), fTrip = fw('fTrip');
    const fHook = fw('fHook'), fHold = fw('fHold'), fCross = fw('fCross'), fBoard = fw('fBoard');
    let fRough = fw('fRough');
    const stag = clamp01(opts.stagger ?? 0), down = smooth(clamp01(opts.down ?? 0));
    // a jolt: knocked the way of the hit — the body goes with it, a catch step; a hard one sideways puts a glove on the ice
    const jo = opts.jolt, jw = jo ? clamp01(jo.k) * smooth(clamp01(stag * 1.8)) * (1 - down) : 0, jx = jo ? jo.x : 0, jz = jo ? jo.z : 0;
    const handIce = jo ? smooth(clamp01((jo.k - .6) / .3)) * smooth(clamp01(stag * 2.2)) * smooth(clamp01((Math.abs(jx) - .35) / .4)) * (1 - down) : 0;
    // (a directed jolt replaces most of the plain wobble)
    const wob = stag * Math.sin(stag * 18) * (1 - .7 * clamp01(jo?.k ?? 0));
    // the manager's goal celebrations (moveT over the whole of it): in quickly, held, out at the end
    const cw = (k: LiveMove) => (mv === k ? smooth(clamp01(mu / .1)) * (1 - smooth(clamp01((mu - .86) / .14))) : 0);
    const cArms = cw('cel1'), cBow = cw('cel2'), cSky = cw('cel3'), cEar = cw('cel4');
    const cStick = Math.max(cw('celStick'), cw('celStickPump')), cKnee = Math.max(cw('celKnee'), cw('celKneePump'));
    const cPump = Math.max(cw('celPump'), cw('celStickPump'), cw('celKneePump'));
    if (cArms > 0) cheer = Math.max(cheer, cArms);
    if (cPump > 0) opts = { ...opts, pump: Math.max(opts.pump ?? 0, cPump), t: (opts.now ?? 0) };
    if (cKnee > 0) opts = { ...opts, kneel: Math.max(opts.kneel ?? 0, cKnee) };
    // a fight: the gloves off, punches with the right (as roughing, harder), the left holding his jersey
    const fgt = mv === 'fight' ? smooth(clamp01(mu / .08)) : 0;
    const kick = w('kick'), dive = mv === 'dive' ? smooth(clamp01(mu / .2)) : 0;
    // laid out in a dive (the caller pitches the whole figure forward by opts.pitch): flat on the chest, the legs
    // straight out behind, the head up — and the stick swept across the ice out in front to catch the puck
    const lay = dive * down;
    fRough = Math.max(fRough, fgt);
    const fArm = Math.max(fHead, fElbow, fHold, fRough);
    // held stances (the played match): blocking — down on one knee, the stick flat across; a one-timer — the stick
    // cocked; calling for the puck — the blade tapping the ice; vision — wide, the stick out in front; hustle — leaning
    // into a burst; the manager's stickhandling turns the shoulders with the puck
    const stw = smooth(clamp01(opts.stanceT ?? 0)), st = opts.stance;
    const prot = st === 'protect' ? stw : 0;
    // where the checker is: his side (character x, + = his left) and how far behind; the side in the right-shot frame
    const thr = opts.threat, thrD = thr ? Math.hypot(thr.x, thr.z) || 1 : 1, tSide = thr ? thr.x / thrD : 0, tNear = thr ? 1 - smooth((thrD - 1.1) / 1.8) : 0;
    const tSideR = tSide * m, tSgn = Math.sign(tSideR) || 1, tLat = smooth(clamp01(Math.abs(tSide) / .6)), pDir = thr ? prot : 0;
    const armBar = pDir * tLat * tNear;
    const tight = smooth(clamp01(opts.tight ?? 0)) * (1 - prot) * (1 - walk);
    const fallReach = smooth(clamp01(opts.fallReach ?? 0)) * (opts.reach ? 1 : 0);
    const brd = st === 'board' ? stw : 0, swp = st === 'sweep' ? stw : 0;
    const blk = Math.max(st === 'block' ? stw : 0, dive), ot = st === 'oneTimer' ? stw : 0, call = st === 'call' ? stw : 0, vis = st === 'vision' ? stw : 0, hus = st === 'hustle' ? stw : 0;
    const hdl = Math.max(-1, Math.min(1, opts.handle ?? 0)), shove = w('push'), now = opts.now ?? 0;
    const kneel = Math.max(smooth(clamp01(opts.kneel ?? 0)), (st === 'block' ? stw : 0) * .9);
    // (leaning: with a jolt, and into the checker when he shields the puck or has a man on him)
    bank += jx * jw * .34 + Math.sign(jx) * handIce * .3 + tSide * (pDir * .2 + tight * .12) * tNear;
    // plain skating (skateGait.ts): an explosive start, a hard stop, backwards, a shuffle, crossovers, one hand off
    // the stick — none of it while he walks, lies on the ice, kneels, blocks or fights
    const gt = opts.gait ?? NO_GAIT, sty = opts.style, plain = (1 - walk) * (1 - down) * (1 - kneel) * (1 - fgt) * (1 - cheer);
    const gBurst = smooth(clamp01(gt.burst)) * plain, gStop = smooth(clamp01(gt.stop)) * plain, gSS = gt.stopSide, gBack = smooth(clamp01(gt.back)) * plain;
    const gShuf = Math.max(-1, Math.min(1, gt.shuffle)) * plain, gCross = Math.max(-1, Math.min(1, gt.cross)) * plain, gOne = smooth(clamp01(gt.oneHand)) * plain;
    // Deeper knee bend on a hard stride, a little bob with every push.
    const crouch = lerp(.1 + .07 * amp + .012 * amp * Math.cos(phase * 2), .02, cheer) * (1 - walk) + walk * walkCrouch(phase) + Math.abs(bank) * .08 + Math.abs(deke) * .06 + chk * .1 + poke * .07
      + toe * .08 + btw * .16 + spin * .12 + hip * .14 - pin * .04 + lift * .05 - stag * .03 + rch * .14 + down * .22 * (1 - lay) - lay * .06 + kneel * .42
      + ot * .06 + vis * .08 + hus * .04 + Math.abs(hdl) * .05 + shove * .05 + prot * .1 + brd * .2 + swp * .12 + cStick * .2 + fgt * .06 - kick * .04
      - fHead * .05 + fTrip * .14 + fKnee * .05 + fHook * .05 + fCross * .04 + fBoard * .06 - fRough * .03
      + gBurst * .08 + gStop * .2 + gBack * .12 + Math.abs(gShuf) * .07 + (sty ? sty.low * .04 * (1 - walk) : 0)
      + pDir * .08 + tight * .05 + jw * .1 + handIce * .26;
    // Shot profile: load (stick back, shoulders closed), whip through the puck, follow through.
    const s = shot === undefined ? -9 : shot;
    // a shot fake: the windup comes up and is held, the puck stays on the blade
    const load = Math.max(s < -1 ? 0 : s < -.35 ? smooth((s + 1) / .65) : s < 0 ? 1 - smooth((s + .35) / .35) : 0, smooth(Math.min(1, fake * 1.4)));
    const follow = s < 0 ? 0 : s < .5 ? smooth(s / .5) : 1 - smooth((s - 1.1) / .8);
    const size = kind === 'pass' ? .55 : kind === 'saucer' ? .65 : kind === 'tip' ? .3 : kind === 'slap' ? 1.25 : 1;
    const back = kind === 'backhand';
    // the weight: onto the back skate in the load, over onto the front one through the release (right-shot frame: the
    // back skate is on the forehand side, −x; a backhand the other way round); `shift` + = toward the front skate
    const shotW = kind === 'pass' || kind === 'tip' ? .4 : 1, shift = (-.8 * load + follow) * Math.min(1.15, size) * shotW * (back ? -1 : 1);
    this.rig.position.set(.035 * Math.sin(phase) * lerp(amp, .7, walk) * (1 - cheer) * (1 - gStop) + bank * .1 + (opts.deke ?? 0) * .12 + wob * .08 + hip * .12 * m + gShuf * .05
      + shift * .085 * m + jx * jw * .1, LIFT - crouch, -gStop * .06 + jz * jw * .08);
    // a body check turns the lead shoulder (the one away from the stick) into the man; a poke reaches with the top hand
    const twist = ((back ? .45 : -.55) * load + (back ? -.4 : .4) * follow) * size + deke * .5 + chk * .5 - poke * .3
      + toe * .3 + (mv === 'between' ? Math.sin(2 * Math.PI * mu) * .35 : 0) + hip * .9 + pin * .35 + wob * .3 - rch * .45
      - ot * .4 + hdl * .22 * m - prot * .55 * (1 - pDir) - pDir * tSgn * .75 * tLat + brd * .25 + cBow * .5 - tight * tSgn * .2 * tNear
      // the free arm's shoulder driven into the man (head, elbow, punches), the stick swung across (slash, trip)
      - (fHead * .55 + fElbow * .5 + fRough * (.3 + .25 * Math.sin(now * 9))) + fSlash * .3 + fTrip * .35 - fHook * .2;
    const lean = lerp(lerp(.2 + .14 * amp, .07, walk) + .1 * load * size, -.05, cheer) + chk * .22 + poke * .28 + btw * .25 + spin * .2 + toe * .1 - pin * .05 + lift * .18 - stag * .35 + rch * .42 - down * .45 * (1 - lay) - lay * .08
      - blk * .2 * (1 - lay) + vis * .06 + hus * .16 + shove * .22 + Math.abs(hdl) * .08 + prot * .12 + brd * .3 + swp * .2 + cStick * .1 - cSky * .1 - cEar * .05
      + fHead * .12 + fElbow * .06 + fTrip * .3 + fHook * .14 + fCross * .24 + fBoard * .3 - fHold * .04 + fRough * .04 + fSlash * .1 + slump * .26
      // a start: far forward over the toes; a stop: back against it, the skates out ahead; backwards: upright, sitting
      + gBurst * .62 - gStop * .3 - gBack * .12
      // a jolt from behind throws him forward, from the front back; over the front skate in a shot's follow-through
      + jz * jw * .42 + Math.max(0, shift) * .08 + tight * .06
      // his own style: a speed man leans into it, a power forward stands taller
      + (sty ? sty.lean * .12 * amp * plain - Math.max(0, -sty.low) * .05 * plain : 0);
    // Shoulders counter-rotate the stride a little (real skaters swing the upper body against the legs).
    const swing = .07 * lerp(amp, 1.2, walk) * Math.sin(phase) * (1 - load) * (1 - follow) * (1 - cheer) * (1 + 1.6 * hus) * (1 - blk);
    // a stop: the hips (and the legs with them) turned across the way he slides, the shoulders kept square to it
    // the hips open with the shot (and come round with the shoulders), turn across in a stop
    const hipTurn = gSS * gStop * .8 + ((back ? .28 : -.32) * load + (back ? -.3 : .34) * follow) * Math.min(1, size) * shotW * m
      - pDir * tSgn * .4 * tLat * m; // (shielding: the hips come round too, the back to the checker)
    if (hipTurn !== 0) this.turn('Hips', _t1.setFromAxisAngle(Y, hipTurn));
    this.turn('Abdomen', _q2.setFromAxisAngle(Y, -gSS * gStop * .7).multiply(_t1.setFromAxisAngle(Z, -bank * .45 - (opts.deke ?? 0) * .25 - hip * .35 * m + wob * .2 - Math.sign(jx) * handIce * .42)).multiply(_t2.setFromAxisAngle(X, lean * .55)));
    this.turn('Torso', _t1.setFromAxisAngle(Y, (twist * .6 + swing) * m).multiply(_t2.setFromAxisAngle(X, lean * .3)).multiply(_q.setFromAxisAngle(Z, -bank * .35 - Math.sign(jx) * handIce * .3)));
    this.turn('Chest', _t1.setFromAxisAngle(Y, (twist * .4 + swing * .6) * m).multiply(_t2.setFromAxisAngle(X, lean * .25)));
    // the head stays on the play: it turns back against the shoulders (and sells a deke the other way)
    this.turn('Neck', _t1.setFromAxisAngle(X, -lean * .8 + slump * .72 - lay * .75).multiply(_t2.setFromAxisAngle(Z, bank * .5)).multiply(_q.setFromAxisAngle(Y, -twist * .55 * m - deke * .4 * m)));
    this.root.updateMatrixWorld(true);
    const feet: [T.Vector3, T.Vector3] = [vec(0, 0, 0), vec(0, 0, 0)], yaw: [number, number] = [0, 0];
    const brace = (follow + load) * Math.min(1, size);
    [1, -1].forEach((side, i) => {
      const ph = phase + (i ? Math.PI : 0), push = Math.max(0, Math.sin(ph)), backS = Math.sin(ph);
      // Push out to the side and back, recover low and forward; the inside skate carries the turn.
      const wide = (.17 + .2 * push * amp) * side + brace * .07 * side + bank * .12 + (btw * .14 + hip * .1 + pin * .06 + stag * .08 + down * .14 + rch * .08 + vis * .08 + pDir * .1 + tight * .04) * side;
      const lift = .065 * amp * smooth(Math.max(0, -Math.sin(ph + .5)));
      feet[i].set(wide * (1 + (sty ? sty.wide * .18 : 0)), .023 + LIFT * .2 + lift, .08 - .28 * amp * backS);
      yaw[i] = side * (.1 + .32 * amp * push) + bank * .3;
      const ice = .023 + LIFT * .2;
      // the start: short, quick, V-shaped pushes on the toes, the skates turned well out, high off the ice coming back
      if (gBurst > 0) { feet[i].lerp(vec(side * (.21 + .12 * push), ice + .1 * smooth(Math.max(0, -Math.sin(ph + .5))), .02 - .2 * backS), gBurst); yaw[i] = lerp(yaw[i], side * (.6 + .2 * push), gBurst); }
      // crossovers: the outside skate lifted over in front of the inside one, the inside one pushing out under him
      if (gCross !== 0) {
        const c = Math.sign(gCross), cw2 = Math.abs(gCross), rec = smooth(Math.max(0, -Math.sin(ph + .3)));
        if (side === -c) feet[i].lerp(vec(side * .17 + c * .32 * rec, ice + .1 * rec, .1 + .12 * rec - .2 * push), cw2);
        else feet[i].lerp(vec(side * .16 - c * .3 * push, ice + .03 * rec, .1 - .1 * backS), cw2);
        feet[i].x -= c * .08 * cw2; yaw[i] = lerp(yaw[i], c * .35, cw2);
      }
      // the stop: both skates turned across, one out ahead of the other, the blades scraping the ice
      if (gStop > 0) { const front = side === -gSS; feet[i].lerp(vec((front ? -.02 : .06) * gSS, ice, front ? .46 : 0), gStop); yaw[i] = lerp(yaw[i], gSS * 1.45, gStop); }
      // backwards: C-cuts — each skate pushed out in an arc and pulled back in under him, toes in
      if (gBack > 0) { const c = Math.max(0, Math.sin(ph)), a2 = Math.max(.4, amp); feet[i].lerp(vec(side * (.19 + .14 * c * a2), ice + .04 * smooth(Math.max(0, -Math.sin(ph))), .06 + .14 * Math.cos(ph) * a2), gBack); yaw[i] = lerp(yaw[i], -side * .3 * c, gBack); }
      // a shuffle: wide, low side steps, the skates never crossing
      if (gShuf !== 0) { const sw = Math.abs(gShuf), sp2 = Math.sin(ph); feet[i].lerp(vec(side * (.25 + .07 * sp2), ice + .06 * Math.max(0, sp2), .06), sw); yaw[i] = lerp(yaw[i], side * .2, sw); }
      // a catch step: the skate on the side he is knocked to goes out that way, the other one braces
      if (jw > 0) { const lead = Math.sign(jx) === side; feet[i].x += jx * jw * (lead ? .26 : .06); feet[i].z += jz * jw * (lead ? .22 : -.06); feet[i].y += (lead ? .05 : 0) * jw * Math.sin(Math.PI * clamp01(stag)); }
      // the shot's follow-through: the back skate comes off the ice and trails (the weight all on the front one)
      const backSide = -m * (back ? -1 : 1);
      if (follow > 0 && side === backSide && kind !== 'pass' && kind !== 'tip') { const u = follow * Math.min(1, size) * (1 - gStop) * (1 - kneel); feet[i].y += .1 * u; feet[i].z -= .14 * u; feet[i].x -= side * .05 * u; }
      // on one knee: the left skate planted ahead, the right shin flat on the ice behind
      if (kneel > 0) feet[i].lerp(i ? vec(-.16, .1, -.62) : vec(.2, .023 + LIFT * .2, .38), kneel);
      if (walk > 0) { const wf = walkFoot(ph, side); feet[i].lerp(wf.foot, walk); yaw[i] = lerp(yaw[i], wf.yaw, walk); }
      // a kick of the puck: the right skate swung forward and across under the body, then back
      if (kick > 0 && i === 1) { feet[i].lerp(vec(-.02, .07, .48), kick); yaw[i] = lerp(yaw[i], .7, kick); }
      // board play: wide, low, the skates working the puck between them
      if (brd > 0) feet[i].x += side * .1 * brd;
      // riding the stick: the skates together, gliding
      if (cStick > 0) feet[i].lerp(vec(side * .14, .023 + LIFT * .2, i ? -.12 : .12), cStick);
      // a knee: the leg on the man's side swung out, the knee first, the skate off the ice
      if (fKnee > 0 && i === 1) { feet[i].lerp(vec(-.46, .3, .22), fKnee); yaw[i] = lerp(yaw[i], -.6, fKnee); }
      // laid out: the legs straight, a little apart, the skates trailing (toes down on the ice)
      if (lay > 0) { feet[i].lerp(vec(side * .2, .03, -.12), lay); yaw[i] = lerp(yaw[i], side * .15, lay); }
    });
    const knee = fKnee > 0 ? vec(-1, .1, .7) : vec(-.25, -.1, 1);
    this.legs(feet, [vec(.25, -.1, 1), knee], yaw);
    // Stick (right-shot frame): blade on the ice at the forehand side, ≈1 m ahead, 0.55 m right.
    let carry = vec(-.52 + .07 * Math.sin(phase) * amp + deke * .8, .0, .98), carryTop = vec(.1 + deke * .2, 1.02 - crouch, .3);
    // his own style of carrying it: a dangler far out in front and wide, the blade flat; a power forward in close with
    // the blade riding a little off the ice; a stay-at-home defenceman the long stick out in the lane
    if (sty && plain > 0) {
      const cw = plain * (1 - walk), c = sty.carry * cw, bl = Math.max(0, sty.blade) * cw * (1 - gBack);
      carry = vec(carry.x - .16 * Math.max(0, c), carry.y + .1 * bl, carry.z + .34 * c);
      carryTop = vec(carryTop.x, carryTop.y + .03 * bl, carryTop.z + .14 * c);
    }
    // walking: the stick carried low in front, the blade off the floor, swinging a little with the steps
    if (walk > 0) { carry = mixV(carry, vec(-.42, .16, .74 + .06 * Math.sin(phase)), walk); carryTop = mixV(carryTop, vec(.12, .98 - crouch, .24), walk); }
    // backwards (a defenceman's gap): the stick out in front along the ice in the top hand, taking away the lane
    if (gBack > 0) { carry = mixV(carry, vec(-.3, 0, 1.4), gBack * .8); carryTop = mixV(carryTop, vec(.06, .95 - crouch, .5), gBack * .8); }
    // a stop: the stick lifted a little off the ice to the side, out of the way of the skates
    if (gStop > 0) { carry = mixV(carry, vec(-.62, .12, .78), gStop * .7); carryTop = mixV(carryTop, vec(.14, 1.02 - crouch, .26), gStop * .7); }
    const reachW = opts.reach ? clamp01(opts.reachWeight ?? 0) : 0;
    if (reachW > 0 && opts.reach) {
      // The blade's middle goes onto the puck: heel a little behind and to the forehand side of it.
      const r = opts.reach, rx = r.x * m;
      const target = vec(Math.max(-1.05, Math.min(.6, rx - .04)), 0, Math.max(.35, Math.min(1.45, r.z - .1)));
      carry = mixV(carry, target, smooth(reachW));
      carryTop = mixV(carryTop, vec(.1 + target.x * .25, 1.02 - crouch, .22 + target.z * .1), smooth(reachW) * .6);
    }
    if (chk > 0) { carry = mixV(carry, vec(-.38, 0, .62), chk); carryTop = mixV(carryTop, vec(.05, .95 - crouch, .28), chk); }
    if (poke > 0) { carry = mixV(carry, vec(-.25, 0, 1.85), poke); carryTop = mixV(carryTop, vec(.05, .98 - crouch, .78), poke); }
    if (mv === 'toe') {
      // the toe turned over the puck: pulled back in to the skates, then dragged across to the backhand side
      const pull = smooth(mu / .55), across = smooth((mu - .45) / .45);
      carry = mixV(carry, vec(lerp(-.55, .38, across), 0, lerp(.95, .28, pull) + across * .15), Math.min(1, bell * 1.6));
      carryTop = mixV(carryTop, vec(.05, .95 - crouch, .3), toe);
    } else if (mv === 'between') {
      // forehand → between the skates (blade almost under him) → out on the backhand
      const x = mu < .5 ? lerp(-.55, 0, smooth(mu / .5)) : lerp(0, .45, smooth((mu - .5) / .5)), z = lerp(.95, .05, Math.sin(Math.PI * mu));
      carry = mixV(carry, vec(x, 0, z), Math.min(1, bell * 2));
      carryTop = mixV(carryTop, vec(.08, .8 - crouch, .12), btw);
    } else if (spin > 0) {
      // tucked in tight while he turns, the puck on the forehand close to the skates
      carry = mixV(carry, vec(-.5, 0, .5), spin); carryTop = mixV(carryTop, vec(.1, .95 - crouch, .22), spin);
    } else if (mv === 'shoulder' || hip > 0) {
      carry = mixV(carry, vec(-.45, 0, .5), Math.max(chk, hip)); carryTop = mixV(carryTop, vec(.1, .95 - crouch, .2), hip);
    } else if (pin > 0) {
      // up against the man on the boards: the stick held across in front, gloves at chest height
      carry = mixV(carry, vec(-.55, .7, .7), pin); carryTop = mixV(carryTop, vec(.45, 1.15 - crouch, .5), pin);
    } else if (lift > 0) {
      // the blade under his stick and up
      const up = smooth(mu / .5);
      carry = mixV(carry, vec(-.2, .05 + .4 * up, 1.35), lift); carryTop = mixV(carryTop, vec(.05, .82 - crouch, .55), lift);
    }
    if (shove > 0) {
      // a push check: the stick held across in both hands at the chest, shoved out into the man
      carry = mixV(carry, vec(-.95, .92 - crouch, .5 + .3 * shove), Math.min(1, shove * 1.5)); carryTop = mixV(carryTop, vec(.38, .98 - crouch, .38 + .3 * shove), Math.min(1, shove * 1.5));
    }
    if (blk > 0) {
      // down to block: the stick laid flat across in front, the shaft low
      carry = mixV(carry, vec(-.85, .02, .5), blk); carryTop = mixV(carryTop, vec(.38, .5, .42), blk);
    }
    if (ot > 0) {
      // a one-timer coming: the stick wound up high behind him (a slap shot's backswing), ready to swing through
      carry = mixV(carry, vec(-.72, 1.3, -.45), ot); carryTop = mixV(carryTop, vec(.12, 1.06 - crouch, .26), ot);
    }
    if (call > 0) {
      // «Пас!»: the blade tapping the ice
      const tap = Math.pow(Math.max(0, Math.sin(now * 13)), 2);
      carry = mixV(carry, vec(-.5, .16 * tap, .95), call); carryTop = mixV(carryTop, vec(.1, 1.05 - crouch, .32), call);
    }
    if (vis > 0) {
      // the defensive stance: the stick out in front on the ice, in the lane
      carry = mixV(carry, vec(-.3, 0, 1.38), vis); carryTop = mixV(carryTop, vec(.06, .98 - crouch, .52), vis);
    }
    if (hus > 0) {
      // a burst: the stick in close, swinging with the stride
      carry = mixV(carry, vec(-.45 + .12 * Math.sin(phase), .05, .75), hus * .7); carryTop = mixV(carryTop, vec(.14, 1.0 - crouch, .22), hus * .6);
    }
    if (prot > 0) {
      // protecting the puck: the stick out wide on the forehand side, the body (the lead shoulder) turned into the man;
      // knowing where the checker is: the puck at arm's length on the side away from him (forehand or backhand), in
      // front when he is right behind
      let pc = vec(-1.0, 0, .62), pt = vec(.06, .96 - crouch, .22);
      if (thr) {
        const side = tSgn > 0 ? vec(-1.15, 0, .58) : vec(.66, 0, .66), sideT = tSgn > 0 ? vec(-.12, .95 - crouch, .3) : vec(.02, .95 - crouch, .34);
        pc = mixV(vec(-.42, 0, 1.15), side, tLat); pt = mixV(vec(.06, .95 - crouch, .4), sideT, tLat);
      }
      carry = mixV(carry, pc, prot); carryTop = mixV(carryTop, pt, prot);
    }
    if (tight > 0) {
      // traffic: the stick in close and short, the puck in his feet
      carry = mixV(carry, vec(-.4, 0, .64), tight * .85); carryTop = mixV(carryTop, vec(.1, .97 - crouch, .2), tight * .7);
    }
    if (brd > 0) {
      // on the boards: the blade down in his skates, the shaft almost upright, his body over the puck
      carry = mixV(carry, vec(-.18, 0, .32), brd); carryTop = mixV(carryTop, vec(.1, .92 - crouch, .3), brd);
    }
    if (swp > 0) {
      // a stick sweep: the blade flat on the ice in a wide arc in front, side to side
      const sw = Math.sin(now * 8.5);
      carry = mixV(carry, vec(-.35 + .8 * sw, 0, 1.25 - .25 * Math.abs(sw)), swp); carryTop = mixV(carryTop, vec(.05 + .1 * sw, .9 - crouch, .45), swp);
    }
    if (kick > 0) { carry = mixV(carry, vec(-.6, .02, .7), kick * .7); }
    if (fgt > 0) {
      // the gloves are off: the stick dropped at his feet
      carry = mixV(carry, vec(-.9, 0, .1), fgt); carryTop = mixV(carryTop, vec(-.2, .03, 1.1), fgt);
    }
    if (cStick > 0) {
      // riding the stick like a horse: the shaft between the legs, the blade on the ice behind, the knob out in front
      carry = mixV(carry, vec(-.05, 0, -.75), cStick); carryTop = mixV(carryTop, vec(.0, .78 - crouch, .45), cStick);
    }
    if (cBow > 0) {
      // the bow and arrow: the stick held out level in front like a bow
      carry = mixV(carry, vec(.45, 1.35 - crouch, .75), cBow); carryTop = mixV(carryTop, vec(-.25, 1.3 - crouch, .55), cBow);
    }
    if (stag > 0) { carry = mixV(carry, vec(-.75, .35, .6), stag * .6); carryTop = mixV(carryTop, vec(.2, 1.15 - crouch, .25), stag * .5); }
    if (rch > 0) {
      // the stretch: the top hand shoots the stick out to the puck (or straight ahead), the blade flat on the ice
      const r = opts.reach;
      const target = r ? vec(Math.max(-1.2, Math.min(.7, r.x * m - .04)), 0, Math.max(1.1, Math.min(2.05, r.z - .05))) : vec(-.4, 0, 1.95);
      carry = mixV(carry, target, Math.min(1, rch * 1.3));
      carryTop = mixV(carryTop, vec(.02 + target.x * .2, .9 - crouch, .5 + target.z * .2), rch);
    }
    if (down > 0) {
      // on the ice: arms out to break the fall, the stick flung wide
      carry = mixV(carry, vec(-1.0, .5, .3), down); carryTop = mixV(carryTop, vec(.38, .95 - crouch, -.05), down);
    }
    if (fallReach > 0 && opts.reach) {
      // going down, the stick shot out one-handed at the puck (the top arm straight out, the blade flat on it)
      // (the puck's own height in his frame: tipped over, the ice ahead of him is up off his skates' plane)
      const r = opts.reach, target = vec(Math.max(-1.3, Math.min(.8, r.x * m - .04)), Math.max(-.2, Math.min(1.3, r.y)), Math.max(.6, Math.min(2.0, r.z - .05)));
      carry = mixV(carry, target, fallReach); carryTop = mixV(carryTop, vec(target.x * .3, .88 - crouch, .45 + target.z * .25), fallReach);
    }
    // the stick fouls (right-shot frame)
    if (fSlash > 0) {
      // raised over the shoulder, then chopped down across his stick / hands
      const chop = smooth(clamp01((mu - .35) / .18));
      carry = mixV(carry, mixV(vec(-.55, 1.45, .35), vec(-.25, .45, 1.25), chop), fSlash); carryTop = mixV(carryTop, vec(.1, 1.12 - crouch, .32 + .12 * chop), fSlash);
    }
    if (fHigh > 0) {
      // the blade up at face height out in front, swinging across
      carry = mixV(carry, vec(-.35 + .35 * Math.sin(mu * Math.PI * 2), 1.65, 1.15), fHigh); carryTop = mixV(carryTop, vec(.12, 1.12 - crouch, .38), fHigh);
    }
    if (fTrip > 0) {
      // swept low across in front, the blade into his skates
      carry = mixV(carry, vec(lerp(-1.05, .35, smooth(mu)), .03, .95), fTrip); carryTop = mixV(carryTop, vec(.1, .8 - crouch, .38), fTrip);
    }
    if (fHook > 0) {
      // the blade round his waist, pulled back in
      carry = mixV(carry, vec(-.25, .9, lerp(1.45, .85, smooth(clamp01((mu - .2) / .6)))), fHook); carryTop = mixV(carryTop, vec(.12, 1.02 - crouch, .3), fHook);
    }
    if (fCross > 0 || fBoard > 0) {
      // the shaft across in both hands, shoved out into him at chest height (into the boards from behind: harder, lower)
      const k = Math.max(fCross, fBoard), thrust = smooth(clamp01((mu - .1) / .25)), lo = fBoard > fCross ? .12 : 0;
      carry = mixV(carry, vec(-.95, 1.08 - crouch - lo, .45 + .5 * thrust), k); carryTop = mixV(carryTop, vec(.4, 1.1 - crouch - lo, .45 + .5 * thrust), k);
    }
    if (slump > 0) {
      // dejected: the blade dragged along the ice close in, the knob low
      carry = mixV(carry, vec(-.38, 0, .78), slump * .7); carryTop = mixV(carryTop, vec(.12, .86 - crouch, .22), slump * .7);
    }
    let heel = carry, top = carryTop;
    if (load > 0) {
      let wind: T.Vector3, windTop: T.Vector3;
      if (kind === 'slap') { wind = vec(-.65, 1.75, -.6); windTop = vec(.12, 1.0, .3); } // full backswing: blade high above and behind the shoulder
      else if (back) { wind = vec(.32, .04, carry.z - .5); windTop = vec(-.12, 1.0, .2); } // puck pulled to the backhand side
      else if (kind === 'pass') { wind = vec(carry.x - .08, .02, carry.z - .32); windTop = vec(carryTop.x, carryTop.y, carryTop.z - .05); }
      else if (kind === 'saucer') { wind = vec(carry.x - .12, .03, carry.z - .4); windTop = vec(carryTop.x + .04, carryTop.y - .04, carryTop.z - .08); } // the blade cupped under the puck
      else if (kind === 'tip') { wind = vec(carry.x + .05, .12, carry.z + .05); windTop = vec(carryTop.x, carryTop.y + .02, carryTop.z); }
      else {
        // With the puck on the blade the windup is a short drag behind it, blade low (wrist/snap); without, a full backswing.
        wind = mixV(vec(-.82, .3 + (kind === 'snap' ? .2 : 0), -.15), vec(carry.x - .12, .04, carry.z - .5), smooth(reachW));
        windTop = mixV(carryTop, vec(.12, 1.12, .02), 1 - .5 * smooth(reachW));
      }
      heel = mixV(carry, wind, load); top = mixV(carryTop, windTop, load);
    }
    if (follow > 0) {
      // Follow-through toward the target: high for shots, low and long for a pass (the blade points where the puck goes).
      const f: [T.Vector3, T.Vector3] = kind === 'slap' ? [vec(.05, 1.3, 1.15), vec(.42, 1.05, .55)]
        : back ? [vec(.8, 1.05, 1.0), vec(-.18, 1.0, .5)]
        : kind === 'pass' ? [vec(-.2, .1, 1.35), vec(.24, .95, .6)]
        : kind === 'saucer' ? [vec(-.22, .5, 1.3), vec(.26, 1.0, .58)] // the blade opens and lifts: the puck flips up and spins
        : kind === 'tip' ? [vec(-.35, .35, 1.3), vec(.15, 1.0, .5)]
        : kind === 'snap' ? [vec(-.15, .7, 1.3), vec(.32, .98, .6)]
        : [vec(-.08, 1.0, 1.25), vec(.36, .98, .6)];
      heel = mixV(heel, f[0], follow); top = mixV(top, f[1], follow);
    }
    if (cheer > 0) { heel = mixV(heel, vec(-.2, 2.25, .45), smooth(cheer)); top = mixV(top, vec(.2, 1.12, .3), smooth(cheer)); }
    if (lay > 0) {
      // the sweep: the top hand out past the head, the blade flat on the ice a stick's length ahead, swung in an arc
      // from the forehand side across to the backhand and back (about one and a half passes in the dive)
      const th = opts.pitch ?? 1.3 * down, up = opts.pitchLift ?? .1 * Math.sin(down * Math.PI / 2), c = Math.cos(th), sn = Math.sin(th);
      // (the hand by his helmet a little off the ice, over the ice: height hh, ahead hf — into the figure's frame)
      const hh = .2, hf = 1.6, hand = vec(-.08, c * (hh - up) + sn * hf, -sn * (hh - up) + c * hf);
      const reach = Math.sqrt(Math.max(.2, (this.stickLength * .97) ** 2 - hh * hh));
      const phi = .62 * Math.sin((mu - .12) * Math.PI * 2 * 1.25) - .1; // + = toward his forehand (right-shot frame)
      const bx = hand.x - reach * Math.sin(phi), bf = hf + reach * Math.cos(phi), bh = .01 - up;
      const blade = vec(bx, c * bh + sn * bf, -sn * bh + c * bf);
      heel = mixV(heel, blade, lay); top = mixV(top, hand, lay);
    }
    // the shaft loads as the blade digs in behind the puck (a slap shot most), springs back through the release
    const flexK = kind === 'slap' ? .1 : kind === 'snap' ? .075 : kind === 'wrist' ? .06 : kind === 'backhand' ? .04 : .02;
    this.flex = s < -.45 || s > .25 ? 0 : flexK * Math.sin(Math.PI * clamp01((s + .45) / .7));
    if (!noStick) this.grip(heel, top, vec(1, -.6, -.6), vec(-1, -.8, -.3));
    else {
      // no stick: the gloves at his sides, fists up when he cheers; a Cup at the chest (.5) and high overhead (1)
      const c = smooth(cheer), hold = smooth(clamp01(trophy * 2)), high = smooth(clamp01((trophy - .5) * 2));
      const side = (x: number) => mixV(mixV(vec(x * .3, .98 - crouch, .1), vec(x * .34, 2.02 - crouch, .16), c),
        mixV(vec(x * .18, 1.22 - crouch, .4), vec(x * .16, 2.06 - crouch, .1), high), hold);
      this.arms(side(1), side(-1), vec(1, -.5 + .4 * c, -.4), vec(-1, -.5 + .4 * c, -.4));
    }
    // the free right hand: out for a handshake, or a fist pumped after a goal (the stick stays in the other hand)
    const shake = smooth(clamp01(opts.shake ?? 0)), pump = smooth(clamp01(opts.pump ?? 0)), bump = smooth(clamp01(opts.bump ?? 0)), tt = opts.t ?? 0;
    if (fArm > 0) {
      // the free right arm: a forearm / elbow up into his head, an elbow out, a glove grabbing his jersey, punches
      const b = this.bones;
      const cur = this.root.worldToLocal(b.HandR.getWorldPosition(new T.Vector3()));
      const drive = smooth(clamp01(mu / .3));
      const hand = fHead === fArm ? vec(lerp(-.4, -.02, drive), lerp(1.25, 1.66, drive) - crouch, lerp(.1, .42, drive))
        : fElbow === fArm ? vec(-.08, 1.42 - crouch, .1 + .08 * drive)
        : fHold === fArm ? vec(-.12, 1.18 - crouch, lerp(.72, .5, smooth(clamp01((mu - .3) / .5))))
        : vec(-.06, 1.5 - crouch, .3 + .32 * Math.pow(Math.max(0, Math.sin(now * 9)), .7));
      const pole = fHead === fArm || fElbow === fArm ? vec(-1, .55, .35) : fHold === fArm ? vec(-1, -.6, -.2) : vec(-1, -.3, -.4);
      this.arm('R', this.world(cur.lerp(hand, fArm)), this.dirWorld(pole));
    } else if (cBow > 0 || cSky > 0 || cEar > 0) {
      // the free right hand: the bowstring drawn back to the cheek / a finger up at the sky / a glove cupped at the ear
      const b = this.bones, k = Math.max(cBow, cSky, cEar);
      const cur = this.root.worldToLocal(b.HandR.getWorldPosition(new T.Vector3()));
      const draw = smooth(clamp01((mu - .1) / .25)), tt2 = opts.now ?? 0;
      const hand = cBow === k ? vec(lerp(-.2, -.12, draw), 1.45 - crouch, lerp(.5, .05, draw))
        : cSky === k ? vec(-.22, 2.05 - crouch, .18)
        : vec(-.24 + .02 * Math.sin(tt2 * 5), 1.62 - crouch, .02);
      const pole = cSky === k ? vec(-1, .2, -.2) : vec(-1, -.4, -.5);
      this.arm('R', this.world(cur.lerp(hand, k)), this.dirWorld(pole));
    } else if (shake > 0 || pump > 0 || bump > 0) {
      const b = this.bones;
      const now = this.root.worldToLocal(b.HandR.getWorldPosition(new T.Vector3()));
      const top = Math.max(shake, pump, bump);
      // a fist bump along the bench (on his right): the glove out to the side, knuckles first, a little punch at each man
      const hand = bump === top
        ? vec(-.58 - .06 * Math.max(0, Math.sin(tt * 9)), 1.16 - crouch, .2 + .05 * Math.sin(tt * 9))
        : shake >= pump
          ? vec(-.12, 1.02 - crouch + .035 * Math.sin(tt * 13), .52)
          : vec(-.3, 1.42 - crouch + .36 * Math.pow(Math.max(0, Math.sin(tt * 6.5)), .6), .22);
      this.arm('R', this.world(now.lerp(hand, top)), this.dirWorld(bump === top ? vec(-.3, -1, -.5) : shake >= pump ? vec(-1, -.8, -.2) : vec(-1, -.2, -.6)));
    } else if (!noStick) {
      // one hand off the stick: at top speed the bottom hand lets go and swings with the strides for balance; skating
      // backwards it is held out to the side (the stick out front in the top hand)
      const freeW = Math.max(gOne, gBack * .6) * (1 - Math.max(load, follow)) * (1 - reachW) * (1 - lay) * (1 - chk) * (1 - poke);
      if (freeW > .01) {
        const sw = Math.sin(phase) * (.8 + .3 * (sty?.swing ?? 0));
        const tgt = gBack > gOne ? vec(-.4, .9 - crouch, .3) : vec(-.3, .98 - crouch + .05 * Math.abs(sw), .12 + .34 * sw);
        const sideA = m > 0 ? 'R' : 'L', cur = this.root.worldToLocal(this.bones['Hand' + sideA].getWorldPosition(new T.Vector3()));
        this.arm(sideA, this.world(cur.lerp(this.mir(tgt), freeW)), this.dirWorld(this.mir(vec(-1, -.5, -.3))));
      }
    }
    // (character space from here: L is the +x side) a glove down on the ice on the side a hard jolt throws him to; the
    // near arm barring the checker off while he shields the puck; going down for the puck, the bottom hand off the stick
    const freeArm = (sd: 'L' | 'R', tgt: T.Vector3, pole: T.Vector3, wgt: number) => {
      const cur = this.root.worldToLocal(this.bones['Hand' + sd].getWorldPosition(new T.Vector3()));
      this.arm(sd, this.world(cur.lerp(tgt, clamp01(wgt))), this.dirWorld(pole));
    };
    if (handIce > .01) { const sx = Math.sign(jx); freeArm(sx > 0 ? 'L' : 'R', vec(sx * .72, .06, .28 + jz * .2), vec(sx, .3, -.4), handIce); }
    else if (armBar > .01 && !noStick) { const sx = Math.sign(tSide) || 1; freeArm(sx > 0 ? 'L' : 'R', vec(sx * .5, 1.1 - crouch, .1 + .12 * Math.max(0, thr!.z / thrD)), vec(sx, .25, -.6), armBar); }
    else if (fallReach > .01 && !noStick) { const bot = m > 0 ? 'R' : 'L', sx = bot === 'L' ? 1 : -1; freeArm(bot, vec(sx * .55, .75 - crouch, .15), vec(sx, -.3, -.5), fallReach); }
  }

  /**
   * Goalie: stance → butterfly, shuffles and T-pushes, head on the puck, and real saves — glove, blocker
   * (the stick goes with it), butterfly with the pad stretched out toward a low puck, a poke check.
   * Solved for a goalie who catches with the left hand and mirrored for the other one.
   */
  goalie(pose: GoaliePose) {
    this.reset();
    this.props(true);
    const m = this.hand;
    const sv = pose.save ? vec(pose.save.x * m, pose.save.y, pose.save.z) : null, w = sv ? smooth(pose.saveWeight ?? 0) : 0;
    let drop = clamp01(pose.drop), glove = 0, blocker = 0, padL = 0, padR = 0;
    const hw = pose.hold ? smooth(clamp01(pose.holdW ?? 1)) : 0, gHold = pose.hold === 'glove' ? hw : 0, cHold = pose.hold === 'cover' ? hw : 0;
    // covering it: down in the butterfly, bent over the puck
    drop = Math.max(drop, cHold);
    if (sv && w > 0) {
      if (sv.y < .42) {
        drop = Math.max(drop, w); // along the ice: butterfly, the pad slides out toward a puck wide of him
        if (sv.x > .35) padL = w * smooth((sv.x - .35) / .45); else if (sv.x < -.35) padR = w * smooth((-sv.x - .35) / .45);
        if (sv.x > .2 && sv.y > .2) glove = w * .6;
      } else if (sv.x > -.12) { glove = w; if (sv.y < .95) drop = Math.max(drop, w * .75); }
      else { blocker = w; if (sv.y < .95) drop = Math.max(drop, w * .75); }
    }
    const d = smooth(drop), lat = Math.max(-1, Math.min(1, (pose.lateral ?? 0) * m));
    const tpush = smooth((Math.abs(lat) - .35) / .4) * (1 - d) * (1 - w), dirP = Math.sign(lat) || 1;
    const crouch = lerp(.2, .5, d) + tpush * .06 - (glove + blocker) * (1 - d) * .04;
    const slide = (padL - padR) * .14 + lat * .05;
    this.rig.position.set(slide, LIFT - crouch, -.08 * d);
    const lean = lerp(.4, .18, d) + tpush * .1 + cHold * .42 - gHold * .08;
    const reachX = sv ? Math.max(-1, Math.min(1, sv.x)) * w : 0; // leans into the save
    const look = Math.max(-.8, Math.min(.8, (pose.look ?? 0) * m));
    this.turn('Abdomen', _t1.setFromAxisAngle(Z, (-reachX * .32 - (padL - padR) * .1) * m).multiply(_t2.setFromAxisAngle(X, lean * .55)));
    this.turn('Torso', _t1.setFromAxisAngle(Y, look * .3 * m).multiply(_t2.setFromAxisAngle(X, lean * .3)));
    this.turn('Chest', _t1.setFromAxisAngle(Y, (look * .2 + reachX * .15) * m).multiply(_t2.setFromAxisAngle(X, lean * .2)));
    this.turn('Neck', _t1.setFromAxisAngle(X, -lean * .9).multiply(_t2.setFromAxisAngle(Y, look * .45 * m)));
    this.root.updateMatrixWorld(true);
    // Feet (glove-left frame): stance, butterfly, T-push (lead skate turned along the crease, the other one pushing), pad extension.
    const fy = lerp(.025 + LIFT * .2, .08, d), fx = lerp(.36, .62, d), fz = lerp(0, -.12, d);
    const feet: [T.Vector3, T.Vector3] = [vec(fx, fy, fz), vec(-fx, fy, fz)];
    const yaw: [number, number] = [lerp(.25, 1.1, d), -lerp(.25, 1.1, d)];
    if (tpush > 0) {
      const lead = dirP > 0 ? 0 : 1, trail = 1 - lead;
      feet[lead].lerp(vec(dirP * .5, fy + .02, .06), tpush); feet[trail].lerp(vec(-dirP * .62, fy, -.06), tpush);
      yaw[lead] = lerp(yaw[lead], dirP * 1.35, tpush); yaw[trail] = lerp(yaw[trail], -dirP * .15, tpush);
    }
    if (padL > 0) { feet[0].lerp(vec(1.08, .1, .06), padL); yaw[0] = lerp(yaw[0], 1.5, padL); }
    if (padR > 0) { feet[1].lerp(vec(-1.08, .1, .06), padR); yaw[1] = lerp(yaw[1], -1.5, padR); }
    // Butterfly: knees together on the ice in front (the stretched leg keeps its knee off the ice).
    const knees: [T.Vector3, T.Vector3] = [vec(.12 + padL * .3, .1 + padL * .05, .26 - padL * .08), vec(-.12 - padR * .3, .1 + padR * .05, .26 - padR * .08)];
    const poles: [T.Vector3, T.Vector3] = [vec(.4, padL * .8, 1), vec(-.4, padR * .8, 1)];
    if (m > 0) this.legs(feet, poles, yaw, knees, d * (1 - Math.max(padL, padR) * .5));
    else this.legs([this.mir(feet[1]), this.mir(feet[0])], [this.mir(poles[1]), this.mir(poles[0])], [-yaw[1], -yaw[0]], [this.mir(knees[1]), this.mir(knees[0])], d * (1 - Math.max(padL, padR) * .5));
    // Stick: blade on the ice in front of the five-hole; a poke goes at the puck; a blocker save takes it along.
    let heel = vec(-.04, 0, lerp(.62, .52, d)), top = vec(-.3, lerp(.95, .8, d), .3);
    const pokeW = pose.poke ? smooth(pose.pokeWeight ?? 0) * (1 - w) : 0;
    if (pokeW > 0 && pose.poke) {
      const px = Math.max(-.9, Math.min(.5, pose.poke.x * m)), pz = Math.max(.7, Math.min(1.7, pose.poke.z));
      heel = mixV(heel, vec(px, 0, pz), pokeW); top = mixV(top, vec(-.25 + px * .3, .75, .45 + pz * .2), pokeW);
    }
    if (blocker > 0 && sv) {
      const B = vec(Math.max(-1.05, Math.min(-.25, sv.x)), Math.max(.45, Math.min(1.5, sv.y)), Math.max(.2, Math.min(.65, sv.z)));
      // the blade stays low and slants out under the blocker
      heel = mixV(heel, vec(B.x - .3, Math.max(0, B.y - .88), B.z + .35), blocker);
      top = mixV(top, vec(B.x + .15, B.y + .2, B.z - .1), blocker);
    }
    if (padR > 0) heel = mixV(heel, vec(-.75, 0, .45), padR * .7); // the paddle covers the post on a low blocker-side puck
    const g = this.stick(this.mir(heel), this.mir(top), -1, -m);
    const stance = vec(.5, lerp(.9, .85, d) - crouch * .45 + .2 * d, .38);
    const gloveAt = sv ? vec(Math.max(.2, Math.min(1.15, sv.x)), Math.max(.25, Math.min(1.75, sv.y + .05)), Math.max(.15, Math.min(.65, sv.z + .1))) : stance;
    let gl = mixV(stance, gloveAt, glove);
    // the puck held: the glove closed up at his chest; covered: the glove flat on the ice in front, over the puck
    if (gHold > 0) gl = mixV(gl, vec(.26, 1.12 - crouch * .3, .3), gHold);
    if (cHold > 0) gl = mixV(gl, vec(.04, .07, .5), cHold);
    const left = this.mir(gl);
    const gp = this.mir(vec(1, -.8 + Math.max(glove, gHold) * .9, -.3)), bp = this.mir(vec(-1, -.8 + blocker * .7, -.3));
    if (m > 0) this.arms(left, g.top, gp, bp); else this.arms(g.top, left, bp, gp);
  }

  /** Where the goalie's catching glove is in the world (the frozen puck goes there). */
  gloveWorld(out = new T.Vector3()): T.Vector3 {
    return (this.hand > 0 ? this.bones.HandL : this.bones.HandR).getWorldPosition(out);
  }

  /**
   * On the bench or in the penalty box: seated (the root stands on the bench floor), leaning on the stick held
   * upright between the knees, head and shoulders turned toward the play. o.seat: height of the seat above the
   * floor; o.look: turn toward the play (rad, + to his left); o.up 0..1: standing up (a goal of his team).
   */
  sit(o: { seat?: number; look?: number; up?: number; /** standing at the boards: the right glove out over them (a fist bump) 0…1 */ reach?: number; t?: number } = {}) {
    this.reset();
    this.props(true);
    const seat = o.seat ?? .48, up = smooth(clamp01(o.up ?? 0)), look = Math.max(-1.1, Math.min(1.1, o.look ?? 0));
    const hip = this.restRig.get('UpperLegL')?.pos.y ?? .9;
    this.rig.position.set(0, lerp(seat + .1 - hip, LIFT, up), lerp(-.1, 0, up));
    const lean = lerp(.32, .12, up);
    this.turn('Abdomen', _t1.setFromAxisAngle(X, lean * .6));
    this.turn('Torso', _t1.setFromAxisAngle(Y, look * .3).multiply(_t2.setFromAxisAngle(X, lean * .3)));
    this.turn('Chest', _t1.setFromAxisAngle(Y, look * .25));
    this.turn('Neck', _t1.setFromAxisAngle(X, -lean * .8).multiply(_t2.setFromAxisAngle(Y, look * .45)));
    this.root.updateMatrixWorld(true);
    const fy = .025 + LIFT * .2, fz = lerp(.36, .04, up);
    this.legs([vec(.16, fy, fz), vec(-.16, fy, fz)], [vec(.2, lerp(.6, 0, up), 1), vec(-.2, lerp(.6, 0, up), 1)], [.12, -.12]);
    // the stick: blade on the floor out in front, the knob up by the chin, both gloves on the shaft
    const heel = mixV(vec(-.04, 0, 1.25), vec(-.3, 0, .62), up), top = mixV(vec(-.02, .74, .58), vec(-.2, 1.2, .3), up);
    this.grip(heel, top, vec(.9, -.5, -.1), vec(-.9, -.6, -.1));
    const reach = smooth(clamp01(o.reach ?? 0)) * up;
    if (reach > 0) {
      const now = this.root.worldToLocal(this.bones.HandR.getWorldPosition(new T.Vector3()));
      const tt = o.t ?? 0;
      this.arm('R', this.world(now.lerp(vec(-.16, 1.28 + .04 * Math.sin(tt * 8), .62 + .06 * Math.max(0, Math.sin(tt * 8))), reach)), this.dirWorld(vec(-1, -.6, -.2)));
    }
  }

  /**
   * An on-ice official: an easy upright stride (or standing, knees soft), the head on the play, and the arms
   * giving the signals of the IIHF rule book — the arm straight up (delayed call, whistle), tripping (a chop at
   * the leg below the knee), hooking (a tug toward the stomach), holding (one wrist clasped), slashing (a chop
   * across the forearm), interference (arms crossed), boarding (a fist into the palm), charging (fists rolling),
   * high-sticking (both fists stacked at the forehead), roughing (a fist out from the shoulder), icing (arms folded
   * high on the chest), a wash-out, a point (to the penalty box, at the net); at a faceoff bent over with the
   * puck held out, then the drop.
   */
  officiate(o: OfficialPose) {
    this.reset();
    const t = o.t, g = o.gesture, amp = clamp01(o.amp);
    const into = smooth(Math.min(1, t / .22)); // arms swing into a signal
    const ready = g === 'ready' ? smooth(Math.min(1, t / .4)) : g === 'drop' ? 1 - smooth((t - .25) / .3) : 0;
    const walk = smooth(clamp01(o.walk ?? 0));
    const crouch = (.06 + .05 * amp + ready * .14 + (g === 'trip' ? .08 * into : 0)) * (1 - walk) + walk * walkCrouch(o.phase);
    this.rig.position.set(.03 * Math.sin(o.phase) * lerp(amp, .7, walk), LIFT - crouch, 0);
    const lean = .1 + .12 * amp + ready * .45 + (g === 'trip' ? .3 * into : 0) + (g === 'goal' ? .08 : 0);
    const look = Math.max(-1.2, Math.min(1.2, o.look ?? 0));
    const swing = .06 * amp * Math.sin(o.phase);
    this.turn('Abdomen', _t1.setFromAxisAngle(X, lean * .5));
    this.turn('Torso', _t1.setFromAxisAngle(Y, swing + look * .15).multiply(_t2.setFromAxisAngle(X, lean * .3)));
    this.turn('Chest', _t1.setFromAxisAngle(Y, look * .2).multiply(_t2.setFromAxisAngle(X, lean * .2)));
    this.turn('Neck', _t1.setFromAxisAngle(X, -lean * .75).multiply(_t2.setFromAxisAngle(Y, look * .55)));
    this.root.updateMatrixWorld(true);
    const feet: [T.Vector3, T.Vector3] = [vec(0, 0, 0), vec(0, 0, 0)], yaw: [number, number] = [0, 0];
    [1, -1].forEach((side, i) => {
      const ph = o.phase + (i ? Math.PI : 0), push = Math.max(0, Math.sin(ph)), back = Math.sin(ph);
      feet[i].set((.16 + .16 * push * amp + ready * .1) * side, .023 + LIFT * .2 + .05 * amp * smooth(Math.max(0, -Math.sin(ph + .5))), .05 - .22 * amp * back);
      yaw[i] = side * (.12 + .25 * amp * push);
      if (walk > 0) { const wf = walkFoot(ph, side); feet[i].lerp(wf.foot, walk); yaw[i] = lerp(yaw[i], wf.yaw, walk); }
    });
    this.legs(feet, [vec(.25, -.1, 1), vec(-.25, -.1, 1)], yaw);
    // shoulders (character space) — the arms are solved onto targets around them
    const sh = this.restRig.get('UpperArmL')?.pos ?? vec(.17, 1.42, 0);
    const sy = sh.y - crouch - lean * .12, sx = Math.abs(sh.x), sz = lean * .32;
    // walking: the arms swing against the legs (the left arm forward with the right foot)
    const armWalk = (side: 1 | -1) => walk * .2 * Math.sin(o.phase + (side > 0 ? 0 : Math.PI));
    const rest = (side: 1 | -1) => vec(side * (sx + .1 - .04 * walk), sy - .5 + .04 * Math.sin(o.phase + (side > 0 ? Math.PI : 0)) * amp + .03 * walk * Math.abs(armWalk(side)) * 4, sz + .08 + .1 * side * swing + armWalk(side));
    let L = rest(1), R = rest(-1);
    const poleOut = (side: 1 | -1) => vec(side, -.7, -.5), poleDown = (side: 1 | -1) => vec(side * .8, -1, -.2);
    let PL = poleOut(1), PR = poleOut(-1);
    const chest = sy - .18, front = sz + .32;
    const osc = (f: number) => Math.sin(t * f);
    const pointAt = (target: T.Vector3 | null | undefined, down = 0) => {
      const s0 = vec(-sx, sy, sz);
      const d = target ? target.clone().sub(s0) : vec(-1, 0, 1);
      d.y = Math.max(-.5, Math.min(.35, d.y * .2)) - down;
      // the right arm points to his right and forward: a target behind him or across his body is pointed at as far
      // round as the shoulder goes (the arm never wraps behind the back or through the chest)
      const flat = Math.hypot(d.x, d.z) || 1; d.x /= flat; d.z /= flat;
      if (d.x > -.3) { d.x = -.3; d.z = Math.sign(d.z || 1) * Math.sqrt(1 - .09); }
      if (d.z < -.35) { d.z = -.35; d.x = -Math.sqrt(1 - .35 * .35); }
      d.normalize();
      return s0.addScaledVector(d, .62);
    };
    switch (g) {
      case 'armUp': R = vec(-sx + .04, sy + .62, sz + .05); PR = vec(-1, 0, -.2); break;
      case 'point': R = pointAt(o.aim); PR = vec(-.3, -1, 0); break;
      case 'goal': R = pointAt(o.aim, .25); PR = vec(-.3, -1, 0); L = vec(sx + .05, sy - .45, sz + .2); break;
      case 'trip': R = vec(-.12, .55 + .06 * osc(10), sz + .32); PR = poleDown(-1); break;
      case 'hook': { const k = (osc(7) + 1) / 2; L = vec(.12, chest - .12, front + .12 - .2 * k); R = vec(-.12, chest - .12, front + .12 - .2 * k); PL = poleDown(1); PR = poleDown(-1); break; }
      case 'hold': L = vec(.02, chest - .05, front + .02); R = vec(-.06, chest - .05, front + .05); PL = poleDown(1); PR = poleDown(-1); break;
      case 'slash': L = vec(.18, chest, front + .05); R = vec(-.02, chest + .07 + .16 * Math.abs(osc(6)), front + .1); PL = poleDown(1); PR = vec(-1, -.3, -.3); break;
      case 'interference': L = vec(-.16, chest + .02, front - .06); R = vec(.16, chest + .05, front - .04); PL = poleDown(1); PR = poleDown(-1); break;
      case 'boarding': L = vec(.04, chest, front + .02); R = vec(-.04, chest + .02, front + .12 - .1 * Math.abs(osc(6))); PL = poleDown(1); PR = poleDown(-1); break;
      case 'charging': { const a = t * 9, c = vec(0, chest, front + .02); L = c.clone().add(vec(.09 * Math.cos(a), .09 * Math.sin(a), 0)); R = c.clone().add(vec(-.09 * Math.cos(a), -.09 * Math.sin(a), 0)); PL = poleDown(1); PR = poleDown(-1); break; }
      case 'highstick': L = vec(.03, sy + .24, front - .04); R = vec(.03, sy + .1, front); PL = vec(1, -.4, -.2); PR = vec(-1, -.4, -.2); break;
      case 'fist': R = vec(-sx - .55, sy + .05, sz + .25); PR = vec(0, -1, -.3); break;
      case 'icing': L = vec(-.12, sy - .08, front - .1); R = vec(.12, sy - .1, front - .08); PL = poleDown(1); PR = poleDown(-1); break;
      case 'washout': { const k = osc(7); L = vec(sx + .25 + .3 * k, sy - .05, front); R = vec(-sx - .25 - .3 * k, sy - .05, front); PL = vec(.3, -1, -.3); PR = vec(-.3, -1, -.3); break; }
      // elbowing: the left hand taps the right elbow, held out at the side
      case 'elbow': { const k = Math.abs(osc(8)); R = vec(-sx - .12, chest + .02, front + .1); L = vec(-sx + .02 + .05 * k, chest - .04, front - .02); PL = poleDown(1); PR = vec(-.2, -1, .2); break; }
      // a check to the head: the open hand taps the side of the helmet
      case 'head': R = vec(-.2, sy + .3 + .03 * osc(9), sz + .02); PR = vec(-.3, .8, -.2); break;
      // checking from behind: both arms pushed out from the chest, palms forward
      case 'behind': { const k = (osc(6) + 1) / 2; L = vec(.14, sy - .02, front + .1 + .28 * k); R = vec(-.14, sy - .02, front + .1 + .28 * k); PL = vec(.1, 1, .1); PR = vec(-.1, 1, .1); break; }
      // kneeing: the hand slaps the knee
      case 'knee': R = vec(-.14, .62 + .06 * Math.abs(osc(8)), sz + .28); PR = poleDown(-1); break;
      // delay of game: the open hand across the chest, then straight out in front
      case 'delay': { const k = smooth(Math.min(1, Math.max(0, (t - .5) / .4))); R = vec(-sx + (sx * 1.6) * (1 - k), chest + .04 + .1 * k, front + .02 + .45 * k); PR = vec(0, 1, .1); break; }
      case 'shake': R = vec(-.1, chest - .14 + .035 * osc(13), front + .42); PR = poleDown(-1); break;
      case 'ready': case 'drop': {
        // holding the puck out over the dot; the windup brings it up and back a little, the throw snaps it down past the
        // puck's height and the arm swings back as he backs off
        const w = g === 'ready' ? smooth(clamp01(o.windup ?? 0)) : 0;
        const d = g === 'drop' ? smooth(Math.min(1, t / .12)) : 0, back = g === 'drop' ? smooth((t - .14) / .3) : 0;
        R = vec(-.06, sy - .3 + .26 * w - .34 * d + .1 * back, front + .3 - .1 * w + .06 * d - .25 * back); PR = poleDown(-1);
        if (g === 'drop' && t < .1) R.y += .26 * (1 - t / .1) * (1 - d);
        L = vec(.22, sy - .55 + .05 * w, sz + .25); break;
      }
      default: break;
    }
    // (the first signal of a fresh figure swings in from the side)
    if (!this.offArms && g !== 'none' && g !== 'ready' && g !== 'drop') { L = rest(1).lerp(L, into); R = rest(-1).lerp(R, into); }
    // From one signal to the next (the arm up → the infraction → the point to the box → down again) the hands and the
    // elbows travel from where they were — never a snap back to the side and up again, never an elbow flipping over —
    // and the hands swing a little out from the body on the way, not through it.
    const m = this.offArms;
    if (!m || m.g !== g || t < m.t0 - 1e-6) {
      // (the throw at a faceoff is quick on purpose: no blending into it)
      const from = m && !(m.g === 'ready' && g === 'drop') ? { L: m.L.clone(), R: m.R.clone(), PL: m.PL.clone(), PR: m.PR.clone() } : null;
      this.offArms = { g, t0: t, from, L: L.clone(), R: R.clone(), PL: PL.clone(), PR: PR.clone() };
    }
    const a = this.offArms!;
    if (a.from) {
      const k = smooth(clamp01((t - a.t0) / .32)), bulge = Math.sin(Math.PI * k) * .14;
      if (k >= 1) a.from = null;
      else {
        L = a.from.L.clone().lerp(L, k).add(vec(bulge, 0, bulge * .6)); R = a.from.R.clone().lerp(R, k).add(vec(-bulge, 0, bulge * .6));
        PL = a.from.PL.clone().lerp(PL, k).normalize(); PR = a.from.PR.clone().lerp(PR, k).normalize();
      }
    }
    a.L.copy(L); a.R.copy(R); a.PL.copy(PL); a.PR.copy(PR);
    this.arms(L, R, PL, PR);
  }
  private offArms: { g: string; t0: number; from: { L: T.Vector3; R: T.Vector3; PL: T.Vector3; PR: T.Vector3 } | null; L: T.Vector3; R: T.Vector3; PL: T.Vector3; PR: T.Vector3 } | null = null;

  private shadowCasters: T.Object3D[] | null = null;
  /** Off the ice the figure needs no shadow (the bench is outside the shadow map anyway): saves the shadow pass. */
  castShadows(on: boolean) {
    if (!this.shadowCasters) { this.shadowCasters = []; this.root.traverse(o => { if ((o as T.Mesh).isMesh && o.castShadow) this.shadowCasters!.push(o); }); }
    this.shadowCasters.forEach(o => { o.castShadow = on; });
  }

  dispose() {
    this.owned.geometries.forEach(g => g.dispose()); this.owned.materials.forEach(m => m.dispose()); this.owned.textures.forEach(t => t.dispose());
    this.root.removeFromParent();
  }
}
