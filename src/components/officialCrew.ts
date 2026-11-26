import type { RinkPlay } from '../game/rinkAI';
import type { LiveFrame } from '../game/rinkPlayback';
import { RINK } from '../game/rinkGeometry';

/**
 * The four on-ice officials of the KHL (IIHF four-official system): two referees (orange armbands) and two
 * linesmen, read from the very frames and plays both rinks show — so the 2D rink and the 3D picture put them
 * in the same places and they react to the same calls.
 *
 *  - Positioning: each referee covers one end. With the puck in a zone the referee of that end stands deep on the
 *    goal line by the boards (the "lead"), the other one trails the play near the blue line, diagonally across.
 *    The linesmen stay on the boards on their blue lines; when the puck goes deep in one zone the linesman of the
 *    other end moves up to the red line. Nobody stands in the way: an official steps away from skaters and the puck.
 *  - Faceoffs: a linesman drops the puck (a referee at centre ice): he skates to the dot, bends over holding the
 *    puck out, drops it and backs away.
 *  - Calls, with the signals of the IIHF rule book: a delayed penalty — the arm straight up until the whistle; the
 *    penalty itself — the signal of the infraction (tripping, hooking, holding, slashing, interference, boarding,
 *    charging, high-sticking, roughing), then a point to the penalty box while he skates over to the timekeepers;
 *    a goal — a point at the net; icing — the arms folded across the chest; an offside — the arm up, then a point
 *    to the faceoff; a frozen puck — the arm up for the whistle.
 *
 * World metres (origin at centre ice, x along the rink ±30, z across it ±15), headings in the 3D scene's
 * convention (0 = facing +x, angle = atan2(−dz, dx)). Pure (no three.js): the tests run it in Node.
 */
export type Gesture = 'none' | 'armUp' | 'point' | 'goal' | 'trip' | 'hook' | 'hold' | 'slash' | 'interference' | 'boarding' | 'charging'
  | 'highstick' | 'fist' | 'icing' | 'washout' | 'ready' | 'drop' | 'shake';
export type OfficialRole = 'ref' | 'line';
export type Official = {
  role: OfficialRole; x: number; z: number; vx: number; vz: number;
  /** body heading (scene convention) and the skating stride phase */
  heading: number; phase: number;
  gesture: Gesture; /** seconds (rink time) into the current gesture */ gt: number;
  /** where a pointing arm points (world metres) */
  aim: { x: number; z: number } | null;
};
type Step = { g: Gesture; dur: number; aim?: { x: number; z: number } };
type Inner = Official & {
  queue: Step[]; until: number; hold: boolean; holdAt: number; since: number;
  /** a place to skate to for a while (the timekeepers' desk after a penalty, out of a goal-mouth scramble …) */
  go: { x: number; z: number; until: number } | null;
};

const HL = RINK.length / 2, HW = RINK.width / 2;
/** Blue lines and goal lines: distance from centre ice. */
export const BLUE = HL - RINK.blueLine, GOAL = HL - RINK.goalLine;
/** The penalty boxes / timekeepers across the ice from the benches (world, see arenaBenches). */
const BOX_X: [number, number] = [-2.6, 2.6], BOX_Z = HW + .6;
const TIMEKEEPER = { x: 0, z: HW - 1.6 };

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const toW = (p: { x: number; y: number }) => ({ x: (p.x - 50) * RINK.length / 100, z: (p.y - 50) * RINK.width / 100 });

/** The signal of an infraction, from the penalty's wording (both rinks write it in Russian). */
export function penaltyGesture(text: string): Gesture {
  const t = text.toLowerCase();
  if (t.includes('подножк')) return 'trip';
  if (t.includes('задержка клюшкой') || t.includes('крюк')) return 'hook';
  if (t.includes('задержка руками') || t.includes('захват')) return 'hold';
  if (t.includes('удар клюшкой') || t.includes('рубящ')) return 'slash';
  if (t.includes('без шайбы') || t.includes('помеха')) return 'interference';
  if (t.includes('на борт')) return 'boarding';
  if (t.includes('разгон') || t.includes('атака')) return 'charging';
  if (t.includes('высок') || t.includes('высота')) return 'highstick';
  if (t.includes('задержка')) return 'hook';
  return 'fist';
}

