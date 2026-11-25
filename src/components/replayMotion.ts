import { attackDir, clamp, samplePath, sampleSmooth, type ReplayClip, type Track } from '../game/rinkPlayback';
import { RINK } from '../game/rinkGeometry';
import { toWorld } from './replayCameras';

/**
 * What the skaters and goalies of a 3D goal replay do, worked out once per clip from the tracks and the puck:
 * who carries the puck when (touches), every release (passes and shots, with a windup and a follow-through
 * aimed at where the puck goes), every puck the goalies have to react to (saves), and stickhandling dekes.
 * Pure functions (no three.js): ReplayScene turns them into poses, the tests check them in Node.
 */
export type Touch = { id: string; t0: number; t1: number };
export type ReleaseKind = 'wrist' | 'snap' | 'slap' | 'backhand' | 'tip' | 'pass';
/** t: puck leaves the blade (clip time 0..1); windup/follow in seconds; (tx, tz): world point the puck goes to. */
export type Release = { id: string; t: number; kind: ReleaseKind; windup: number; follow: number; tx: number; tz: number; goal?: boolean };
/** A puck reaching a goalie: clip time and the world point where it passes him. */
export type Save = { t: number; x: number; y: number; z: number };
export type MotionPlan = { touches: Touch[]; releases: Release[]; saves: Map<string, Save[]> };

/** World x of the goal lines (the nets stand on them). */
export const NET_X = RINK.length / 2 - RINK.goalLine;
const WINDUP: Record<ReleaseKind, number> = { wrist: .32, snap: .2, slap: .55, backhand: .3, tip: .1, pass: .24 };
const FOLLOW: Record<ReleaseKind, number> = { wrist: .45, snap: .38, slap: .5, backhand: .45, tip: .25, pass: .32 };
/** Body turned away from the target in the windup (rad): side-on for shots, square for passes; < 0 backhand side. */
const SIDE_ON: Record<ReleaseKind, number> = { wrist: .55, snap: .45, slap: .95, backhand: -.5, tip: .2, pass: .3 };

const smooth01 = (v: number) => { const t = clamp(v, 0, 1); return t * t * (3 - 2 * t); };

export function shotKind(clip: Pick<ReplayClip, 'shot' | 'label'>): ReleaseKind {
  const s = clip.shot ?? (/Щелч/.test(clip.label) ? 'slap' : /неудоб/.test(clip.label) ? 'backhand' : /Подстав/.test(clip.label) ? 'tip' : /с ходу/.test(clip.label) ? 'snap' : 'wrist');
  return s === 'rebound' ? 'snap' : s;
}

/** Puck carriers from the geometry (clips without recorded possession): the skater whose blade is on a slow puck. */
function deriveTouches(clip: ReplayClip, skaters: Track[]): Touch[] {
  const dur = Math.max(.5, clip.duration), step = .04 / dur, out: Touch[] = [];
  let cur: Touch | null = null;
  for (let t = 0; t <= 1 + 1e-9; t += step) {
    const p = toWorld(samplePath(clip.puck, t)), q = toWorld(samplePath(clip.puck, Math.min(1, t + step)));
    const pv = Math.hypot(q.x - p.x, q.z - p.z) / .04;
    let best: string | null = null, bd = 1.0;
    if (p.y < .3) for (const tr of skaters) {
      const a = toWorld(sampleSmooth(tr.keys, t)), b = toWorld(sampleSmooth(tr.keys, Math.min(1, t + step)));
      let bx = a.x, bz = a.z;
      if (clip.bodies) {
        // the blade is ~0.75 m ahead of a skating body (facing the puck when standing)
        let fx = b.x - a.x, fz = b.z - a.z, n = Math.hypot(fx, fz);
        if (n < .02) { fx = p.x - a.x; fz = p.z - a.z; n = Math.hypot(fx, fz) || 1; }
        bx += fx / n * .75; bz += fz / n * .75;
      }
      const sv = Math.hypot(b.x - a.x, b.z - a.z) / .04;
      const d = Math.hypot(p.x - bx, p.z - bz);
      if (d < bd && Math.abs(pv - sv) < 6) { bd = d; best = tr.id; }
    }
    if (best && cur && cur.id === best && t - cur.t1 < step * 2.5) cur.t1 = t;
    else if (best) { if (cur) out.push(cur); cur = { id: best, t0: t, t1: t }; }
  }
  if (cur) out.push(cur);
  return out.filter(c => (c.t1 - c.t0) * dur >= .08);
}

