import * as T from 'three';
import { Parts } from './benchParts';

/**
 * A coach behind the bench who is alive: a little low-poly man in a suit made of a few jointed pieces (legs, the
 * body, the head, the upper and lower arms, the line card) posed every frame — no skinning, nine small meshes.
 *
 * He follows the play with his eyes and turns his shoulders with it, shifts his weight, breathes; now and then he
 * points at the ice, explains something to the bench with his hand, looks down the bench, puts his hands on his
 * hips. A goal for his team: arms up and clapping; against: hands on the hips or on the head, the head down. At a
 * whistle he leans over to his players; in a timeout the head coach bends over the line card, drawing on it, the
 * assistants beside him. Walking (the entrance) the legs step and the arms swing.
 *
 * Coach-local space: feet at the origin (on the bench floor, `floor` above it), facing +z (the ice), metres.
 */

export type CoachPose = 'cross' | 'clip' | 'hands' | 'point';
export type CoachMood = 'play' | 'stop' | 'goalFor' | 'goalAgainst' | 'timeout';
export type CoachLook = {
  /** real seconds (drives the idle life) */ t: number;
  /** real seconds since the last update */ dt: number;
  /** the puck in coach-local coordinates (x right, z toward the ice) */ puck: { x: number; z: number };
  mood: CoachMood;
  /** seconds since the mood began (a goal, the whistle, the timeout) */ moodT: number;
  /** 0 … 1: how dangerous the play is (he leans in) */ excite: number;
  /** walking: the step phase (radians) and 0 … 1 how much he walks */ walk?: { phase: number; w: number };
  /** the head coach (in a timeout he holds the card) */ head?: boolean;
};

type V3 = T.Vector3;
const v = (x: number, y: number, z: number) => new T.Vector3(x, y, z);
const LU = .29, LF = .27, HIP = .95, SHOULDER = .66, NECK = .78;
const DOWN = v(0, -1, 0);

/** Gestures he makes now and then in play (and how long they take). */
type Gesture = 'none' | 'point' | 'talk' | 'hips' | 'bench' | 'chin';
const GESTURE_LEN: Record<Gesture, [number, number]> = { none: [3, 7], point: [1.2, 2.2], talk: [1.8, 3.2], hips: [2.5, 5], bench: [1.2, 2.2], chin: [2, 4] };

export class CoachRig {
  readonly root: T.Group;
  private body = new T.Group();
  private head = new T.Group();
  private legs = [new T.Group(), new T.Group()];
  private upper = [new T.Group(), new T.Group()];
  private fore = [new T.Group(), new T.Group()];
  private card: T.Group | null = null;
  private hands = [v(0, 0, 0), v(0, 0, 0)];
  private elbowOut = [1, 1];
  private lean = 0; private twist = 0; private nod = 0; private turn = 0; private sway = 0;
  private gesture: Gesture = 'none'; private gestureEnd = 0; private seed: number;
  private ready = false;

