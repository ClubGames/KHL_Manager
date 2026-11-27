// What a match sounds like, read from the same frames and plays the pictures show (the watched match's rink AI and the
// played match alike): pure logic that turns them into sound cues for a sink (the Web Audio one in useMatchSound.ts,
// a recorder in the tests).
//
// - plays: body checks, saves, blocks, goals (horn + roar for the home team), the post, the period siren;
// - the frames: the whistle when play stops, the puck dropped at a faceoff, the stick on the puck (a pass, a shot, a
//   slap shot — told apart by the puck's speed and where it goes), a pass received, the puck off the boards / the
//   glass, hockey stops, how much skating there is;
// - the crowd: its excitement follows the puck (the home team attacking lifts it), "ooh" at a post or a big chance,
//   a groan at a home penalty; the organ plays some stoppages.
import type { LiveFrame } from '../../game/rinkPlayback';
import type { RinkPlay } from '../../game/rinkAI';
import { RINK } from '../../game/rinkGeometry';

export type Cue =
  | { k: 'stick'; kind: 'pass' | 'shot' | 'slap' | 'receive'; power: number; pan: number }
  | { k: 'boards'; power: number; pan: number }
  | { k: 'glass'; power: number; pan: number }
  | { k: 'post'; pan: number }
  | { k: 'check'; power: number; wall: boolean; pan: number }
  | { k: 'save'; pad: boolean; pan: number }
  | { k: 'block'; pan: number }
  | { k: 'whistle'; long: boolean }
  | { k: 'drop'; pan: number }
  | { k: 'goal'; home: boolean; pan: number }
  | { k: 'siren' }
  | { k: 'skateStop'; power: number; pan: number }
  | { k: 'ooh' } | { k: 'groan' } | { k: 'applause'; k2: number }
  | { k: 'organ'; riff: 'stoppage' | 'goal' };

export interface SoundSink {
  cue(c: Cue): void;
  /** the crowd's excitement 0…1 (the sink smooths it) */
  crowd(excite: number): void;
  /** how much skating is heard 0…1 */
  skating(level: number): void;
}

/** What the driver reads: the LiveSource of the 3D view (frames, plays, the clock). */
export interface SoundSource {
  readonly flipped: boolean;
  readonly plays: readonly RinkPlay[];
  frameAt(tau: number): LiveFrame;
  clockAt?(tau: number): number;
}

const L = RINK.length, W = RINK.width;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
/** rink percent → metres */
const mx = (x: number) => x / 100 * L, my = (y: number) => y / 100 * W;
/** Distance (m) from a point to the boards (the rounded corners included). */
function toBoards(X: number, Y: number): number {
  const r = RINK.corner;
  const cx = clamp(X, r, L - r), cy = clamp(Y, r, W - r);
  if (cx !== X && cy !== Y) return r - Math.hypot(X - cx, Y - cy);
  return Math.min(X, L - X, Y, W - Y);
}
const pan = (x: number) => clamp((x - 50) / 50, -1, 1) * .45;

type SkPrev = { x: number; y: number; v: number; vAt: number };

export class MatchSound {
  private lastTau = -1;
  private playIdx = 0;
  private prev: LiveFrame | null = null;
  private prevPuck: { X: number; Y: number; vx: number; vy: number } | null = null;
  private prevClock = 0;
  private sk = new Map<string, SkPrev>();
  private release: { at: number; x0: number; y0: number; side: 0 | 1 | null } | null = null;
  private recentGoal = -99;
  private recentSiren = -99;
  private recentWhistle = -99;
  private recentPenalty = -99;
  private lastBoards = -99;
  private lastStop = -99;
  private stopSince: number | null = null;
  private organDone = false;
  private organAfterGoal = false;
  private lastOrgan = -999;
  private shotBuzz = 0;
  private goalCheer = 0;
  private rand: () => number;

  constructor(private sink: SoundSink, seed = 1) {
    let s = seed >>> 0 || 1;
    this.rand = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  }

  /** Forget the past (a jump in time: a replay, a new period): no sounds for what was skipped. */
  resync(src: SoundSource, tau: number) {
    this.lastTau = tau;
    let i = src.plays.length;
    while (i > 0 && src.plays[i - 1].tau > tau) i--;
    this.playIdx = i;
    this.prev = src.frameAt(tau);
    this.prevPuck = null;
    this.prevClock = src.clockAt?.(tau) ?? 0;
    this.sk.clear();
    this.release = null;
    this.stopSince = null;
  }