/** Puck speed (m/s, along the ice) just after clip time t. */
function puckSpeed(clip: ReplayClip, t: number, dt = .1) {
  const dur = Math.max(.5, clip.duration), a = toWorld(samplePath(clip.puck, t)), b = toWorld(samplePath(clip.puck, Math.min(1, t + dt / dur)));
  return Math.hypot(b.x - a.x, b.z - a.z) / dt;
}

/** Releases of all the puck carriers: passes to teammates, shots at the net, the goal itself. */
function planReleases(clip: ReplayClip, touches: Touch[], sideOf: Map<string, 0 | 1>): Release[] {
  const dur = Math.max(.5, clip.duration), out: Release[] = [];
  const kind = shotKind(clip);
  const goalTo = toWorld(samplePath(clip.puck, clip.goal));
  out.push({ id: clip.scorer, t: clip.release, kind, windup: clip.shot === 'rebound' ? .12 : WINDUP[kind], follow: FOLLOW[kind], tx: goalTo.x, tz: goalTo.z, goal: true });
  touches.forEach((tc, k) => {
    if (tc.id === clip.scorer && Math.abs(tc.t1 - clip.release) * dur < .45) return; // the goal shot itself
    if (tc.t1 > clip.goal) return;
    // The puck leaves the blade at the first moment it moves fast after the last frame on his stick
    // (the 2D rink holds it there for one frame while the pass is played).
    let t = -1;
    for (let sec = 0; sec <= .3 + 1e-9; sec += .02) { if (puckSpeed(clip, tc.t1 + sec / dur, .04) > 7) { t = tc.t1 + sec / dur; break; } }
    if (t < 0 || puckSpeed(clip, t, .12) < 7) return; // lost or stripped, not played
    const side = sideOf.get(tc.id);
    const next = touches.slice(k + 1).find(n => n.t0 >= tc.t1 - 1e-9);
    const to = toWorld(samplePath(clip.puck, next && (next.t0 - t) * dur < 2.5 ? next.t0 : Math.min(1, t + .35 / dur)));
    const from = toWorld(samplePath(clip.puck, t));
    // a puck sent toward the attacked net (the scorer's team attacks attackDir(clip)) is a shot
    const dir = side === clip.attacking ? attackDir(clip) : -attackDir(clip);
    const nx = dir * NET_X, toNet = Math.atan2(-(0 - from.z), nx - from.x), moving = Math.atan2(-(to.z - from.z), to.x - from.x);
    let dA = moving - toNet; while (dA > Math.PI) dA -= Math.PI * 2; while (dA < -Math.PI) dA += Math.PI * 2;
    const shot = (!next || sideOf.get(next.id) !== side) && Math.abs(dA) < .35 && Math.abs(nx - from.x) < 20;
    const k2: ReleaseKind = shot ? (Math.abs(nx - from.x) > 13 ? 'slap' : 'wrist') : 'pass';
    // a one-touch pass has no time for a long windup
    const windup = Math.min(WINDUP[k2], Math.max(.08, (tc.t1 - tc.t0) * dur * .8 + (k2 === 'slap' ? .3 : .1)));
    out.push({ id: tc.id, t, kind: k2, windup, follow: FOLLOW[k2], tx: shot ? nx : to.x, tz: shot ? 0 : to.z });
  });
  return out.sort((a, b) => a.t - b.t);
}