/** Keeps a point on the ice, `m` metres off the boards (rounded corners included). */
export function insideRink(x: number, z: number, m: number) {
  const r = RINK.corner;
  x = clamp(x, -HL + m, HL - m); z = clamp(z, -HW + m, HW - m);
  const cx = HL - r, cz = HW - r;
  if (Math.abs(x) > cx && Math.abs(z) > cz) {
    const ox = Math.sign(x) * cx, oz = Math.sign(z) * cz, dx = x - ox, dz = z - oz, d = Math.hypot(dx, dz), lim = r - m;
    if (d > lim) { x = ox + dx / d * lim; z = oz + dz / d * lim; }
  }
  return { x, z };
}

export class OfficialCrew {
  /** referee of the +x end, referee of the −x end, linesman of the +x blue line, linesman of the −x blue line */
  readonly crew: Inner[];
  private lastTau = NaN;
  private dropper = -1;
  private wasStop = false;
  private dropped = false;
  private stoppedAt = NaN;

  constructor() {
    const mk = (role: OfficialRole, x: number, z: number): Inner => ({ role, x, z, vx: 0, vz: 0, heading: z > 0 ? Math.PI / 2 : -Math.PI / 2, phase: 0, gesture: 'none', gt: 0, aim: null,
      queue: [], until: 0, hold: false, holdAt: 0, since: 0, go: null });
    this.crew = [mk('ref', 12, -(HW - 2.6)), mk('ref', -12, HW - 2.6), mk('line', BLUE + .6, HW - 1.3), mk('line', -(BLUE + .6), -(HW - 1.3))];
  }

  get officials(): readonly Official[] { return this.crew; }

