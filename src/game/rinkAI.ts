import type { AttackStyle, ForecheckStyle, GameEvent, Player, Team } from '../types';
import type { Key, LiveFrame, ReplayClip, Track } from './rinkPlayback';
import { RINK } from './rinkGeometry';

/*
 * Agent-based hockey for the 2D rink and the 3D replay.
 *
 * Every skater and goalie is an agent with position, velocity, top speed and acceleration taken from skills.
 * Puck carriers decide (carry, pass, dump in, chip out, shoot wide, get stripped); off-puck players take
 * role-based attacking/defending positions, forecheck according to tactics, and change lines on the fly.
 * Nobody moves faster than physics allows and there are no teleports. Attackers normally tag up and stay
 * onside; now and then a forward jumps the blue line too early, the linesman whistles the offside and the
 * puck is dropped at the neutral-zone dot outside that blue line. The game clock stops at every whistle
 * until the puck is dropped. The rink has real IIHF/KHL proportions (see rinkGeometry.ts).
 *
 * Special teams: on the power play the team sets up in the zone (1-3-1, or the umbrella for a shooting team)
 * and moves the puck around the perimeter to keep it in the zone; the penalty killers hold a box (a triangle
 * when two men down), pressure only a puck they can reach, ice it whenever they get it and wait passively
 * in the neutral zone instead of forechecking.
 *
 * The statistical engine remains authoritative: shots, saves, goals, scorers, assists, penalties and hits
 * happen exactly at their game second. A director steers the free play so that the right team owns the
 * puck, the right players pass and the right player shoots from the recorded location.
 * Time units: `g` is the game clock (stops at whistles), `tau` is presentation time (never stops).
 */

type Side = 0 | 1;
type Role = 'C' | 'LW' | 'RW' | 'LD' | 'RD' | 'X';
type V2 = { x: number; y: number };
export type PlayKind = 'faceoff' | 'loose' | 'entry' | 'dump' | 'icing' | 'offside' | 'takeaway' | 'interception' | 'block' | 'wide' | 'hit' | 'penalty' | 'freeze' | 'save' | 'goal' | 'change' | 'clear';
export type RinkPlay = { tau: number; g: number; kind: PlayKind; side: Side | null; player?: string; text: string };
export type RinkTactics = [{ forecheck: ForecheckStyle; style: AttackStyle }, { forecheck: ForecheckStyle; style: AttackStyle }];
/** `flip`: teams have switched ends (2nd period, 1st overtime …). The simulation itself always runs in one
 *  orientation; frames and goal clips are mirrored lengthwise for presentation. */
export interface RinkAIOptions { suddenDeath?: boolean; tactics?: () => RinkTactics; goalies?: [string | null, string | null]; seed?: number; flip?: boolean }

const DT = 0.1;
const L = 60, W = 30, MID = 15;
export const RINK_M = { length: L, width: W, goalLine: RINK.goalLine, blueLine: RINK.blueLine, post: 0.915 } as const;
const GOAL = RINK.goalLine, BLUE = RINK.blueLine, RED = 30, OPP_BLUE = L - RINK.blueLine, OPP_GOAL = L - RINK.goalLine;
const BENCH: [V2, V2] = [{ x: 24, y: 0.8 }, { x: 36, y: 0.8 }];
const BOX: [V2, V2] = [{ x: 27, y: 29.2 }, { x: 33, y: 29.2 }];
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const dist = (a: V2, b: V2) => Math.hypot(a.x - b.x, a.y - b.y);
/** Each team's local frame: attacking toward +x, own net at x = 4.2. It is a 180° rotation, its own inverse. */
const loc = (s: Side, p: V2): V2 => (s ? { x: L - p.x, y: W - p.y } : { x: p.x, y: p.y });
const sk = (p: Player | undefined, k: keyof Player['skills'], d = 62) => p?.skills?.[k] ?? d;
function rng(seed: number) {
  let a = seed | 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Rounded-rectangle boards (corner radius 8.5 m). */
function inside(p: V2, m = 0.5): V2 {
  const r = RINK.corner;
  let x = clamp(p.x, m, L - m), y = clamp(p.y, m, W - m);
  const cx = clamp(x, r + m, L - r - m), cy = clamp(y, r + m, W - r - m);
  if (cx !== x && cy !== y) { const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy); if (d > r) { x = cx + (dx / d) * r; y = cy + (dy / d) * r; } }
  return { x, y };
}

interface Agent {
  id: string; side: Side; goalie: boolean; role: Role; name: string;
  x: number; y: number; vx: number; vy: number; fx: number; fy: number;
  on: 'ice' | 'bench' | 'box'; leave: null | 'bench' | 'box'; boxUntil: number; pim: number; stun: number;
  max: number; acc: number; pass: number; shoot: number; hands: number; check: number;
  tx: number; ty: number; urg: number; arrive: number; scripted: boolean;
  /** velocity of the target itself (a man being shadowed): skated on top of the closing speed, so nobody trails behind */
  fvx: number; fvy: number;
}
/** Power-play spots: Q quarterback at the top, P1/P2 umbrella points, F1/F2 half-wall flanks, B bumper in the slot, LOW goal line, NET net-front. */
type PPRole = 'Q' | 'P1' | 'P2' | 'F1' | 'F2' | 'B' | 'LOW' | 'NET';
type LegKind = 'pass' | 'giveaway' | 'shot' | 'dump' | 'chip' | 'wide' | 'block' | 'clear' | 'deflect';
interface Leg { via?: Agent; tv?: number; kind: LegKind; t0: number; t1: number; from: V2; to: V2 | Agent; h0: number; h1: number; arc: number; by: Agent | null; protect: boolean; exitSpeed: number; event?: GameEvent; icing?: Side | null }
interface Puck { x: number; y: number; h: number; vx: number; vy: number; carrier: Agent | null; leg: Leg | null; next: Leg | null; last: Side | null; noTouch: Agent | null; noTouchUntil: number; icing: Side | null; reserved: Agent | null; dead: boolean }
interface ShotPlan { ev: GameEvent; T: Side; chain: Agent[]; spots: V2[]; rel: number[]; arr: number[]; tr: number; target: V2 | Agent; th: number; step: number; acquired: boolean; acqStarted: boolean; shot: boolean }
interface DuelPlan { ev: GameEvent; kind: 'hit' | 'penalty'; actor: Agent; victim: Agent | null }
interface Stop { reason: 'start' | 'goal' | 'freeze' | 'icing' | 'penalty' | 'offside'; dot: V2; t0: number; phase: 'whistle' | 'celebrate' | 'gather' | 'set' | 'drop'; phaseAt: number; scorer?: Agent; winner?: Side }
interface Frame { tau: number; g: number; px: number; py: number; ph: number; ids: string[]; pos: Float32Array; flags: Uint8Array; carrier: number; stop: 0 | 1 | 2; ox: number; oy: number }

const isAgent = (v: V2 | Agent): v is Agent => typeof (v as Agent).id === 'string';
const SHOT_SPEED: Record<string, number> = { slap: 36, snap: 30, wrist: 26, backhand: 21, tip: 24, rebound: 18 };
const CATCH: Record<string, number> = { slap: 0.3, snap: 0.25, wrist: 0.65, backhand: 0.8, tip: 0.05, rebound: 0.15 };
const FACEOFF_DOTS = { center: { x: 30, y: 15 } };
/** End-zone dot of side s's defensive zone, on the half where the puck is. */
const zoneDot = (s: Side, y: number): V2 => loc(s, { x: RINK.endDot, y: loc(s, { x: 0, y }).y < MID ? MID - RINK.dotOffset : MID + RINK.dotOffset });
/** Neutral-zone dot just outside side s's attacking blue line (offside faceoffs), on the puck's half. */
const neutralDot = (s: Side, y: number): V2 => loc(s, { x: L - RINK.neutralDot, y: loc(s, { x: 0, y }).y < MID ? MID - RINK.dotOffset : MID + RINK.dotOffset });

export class RinkAI {
  readonly frames: Frame[] = [];
  readonly plays: RinkPlay[] = [];
  readonly faceoffWins: [number, number] = [0, 0];
  readonly blocks: [number, number] = [0, 0];
  readonly icings: [number, number] = [0, 0];
  readonly offsides: [number, number] = [0, 0];
  g: number;
  tau = 0;
  mode: 'play' | 'stop' | 'end' = 'stop';
  private readonly eventTau = new Map<GameEvent, number>();
  private all: GameEvent[] = [];
  private staged: GameEvent[] = [];
  private si = 0;
  private ri = 0;
  private agents = new Map<string, Agent>();
  private rand: () => number;
  private puck: Puck = { x: 30, y: 15, h: 0, vx: 0, vy: 0, carrier: null, leg: null, next: null, last: null, noTouch: null, noTouchUntil: 0, icing: null, reserved: null, dead: true };
  private plan: ShotPlan | null = null;
  private duel: DuelPlan | null = null;
  private stop: Stop | null = null;
  private poss: { side: Side; until: number } = { side: 0, until: 0 };
  private decideAt = new Map<string, number>();
  private carryTarget = new Map<string, V2>();
  /** Current offensive-zone possession: who has it, since when, how many passes, and the last passer. */
  private oz = { side: -1 as Side | -1, t0: 0, passes: 0, lastPasser: '' };
  private lastIds: string[] = [];
  private lastGoalie: [string | null, string | null];
  /** Skaters the current unit should have without an extra attacker (5 at even strength, 4 on the PK, 3 in OT). */
  private baseSkaters: [number, number] = [5, 5];
  /** The engine's last unit per side (ids as sent, nulls included). */
  private lastUnit: [(string | null)[], (string | null)[]] = [[], []];
  private zoneEntry: Side | null = null;
  /** Puck is in side s's attacking zone; it leaves only after fully crossing the 30 cm blue line. */
  private zoneIn: [boolean, boolean] = [false, false];
  /** A forward who jumps the attacking blue line before the puck (a rare, deliberate mistake → offside). */
  private early: { a: Agent; until: number } | null = null;
  /** Game second before which no new offside is staged (keeps them at a realistic few per period). */
  private offsideQuiet = 0;
  /** side on the power play (more skaters, both goalies in the net), null at even strength */
  private pp: Side | null = null;
  /** power-play formation spots of the skaters (stable while the same unit is out there) */
  private ppMap = new Map<string, PPRole>();
  private ppKey = '';
  /** puck side of the overload (with hysteresis, so the umbrella does not flip at every pass through the middle) */
  private ppLow = true;
  private readonly teams: [Team, Team];

  constructor(events: GameEvent[], home: Team, away: Team, private readonly players: Record<string, Player>, readonly start: number, public end: number, private readonly opts: RinkAIOptions = {}) {
    this.teams = [home, away];
    this.g = start;
    this.lastGoalie = opts.goalies ?? [home.lineup.starterG, away.lineup.starterG];
    let seed = opts.seed ?? (Math.round(start * 13) ^ 0x9e3779b9);
    for (const e of events) seed = Math.imul(seed ^ Math.round(e.sec * 7 + (e.x ?? 3)), 16777619);
    this.rand = rng(seed);
    this.setEvents(events);
    this.poss = { side: this.rand() < 0.5 ? 0 : 1, until: start + 6 };
    // Opening faceoff: both lines in formation at centre ice; the clock waits for the drop.
    const goalies = this.desiredGoalies();
    for (const s of [0, 1] as Side[]) {
      const ids = this.wantedSkaters(s, goalies[s]);
      ids.forEach(id => this.spawn(id, s, null));
      if (goalies[s]) this.spawn(goalies[s]!, s, null, true);
      this.assignRoles(s);
    }
    this.startStop('start', FACEOFF_DOTS.center);
    for (const a of this.onIce()) { const slot = this.slot(a); a.x = slot.x; a.y = slot.y; }
    this.puck.x = 30; this.puck.y = 15; this.puck.h = 1.1;
    this.stop!.phase = 'set'; this.stop!.phaseAt = 0;
    this.record();
  }

  /* ---------------- public API ---------------- */

