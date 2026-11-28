import type { RinkPlay } from '../game/rinkAI';
import type { LiveFrame } from '../game/rinkPlayback';
import { toWorld } from './replayCameras';
import { FOLLOW, NET_X, releaseAt, WINDUP, type MotionPlan, type Release, type ReleaseKind } from './replayMotion';

/**
 * What the 3D players of the live match do with the puck, read from the very frames the 2D rink shows:
 * every pass and shot (who lets the puck go, when, where to — so the body winds up before and follows through
 * after), and the goals (celebration, goal lamp). Time is the rink's presentation time `tau`; the 3D view keeps
 * the rink simulated about a second ahead of the picture, so a windup starts before the puck leaves the blade.
 * Pure (no three.js): the tests run it in Node.
 */
export const LOOKAHEAD = 1.2;
/** World units: metres around centre ice, the replay's convention (toWorld). */
export type LiveRelease = Release & { side: 0 | 1 };

/** What the 3D match reads: the rink AI of a watched match or the playable rink (which brings its own motion). */
export interface LiveSource {
  readonly flipped: boolean;
  /** the played match: the way the manager's team attacks on the screen (+1 toward +x) — the vertical camera looks that way */
  readonly attack?: 1 | -1;
  readonly frames: readonly { tau: number; carrier: number; ids: string[] }[];
  readonly plays: readonly RinkPlay[];
  frameAt(tau: number): LiveFrame;
  ensure(tau: number): void;
  /** the game clock at presentation time (the replays of moments keep a few game minutes apart) */
  clockAt?(tau: number): number;
  /** releases known as they happen (the played match): used instead of reading them back from the frames */
  readonly motion?: LiveMotionLike;
  /** the played match: the aim marker on the net (world metres, the charge of the shot 0…1) */
  aimMarker?(): { x: number; y: number; z: number; charge: number } | null;
  /** set by the 3D view: a screen point (client px) → rink percent on the ice, for the mouse */
  screenPick?: ((cx: number, cy: number) => { x: number; y: number; h?: number } | null) | null;
  /** the played match: a timeout under way (whose, seconds left) — the coaches and the camera go to that bench */
  timeoutNow?(): { side: 0 | 1; left: number } | null;
}
export interface LiveMotionLike {
  update(): void;
  prune(tau: number): void;
  releaseAt(id: string, tau: number): { rel: Release; s: number; aim: number } | null;
  goalAt(tau: number): { side: 0 | 1; tau: number; netX: number } | null;
}

const HOLD_BACK = 1.5;
/** Seconds of releases kept behind the picture: a replay goes back up to about this far. */
export const REPLAY_KEEP = 18;

export class LiveMotion implements LiveMotionLike {
  readonly releases: LiveRelease[] = [];
  private scanned = 1;
  private pending: { id: string; k: number }[] = [];
  private plan: MotionPlan = { touches: [], releases: [], saves: new Map() };
  constructor(readonly ai: LiveSource) {}

  /** World x of the net side `side` attacks (teams switch ends between periods). */
  netX(side: 0 | 1): number {
    return ((side === 0) !== this.ai.flipped ? 1 : -1) * NET_X;
  }

  /** Reads the frames recorded since the last call. */
  update() {
    const F = this.ai.frames;
    for (; this.scanned < F.length; this.scanned++) {
      const a = F[this.scanned - 1], b = F[this.scanned];
      const ca = a.carrier >= 0 ? a.ids[a.carrier] : null, cb = b.carrier >= 0 ? b.ids[b.carrier] : null;
      if (ca && ca !== cb) this.pending.push({ id: ca, k: this.scanned - 1 });
    }
    const last = F.length ? F[F.length - 1].tau : 0;
    while (this.pending.length && F[this.pending[0].k].tau + 0.3 <= last) this.resolve(this.pending.shift()!);
  }