  constructor(root: T.Group, private floor: number, readonly pose: CoachPose, o: { suit: string; tie: string; skin: string; hair: string },
    build: (p: Parts, parent: T.Object3D) => void, seed: number) {
    this.root = root;
    this.seed = seed;
    const { suit, skin } = o;
    const add = (node: T.Object3D, parent: T.Object3D, draw: (p: Parts) => void) => { const p = new Parts(); draw(p); parent.add(node); build(p, node); };
    // legs: from the hip down, a shoe at the bottom
    this.legs.forEach((g, i) => {
      const s = i ? 1 : -1;
      g.position.set(s * .1, floor + HIP, 0);
      add(g, root, p => { p.limb(suit, .072, [0, 0, 0], [s * .005, -HIP + .08, 0], .068); p.box('#0e1013', .11, .07, .27, [s * .005, -HIP + .035, .04]); });
    });
    // the body from the hips: trousers' top, the jacket, shirt and tie, shoulders, the neck
    this.body.position.set(0, floor + HIP, 0);
    add(this.body, root, p => {
      p.box(suit, .37, .2, .23, [0, .04, 0]);
      p.cyl(suit, .215, .18, .62, [0, .43, 0], [0, 0, 0], [1, 1, .64], 10);
      p.box('#eef1f4', .11, .22, .02, [0, .6, .128]);
      p.box(o.tie, .045, .3, .016, [0, .51, .138]);
      for (const s of [-1, 1]) p.ball(suit, .1, [s * .2, .67, 0], [1, .85, 1]);
      p.cyl(skin, .048, .055, .1, [0, .76, 0]);
    });
    this.head.position.set(0, NECK, 0);
    add(this.head, this.body, p => {
      p.ball(skin, .108, [0, .1, .005], [1, 1.12, 1.05]);
      p.box(skin, .035, .05, .04, [0, .08, .115]);
      p.ball(o.hair, .113, [0, .145, -.025], [1.02, .78, 1.02]);
    });
    // the arms: an upper and a lower piece each, hanging along local −y (turned toward the elbow / the hand)
    for (let i = 0; i < 2; i++) {
      add(this.upper[i], root, p => p.limb(suit, .056, [0, 0, 0], [0, -LU, 0], .05));
      add(this.fore[i], root, p => { p.limb(suit, .05, [0, 0, 0], [0, -LF, 0], .045); p.ball(skin, .045, [0, -LF - .02, 0]); });
    }
    if (pose === 'clip') {
      this.card = new T.Group();
      add(this.card, root, p => { p.box('#6b4e2e', .25, .34, .015, [0, 0, 0]); p.box('#f4f6f8', .21, .27, .004, [0, .005, .008]); });
    }
    this.rest();
  }

  /** Stands as built (the replays share the arena and expect a quiet coach). */
  rest() {
    this.lean = this.twist = this.nod = this.turn = this.sway = 0; this.ready = false;
    const base = this.base(0);
    this.hands[0].copy(base[0]); this.hands[1].copy(base[1]);
    this.place({ t: 0, dt: 0, puck: { x: 0, z: 10 }, mood: 'play', moodT: 99, excite: 0 }, base);
  }

  /** His own resting hands (left, right) for his pose. */
  private base(t: number): [V3, V3] {
    const br = Math.sin(t * 1.3 + this.seed) * .006;
    switch (this.pose) {
      case 'cross': return [v(.12, 1.33 + br, .17), v(-.12, 1.3 + br, .18)];
      case 'clip': return [v(-.15, 1.22 + br, .3), v(.24, 1.1, .08)];
      case 'point': return [v(-.16, 1.06, -.15), v(.16, 1.06, -.15)];
      default: return [v(-.14, 1.08, -.16), v(.14, 1.08, -.16)];
    }
  }