  /** Moves the crew to rink time `tau` (idempotent for the same tau; a jump back or far ahead snaps them in place). */
  update(f: LiveFrame, plays: readonly RinkPlay[], tau: number): readonly Official[] {
    // the same moment, or a hair earlier (the 2D rink samples the clock a frame behind the 3D picture): as is
    if (tau <= this.lastTau && this.lastTau - tau < 1) return this.crew;
    const fresh = Number.isNaN(this.lastTau) || tau < this.lastTau || tau - this.lastTau > 3;
    const from = fresh ? tau - 1e-6 : this.lastTau;
    const dt = fresh ? 0 : tau - this.lastTau;
    this.lastTau = tau;
    const puck = toW(f.puck);
    const skaters = f.skaters.filter(s => !s.box).map(s => ({ id: s.id, ...toW(s.pos) }));
    const posOf = (id?: string) => (id ? skaters.find(s => s.id === id) : undefined);
    const nearest = (role: OfficialRole, p: { x: number; z: number }) => {
      let best = -1, bd = Infinity;
      this.crew.forEach((o, i) => { if (o.role !== role) return; const d = Math.hypot(o.x - p.x, o.z - p.z); if (d < bd) { bd = d; best = i; } });
      return this.crew[best];
    };
    const signal = (o: Inner, steps: Step[]) => { o.hold = false; o.queue = steps.slice(1); this.begin(o, steps[0], tau); };

    // the calls since the last update
    if (!fresh) for (const p of plays) {
      if (p.tau <= from || p.tau > tau) continue;
      const at = posOf(p.player) ?? puck;
      if (p.kind === 'penalty' && p.text.startsWith('Отложенный')) {
        const o = nearest('ref', at); o.hold = true; o.holdAt = tau; o.queue = []; this.begin(o, { g: 'armUp', dur: 1e9 }, tau);
      } else if (p.kind === 'penalty') {
        const held = this.crew.find(o => o.hold && o.gesture === 'armUp');
        const o = held ?? nearest('ref', at), side = p.side ?? 0;
        const box = { x: BOX_X[side], z: BOX_Z };
        signal(o, [...(held ? [] : [{ g: 'armUp' as Gesture, dur: .9 }]), { g: penaltyGesture(p.text), dur: 2.4 }, { g: 'point', dur: 1.6, aim: box }]);
        o.go = { ...TIMEKEEPER, x: TIMEKEEPER.x + (o.x > 0 ? 2.4 : -2.4), until: tau + 6.5 };
      } else if (p.kind === 'goal') {
        const net = { x: Math.sign(puck.x || at.x || 1) * GOAL, z: 0 };
        const o = nearest('ref', net);
        signal(o, [{ g: 'goal', dur: 2.6, aim: net }]);
      } else if (p.kind === 'icing') {
        const o = nearest('line', puck);
        signal(o, [{ g: 'armUp', dur: .8 }, { g: 'icing', dur: 2.2 }]);
      } else if (p.kind === 'offside') {
        const o = nearest('line', at);
        signal(o, [{ g: 'armUp', dur: 1.1 }, { g: 'point', dur: 1.3, aim: { x: Math.sign(at.x || 1) * (HL - RINK.neutralDot), z: Math.sign(at.z || 1) * RINK.dotOffset } }]);
      } else if (p.kind === 'freeze' && !p.text.startsWith('Сирена')) {
        const o = nearest('ref', puck);
        if (!o.hold) signal(o, [{ g: 'armUp', dur: 1.1 }]);
      } else if (p.kind === 'faceoff' && this.dropper >= 0) {
        // (the drop itself is signalled as the puck leaves his hand, see below)
        if (!this.dropped) signal(this.crew[this.dropper], [{ g: 'drop', dur: .55 }]);
        this.dropper = -1;
      }
    }

    // the next faceoff: known from the whistle on, so the man who drops the puck skates there at once (signalling
    // on the way if he has a call to show) and is at the dot, set, before the players are
    const dot = f.stopped && f.official ? toW(f.official) : f.faceoff ? { x: puck.x + .9 * (puck.x > 0 ? -1 : 1), z: puck.z + 1.6 } : null;
    if (dot && (!this.wasStop || this.dropper < 0) && !this.dropped) {
      const centre = Math.abs(dot.x) < 3 && Math.abs(dot.z) < 3.5;
      this.dropper = this.crew.indexOf(nearest(centre ? 'ref' : 'line', dot));
    }
    // the drop: as the puck leaves his hand
    if (f.faceoff && this.dropper >= 0 && !this.dropped && f.puck.h < 1.06) {
      signal(this.crew[this.dropper], [{ g: 'drop', dur: .55 }]); this.dropped = true;
    }
    if (!f.stopped && this.wasStop) {
      // the puck is in play: he backs off (also when the drop went unannounced)
      if (this.dropper >= 0) { const o = this.crew[this.dropper]; if (o.gesture === 'ready') signal(o, [{ g: 'drop', dur: .4 }]); }
      this.dropper = -1; this.dropped = false;
    }
    this.wasStop = !!f.stopped;
    if (f.stopped && Number.isNaN(this.stoppedAt)) this.stoppedAt = tau;
    if (!f.stopped) this.stoppedAt = NaN;

    // positions
    const zone = Math.abs(puck.x) > BLUE ? Math.sign(puck.x) : 0;
    const targets = this.crew.map((o, i) => {
      if (o.go && tau < o.go.until) return { x: o.go.x, z: o.go.z };
      if (o.go) o.go = null;
      if (i === this.dropper && dot) return dot;
      const p = dot ?? puck;
      const pz = Math.sign(p.x) * Math.min(Math.abs(p.x), HL);
      if (i === 0) return { x: clamp(pz + 12.5, -9, GOAL - .6), z: -(HW - 2.4) };
      if (i === 1) return { x: clamp(pz - 12.5, -(GOAL - .6), 9), z: HW - 2.4 };
      const end = i === 2 ? 1 : -1;
      const deepOther = (dot ? (Math.abs(p.x) > BLUE ? Math.sign(p.x) : 0) : zone) === -end;
      return { x: deepOther ? end * 1.2 : end * (BLUE + .7), z: (i === 2 ? 1 : -1) * (HW - 1.3) };
    });
    this.crew.forEach((o, i) => {
      let { x: tx, z: tz } = targets[i];
      const dropping = i === this.dropper && !!dot;
      // step out of the way: skaters (not around the dot the dropper skates to) and the puck
      if (!dropping) {
        for (const s of skaters) {
          const dx = tx - s.x, dz = tz - s.z, d = Math.hypot(dx, dz);
          if (d < 2.2) { const k = (2.2 - d) / (d || 1); tx += dx * k; tz += dz * k; }
        }
        const dx = tx - puck.x, dz = tz - puck.z, d = Math.hypot(dx, dz);
        if (d < 3) { const k = (3 - d) / (d || 1); tx += dx * k; tz += dz * k; }
      }
      // referees never stand in the crease or behind the net
      if (Math.abs(tx) > GOAL - 3.5 && Math.abs(tz) < 3.2) tz = Math.sign(tz || (o.z || 1)) * 3.2;
      ({ x: tx, z: tz } = insideRink(tx, tz, o.role === 'line' ? .9 : 1.1));
      if (fresh) { o.x = tx; o.z = tz; o.vx = o.vz = 0; }
      else if (dt > 0) {
        const dx = tx - o.x, dz = tz - o.z, d = Math.hypot(dx, dz);
        const top = dropping ? (d > 6 ? 10.5 : 8) : 7.5, want = d > .05 ? Math.min(top, d * (dropping ? 2.2 : 1.4)) : 0;
        const k = 1 - Math.exp(-dt * (dropping ? 5 : 3.2));
        o.vx += ((d > 0 ? dx / d : 0) * want - o.vx) * k; o.vz += ((d > 0 ? dz / d : 0) * want - o.vz) * k;
        o.x += o.vx * dt; o.z += o.vz * dt;
        ({ x: o.x, z: o.z } = insideRink(o.x, o.z, .7));
        o.phase += Math.hypot(o.vx, o.vz) * dt / 3.1 * Math.PI * 2;
      }
      // facing: the play (the puck), the dot when dropping; along the way when skating fast far off
      const look = dropping ? puck : o.go ? { x: o.go.x, z: o.go.z } : puck;
      let head = Math.atan2(-(look.z - o.z), look.x - o.x);
      const v = Math.hypot(o.vx, o.vz);
      if (v > 5.5 && !dropping) head = Math.atan2(-o.vz, o.vx);
      if (o.gesture === 'point' && o.aim) head = Math.atan2(-(o.aim.z - o.z), o.aim.x - o.x) + .9;
      const turn = fresh ? 1 : 1 - Math.exp(-dt * 6);
      let dh = head - o.heading; while (dh > Math.PI) dh -= Math.PI * 2; while (dh < -Math.PI) dh += Math.PI * 2;
      o.heading += dh * turn;
      // gestures run out (a held arm comes down a while after the whistle when no call follows)
      if (o.hold && f.stopped && !Number.isNaN(this.stoppedAt) && tau - this.stoppedAt > 6) { o.hold = false; o.until = tau; }
      if (!o.hold && tau >= o.until && o.gesture !== 'none') {
        const next = o.queue.shift();
        if (next) this.begin(o, next, tau); else { o.gesture = 'none'; o.aim = null; }
      }
      // at the dot: upright until the players are set, then bent over with the puck held out
      if (dropping && f.faceoff && !this.dropped && o.gesture === 'none' && Math.hypot(o.x - tx, o.z - tz) < 1.2) this.begin(o, { g: 'ready', dur: 1e9 }, tau);
      if ((!dropping || !f.faceoff) && o.gesture === 'ready') { o.gesture = 'none'; }
      o.gt = tau - o.since;
    });
    return this.crew;
  }

  private begin(o: Inner, s: Step, tau: number) { o.gesture = s.g; o.since = tau; o.gt = 0; o.until = tau + s.dur; o.aim = s.aim ?? null; }
}

const crews = new WeakMap<object, OfficialCrew>();
/** One crew per rink: the 2D rink and the 3D picture read the same officials. */
export function crewFor(source: object): OfficialCrew {
  let c = crews.get(source);
  if (!c) { c = new OfficialCrew(); crews.set(source, c); }
  return c;
}