  /** Replace future events after a live coaching change. Motion already generated is kept. */
  setEvents(events: GameEvent[], end = this.end) {
    this.end = Math.max(this.g, end);
    this.all = [...events].sort((a, b) => a.sec - b.sec);
    this.staged = this.all.filter(e => (['goal', 'shot', 'miss', 'penalty', 'hit'] as GameEvent['type'][]).includes(e.type) && e.sec > this.start - 1e-9 && (e.type === 'penalty' || e.type === 'hit' || (!!e.player && !!this.players[e.player])));
    this.si = this.staged.findIndex(e => e.sec > this.g + 1e-9 || (e.sec >= this.g - 1e-9 && !this.eventTau.has(e)));
    if (this.si < 0) this.si = this.staged.length;
    this.ri = 0;
    while (this.ri < this.all.length && this.eventTau.has(this.all[this.ri])) this.ri++;
    if (this.plan && !this.staged.includes(this.plan.ev)) this.cancelPlan();
    if (this.duel && !this.staged.includes(this.duel.ev)) this.duel = null;
  }
  get ended() { return this.mode === 'end'; }
  /** Rink-level hockey stats of the plays already shown (up to presentation time `tau`). */
  tally(tau: number) {
    const t = { faceoff: [0, 0], block: [0, 0], takeaway: [0, 0], icing: [0, 0], offside: [0, 0] } as Record<'faceoff' | 'block' | 'takeaway' | 'icing' | 'offside', [number, number]>;
    for (const p of this.plays) {
      if (p.tau > tau) break;
      if (p.side === null) continue;
      if (p.kind === 'faceoff' || p.kind === 'block' || p.kind === 'icing' || p.kind === 'offside') t[p.kind][p.side]++;
      else if (p.kind === 'takeaway' || p.kind === 'interception') t.takeaway[p.side]++;
    }
    return t;
  }
  /** Something worth watching at normal pace: a shot sequence, a whistle, a faceoff drop or a body check. */
  get hot(): boolean {
    if (this.mode === 'end') return false;
    if (this.mode === 'stop') return !!this.stop && this.stop.phase !== 'gather' && this.stop.phase !== 'celebrate';
    if (this.puck.leg?.kind === 'shot') return true;
    if (this.plan && this.plan.ev.sec - this.g < 3.2) return true;
    const n = this.next();
    return !!n && (n.type === 'hit' || n.type === 'penalty') && n.sec - this.g < 1.6;
  }
  /** Presentation seconds per real second: highlights near real time, routine skating fast-forwarded,
   *  so a period lasts about as long as before (≈4–5 min at ×1, ≈2.3 at ×2, ≈1.2 at ×4). */
  static readonly PACE = { hot: 1.5, setup: 3.2, cold: 6.5 } as const;
  /** Pace of the moment: a power play working the puck in the zone is shown slower than routine skating. */
  get pace(): number {
    if (this.hot) return RinkAI.PACE.hot;
    const pp = this.pp, p = this.puck;
    if (this.mode === 'play' && pp !== null && this.zoneIn[pp] && (p.carrier?.side ?? p.leg?.by?.side) === pp) return RinkAI.PACE.setup;
    return RinkAI.PACE.cold;
  }
  get lastTau() { return this.frames.at(-1)?.tau ?? 0; }
  /** Simulate until presentation time `tau` (lazy; keeps the live match cheap). */
  ensure(tau: number) {
    let guard = 0;
    while (this.mode !== 'end' && this.tau < tau && guard++ < 200000) this.step();
  }
  runToEnd() { this.ensure(Infinity); return this; }
  tauOf(e: GameEvent): number | undefined {
    const t = this.eventTau.get(e);
    if (t !== undefined) return t;
    if (e.sec > this.g + 1e-9) return undefined;
    // Events that arrived after a replan in the already-simulated look-ahead: first frame at that clock.
    const f = this.frames.find(fr => fr.g >= e.sec - 1e-9);
    return f?.tau ?? this.tau;
  }
  clockAt(tau: number): number {
    const [a, b, u] = this.bracket(tau);
    return a.g + (b.g - a.g) * u;
  }
  /** Teams have switched ends: presentation is mirrored lengthwise. */
  get flipped() { return !!this.opts.flip; }
  /** Presentation x in rink percent (0…100), mirrored when the teams have switched ends. */
  private px(x: number) { return (this.opts.flip ? L - x : x) / 0.6; }
  frameAt(tau: number): LiveFrame {
    const [a, b, u] = this.bracket(tau);
    const skaters: LiveFrame['skaters'] = [];
    const index = new Map(b.ids.map((id, i) => [id, i] as const));
    a.ids.forEach((id, i) => {
      const j = a.ids === b.ids ? i : index.get(id);
      const ax = a.pos[i * 2], ay = a.pos[i * 2 + 1];
      const box = (a.flags[i] & 2) > 0;
      let x = ax, y = ay;
      if (j !== undefined && !box && (b.flags[j] & 2) === 0) { x = ax + (b.pos[j * 2] - ax) * u; y = ay + (b.pos[j * 2 + 1] - ay) * u; }
      skaters.push({ id, side: this.sideOf(id), goalie: (a.flags[i] & 1) > 0, box: box || undefined, pos: { x: this.px(x), y: y / 0.3, h: 0 } });
    });
    const caption = [...this.plays].reverse().find(p => p.tau <= tau && tau - p.tau < 2.6);
    return {
      puck: { x: this.px(a.px + (b.px - a.px) * u), y: (a.py + (b.py - a.py) * u) / 0.3, h: a.ph + (b.ph - a.ph) * u },
      skaters, faceoff: a.stop === 1 || undefined, stopped: a.stop > 0 || undefined,
      carrier: a.carrier >= 0 ? a.ids[a.carrier] : null, caption: caption?.text,
      official: a.stop === 1 ? { x: this.px(a.ox), y: a.oy / 0.3, h: 0 } : undefined,
    };
  }
  /** The goal sequence as the 3D viewer consumes it — exactly the frames shown on the 2D rink. */
  goalClip(e: GameEvent): ReplayClip | null {
    const te = this.tauOf(e);
    if (te === undefined || !e.player) return null;
    this.ensure(te + 2.4);
    const startAt = Math.max(this.frames[0].tau, te - 7), endAt = Math.min(this.lastTau, te + 2.2);
    const frames = this.frames.filter(f => f.tau >= startAt - 1e-9 && f.tau <= endAt + 1e-9);
    const at = frames.find(f => f.tau >= te - 1e-9) ?? frames.at(-1)!;
    const duration = Math.max(0.5, endAt - startAt), norm = (t: number) => clamp((t - startAt) / duration, 0, 1);
    const tracks: Track[] = at.ids.map((id, i) => {
      if (at.flags[i] & 2) return null;
      const keys: Key[] = [];
      let last: Key | null = null;
      for (const f of frames) {
        const j = f.ids === at.ids ? i : f.ids.indexOf(id);
        if (j < 0 || f.flags[j] & 2) continue;
        last = { t: norm(f.tau), x: this.px(f.pos[j * 2]), y: f.pos[j * 2 + 1] / 0.3, h: 0 };
        keys.push(last);
      }
      if (!keys.length) return null;
      if (keys[0].t > 0) keys.unshift({ ...keys[0], t: 0 });
      if (last && last.t < 1) keys.push({ ...last, t: 1 });
      return { id, side: this.sideOf(id), goalie: (at.flags[i] & 1) > 0 || undefined, keys } as Track;
    }).filter((t): t is Track => !!t);
    const puck: Key[] = frames.map(f => ({ t: norm(f.tau), x: this.px(f.px), y: f.py / 0.3, h: f.ph }));
    // possession on the 2D rink, frame by frame: the 3D players pass and shoot exactly when the puck leaves them
    const touches: { id: string; t0: number; t1: number }[] = [];
    let held: string | null = null;
    for (const f of frames) {
      const id = f.carrier >= 0 ? f.ids[f.carrier] : null, t = norm(f.tau);
      if (id && id === held) touches[touches.length - 1].t1 = t;
      else if (id) touches.push({ id, t0: t, t1: t });
      held = id;
    }
    const release = this.releaseTau.get(e) ?? te - 0.4;
    const side: Side = e.team === this.teams[1].id ? 1 : 0;
    const labels = { wrist: 'Кистевой бросок', snap: 'Бросок с ходу', slap: 'Щелчок', tip: 'Подставление на пятаке', rebound: 'Добивание', backhand: 'Бросок с неудобной' };
    return { label: e.strength === 'EN' ? 'Бросок в пустые ворота' : labels[e.shotType ?? 'wrist'], duration, release: norm(release), goal: norm(te), tracks, puck, scorer: e.player, attacking: side, bodies: true, dir: ((side === 0) !== !!this.opts.flip ? 1 : -1) as 1 | -1, touches, shot: e.shotType };
  }

  /* ---------------- internals ---------------- */

