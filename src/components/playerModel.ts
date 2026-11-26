import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
// Base body: "Ultimate Modular Men" by Quaternius (CC0 1.0, https://quaternius.com) — hair removed,
// materials renamed (Jersey/Pants/Skate) and meshopt-compressed to ~150 KB. Inlined by the single-file build.
import modelUrl from '../assets/hockey-player.glb?url';
import { buildHelmet, kitUp } from './playerGear';
import type { ReleaseKind } from './replayMotion';
import type { LiveMove } from '../game/rinkPlayback';

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
};

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
const Y = new T.Vector3(0, 1, 0), X = new T.Vector3(1, 0, 0), Z = new T.Vector3(0, 0, 1);
const _t1 = new T.Quaternion(), _t2 = new T.Quaternion();
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
    if (ctx) {
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

  /** World position of the middle of the stick blade (after the pose of this frame). */
  bladeWorld(out: T.Vector3): T.Vector3 { return this.blade.getWorldPosition(out); }

  /** Places the stick (heel on/near the ice, shaft towards `top`) and returns the two grip points. */
  private stick(heel: T.Vector3, top: T.Vector3, toeSign = 1, xSign = toeSign) {
    const dir = top.clone().sub(heel).normalize(), L = this.stickLength;
    this.shaft.position.copy(heel).addScaledVector(dir, L / 2); this.shaft.quaternion.setFromUnitVectors(Y, dir); this.shaft.scale.set(1, L, 1);
    const flat = vec(dir.x, 0, dir.z); if (flat.lengthSq() < 1e-4) flat.set(0, 0, -1); flat.normalize();
    let toe = vec(-flat.z, 0, flat.x); if (toe.z * toeSign < 0 || (Math.abs(toe.z) < .05 && toe.x * xSign < 0)) toe.negate();
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
   * Everything is solved for a right shot and mirrored for a left one.
   */
  skate(phase: number, amp: number, shot?: number, cheer = 0, opts: { bank?: number; reach?: T.Vector3 | null; reachWeight?: number; kind?: ReleaseKind; deke?: number; check?: number; poke?: number; move?: LiveMove; moveT?: number; stagger?: number; down?: number } = {}) {
    this.reset();
    const m = this.hand, kind = opts.kind ?? 'wrist';
    const chk = smooth(clamp01(opts.check ?? 0)), poke = smooth(clamp01(opts.poke ?? 0));
    const bank = clamp01(Math.abs(opts.bank ?? 0) / .4) * .4 * Math.sign(opts.bank ?? 0) * (1 - cheer);
    const deke = (opts.deke ?? 0) * m; // in the right-shot frame
    // named moves: a bell over the move (in, hold, out) and its progress
    const mv = opts.move, mu = clamp01(opts.moveT ?? 0), bell = mv ? Math.sin(Math.PI * mu) : 0;
    const w = (k: LiveMove) => (mv === k ? bell : 0);
    const toe = w('toe'), btw = w('between'), spin = w('spin'), fake = w('fake'), hip = w('hip'), pin = w('pin'), lift = w('lift'), rch = w('reach');
    const stag = clamp01(opts.stagger ?? 0), wob = stag * Math.sin(stag * 18), down = smooth(clamp01(opts.down ?? 0));
    // Deeper knee bend on a hard stride, a little bob with every push.
    const crouch = lerp(.1 + .07 * amp + .012 * amp * Math.cos(phase * 2), .02, cheer) + Math.abs(bank) * .08 + Math.abs(deke) * .06 + chk * .1 + poke * .07
      + toe * .08 + btw * .16 + spin * .12 + hip * .14 - pin * .04 + lift * .05 - stag * .03 + rch * .14 + down * .22;
    this.rig.position.set(.035 * Math.sin(phase) * amp * (1 - cheer) + bank * .1 + (opts.deke ?? 0) * .12 + wob * .08 + hip * .12 * m, LIFT - crouch, 0);
    // Shot profile: load (stick back, shoulders closed), whip through the puck, follow through.
    const s = shot === undefined ? -9 : shot;
    // a shot fake: the windup comes up and is held, the puck stays on the blade
    const load = Math.max(s < -1 ? 0 : s < -.35 ? smooth((s + 1) / .65) : s < 0 ? 1 - smooth((s + .35) / .35) : 0, smooth(Math.min(1, fake * 1.4)));
    const follow = s < 0 ? 0 : s < .5 ? smooth(s / .5) : 1 - smooth((s - 1.1) / .8);
    const size = kind === 'pass' ? .55 : kind === 'tip' ? .3 : kind === 'slap' ? 1.25 : 1;
    const back = kind === 'backhand';
    // a body check turns the lead shoulder (the one away from the stick) into the man; a poke reaches with the top hand
    const twist = ((back ? .45 : -.55) * load + (back ? -.4 : .4) * follow) * size + deke * .5 + chk * .5 - poke * .3
      + toe * .3 + (mv === 'between' ? Math.sin(2 * Math.PI * mu) * .35 : 0) + hip * .9 + pin * .35 + wob * .3 - rch * .45;
    const lean = lerp(.2 + .14 * amp + .1 * load * size, -.05, cheer) + chk * .22 + poke * .28 + btw * .25 + spin * .2 + toe * .1 - pin * .05 + lift * .18 - stag * .35 + rch * .42 - down * .45;
    // Shoulders counter-rotate the stride a little (real skaters swing the upper body against the legs).
    const swing = .07 * amp * Math.sin(phase) * (1 - load) * (1 - follow) * (1 - cheer);
    this.turn('Abdomen', _t1.setFromAxisAngle(Z, -bank * .45 - (opts.deke ?? 0) * .25 - hip * .35 * m + wob * .2).multiply(_t2.setFromAxisAngle(X, lean * .55)));
    this.turn('Torso', _t1.setFromAxisAngle(Y, (twist * .6 + swing) * m).multiply(_t2.setFromAxisAngle(X, lean * .3)).multiply(_q.setFromAxisAngle(Z, -bank * .35)));
    this.turn('Chest', _t1.setFromAxisAngle(Y, (twist * .4 + swing * .6) * m).multiply(_t2.setFromAxisAngle(X, lean * .25)));
    // the head stays on the play: it turns back against the shoulders (and sells a deke the other way)
    this.turn('Neck', _t1.setFromAxisAngle(X, -lean * .8).multiply(_t2.setFromAxisAngle(Z, bank * .5)).multiply(_q.setFromAxisAngle(Y, -twist * .55 * m - deke * .4 * m)));
    this.root.updateMatrixWorld(true);
    const feet: [T.Vector3, T.Vector3] = [vec(0, 0, 0), vec(0, 0, 0)], yaw: [number, number] = [0, 0];
    const brace = (follow + load) * Math.min(1, size);
    [1, -1].forEach((side, i) => {
      const ph = phase + (i ? Math.PI : 0), push = Math.max(0, Math.sin(ph)), backS = Math.sin(ph);
      // Push out to the side and back, recover low and forward; the inside skate carries the turn.
      const wide = (.17 + .2 * push * amp) * side + brace * .07 * side + bank * .12 + (btw * .14 + hip * .1 + pin * .06 + stag * .08 + down * .14 + rch * .08) * side;
      const lift = .065 * amp * smooth(Math.max(0, -Math.sin(ph + .5)));
      feet[i].set(wide, .023 + LIFT * .2 + lift, .08 - .28 * amp * backS);
      yaw[i] = side * (.1 + .32 * amp * push) + bank * .3;
    });
    this.legs(feet, [vec(.25, -.1, 1), vec(-.25, -.1, 1)], yaw);
    // Stick (right-shot frame): blade on the ice at the forehand side, ≈1 m ahead, 0.55 m right.
    let carry = vec(-.52 + .07 * Math.sin(phase) * amp + deke * .8, .0, .98), carryTop = vec(.1 + deke * .2, 1.02 - crouch, .3);
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
    let heel = carry, top = carryTop;
    if (load > 0) {
      let wind: T.Vector3, windTop: T.Vector3;
      if (kind === 'slap') { wind = vec(-.65, 1.75, -.6); windTop = vec(.12, 1.0, .3); } // full backswing: blade high above and behind the shoulder
      else if (back) { wind = vec(.32, .04, carry.z - .5); windTop = vec(-.12, 1.0, .2); } // puck pulled to the backhand side
      else if (kind === 'pass') { wind = vec(carry.x - .08, .02, carry.z - .32); windTop = vec(carryTop.x, carryTop.y, carryTop.z - .05); }
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
        : kind === 'tip' ? [vec(-.35, .35, 1.3), vec(.15, 1.0, .5)]
        : kind === 'snap' ? [vec(-.15, .7, 1.3), vec(.32, .98, .6)]
        : [vec(-.08, 1.0, 1.25), vec(.36, .98, .6)];
      heel = mixV(heel, f[0], follow); top = mixV(top, f[1], follow);
    }
    if (cheer > 0) { heel = mixV(heel, vec(-.2, 2.25, .45), smooth(cheer)); top = mixV(top, vec(.2, 1.12, .3), smooth(cheer)); }
    this.grip(heel, top, vec(1, -.6, -.6), vec(-1, -.8, -.3));
  }

  /**
   * Goalie: stance → butterfly, shuffles and T-pushes, head on the puck, and real saves — glove, blocker
   * (the stick goes with it), butterfly with the pad stretched out toward a low puck, a poke check.
   * Solved for a goalie who catches with the left hand and mirrored for the other one.
   */
  goalie(pose: GoaliePose) {
    this.reset();
    const m = this.hand;
    const sv = pose.save ? vec(pose.save.x * m, pose.save.y, pose.save.z) : null, w = sv ? smooth(pose.saveWeight ?? 0) : 0;
    let drop = clamp01(pose.drop), glove = 0, blocker = 0, padL = 0, padR = 0;
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
    const lean = lerp(.4, .18, d) + tpush * .1;
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
    const left = this.mir(mixV(stance, gloveAt, glove));
    const gp = this.mir(vec(1, -.8 + glove * .9, -.3)), bp = this.mir(vec(-1, -.8 + blocker * .7, -.3));
    if (m > 0) this.arms(left, g.top, gp, bp); else this.arms(g.top, left, bp, gp);
  }

  dispose() {
    this.owned.geometries.forEach(g => g.dispose()); this.owned.materials.forEach(m => m.dispose()); this.owned.textures.forEach(t => t.dispose());
    this.root.removeFromParent();
  }
}
