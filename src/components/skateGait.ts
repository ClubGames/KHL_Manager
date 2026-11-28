/**
 * How a skater skates right now, read from his motion alone (so the watched match and the played one look the same):
 * an explosive start (short, quick V-strides on the toes, leaning far forward), crossovers through a turn, a hard
 * hockey stop (hips turned across, the skates digging in, snow off the blades), skating backwards (C-cuts), a lateral
 * shuffle, and at top speed one hand off the stick for balance. Pure — the 3D scene keeps one state per man and steps
 * it every picture; tests check it in Node.
 */

import { archetypeOf, starOf, type Archetype } from '../game/playStyle';

export interface Gait {
  /** 0…1 an explosive start */
  burst: number;
  /** 0…1 a hard stop; `stopSide` the way the hips (and the toes) turn: +1 to his left, −1 to his right */
  stop: number; stopSide: 1 | -1;
  /** 0…1 skating backwards */
  back: number;
  /** −1…1 a lateral shuffle (+ to his left) */
  shuffle: number;
  /** −1…1 crossovers through a turn (+ turning left) */
  cross: number;
  /** 0…1 the bottom hand off the stick (top speed, gliding straight) */
  oneHand: number;
}

export interface GaitState extends Gait {
  /** smoothed acceleration along the motion (m/s²) */
  acc: number;
  /** how long the stop is still held (s) */
  hold: number;
}

/**
 * A skater's own way of skating: stance width, how low he sits, how much the free arm swings, how far out in front
 * he carries the stick, the blade riding off the ice, the lean of the upper body (−1…1 each) — and the archetype it
 * comes from, with how strongly it shows (a star: all of it).
 */
export interface SkateStyle { wide: number; low: number; swing: number; stopSide: 1 | -1; carry: number; blade: number; lean: number; arch: Archetype; star: number }

export const NO_GAIT: Gait = { burst: 0, stop: 0, stopSide: 1, back: 0, shuffle: 0, cross: 0, oneHand: 0 };