  /** The puck left `id` after frame k: a pass or a shot when it flies off fast, nothing when it was lost. */
  private resolve({ id, k }: { id: string; k: number }) {
    const F = this.ai.frames;
    const t0 = F[k].tau;
    const at = (tau: number) => this.ai.frameAt(tau);
    const f0 = at(t0), me = f0.skaters.find(p => p.id === id);
    if (!me || me.goalie) return;
    const p0 = toWorld(f0.puck);
    // the moment it leaves: the first frame after his last one on it where it moves fast
    let t = -1;
    for (let dt = 0.02; dt <= 0.3 + 1e-9; dt += 0.02) {
      const a = toWorld(at(t0 + dt - 0.02).puck), b = toWorld(at(t0 + dt).puck);
      if (Math.hypot(b.x - a.x, b.z - a.z) / 0.02 > 7) { t = t0 + dt - 0.02; break; }
    }
    if (t < 0) return;
    const p1 = toWorld(at(t + 0.12).puck);
    if (Math.hypot(p1.x - p0.x, p1.z - p0.z) / Math.max(0.05, t + 0.12 - t0) < 6) return;
    const from = toWorld(at(t).puck), to = toWorld(at(t + 0.35).puck);
    const nx = this.netX(me.side);
    const toNet = Math.atan2(-(0 - from.z), nx - from.x), moving = Math.atan2(-(to.z - from.z), to.x - from.x);
    let dA = moving - toNet; while (dA > Math.PI) dA -= Math.PI * 2; while (dA < -Math.PI) dA += Math.PI * 2;
    const shot = Math.abs(dA) < 0.35 && Math.abs(nx - from.x) < 20;
    const kind: ReleaseKind = shot ? (Math.abs(nx - from.x) > 13 ? 'slap' : 'wrist') : 'pass';
    // how long he had it: a one-touch pass has no time for a long windup
    let held = 0;
    for (let j = k; j >= 0 && F[j].carrier >= 0 && F[j].ids[F[j].carrier] === id && t0 - F[j].tau < HOLD_BACK; j--) held = t0 - F[j].tau;
    const windup = Math.min(WINDUP[kind], Math.max(0.08, held * 0.8 + (kind === 'slap' ? 0.3 : 0.1)));
    this.releases.push({ id, side: me.side, t, kind, windup, follow: FOLLOW[kind], tx: shot ? nx : to.x, tz: shot ? 0 : to.z });
    this.releases.sort((x, y) => x.t - y.t);
  }

  /** The release skater `id` is winding up for / following through at `tau` (shot units as in the replay). */
  releaseAt(id: string, tau: number): ReturnType<typeof releaseAt> {
    this.plan.releases = this.releases;
    return releaseAt(this.plan, id, tau, 1);
  }

  /** Forget releases long gone (kept long enough for the replays, which read the last seconds again). */
  prune(tau: number) {
    let n = 0;
    while (n < this.releases.length && this.releases[n].t < tau - REPLAY_KEEP) n++;
    if (n) this.releases.splice(0, n);
  }

  /** The latest goal shown up to `tau`: who scored (side), when, and on which net. */
  goalAt(tau: number): { side: 0 | 1; tau: number; netX: number } | null {
    const plays = this.ai.plays;
    for (let i = plays.length - 1; i >= 0; i--) {
      const p = plays[i];
      if (p.tau > tau) continue;
      if (tau - p.tau > 6) return null;
      if (p.kind === 'goal' && p.side !== null) return { side: p.side, tau: p.tau, netX: this.netX(p.side) };
    }
    return null;
  }
}

/** World velocity (m/s along the ice) of the puck at `tau`, from the frames around it. */
export function puckVelocity(ai: LiveSource, tau: number, dt = 0.06): { x: number; z: number } {
  const a = toWorld(ai.frameAt(tau - dt).puck), b = toWorld(ai.frameAt(tau).puck);
  return { x: (b.x - a.x) / dt, z: (b.z - a.z) / dt };
}

/** Skaters on the ice (not in the penalty box) of a frame — what both the 2D and the 3D rink draw. */
export const shownSkaters = (f: LiveFrame) => f.skaters.filter(p => !p.box);