  /** Called every animation frame with the presentation time; `running` false: paused (the crowd quietens). */
  update(src: SoundSource, tau: number, running: boolean) {
    if (this.lastTau < 0 || tau < this.lastTau - 1e-6 || tau - this.lastTau > 1.5) { this.resync(src, tau); return; }
    const dt = tau - this.lastTau;
    if (!running || dt <= 1e-6) {
      // paused or held (a celebration, a replay of the moment): nothing moves, the crowd settles
      this.goalCheer *= .995;
      this.sink.skating(0);
      this.sink.crowd(running ? .3 + this.goalCheer * .6 : .25);
      if (!running) this.lastTau = tau;
      return;
    }
    const f = src.frameAt(tau);
    this.readPlays(src, tau, f);
    this.readFrame(src, f, tau, dt);
    this.prev = f;
    this.lastTau = tau;
  }

  private readPlays(src: SoundSource, tau: number, f: LiveFrame) {
    const plays = src.plays;
    while (this.playIdx < plays.length && plays[this.playIdx].tau <= tau) {
      const p = plays[this.playIdx++];
      if (p.tau <= this.lastTau - 1e-6) continue;
      const who = p.player ? f.skaters.find(s => s.id === p.player) : undefined;
      const at = who?.pos ?? f.puck;
      switch (p.kind) {
        case 'hit': {
          const wall = toBoards(mx(at.x), my(at.y)) < 2.2;
          this.sink.cue({ k: 'check', power: .55 + this.rand() * .45, wall, pan: pan(at.x) });
          this.shotBuzz = Math.max(this.shotBuzz, wall ? .45 : .3);
          break;
        }
        case 'save': this.sink.cue({ k: 'save', pad: this.rand() < .55, pan: pan(f.puck.x) }); break;
        case 'block': this.sink.cue({ k: 'block', pan: pan(f.puck.x) }); break;
        case 'goal': {
          const home = p.side === 0;
          this.recentGoal = tau;
          this.sink.cue({ k: 'goal', home, pan: pan(f.puck.x) });
          this.goalCheer = home ? 1 : .15;
          this.organAfterGoal = home;
          break;
        }
        case 'wide':
          if (/штанг|перекладин/i.test(p.text)) {
            this.sink.cue({ k: 'post', pan: pan(f.puck.x) });
            this.sink.cue({ k: 'ooh' });
          } else if (p.side === 0 && this.shotBuzz > .4) this.sink.cue({ k: 'ooh' });
          break;
        case 'penalty':
          if (!p.text.startsWith('Отложенный')) { this.recentPenalty = tau; if (p.side === 0) this.sink.cue({ k: 'groan' }); }
          break;
        case 'freeze':
          if (p.text.startsWith('Сирена')) this.siren(tau);
          break;
        default: break;
      }
    }
  }

  private siren(tau: number) {
    if (tau - this.recentSiren < 5) return;
    this.recentSiren = tau;
    this.sink.cue({ k: 'siren' });
  }