  update(c: CoachLook) {
    const k = this.ready ? 1 - Math.exp(-Math.max(0, c.dt) * 7) : 1;
    this.ready = true;
    const t = c.t;
    // where the play is: the head follows it, the shoulders a little
    const look = Math.atan2(c.puck.x, Math.max(.3, c.puck.z));
    let hands = this.base(t), lean = c.excite * .1, twist = clamp(look * .3, -.35, .35), turn = clamp(look - twist, -1, 1), nod = .12;
    const elbow = [1, 1];
    if (c.walk && c.walk.w > .01) {
      // walking: arms swing against the legs (the card held as it is)
      const sw = Math.sin(c.walk.phase) * c.walk.w;
      if (this.pose !== 'clip') hands[0] = v(-.24, .98, .02 + .2 * sw);
      hands[1] = v(.24, .98, .02 - .2 * sw);
      lean = .05; twist = 0; turn = 0; nod = .05;
    } else if (c.mood === 'goalFor' && c.moodT < 6) {
      const u = c.moodT;
      if (u < 2.2 && (c.head || this.seed % 2 < 1)) {
        // a fist pump: the right arm up, twice
        const up = Math.abs(Math.sin(u * 3.2));
        hands[1] = v(.3, 1.6 + .5 * up, .2);
        if (this.pose !== 'clip') hands[0] = v(-.22, 1.25, .25);
      } else {
        // clapping
        const cl = Math.abs(Math.sin(u * 7 + this.seed));
        hands = [v(-.04 - .1 * cl, 1.36, .32), v(.04 + .1 * cl, 1.36, .32)];
        if (this.pose === 'clip') hands[0] = v(-.15, 1.22, .3);
      }
      lean = -.04; nod = -.1; turn *= .3;
    } else if (c.mood === 'goalAgainst' && c.moodT < 6) {
      // hands on the hips (or one on the back of the head), the head down, then a look at the bench
      if (c.head || this.pose === 'point') { hands = [v(-.27, 1.0, .02), v(.27, 1.0, .02)]; elbow[0] = elbow[1] = 1.6; }
      else { hands[1] = v(.08, 1.92, -.06); elbow[1] = 1.4; }
      nod = c.moodT < 2.5 ? .45 : .2; turn = c.moodT < 2.5 ? 0 : -.6 * Math.sin(this.seed); twist *= .2; lean = .06;
    } else if (c.mood === 'timeout') {
      if (c.head) {
        // bent over the card, the players around him: draws on it, points, looks up at them
        const draw = Math.sin(t * 2.3) * .05, up = Math.sin(t * .7 + this.seed) > .6;
        hands = [v(-.06, 1.12, .42), v(.04 + draw, 1.14 + Math.abs(Math.sin(t * 4)) * .02, .44 + draw * .4)];
        lean = .42; nod = up ? -.05 : .55; turn = up ? Math.sin(t * .5) * .5 : 0; twist = 0;
        if (this.pose !== 'clip') hands[0] = v(-.14, 1.16, .4);
      } else {
        // the assistants lean in and listen; one adds a word with his hand
        lean = .3; nod = .35; turn = (this.seed % 2 < 1 ? 1 : -1) * .5; twist = 0;
        if (this.pose === 'point') { const g = Math.sin(t * 3 + this.seed) * .06; hands[1] = v(.18 + g, 1.3, .38); }
      }
    } else if (c.mood === 'stop') {
      // the whistle: a word for the players in front of him (he leans over the bench, a hand explains)
      lean = .22; nod = .38; turn = clamp(look * .3, -.4, .4);
      const g = Math.sin(t * 3.4 + this.seed);
      if (c.moodT > .6 && c.moodT < 4.5 && (c.head || this.pose === 'point')) hands[1] = v(.16 + g * .07, 1.28 + g * .03, .36);
    } else {
      // play: gestures now and then
      if (t >= this.gestureEnd) {
        const r = frac(Math.sin((t + this.seed) * 12.9898) * 43758.5453);
        const pool: Gesture[] = ['none', 'none', 'point', 'talk', 'hips', 'bench', 'chin'];
        this.gesture = this.gesture !== 'none' ? 'none' : pool[Math.floor(r * pool.length)];
        const [a, b] = GESTURE_LEN[this.gesture];
        this.gestureEnd = t + a + (b - a) * frac(r * 7.13);
      }
      const g = this.gesture;
      if (g === 'point') {
        // at the play: the right arm out toward the puck
        const d = Math.hypot(c.puck.x, c.puck.z) || 1;
        hands[1] = v(.22 + c.puck.x / d * .5, 1.5, Math.max(.15, c.puck.z / d * .5));
        twist = clamp(look * .45, -.45, .45);
      } else if (g === 'talk') {
        const w = Math.sin(t * 3.1 + this.seed), w2 = Math.sin(t * 1.7);
        hands[1] = v(.16 + .06 * w, 1.3 + .04 * w2, .34);
        if (this.pose !== 'clip' && this.pose !== 'cross') hands[0] = v(-.14 - .04 * w2, 1.25, .3);
        nod = .25; turn = (this.seed % 2 < 1 ? 1 : -1) * .7;
      } else if (g === 'hips' && this.pose !== 'clip') { hands = [v(-.27, 1.0, .02), v(.27, 1.0, .02)]; elbow[0] = elbow[1] = 1.6; }
      else if (g === 'bench') { turn = (this.seed % 2 < 1 ? 1 : -1) * 1.0; nod = .3; lean = .12; }
      else if (g === 'chin') { hands[1] = v(.03, 1.74, .1); elbow[1] = .6; if (this.pose === 'cross') hands[0] = v(.1, 1.36, .15); }
    }
    for (let i = 0; i < 2; i++) { this.hands[i].lerp(hands[i], k); this.elbowOut[i] += (elbow[i] - this.elbowOut[i]) * k; }
    this.lean += (lean - this.lean) * k * .6; this.twist += (twist - this.twist) * k * .5;
    this.nod += (nod - this.nod) * k * .6; this.turn += (turn - this.turn) * k * .45;
    this.sway = Math.sin(t * .37 + this.seed) * .018;
    this.place(c, this.hands);
  }