/** Pucks that reach each goalie: runs of a fast puck heading at him; the point where it passes him. */
function planSaves(clip: ReplayClip, goalies: Track[]): Map<string, Save[]> {
  const dur = Math.max(.5, clip.duration), step = .02 / dur, out = new Map<string, Save[]>();
  for (const g of goalies) {
    const list: Save[] = [];
    let run: { best: number; t: number } | null = null;
    const close = (t: number) => {
      if (run) { const p = toWorld(samplePath(clip.puck, run.t)); list.push({ t: run.t, x: p.x, y: Math.max(0, p.y), z: p.z }); }
      run = null; void t;
    };
    for (let t = 0; t <= 1; t += step) {
      const p = toWorld(samplePath(clip.puck, t)), q = toWorld(samplePath(clip.puck, Math.min(1, t + step))), w = toWorld(sampleSmooth(g.keys, t));
      const vx = (q.x - p.x) / .02, vz = (q.z - p.z) / .02, v = Math.hypot(vx, vz);
      const rx = w.x - p.x, rz = w.z - p.z, along = v > 0 ? (rx * vx + rz * vz) / v : 0, lateral = v > 0 ? Math.abs(rx * vz - rz * vx) / v : 99;
      const threat = v > 9 && along > -.3 && along < 14 && lateral < 2.4;
      if (threat) { if (!run || along < run.best) run = { best: along, t }; }
      else close(t);
    }
    close(1);
    // The goal shot always gets a reaction from the beaten goalie, even a slow or wide one (a tap-in at the far post):
    // he reaches for the puck where it passes him, unless he is nowhere near it.
    if (g.side !== clip.attacking && !list.some(s => s.t >= clip.release - 1e-9 && (s.t - clip.goal) * dur < .25)) {
      let tc = clip.goal, best = Infinity;
      for (let t = clip.release; t <= clip.goal + 1e-9; t += step) {
        const p = toWorld(samplePath(clip.puck, t)), w = toWorld(sampleSmooth(g.keys, t)), d = Math.hypot(p.x - w.x, p.z - w.z);
        if (d < best) { best = d; tc = t; }
      }
      const p = toWorld(samplePath(clip.puck, tc));
      if (best < 4) list.push({ t: tc, x: p.x, y: Math.max(0, p.y), z: p.z });
      list.sort((a, b) => a.t - b.t);
    }
    // one save per shot: runs closer than 0.25 s merge into the later one (where the puck finally gets to him)
    const merged: Save[] = [];
    for (const s of list) { const last = merged.at(-1); if (last && (s.t - last.t) * dur < .25) merged[merged.length - 1] = s; else merged.push(s); }
    out.set(g.id, merged);
  }
  return out;
}

export function planMotion(clip: ReplayClip): MotionPlan {
  const skaters = clip.tracks.filter(t => !t.goalie), goalies = clip.tracks.filter(t => t.goalie);
  const sideOf = new Map(clip.tracks.map(t => [t.id, t.side] as [string, 0 | 1]));
  const known = new Set(skaters.map(t => t.id));
  const touches = (clip.touches?.filter(t => known.has(t.id)) ?? deriveTouches(clip, skaters)).slice().sort((a, b) => a.t0 - b.t0);
  return { touches, releases: planReleases(clip, touches, sideOf), saves: planSaves(clip, goalies) };
}

/** Skater `id` at clip time: the release he is winding up for / following through, in shot units
 *  (-1 windup start, 0 release, 1.9 follow-through over), and how much his body turns to the target (0..1). */