  private releaseTau = new Map<GameEvent, number>();
  private bracket(tau: number): [Frame, Frame, number] {
    const f = this.frames;
    if (tau <= f[0].tau) return [f[0], f[0], 0];
    if (tau >= f[f.length - 1].tau) return [f[f.length - 1], f[f.length - 1], 0];
    let lo = 0, hi = f.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (f[m].tau <= tau) lo = m; else hi = m; }
    return [f[lo], f[hi], (tau - f[lo].tau) / (f[hi].tau - f[lo].tau || 1)];
  }
  private sideOf(id: string): Side {
    const a = this.agents.get(id);
    if (a) return a.side;
    return this.teams[1].players.includes(id) ? 1 : 0;
  }
  private agent(id: string, side: Side, goalie = false): Agent {
    let a = this.agents.get(id);
    if (!a) {
      const p = this.players[id];
      const skate = sk(p, 'skating');
      a = {
        id, side, goalie, role: 'X', name: p?.name ?? id, x: BENCH[side].x, y: BENCH[side].y, vx: 0, vy: 0, fx: side ? -1 : 1, fy: 0,
        on: 'bench', leave: null, boxUntil: 0, pim: 0, stun: 0,
        max: goalie ? 3.4 : 6.9 + (skate - 50) * 0.045, acc: goalie ? 9 : 4.4 + (skate - 50) * 0.035,
        pass: sk(p, 'passing'), shoot: sk(p, 'shooting'), hands: sk(p, 'puckControl', sk(p, 'puckHandling')), check: sk(p, 'checking'),
        tx: 0, ty: 0, urg: 0.7, arrive: NaN, scripted: false, fvx: 0, fvy: 0,
      };
      this.agents.set(id, a);
    }
    a.goalie = goalie || a.goalie;
    return a;
  }
  private spawn(id: string, side: Side, at: V2 | null, goalie = false) {
    const a = this.agent(id, side, goalie || this.players[id]?.position === 'G');
    a.on = 'ice'; a.leave = null; a.stun = 0; a.vx = 0; a.vy = 0;
    const p = at ?? BENCH[side];
    a.x = p.x; a.y = p.y;
    return a;
  }
  private onIce(side?: Side) { return [...this.agents.values()].filter(a => a.on === 'ice' && (side === undefined || a.side === side)); }
  private skaters(side: Side, includeLeaving = false) { return this.onIce(side).filter(a => !a.goalie && (includeLeaving || !a.leave)); }
  private goalieOf(side: Side) { return this.onIce(side).find(a => a.goalie && !a.leave) ?? null; }
  private play(kind: PlayKind, side: Side | null, text: string, player?: Agent) {
    const lastSame = this.plays.at(-1);
    if (lastSame && lastSame.kind === kind && lastSame.text === text && this.tau - lastSame.tau < 1.5) return;
    this.plays.push({ tau: this.tau, g: this.g, kind, side, player: player?.id, text });
  }
  private teamShort(s: Side) { return this.teams[s].short ?? this.teams[s].name; }
  private next() { return this.staged[this.si]; }

  /* --- who should be on the ice --- */
  private nextIceEvent(): GameEvent | undefined {
    for (let i = this.si; i < this.staged.length; i++) { const e = this.staged[i]; if (e.ice && e.sec >= this.g - 1e-9) return e; }
    return undefined;
  }
  private valid(id: string | null | undefined): id is string { return !!id && !!this.players[id] && this.players[id].position !== 'G' && !this.players[id].inVhl; }
  private desiredGoalies(): [string | null, string | null] {
    const out: [string | null, string | null] = [...this.lastGoalie];
    for (const s of [0, 1] as Side[]) {
      for (let i = this.si; i < this.staged.length; i++) {
        const e = this.staged[i];
        if (e.sec - this.g > 25) break;
        if (e.goalie !== undefined && (e.type === 'goal' || e.type === 'shot' || e.type === 'miss') && e.team === this.teams[1 - s].id) { out[s] = e.goalie; break; }
      }
    }
    return out;
  }
  /** Defenceman by the lineup slot he is dressed in (a forward listed on a pair plays defence), else by position. */
  private kindD(id: string): boolean {
    const L = this.teams[this.sideOf(id)].lineup;
    if (L.D.some(p => p.includes(id)) || L.u20D === id) return true;
    if (L.F.some(l => l.includes(id)) || L.u20F === id) return false;
    return this.players[id]?.position === 'D';
  }
  /** A dressed skater of the same kind to stand in for a man who cannot play (box, VHL, empty slot). */
  private standIn(s: Side, wantD: boolean, taken: string[]): string | null {
    const L = this.teams[s].lineup;
    const own = [...this.skaters(s).map(a => a.id), ...L.D.flat(), ...L.F.flat(), L.u20D, L.u20F];
    const free = (id: string | null | undefined): id is string => this.valid(id) && !taken.includes(id) && this.agents.get(id)?.on !== 'box' && this.agents.get(id)?.leave !== 'box';
    return own.find(id => free(id) && this.kindD(id) === wantD) ?? own.find(free) ?? null;
  }
  private wantedSkaters(s: Side, goalie: string | null): string[] {
    const e = this.nextIceEvent();
    const raw = e?.ice?.[s] ?? [];
    let ids: string[] = [];
    const ok = (id: string | null) => this.valid(id) && this.agents.get(id!)?.on !== 'box' && this.agents.get(id!)?.leave !== 'box';
    if (raw.length) {
      // The unit size is the engine's (nulls included): a man who cannot be shown is replaced, never dropped.
      this.baseSkaters[s] = raw.length;
      this.lastUnit[s] = raw;
      ids = raw.filter((id): id is string => ok(id));
      raw.forEach((id, k) => {
        if (ok(id)) return;
        const wantD = id && this.players[id] ? this.kindD(id) : raw.length >= 4 ? k >= raw.length - 2 : k === raw.length - 1;
        const sub = this.standIn(s, wantD, ids);
        if (sub) ids.push(sub);
      });
    } else {
      // No upcoming event (end of the period): the last unit the engine sent out stays (not the men who happen to
      // be skating — mid-change that list is a man short and would shrink with every update), topped up to the
      // unit size with stand-ins of the missing kind.
      const L = this.teams[s].lineup;
      const src = this.lastUnit[s].length ? this.lastUnit[s] : [...this.skaters(s).map(a => a.id), ...(L.F[0] ?? []), ...(L.D[0] ?? [])];
      ids = [...new Set(src.filter((id): id is string => ok(id)))].slice(0, this.baseSkaters[s]);
      while (ids.length < this.baseSkaters[s]) {
        const sub = this.standIn(s, ids.filter(id => this.kindD(id)).length < (this.baseSkaters[s] >= 4 ? 2 : 1), ids);
        if (!sub) break;
        ids.push(sub);
      }
    }
    // Participants of an imminent hit/penalty must be on the ice for it.
    const n = this.next();
    if (n && (n.type === 'hit' || n.type === 'penalty') && n.sec - this.g < 9) {
      for (const id of [n.player, ...(n.players ?? [])]) {
        if (!this.valid(id) || ids.includes(id) || this.sideOf(id) !== s || this.agents.get(id)?.on === 'box') continue;
        // he replaces a teammate of his own kind (a forward for a forward), so the pair stays a pair
        const d = this.kindD(id), core = new Set([n.player, ...(n.players ?? [])]);
        let k = -1;
        for (let j = ids.length - 1; j >= 0; j--) if (!core.has(ids[j]) && this.kindD(ids[j]) === d) { k = j; break; }
        if (k < 0) for (let j = ids.length - 1; j >= 0; j--) if (!core.has(ids[j])) { k = j; break; }
        if (k < 0) continue;
        ids = [...ids.slice(0, k), id, ...ids.slice(k + 1)];
      }
    }
    ids = [...new Set(ids)].filter(id => this.agents.get(id)?.on !== 'box');
    if (!goalie) {
      // Sixth attacker: prefer one already out there, so the extra man does not change on every update.
      const pool = [...this.skaters(s).map(a => a.id), ...this.teams[s].lineup.F.flat(), ...this.teams[s].players];
      const extra = pool.find(id => this.valid(id) && !ids.includes(id) && this.agents.get(id)?.on !== 'box');
      if (extra) ids.push(extra);
    }
    // Never more than the unit plus one extra attacker for a pulled goalie.
    return ids.slice(0, this.baseSkaters[s] + (goalie ? 0 : 1));
  }
  private updateRoster() {
    const stopped = this.mode === 'stop';
    const goalies = this.desiredGoalies();
    const n = this.nextIceEvent();
    const allowChange = stopped || !n || n.sec - this.g < 14;
    for (const s of [0, 1] as Side[]) {
      // Penalised players return when their time is served.
      for (const a of this.agents.values()) if (a.side === s && a.on === 'box' && this.g >= a.boxUntil - 1e-9) {
        const before = this.skaters(s).length;
        a.on = 'ice'; a.x = BOX[s].x; a.y = BOX[s].y - 0.6; a.vx = 0; a.vy = 0; a.leave = null; this.play('change', s, `${a.name} возвращается после удаления`, a);
        // The team gets its man back — unless a waiting penalty starts now and keeps it three (5-on-3 → still 3) —
        // and never a sixth skater (seventh with a pulled goalie): someone heads for the bench.
        const serving = [...this.agents.values()].filter(b => b.side === s && b !== a && (b.on === 'box' || b.leave === 'box') && b.pim < 10 && b.boxUntil > this.g + 1e-9 && b.boxUntil - b.pim * 60 <= this.g + 1e-6).length;
        this.baseSkaters[s] = Math.min(5 - Math.min(2, serving), Math.max(this.baseSkaters[s], before + 1));
        this.trimSkaters(s, this.lastGoalie[s] === null, a);
      }
      const gWant = goalies[s];
      const gNow = this.onIce(s).find(a => a.goalie);
      if (gNow && gNow.id !== gWant && !gNow.leave) gNow.leave = 'bench';
      if (gWant && !this.onIce(s).some(a => a.goalie && a.id === gWant)) {
        const old = this.onIce(s).find(a => a.goalie && a.leave);
        if (!old || dist(old, BENCH[s]) < 7) this.spawn(gWant, s, BENCH[s], true);
      }
      if (gWant !== this.lastGoalie[s] && (gWant === null || this.onIce(s).some(a => a.id === gWant))) this.lastGoalie[s] = gWant;
      // A goalie back in the net sends the extra attacker off at once, change or no change.
      this.trimSkaters(s, gWant === null);
      // A five without two defencemen at even strength (a forward out of the box, the power-play unit after the
      // penalty) is fixed by the next change at once, not only before the next event.
      const shortD = this.baseSkaters[0] === 5 && this.baseSkaters[1] === 5 && this.skaters(s).filter(a => this.kindD(a.id)).length < 2;
      // A man short with nobody on his way off (the change was cut by a whistle or a penalty): fill up at once.
      const short = this.skaters(s, true).length < this.baseSkaters[s] + (gWant === null ? 1 : 0);
      if (!allowChange && !shortD && !short) continue;
      const want = this.wantedSkaters(s, gWant);
      let changed = false;
      // The puck carrier finishes his play first, and nobody leaves his own end while the opponents attack there
      // (unless the engine needs the new man out within seconds): he is sent off on a later update.
      const urgent = stopped || !n || n.sec - this.g < 9;
      const P = this.puck, oppAttacks = (P.carrier?.side ?? P.last) === 1 - s && loc(s, P).x < RED - 4;
      for (const a of this.skaters(s)) {
        if (want.includes(a.id) || a === P.carrier) continue;
        if (!urgent && oppAttacks && dist(a, BENCH[s]) > 20) continue;
        a.leave = 'bench'; changed = true;
      }
      // A change on the fly: the new man jumps over the boards only when the one he replaces is at the bench door.
      const active = this.onIce(s).filter(a => !a.goalie && !(a.leave && dist(a, a.leave === 'box' ? BOX[s] : BENCH[s]) < 2.6));
      let count = active.length;
      for (const id of want) {
        if (count >= want.length) break;
        const a = this.agents.get(id);
        if (a?.on === 'ice' && !a.leave) continue;
        if (a?.on === 'box') continue;
        if (a?.on === 'ice' && a.leave) { a.leave = null; count++; continue; }
        this.spawn(id, s, BENCH[s]); count++; changed = true;
      }
      if (changed) { this.assignRoles(s); if (!stopped) this.play('change', s, `Смена на ходу: ${this.teamShort(s)}`); }
    }
    for (const a of this.onIce()) {
      if (!a.leave) continue;
      const gate = a.leave === 'box' ? BOX[a.side] : BENCH[a.side];
      if (dist(a, gate) < 1.8) {
        if (a.leave === 'box') { a.on = 'box'; const seat = this.boxSeat(a); a.x = seat.x; a.y = seat.y; }
        else a.on = 'bench';
        a.leave = null; a.vx = 0; a.vy = 0;
        if (this.puck.carrier === a) this.loosePuck(a.vx, a.vy);
        this.assignRoles(a.side);
      }
    }
  }
  /** Too many men: skaters beyond the unit size (+1 for a pulled goalie) head for the bench, nearest first. */
  private trimSkaters(s: Side, pulled: boolean, keep?: Agent) {
    const allowed = this.baseSkaters[s] + (pulled ? 1 : 0);
    let excess = this.skaters(s).length - allowed;
    if (excess <= 0) return;
    const out = this.skaters(s).filter(b => b !== keep && b !== this.puck.carrier && !this.plan?.chain.includes(b)).sort((p, q) => dist(p, BENCH[s]) - dist(q, BENCH[s]));
    while (excess-- > 0 && out.length) out.shift()!.leave = 'bench';
    this.assignRoles(s);
  }
  private boxSeat(a: Agent): V2 {
    const others = [...this.agents.values()].filter(b => b.side === a.side && b.on === 'box' && b !== a).length;
    return { x: BOX[a.side].x + (a.side ? 1 : -1) * (1 + others * 1.1), y: 31.4 };
  }
  /**
   * Roles from the lineup card: the slot a man is dressed in (line = [C, LW, RW], pair = [left D, right D]);
   * players from different lines (special teams) fall back on their position. Defencemen take the D spots
   * first, so a forward drops back only when a pair really is a man short.
   */
  private assignRoles(s: Side) {
    const list = this.skaters(s), L = this.teams[s].lineup;
    const slot = (a: Agent): Role | null => {
      for (const l of L.F) { const j = l.indexOf(a.id); if (j >= 0) return (['C', 'LW', 'RW'] as Role[])[j] ?? 'C'; }
      for (const p of L.D) { const j = p.indexOf(a.id); if (j >= 0) return j === 0 ? 'LD' : 'RD'; }
      if (L.u20D === a.id) return 'RD';
      if (L.u20F === a.id) return 'RW';
      return null;
    };
    const prefsOf = (a: Agent): Role[] => {
      const own = slot(a), pos = this.players[a.id]?.position ?? 'C';
      const first: Role = own ?? (pos === 'D' ? (this.players[a.id]?.hand === 'R' ? 'RD' : 'LD') : pos === 'LW' ? 'LW' : pos === 'RW' ? 'RW' : 'C');
      if (first === 'LD' || first === 'RD') return [first, first === 'LD' ? 'RD' : 'LD'];
      return [first, ...(['C', 'LW', 'RW'] as Role[]).filter(r => r !== first)];
    };
    const taken = new Set<Role>();
    const pick = (a: Agent, prefs: Role[]) => { const r = prefs.find(x => !taken.has(x)) ?? 'X'; taken.add(r); a.role = r; };
    // the dressed slot wins a contested role: men in their own slot pick first
    const order = (xs: Agent[]) => [...xs].sort((p, q) => +(slot(q) !== null) - +(slot(p) !== null));
    const defense = order(list.filter(a => this.kindD(a.id))), forwards = order(list.filter(a => !this.kindD(a.id)));
    for (const a of defense.slice(0, 2)) pick(a, prefsOf(a));
    for (const a of forwards) pick(a, [...prefsOf(a), 'LD', 'RD']);
    for (const a of defense.slice(2)) pick(a, ['C', 'LW', 'RW', 'X']);
    // 4-on-4 / 3-on-3: a lone defenceman plays the middle.
    if (list.filter(a => a.role === 'LD' || a.role === 'RD').length === 1) { const d = list.find(a => a.role === 'LD' || a.role === 'RD')!; d.role = 'LD'; }
  }

  /* --- whistles and faceoffs --- */
  private startStop(reason: Stop['reason'], dot: V2, scorer?: Agent) {
    this.mode = 'stop';
    const p = this.puck;
    p.carrier = null; p.leg = null; p.next = null; p.reserved = null; p.icing = null; p.dead = true; p.vx = 0; p.vy = 0;
    this.stop = { reason, dot: inside(dot, 2), t0: this.tau, phase: reason === 'goal' ? 'celebrate' : 'whistle', phaseAt: this.tau, scorer };
    this.zoneEntry = null;
    if (this.plan && reason !== 'goal') this.plan.acquired = false, this.plan.acqStarted = false;
  }
  private slot(a: Agent): V2 {
    const d = this.stop?.dot ?? FACEOFF_DOTS.center;
    if (a.goalie) return loc(a.side, { x: GOAL + 0.9, y: MID });
    const l = loc(a.side, d);
    const off: Record<Role, V2> = { C: { x: -0.9, y: 0 }, LW: { x: -1.3, y: -4.4 }, RW: { x: -1.3, y: 4.4 }, LD: { x: -7.2, y: -3.8 }, RD: { x: -7.2, y: 3.8 }, X: { x: -4.5, y: 1.5 } };
    const o = off[a.role];
    const list = this.skaters(a.side), same = list.filter(b => b.role === a.role), k = same.indexOf(a);
    return inside(loc(a.side, { x: Math.max(GOAL + 1.5, l.x + o.x - k * 1.5), y: l.y + o.y + k * 1.5 }), 1);
  }
  private stepStop() {
    const st = this.stop!;
    const since = this.tau - st.phaseAt;
    const p = this.puck;
    if (st.phase === 'whistle' && since > 0.9) { st.phase = 'gather'; st.phaseAt = this.tau; }
    if (st.phase === 'celebrate' && since > 3.6) {
      st.phase = 'gather'; st.phaseAt = this.tau;
      if (this.opts.suddenDeath) { this.finish(); return; }
    }
    if (st.phase !== 'whistle' && st.phase !== 'celebrate') this.updateRoster();
    for (const a of this.onIce()) {
      a.scripted = false; a.arrive = NaN;
      if (a.leave) { const gate = a.leave === 'box' ? BOX[a.side] : BENCH[a.side]; this.setT(a, gate, 0.75); continue; }
      if (st.phase === 'whistle' || (st.phase === 'celebrate' && (!st.scorer || a.side !== st.scorer.side || a.goalie))) {
        if (a.goalie) this.setT(a, loc(a.side, { x: GOAL + 0.9, y: MID }), 0.5);
        else this.setT(a, { x: a.x + a.vx * 0.5, y: a.y + a.vy * 0.5 }, 0.3);
        continue;
      }
      if (st.phase === 'celebrate') {
        const k = this.skaters(a.side).indexOf(a);
        if (a === st.scorer) this.setT(a, { x: a.x + a.vx * 0.4, y: clamp(a.y + (a.y < MID ? -2 : 2), 1, 29) }, 0.4);
        else this.setT(a, { x: st.scorer!.x + (k % 2 ? 0.9 : -0.9), y: st.scorer!.y + (k - 2) * 0.8 }, 0.75);
        continue;
      }
      this.setT(a, this.slot(a), 0.6);
    }
    if (st.phase === 'gather' || st.phase === 'set' || st.phase === 'drop') {
      const d = dist(p, st.dot);
      if (d > 0.02) { const step = Math.min(d, 7 * DT); p.x += ((st.dot.x - p.x) / d) * step; p.y += ((st.dot.y - p.y) / d) * step; }
      p.h = st.phase === 'drop' ? Math.max(0, 1.1 * (1 - (this.tau - st.phaseAt) / 0.45)) : 1.1;
    }
    if (st.phase === 'gather') {
      const ready = this.onIce().every(a => !a.leave && dist(a, this.slot(a)) < 0.9) && dist(p, st.dot) < 0.05;
      if ((ready && since > 1.2) || since > 14) { st.phase = 'set'; st.phaseAt = this.tau; }
    } else if (st.phase === 'set' && since > 0.8) { st.phase = 'drop'; st.phaseAt = this.tau; }
    else if (st.phase === 'drop' && since >= 0.45) this.dropPuck();
  }
  private dropPuck() {
    const st = this.stop!, p = this.puck;
    p.dead = false; p.h = 0; p.x = st.dot.x; p.y = st.dot.y;
    this.zoneIn = [false, false]; this.updateZones();
    const w = this.faceoffWinner();
    this.faceoffWins[w]++;
    const c = this.skaters(w).find(a => a.role === 'C') ?? this.nearest(this.skaters(w), p);
    const d = loc(w, st.dot);
    this.mode = 'play'; this.stop = null;
    this.startLeg('chip', inside(loc(w, { x: Math.max(GOAL + 2, d.x - 6), y: d.y + (this.rand() - 0.5) * 6 }), 1.5), this.g + 0.55, { by: c ?? null, exitSpeed: 2 });
    p.last = w;
    this.poss = { side: w, until: this.g + 5 + this.rand() * 8 };
    if (c) this.play('faceoff', w, `Вбрасывание выиграл ${c.name}`, c);
  }
  private faceoffWinner(): Side {
    if (this.plan) return this.plan.T;
    const n = this.next();
    if (n && (n.type === 'goal' || n.type === 'shot' || n.type === 'miss') && n.sec - this.g < 16) return n.team === this.teams[1].id ? 1 : 0;
    const c0 = this.skaters(0).find(a => a.role === 'C'), c1 = this.skaters(1).find(a => a.role === 'C');
    return this.rand() < 0.5 + ((c0?.hands ?? 62) - (c1?.hands ?? 62)) / 200 ? 0 : 1;
  }
  private finish() {
    this.mode = 'end'; this.stop = null;
    for (const e of this.all) if (!this.eventTau.has(e)) this.eventTau.set(e, this.tau);
    this.si = this.staged.length; this.ri = this.all.length;
  }

  /* --- main step --- */
  private step() {
    if (this.mode === 'play') {
      const n = this.next();
      const target = Math.min(n ? n.sec : Infinity, this.end);
      const dt = clamp(target - this.g, 1e-3, DT);
      this.tau += dt; this.g += dt;
      if (Math.abs(this.g - target) < 2e-3) this.g = target;
      this.updateRoster();
      this.pp = this.powerPlay();
      this.direct();
      this.targets();
      for (const a of this.onIce()) this.move(a, dt);
      this.movePuck(dt);
      const wasIn: [boolean, boolean] = [this.zoneIn[0], this.zoneIn[1]];
      this.updateZones();
      if (this.mode === 'play') this.checkOffside(wasIn);
      if (this.mode === 'play') this.interact();
      this.fireDue();
      if (this.mode === 'play' && this.g >= this.end - 1e-9) this.finish();
    } else if (this.mode === 'stop') {
      this.tau += DT;
      this.fireDue();
      this.stepStop();
      if (this.mode === 'stop') for (const a of this.onIce()) this.move(a, DT);
    }
    while (this.ri < this.all.length && this.all[this.ri].sec <= this.g + 1e-9) {
      const e = this.all[this.ri];
      if (this.staged.includes(e) && !this.eventTau.has(e)) break;
      if (!this.eventTau.has(e)) this.eventTau.set(e, this.tau);
      this.ri++;
    }
    this.record();
  }
  private fireDue() {
    while (this.si < this.staged.length && this.staged[this.si].sec <= this.g + 1e-9) {
      const e = this.staged[this.si++];
      this.eventTau.set(e, this.tau);
      if (e.type === 'penalty') this.doPenalty(e);
      else if (e.type === 'hit') this.doHit(e);
      else if (!this.delivered.has(e)) this.forceOutcome(e);
      if (this.plan?.ev === e) this.plan = null;
      if (this.duel?.ev === e) this.duel = null;
    }
  }
  private delivered = new Set<GameEvent>();
  /** Safety net: a shot whose sequence could not be staged (e.g. replanned 0.1 s before) still resolves. */
  private forceOutcome(e: GameEvent) {
    this.delivered.add(e);
    const T: Side = e.team === this.teams[1].id ? 1 : 0;
    if (e.type === 'goal') { this.play('goal', T, `ГОЛ! ${this.players[e.player!]?.name ?? ''}`); this.startStop('goal', FACEOFF_DOTS.center, this.agents.get(e.player!)); }
    else if (e.type === 'shot' && this.mode === 'play') { this.play('save', (1 - T) as Side, 'Сейв'); }
  }
  private doPenalty(e: GameEvent) {
    const id = e.player;
    if (!id || !this.players[id]) return;
    const s = this.sideOf(id);
    const a = this.agent(id, s);
    const pim = e.pim ?? 2;
    a.pim = pim;
    a.boxUntil = pim >= 10 ? e.sec + pim * 60 : Math.max(e.sec + 1, e.boxUntil ?? e.penUntil?.[s] ?? e.sec + pim * 60);
    // the team plays a man short until the engine's next unit says otherwise (a misconduct is replaced)
    if (pim < 10) this.baseSkaters[s] = Math.max(3, this.baseSkaters[s] - 1);
    if (a.on === 'ice') { a.leave = 'box'; if (this.puck.carrier === a) this.loosePuck(0, 0); }
    else { a.on = 'box'; const seat = this.boxSeat(a); a.x = seat.x; a.y = seat.y; }
    this.play('penalty', s, `Удаление: ${a.name}, ${pim} мин`, a);
    if (this.mode === 'play') this.startStop('penalty', zoneDot(s, this.puck.y));
  }
  private doHit(e: GameEvent) {
    const h = e.player ? this.agents.get(e.player) : undefined, v = e.players?.[0] ? this.agents.get(e.players[0]) : undefined;
    if (!h || !v || h.on !== 'ice' || v.on !== 'ice') return;
    const d = Math.max(0.3, dist(h, v)), nx = (v.x - h.x) / d, ny = (v.y - h.y) / d;
    if (d < 4.5) { v.vx += nx * 3.2; v.vy += ny * 3.2; h.vx *= 0.4; h.vy *= 0.4; }
    v.stun = d < 4.5 ? 1.1 : 0.5;
    if (this.puck.carrier === v) this.loosePuck(v.vx * 0.8 + ny * 2, v.vy * 0.8 - nx * 2);
    this.play('hit', h.side, `Силовой приём: ${h.name} — ${v.name}`, h);
  }

  /* --- director: stages the engine's events --- */
  private direct() {
    const n = this.next();
    if (!n || this.mode !== 'play') return;
    if ((n.type === 'hit' || n.type === 'penalty') && (!this.duel || this.duel.ev !== n) && n.sec - this.g <= (n.type === 'hit' ? 3.5 : 2.5)) this.makeDuel(n);
    if (n.type === 'goal' || n.type === 'shot' || n.type === 'miss') {
      if (!this.plan || this.plan.ev !== n) {
        const k = n.type === 'goal' ? (n.players?.length ?? 0) + 1 : 2;
        const spot = { x: (n.x ?? 81) * 0.6, y: (n.y ?? 50) * 0.3 };
        const lead = clamp(3.5 + (k - 1) * 1.8 + dist(this.puck, spot) / 7.5, 5, 15);
        if (n.sec - this.g <= lead) this.makePlan(n);
      }
      if (this.plan) this.runPlan();
    }
  }
  private makePlan(n: GameEvent) {
    const T: Side = n.team === this.teams[1].id ? 1 : 0;
    const ensure = (id: string) => { let a = this.agents.get(id); if (!a || a.on !== 'ice' || a.side !== T) a = this.spawn(id, T, BENCH[T]); a.leave = null; return a; };
    const S = ensure(n.player!);
    let helpers: Agent[] = [];
    if (n.type === 'goal') helpers = (n.players ?? []).filter(id => this.valid(id) && this.sideOf(id) === T).slice(0, 2).map(ensure);
    else { const mates = this.skaters(T).filter(a => a !== S); if (mates.length && this.rand() < 0.7) helpers = [mates[Math.floor(this.rand() * mates.length)]]; }
    const chain = [...helpers].reverse().concat(S);
    // The engine's players jump on if they are not out there yet: as many teammates head for the bench, never too many men.
    const allowed = this.baseSkaters[T] + (this.lastGoalie[T] === null ? 1 : 0);
    const spare = this.skaters(T).filter(a => !chain.includes(a) && a !== this.puck.carrier).sort((p, q) => dist(p, BENCH[T]) - dist(q, BENCH[T]));
    for (let excess = this.skaters(T).length - allowed; excess > 0 && spare.length; excess--) spare.shift()!.leave = 'bench';
    const type = n.shotType ?? 'wrist';
    const sl = loc(T, { x: (n.x ?? (T ? 19 : 81)) * 0.6, y: (n.y ?? 50) * 0.3 });
    sl.x = clamp(sl.x, OPP_BLUE + 1, 53.6); sl.y = clamp(sl.y, 2, 28);
    if (Math.abs(sl.y - MID) < 1.4 && sl.x > 51.8) sl.x = 51.8;
    const sideSign = sl.y < MID ? -1 : 1;
    const a1: V2 = type === 'tip' ? { x: 39.1, y: MID + sideSign * 6 } : type === 'rebound' ? { x: 43.7, y: MID - sideSign * 6 }
      : type === 'slap' ? (sl.x < 42.9 ? { x: 48.1, y: sl.y < MID ? 3.5 : 26.5 } : { x: clamp(sl.x - 1, OPP_BLUE + 1.2, 50.4), y: W - sl.y })
      : type === 'snap' ? { x: 54.1, y: MID - sideSign * 4.5 } : { x: 47.4, y: sideSign < 0 ? 4 : 26 };
    const spots = chain.map((_, i) => loc(T, inside(i === chain.length - 1 ? sl : i === chain.length - 2 ? a1 : { x: 39.4, y: sideSign < 0 ? 22 : 8 }, 1)));
    const gk = this.goalieOf((1 - T) as Side);
    let target: V2 | Agent, th: number;
    if (n.type === 'goal') {
      const gl = gk ? loc(T, gk) : { x: OPP_GOAL - 1, y: MID };
      target = loc(T, { x: OPP_GOAL + 0.05, y: MID + (gl.y >= MID ? -1 : 1) * (0.5 + this.rand() * 0.3) });
      th = type === 'rebound' || type === 'tip' ? 0.1 + this.rand() * 0.2 : 0.15 + this.rand() * 0.8;
    } else if (n.type === 'shot' && gk) { target = gk; th = 0.15 + this.rand() * 0.6; }
    else { target = loc(T, { x: OPP_GOAL + 0.3, y: MID + (this.rand() < 0.5 ? -1 : 1) * (2 + this.rand() * 1.5) }); th = 0.1; }
    const flight = clamp(dist(spots[spots.length - 1], target) / (SHOT_SPEED[type] ?? 26), 0.15, 1.2);
    const tr = n.sec - flight;
    const rel: number[] = [], arr: number[] = [];
    let t = tr - (CATCH[type] ?? 0.5);
    for (let i = chain.length - 2; i >= 0; i--) {
      arr[i] = t;
      rel[i] = t - clamp(dist(spots[i], spots[i + 1]) / (type === 'tip' && i === chain.length - 2 ? 28 : 17), 0.25, 1.5);
      t = rel[i] - 1.0;
    }
    const first = chain.length > 1 ? rel[0] : tr, earliest = this.g + 1.4;
    if (first < earliest && chain.length > 1) {
      const k = Math.max(0.05, Math.min(1, (tr - earliest) / Math.max(0.01, tr - first)));
      for (let i = 0; i < rel.length; i++) { rel[i] = tr - (tr - rel[i]) * k; arr[i] = tr - (tr - arr[i]) * k; }
    }
    this.plan = { ev: n, T, chain, spots, rel, arr, tr, target, th, step: 0, acquired: false, acqStarted: false, shot: false };
  }
  private cancelPlan() {
    const leg = this.puck.leg;
    if (leg && leg.kind === 'shot' && leg.event === this.plan?.ev) {
      const s = leg.by?.side ?? 0;
      leg.kind = 'wide'; leg.event = undefined; leg.exitSpeed = 14;
      leg.to = loc(s, { x: OPP_GOAL + 0.3, y: MID + (loc(s, this.puck).y < MID ? -2.5 : 2.5) });
    }
    this.plan = null;
  }
  private runPlan() {
    const pl = this.plan!, p = this.puck, S = pl.chain[pl.chain.length - 1];
    if (pl.shot) return;
    // a later link already has the puck (e.g. the shooter itself): skip ahead in the chain
    const ahead = p.carrier ? pl.chain.indexOf(p.carrier) : -1;
    if (ahead > pl.step) { pl.step = ahead; pl.acquired = true; pl.acqStarted = true; }
    const holder = pl.chain[pl.step];
    if (p.carrier === holder) pl.acquired = true;
    if (!pl.acquired && (!pl.acqStarted || (!p.leg && !p.carrier && p.reserved !== holder))) {
      pl.acqStarted = true;
      const due = clamp(Math.min(pl.chain.length > 1 && pl.step < pl.chain.length - 1 ? pl.rel[pl.step] : pl.tr, this.g + 1.6) - 0.3, this.g + 0.35, this.g + 1.6);
      if (p.carrier && p.carrier.side !== pl.T && dist(p.carrier, holder) < 2.2) { this.take(holder, 'takeaway'); pl.acquired = true; }
      else if (p.carrier) {
        const own = p.carrier.side === pl.T;
        if (!own) this.play('interception', pl.T, `Потеря: ${p.carrier.name}, шайбу подбирает ${holder.name}`, holder);
        this.startLeg(own ? 'pass' : 'giveaway', holder, due, { protect: true, exitSpeed: 3 });
      } else if (p.leg) { if (p.leg.kind !== 'shot') p.reserved = holder; else pl.acqStarted = false; }
      else { p.reserved = holder; if (dist(p, holder) > 5) this.startLeg('giveaway', holder, due, { protect: true, by: null, exitSpeed: 2 }); }
    }
    if (pl.acquired && p.carrier === holder && pl.step < pl.chain.length - 1 && this.g >= pl.rel[pl.step] - 1e-9 && this.onsideOk(holder, pl.chain[pl.step + 1])) {
      this.startLeg('pass', pl.chain[pl.step + 1], Math.max(this.g + 0.2, pl.arr[pl.step]), { protect: true, exitSpeed: 4 });
      pl.step++; pl.acquired = false; pl.acqStarted = true;
    }
    // release no later than the moment a realistic shot speed still reaches the net exactly at the event second
    const vmax = (SHOT_SPEED[pl.ev.shotType ?? 'wrist'] ?? 26) * 1.25, tgt = isAgent(pl.target) ? pl.target : pl.target;
    const fly = dist(this.blade(S), tgt) / vmax;
    if (p.carrier === S && pl.step === pl.chain.length - 1 && this.g >= Math.min(pl.tr, pl.ev.sec - fly) - 1e-9) this.releaseShot(false);
    else if (!pl.shot && p.carrier !== S) {
      const from = p.carrier ? this.blade(p.carrier) : p;
      const need = dist(from, this.blade(S)) / 30 + fly + 0.1;
      if (this.g >= pl.ev.sec - Math.max(0.3, need)) this.releaseShot(true);
    }
  }
  private releaseShot(emergency: boolean) {
    const pl = this.plan!, S = pl.chain[pl.chain.length - 1];
    const via = emergency && this.puck.carrier !== S ? S : undefined;
    let tv: number | undefined;
    if (via) {
      // a one-timer: split the remaining time by leg length so both legs travel at a similar speed
      const p = this.puck, from = p.carrier ? this.blade(p.carrier) : { x: p.x, y: p.y }, b = this.blade(S);
      const d1 = dist(from, b), d2 = dist(b, isAgent(pl.target) ? pl.target : pl.target), left = Math.max(0.05, pl.ev.sec - this.g);
      tv = this.g + left * clamp(d1 / Math.max(0.1, d1 + d2 * 0.75), 0.25, 0.8);
    }
    this.startLeg('shot', pl.target, pl.ev.sec, { by: S, h1: pl.th, arc: pl.ev.shotType === 'slap' ? 0.12 : 0.06, protect: true, event: pl.ev, via, tv });
    pl.shot = true;
    this.releaseTau.set(pl.ev, via ? this.tau + (tv! - this.g) : this.tau);
  }
  private makeDuel(n: GameEvent) {
    const actor = n.player ? this.agents.get(n.player) : undefined;
    if (!actor || actor.on !== 'ice') return;
    let victim = n.players?.[0] ? this.agents.get(n.players[0]) ?? null : null;
    if (!victim || victim.on !== 'ice') {
      const c = this.puck.carrier;
      victim = c && c.side !== actor.side ? c : this.nearest(this.skaters((1 - actor.side) as Side), actor);
    }
    this.duel = { ev: n, kind: n.type === 'hit' ? 'hit' : 'penalty', actor, victim };
  }
  private desiredSide(): Side {
    if (this.plan) return this.plan.T;
    const n = this.next();
    if (n && (n.type === 'goal' || n.type === 'shot' || n.type === 'miss') && n.sec - this.g < 18) return n.team === this.teams[1].id ? 1 : 0;
    if (this.g >= this.poss.until) {
      let side: Side = this.rand() < 0.65 ? ((1 - this.poss.side) as Side) : this.poss.side;
      // The power play owns the puck most of the time and keeps it longer.
      const pp = this.pp;
      if (pp !== null && this.rand() < 0.72) side = pp;
      this.poss = { side, until: this.g + (pp !== null && side === pp ? 9 + this.rand() * 12 : 4 + this.rand() * 6) };
    }
    return this.poss.side;
  }

  /* --- positioning --- */
  private setT(a: Agent, p: V2, urg: number, by = NaN, vel?: V2) {
    const c = a.goalie ? p : inside(p, 0.9);
    a.tx = c.x; a.ty = c.y; a.urg = urg; a.arrive = by; a.fvx = vel?.x ?? 0; a.fvy = vel?.y ?? 0;
  }
  /** Attackers never precede the puck over the offensive blue line. */
  private puckLocal(s: Side): V2 { return loc(s, this.puck); }
  private onsideClamp(a: Agent, p: V2, carrier = false): V2 {
    const l = loc(a.side, p);
    if (this.early && this.early.a.side === a.side && (this.early.a === a || this.puck.carrier === a)) return p;
    if (!this.zoneIn[a.side]) {
      if (carrier && this.puck.carrier === a) {
        if (this.skaters(a.side).some(m => m !== a && loc(a.side, m).x > OPP_BLUE - 0.3)) l.x = Math.min(l.x, OPP_BLUE - 0.9);
      } else l.x = Math.min(l.x, OPP_BLUE - 0.7);
    }
    return loc(a.side, l);
  }
  /** Hard offside rule: nobody crosses the attacking blue line ahead of the puck; the carrier waits for teammates to tag up. */
  private updateZones() {
    for (const s of [0, 1] as Side[]) {
      const x = this.puckLocal(s).x;
      if (x > OPP_BLUE) this.zoneIn[s] = true;
      else if (x < OPP_BLUE - 0.3) { this.zoneIn[s] = false; if (this.oz.side === s) this.oz.side = -1; }
    }
  }
  private keepOnside(a: Agent, prevX: number) {
    const l = loc(a.side, a);
    if (this.zoneIn[a.side]) return;
    if (this.early && this.early.a.side === a.side && (this.early.a === a || this.puck.carrier === a)) return;
    let lim = Infinity;
    // never pulled backwards (no teleport): at worst a skater is held where he already was
    if (this.puck.carrier === a) {
      if (this.skaters(a.side).some(m => m !== a && loc(a.side, m).x > OPP_BLUE)) lim = Math.max(OPP_BLUE - 1.3, prevX);
    } else if (prevX <= OPP_BLUE) lim = Math.max(OPP_BLUE - 0.05, prevX);
    if (l.x > lim) {
      l.x = lim; const g = loc(a.side, l); a.x = g.x; a.y = g.y;
      if (a.side === 0 ? a.vx > 0 : a.vx < 0) a.vx = 0;
    }
  }
  private onsideOk(passer: Agent, receiver: Agent) {
    return this.zoneIn[passer.side] || loc(passer.side, receiver).x < OPP_BLUE - 0.3;
  }
  /** An offside whistle may only fall where it cannot disturb the engine's next shot sequence. */
  private offsideRoom(): boolean {
    if (this.plan || this.duel || this.mode !== 'play') return false;
    const n = this.next();
    return !n || n.sec - this.g > 16;
  }
  /** Carrier approaching the blue line: now and then a winger cheats and crosses before the puck. */
  private maybeJumpEarly(a: Agent) {
    if (this.early || this.g < this.offsideQuiet || !this.offsideRoom() || this.rand() > 0.1) return;
    const s = a.side, me = loc(s, a);
    if (me.x < OPP_BLUE - 9 || me.x > OPP_BLUE - 2.5) return;
    const cheat = this.skaters(s).filter(m => m !== a && !this.isD(m) && m.stun <= 0).sort((p, q) => loc(s, q).x - loc(s, p).x)[0];
    if (!cheat) return;
    this.early = { a: cheat, until: this.g + 4 };
    this.carryTarget.set(a.id, loc(s, { x: OPP_BLUE + 4, y: clamp(me.y, 5, 25) }));
  }
  /** The puck has just entered side s's attacking zone with a teammate already over the line: offside. */
  private checkOffside(wasIn: [boolean, boolean]) {
    const e = this.early;
    if (e && (this.g > e.until || e.a.on !== 'ice' || e.a.leave || this.puck.carrier?.side !== e.a.side && !(this.puck.leg && this.puck.leg.by?.side === e.a.side))) this.early = null;
    for (const s of [0, 1] as Side[]) {
      if (wasIn[s] || !this.zoneIn[s]) continue;
      const p = this.puck, by = p.carrier ?? p.leg?.by ?? null;
      if (!by || by.side !== s) continue;
      const over = this.skaters(s).filter(m => m !== p.carrier && loc(s, m).x > OPP_BLUE + RINK.blueWidth / 2 + 0.1);
      if (!over.length) { if (this.early?.a.side === s) this.early = null; continue; }
      if (!this.offsideRoom()) continue;
      const who = over.sort((m, q) => loc(s, q).x - loc(s, m).x)[0];
      this.offsides[s]++;
      this.play('offside', s, `Офсайд: ${who.name} (${this.teamShort(s)}), вбрасывание в средней зоне`, who);
      this.early = null; this.offsideQuiet = this.g + 60;
      this.zoneIn[s] = false;
      this.startStop('offside', neutralDot(s, p.y));
      return;
    }
  }
  private defendSpot(a: Agent): { p: V2; urg: number; vel?: V2 } {
    const P = this.puckLocal(a.side), s = a.side;
    // Penalty killers do not forecheck: one man angles the carrier, the rest wait at their own blue line.
    const style = this.pp === 1 - s ? 'trap' : this.opts.tactics?.()[s].forecheck ?? 'balanced';
    let t: V2;
    if (this.pp === s && P.x > OPP_BLUE - 1) {
      // Power play without the puck in the zone: the points hold the blue line, the forwards hunt the puck.
      t = ({ LD: { x: OPP_BLUE + 0.9, y: 7.5 }, RD: { x: OPP_BLUE + 0.9, y: 22.5 }, C: { x: P.x - 1, y: P.y }, LW: { x: P.x - 3.5, y: clamp(P.y - 5.5, 2, 28) }, RW: { x: P.x - 3.5, y: clamp(P.y + 5.5, 2, 28) }, X: { x: OPP_BLUE + 3, y: MID } } as Record<Role, V2>)[a.role];
      return { p: loc(s, t), urg: 0.85 };
    }
    if (P.x <= BLUE) {
      const puckSideD = (a.role === 'LD' && P.y < MID) || (a.role === 'RD' && P.y >= MID);
      t = ({
        LD: puckSideD ? { x: Math.max(GOAL + 1, P.x - 1.2), y: P.y + (MID - P.y) * 0.15 } : { x: GOAL + 2.5, y: MID - 1.5 },
        RD: puckSideD ? { x: Math.max(GOAL + 1, P.x - 1.2), y: P.y + (MID - P.y) * 0.15 } : { x: GOAL + 2.5, y: MID + 1.5 },
        C: { x: 11.1, y: MID + (P.y - MID) * 0.35 }, LW: { x: 20.8, y: 6.5 }, RW: { x: 20.8, y: 23.5 }, X: { x: 9.6, y: MID },
      } as Record<Role, V2>)[a.role];
    } else if (P.x <= OPP_BLUE) {
      const me = loc(s, a), p = this.puck, opp = p.carrier && p.carrier.side !== s ? p.carrier : null;
      if (this.isD(a) && opp && this.pp !== 1 - s) {
        // Gap control: the defencemen skate backwards in front of the rush, the puck-side man on the carrier's
        // inside lane, his partner covering the middle; the gap shrinks as the carrier nears the blue line.
        const gap = clamp(3 + (P.x - BLUE) * 0.4, 3, 8.5), puckSide = (a.role === 'LD') === (P.y < MID);
        const y = puckSide ? P.y + (MID - P.y) * 0.3 : MID + (a.role === 'LD' ? -3 : 3) + (P.y - MID) * 0.25;
        const v = loc(s, { x: L / 2 + opp.vx, y: W / 2 + opp.vy }), back = Math.min(0, v.x - L / 2);
        const vel = loc(s, { x: L / 2 + back, y: W / 2 + (puckSide ? (v.y - W / 2) * 0.6 : 0) });
        return { p: loc(s, { x: Math.max(GOAL + 3, P.x - gap), y }), urg: 1, vel: { x: vel.x - L / 2, y: vel.y - W / 2 } };
      }
      t = ({ LD: { x: Math.min(P.x - 7, 23.4), y: 10.5 }, RD: { x: Math.min(P.x - 7, 23.4), y: 19.5 }, C: { x: P.x - 3, y: MID + (P.y - MID) * 0.6 }, LW: { x: P.x - 4, y: 7 }, RW: { x: P.x - 4, y: 23 }, X: { x: P.x - 5, y: MID } } as Record<Role, V2>)[a.role];
      // Backcheck: a forward caught up ice skates back hard, a skater already goal-side of the puck gets set.
      return { p: loc(s, t), urg: me.x > P.x - 1.5 ? 1 : 0.85 };
    } else if (style === 'aggressive') {
      t = ({ C: { x: P.x - 1, y: P.y }, LW: { x: P.x - 3.5, y: clamp(P.y - 6, 2, 28) }, RW: { x: P.x - 3.5, y: clamp(P.y + 6, 2, 28) }, LD: { x: 36.6, y: 9 }, RD: { x: 36.6, y: 21 }, X: { x: 35.5, y: MID } } as Record<Role, V2>)[a.role];
    } else if (style === 'balanced') {
      t = ({ C: { x: P.x - 1.5, y: P.y }, LW: { x: 34.4, y: 8 }, RW: { x: 34.4, y: 22 }, LD: { x: 31.1, y: 10 }, RD: { x: 31.1, y: 20 }, X: { x: 32.2, y: MID } } as Record<Role, V2>)[a.role];
    } else {
      t = ({ C: { x: 33.3, y: MID }, LW: { x: 31.1, y: 7 }, RW: { x: 31.1, y: 23 }, LD: { x: 26.7, y: 10 }, RD: { x: 26.7, y: 20 }, X: { x: 28.9, y: MID } } as Record<Role, V2>)[a.role];
    }
    return { p: loc(s, t), urg: 0.75 };
  }
  private goalieTarget(a: Agent) {
    const p = this.puck, s = a.side, P = loc(s, p);
    let t: V2;
    const leg = p.leg;
    if (leg && leg.kind === 'shot' && leg.by && leg.by.side !== s) {
      const end = loc(s, this.legTarget(leg));
      if (leg.event?.type === 'goal') t = { x: GOAL + 0.7, y: loc(s, a).y + (end.y - loc(s, a).y) * 0.35 };
      else t = loc(s, a);
    } else if (P.x < GOAL) t = { x: GOAL + 0.35, y: MID + (P.y < MID ? -0.75 : 0.75) };
    else {
      const dx = P.x - GOAL, dy = P.y - MID, d = Math.hypot(dx, dy) || 1, depth = d < 5 ? 0.6 : 1.25;
      t = { x: GOAL + (dx / d) * depth, y: clamp(MID + (dy / d) * depth, MID - 1.4, MID + 1.4) };
    }
    this.setT(a, loc(s, t), 1);
  }
  private targets() {
    const p = this.puck, pl = this.plan, du = this.duel;
    for (const a of this.onIce()) { a.scripted = false; a.arrive = NaN; }
    for (const a of this.onIce()) {
      if (a.leave) { this.setT(a, a.leave === 'box' ? BOX[a.side] : BENCH[a.side], a.leave === 'bench' ? 1 : 0.8); a.scripted = true; }
      else if (a.goalie) { this.goalieTarget(a); a.scripted = true; }
    }
    if (pl) pl.chain.forEach((a, i) => {
      if (a.on !== 'ice' || a.leave || i < pl.step) return;
      if (i === pl.step && !pl.acquired && p.carrier !== a) this.setT(a, p.leg ? this.legTarget(p.leg) : p, 1);
      else if (i === pl.step) this.setT(a, this.onsideClamp(a, pl.spots[i], true), 0.95, i === pl.chain.length - 1 ? pl.tr : pl.rel[i]);
      else this.setT(a, this.onsideClamp(a, pl.spots[i]), 1, pl.arr[i - 1]);
      a.scripted = true;
    });
    if (du && du.actor.on === 'ice' && !du.actor.leave && du.victim?.on === 'ice') {
      const left = Math.max(0.1, du.ev.sec - this.g), v = du.victim;
      this.setT(du.actor, { x: v.x + v.vx * left, y: v.y + v.vy * left }, 1, du.ev.sec);
      du.actor.scripted = true;
    }
    const carrier = p.carrier;
    if (carrier && !carrier.scripted) this.carrierAct(carrier);
    const chasers = new Set<Agent>();
    if (!carrier && !p.dead) {
      const spot = p.leg ? this.legTarget(p.leg) : { x: p.x + p.vx * 0.4, y: p.y + p.vy * 0.4 };
      for (const s of [0, 1] as Side[]) {
        const free = this.skaters(s).filter(a => !a.scripted);
        const c = p.reserved && p.reserved.side === s ? p.reserved : this.nearest(free, spot);
        if (c && (!p.leg || p.leg.kind !== 'pass' || p.leg.to !== c)) { this.setT(c, spot, 1); chasers.add(c); c.scripted = true; }
      }
    }
    const ps: Side | null = carrier?.side ?? (p.leg?.by?.side ?? p.last);
    // the defender nearest the carrier pressures goal-side; the rest hold structure
    const presser = carrier ? this.nearest(this.skaters((1 - carrier.side) as Side).filter(a => !a.scripted), carrier) : null;
    let pressing = false;
    if (presser && carrier) {
      const style = this.opts.tactics?.()[presser.side].forecheck ?? 'balanced';
      const cl = loc(presser.side, carrier), far = dist(presser, carrier);
      // Take away time and space: skate to where the carrier will be, not where he is, and arrive on his
      // net side (inside shoulder) with a stick length of gap — tight in the own zone, a little more up ice.
      const lead = clamp(far / Math.max(1, presser.max), 0, 0.9);
      const fut = inside({ x: carrier.x + carrier.vx * lead, y: carrier.y + carrier.vy * lead }, 0.6);
      const own = loc(presser.side, { x: GOAL, y: MID }), dx = own.x - fut.x, dy = own.y - fut.y, d = Math.hypot(dx, dy) || 1;
      const gap = cl.x < BLUE + 2 ? 0.7 : 1.1;
      // A penalty killer leaves the box only for a puck he can reach, or one low on the wall / behind the net.
      const pkHold = this.pp === carrier.side && cl.x <= BLUE + 1.5 && far > 4.2 && !(cl.x < GOAL + 1.5 || (cl.x < GOAL + 8 && Math.abs(cl.y - MID) > 10));
      if (!(style === 'trap' && cl.x > RED + 4) && !pkHold) {
        this.setT(presser, { x: fut.x + (dx / d) * gap, y: fut.y + (dy / d) * gap }, 1, NaN, far < 5 ? { x: carrier.vx, y: carrier.vy } : undefined);
        pressing = true;
      }
    }
    for (const side of [0, 1] as Side[]) {
      const free = this.skaters(side).filter(a => !a.scripted && a !== carrier && !(pressing && a === presser));
      if (ps === side) this.attackShape(side, free);
      else this.defendShape(side, free, pressing ? carrier : null);
    }
    const e = this.early;
    if (e && !e.a.scripted && e.a !== carrier) {
      const l = loc(e.a.side, e.a);
      this.setT(e.a, loc(e.a.side, { x: Math.max(l.x + 2, OPP_BLUE + 2.5), y: l.y < MID ? 6 : 24 }), 1);
    }
  }

  /** Slow per-player wander (±amp m, 4–7 s period) so nobody freezes on a spot. Deterministic in game time. */
  private drift(a: Agent, amp: number): V2 {
    let h = 7;
    for (let i = 0; i < a.id.length; i++) h = (Math.imul(h, 31) + a.id.charCodeAt(i)) | 0;
    const ph = ((h & 1023) / 1023) * Math.PI * 2, w = 0.9 + (((h >>> 10) & 255) / 255) * 0.6;
    return { x: Math.sin(this.g * w + ph) * amp, y: Math.cos(this.g * w * 0.73 + ph * 1.7) * amp * 0.8 };
  }
  private isD(a: Agent) { return a.role === 'LD' || a.role === 'RD'; }
  /** Team in possession: point men, a puck-side support option, a net-front/back-door threat; lanes; breakout outlets. */
  private attackShape(s: Side, free: Agent[]) {
    if (!free.length) return;
    const p = this.puck, fut = p.leg ? this.legTarget(p.leg) : p, P = loc(s, fut);
    const recv = p.leg && (p.leg.kind === 'pass' || p.leg.kind === 'giveaway') && isAgent(p.leg.to) ? p.leg.to : null;
    const owner = p.carrier ?? recv;
    const carrierIsD = !!owner && owner.side === s && this.isD(owner);
    const low = P.y < MID, sideY = (k: number) => (low ? k : W - k);
    const put = (a: Agent, t: V2, urg: number, amp: number) => {
      const d = this.drift(a, amp);
      this.setT(a, this.onsideClamp(a, loc(s, { x: t.x + d.x, y: t.y + d.y })), urg);
    };
    if ((this.zoneIn[s] || P.x >= OPP_BLUE) && this.pp === s) {
      // Power play set up in the zone: everybody to his spot of the formation.
      for (const a of free) {
        const t = this.ppSpot(a, P), d = this.drift(a, 0.45);
        this.setT(a, this.onsideClamp(a, loc(s, { x: t.x + d.x, y: t.y + d.y })), 0.72);
      }
      return;
    }
    if (this.zoneIn[s] || P.x >= OPP_BLUE) {
      const style = this.opts.tactics?.()[s].style ?? 'balanced', sl = style === 'cycle' ? 1.2 : style === 'shoot' ? -1 : 0;
      for (const a of free.filter(x => this.isD(x))) {
        const left = a.role === 'LD', strong = left === low;
        const y = left ? (strong ? clamp(P.y * 0.35 + 3, 3.5, 8) : 11.5) : (strong ? clamp(W - (W - P.y) * 0.35 - 3, 22, 26.5) : 18.5);
        const pinch = strong && P.x > 46.6 && Math.abs(P.y - MID) > 9 ? 3.5 : 0;
        put(a, { x: OPP_BLUE + 2.5 + pinch, y }, 0.65, 0.9);
      }
      const fw = free.filter(x => !this.isD(x)).sort((a, b) => dist(loc(s, a), P) - dist(loc(s, b), P));
      fw.forEach((a, i) => {
        let t: V2;
        if (carrierIsD) t = i === 0 ? { x: 51.3, y: MID + (low ? -1.3 : 1.3) } : i === 1 ? { x: 48.9, y: sideY(5) } : { x: 45.9, y: W - sideY(8) };
        else if (i === 0) t = P.x > 48.1 ? { x: Math.max(42.2, P.x - 9) + sl, y: sideY(4.2) } : { x: 54.5, y: sideY(7) };
        else if (i === 1) t = Math.sin(this.g * 0.31 + (a.id.length * 1.7)) > 0.3 ? { x: 52.1, y: W - sideY(9.5) } : { x: 51.3 - Math.max(0, sl), y: MID + (low ? 1.5 : -1.5) };
        else t = { x: 45.2 + sl * 0.8, y: MID - (P.y - MID) * 0.2 };
        put(a, t, i === 0 ? 0.78 : 0.62, i === 1 ? 0.7 : 1.3);
      });
    } else if (P.x >= BLUE) {
      for (const a of free) {
        const t: V2 = this.isD(a) ? { x: P.x - 7, y: a.role === 'LD' ? 10 : 20 }
          : a.role === 'LW' ? { x: P.x + 4.5, y: 4.2 } : a.role === 'RW' ? { x: P.x + 4.5, y: 25.8 }
          : { x: P.x + 1.5, y: MID - (P.y - MID) * 0.5 };
        put(a, t, 0.88, 0.6);
      }
    } else {
      for (const a of free) {
        let t: V2;
        if (a.role === 'LW' || a.role === 'RW') { const strong = (a.role === 'LW') === low; t = { x: strong ? 18.3 : 23.2, y: a.role === 'LW' ? 2.7 : 27.3 }; }
        else if (a.role === 'C' || a.role === 'X') t = { x: clamp(P.x + 5, 11, 24.5), y: MID + (low ? 4 : -4) };
        else if (carrierIsD) t = { x: GOAL + 2, y: W - sideY(6) };
        else t = { x: Math.max(GOAL + 1.5, P.x - 3), y: a.role === 'LD' ? (low ? P.y + 2.5 : 8) : (low ? 22 : P.y - 2.5) };
        put(a, t, 0.75, 0.6);
      }
    }
  }
  /** Team without the puck: zone coverage marks attackers goal-side (no pile in the crease); elsewhere gap and forecheck. */
  private defendShape(s: Side, free: Agent[], pressed: Agent | null) {
    if (!free.length) return;
    const P = this.puckLocal(s), net: V2 = { x: GOAL + 0.5, y: MID };
    if (this.pp === 1 - s && P.x <= BLUE + 1.5) { this.pkShape(s, free, pressed); return; }
    if (P.x > BLUE + 1.5) {
      for (const a of free) { const spot = this.defendSpot(a), d = this.drift(a, spot.vel ? 0 : 0.35); this.setT(a, { x: spot.p.x + d.x, y: spot.p.y + d.y }, spot.urg, NaN, spot.vel); }
      return;
    }
    const attackers = this.skaters((1 - s) as Side).filter(o => o !== pressed).map(o => ({ o, l: loc(s, o) }));
    // Man coverage, goal-side and in the lane: tight (a body length) on a man near the crease, a few metres off
    // a man at the point — close enough to get a stick in the shooting lane, never chasing him into a corner.
    const markSpot = (l: V2) => { const dn = dist(l, net) || 1, g = dn < 9 ? Math.min(1.1, dn * 0.3) : Math.min(3.2, dn * 0.22); return { x: l.x + ((net.x - l.x) / dn) * g, y: l.y + ((net.y - l.y) / dn) * g }; };
    const left = new Set(free), open = new Set(attackers);
    while (left.size && open.size) {
      let best: [Agent, (typeof attackers)[number]] | null = null, bc = 1e9;
      for (const a of left) for (const t of open) {
        const near = dist(t.l, net) < 9;
        const c = dist(loc(s, a), markSpot(t.l)) + (this.isD(a) ? (near ? -2 : 3) : near ? 1.5 : 0);
        if (c < bc) { bc = c; best = [a, t]; }
      }
      if (!best) break;
      const [a, t] = best, m = markSpot(t.l);
      // shadow the man: move with him rather than chase where he was
      this.setT(a, loc(s, { x: Math.max(GOAL + 0.8, m.x), y: m.y }), 0.95, NaN, { x: t.o.vx, y: t.o.vy });
      left.delete(a); open.delete(t);
    }
    let k = 0;
    for (const a of left) { const d = this.drift(a, 0.4); this.setT(a, loc(s, { x: GOAL + 4 + k * 2, y: MID + (k % 2 ? 2.5 : -2.5) + d.y }), 0.8); k++; }
  }

  /* --- puck carrier decisions --- */
  private carrierAct(a: Agent) {
    const s = a.side, me = loc(s, a), keep = this.desiredSide() === s;
    const opps = this.skaters((1 - s) as Side), mates = this.skaters(s).filter(m => m !== a);
    const pressure = Math.min(99, ...opps.map(o => dist(o, a)));
    const sh = this.skaters(s).length < opps.length;
    if (this.g >= (this.decideAt.get(a.id) ?? 0)) {
      // Read and react: a carrier with a man on him decides in a blink, an unpressured one reads the play a little
      // longer — but nobody stands still with the puck.
      this.decideAt.set(a.id, this.g + (pressure < 2.2 ? 0.2 + this.rand() * 0.25 : pressure < 4.5 ? 0.4 + this.rand() * 0.4 : 0.7 + this.rand() * 0.6));
      const r = this.rand();
      const allOnside = mates.every(m => loc(s, m).x <= OPP_BLUE);
      // Penalty killers get rid of the puck (no icing for them) unless the engine has a short-handed chance coming.
      const pkClear = sh && this.pp !== null && !this.plan && this.shotSoon() !== s && this.rand() < 0.85;
      // Under a forecheck the puck moves: a quick pass to the open man before the stick arrives.
      if (pressure < 2.2 && !pkClear && this.pp !== s && this.rand() < (keep ? 0.5 : 0.35) && this.passBest(a, true)) return;
      if (me.x < BLUE) {
        if ((!keep && r < 0.5) || pkClear) {
          const long = sh || r < 0.12;
          this.startLeg(long ? 'clear' : 'chip', loc(s, long ? { x: 57.1, y: me.y < MID ? 4 : 26 } : { x: 31.1, y: me.y < MID ? 1.5 : 28.5 }), this.g + (long ? 2.2 : 1.1), { exitSpeed: long ? 9 : 5, icing: long && !sh ? s : null });
          this.play(long ? 'clear' : 'dump', s, long ? `${a.name} выбрасывает шайбу из зоны` : `${a.name} выводит шайбу по борту`, a);
          return;
        }
        if (pressure < 4 || r < 0.35) { if (this.passBest(a, keep)) return; }
        this.carryTarget.set(a.id, loc(s, { x: me.x + 11, y: me.y < MID ? 6 : 24 }));
      } else if (me.x < OPP_BLUE) {
        this.maybeJumpEarly(a);
        if (this.early?.a.side === s) { /* the cheating winger is already gone: carry it in */ }
        else if (!allOnside) this.carryTarget.set(a.id, loc(s, { x: Math.min(me.x + 2, OPP_BLUE - 1), y: me.y }));
        else if ((!keep && r < 0.55) || pkClear) {
          const fromOwnHalf = me.x < RED;
          this.startLeg('dump', loc(s, { x: 57.6, y: me.y < MID ? 3 : 27 }), this.g + 1.5, { exitSpeed: 8, icing: fromOwnHalf && !sh ? s : null, arc: 0.4 });
          this.play('dump', s, `${a.name} вбрасывает шайбу в зону`, a);
          return;
        } else if (keep && pressure < 2.6 && r < 0.3 && me.x > BLUE + 3 && this.regroup(a)) return;
        else if (pressure < 3.5 && r < 0.6 && this.passBest(a, keep)) return;
        else this.carryTarget.set(a.id, loc(s, { x: me.x + 10, y: clamp(me.y + (this.rand() - 0.5) * 6, 4, 26) }));
      } else {
        if (!keep) {
          if (r < 0.45) { this.freeShot(a); return; }
          if (r < 0.75 && this.passBest(a, false)) return;
          this.carryTarget.set(a.id, loc(s, { x: 47.4, y: MID }));
        } else if (this.pp === s) this.ppKeep(a, me, pressure, r);
        else this.ozKeep(a, me, pressure, r);
      }
    }
    let t = this.carryTarget.get(a.id) ?? loc(s, { x: me.x + 6, y: me.y });
    // Puck protection: with a checker on his hip the carrier curls away from him, shielding the puck with his body.
    const o = pressure < 2.2 && me.x < OPP_BLUE ? this.nearest(opps, a) : null;
    if (o) {
      const dx = a.x - o.x, dy = a.y - o.y, d = Math.hypot(dx, dy) || 1;
      t = { x: a.x + (dx / d) * 3 + (t.x - a.x) * 0.5, y: a.y + (dy / d) * 3 + (t.y - a.y) * 0.5 };
    }
    this.setT(a, this.onsideClamp(a, t, true), keep || o ? 0.92 : 0.75);
  }
  /**
   * Offensive-zone possession the engine wants kept until its next shot event. Real teams cycle, walk the
   * boards, go low-to-high and throw pucks at the net — they don't ping-pong tape-to-tape passes around the crease.
   * Passing gets rarer the longer the possession lasts; shots taken here go wide or are blocked (never on goal).
   */
  private ozKeep(a: Agent, me: V2, pressure: number, r: number) {
    const s = a.side, oz = this.oz;
    if (oz.side !== s) { oz.side = s; oz.t0 = this.g; oz.passes = 0; oz.lastPasser = ''; }
    const age = this.g - oz.t0, n = oz.passes, top = me.y < MID;
    const slot = me.x > 43.5 && Math.abs(me.y - MID) < 6.5, point = me.x < 43.7 && !slot, behind = me.x > OPP_GOAL - 0.5;
    const passW = (n < 2 ? 0.5 : n < 4 ? 0.28 : 0.12) * (pressure < 2.2 ? 1.6 : 1);
    if (slot && r < (age > 5 ? 0.35 : 0.14)) { this.freeShot(a); return; }
    if (point && r < (age > 7 ? 0.22 : 0.07)) { this.freeShot(a); return; }
    if (this.rand() < passW && this.passBest(a, true)) return;
    let t: V2;
    if (behind) t = { x: OPP_GOAL + 1.6, y: top ? MID + 4.5 : MID - 4.5 }; // walk out the other side of the cage
    else if (point) t = this.rand() < 0.5 ? { x: 40, y: clamp(me.y + (top ? 7 : -7), 4, 26) } : { x: 45.2, y: top ? 9.5 : 20.5 }; // walk the line / step down
    else if (me.x > 48.9 && Math.abs(me.y - MID) > 7) t = r < 0.55 ? { x: OPP_GOAL + 2.3, y: top ? MID - 3 : MID + 3 } : { x: 43.7, y: top ? 2.8 : 27.2 }; // cycle: behind the net or up the wall
    else if (slot) t = { x: 45.9, y: top ? 7 : 23 }; // peel off to the half-wall
    else t = { x: Math.min(me.x + 5, 54.1), y: top ? 3.5 : 26.5 };
    if (pressure < 2.2) { const o = this.nearest(this.skaters((1 - s) as Side), a); if (o) { const ol = loc(s, o), dx = me.x - ol.x, dy = me.y - ol.y, d = Math.hypot(dx, dy) || 1; t = { x: me.x + (dx / d) * 4 + (t.x - me.x) * 0.3, y: me.y + (dy / d) * 4 + (t.y - me.y) * 0.3 }; } }
    this.carryTarget.set(a.id, loc(s, { x: clamp(t.x, OPP_BLUE + 1, 58), y: clamp(t.y, 1.5, 28.5) }));
  }
  /* --- special teams --- */
  /** Side of the engine's next shot if it comes within 18 s. */
  private shotSoon(): Side | null {
    const n = this.next();
    return n && (n.type === 'goal' || n.type === 'shot' || n.type === 'miss') && n.sec - this.g < 18 ? (n.team === this.teams[1].id ? 1 : 0) : null;
  }
  /** The side on the power play: more skaters by the unit sizes and on the ice, both goalies in the net. */
  private powerPlay(): Side | null {
    if (this.lastGoalie[0] === null || this.lastGoalie[1] === null) return null;
    const [b0, b1] = this.baseSkaters, n0 = this.skaters(0).length, n1 = this.skaters(1).length;
    if (b0 === b1 || n0 === n1 || (b0 > b1) !== (n0 > n1)) return null;
    return b0 > b1 ? 0 : 1;
  }
  /** Formation of side s: 1-3-1 by default, the umbrella for a shooting team; its spots in attacking-local metres. */
  private ppFormation(s: Side): { roles: PPRole[]; at: (r: PPRole, P: V2) => V2 } {
    const style = this.opts.tactics?.()[s].style ?? 'balanced';
    const n = this.skaters(s).length;
    const low = this.ppLow, sideY = (k: number) => (low ? k : W - k);
    if (style === 'shoot' && n >= 5) return {
      roles: ['P1', 'P2', 'F1', 'LOW', 'NET'],
      at: (r, P) => ({
        P1: { x: OPP_BLUE + 2.4, y: 9.5 + (P.y - MID) * 0.12 }, P2: { x: OPP_BLUE + 2.4, y: 20.5 + (P.y - MID) * 0.12 },
        F1: { x: 47.5, y: sideY(3.6) }, LOW: { x: OPP_GOAL - 0.6, y: sideY(7.5) },
        NET: { x: OPP_GOAL - 1.7, y: MID + (low ? 0.9 : -0.9) },
      } as Record<PPRole, V2>)[r],
    };
    const roles: PPRole[] = (['Q', 'F1', 'F2', 'NET', 'B'] as PPRole[]).slice(0, Math.max(2, Math.min(5, n)));
    return {
      roles,
      at: (r, P) => {
        const lean = (P.y - MID) * 0.22;
        // the flank with the puck steps down the wall, the far one cheats up for the one-timer
        const near = (top: boolean) => (P.x > 44 && (P.y < MID) === top ? 2.2 : 0);
        return ({
          Q: { x: OPP_BLUE + 2.4, y: MID + lean }, F1: { x: 47.2 + near(true), y: 3.8 }, F2: { x: 47.2 + near(false), y: W - 3.8 },
          B: { x: 46.6, y: MID + lean * 0.8 }, NET: { x: OPP_GOAL - (P.x < 43 ? 1.3 : 1.8), y: MID + (P.y < MID ? 0.9 : -0.9) },
        } as Record<PPRole, V2>)[r] ?? { x: 47, y: MID };
      },
    };
  }
  /** Spots of the unit: defencemen at the top, forwards on the flanks and in front; kept while the unit is unchanged. */
  private ppRole(a: Agent): PPRole {
    const s = a.side, list = this.skaters(s), f = this.ppFormation(s);
    const P = this.puckLocal(s);
    if (Math.abs(P.y - MID) > 3) this.ppLow = P.y < MID;
    const key = f.roles.join() + '|' + list.map(m => m.id).sort().join();
    if (key !== this.ppKey) {
      this.ppKey = key; this.ppMap.clear();
      const cost = (m: Agent, r: PPRole) => {
        const d = this.isD(m), at = f.at(r, P);
        const top = r === 'Q' || r === 'P1' || r === 'P2';
        return dist(loc(s, m), at) / 2.5 + (top ? (d ? -6 : 4) : d ? 5 : 0) + (r === 'NET' ? -m.check / 40 : 0) + (r === 'F1' || r === 'F2' ? -m.shoot / 30 : 0);
      };
      // at most 5×5: try every assignment
      const roles = f.roles.slice(0, list.length);
      let best: PPRole[] = roles, bc = Infinity;
      const perm = (left: PPRole[], acc: PPRole[]) => {
        if (acc.length === list.length || !left.length) {
          const c = acc.reduce((sum, r, i) => sum + cost(list[i], r), 0);
          if (c < bc) { bc = c; best = acc; }
          return;
        }
        left.forEach((r, i) => perm([...left.slice(0, i), ...left.slice(i + 1)], [...acc, r]));
      };
      perm(roles, []);
      list.forEach((m, i) => this.ppMap.set(m.id, best[i] ?? 'B'));
    }
    return this.ppMap.get(a.id) ?? 'B';
  }
  private ppSpot(a: Agent, P = this.puckLocal(a.side)): V2 { return this.ppFormation(a.side).at(this.ppRole(a), P); }
  /** Power-play carrier: hold the spot, walk it a little, move the puck around the outside, shoot now and then. */
  private ppKeep(a: Agent, me: V2, pressure: number, r: number) {
    const s = a.side, oz = this.oz;
    if (oz.side !== s) { oz.side = s; oz.t0 = this.g; oz.passes = 0; oz.lastPasser = ''; }
    const age = this.g - oz.t0, role = this.ppRole(a), spot = this.ppSpot(a);
    this.decideAt.set(a.id, this.g + 0.55 + this.rand() * 0.65);
    const top = role === 'Q' || role === 'P1' || role === 'P2';
    const shootP = top ? (age > 9 ? 0.2 : 0.07) : role === 'F1' || role === 'F2' ? (age > 9 ? 0.15 : 0.06) : 0.1;
    if (r < shootP && dist(me, spot) < 3.5 && oz.passes >= 2) { this.freeShot(a); return; }
    if (this.rand() < (pressure < 2.5 ? 0.9 : 0.6) && this.passPP(a)) return;
    let t: V2 = spot;
    const wave = Math.sin(this.g * 0.9 + a.id.length * 1.3);
    if (top) t = { x: spot.x + 0.4, y: clamp(spot.y + wave * 3.2, 5, 25) }; // walking the line
    else if (role === 'F1' || role === 'F2') t = { x: spot.x + 1.2 + wave * 1.8, y: spot.y + (spot.y < MID ? 1.2 : -1.2) }; // up and down the half-wall
    else if (role === 'LOW') t = { x: spot.x, y: spot.y + wave * 2 };
    if (pressure < 2.2) {
      const o = this.nearest(this.skaters((1 - s) as Side), a);
      if (o) { const ol = loc(s, o), dx = me.x - ol.x, dy = me.y - ol.y, d = Math.hypot(dx, dy) || 1; t = { x: me.x + (dx / d) * 3 + (t.x - me.x) * 0.4, y: me.y + (dy / d) * 3 + (t.y - me.y) * 0.4 }; }
    }
    this.carryTarget.set(a.id, loc(s, { x: clamp(t.x, OPP_BLUE + 1, 58), y: clamp(t.y, 1.5, 28.5) }));
  }
  /** Power-play pass: around the perimeter through open lanes; the net-front man and the passer back are rare options. */
  private passPP(a: Agent): boolean {
    const s = a.side, opps = this.skaters((1 - s) as Side);
    let best: Agent | null = null, score = -1e9, bestLane = 0;
    for (const m of this.skaters(s)) {
      if (m === a || m.stun > 0 || !this.onsideOk(a, m)) continue;
      const d = dist(a, m);
      if (d < 2.5 || d > 32) continue;
      const lane = Math.min(9, ...opps.map(o => segDist(o, a, m))), open = Math.min(9, ...opps.map(o => dist(o, m)));
      let sc = lane * 1.6 + open * 0.6 - d * 0.04 + this.rand() * 2.2;
      if (this.ppRole(m) === 'NET') sc -= 5;
      if (m.id === this.oz.lastPasser) sc -= 2.5;
      if (lane < 1) sc -= 6; // the lane is covered by a stick
      if (sc > score) { score = sc; best = m; bestLane = lane; }
    }
    if (!best || score < -2) return false;
    this.oz.passes++; this.oz.lastPasser = a.id;
    // a pass through a tight lane can be picked off (then the killers ice it)
    this.startLeg('pass', best, this.g + clamp(dist(a, best) / 19, 0.22, 1.5), { exitSpeed: 5, protect: bestLane > 1.6 || this.rand() < 0.6 });
    return true;
  }
  /** Penalty kill in the own zone: a box (a triangle two men down) leaning to the puck; D men take the low spots. */
  private pkShape(s: Side, free: Agent[], pressed: Agent | null) {
    const P = this.puckLocal(s), shift = clamp((P.y - MID) * 0.22, -2.6, 2.6);
    const highX = clamp(GOAL + 10.5 + (P.x - (GOAL + 12)) * 0.12, GOAL + 9, GOAL + 13), lowX = GOAL + 3.4;
    const n = this.skaters(s).length;
    let spots: { p: V2; low: boolean }[] = n >= 4
      ? [{ p: { x: lowX, y: MID - 3.3 + shift }, low: true }, { p: { x: lowX, y: MID + 3.3 + shift }, low: true }, { p: { x: highX, y: MID - 5.4 + shift * 1.4 }, low: false }, { p: { x: highX, y: MID + 5.4 + shift * 1.4 }, low: false }]
      : [{ p: { x: lowX - 0.3, y: MID + shift * 0.5 }, low: true }, { p: { x: highX - 1, y: MID - 4.6 + shift }, low: false }, { p: { x: highX - 1, y: MID + 4.6 + shift }, low: false }];
    // the man pressuring the puck has left his spot: the one nearest the puck stays empty
    if (pressed && spots.length > free.length) {
      const pl = loc(s, pressed);
      spots = spots.sort((u, v) => dist(u.p, pl) - dist(v.p, pl)).slice(1);
    }
    const left = new Set(free);
    for (const sp of spots) {
      let best: Agent | null = null, bc = Infinity;
      for (const a of left) { const c = dist(loc(s, a), sp.p) + (this.isD(a) ? (sp.low ? -3 : 2) : sp.low ? 1.5 : 0); if (c < bc) { bc = c; best = a; } }
      if (!best) break;
      const d = this.drift(best, 0.25);
      this.setT(best, loc(s, { x: sp.p.x + d.x, y: sp.p.y + d.y }), 0.85);
      left.delete(best);
    }
    for (const a of left) this.setT(a, loc(s, { x: GOAL + 2.5, y: MID }), 0.85);
  }
  /** Even strength, neutral zone, no room: a drop pass back to a defenceman to regroup. */
  private regroup(a: Agent): boolean {
    const s = a.side, me = loc(s, a), opps = this.skaters((1 - s) as Side);
    const back = this.skaters(s).filter(m => m !== a && this.isD(m) && m.stun <= 0 && loc(s, m).x < me.x - 4 && dist(m, a) < 22)
      .map(m => ({ m, lane: Math.min(9, ...opps.map(o => segDist(o, a, m))) })).filter(x => x.lane > 1.8).sort((u, v) => v.lane - u.lane)[0];
    if (!back) return false;
    this.startLeg('pass', back.m, this.g + clamp(dist(a, back.m) / 17, 0.3, 1.4), { exitSpeed: 4, protect: true });
    return true;
  }

  private passBest(a: Agent, safe: boolean): boolean {
    const s = a.side, opps = this.skaters((1 - s) as Side);
    let best: Agent | null = null, score = -1e9;
    for (const m of this.skaters(s)) {
      if (m === a || m.stun > 0 || !this.onsideOk(a, m)) continue;
      const d = dist(a, m);
      if (d < 3 || d > 30) continue;
      const open = Math.min(9, ...opps.map(o => dist(o, m)));
      const lane = Math.min(9, ...opps.map(o => segDist(o, a, m)));
      let sc = (loc(s, m).x - loc(s, a).x) * 0.25 + open + (safe ? lane * 1.5 : 0) - d * 0.05;
      if (this.oz.side === s && this.zoneIn[s]) {
        if (m.id === this.oz.lastPasser) sc -= 6; // no instant give-and-go ping-pong
        const net = loc(s, { x: OPP_GOAL, y: MID });
        if (d < 7 && dist(a, net) < 11 && dist(m, net) < 11) sc -= 5; // no tic-tac-toe around the crease
      }
      if (sc > score) { score = sc; best = m; }
    }
    if (!best) return false;
    if (this.oz.side === s && this.zoneIn[s]) { this.oz.passes++; this.oz.lastPasser = a.id; }
    const t1 = this.g + clamp(dist(a, best) / 16, 0.25, 1.8);
    this.startLeg('pass', best, t1, { exitSpeed: 5, protect: safe && this.rand() < 0.85 });
    return true;
  }
  /** Shot that does not reach the goalie: wide of the net or blocked. Never an extra shot on goal. */
  private freeShot(a: Agent) {
    const s = a.side, net = loc(s, { x: OPP_GOAL, y: MID });
    const blocker = this.skaters((1 - s) as Side).filter(o => segDist(o, a, net) < 1.2 && dist(o, a) < dist(a, net) * 0.75 && dist(o, a) > 1).sort((x, y) => dist(x, a) - dist(y, a))[0];
    if (blocker) {
      this.startLeg('block', blocker, this.g + clamp(dist(a, blocker) / 26, 0.08, 0.6), { exitSpeed: 5, h1: 0.2 });
    } else {
      const wide = loc(s, { x: OPP_GOAL + 0.2, y: MID + (loc(s, a).y < MID ? -1 : 1) * (1.7 + this.rand() * 1.8) });
      this.startLeg('wide', wide, this.g + clamp(dist(a, wide) / 25, 0.15, 1), { exitSpeed: 13, h1: 0.3 + this.rand() * 0.6 });
      this.play('wide', s, `Бросок мимо: ${a.name}`, a);
    }
  }

  /* --- puck physics --- */
  private nearest(list: Agent[], p: V2) { let best: Agent | null = null, d = 1e9; for (const a of list) { const x = dist(a, p); if (x < d) { d = x; best = a; } } return best; }
  private blade(a: Agent): V2 { return a.goalie ? { x: a.x, y: a.y } : { x: a.x + a.fx * 0.75, y: a.y + a.fy * 0.75 }; }
  private legTarget(leg: Leg): V2 { return isAgent(leg.to) ? this.blade(leg.to) : leg.to; }
  private startLeg(kind: LegKind, to: V2 | Agent, t1: number, o: { by?: Agent | null; h1?: number; arc?: number; exitSpeed?: number; protect?: boolean; event?: GameEvent; icing?: Side | null; via?: Agent; tv?: number } = {}) {
    const p = this.puck, by = o.by === undefined ? p.carrier : o.by;
    p.leg = { kind, t0: this.g, t1: Math.max(this.g + 0.05, t1), from: { x: p.x, y: p.y }, to, h0: p.h, h1: o.h1 ?? 0, arc: o.arc ?? 0, by, protect: !!o.protect, exitSpeed: o.exitSpeed ?? 0, event: o.event, icing: o.icing ?? null, via: o.via, tv: o.tv };
    p.carrier = null; p.dead = false; p.reserved = null;
    p.icing = o.icing ?? null;
    if (by) { p.noTouch = by; p.noTouchUntil = this.g + 0.4; p.last = by.side; }
    this.carryTarget.clear();
  }
  private loosePuck(vx: number, vy: number) { const p = this.puck; p.carrier = null; p.leg = null; p.vx = vx; p.vy = vy; p.dead = false; }
  private take(a: Agent, kind: PlayKind | null) {
    const p = this.puck;
    if (p.carrier && p.carrier !== a) p.noTouch = p.carrier, p.noTouchUntil = this.g + 0.6;
    p.carrier = a; p.leg = null; p.reserved = null; p.icing = null; p.last = a.side; p.h = 0;
    if (kind === 'takeaway') this.play('takeaway', a.side, `Отбор: ${a.name}`, a);
    if (kind === 'interception') this.play('interception', a.side, `Перехват: ${a.name}`, a);
    this.decideAt.set(a.id, this.g + 0.3 + this.rand() * 0.4);
    this.carryTarget.delete(a.id);
  }
  private movePuck(dt: number) {
    const p = this.puck;
    if (p.dead) return;
    const ox = p.x, oy = p.y;
    if (p.carrier) {
      const b = this.blade(p.carrier);
      p.x = b.x; p.y = b.y; p.h = 0;
    } else if (p.leg) {
      const leg = p.leg;
      if (leg.via && leg.tv !== undefined) {
        if (this.g < leg.tv) {
          const u = clamp((this.g - leg.t0) / (leg.tv - leg.t0), 0, 1), b = this.blade(leg.via);
          p.x = leg.from.x + (b.x - leg.from.x) * u; p.y = leg.from.y + (b.y - leg.from.y) * u; p.h = 0;
          p.vx = (p.x - ox) / dt; p.vy = (p.y - oy) / dt;
          return;
        }
        leg.from = { x: p.x, y: p.y }; leg.t0 = leg.tv; leg.via = undefined; leg.tv = undefined;
      }
      const u = clamp((this.g - leg.t0) / (leg.t1 - leg.t0), 0, 1), end = this.legTarget(leg);
      p.x = leg.from.x + (end.x - leg.from.x) * u; p.y = leg.from.y + (end.y - leg.from.y) * u;
      p.h = Math.max(0, leg.h0 + (leg.h1 - leg.h0) * u + leg.arc * 4 * u * (1 - u));
      p.vx = (p.x - ox) / dt; p.vy = (p.y - oy) / dt;
      if (u >= 1 - 1e-9) this.legEnd(leg);
      return;
    } else {
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > 0) { const ns = Math.max(0, sp - 1.6 * dt); p.vx *= ns / sp; p.vy *= ns / sp; }
      let nx = p.x + p.vx * dt; const ny = p.y + p.vy * dt;
      for (const gx of [GOAL, L - GOAL]) {
        const back = gx < RED ? gx - 1.15 : gx + 1.15;
        if (nx > Math.min(gx, back) - 0.12 && nx < Math.max(gx, back) + 0.12 && Math.abs(ny - MID) < 1.1) { p.vx = -p.vx * 0.45; nx = p.x; }
      }
      const c = inside({ x: nx, y: ny }, 0.3);
      if (c.x !== nx || c.y !== ny) {
        const nX = nx - c.x, nY = ny - c.y, nl = Math.hypot(nX, nY) || 1, vn = (p.vx * nX + p.vy * nY) / nl;
        if (vn > 0) { p.vx -= (1.55 * vn * nX) / nl; p.vy -= (1.55 * vn * nY) / nl; }
      }
      p.x = c.x; p.y = c.y; p.h = Math.max(0, p.h - 2 * dt);
      // icing: shot from own half crosses the opponents' goal line untouched
      if (p.icing !== null && loc(p.icing, p).x > OPP_GOAL) {
        const s = p.icing;
        this.icings[s]++;
        this.play('icing', s, `Проброс: ${this.teamShort(s)}`);
        this.startStop('icing', zoneDot(s, p.y));
      }
    }
    if (!p.leg && !p.carrier && !p.dead) return;
    if (p.carrier) { p.vx = (p.x - ox) / dt; p.vy = (p.y - oy) / dt; }
  }
  private legEnd(leg: Leg) {
    const p = this.puck, sp = Math.hypot(p.vx, p.vy) || 1, ux = p.vx / sp, uy = p.vy / sp;
    p.leg = null;
    if ((leg.kind === 'pass' || leg.kind === 'giveaway') && isAgent(leg.to)) {
      const r = leg.to;
      if (r.on === 'ice' && !r.leave && r.stun <= 0) { this.take(r, null); return; }
    }
    if (leg.kind === 'shot' && leg.event) { this.shotArrives(leg); return; }
    if (leg.kind === 'block' && isAgent(leg.to)) {
      const b = leg.to, ang = this.rand() * Math.PI * 2;
      this.blocks[b.side]++;
      this.play('block', b.side, `Блок-шот: ${b.name}`, b);
      this.loosePuck(Math.cos(ang) * 5, Math.sin(ang) * 5);
      p.noTouch = b; p.noTouchUntil = this.g + 0.25;
      return;
    }
    this.loosePuck(ux * leg.exitSpeed, uy * leg.exitSpeed);
    p.icing = leg.icing ?? null;
  }
  private shotArrives(leg: Leg) {
    const e = leg.event!, p = this.puck, T: Side = e.team === this.teams[1].id ? 1 : 0, D = (1 - T) as Side;
    this.delivered.add(e);
    const shooter = this.agents.get(e.player!);
    if (e.type === 'goal') {
      const inNet = loc(T, { x: OPP_GOAL + 0.75, y: clamp(loc(T, p).y, MID - 0.8, MID + 0.8) });
      p.x = inNet.x; p.y = inNet.y; p.h = Math.min(p.h, 0.9);
      this.play('goal', T, `ГОЛ! ${shooter?.name ?? ''}`, shooter);
      if (e.strength === 'PP') {
        // One minor ends (the one closest to its end); a double minor in its first half restarts as two minutes.
        const boxed = [...this.agents.values()].filter(a => a.side === D && (a.on === 'box' || a.leave === 'box') && (a.pim === 2 || a.pim === 4) && a.boxUntil > this.g && a.boxUntil - a.pim * 60 <= this.g + 1e-6).sort((x, y) => x.boxUntil - y.boxUntil)[0];
        if (boxed) { if (boxed.pim === 4 && boxed.boxUntil - this.g > 120) { boxed.boxUntil = this.g + 120; boxed.pim = 2; } else boxed.boxUntil = this.g; }
      }
      this.startStop('goal', FACEOFF_DOTS.center, shooter);
      p.dead = true;
      return;
    }
    if (e.type === 'shot') {
      const gk = this.goalieOf(D);
      if (!gk || this.rand() < 0.45) {
        this.play('freeze', D, `${gk?.name ?? 'Вратарь'} фиксирует шайбу`, gk ?? undefined);
        this.startStop('freeze', zoneDot(D, p.y));
        return;
      }
      this.play('save', D, `Сейв: ${gk.name}`, gk);
      const away = loc(T, { x: 47.4 - this.rand() * 5, y: this.rand() < 0.5 ? 4 + this.rand() * 6 : 26 - this.rand() * 6 });
      const d = dist(p, away) || 1;
      this.loosePuck(((away.x - p.x) / d) * 7, ((away.y - p.y) / d) * 7);
      p.noTouch = gk; p.noTouchUntil = this.g + 0.5; p.h = 0.2;
      return;
    }
    const sp = Math.hypot(p.vx, p.vy) || 1;
    this.loosePuck((p.vx / sp) * 14, (p.vy / sp) * 14);
    this.play('wide', T, `Мимо пустых ворот: ${shooter?.name ?? ''}`, shooter);
  }

  /* --- contact: pick-ups, stick checks, interceptions --- */
  private interact() {
    const p = this.puck;
    if (p.dead) return;
    const want = this.desiredSide();
    const free = (a: Agent) => a.on === 'ice' && !a.leave && a.stun <= 0 && !(p.noTouch === a && this.g < p.noTouchUntil);
    if (p.carrier) {
      const c = p.carrier;
      const protectedC = (this.plan && this.plan.T === c.side) || this.duel?.victim === c;
      if (!protectedC) for (const o of this.skaters((1 - c.side) as Side)) {
        // stick on puck: the checker's blade reaches the puck or his body is on the carrier
        if (!free(o) || o.scripted && this.plan?.T !== o.side || (dist(o, c) > 1.3 && dist(this.blade(o), p) > 1.0)) continue;
        // contested even when the engine does not need the turnover — unless its next shot is the carrier's
        const base = want === o.side ? 0.13 : this.shotSoon() === null ? 0.012 : 0.004;
        const chance = base * (0.6 + o.check / 160) * (1.25 - c.hands / 200);
        if (this.rand() >= chance) continue;
        if (this.rand() < 0.4 && want === o.side) {
          // a poke check: the puck squirts loose and the battle is on
          const ang = Math.atan2(c.y - o.y, c.x - o.x) + (this.rand() - 0.5) * 1.6;
          this.play('takeaway', o.side, `Отбор: ${o.name}`, o);
          this.loosePuck(Math.cos(ang) * 4, Math.sin(ang) * 4);
          p.noTouch = c; p.noTouchUntil = this.g + 0.5;
          c.stun = Math.max(c.stun, 0.25);
        } else this.take(o, 'takeaway');
        return;
      }
      return;
    }
    if (p.leg) {
      const leg = p.leg;
      // A clearing attempt along the ice against the power play: a point man on the blue line keeps it in.
      if (this.pp !== null && leg.by && leg.by.side !== this.pp && (leg.kind === 'clear' || leg.kind === 'chip' || leg.kind === 'dump') && p.h < 0.5) {
        for (const o of this.skaters(this.pp)) {
          const l = loc(o.side, o);
          if (!free(o) || !this.isD(o) || l.x < OPP_BLUE - 0.5 || l.x > OPP_BLUE + 4.5 || dist(this.blade(o), p) > 1.6) continue;
          if (this.rand() < (want === o.side ? 0.35 : 0.08)) { this.take(o, null); this.play('interception', o.side, `${o.name} удерживает шайбу в зоне`, o); return; }
        }
      }
      if (leg.protect || leg.kind === 'shot' || leg.kind === 'block' || p.h > 0.6) return;
      for (const o of this.onIce()) {
        if (o.goalie || !free(o) || (leg.by && o.side === leg.by.side) || dist(o, p) > 0.9) continue;
        const chance = want === o.side ? 0.45 : 0.03;
        if (this.rand() < chance) { this.take(o, 'interception'); return; }
      }
      return;
    }
    // loose puck
    if (p.h > 0.5) return;
    const near = this.onIce().filter(a => free(a) && dist(this.blade(a), p) < (a.goalie ? 0.9 : 1.1) && (!p.reserved || a === p.reserved || a.goalie));
    if (!near.length) return;
    const gk = near.find(a => a.goalie);
    if (gk && Math.hypot(p.vx, p.vy) < 6 && !p.reserved) {
      this.play('freeze', gk.side, `${gk.name} накрывает шайбу`, gk);
      this.startStop('freeze', zoneDot(gk.side, p.y));
      return;
    }
    const skaters = near.filter(a => !a.goalie);
    if (!skaters.length) { if (gk) { const out = loc(gk.side, { x: GOAL + 6, y: p.y < MID ? 6 : 24 }); const d = dist(p, out) || 1; this.loosePuck(((out.x - p.x) / d) * 6, ((out.y - p.y) / d) * 6); p.noTouch = gk; p.noTouchUntil = this.g + 0.5; } return; }
    const pref = skaters.filter(a => a.side === want);
    const winner = p.reserved && skaters.includes(p.reserved) ? p.reserved : pref.length && this.rand() < 0.8 ? pref[0] : skaters[Math.floor(this.rand() * skaters.length)];
    const was = p.last;
    this.take(winner, null);
    if (was !== null && was !== winner.side && dist(winner, loc(winner.side, { x: GOAL, y: MID })) > 6) this.play('loose', winner.side, `Подбор: ${winner.name}`, winner);
    // possession over the blue line on the carry is a legal zone entry
  }

  /* --- skating --- */
  private move(a: Agent, dt: number) {
    if (a.stun > 0) {
      a.stun -= dt; a.vx *= 0.92; a.vy *= 0.92;
    } else {
      if (!a.goalie && a.on === 'ice' && !a.leave && this.mode === 'play' && !this.zoneIn[a.side] && this.puck.carrier !== a && this.early?.a !== a) {
        // tag up: an attacker left in the zone after the puck went out skates back over the blue line at once
        const l = loc(a.side, a);
        if (l.x > OPP_BLUE - 0.4) { const t = loc(a.side, { x: Math.min(loc(a.side, { x: a.tx, y: a.ty }).x, OPP_BLUE - 1.5), y: loc(a.side, { x: a.tx, y: a.ty }).y }); a.tx = t.x; a.ty = t.y; a.urg = 1; a.arrive = Infinity; }
      }
      const dx = a.tx - a.x, dy = a.ty - a.y, d = Math.hypot(dx, dy);
      let want = a.goalie ? Math.min(a.max, d * 5) : Math.min(a.max * a.urg, d * 1.7 + (d > 0.4 ? 0.5 : 0));
      if (Number.isFinite(a.arrive)) { const left = a.arrive - this.g; want = left > 0.05 ? Math.min(a.max, Math.max(d / left, d > 0.5 ? 1.5 : 0)) : Math.min(a.max, d * 3); }
      if (a === this.puck.carrier) want = Math.min(want, a.max * 0.93);
      let vx = d > 1e-6 ? (dx / d) * want : 0, vy = d > 1e-6 ? (dy / d) * want : 0;
      if ((a.fvx || a.fvy) && !Number.isFinite(a.arrive)) {
        // shadowing a moving man: match his speed, then close the remaining gap on top of it
        vx += a.fvx; vy += a.fvy;
        const m = Math.hypot(vx, vy);
        if (m > a.max) { vx *= a.max / m; vy *= a.max / m; }
      }
      if (!a.goalie) for (const b of this.onIce()) {
        if (b === a || b.goalie) continue;
        const ex = a.x - b.x, ey = a.y - b.y, e = Math.hypot(ex, ey);
        if (e > 0.01 && e < 1.3) { const f = ((1.3 - e) / 1.3) * (a.scripted ? 1.2 : 2.6); vx += (ex / e) * f; vy += (ey / e) * f; }
      }
      let ax = vx - a.vx, ay = vy - a.vy;
      const am = Math.hypot(ax, ay), lim = a.acc * dt * (want < Math.hypot(a.vx, a.vy) ? 1.6 : 1);
      if (am > lim) { ax *= lim / am; ay *= lim / am; }
      a.vx += ax; a.vy += ay;
    }
    const sp = Math.hypot(a.vx, a.vy);
    if (sp > a.max * 1.05) { a.vx *= (a.max * 1.05) / sp; a.vy *= (a.max * 1.05) / sp; }
    const prevX = loc(a.side, a).x;
    a.x += a.vx * dt; a.y += a.vy * dt;
    if (!a.goalie && a.on === 'ice' && this.mode === 'play') this.keepOnside(a, prevX);
    if (!a.goalie || a.leave) { const c = inside(a, 0.5); if (c.x !== a.x) a.vx *= 0.3; if (c.y !== a.y) a.vy *= 0.3; a.x = c.x; a.y = c.y; }
    if (sp > 0.6) { const k = Math.min(1, dt * 8); a.fx += (a.vx / sp - a.fx) * k; a.fy += (a.vy / sp - a.fy) * k; }
    else { const px = this.puck.x - a.x, py = this.puck.y - a.y, pd = Math.hypot(px, py) || 1, k = Math.min(1, dt * 3); a.fx += (px / pd - a.fx) * k; a.fy += (py / pd - a.fy) * k; }
    const fl = Math.hypot(a.fx, a.fy) || 1; a.fx /= fl; a.fy /= fl;
    // a legal zone entry by the carrier
    const pc = this.puck.carrier;
    if (pc === a && this.mode === 'play') {
      const inZone = loc(a.side, a).x > OPP_BLUE;
      if (inZone && this.zoneEntry !== a.side) { this.zoneEntry = a.side; this.play('entry', a.side, `Вход в зону: ${a.name}`, a); }
      if (!inZone && loc(a.side, a).x < OPP_BLUE - 3 && this.zoneEntry === a.side) this.zoneEntry = null;
    }
  }

  private record() {
    const list = [...this.agents.values()].filter(a => a.on === 'ice' || a.on === 'box');
    const ids = list.map(a => a.id);
    const same = ids.length === this.lastIds.length && ids.every((id, i) => id === this.lastIds[i]);
    if (!same) this.lastIds = ids;
    const pos = new Float32Array(list.length * 2), flags = new Uint8Array(list.length);
    list.forEach((a, i) => { pos[i * 2] = a.x; pos[i * 2 + 1] = a.y; flags[i] = (a.goalie ? 1 : 0) | (a.on === 'box' ? 2 : 0); });
    const st = this.stop;
    const faceoff = !!st && (st.phase === 'set' || st.phase === 'drop' || (st.phase === 'gather' && dist(this.puck, st.dot) < 0.05));
    const off = st ? { x: st.dot.x + 0.9, y: st.dot.y + 1.6 } : { x: 0, y: 0 };
    this.frames.push({ tau: this.tau, g: this.g, px: this.puck.x, py: this.puck.y, ph: this.puck.h, ids: this.lastIds, pos, flags, carrier: this.puck.carrier ? this.lastIds.indexOf(this.puck.carrier.id) : -1, stop: st ? (faceoff ? 1 : 2) : 0, ox: off.x, oy: off.y });
  }
}

function segDist(p: V2, a: V2, b: V2): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1);
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}