  private place(c: CoachLook, hands: V3[] | [V3, V3]) {
    const walk = c.walk && c.walk.w > .01 ? c.walk : null;
    const breath = Math.sin(c.t * 1.3 + this.seed) * .008;
    this.body.position.set(this.sway, this.floor + HIP + (walk ? Math.abs(Math.cos(walk.phase)) * .03 * walk.w : 0), 0);
    this.body.rotation.set(this.lean + breath, this.twist, -this.sway * .6, 'YXZ');
    this.head.rotation.set(this.nod - this.lean * .6, this.turn, 0, 'YXZ');
    this.legs.forEach((g, i) => {
      const sw = walk ? Math.sin(walk.phase + (i ? Math.PI : 0)) * .42 * walk.w : 0;
      g.position.x = (i ? .1 : -.1) + this.sway; g.rotation.set(-sw, 0, (i ? 1 : -1) * this.sway * .3);
      g.updateMatrix();
    });
    this.body.updateMatrix(); this.head.updateMatrix();
    for (let i = 0; i < 2; i++) {
      const s = i ? 1 : -1;
      // shoulder through the body's pose; the hand as the pose wants it; the elbow out, a little back and down
      const S = v(s * .22, SHOULDER, 0).applyMatrix4(this.body.matrix);
      const H = hands[i].clone(); H.y += this.floor;
      // the hands go with the body when he leans (the pose is relative to his chest)
      const rel = H.clone().sub(v(0, this.floor + HIP, 0)).applyEuler(new T.Euler(this.lean * .8, this.twist, 0, 'YXZ')).add(v(this.sway, this.floor + HIP, 0));
      const E = elbowOf(S, rel, v(s * this.elbowOut[i], -.35, -.45));
      this.upper[i].position.copy(S); this.upper[i].quaternion.setFromUnitVectors(DOWN, E.clone().sub(S).normalize());
      const hand = rel.clone().sub(E); const hl = hand.length();
      this.fore[i].position.copy(E); this.fore[i].quaternion.setFromUnitVectors(DOWN, hl > 1e-4 ? hand.normalize() : DOWN);
      this.upper[i].updateMatrix(); this.fore[i].updateMatrix();
      if (i === 0 && this.card) {
        // the card in his left hand, tipped toward his face
        this.card.position.copy(rel).add(v(.08, .03, .03));
        this.card.rotation.set(-1.05 + this.lean, this.twist, 0, 'YXZ');
        this.card.updateMatrix();
      }
    }
  }
}

/** Two-bone IK: the elbow for a shoulder S, a hand H and a hint which way the elbow points. */
function elbowOf(S: V3, H: V3, hint: V3): V3 {
  const d = H.clone().sub(S); let len = d.length();
  if (len < 1e-4) return S.clone().add(v(0, -LU, 0));
  const n = d.multiplyScalar(1 / len);
  len = Math.min(len, LU + LF - 1e-3);
  if (len < Math.abs(LU - LF) + 1e-3) len = Math.abs(LU - LF) + 1e-3;
  H.copy(S).addScaledVector(n, len);
  const a = (LU * LU - LF * LF + len * len) / (2 * len), h = Math.sqrt(Math.max(0, LU * LU - a * a));
  const p = hint.clone().addScaledVector(n, -hint.dot(n));
  if (p.lengthSq() < 1e-6) p.set(0, 0, -1);
  p.normalize();
  return S.clone().addScaledVector(n, a).addScaledVector(p, h);
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const frac = (x: number) => x - Math.floor(x);