export function releaseAt(plan: MotionPlan, id: string, time: number, duration: number): { rel: Release; s: number; aim: number } | null {
  let best: { rel: Release; s: number; aim: number } | null = null;
  for (const rel of plan.releases) {
    if (rel.id !== id) continue;
    const sec = (time - rel.t) * duration;
    if (sec < -rel.windup - .2 || sec > rel.follow + .25) continue;
    const s = sec < 0 ? sec / rel.windup : sec / (rel.follow / 1.9);
    const aim = smooth01((sec + rel.windup + .2) / .2) * (1 - smooth01((sec - rel.follow * .55) / (rel.follow * .45 + .25)));
    if (!best || Math.abs(sec) < Math.abs((time - best.rel.t) * duration)) best = { rel, s, aim };
  }
  return best;
}

/** Heading (world yaw, the replay's convention: atan2(-dz, dx)) a releasing skater turns to: side-on to the target. */
export function releaseHeading(rel: Release, x: number, z: number, hand: 1 | -1, follow01: number): number {
  const aim = Math.atan2(-(rel.tz - z), rel.tx - x);
  // forehand: the lead shoulder (the one away from the blade) points at the target and opens up in the follow-through
  return aim - hand * SIDE_ON[rel.kind] * (1 - .5 * follow01);
}

export function carrierAt(plan: MotionPlan, time: number): Touch | null {
  for (const t of plan.touches) if (time >= t.t0 - 1e-9 && time <= t.t1 + 1e-9) return t;
  return null;
}

const hashId = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0) / 4294967296; };

/**
 * Stickhandling: a carrier closing on a defender (or the goalie) moves the puck from forehand to backhand and back.
 * Returns the sideways puck offset in metres (+ = the carrier's left, world direction (lx, lz)) — 0 when nobody is in front of him,
 * during a release, and at the start/end of a touch (so the puck meets passes where the 2D play has it).
 */
export function dekeAt(clip: ReplayClip, plan: MotionPlan, time: number): { id: string; offset: number; weight: number; lx: number; lz: number } | null {
  const c = carrierAt(plan, time);
  if (!c) return null;
  const dur = Math.max(.5, clip.duration);
  const tr = clip.tracks.find(t => t.id === c.id);
  if (!tr) return null;
  const a = toWorld(sampleSmooth(tr.keys, Math.max(0, time - .15 / dur))), b = toWorld(sampleSmooth(tr.keys, Math.min(1, time + .15 / dur))), w = toWorld(sampleSmooth(tr.keys, time));
  let fx = b.x - a.x, fz = b.z - a.z, n = Math.hypot(fx, fz);
  if (n < .15) { fx = (tr.side === clip.attacking ? attackDir(clip) : -attackDir(clip)); fz = 0; n = 1; }
  fx /= n; fz /= n;
  let env = 0, goalieNear = false;
  for (const o of clip.tracks) {
    if (o.side === tr.side) continue;
    const p = toWorld(sampleSmooth(o.keys, time)), dx = p.x - w.x, dz = p.z - w.z, d = Math.hypot(dx, dz) || 1;
    if ((dx * fx + dz * fz) / d < .35) continue; // only someone in front of him
    const e = o.goalie ? smooth01((8 - d) / 4) : smooth01((4.6 - d) / 2.4);
    if (e > env) { env = e; goalieNear = !!o.goalie; }
  }
  if (env <= 0) return null;
  env *= smooth01((time - c.t0) * dur / .3) * smooth01((c.t1 - time) * dur / .3);
  const r = releaseAt(plan, c.id, time, dur);
  if (r) env *= 1 - r.aim;
  // the puck is only on his blade while it is slow
  if (puckSpeed(clip, time, .08) > 11) env = 0;
  if (env < .02) return null;
  const freq = goalieNear ? 1.25 : 1.7, amp = goalieNear ? .42 : .32;
  // (lx, lz): his left in world space, for the heading convention atan2(-dz, dx)
  return { id: c.id, offset: amp * Math.sin(Math.PI * 2 * (freq * time * dur + hashId(c.id))) * env, weight: env, lx: fz, lz: -fx };
}