/** What each archetype does to the way he skates (added to his own little quirks, scaled by how much of a star he is). */
const ARCH_STYLE: Record<Archetype, Partial<Record<'wide' | 'low' | 'swing' | 'carry' | 'blade' | 'lean', number>>> = {
  // long, low strides, the free arm driving, leaning into it
  speed: { low: 0.9, swing: 0.9, lean: 0.8, wide: -0.3 },
  // upright and wide-based, hard to knock off the puck, the blade riding a little off the ice
  power: { low: -0.6, wide: 0.9, swing: 0.4, blade: 0.6, carry: -0.4 },
  // the stick far out in front and low, the puck out wide on the blade, knees bent to move side to side
  dangler: { carry: 0.9, low: 0.4, blade: -0.5, wide: 0.2 },
  // the shot ready: the stick a little out, the head up, the weight on the balls of the feet
  sniper: { carry: 0.3, lean: 0.3, low: 0.2 },
  // the long stick out in the lanes, wide and solid
  stayHome: { carry: 0.6, wide: 0.6, low: 0.3, swing: -0.4 },
  // a forward on the blue line: lively strides, the arm swinging
  offD: { swing: 0.5, low: 0.3, lean: 0.3 },
  twoWay: {},
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const hash = (id: string) => { let h = 2166136261; for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
/**
 * Every man skates a little his own way (from his id: the same each time) — and, given the player, his archetype
 * on top of it, the more so the better he is (a star's style is plain to see).
 */
export function styleOf(id: string, p?: Parameters<typeof archetypeOf>[0]): SkateStyle {
  const h = hash(id), u = (k: number) => ((h >>> (k * 7)) & 127) / 127 * 2 - 1;
  const arch = archetypeOf(p), star = p ? starOf(p) : 0, a = ARCH_STYLE[arch], k = 0.35 + 0.65 * star;
  const mix = (q: number, key: keyof typeof a) => clamp(q * (1 - 0.7 * k * (a[key] !== undefined ? 1 : 0)) + (a[key] ?? 0) * k, -1, 1);
  return { wide: mix(u(0), 'wide'), low: mix(u(1), 'low'), swing: mix(u(2), 'swing'), stopSide: (h & 1) ? 1 : -1, carry: mix(u(3) * 0.4, 'carry'), blade: mix(0, 'blade'), lean: mix(0, 'lean'), arch, star };
}

export const newGait = (style?: SkateStyle): GaitState => ({ ...NO_GAIT, stopSide: style?.stopSide ?? 1, acc: 0, hold: 0 });

const s01 = (x: number) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const toward = (v: number, t: number, rate: number, dt: number) => v + (t - v) * (1 - Math.exp(-rate * dt));

export interface Kinematics {
  /** speed now and a moment ago (m/s) */
  speed: number; prevSpeed: number;
  /** the motion in his own frame: ahead (+) / behind (−), to his left (+) / right (−) (m/s) */
  fwd: number; lat: number;
  /** how fast the direction of motion turns (rad/s, + to the left) */
  turn: number;
  /** he has the puck (keeps both hands on the stick) */
  carrier: boolean;
  /** shooting, a move, a check, on the ice…: the plain skating is off */
  busy: boolean;
}

/** One step (dt s of match time) of a man's gait from his motion. */
export function stepGait(g: GaitState, k: Kinematics, dt: number): GaitState {
  if (dt <= 0) return g;
  const raw = (k.speed - k.prevSpeed) / 0.1;
  g.acc = toward(g.acc, clamp(raw, -20, 20), 7, dt);
  const sp = k.speed, busy = k.busy;
  // a hard stop: a big drop in speed going forward — held a moment (the blades dig in), over once he has stopped
  if (!busy && g.acc < -7 && sp > 3 && k.fwd > 0.5) g.hold = 0.3;
  else g.hold = Math.max(0, g.hold - dt);
  if (sp < 0.5) g.hold = 0;
  const stopT = g.hold > 0 ? 1 : 0;
  const backT = busy ? 0 : k.fwd < -0.9 && -k.fwd > Math.abs(k.lat) * 0.8 ? s01((-k.fwd - 0.9) / 1.2) : 0;
  const shufT = busy || sp > 4.5 ? 0 : Math.abs(k.lat) > 0.7 && Math.abs(k.lat) > Math.abs(k.fwd) * 1.3 ? Math.sign(k.lat) * s01((Math.abs(k.lat) - 0.7) / 1.0) : 0;
  const burstT = busy || stopT ? 0 : g.acc > 3.4 && k.fwd > 0.5 ? s01((g.acc - 3.4) / 2.5) * (1 - s01((sp - 4.5) / 1.5)) : 0;
  const crossT = busy || stopT || k.fwd <= 0 || g.acc < -2.5 ? 0 : Math.sign(k.turn) * s01((Math.abs(k.turn) - 0.45) / 0.8) * s01((sp - 3.2) / 1.5);
  const oneT = busy || k.carrier || stopT || k.fwd <= 0 ? 0 : s01((sp - 6.0) / 0.8) * (1 - s01((Math.abs(k.turn) - 0.25) / 0.3)) * (1 - s01((g.acc - 1) / 1.5));
  g.stop = toward(g.stop, stopT, stopT > g.stop ? 16 : 5, dt);
  g.back = toward(g.back, backT, 5, dt);
  g.shuffle = toward(g.shuffle, shufT, 6, dt);
  g.burst = toward(g.burst, burstT, burstT > g.burst ? 9 : 4, dt);
  g.cross = toward(g.cross, crossT, 6, dt);
  g.oneHand = toward(g.oneHand, oneT, 3, dt);
  return g;
}

/** Strides per metre against the plain stride: short quick ones in a start, steps in a shuffle, none in a stop. */
export function strideRate(g: Gait) {
  return (1 + 1.5 * g.burst + 0.6 * Math.abs(g.shuffle) + 0.35 * g.back + 0.25 * Math.abs(g.cross)) * (1 - 0.9 * g.stop);
}