  private readFrame(src: SoundSource, f: LiveFrame, tau: number, dt: number) {
    const prev = this.prev;
    // ——— the period ends on the clock (the watched match: the engine clock crosses the end of a period) ———
    const clock = src.clockAt?.(tau) ?? 0;
    for (const end of [1200, 2400, 3600, 3900]) if (this.prevClock < end - .05 && clock >= end - .05 && clock - this.prevClock < 30) this.siren(tau);
    this.prevClock = clock;
    // ——— whistles and faceoffs ———
    const stopped = !!f.stopped, wasStopped = !!prev?.stopped;
    if (stopped && !wasStopped) {
      this.stopSince = tau;
      this.organDone = false;
      // a goal has the horn, the end of a period the siren
      if (tau - this.recentGoal > 1.5 && tau - this.recentSiren > 1.5 && tau - this.recentWhistle > 1) {
        this.recentWhistle = tau;
        this.sink.cue({ k: 'whistle', long: tau - this.recentPenalty < 1.5 });
      }
    }
    if (!stopped) this.stopSince = null;
    if (wasStopped && !stopped) this.sink.cue({ k: 'drop', pan: pan(f.puck.x) });
    // the organ at a stoppage: after a home goal, and now and then at a whistle
    if (stopped && this.stopSince !== null && !this.organDone) {
      const into = tau - this.stopSince;
      if (this.organAfterGoal && into > 4) { this.organDone = true; this.organAfterGoal = false; this.lastOrgan = tau; this.sink.cue({ k: 'organ', riff: 'goal' }); }
      else if (into > 1.4) {
        this.organDone = true;
        if (tau - this.lastOrgan > 80 && tau - this.recentGoal > 20 && this.rand() < .3) { this.lastOrgan = tau; this.sink.cue({ k: 'organ', riff: 'stoppage' }); }
      }
    }
    // ——— the puck ———
    const X = mx(f.puck.x), Y = my(f.puck.y);
    const pp = this.prevPuck;
    const vx = pp ? (X - pp.X) / dt : 0, vy = pp ? (Y - pp.Y) / dt : 0;
    const speed = Math.hypot(vx, vy);
    const carrier = f.carrier ?? null, prevCarrier = prev?.carrier ?? null;
    if (!stopped && prev && !prev.stopped) {
      if (prevCarrier && !carrier) this.release = { at: tau, x0: X, y0: Y, side: f.skaters.find(s => s.id === prevCarrier)?.side ?? null };
      else if (carrier && carrier !== prevCarrier) {
        const c = f.skaters.find(s => s.id === carrier);
        this.release = null;
        if (c && !c.goalie) this.sink.cue({ k: 'stick', kind: 'receive', power: clamp((pp ? Math.hypot(pp.vx, pp.vy) : 8) / 25, .2, .7), pan: pan(f.puck.x) });
      }
      // the release's sound waits a moment for the puck's speed to show (the frames are interpolated)
      if (this.release && tau - this.release.at >= .06) {
        const r = this.release;
        this.release = null;
        const d = Math.hypot(X - r.x0, Y - r.y0), t = tau - r.at;
        const s = Math.max(speed, d / Math.max(t, 1e-3));
        if (s > 3) {
          // toward a net? (the side's attack direction is unknown on a mirrored rink: either net will do)
          const towardNet = [RINK.goalLine, L - RINK.goalLine].some(nx => {
            const dx = nx - X, dy = W / 2 - Y, dd = Math.hypot(dx, dy);
            return dd < 26 && (vx * dx + vy * dy) / (Math.max(speed, 1e-3) * dd) > .93;
          });
          const kind = towardNet && s > 26 ? 'slap' : towardNet && s > 15 ? 'shot' : 'pass';
          this.sink.cue({ k: 'stick', kind, power: clamp(s / 34, .15, 1), pan: pan(f.puck.x) });
          if (kind !== 'pass') {
            // the home team shooting lifts the crowd more
            const homeAttacksRight = !src.flipped, atRightNet = X > L / 2;
            this.shotBuzz = Math.max(this.shotBuzz, homeAttacksRight === atRightNet ? .8 : .45);
          }
        }
      }
      // off the boards / the glass: the free puck turns sharply right at the boards
      if (!carrier && pp) {
        const ps = Math.hypot(pp.vx, pp.vy);
        if (ps > 4 && speed > .5 && toBoards(X, Y) < 1.6 && tau - this.lastBoards > .15) {
          const cos = (pp.vx * vx + pp.vy * vy) / (ps * speed);
          if (cos < .6) {
            this.lastBoards = tau;
            const power = clamp(ps / 28, .15, 1);
            if ((f.puck.h ?? 0) > .95) this.sink.cue({ k: 'glass', power, pan: pan(f.puck.x) });
            else this.sink.cue({ k: 'boards', power, pan: pan(f.puck.x) });
          }
        }
      }
    }
    this.prevPuck = { X, Y, vx, vy };
    // ——— skating and hockey stops ———
    let sum = 0, n = 0;
    for (const s of f.skaters) {
      if (s.goalie || s.box) continue;
      const sx = mx(s.pos.x), sy = my(s.pos.y), q = this.sk.get(s.id);
      if (q) {
        const v = Math.hypot(sx - q.x, sy - q.y) / dt;
        if (v < 14) {
          sum += v; n++;
          // a hard stop: from a fast stride to almost still within a quarter second
          let fired = false;
          if (q.v > 6.5 && v < 2 && tau - q.vAt < .3 && tau - this.lastStop > .5 && !stopped) {
            this.lastStop = tau; fired = true;
            this.sink.cue({ k: 'skateStop', power: clamp((q.v - 5) / 5, .2, 1), pan: pan(s.pos.x) });
          }
          // keep the top speed of the last quarter second (`v`, seen at `vAt`)
          const keep = !fired && q.v > v && tau - q.vAt < .3;
          this.sk.set(s.id, { x: sx, y: sy, v: keep ? q.v : v, vAt: keep ? q.vAt : tau });
          continue;
        }
      }
      this.sk.set(s.id, { x: sx, y: sy, v: 0, vAt: tau });
    }
    this.sink.skating(stopped ? 0 : clamp((n ? sum / n : 0) / 7, 0, 1));
    // ——— the crowd ———
    const homeNetX = src.flipped ? RINK.goalLine : L - RINK.goalLine; // the net the home team attacks
    const awayNetX = L - homeNetX;
    const dHome = Math.hypot(X - homeNetX, Y - W / 2), dAway = Math.hypot(X - awayNetX, Y - W / 2);
    const zone = clamp(1 - dHome / 20, 0, 1) * .55 + clamp(1 - dAway / 20, 0, 1) * .2;
    this.shotBuzz *= Math.exp(-dt / 1.6);
    this.goalCheer *= Math.exp(-dt / 6);
    const excite = stopped ? .2 + this.goalCheer * .7 : .25 + zone + this.shotBuzz * .5 + this.goalCheer * .7;
    this.sink.crowd(clamp(excite, 0, 1));
  }
}
