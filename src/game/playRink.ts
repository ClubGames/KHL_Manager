import type { GameEvent, Lineup, Player, ShotZone, Strength, Team } from '../types';
import type { Key, LiveFrame, ReplayClip, Track } from './rinkPlayback';
import type { RinkPlay, PlayKind } from './rinkAI';
import { BOARDS_H, FACEOFF_SPOTS, RINK, glassTop, inBenchFront } from './rinkGeometry';
import { goalieSavePct } from './ratings';

/*
 * A period the manager plays himself, NHL style: he skates one of his players (the puck carrier when his team
 * has it, a switchable defender when it does not), everybody else is driven by the rink AI.
 *
 * Unlike the watched match (rinkAI.ts), where the statistical engine decides every shot and goal and the rink
 * only stages them, here the rink is authoritative: skating, passes, shots, blocks, saves and goals come out of
 * the physics and the players' ratings. Every shot is aimed at a point of the net mouth; the aim error grows
 * with a weak shooter, speed and pressure, and a shot on target beats the goalie with a probability built from
 * the goalie's rating and the shot (distance and angle, speed, the corner it is aimed at, a screen, a goalie who
 * has to move across, a deke, a rebound). Penalties come from the players' own fouls (a hook or trip with a
 * missed poke check, a late or charging hit, interference), icing and offside are called by the rules.
 *
 * Coordinates: metres, x along the rink (0…60), y across (0…30). In the simulation side 0 (home) always attacks
 * toward x = 60; the presentation mirrors the rink lengthwise when the teams have switched ends (`flip`).
 * Time: `tau` real seconds since the start of the block, `clock` seconds on the period clock (it runs `rate`
 * times faster than real time, so a 20-minute period can be played in five minutes, and stops at whistles).
 */

export type Side = 0 | 1;
type V2 = { x: number; y: number };
type Role = 'C' | 'LW' | 'RW' | 'LD' | 'RD' | 'G';
export type Difficulty = 'rookie' | 'pro' | 'star';
export type ShotKind = 'wrist' | 'snap' | 'slap' | 'backhand' | 'tip' | 'rebound';
export type ReleaseKind = 'wrist' | 'snap' | 'slap' | 'backhand' | 'tip' | 'pass' | 'saucer';

/**
 * The manager's controls. mx/my: the skating stick (screen axes: x to the right, y down, magnitude 0…1; the
 * played match turns them into rink terms for the turned cameras). sx/sy: the «skill stick», NHL style (the
 * right stick of a pad, the second touch stick, a mouse drag) read in SCREEN terms like the NHL games: pull it
 * down (back) and push it up (forward) for a slap / snap shot — the longer it is held back, the harder; flick it
 * up from the centre for a wrist shot; held to one side it carries the puck to the forehand / backhand
 * (stickhandling), flicked sideways it dekes (down then sideways: a toe drag; one way then the other: between the
 * legs; a full circle: a spin-o-rama; down and let go: a shot fake). On defence a flick is a poke check (a stick
 * lift from behind the carrier). Buttons are held states.
 */
export interface PadState { mx: number; my: number; sprint: boolean; shoot: boolean; pass: boolean; deke: boolean; swap: boolean; sx?: number; sy?: number;
  /** the faceoff button: pressed right as the referee drops the puck it wins the draw clean (shot / pass work too, a little less well) */
  faceoff?: boolean;
  /** the skill stick turned by the camera like mx/my (the side a deke or the stickhandling goes on the ice); default sx/sy */
  srx?: number; sry?: number;
  /** a point on the ice the manager aims at (the mouse cursor), rink coordinates: shots go to that side of the net, passes to the man nearest it */
  aimAt?: { x: number; y: number } | null;
  /**
   * The gamepad's NHL 25/26 scheme (see playInput.ts): the shot and deke buttons do nothing on defence (the checks
   * are the right stick and the buttons below); RT held with the puck is a pass loading up while the right stick
   * only stickhandles (no accidental dekes); LB held with the puck turns right-stick flicks into the special dekes.
   */
  nhl?: boolean;
  /** RB on defence: poke check */
  poke?: boolean;
  /** A on defence: stick lift */
  lift?: boolean;
  /** Y on defence: board pin */
  pin?: boolean;
  /** LB: on defence the shot-block stance (held), with the puck the deke modifier (held) */
  lb?: boolean;
  /** LT on defence: vision control — he keeps facing the puck, skating backwards if need be (held) */
  vision?: boolean;
  /** L3: hustle — a burst kept while the left stick is pushed (pressed again or the stick let go: off) */
  hustle?: boolean;
  /** a push check on defence (the pad does it with the right stick up; the keyboard and the touch screen have a button) */
  push?: boolean }
export const NO_PAD: PadState = { mx: 0, my: 0, sprint: false, shoot: false, pass: false, deke: false, swap: false };
/** The kinds of dekes and body checks (the 3D figures act them out). */
export type DekeKind = 'side' | 'toe' | 'between' | 'spin' | 'fake';
export type CheckKind = 'shoulder' | 'hip' | 'pin';
export type MoveKind = DekeKind | CheckKind | 'lift' | 'reach' | 'push';
/**
 * A held stance the 3D figure shows: down to block a shot, the stick cocked for a one-timer, tapping the stick for
 * a pass, the defensive «vision» stance (skating backwards facing the puck, stick out in front), a hustle burst.
 */
export type Stance = 'block' | 'oneTimer' | 'call' | 'vision' | 'hustle';
/** How a skater goes down: knocked over backwards, face first (hit from behind, a whiffed check), over the hip sideways. */
export type FallKind = 'back' | 'front' | 'side';
/** A stretch for a puck just out of reach: the stick shot out one-handed (seconds). */
const REACH_DUR = 0.36;
const DEKE_DUR: Record<DekeKind, number> = { side: 0.45, toe: 0.55, between: 0.6, spin: 0.65, fake: 0.5 };
export const FORECHECK_NAME = ['пассивный 1-2-2', 'сбалансированный', 'агрессивный 2-1-2'];
export const BREAKOUT_NAME = ['стандартный выход', 'длинный пас (stretch)', 'надёжный выход'];
const DEKE_NAME: Record<DekeKind, string> = { side: 'финт', toe: 'протяжка', between: 'между ног', spin: 'вертушка', fake: 'ложный замах' };

export interface PlayRules { offside: boolean; icing: boolean; penalties: boolean }
export interface PlayRinkOptions {
  home: Team; away: Team; players: Record<string, Player>; lineups: [Lineup, Lineup];
  /** the manager's side (null: both benches are AI — tests, finishing a period in the background) */
  userSide: Side | null;
  kind: 'reg' | 'ot3' | 'ot5';
  /** the teams have switched ends: presentation is mirrored lengthwise */
  flip?: boolean;
  /** real minutes a 20-minute period takes (the clock runs 20 / periodMinutes times faster) */
  periodMinutes?: number;
  difficulty?: Difficulty;
  rules?: Partial<PlayRules>;
  goalies?: [string | null, string | null];
  /** penalties carried over from the previous period: [player, end] with `end` in seconds of this block's clock */
  box?: [[string, number][], [string, number][]];
  /** score before this block [home, away] (late-game decisions: pulling the goalie) */
  score?: [number, number];
  /** period number (1…3 regulation, 4+ overtime) */
  period?: number;
  seed?: number;
  /** on defence the control moves by itself to the man nearest the puck when the controlled one is out of the play */
  autoSwitch?: boolean;
}

/** What happened on the ice, for the books (GameSim.recordPlayed) and the match screen. */
export type PlayOut =
  | { type: 'shot'; side: Side; shooter: string; goalie: string | null; outcome: 'goal' | 'save' | 'miss' | 'block'; post?: boolean; blocker?: string; assists: string[]; strength: Strength; shotType: ShotKind; x: number; y: number; xg: number; zone: ShotZone; ice: [(string | null)[], (string | null)[]] }
  | { type: 'penalty'; side: Side; player: string; min: 2 | 4 | 5; reason: string }
  | { type: 'hit'; side: Side; player: string; victim: string }
  | { type: 'faceoff'; side: Side; player: string }
  | { type: 'icing' | 'offside'; side: Side }
  | { type: 'waived'; side: Side; text: string }
  | { type: 'end' };

/** A release as the 3D view animates it (shared with replayMotion's Release shape, plus the side). */
export type PlayRelease = { id: string; side: Side; t: number; kind: ReleaseKind; windup: number; follow: number; tx: number; tz: number };

const L = 60, W = 30, MID = 15;
const GOAL = RINK.goalLine, OPP_GOAL = L - RINK.goalLine, BLUE = RINK.blueLine, OPP_BLUE = L - RINK.blueLine, RED = 30;
const POST = RINK.goalWidth / 2, BAR = RINK.goalHeight;
const BENCH: [V2, V2] = [{ x: 24, y: 0.9 }, { x: 36, y: 0.9 }];
const BOX: [V2, V2] = [{ x: 27, y: 29.1 }, { x: 33, y: 29.1 }];
const NET_DEPTH = RINK.goalDepth, NET_HALF = POST + 0.06;
const CAGES = [
  { x0: GOAL - NET_DEPTH, x1: GOAL, y0: MID - NET_HALF, y1: MID + NET_HALF },
  { x0: OPP_GOAL, x1: OPP_GOAL + NET_DEPTH, y0: MID - NET_HALF, y1: MID + NET_HALF },
];
const STEP = 1 / 60;
const REACH = 0.72; // body to the middle of the blade
const FRAMES_KEPT = 20; // seconds of frames kept (goal clips look 7 s back; the 3D broadcast replays up to ~13 s back)
const ZONE_MULT: Record<ShotZone, number> = { crease: 2.04, slot: 1.46, circles: 0.9, point: 0.33, perimeter: 0.26 };
const WINDUP: Record<ReleaseKind, number> = { wrist: .32, snap: .2, slap: .55, backhand: .3, tip: .1, pass: .24, saucer: .26 };
const FOLLOW: Record<ReleaseKind, number> = { wrist: .45, snap: .38, slap: .5, backhand: .45, tip: .25, pass: .32, saucer: .42 };
const NET_X = RINK.length / 2 - RINK.goalLine;
/** Calibration of the goal chance of a shot on target (AI against AI: a save % of about .910, as in the KHL). */
const GOAL_CAL = 1.5;
/** The calls of the played match, in the wording of the KHL (and of the text simulation's list). */
const PEN_REASON = {
  trip: 'подножка', hook: 'задержка клюшкой', interference: 'атака игрока без шайбы', charge: 'атака с разгона', board: 'толчок на борт', slash: 'удар клюшкой',
  hold: 'задержка руками', high: 'высота клюшки', goalie: 'помеха вратарю', elbow: 'удар локтем', head: 'удар в голову', behind: 'атака сзади',
  knee: 'удар коленом', rough: 'грубость', bench: 'нарушение численного состава', delay: 'задержка игры (выброс шайбы за пределы площадки)',
} as const;

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const dist = (a: V2, b: V2) => Math.hypot(a.x - b.x, a.y - b.y);
/** The skill stick's charge: a slap / snap shot loads to full power in about a third of a second. */
const stickPower = (held: number) => clamp(0.6 + held * 1.15, 0.6, 1);
/** The shot button's charge: held longer, harder (full in a little under half a second). */
const buttonPower = (held: number) => clamp(0.25 + held / 0.6, 0.25, 1);
const smooth01 = (v: number) => { const t = clamp(v, 0, 1); return t * t * (3 - 2 * t); };
/** The official who drops the puck stands this far from the dot, across the rink on its far side (m): his hand is over the dot. */
const OFFICIAL_AT = 0.75;
/** The longest the players take to skate to their faceoff places after a whistle (s). */
const FO_GATHER_MAX = 7;
/** The faceoff drop (s): the official's windup before the puck leaves his hand, its fall, the centres' battle for it before one wins it. */
export const FO_DROP = { windup: 0.3, fall: 0.147, battle: 0.45 };
const angDiff = (a: number, b: number) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; };
/** Side s's local frame: attacking toward +x, own net at x = 4. A 180° rotation, its own inverse. */
const loc = (s: Side, p: V2): V2 => (s ? { x: L - p.x, y: W - p.y } : { x: p.x, y: p.y });
const sk = (p: Player | undefined, k: keyof Player['skills'], d = 62) => p?.skills?.[k] ?? d;
function rng(seed: number) {
  let a = seed | 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Rounded-rectangle boards (corner radius 8.5 m): the nearest point at least m inside. */
function inside(p: V2, m = 0.5): V2 {
  const r = RINK.corner;
  let x = clamp(p.x, m, L - m), y = clamp(p.y, m, W - m);
  const cx = clamp(x, r, L - r), cy = clamp(y, r, W - r);
  if (cx !== x && cy !== y) { const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy); if (d > r - m) { x = cx + (dx / d) * (r - m); y = cy + (dy / d) * (r - m); } }
  return { x, y };
}
function segDist(p: V2, a: V2, b: V2): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1);
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}
const inBox = (p: V2, c: { x0: number; x1: number; y0: number; y1: number }, m: number) => p.x > c.x0 - m && p.x < c.x1 + m && p.y > c.y0 - m && p.y < c.y1 + m;
/** End-zone dot of side s's defensive zone on the puck's half. */
const zoneDot = (s: Side, y: number): V2 => loc(s, { x: RINK.endDot, y: loc(s, { x: 0, y }).y < MID ? MID - RINK.dotOffset : MID + RINK.dotOffset });
/** Neutral-zone dot just outside side s's attacking blue line. */
const neutralDot = (s: Side, y: number): V2 => loc(s, { x: L - RINK.neutralDot, y: loc(s, { x: 0, y }).y < MID ? MID - RINK.dotOffset : MID + RINK.dotOffset });

/** Where a shot is taken from, by the engine's zones (local frame of the shooting side: the net at x = 56). */
export function shotZone(p: V2): ShotZone {
  const dx = OPP_GOAL - p.x, dy = Math.abs(p.y - MID), d = Math.hypot(dx, dy);
  if (dx < -0.3) return 'perimeter';
  if (d < 2.8) return 'crease';
  if (d < 9.5 && dy < 4.8) return 'slot';
  if (dx > 15) return 'point';
  if (dy < 11 && d < 15.5) return 'circles';
  return 'perimeter';
}

type Act =
  | { k: 'windup'; t0: number; what: 'shot' | 'pass'; fire?: boolean }
  | { k: 'check'; t0: number; tgt: Sk; done: boolean; kind: CheckKind; onPuck: boolean; light?: boolean }
  | { k: 'reach'; t0: number; done: boolean }
  | { k: 'poke'; t0: number; done: boolean; lift?: boolean }
  | { k: 'deke'; t0: number; s: 1 | -1; kind: DekeKind };

interface Sk {
  id: string; side: Side; goalie: boolean; name: string; hand: 1 | -1; kindD: boolean; role: Role;
  x: number; y: number; vx: number; vy: number; fa: number;
  max: number; acc: number; shoot: number; pass: number; hands: number; check: number; def: number; bal: number; fo: number; endur: number; ovr: number; rebound: number;
  energy: number; on: 'ice' | 'bench' | 'box'; leaving: boolean; boxUntil: number;
  /** the length of the penalty he is serving (a major is not cut short by a goal, a double minor by its first two minutes) */
  boxMin?: 2 | 4 | 5;
  /** the last time he ran into a goalie (one call per contact) */
  gi?: number;
  /** the puck in the air he last tried to knock down with his glove (its `leg`) */
  gloved?: number;
  /** the stance he is showing and since when (its blend in and out) */
  stK?: Stance | null; stAt?: number;
  /** called for a penalty: still skating to the penalty box door (off the play already, drawn on the ice) */
  boxGo?: boolean;
  stun: number; fall: number; act: Act | null; cool: number;
  /** desired velocity direction from the stick (manual) or the AI target */
  manual: boolean; wx: number; wy: number; sprint: boolean;
  tx: number; ty: number; urg: number; back: boolean;
  decideAt: number; carryT: V2 | null; lastPuck: number; spot: number;
  rolled: number; oneTimer: boolean; dekeBeat: number; dekeF: number; dekeR: number; stagger: number;
  /** the last moment he had the puck on his stick (carried, shot or passed): a hit within the grace after it is no interference */
  ownAt: number;
  /** a fall: how, which way (side falls: ±1), when it began */
  fallK: FallKind; fallS: 1 | -1; fallAt: number;
}
interface Shot { by: Sk; side: Side; t0: number; outcome: 'goal' | 'save' | 'miss'; kind: ShotKind; from: V2; xg: number; zone: ShotZone; goalie: Sk | null; strength: Strength; ice: [(string | null)[], (string | null)[]]; assists: string[]; post: boolean }
interface Puck {
  x: number; y: number; h: number; vx: number; vy: number; vh: number;
  carrier: Sk | null; last: Sk | null; noTouch: Sk | null; noTouchUntil: number;
  shot: Shot | null; passTo: Sk | null; passBy: Sk | null; icing: Side | null; dead: boolean; inNet: Side | null; leg: number; saucer: boolean;
  /** who sent it on its way last and from where (the rules on a puck out of play); `defl`: it has hit something since */
  rel?: { by: Sk; x: number; y: number }; defl?: boolean;
}
interface Pending { side: Side; player: Sk; reason: string; min: 2 | 4 | 5 }
interface Frame { tau: number; clock: number; px: number; py: number; ph: number; carrier: number; ids: string[]; sk: { id: string; side: Side; goalie: boolean; box: boolean; x: number; y: number; fa: number; ctrl: boolean; fall: number; fk: FallKind; fs: 1 | -1; check: number; poke: number; deke: number; mv: MoveKind | null; mt: number; stag: number; st: Stance | null; stT: number; hl: number }[]; stop: 0 | 1 | 2; ox: number; oy: number; dx: number; dy: number }

export class PlayRink {
  readonly plays: RinkPlay[] = [];
  /** frames of the last seconds (the 2D and the 3D rink draw them; goal clips are cut from them) */
  readonly frames: Frame[] = [];
  readonly releases: PlayRelease[] = [];
  /** events since the last drain() */
  private out: PlayOut[] = [];
  readonly opts: PlayRinkOptions;
  readonly rules: PlayRules;
  readonly difficulty: Difficulty;
  readonly len: number;
  readonly rate: number;
  tau = 0;
  clock = 0;
  mode: 'stop' | 'faceoff' | 'play' | 'end' = 'stop';
  score: [number, number];
  readonly shots: [number, number] = [0, 0];
  readonly hits: [number, number] = [0, 0];
  readonly faceoffWins: [number, number] = [0, 0];
  readonly goalsFor: { id: string; side: Side; tau: number; clock: number }[] = [];
  /** the skater the manager controls */
  ctl: string | null = null;
  /** set by the 3D view: a screen point → rink percent (the mouse aims with it) */
  screenPick: ((cx: number, cy: number) => { x: number; y: number } | null) | null = null;
  /** goalie pulled for an extra attacker (the manager's choice for his side, the AI's for the other) */
  readonly pulled: [boolean, boolean] = [false, false];
  private agents = new Map<string, Sk>();
  private rand: () => number;
  private puck: Puck = { x: 30, y: 15, h: 0, vx: 0, vy: 0, vh: 0, carrier: null, last: null, noTouch: null, noTouchUntil: 0, shot: null, passTo: null, passBy: null, icing: null, dead: true, inNet: null, leg: 0, saucer: false };
  private stopInfo: { reason: 'start' | 'goal' | 'freeze' | 'icing' | 'offside' | 'penalty' | 'out' | 'end'; dot: V2; until: number; icingSide: Side | null } = { reason: 'start', dot: { x: 30, y: 15 }, until: 0.6, icingSide: null };
  /** the faceoff: `gather` while the players skate to their places (spots by id), then the official sets, winds up and throws the puck down
   *  (`drop`: the moment it leaves his hand), and the centres battle for it for a moment (`decide`) */
  private fo: { dot: V2; setAt: number; drop: number; press: number; btn: boolean; done: boolean; gather: boolean; until: number; spots: Map<string, V2>; decide: number } | null = null;
  /** how the manager timed the last draw (the HUD shows it for a moment) */
  private foCall: { text: string; until: number } | null = null;
  private pending: Pending[] = [];
  private zoneIn: [boolean, boolean] = [false, false];
  private touches: { id: string; side: Side }[] = [];
  private lastSave = -9;
  /** a man jumped on before the one he replaces got to the bench (too many men while both are out there) */
  private early: [{ id: string; leaver: Sk } | null, { id: string; leaver: Sk } | null] = [null, null];
  private prevPad: PadState = NO_PAD;
  private pressAt = { shoot: -1, pass: -1 };
  private lineIdx: [number, number] = [0, 0];
  /** skill-stick gesture state: when it was pulled back (-1: not), when it was last at rest, the last sideways flick, the turn swept */
  private ss = { back: -1, loadEnd: -1, rest: 0, ang: 0, sweep: 0, sweepAt: 0, wasOut: false, ot: false, still: 0, backSweep: 0, handSide: 0 as 0 | 1 | -1, sideAt: -9, pend: null as null | { at: number; f: number; l: number; s: 1 | -1; sweep: number; drag: boolean } };
  /** the skill stick held out with the puck: where the blade carries it (lateral −1…1 to the left of his facing, forward −1…1) */
  private handle: { lat: number; fwd: number } | null = null;
  /** the last quick side-to-side of the stickhandling (a man reaching in has a harder time) */
  private handleSwing = -9;
  /** where the manager aims: the mouse cursor on the ice (null: the skating stick decides) */
  private aimPt: V2 | null = null;
  private aimVec: V2 = { x: 0, y: 0 };
  private lastDekeAt = -9;
  /** L3 hustle latched on (until the stick is let go or L3 is pressed again) */
  private hustleOn = false;
  /** the manager's man in the shot-block stance this step (LB on defence) */
  private blockBy: Sk | null = null;
  /** RT held with the puck (NHL scheme): the right stick only stickhandles, quicker */
  private handleFast = false;
  /** the team tactics the manager calls from the d-pad: forecheck (-1 passive 1-2-2, 0 balanced, 1 aggressive 2-1-2) and breakout (0 standard, 1 stretch, 2 safe) */
  readonly forecheck: [number, number] = [0, 0];
  readonly breakout: [number, number] = [0, 0];
  private pairIdx: [number, number] = [0, 0];
  private ppIdx: [number, number] = [0, 0];
  /** single changes: a tired man's place in his line taken by a fresher one from the bench (lineup id → who plays) */
  private sub: [Map<string, string>, Map<string, string>] = [new Map(), new Map()];
  /** when each side last sent forwards / defencemen off on the fly (the two never change together) */
  private changedAt: [{ F: number; D: number }, { F: number; D: number }] = [{ F: -99, D: -99 }, { F: -99, D: -99 }];
  /** called off with the puck on his stick: he goes as soon as he has given it up */
  private offNext = new Set<string>();
  private changeCheck = 0;
  private aiTick = 0;
  private callForPass = 0;
  private autoAt = 0;
  private stepAcc = 0;
  private readonly goalieIds: [string | null, string | null];
  private readonly teams: [Team, Team];
  private readonly P: Record<string, Player>;
  private clips: { e: { tau: number; scorer: string; side: Side; kind: ShotKind; release: number; strength: Strength }; clip: ReplayClip | null }[] = [];

  /** The benches and the penalty boxes stay where they are in the arena when the teams switch ends: in the
   *  simulation's own (unflipped) frame they swap sides in the periods the picture is mirrored. */
  private sides?: { bench: [V2, V2]; box: [V2, V2] };
  private get bench(): [V2, V2] { return (this.sides ??= this.opts.flip ? { bench: [BENCH[1], BENCH[0]], box: [BOX[1], BOX[0]] } : { bench: BENCH, box: BOX }).bench; }
  private get box(): [V2, V2] { return (this.sides ??= this.opts.flip ? { bench: [BENCH[1], BENCH[0]], box: [BOX[1], BOX[0]] } : { bench: BENCH, box: BOX }).box; }
  constructor(opts: PlayRinkOptions) {
    this.opts = opts;
    this.P = opts.players;
    this.teams = [opts.home, opts.away];
    this.rules = { offside: true, icing: true, penalties: true, ...opts.rules };
    this.difficulty = opts.difficulty ?? 'pro';
    this.len = opts.kind === 'ot3' ? 300 : 1200;
    this.rate = 1200 / (60 * clamp(opts.periodMinutes ?? 5, 1, 20));
    this.score = [opts.score?.[0] ?? 0, opts.score?.[1] ?? 0];
    this.rand = rng(opts.seed ?? Math.floor(Math.random() * 2 ** 31));
    this.goalieIds = opts.goalies ?? [opts.lineups[0].starterG, opts.lineups[1].starterG];
    for (const s of [0, 1] as Side[]) {
      const Lu = opts.lineups[s];
      const ids = [...Lu.F.flat(), ...Lu.D.flat(), Lu.u20F, Lu.u20D, ...Lu.pp1, ...Lu.pp2, ...Lu.pk1, ...Lu.pk2];
      for (const id of ids) if (this.validSkater(id)) this.agent(id, s);
      const g = this.goalieIds[s];
      if (g && this.P[g]) { const a = this.agent(g, s, true); a.on = 'ice'; const n = loc(s, { x: GOAL + 1, y: MID }); a.x = n.x; a.y = n.y; a.fa = s ? Math.PI : 0; }
      for (const [id, end] of opts.box?.[s] ?? []) { const a = this.agents.get(id); if (a && !a.goalie && end > 0) { a.on = 'box'; a.boxUntil = end; const seat = this.boxSeat(a); a.x = seat.x; a.y = seat.y; } }
    }
    for (const s of [0, 1] as Side[]) this.setUnit(s, true);
    // lined up for the opening faceoff from the first frame (nobody is seen jumping from the bench to his place)
    this.setupFaceoff({ x: 30, y: 15 }, null, false);
    this.startStop('start', { x: 30, y: 15 }, 0.4);
  }

  /* ---------------- public API ---------------- */
  get flipped() { return !!this.opts.flip; }
  /** The way the manager's team attacks in presentation terms (+1: toward +x); undefined without a manager. */
  get attack(): 1 | -1 | undefined { const s = this.opts.userSide; return s === null ? undefined : (s === 0) !== this.flipped ? 1 : -1; }
  /** The interactive rink is simulated as it is played: nothing to compute ahead. */
  ensure(_tau: number) { /* frames are produced by step() */ }
  get ended() { return this.mode === 'end'; }
  get lastTau() { return this.frames.length ? this.frames[this.frames.length - 1].tau : 0; }
  /** Events since the last call. */
  drain(): PlayOut[] { const o = this.out; this.out = []; return o; }
  /** Advances real time by `dt` seconds (fixed internal steps of 1/60 s) with the manager's controls. */
  advance(dt: number, pad: PadState = NO_PAD) {
    this.stepAcc = Math.min(this.stepAcc + dt, 0.25);
    while (this.stepAcc >= STEP - 1e-9) { this.stepAcc -= STEP; this.step(pad); }
  }
  /** Skaters per side right now (in the box ones excluded, an extra attacker included). */
  men(): [number, number] { return [this.skaters(0).length, this.skaters(1).length]; }
  /** Men in the box per side with the time left on their penalties (period-clock seconds). */
  boxed(): [{ id: string; left: number }[], { id: string; left: number }[]] {
    return [0, 1].map(s => [...this.agents.values()].filter(a => a.side === s && a.on === 'box').map(a => ({ id: a.id, left: Math.max(0, a.boxUntil - this.clock) })).sort((p, q) => p.left - q.left)) as [{ id: string; left: number }[], { id: string; left: number }[]];
  }
  /** A delayed penalty is signalled against this side (the referee's arm is up). */
  get delayed(): Side | null { return this.pending.length ? this.pending[0].side : null; }
  /** On-ice skaters per side (ids), for the books. */
  ice(): [(string | null)[], (string | null)[]] { return [this.skaters(0, true).map(a => a.id), this.skaters(1, true).map(a => a.id)]; }
  goalieOn(s: Side): string | null { return this.goalieOf(s)?.id ?? null; }
  /** The manager's view of his controlled player: what each button does right now and the charge of a windup. */
  hud(): { ctl: string | null; power: number; context: 'carry' | 'support' | 'defend'; labels: { shoot: string; pass: string; deke: string }; energy: number; faceoff: boolean; foCue: 'ready' | 'now' | null; foCall: string | null; move: string | null } {
    const me = this.ctl ? this.agents.get(this.ctl) : undefined, s = this.opts.userSide;
    const p = this.puck;
    const context = me && p.carrier === me ? 'carry' : s !== null && (p.carrier?.side === s || (p.passTo && p.passTo.side === s)) ? 'support' : 'defend';
    const act = me?.act;
    const power = act?.k === 'windup' ? (act.what === 'shot' ? (this.ss.back >= 0 ? stickPower(this.tau - this.ss.back) : buttonPower(this.tau - act.t0)) : clamp((this.tau - act.t0) / 0.5, 0, 1)) : 0;
    const labels = context === 'carry' ? { shoot: 'Бросок', pass: 'Пас', deke: 'Финт' } : context === 'support' ? { shoot: 'В касание', pass: 'Дай пас', deke: 'Финт' } : { shoot: 'Силовой', pass: 'Смена', deke: 'Отбор' };
    // the draw: «ready» while the referee holds the puck, «now» once it falls (until the draw is decided)
    const fo = this.mode === 'faceoff' ? this.fo : null;
    const foCue = fo && !fo.done && !fo.gather && s !== null ? (this.tau >= fo.drop ? 'now' : 'ready') : null;
    const foCall = this.foCall && this.tau < this.foCall.until ? this.foCall.text : null;
    // the move he is making right now (the HUD names it: a deke on a button press is otherwise easy to miss)
    const move = act?.k === 'deke' ? DEKE_NAME[act.kind] : act?.k === 'poke' ? (act.lift ? 'подбил клюшку' : 'отбор клюшкой') : null;
    return { ctl: this.ctl, power, context, labels, energy: me?.energy ?? 1, faceoff: this.mode === 'faceoff', foCue, foCall, move };
  }
  /** The manager hands his skater back to the AI (the rest of the period is simulated). */
  autopilot() { this.opts.userSide = null; this.ctl = null; }
  /** Plays the rest of the block without the manager (fast: no presentation). */
  runToEnd(maxSteps = 200000) { this.autopilot(); for (let i = 0; i < maxSteps && !this.ended; i++) this.step(NO_PAD); }
  /** Pull (true) or return (false) side s's goalie. */
  setPulled(s: Side, on: boolean) { this.pulled[s] = on; }
  /** Line change right now (at the next chance on the fly) for side s: everyone, only the forwards (NHL: offensive) or only the defence pair. */
  requestChange(s: Side, who: 'all' | 'F' | 'D' = 'all') { this.changeNow[s] = this.changeNow[s] && this.changeNow[s] !== who ? 'all' : who; }
  private changeNow: [false | 'all' | 'F' | 'D', false | 'all' | 'F' | 'D'] = [false, false];
  /** The d-pad tactics: the next forecheck (balanced → aggressive → passive) or breakout (standard → stretch → safe). Returns its name. */
  cycleForecheck(s: Side): string { const v = this.forecheck[s] === 0 ? 1 : this.forecheck[s] === 1 ? -1 : 0; this.forecheck[s] = v; return FORECHECK_NAME[v + 1]; }
  cycleBreakout(s: Side): string { this.breakout[s] = (this.breakout[s] + 1) % 3; return BREAKOUT_NAME[this.breakout[s]]; }

  /** The frame both rinks draw at presentation time `tau` (interpolated between simulation steps). */
  frameAt(tau: number): LiveFrame {
    const f = this.frames;
    if (!f.length) return this.liveFrame(this.snapshot(), this.snapshot(), 0);
    if (tau >= f[f.length - 1].tau) return this.liveFrame(f[f.length - 1], f[f.length - 1], 0);
    if (tau <= f[0].tau) return this.liveFrame(f[0], f[0], 0);
    let lo = 0, hi = f.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (f[m].tau <= tau) lo = m; else hi = m; }
    return this.liveFrame(f[lo], f[hi], (tau - f[lo].tau) / (f[hi].tau - f[lo].tau || 1));
  }
  /** Presentation x (rink percent 0…100), mirrored when the teams have switched ends. */
  private px(x: number) { return (this.opts.flip ? L - x : x) / 0.6; }
  private liveFrame(a: Frame, b: Frame, u: number): LiveFrame {
    const index = new Map(b.ids.map((id, i) => [id, i] as const));
    const skaters: LiveFrame['skaters'] = a.sk.map(s => {
      const j = index.get(s.id), t = j === undefined ? s : b.sk[j];
      const jump = Math.hypot(t.x - s.x, t.y - s.y) > 3;
      const x = jump ? t.x : s.x + (t.x - s.x) * u, y = jump ? t.y : s.y + (t.y - s.y) * u;
      const fa = s.fa + angDiff(s.fa, t.fa) * u;
      return { id: s.id, side: s.side, goalie: s.goalie || undefined, box: s.box || undefined, pos: { x: this.px(x), y: y / 0.3, h: 0 }, dir: { x: this.opts.flip ? -Math.cos(fa) : Math.cos(fa), y: Math.sin(fa) }, ctrl: t.ctrl || undefined, fall: t.fall || undefined, fallKind: t.fall ? t.fk : undefined, fallSide: t.fall && t.fk === 'side' ? t.fs : undefined, check: t.check || undefined, poke: t.poke && !t.mv ? t.poke : undefined, deke: t.deke || undefined, move: t.mv ?? undefined, moveT: t.mv ? s.mv === t.mv ? s.mt + (t.mt - s.mt) * u : t.mt : undefined, stagger: t.stag || undefined,
        stance: t.st ?? undefined, stanceT: t.st ? (s.st === t.st ? s.stT + (t.stT - s.stT) * u : t.stT) : undefined, handle: t.hl ? s.hl + (t.hl - s.hl) * u : undefined };
    });
    const cap = [...this.plays].reverse().find(p => p.tau <= a.tau + 1e-9 && a.tau - p.tau < 2.6);
    return {
      puck: { x: this.px(a.px + (b.px - a.px) * u), y: (a.py + (b.py - a.py) * u) / 0.3, h: a.ph + (b.ph - a.ph) * u },
      skaters, faceoff: a.stop === 1 || undefined, stopped: a.stop > 0 || undefined,
      carrier: a.carrier >= 0 ? a.ids[a.carrier] : null, caption: cap?.text,
      official: a.stop ? { x: this.px(a.ox), y: a.oy / 0.3, h: 0 } : undefined,
      dot: a.stop ? { x: this.px(a.dx), y: a.dy / 0.3, h: 0 } : undefined,
    };
  }
  /** Game clock at presentation time (the match screen shows it). */
  clockAt(tau: number): number {
    const f = this.frames;
    if (!f.length) return this.clock;
    const fr = tau >= f[f.length - 1].tau ? f[f.length - 1] : f.find(x => x.tau >= tau) ?? f[f.length - 1];
    return fr.clock;
  }

  /** Motion for the 3D players: windups as they happen (a held shot keeps the stick loaded), follow-throughs after. */
  readonly motion = {
    update: () => { /* releases are pushed live */ },
    prune: (tau: number) => { let n = 0; while (n < this.releases.length && this.releases[n].t < tau - 18) n++; if (n) this.releases.splice(0, n); },
    netX: (side: Side) => ((side === 0) !== this.flipped ? 1 : -1) * NET_X,
    goalAt: (tau: number): { side: Side; tau: number; netX: number } | null => {
      for (let i = this.plays.length - 1; i >= 0; i--) {
        const p = this.plays[i];
        if (p.tau > tau) continue;
        if (tau - p.tau > 6) return null;
        if (p.kind === 'goal' && p.side !== null) return { side: p.side, tau: p.tau, netX: this.motion.netX(p.side) };
      }
      return null;
    },
    releaseAt: (id: string, tau: number): { rel: PlayRelease; s: number; aim: number } | null => {
      const a = this.agents.get(id);
      // a windup in progress: the stick goes back, a held shot stays loaded until it is let go
      if (a && a.act?.k === 'windup' && Math.abs(tau - this.tau) < 0.25) {
        const kind: ReleaseKind = a.act.what === 'pass' ? 'pass' : this.tau - a.act.t0 > 0.45 ? 'slap' : 'wrist';
        const u = clamp((this.tau - a.act.t0) / WINDUP[kind], 0, 0.92);
        const net = this.netWorld(a.side);
        return { rel: { id, side: a.side, t: this.tau + (1 - u) * WINDUP[kind], kind, windup: WINDUP[kind], follow: FOLLOW[kind], tx: net.x, tz: net.z }, s: -1 + u, aim: smooth01(u * 3) };
      }
      let best: { rel: PlayRelease; s: number; aim: number } | null = null;
      for (const rel of this.releases) {
        if (rel.id !== id) continue;
        const sec = tau - rel.t;
        if (sec < -rel.windup - 0.2 || sec > rel.follow + 0.25) continue;
        const s = sec < 0 ? sec / rel.windup : sec / (rel.follow / 1.9);
        const aim = smooth01((sec + rel.windup + 0.2) / 0.2) * (1 - smooth01((sec - rel.follow * 0.55) / (rel.follow * 0.45 + 0.25)));
        if (!best || Math.abs(sec) < Math.abs(tau - best.rel.t)) best = { rel, s, aim };
      }
      return best;
    },
  };
  private netWorld(side: Side) { return { x: this.motion.netX(side), z: 0 }; }
  private world(p: V2) { return { x: (this.px(p.x) - 50) * RINK.length / 100, z: (p.y / 0.3 - 50) * RINK.width / 100 }; }

  /** The goal sequence for the 3D replay (the frames of the 2D rink around the goal at `tau`). */
  goalClip(tau: number): ReplayClip | null {
    const c = this.clips.find(x => Math.abs(x.e.tau - tau) < 1e-6);
    if (!c) return null;
    if (!c.clip) c.clip = this.buildClip(c.e);
    return c.clip;
  }
  private buildClip(e: { tau: number; scorer: string; side: Side; kind: ShotKind; release: number; strength: Strength }): ReplayClip | null {
    const startAt = Math.max(this.frames[0]?.tau ?? 0, e.tau - 7), endAt = Math.min(this.lastTau, e.tau + 2.2);
    const frames = this.frames.filter((f, i) => f.tau >= startAt - 1e-9 && f.tau <= endAt + 1e-9 && i % 2 === 0);
    if (frames.length < 3) return null;
    const at = frames.find(f => f.tau >= e.tau - 1e-9) ?? frames[frames.length - 1];
    const duration = Math.max(0.5, endAt - startAt), norm = (t: number) => clamp((t - startAt) / duration, 0, 1);
    const tracks: Track[] = at.sk.filter(s => !s.box).map(s => {
      const keys: Key[] = [];
      for (const f of frames) { const q = f.sk.find(x => x.id === s.id); if (q && !q.box) keys.push({ t: norm(f.tau), x: this.px(q.x), y: q.y / 0.3, h: 0 }); }
      if (!keys.length) return null;
      if (keys[0].t > 0) keys.unshift({ ...keys[0], t: 0 });
      if (keys[keys.length - 1].t < 1) keys.push({ ...keys[keys.length - 1], t: 1 });
      return { id: s.id, side: s.side, goalie: s.goalie || undefined, keys } as Track;
    }).filter((t): t is Track => !!t);
    const puck: Key[] = frames.map(f => ({ t: norm(f.tau), x: this.px(f.px), y: f.py / 0.3, h: f.ph }));
    const touches: { id: string; t0: number; t1: number }[] = [];
    let held: string | null = null;
    for (const f of frames) {
      const id = f.carrier >= 0 ? f.ids[f.carrier] : null, t = norm(f.tau);
      if (id && id === held) touches[touches.length - 1].t1 = t; else if (id) touches.push({ id, t0: t, t1: t });
      held = id;
    }
    const labels: Record<ShotKind, string> = { wrist: 'Кистевой бросок', snap: 'Бросок с ходу', slap: 'Щелчок', tip: 'Подставление на пятаке', rebound: 'Добивание', backhand: 'Бросок с неудобной' };
    return { label: e.strength === 'EN' ? 'Бросок в пустые ворота' : labels[e.kind], duration, release: norm(e.release), goal: norm(e.tau), tracks, puck, scorer: e.scorer, attacking: e.side, bodies: true, dir: ((e.side === 0) !== this.flipped ? 1 : -1) as 1 | -1, touches, shot: e.kind };
  }

  /* ---------------- set-up ---------------- */
  private validSkater(id: string | null | undefined): id is string {
    const p = id ? this.P[id] : undefined;
    return !!p && p.position !== 'G' && !p.inVhl;
  }
  private agent(id: string, side: Side, goalie = false): Sk {
    let a = this.agents.get(id);
    if (a) return a;
    const p = this.P[id];
    const skate = sk(p, 'skating');
    const Lu = this.opts.lineups[side];
    const kindD = !goalie && (Lu.D.some(x => x.includes(id)) || Lu.u20D === id || (!Lu.F.some(x => x.includes(id)) && p?.position === 'D'));
    a = {
      id, side, goalie, name: p?.name ?? id, hand: p?.hand === 'L' ? -1 : 1, kindD, role: goalie ? 'G' : kindD ? 'LD' : 'C',
      x: this.bench[side].x, y: this.bench[side].y, vx: 0, vy: 0, fa: side ? Math.PI : 0,
      max: goalie ? 4.4 : 7.0 + (skate - 60) * 0.05, acc: goalie ? 14 : 5.4 + (skate - 60) * 0.045,
      shoot: sk(p, 'shooting'), pass: sk(p, 'passing'), hands: sk(p, 'puckControl', sk(p, 'puckHandling')), check: sk(p, 'checking'), def: sk(p, 'defense'),
      bal: sk(p, 'checking') * 0.5 + skate * 0.3 + sk(p, 'endurance', 70) * 0.2,
      fo: sk(p, 'puckControl', 62) * 0.45 + sk(p, 'checking') * 0.3 + sk(p, 'passing') * 0.25,
      endur: sk(p, 'endurance', 70), ovr: p?.overall ?? 70, rebound: sk(p, 'reboundControl', 70),
      energy: 1, on: 'bench', leaving: false, boxUntil: 0, stun: 0, fall: 0, act: null, cool: 0, ownAt: -9, fallK: 'back', fallS: 1, fallAt: -9,
      manual: false, wx: 0, wy: 0, sprint: false, tx: this.bench[side].x, ty: this.bench[side].y, urg: 0.6, back: false,
      decideAt: 0, carryT: null, lastPuck: -9, spot: -1, rolled: -1, oneTimer: false, dekeBeat: -9, dekeF: 1.6, dekeR: 6, stagger: 0,
    };
    this.agents.set(id, a);
    return a;
  }
  private onIce(side?: Side) { return [...this.agents.values()].filter(a => a.on === 'ice' && (side === undefined || a.side === side)); }
  /** Skaters of a side on the ice (not the goalie); `withLeaving` also counts men on their way to the bench. */
  private skaters(side: Side, withLeaving = true) { return this.onIce(side).filter(a => !a.goalie && (withLeaving || !a.leaving)); }
  private goalieOf(side: Side) { return this.onIce(side).find(a => a.goalie && !a.leaving) ?? null; }
  private boxCount(side: Side) { return [...this.agents.values()].filter(a => a.side === side && a.on === 'box').length; }
  /** How many skaters side s should have: five (three in the 3-on-3 overtime) less the men in the box. */
  private manpower(s: Side): number {
    const mine = Math.min(2, this.boxCount(s)), theirs = Math.min(2, this.boxCount((1 - s) as Side));
    // KHL 3-on-3 overtime: a penalty gives the other team a fourth (fifth) skater instead
    if (this.opts.kind === 'ot3') return clamp(3 + Math.max(0, theirs - mine), 3, 5);
    return 5 - mine;
  }
  private play(kind: PlayKind, side: Side | null, text: string, who?: Sk) {
    this.plays.push({ tau: this.tau, g: this.clock, kind, side, player: who?.id, text });
    if (this.plays.length > 200) this.plays.splice(0, 50);
  }
  private boxSeat(a: Sk): V2 {
    const n = [...this.agents.values()].filter(b => b.side === a.side && b.on === 'box' && b !== a).length;
    return { x: this.box[a.side].x + (a.side ? 1 : -1) * (0.8 + n * 1.0), y: 31.4 };
  }

  /** The unit side s should have on the ice for the current manpower: ids, forwards first. */
  private unitFor(s: Side): string[] {
    const n = this.manpower(s), other = this.manpower((1 - s) as Side), Lu = this.opts.lineups[s];
    const free = (id: string | null | undefined): id is string => this.validSkater(id) && this.agents.get(id)?.on !== 'box';
    let ids: (string | null)[];
    if (n > other && n >= 4 && this.opts.kind !== 'ot3') ids = (this.ppIdx[s] % 2 ? Lu.pp2 : Lu.pp1).slice(0, n);
    else if (n < other && n <= 4 && this.opts.kind !== 'ot3') ids = n === 4 ? (this.ppIdx[s] % 2 ? Lu.pk2 : Lu.pk1).slice(0, 4) : [(Lu.pk1[0] ?? null), ...(Lu.pk1.slice(2, 4))];
    else {
      const F = Lu.F[this.lineIdx[s] % Math.max(1, Lu.F.length)] ?? [], D = Lu.D[this.pairIdx[s] % Math.max(1, Lu.D.length)] ?? [];
      ids = n >= 5 ? [...F, ...D] : n === 4 ? [F[0], F[1], ...D] : [F[0], F[1], D[0]];
      if (n > 5) ids.push(F[2]);
    }
    const swap = this.sub[s];
    const out = [...new Set(ids.map(id => (id && swap.has(id) && free(swap.get(id)) ? swap.get(id)! : id)).filter(free))];
    // fill gaps with dressed men of the missing kind (defencemen first when a pair is short)
    const wantD = n >= 4 ? 2 : 1;
    const pool = [...Lu.F.flat(), ...Lu.D.flat(), Lu.u20F, Lu.u20D].filter(free);
    while (out.length < n) {
      const needD = out.filter(id => this.agents.get(id)?.kindD).length < wantD && out.length >= n - wantD;
      const next = pool.find(id => !out.includes(id) && !!this.agents.get(id)?.kindD === needD && (this.agents.get(id)?.energy ?? 0) > 0.3) ?? pool.find(id => !out.includes(id));
      if (!next) break;
      out.push(next);
    }
    return out.slice(0, n);
  }
  /** Puts side s's unit on the ice (at a whistle: an instant change; the faceoff places everybody). */
  private setUnit(s: Side, force = false) {
    const want = this.unitFor(s);
    const extra = this.pulled[s] && this.goalieOf(s) === null;
    const cur = this.skaters(s);
    if (!force && cur.length === want.length + (extra ? 1 : 0) && want.every(id => cur.some(a => a.id === id))) return;
    for (const a of cur) if (!want.includes(a.id)) { a.on = 'bench'; a.leaving = false; a.act = null; }
    // the new men step on along the bench front, side by side (not all on one spot, pushed apart in a frame)
    let k = 0;
    for (const id of want) { const a = this.agents.get(id)!; if (a.on !== 'ice') { a.on = 'ice'; a.x = this.bench[s].x + (k++ - 2) * 0.9; a.y = this.bench[s].y + 1; a.vx = 0; a.vy = 0; } a.leaving = false; }
    if (extra) this.addExtra(s);
    this.assignRoles(s);
  }
  private addExtra(s: Side) {
    const Lu = this.opts.lineups[s];
    const id = [...Lu.F.flat(), ...Lu.D.flat()].find(x => this.validSkater(x) && this.agents.get(x)?.on === 'bench');
    if (!id) return;
    const a = this.agents.get(id)!;
    a.on = 'ice'; a.leaving = false; a.x = this.bench[s].x; a.y = this.bench[s].y + 1; a.vx = 0; a.vy = 2;
  }
  private assignRoles(s: Side) {
    const list = this.skaters(s, false);
    const F = list.filter(a => !a.kindD), D = list.filter(a => a.kindD);
    const fr: Role[] = ['C', 'LW', 'RW'], dr: Role[] = ['LD', 'RD'];
    F.forEach((a, i) => { a.role = fr[i] ?? 'RW'; });
    D.forEach((a, i) => { a.role = dr[i] ?? 'RD'; });
  }

  /* ---------------- whistles and faceoffs ---------------- */
  private startStop(reason: PlayRink['stopInfo']['reason'], dot: V2, wait = 1.3, icingSide: Side | null = null) {
    this.mode = 'stop';
    this.stopInfo = { reason, dot, until: this.tau + wait, icingSide };
    const p = this.puck;
    if (reason !== 'goal') { p.dead = true; }
    p.shot = null; p.passTo = null; p.passBy = null; p.icing = null;
    for (const a of this.onIce()) { if (a.act?.k !== 'deke') a.act = null; a.oneTimer = false; }
    // penalties are called at the whistle
    if (this.pending.length) {
      const list = this.pending; this.pending = [];
      for (const pen of list) this.assess(pen);
    }
  }
  private assess(pen: Pending) {
    const a = pen.player;
    if (a.on !== 'ice') return;
    a.on = 'box'; a.leaving = false; a.act = null; a.boxUntil = this.clock + pen.min * 60; a.boxMin = pen.min;
    if (this.early[a.side]?.leaver === a || this.early[a.side]?.id === a.id) this.early[a.side] = null;
    // he skates to the penalty box door himself (out of the play at once), then sits down
    a.boxGo = true; a.stun = 0; a.fall = 0;
    if (this.puck.carrier === a) this.puck.carrier = null;
    this.out.push({ type: 'penalty', side: pen.side, player: a.id, min: pen.min, reason: pen.reason });
    this.play('penalty', pen.side, `Удаление: ${a.name} — ${pen.reason} (${pen.min === 4 ? '2+2' : pen.min} мин)`, a);
    this.ppIdx[(1 - pen.side) as Side] = 0; this.ppIdx[pen.side] = 0;
    if (this.ctl === a.id) this.ctl = null;
  }
  private stepStop() {
    const st = this.stopInfo;
    for (const a of this.onIce()) {
      if (a.goalie) { this.goalieTarget(a); continue; }
      a.manual = false;
      if (st.reason === 'goal' && this.goalsFor.length) {
        // the scorer's teammates gather round him, the others drift away
        const g = this.goalsFor[this.goalsFor.length - 1], sc = this.agents.get(g.id);
        if (sc && a.side === g.side && a !== sc) { a.tx = sc.x - (sc.x - a.x) * 0.25; a.ty = sc.y - (sc.y - a.y) * 0.25; a.urg = 0.7; }
        else if (a === sc) { const t = inside({ x: a.x + a.vx * 0.6, y: a.y + a.vy * 0.6 }, 2); a.tx = t.x; a.ty = t.y; a.urg = 0.5; }
        else { a.tx = a.x; a.ty = a.y; a.urg = 0.3; }
      } else { a.tx = a.x + a.vx * 0.15; a.ty = a.y + a.vy * 0.15; a.urg = 0.3; }
    }
    for (const a of this.onIce()) this.move(a);
    this.collide();
    if (this.puck.inNet !== null) this.netPuck();
    if (this.tau < st.until) return;
    if (st.reason === 'end' || (st.reason === 'goal' && this.opts.kind !== 'reg' && this.goalsFor.length)) { this.finish(); return; }
    this.setupFaceoff(st.dot, st.icingSide, st.reason !== 'start');
  }
  private finish() {
    if (this.mode === 'end') return;
    this.mode = 'end';
    this.out.push({ type: 'end' });
  }
  private setupFaceoff(dot: V2, icingSide: Side | null, gather = true) {
    // changes at the whistle (the team that iced the puck may not change): forwards and defence each to their
    // freshest line / pair when the men out there are tired, single tired men for a fresh one off the bench
    for (const s of [0, 1] as Side[]) {
      const sk2 = this.skaters(s);
      const wrongSize = sk2.length !== this.manpower(s) + (this.pulled[s] && !this.goalieOf(s) ? 1 : 0);
      if (s === icingSide && !wrongSize) { this.changeNow[s] = false; continue; }
      const want = this.changeNow[s], even = this.manpower(s) === this.manpower((1 - s) as Side);
      let changed = false;
      for (const kind of ['F', 'D'] as const) {
        const on = sk2.filter(a => a.kindD === (kind === 'D'));
        const e = on.length ? on.reduce((m, a) => m + a.energy, 0) / on.length : 1;
        const next = this.freshest(s, kind), eNext = this.groupEnergy(s, kind, next);
        if (want === 'all' || want === kind || (e < 0.82 && eNext > e + 0.08)) { this.setGroup(s, kind, next); changed = true; }
      }
      if (even) { if (changed) this.ppIdx[s]++; }
      else {
        // the power play / penalty kill: the fresher of its two units
        const e = sk2.length ? sk2.reduce((m, a) => m + a.energy, 0) / sk2.length : 1;
        const unitE = (k: number) => { this.ppIdx[s] = k; const u = this.unitFor(s); return u.reduce((m, id) => m + (this.agents.get(id)?.energy ?? 0), 0) / Math.max(1, u.length); };
        const cur = this.ppIdx[s] % 2, mine = unitE(cur), other = unitE(cur + 1);
        this.ppIdx[s] = want || (e < 0.8 && other > mine + 0.05) ? cur + 1 : cur;
      }
      // a man left out of breath in a unit that stays: the freshest of his kind on the bench takes his place
      for (const a of this.unitFor(s).map(id => this.agents.get(id)!)) if (a.energy < 0.5) this.subFor(s, a, 0.75);
      if (changed || wrongSize || this.unitFor(s).some(id => this.agents.get(id)?.on !== 'ice')) this.setUnit(s, true);
      for (const a of this.skaters(s)) this.offNext.delete(a.id);
      this.changeNow[s] = false;
    }
    // a goalie returns to his net at a whistle unless the bench keeps him pulled
    for (const s of [0, 1] as Side[]) {
      const g = this.goalieIds[s] ? this.agents.get(this.goalieIds[s]!) : undefined;
      if (!g) continue;
      if (this.pulled[s] && this.aiPullOk(s)) { if (g.on === 'ice') g.on = 'bench'; if (this.skaters(s).length < this.manpower(s) + 1) this.addExtra(s); }
      else if (g.on !== 'ice') {
        g.on = 'ice'; g.leaving = false;
        const ex = this.skaters(s).length - this.manpower(s);
        if (ex > 0) { const cut = this.skaters(s).filter(a => a.id !== this.ctl).slice(-ex); cut.forEach(a => { a.on = 'bench'; }); }
      }
    }
    const p = this.puck;
    p.dead = true; p.carrier = null; p.inNet = null; p.shot = null; p.passTo = null; p.icing = null;
    p.x = dot.x; p.y = dot.y; p.h = 1.1; p.vx = 0; p.vy = 0; p.vh = 0;
    this.touches = [];
    const place = new Map<string, V2>();
    for (const s of [0, 1] as Side[]) {
      this.assignRoles(s);
      const list = this.skaters(s), d = loc(s, dot);
      const F = list.filter(a => !a.kindD), D = list.filter(a => a.kindD);
      const order = [...F, ...D];
      const spots: V2[] = [{ x: d.x - 0.95, y: d.y }, { x: d.x - 1.1, y: d.y - 4.3 }, { x: d.x - 1.1, y: d.y + 4.3 }, { x: d.x - 6.5, y: d.y - 3.4 }, { x: d.x - 6.5, y: d.y + 3.4 }, { x: d.x - 4, y: d.y }];
      // a short-handed unit: the defencemen take the back spots
      const take = (a: Sk, i: number) => {
        const sp = a.kindD && i < 3 && D.length + F.length < 5 ? spots[3 + D.indexOf(a)] ?? spots[i] : spots[i];
        const l = inside({ x: Math.max(GOAL + 1.4, sp.x), y: sp.y }, 1);
        const g = loc(s, l);
        place.set(a.id, g);
        a.act = null; a.stun = 0; a.fall = 0; a.leaving = false;
        // the opening faceoff: everybody is there already; at a whistle they skate there (no teleporting)
        if (!gather) { a.x = g.x; a.y = g.y; a.vx = 0; a.vy = 0; a.fa = s ? Math.PI : 0; }
        a.tx = g.x; a.ty = g.y;
      };
      order.forEach((a, i) => take(a, Math.min(i, spots.length - 1)));
      const g = this.goalieOf(s);
      if (g) { const n = loc(s, { x: GOAL + 1.0, y: MID }); place.set(g.id, n); if (!gather) { g.x = n.x; g.y = n.y; g.vx = 0; g.vy = 0; g.fa = s ? Math.PI : 0; } }
    }
    // the manager takes his centre for the draw
    const us = this.opts.userSide;
    if (us !== null) { const c = this.center(us); if (c) this.ctl = c.id; }
    this.mode = 'faceoff';
    const setAt = this.tau;
    // the official skates to the dot and holds the puck out before he drops it (see officialCrew)
    this.fo = { dot, setAt, drop: setAt + 1.5 + this.rand() * 0.6, press: -1, btn: false, done: false, gather, until: setAt + FO_GATHER_MAX, spots: place, decide: NaN };
    this.zoneIn = [loc(0, dot).x > OPP_BLUE, loc(1, dot).x > OPP_BLUE];
  }
  private center(s: Side): Sk | null {
    const list = this.skaters(s), d = this.fo?.dot ?? this.puck;
    return list.length ? list.reduce((b, a) => (dist(a, d) < dist(b, d) ? a : b)) : null;
  }
  private stepFaceoff(press: { shoot: boolean; pass: boolean; faceoff: boolean }) {
    const fo = this.fo!;
    const p = this.puck;
    if (fo.gather) {
      // everybody skates to his place (the goalies to their nets); the official waits with the puck at the dot
      let ready = true;
      for (const a of this.onIce()) {
        a.manual = false;
        const sp = fo.spots.get(a.id);
        if (!sp) { if (a.goalie) this.goalieTarget(a); else { a.tx = a.x; a.ty = a.y; a.urg = 0.3; } }
        else { a.tx = sp.x; a.ty = sp.y; const d = Math.hypot(sp.x - a.x, sp.y - a.y); a.urg = d > 8 ? 0.85 : 0.6; if (d > 0.3) ready = false; }
        this.move(a);
        // close to the place: turn to face the dot like a player setting up
        if (sp && Math.hypot(sp.x - a.x, sp.y - a.y) < 1.5 && !a.goalie) a.fa += angDiff(a.fa, a.side ? Math.PI : 0) * 0.2;
      }
      this.collide();
      p.x = fo.dot.x; p.y = fo.dot.y; p.h = 1.1;
      if (!ready && this.tau < fo.until) return;
      // the last few centimetres are set straight (anybody still far off after the wait stays where he is: nobody is seen jumping)
      for (const a of this.onIce()) { const sp = fo.spots.get(a.id); if (sp && Math.hypot(sp.x - a.x, sp.y - a.y) < 1.2) { a.x = sp.x; a.y = sp.y; } a.vx = 0; a.vy = 0; if (!a.goalie || sp) a.fa = a.side ? Math.PI : 0; a.tx = a.x; a.ty = a.y; }
      fo.gather = false; fo.setAt = this.tau; fo.drop = this.tau + 1.5 + this.rand() * 0.6;
      return;
    }
    if ((press.faceoff || press.shoot || press.pass) && fo.press < 0) { fo.press = this.tau; fo.btn = press.faceoff; }
    for (const a of this.onIce()) { a.manual = false; if (a.goalie) this.goalieTarget(a); else { a.tx = a.x; a.ty = a.y; a.urg = 0.2; } this.move(a); }
    // the drop: a short windup (the hand comes up), the throw down, then the centres battle for the puck on the ice
    const t = this.tau - fo.drop;
    if (t >= -FO_DROP.windup && t < 0) p.h = 1.1 + 0.22 * smooth01((t + FO_DROP.windup) / FO_DROP.windup);
    else if (t >= 0) p.h = Math.max(0, 1.32 - t * 9);
    if (t > FO_DROP.fall) { p.x = fo.dot.x + Math.sin(t * 31) * 0.09 * (1 - smooth01((t - FO_DROP.fall) / FO_DROP.battle)); p.y = fo.dot.y + Math.sin(t * 19 + 1) * 0.05; }
    if (t < FO_DROP.fall + FO_DROP.battle || fo.done) return;
    p.x = fo.dot.x; p.y = fo.dot.y;
    fo.done = true;
    const c0 = this.center(0), c1 = this.center(1);
    if (!c0 || !c1) { this.mode = 'play'; p.dead = false; p.h = 0; return; }
    let pr = 0.5 + (c0.fo - c1.fo) / 170;
    const us = this.opts.userSide;
    if (us !== null) {
      // timing the drop: the manager's centre wins clean with a press right as the puck falls
      // the faceoff button has a wider clean window than the shot / pass fallback
      const t = fo.press < 0 ? 9 : fo.press - fo.drop, clean = fo.btn ? 0.2 : 0.14;
      const bonus = t < -0.07 ? -0.45 : t <= clean ? (fo.btn ? 0.36 : 0.3) : t <= 0.32 ? 0.1 : -0.12;
      pr += us === 0 ? bonus : -bonus;
      this.foCall = { text: t < -0.07 ? 'Рано!' : t <= clean ? 'Идеально!' : t <= 0.32 ? 'Неплохо' : fo.press < 0 ? 'Не нажали' : 'Поздно', until: this.tau + 1.4 };
    }
    const w: Side = this.rand() < clamp(pr, 0.06, 0.94) ? 0 : 1;
    const winner = w ? c1 : c0;
    this.faceoffWins[w]++;
    // the puck goes back to the winner's side: toward his defenceman on the strong side
    const mates = this.skaters(w).filter(a => a !== winner);
    const back = mates.filter(a => a.kindD).sort((a, b) => dist(a, p) - dist(b, p))[0] ?? mates[0];
    const aim = back ? { x: back.x, y: back.y } : loc(w, { x: loc(w, p).x - 5, y: MID });
    const dx = aim.x - p.x, dy = aim.y - p.y, d = Math.hypot(dx, dy) || 1, sp = clamp(d * 1.3, 4, 9);
    p.dead = false; p.h = 0; p.vh = 0; p.vx = (dx / d) * sp; p.vy = (dy / d) * sp; p.last = winner; p.leg++;
    p.noTouch = w ? c0 : c1; p.noTouchUntil = this.tau + 0.35;
    if (back) { p.passTo = back; p.passBy = winner; }
    this.out.push({ type: 'faceoff', side: w, player: winner.id });
    this.play('faceoff', w, `Вбрасывание выиграл ${winner.name}`, winner);
    this.mode = 'play';
    this.fo = null;
  }

  /* ---------------- the main step ---------------- */
  private step(pad: PadState) {
    this.tau += STEP;
    const prev = this.prevPad;
    const press = { shoot: pad.shoot && !prev.shoot, pass: pad.pass && !prev.pass, deke: pad.deke && !prev.deke, swap: pad.swap && !prev.swap, faceoff: !!pad.faceoff && !prev.faceoff,
      poke: !!pad.poke && !prev.poke, lift: !!pad.lift && !prev.lift, pin: !!pad.pin && !prev.pin, hustle: !!pad.hustle && !prev.hustle, push: !!pad.push && !prev.push };
    const release = { shoot: !pad.shoot && prev.shoot, pass: !pad.pass && prev.pass };
    this.prevPad = { ...pad };
    if (press.shoot) this.pressAt.shoot = this.tau;
    if (press.pass) this.pressAt.pass = this.tau;
    this.boxWalk();
    if (this.mode === 'end') { this.record(); return; }
    if (this.mode === 'stop') { this.stepStop(); this.record(); return; }
    if (this.mode === 'faceoff') { this.stepFaceoff(press); this.record(); return; }
    this.clock += STEP * this.rate;
    if (this.clock >= this.len) { this.clock = this.len; this.play('freeze', null, 'Сирена: конец периода'); this.startStop('end', { x: 30, y: 15 }, 1.2); this.record(); return; }
    this.boxes();
    this.energy();
    this.goaliePulls();
    this.changes();
    if (this.puck.carrier) this.puck.carrier.ownAt = this.tau;
    this.user(pad, press, release);
    this.think();
    for (const a of this.onIce()) this.move(a);
    this.collide();
    this.acts();
    this.puckStep();
    if (this.mode !== 'play') { this.record(); return; }
    this.contact();
    if (this.puck.carrier) this.puck.carrier.ownAt = this.tau;
    this.zones();
    this.delayedWhistle();
    this.record();
  }

  /* ---------------- penalty box, legs, changes ---------------- */
  /** Players called for a penalty skate to their box door (5.5 m/s, easing in), then take a seat. */
  private boxWalk() {
    for (const a of this.agents.values()) {
      if (a.on !== 'box' || !a.boxGo) continue;
      const door = { x: this.box[a.side].x, y: this.box[a.side].y }, dx = door.x - a.x, dy = door.y - a.y, d = Math.hypot(dx, dy);
      if (d < 0.35) { a.boxGo = false; const seat = this.boxSeat(a); a.x = seat.x; a.y = seat.y; a.vx = 0; a.vy = 0; a.fa = -Math.PI / 2; continue; }
      const v = Math.min(5.5, 1.2 + d * 1.6), k = Math.min(1, STEP * 5);
      a.vx += (dx / d * v - a.vx) * k; a.vy += (dy / d * v - a.vy) * k;
      a.x += a.vx * STEP; a.y += a.vy * STEP;
      a.fa = Math.atan2(a.vy, a.vx);
    }
  }
  private boxes() {
    for (const a of this.agents.values()) {
      if (a.on !== 'box' || this.clock < a.boxUntil - 1e-6) continue;
      a.on = 'ice'; a.boxGo = false; a.x = this.box[a.side].x; a.y = this.box[a.side].y - 0.4; a.vx = 0; a.vy = -2; a.leaving = false; a.fa = -Math.PI / 2;
      this.play('change', a.side, `${a.name} возвращается после удаления`, a);
      this.assignRoles(a.side);
    }
  }
  private energy() {
    for (const a of this.agents.values()) {
      if (a.goalie) continue;
      if (a.on === 'ice') {
        const sp = Math.hypot(a.vx, a.vy) / a.max;
        a.energy = Math.max(0, a.energy - STEP / 52 * (0.5 + 0.5 * sp) * (a.sprint ? 1.8 : 1) * (1.25 - a.endur / 200));
      } else a.energy = Math.min(1, a.energy + STEP / 28);
    }
  }
  /** Late in the game the AI bench pulls its goalie when one or two goals down (only with the puck up ice). */
  private aiPullOk(s: Side) { return this.goalieIds[s] !== null; }
  private goaliePulls() {
    for (const s of [0, 1] as Side[]) {
      if (s === this.opts.userSide) continue;
      const diff = this.score[1 - s] - this.score[s];
      const late = this.opts.kind === 'reg' && (this.opts.period ?? 1) >= 3 && this.len - this.clock < 100;
      const want = late && diff >= 1 && diff <= 2;
      if (want && !this.pulled[s]) { const pl = loc(s, this.puck); if (pl.x > RED - 4 && this.puck.carrier?.side === s) this.pulled[s] = true; }
      if (!want && this.pulled[s]) this.pulled[s] = false;
    }
    for (const s of [0, 1] as Side[]) {
      const g = this.goalieIds[s] ? this.agents.get(this.goalieIds[s]!) : undefined;
      if (!g) continue;
      if (this.pulled[s] && g.on === 'ice' && !g.leaving) { g.leaving = true; this.play('change', s, `${this.teams[s].short ?? this.teams[s].name}: вратарь уходит на скамейку — шестой полевой!`, g); }
      if (!this.pulled[s] && g.leaving && g.on === 'ice') g.leaving = false;
      if (g.leaving && g.on === 'ice' && dist(g, this.bench[s]) < 2.4) { g.on = 'bench'; g.leaving = false; this.addExtra(s); this.assignRoles(s); }
      // the goalie comes back on the fly: the extra attacker heads off first
      if (!this.pulled[s] && g.on === 'bench' && this.mode === 'play') {
        const extra = this.skaters(s).length - this.manpower(s);
        if (extra > 0) {
          const off = this.skaters(s).filter(a => a !== this.puck.carrier && a.id !== this.ctl).sort((a, b) => dist(a, this.bench[s]) - dist(b, this.bench[s]))[0];
          if (off && !off.leaving) off.leaving = true;
          if (off && dist(off, this.bench[s]) < 2.4) { off.on = 'bench'; off.leaving = false; g.on = 'ice'; g.x = this.bench[s].x; g.y = this.bench[s].y + 1; g.vx = 0; g.vy = 0; }
        } else { g.on = 'ice'; g.x = this.bench[s].x; g.y = this.bench[s].y + 1; }
      }
    }
  }
  /** Average energy of side s's forward line / defence pair number i (the men who could go out: not in the box). */
  private groupEnergy(s: Side, kind: 'F' | 'D', i: number): number {
    const g = (kind === 'F' ? this.opts.lineups[s].F : this.opts.lineups[s].D)[i] ?? [];
    const men = g.filter((id): id is string => this.validSkater(id) && this.agents.get(id)?.on !== 'box').map(id => this.agents.get(id)!);
    return men.length ? men.reduce((m, a) => m + a.energy, 0) / men.length : -1;
  }
  /**
   * The line / pair to send out next: the freshest of the others, the next in the rotation a little preferred and
   * the fourth line / third pair a little less (top units play more).
   */
  private freshest(s: Side, kind: 'F' | 'D'): number {
    const groups = kind === 'F' ? this.opts.lineups[s].F : this.opts.lineups[s].D, n = groups.length;
    const cur = (kind === 'F' ? this.lineIdx[s] : this.pairIdx[s]) % Math.max(1, n);
    let best = cur, top = -Infinity;
    for (let i = 0; i < n; i++) {
      const e = this.groupEnergy(s, kind, i);
      if (i === cur || e < 0) continue;
      const score = e - ((i - cur + n) % n) / n * 0.06 - (kind === 'F' ? (i >= 3 ? 0.07 : 0) : i >= 2 ? 0.04 : 0);
      if (score > top) { top = score; best = i; }
    }
    return best;
  }
  private setGroup(s: Side, kind: 'F' | 'D', i: number) {
    if (kind === 'F') this.lineIdx[s] = i; else this.pairIdx[s] = i;
    // the single changes of that kind are over: the line / pair goes out as it is
    for (const [k, v] of [...this.sub[s]]) if (this.agents.get(k)?.kindD === (kind === 'D') || this.agents.get(v)?.kindD === (kind === 'D')) this.sub[s].delete(k);
  }
  /** The freshest man of a's kind on the bench (above `min` energy) to take a's place in the unit; null: nobody. */
  private subFor(s: Side, a: Sk, min: number): Sk | null {
    const want = this.unitFor(s);
    let best: Sk | null = null;
    for (const b of this.agents.values()) if (b.side === s && !b.goalie && b.on === 'bench' && b.kindD === a.kindD && !want.includes(b.id) && b.energy > min && b.energy > (best?.energy ?? -1)) best = b;
    if (!best) return null;
    const key = [...this.sub[s]].find(([, v]) => v === a.id)?.[0] ?? a.id;
    this.sub[s].set(key, best.id);
    return best;
  }
  /** The next line and / or pair picked (the freshest), ahead of a change. */
  nextUnit(s: Side, who: 'all' | 'F' | 'D' = 'all') {
    if (who !== 'D') this.setGroup(s, 'F', this.freshest(s, 'F'));
    if (who !== 'F') this.setGroup(s, 'D', this.freshest(s, 'D'));
    this.ppIdx[s]++;
  }
  /**
   * Whether side s can change on the fly without being caught short: never while the other team has the puck
   * (unless it is deep in its own end and only forwards go), forwards once the puck is out past their own blue line
   * with it in their hands or past centre, defencemen only with the puck past centre ice.
   */
  private safeToChange(s: Side, kind: 'F' | 'D', spent = false): boolean {
    if (this.mode !== 'play') return false;
    const c = this.puck.carrier, pl = loc(s, this.puck);
    // out of breath altogether: any moment the other team is not coming at them will do
    if (spent) return c && c.side !== s ? kind === 'F' && pl.x > RED + 4 : pl.x > BLUE + 2;
    if (c && c.side !== s) return kind === 'F' && pl.x > OPP_BLUE + 3;
    if (kind === 'D') return pl.x > RED + 2;
    return pl.x > BLUE + 4 && (c?.side === s || pl.x > RED);
  }
  /**
   * Changes on the fly. The forwards change as a line and the defencemen as a pair, never at the same time; a
   * tired line / pair goes off only when it is safe; a man out of breath in a line that is still fine goes off on his
   * own for the freshest man of his kind; the new man jumps on at the door.
   */
  private changes() {
    if (this.tau < this.changeCheck) {
      // finish changes in progress: a man at the bench door is replaced at once
      for (const a of this.skaters(0).concat(this.skaters(1))) {
        if (!a.leaving) continue;
        const d = dist(a, this.bench[a.side]);
        if (d < 2.6) this.swapAtBench(a);
        // now and then the next man jumps a little too early
        else if (d < 7 && !this.early[a.side] && this.mode === 'play' && this.rand() < 0.0009) this.jumpEarly(a);
      }
      this.tooManyMen();
      return;
    }
    this.changeCheck = this.tau + 0.5;
    // the man who had the puck when his line was called off goes once he has given it up
    for (const id of this.offNext) {
      const a = this.agents.get(id);
      if (!a || a.on !== 'ice') { this.offNext.delete(id); continue; }
      const at = this.changedAt[a.side], other = a.kindD ? at.F : at.D;
      if (a !== this.puck.carrier && this.tau - other > 2) { a.leaving = true; this.offNext.delete(id); at[a.kindD ? 'D' : 'F'] = this.tau; }
    }
    for (const s of [0, 1] as Side[]) {
      const list = this.skaters(s, false);
      if (!list.length || list.length < this.skaters(s).length) continue;
      const c = this.puck.carrier, forced = this.changeNow[s], at = this.changedAt[s];
      // short-handed or on the power play the whole unit changes (its own lines), as before
      if (this.manpower(s) !== this.manpower((1 - s) as Side)) {
        const avg = list.reduce((m, a) => m + a.energy, 0) / list.length;
        if ((avg < 0.42 || forced) && this.safeToChange(s, 'F')) {
          this.ppIdx[s]++; this.changeNow[s] = false; at.F = at.D = this.tau;
          for (const a of list) if ((forced || a.energy < 0.7) && a !== c) a.leaving = true;
        }
        if (this.ctl && this.agents.get(this.ctl)?.leaving) this.pickControl(true);
        continue;
      }
      // the more tired group first; the other only a few seconds after the first is done
      const kinds = (['F', 'D'] as const).map(kind => {
        const on = list.filter(a => a.kindD === (kind === 'D'));
        return { kind, on, e: on.length ? on.reduce((m, a) => m + a.energy, 0) / on.length : 1 };
      }).sort((a, b) => a.e - b.e);
      let done = false;
      for (const { kind, on, e } of kinds) {
        const asked = forced === 'all' || forced === kind;
        if (!on.length || !(asked || e < (kind === 'F' ? 0.55 : 0.5))) continue;
        const other = kind === 'F' ? at.D : at.F;
        if (this.tau - other < (asked ? 2.5 : 5)) continue;
        if (!this.safeToChange(s, kind, e < 0.2)) continue;
        this.setGroup(s, kind, this.freshest(s, kind));
        at[kind] = this.tau;
        for (const a of on) if (asked || a.energy < 0.8) { if (a === c) this.offNext.add(a.id); else a.leaving = true; }
        // asked for everybody: the defence goes once the forwards are off
        this.changeNow[s] = forced === 'all' ? (kind === 'F' ? 'D' : 'F') : forced === kind ? false : forced;
        done = true;
        break;
      }
      // single changes: one man out of breath (not with the puck), when it is safe and no group change is near
      if (!done && !forced && this.tau - Math.max(at.F, at.D) > 3) {
        const worn = list.filter(a => a.energy < 0.3 && a !== c).sort((a, b) => a.energy - b.energy)[0];
        const kind = worn?.kindD ? 'D' : 'F';
        if (worn && this.safeToChange(s, kind, worn.energy < 0.12) && this.subFor(s, worn, 0.6)) { worn.leaving = true; at[kind] = this.tau; }
      }
      if (this.ctl && this.agents.get(this.ctl)?.leaving) this.pickControl(true);
    }
  }
  /** The replacement comes over the boards while `a` is still on his way in. */
  private jumpEarly(a: Sk) {
    const s = a.side, want = this.unitFor(s), onIce = this.skaters(s);
    const max = this.manpower(s) + (this.pulled[s] && !this.goalieOf(s) ? 1 : 0);
    if (onIce.filter(b => !b.leaving).length >= max) return;
    const pick = want.find(id => !onIce.some(b => b.id === id) && !!this.agents.get(id)?.kindD === a.kindD) ?? want.find(id => !onIce.some(b => b.id === id));
    if (!pick) return;
    const b = this.agents.get(pick)!;
    if (b.on !== 'bench' || b.goalie) return;
    b.on = 'ice'; b.leaving = false; b.x = this.bench[s].x + (this.rand() - 0.5); b.y = this.bench[s].y + 0.6; b.vx = 0; b.vy = 2.5; b.fa = Math.PI / 2; b.act = null;
    this.early[s] = { id: b.id, leaver: a };
    this.assignRoles(s);
  }
  /**
   * Too many men (a bench minor, served here by the man who was late off): called when, with the man coming
   * off still more than a couple of metres from the bench, the one who came on early plays the puck.
   */
  private tooManyMen() {
    for (const s of [0, 1] as Side[]) {
      const e = this.early[s];
      if (!e) continue;
      if (e.leaver.on !== 'ice' || !e.leaver.leaving) { this.early[s] = null; continue; }
      const c = this.puck.carrier;
      if (c?.id === e.id && dist(e.leaver, this.bench[s]) > 2.6) {
        this.early[s] = null;
        if (this.rand() < 0.75) this.foul(e.leaver, PEN_REASON.bench, c);
      }
    }
  }
  private swapAtBench(a: Sk) {
    const s = a.side;
    if (this.early[s]?.leaver === a) this.early[s] = null;
    a.on = 'bench'; a.leaving = false; a.act = null;
    if (this.puck.carrier === a) this.loose(a.vx, a.vy);
    const want = this.unitFor(s);
    const onIce = this.skaters(s);
    const needD = a.kindD;
    const pick = want.find(id => !onIce.some(b => b.id === id) && !!this.agents.get(id)?.kindD === needD) ?? want.find(id => !onIce.some(b => b.id === id));
    const max = this.manpower(s) + (this.pulled[s] && !this.goalieOf(s) ? 1 : 0);
    if (pick && onIce.length < max) {
      const b = this.agents.get(pick)!;
      // the same man again (a short bench): he just stays out, where he is (no jump back to the door)
      if (b === a) { a.on = 'ice'; a.leaving = false; }
      else { b.on = 'ice'; b.leaving = false; b.x = this.bench[s].x + (this.rand() - 0.5); b.y = this.bench[s].y + 0.6; b.vx = 0; b.vy = 2.5; b.fa = Math.PI / 2; b.act = null; }
    }
    this.assignRoles(s);
    if (this.ctl === a.id) this.pickControl(true);
  }

  /* ---------------- the manager's skater ---------------- */
  private pickControl(nearestToPuck = true, exclude?: Sk) {
    const s = this.opts.userSide;
    if (s === null) { this.ctl = null; return; }
    const list = this.skaters(s, false).filter(a => a !== exclude && a.on === 'ice');
    if (!list.length) { this.ctl = null; return; }
    const p = this.puck.carrier?.side === s ? this.puck.carrier : null;
    const best = p && p !== exclude ? p : nearestToPuck ? list.reduce((b, a) => (dist(a, this.puck) < dist(b, this.puck) ? a : b)) : list[0];
    this.ctl = best.id;
  }
  /**
   * On defence against an attack (the other team carries the puck in our half, or up the ice toward us): the
   * skater best placed to stop it — goal side of the carrier, on the line from him to our net, a few metres
   * in front of him. Null when the other team is not attacking.
   */
  private defender(s: Side): { best: Sk; score: (a: Sk) => number } | null {
    const c = this.puck.carrier;
    if (!c || c.side === s) return null;
    const net = loc(s, { x: GOAL, y: MID }), lc = loc(s, c);
    const toNet = dist(c, net) || 1, ux = (net.x - c.x) / toNet, uy = (net.y - c.y) / toNet;
    const toward = c.vx * ux + c.vy * uy;
    if (!(lc.x < RED - 3 || (lc.x < RED + 6 && toward > 1.5))) return null;
    const ahead = Math.min(4, toNet * 0.35), ideal = { x: c.x + ux * ahead, y: c.y + uy * ahead };
    const score = (a: Sk) => dist(a, ideal) + (dist(a, net) < toNet + 0.5 ? 0 : 8) + (a.stun > 0 ? 20 : 0);
    const list = this.skaters(s, false).filter(a => !a.leaving);
    if (!list.length) return null;
    return { best: list.reduce((b, a) => (score(a) < score(b) ? a : b)), score };
  }
  private user(pad: PadState, press: { shoot: boolean; pass: boolean; deke: boolean; swap: boolean; poke: boolean; lift: boolean; pin: boolean; hustle: boolean; push: boolean }, release: { shoot: boolean; pass: boolean }) {
    const s = this.opts.userSide;
    for (const a of this.onIce()) a.manual = false;
    this.blockBy = null; this.handleFast = false;
    if (s === null) return;
    let me = this.ctl ? this.agents.get(this.ctl) : undefined;
    if (!me || me.on !== 'ice' || me.leaving || me.side !== s || me.goalie) { this.pickControl(); me = this.ctl ? this.agents.get(this.ctl) : undefined; }
    if (!me) return;
    const p = this.puck;
    this.handle = null;
    // the mouse cursor on the ice aims (shots to that side of the net, passes and switches toward it)
    this.aimPt = pad.aimAt ?? null;
    // a stretch that got the puck: his buttons work at once (the stick pulls it in while he skates on)
    if (me.act?.k === 'reach' && me.act.done && (press.shoot || press.pass || press.deke)) me.act = null;
    const hasPuck = p.carrier === me;
    const teamHas = !hasPuck && (p.carrier?.side === s || (p.passTo?.side === s && p.passBy?.side === s));
    // auto switch on defence: the man nearest the puck when the controlled one is well out of the play
    if (this.opts.autoSwitch !== false && !hasPuck && !teamHas && this.tau >= this.autoAt && (!me.act || me.stun > 0)) {
      this.autoAt = this.tau + 0.35;
      const lazy = Math.hypot(pad.mx, pad.my) < 0.3;
      const guard = this.defender(s);
      if (guard) {
        // the other team is attacking: control goes to the man best placed between the carrier and our net
        const { best, score } = guard;
        if (best !== me && (me.stun > 0 || score(me) - score(best) > (lazy ? 2.5 : 5))) { this.ctl = best.id; me = best; this.autoAt = this.tau + 1.0; }
      } else {
        const near = this.skaters(s, false).filter(a => a.stun <= 0).reduce((b, a) => (dist(a, p) < dist(b, p) ? a : b), me);
        if (near !== me && dist(near, p) < dist(me, p) - (lazy ? 3.5 : 7) && dist(me, p) > 6) { this.ctl = near.id; me = near; }
      }
    }
    // switch player: the swap button always, the pass button on defence
    if (press.swap || (press.pass && !hasPuck && !teamHas)) {
      const list = this.skaters(s, false).filter(a => a !== me);
      if (list.length) {
        let mx = this.opts.flip ? -pad.mx : pad.mx, my = pad.my;
        if (pad.aimAt) { const d = Math.hypot(pad.aimAt.x - me.x, pad.aimAt.y - me.y) || 1; mx = (pad.aimAt.x - me.x) / d; my = (pad.aimAt.y - me.y) / d; }
        const m = Math.hypot(mx, my);
        const score = (a: Sk) => dist(a, p) - (m > 0.4 ? ((a.x - me!.x) * mx + (a.y - me!.y) * my) / m * 0.35 : 0);
        me = list.reduce((b, a) => (score(a) < score(b) ? a : b));
        this.ctl = me.id;
      }
      return;
    }
    me.manual = true;
    const mx = this.opts.flip ? -pad.mx : pad.mx, my = pad.my, mag = Math.min(1, Math.hypot(mx, my));
    me.wx = mag > 0.12 ? mx / Math.max(mag, 1e-6) * mag : 0; me.wy = mag > 0.12 ? my / Math.max(mag, 1e-6) * mag : 0;
    // L3 hustle (NHL): a click starts the burst, it lasts while he keeps skating
    if (press.hustle) this.hustleOn = !this.hustleOn;
    if (mag < 0.15 || me.energy <= 0.08) this.hustleOn = false;
    me.sprint = (pad.sprint || this.hustleOn) && me.energy > 0.08;
    // LT vision control on defence: he keeps his eyes (and chest) on the puck, backing up instead of turning
    me.back = !!pad.vision && !hasPuck && !teamHas;
    // LB (the modifier on every device) on defence: down in the shooting lane to block (slower, a much wider body in front of the puck)
    if (pad.lb && !hasPuck && !teamHas) this.blockBy = me;
    this.handleFast = !!pad.nhl && hasPuck && pad.pass;
    // the aim of a shot or a pass: toward the cursor when the mouse aims, else the skating stick
    const aim = pad.aimAt ? { x: pad.aimAt.x - me.x, y: pad.aimAt.y - me.y } : { x: mx, y: my };
    this.aimVec = aim;
    if (me.stun > 0) { this.ss.back = -1; return; }
    if (this.skillStick(me, pad, hasPuck, teamHas)) return;
    if (hasPuck) {
      if (press.shoot && !me.act && this.tau > me.cool) me.act = { k: 'windup', t0: this.tau, what: 'shot' };
      if (me.act?.k === 'windup' && me.act.what === 'shot') {
        const held = this.tau - me.act.t0;
        // a tap still takes a moment to get the shot off (no machine-gun releases)
        if (release.shoot) me.act.fire = true;
        if (press.deke && held < 0.6) { me.act = null; this.deke(me, mx, my, undefined, 'fake'); return; }
        if (me.act.fire && held >= 0.12) { me.act = null; this.shoot(me, buttonPower(held), held, aim); return; }
      }
      if (press.pass && !me.act) me.act = { k: 'windup', t0: this.tau, what: 'pass' };
      if (release.pass && me.act?.k === 'windup' && me.act.what === 'pass') {
        const held = this.tau - me.act.t0;
        me.act = null;
        if (pad.nhl) {
          // NHL: a tap is a soft pass, held longer it goes harder; with LB held it is a saucer pass. Let go while the
          // right stick still stickhandles, it was only the "stickhandle without dekes" hold — no pass.
          if (Math.hypot(pad.sx ?? 0, pad.sy ?? 0) >= 0.3) return;
          this.passFrom(me, aim, !!pad.lb, clamp(held / 0.6, 0, 1));
        } else this.passFrom(me, aim, held > 0.35 || !!pad.lb);
        return;
      }
      if (press.deke && !me.act && this.tau > me.cool) {
        // the deke button: with the burst held a spin-o-rama, a second tap right after a deke goes between the legs,
        // the stick pulled back a toe drag, otherwise a side-to-side deke
        const back = Math.hypot(mx, my) > 0.4 && Math.cos(angDiff(me.fa, Math.atan2(my, mx))) < -0.4;
        // with the modifier held, the special dekes (as LB + the right stick): the stick back — between the legs,
        // to a side — a toe drag, straight on — a shot fake
        if (pad.lb) {
          const side = Math.hypot(mx, my) > 0.4 && Math.abs(Math.sin(angDiff(me.fa, Math.atan2(my, mx)))) > 0.6;
          this.deke(me, mx, my, undefined, back ? 'between' : side ? 'toe' : 'fake');
          return;
        }
        const kind: DekeKind = pad.sprint && Math.hypot(me.vx, me.vy) > 3 ? 'spin' : this.tau - this.lastDekeAt < 1.05 ? 'between' : back ? 'toe' : 'side';
        this.deke(me, mx, my, undefined, kind);
        this.lastDekeAt = kind === 'between' ? -9 : this.tau;
      }
      return;
    }
    if (me.act?.k === 'windup') me.act = null;
    if (teamHas) {
      // without the puck on offence: call for it, or get the stick ready for a one-timer
      if (press.pass) { this.callForPass = this.tau + 1.2; this.play('loose', s, `${me.name}: «Пас!»`, me); }
      if (press.shoot) me.oneTimer = true;
      if (release.shoot && !(p.passTo === me)) me.oneTimer = false;
      return;
    }
    me.oneTimer = false;
    const ready = !me.act && this.tau > me.cool;
    // NHL defence on the gamepad: RB poke check, A stick lift, Y board pin (the body checks are on the right stick)
    if (press.poke && ready) { this.startPoke(me); return; }
    if (press.lift && ready) { this.startPoke(me, true); return; }
    if (press.pin && ready) { this.startCheck(me, undefined, 'pin'); return; }
    // a push check (the right stick up on a pad; its own key / button elsewhere)
    if (press.push && ready) { this.startCheck(me, undefined, undefined, true); return; }
    // the keyboard / mouse / touch: the shot button checks, the deke button pokes
    if (press.shoot && ready) this.startCheck(me);
    if (press.deke && ready) this.startPoke(me);
  }

  /**
   * The skill stick (right stick / second touch stick / mouse drag), NHL style, in screen terms: up is forward
   * (the shot), down is back (the windup), left / right the forehand and the backhand. Returns true when it did
   * something (the buttons then wait).
   */
  private skillStick(me: Sk, pad: PadState, hasPuck: boolean, teamHas: boolean): boolean {
    const ss = this.ss;
    const sx = pad.sx ?? 0, sy = pad.sy ?? 0, m = Math.min(1, Math.hypot(sx, sy));
    const f = -sy, l = sx;
    // the same stick on the ice (the camera turned it): which way a deke or the stickhandling goes
    const rx0 = pad.srx ?? sx, rx = this.opts.flip ? -rx0 : rx0, ry = pad.sry ?? sy;
    const lat = -Math.sin(me.fa) * rx + Math.cos(me.fa) * ry, fwd = Math.cos(me.fa) * rx + Math.sin(me.fa) * ry;
    const latSign: 1 | -1 = lat > 0 ? 1 : lat < 0 ? -1 : (l > 0 ? 1 : -1);
    // stickhandling: the puck goes where the stick is held (forehand / backhand, in close or out in front)
    this.handle = hasPuck && m >= 0.3 && ss.back < 0 ? { lat: clamp(lat, -1, 1), fwd: clamp(fwd, -1, 1) } : null;
    // RT held (NHL tip): the stick only moves the puck — no flick, shot or deke can go off by accident
    if (this.handleFast && hasPuck) {
      if (this.handle && Math.abs(lat) > 0.5) { const sd: 1 | -1 = lat > 0 ? 1 : -1; if (ss.handSide && ss.handSide !== sd) this.handleSwing = this.tau; ss.handSide = sd; }
      ss.pend = null; ss.back = -1; ss.loadEnd = -1; ss.sweep = 0; ss.wasOut = m >= 0.3; ss.rest = m < 0.3 ? this.tau : -9;
      if (m < 0.3) ss.handSide = 0;
      return false;
    }
    if (this.handle && Math.abs(lat) > 0.55) {
      const sd: 1 | -1 = lat > 0 ? 1 : -1;
      if (ss.handSide && ss.handSide !== sd) {
        // side to side in a flash: the goalie and a man reaching in have to follow the puck
        this.handleSwing = this.tau;
        const g = this.goalieOf((1 - me.side) as Side);
        if (g && dist(g, me) < 5.5 && this.tau - me.dekeBeat > 0.8) { me.dekeBeat = this.tau; me.dekeF = 1.3; me.dekeR = 5.5; }
      }
      ss.handSide = sd; ss.sideAt = this.tau;
    }
    if (m < 0.3) {
      // back to rest: a pending flick goes
      if (ss.pend && hasPuck) { const pd = ss.pend; ss.pend = null; this.flick(me, pd); }
      ss.pend = null;
      if (ss.back >= 0 && hasPuck && me.act?.k === 'windup' && me.act.what === 'shot') {
        // a loaded stick swung forward passes through the centre: a moment's grace before it counts as let go
        if (ss.loadEnd < 0) ss.loadEnd = this.tau;
        if (this.tau - ss.loadEnd < 0.2) return true;
        // loaded and let go without the shot: a shot fake
        const held = ss.loadEnd - ss.back;
        me.act = null;
        if (held > 0.18 && this.tau > me.cool - 0.3) this.deke(me, 0, 0, undefined, 'fake');
      }
      if (ss.ot) { me.oneTimer = false; ss.ot = false; }
      ss.back = -1; ss.loadEnd = -1; ss.rest = this.tau; ss.wasOut = false; ss.sweep = 0; ss.handSide = 0;
      return false;
    }
    const ang = Math.atan2(sy, sx);
    const through = ss.loadEnd >= 0;
    if (through) {
      // out again after the centre: a straight swing through, not a turn
      ss.loadEnd = -1; ss.sweep = ss.backSweep; ss.still = this.tau;
    } else if (ss.wasOut) {
      const da = angDiff(ss.ang, ang);
      ss.sweep += da;
      // held still a moment: the turn counts from here (a slap shot swung round the edge is not a circle)
      if (Math.abs(da) > 0.05) ss.still = this.tau;
      else if (this.tau - ss.still > 0.1 && !ss.pend) { ss.sweep = 0; ss.sweepAt = this.tau; ss.backSweep = 0; }
    } else { ss.sweep = 0; ss.sweepAt = this.tau; ss.still = this.tau; }
    ss.ang = ang; ss.wasOut = true;
    const flick = this.tau - ss.rest < 0.3 && m > 0.62;
    if (hasPuck) {
      // side to side: a side deke still going, the stick flicked the other way — the puck goes between the legs
      if (me.act?.k === 'deke' && me.act.kind === 'side' && this.tau - me.act.t0 < 0.5 && m > 0.65 && Math.abs(l) > 0.65 * m && latSign === -me.act.s) {
        ss.pend = null; ss.rest = -9; this.deke(me, 0, 0, latSign, 'between'); return true;
      }
      if (this.tau < me.cool && !(me.act?.k === 'windup')) return true;
      // a full circle: spin-o-rama
      if (Math.abs(ss.sweep) > 4.6 && this.tau - ss.sweepAt < 0.9) {
        const dir: 1 | -1 = ss.sweep > 0 ? 1 : -1;
        ss.sweep = 0; ss.back = -1; ss.pend = null; if (me.act?.k === 'windup') me.act = null;
        this.deke(me, 0, 0, dir, 'spin'); return true;
      }
      // LB held (NHL): the right stick does the special dekes — sideways a toe drag, back between the legs, up a shot fake
      if (pad.lb && !me.act) {
        if (flick && Math.abs(l) > 0.7 * m) { ss.rest = -9; ss.pend = null; this.deke(me, 0, 0, latSign, 'toe'); return true; }
        if (flick && f < -0.6 * m) { ss.rest = -9; ss.pend = null; this.deke(me, 0, 0, latSign, 'between'); return true; }
        if (flick && f > 0.6 * m) { ss.rest = -9; ss.pend = null; this.deke(me, 0, 0, undefined, 'fake'); return true; }
        return true;
      }
      // a pending flick: the stick swinging on round is a circle in the making; held still a moment, it goes
      if (ss.pend) {
        if (Math.abs(ss.sweep - ss.pend.sweep) > 1.0) ss.pend = null;
        else if (this.tau - ss.pend.at > 0.08) { const pd = ss.pend; ss.pend = null; this.flick(me, pd); }
        return true;
      }
      // pulled back (down): the stick loads — the longer, the harder (full power in about a third of a second)
      if (m > 0.55 && f < -0.5 * m && (ss.back >= 0 || Math.abs(ss.sweep) < 1.5)) {
        if (ss.back < 0) { ss.back = this.tau; ss.backSweep = ss.sweep; if (!me.act) me.act = { k: 'windup', t0: this.tau, what: 'shot' }; }
        return true;
      }
      if (ss.back >= 0 && m > 0.45) {
        const held = this.tau - ss.back;
        // forward (up): the shot — swung on round in one go it is a circle in the making, not a shot
        if (f > 0.3 * m && (through || !(Math.abs(ss.sweep - ss.backSweep) > 1.6 && held < 0.3))) {
          ss.back = -1; if (me.act?.k === 'windup') me.act = null;
          this.shoot(me, stickPower(held), Math.max(held, 0.3), this.aimVec, held > 0.32 ? 'slap' : 'snap');
          return true;
        }
        // sideways: a toe drag — unless the stick is swinging on round in one go (a circle in the making: a spin)
        if (Math.abs(l) > 0.6 * m && !(Math.abs(ss.sweep - ss.backSweep) > 1.2 && held < 0.3)) {
          ss.back = -1; if (me.act?.k === 'windup') me.act = null;
          this.deke(me, 0, 0, latSign, 'toe'); return true;
        }
        return true;
      }
      // a flick from rest — up: a wrist shot, sideways: a deke; the stick held to a side and swung up: a drag-and-shoot
      // wrist shot (each goes when the stick comes back or holds still a moment, so a circle is not taken for it)
      const drag = this.tau - ss.sideAt < 0.3 && f > 0.6 * m && m > 0.6;
      if (!me.act && ((flick && (f > 0.6 * m || Math.abs(l) > 0.7 * m)) || drag)) { ss.rest = -9; ss.sideAt = -9; ss.pend = { at: this.tau, f, l, s: latSign, sweep: ss.sweep, drag }; return true; }
      return false;
    }
    if (teamHas) {
      // without the puck on offence: the stick held back is loaded for a one-timer
      if (m > 0.55 && f < -0.5 * m) { me.oneTimer = true; ss.ot = true; }
      return false;
    }
    if (pad.nhl) {
      // NHL defence on the right stick: up — a push check; down then up — a shoulder check (the harder one)
      if (m > 0.55 && f < -0.5 * m) { if (ss.back < 0) ss.back = this.tau; return true; }
      if (f > 0.55 * m && m > 0.6 && !me.act && this.tau > me.cool) {
        const loaded = ss.back >= 0 && this.tau - ss.back < 1.2;
        ss.back = -1; ss.rest = -9;
        if (loaded) { this.startCheck(me, undefined, 'shoulder'); return true; }
        if (flick) { this.startCheck(me, undefined, undefined, true); return true; }
      }
      return false;
    }
    // defence: a flick is a poke check in that direction (a stick lift when he is beside or behind the carrier)
    if (flick && !me.act && this.tau > me.cool) {
      ss.rest = -9;
      me.fa += clamp(angDiff(me.fa, Math.atan2(ry, rx)), -0.7, 0.7);
      this.startPoke(me);
      return true;
    }
    return false;
  }

  /** A skill-stick flick that has gone: up a wrist shot (a hard one after a drag to the side), sideways a deke. */
  private flick(me: Sk, pd: { f: number; l: number; s: 1 | -1; drag: boolean }) {
    if (this.puck.carrier !== me || me.act || me.stun > 0) return;
    const m = Math.hypot(pd.f, pd.l) || 1;
    if (pd.f > 0.6 * m) { this.shoot(me, pd.drag ? 0.9 : 0.8, pd.drag ? 0.26 : 0.22, this.aimVec, 'wrist'); return; }
    if (this.tau < me.cool) return;
    this.deke(me, 0, 0, pd.s, 'side');
  }

  /* ---------------- AI ---------------- */
  private diffOf(a: Sk): number {
    // the manager's opponents play to the difficulty; his own teammates always play «pro»
    if (this.opts.userSide === null || a.side === this.opts.userSide) return 1;
    return this.difficulty === 'rookie' ? 0.72 : this.difficulty === 'star' ? 1.18 : 1;
  }
  private think() {
    const p = this.puck;
    const update = this.tau >= this.aiTick;
    if (update) this.aiTick = this.tau + 0.1;
    for (const a of this.onIce()) if (a.goalie) this.goalieTarget(a);
    if (!update) { if (p.carrier && !p.carrier.manual) this.carrierAct(p.carrier, false); return; }
    for (const a of this.onIce()) if (a.leaving && !a.manual) { a.tx = this.bench[a.side].x; a.ty = this.bench[a.side].y + 0.5; a.urg = 1; a.back = false; }
    const carrier = p.carrier;
    if (carrier && !carrier.manual) this.carrierAct(carrier, true);
    this.pathAt = -1;
    // the man a pass is meant for skates onto it (where he meets it in time, along the puck's real path)
    const recv = p.passTo && !p.carrier ? p.passTo : null;
    if (recv && !recv.manual && recv.on === 'ice') { const c = this.catchAt(recv); const t = this.blade2(recv, c.at); recv.tx = t.x; recv.ty = t.y; recv.urg = 1; recv.back = false; }
    const owner: Side | null = carrier?.side ?? (p.passTo && p.passBy?.side === p.passTo.side ? p.passTo.side : null);
    for (const s of [0, 1] as Side[]) {
      const free = this.skaters(s, false).filter(a => !a.manual && a !== carrier && a !== recv && a.stun <= 0);
      const down = this.skaters(s, false).filter(a => !a.manual && a !== carrier && a !== recv && a.stun > 0);
      for (const a of down) { a.tx = a.x; a.ty = a.y; a.urg = 0.3; }
      if (!free.length) continue;
      // the points hold the blue line first (the man at the line plays a clear there, not where it would stop)
      this.holdLine(s, free);
      if (!carrier && !p.dead) this.chase(s, free, owner === s ? recv : null);
      if (owner === s || (owner === null && p.last?.side === s)) this.attackShape(s, free);
      else this.defendShape(s, free);
    }
  }
  /**
   * A free puck: whoever gets to it first (along its real path: friction, the boards) goes for it. Our own pass on
   * its way to a teammate is left to him unless somebody is clearly sooner; the manager's man when he is closest.
   * A second man goes too when the puck is all but on his stick — nobody watches a puck roll past him because a
   * teammate is also coming.
   */
  private chase(s: Side, free: Sk[], mine: Sk | null) {
    const ctlMe = this.ctl ? this.agents.get(this.ctl) : undefined;
    const user = ctlMe && ctlMe.side === s && ctlMe.manual && ctlMe.stun <= 0 ? ctlMe : null;
    const lead = mine ? this.catchAt(mine).t : user ? this.catchAt(user).t : Infinity;
    const cands = free.map(a => ({ a, c: this.catchAt(a) })).sort((u, v) => u.c.t - v.c.t);
    if (!cands.length) return;
    const first = cands[0];
    const go: { a: Sk; at: V2 }[] = [];
    if (mine ? first.c.t < lead - 0.3 : user ? first.c.t < lead * 0.8 : true) go.push({ a: first.a, at: first.c.at });
    for (const c of cands.slice(go.length ? 1 : 0, 3)) {
      if (go.length >= 2) break;
      if (c.c.t < 0.7 && c.c.t < lead && c.c.t < first.c.t + 0.45 && !go.some(g => g.a === c.a)) go.push({ a: c.a, at: c.c.at });
    }
    for (const g of go) {
      const b = this.blade2(g.a, g.at); g.a.tx = b.x; g.a.ty = b.y; g.a.urg = 1; g.a.back = false;
      free.splice(free.indexOf(g.a), 1);
    }
  }
  /** The free puck's path over the next 2.4 s (friction, bounces off the ice and the boards; nobody touching it), every 0.05 s. */
  private path(): { x: number; y: number; h: number }[] {
    if (this.pathAt === this.tau) return this.pathCache;
    const p = this.puck, dt = 0.05, out: { x: number; y: number; h: number }[] = [];
    let x = p.x, y = p.y, vx = p.vx, vy = p.vy, h = p.h, vh = p.vh;
    if (p.carrier) { for (let i = 0; i < 48; i++) out.push({ x: p.x + p.vx * dt * (i + 1), y: p.y + p.vy * dt * (i + 1), h: 0 }); }
    else for (let i = 0; i < 48; i++) {
      if (h > 0 || vh > 0) { vh -= 9.81 * dt; h += vh * dt; if (h <= 0) { h = 0; vh = Math.abs(vh) > 1.2 ? -vh * 0.25 : 0; vx *= 0.9; vy *= 0.9; } }
      else { const sp = Math.hypot(vx, vy); if (sp > 0) { const ns = Math.max(0, sp - (0.9 + sp * 0.02) * dt); vx *= ns / sp; vy *= ns / sp; } }
      x += vx * dt; y += vy * dt;
      const c = inside({ x, y }, 0.08);
      if (c.x !== x || c.y !== y) {
        const nx = x - c.x, ny = y - c.y, nl = Math.hypot(nx, ny) || 1, vn = (vx * nx + vy * ny) / nl;
        if (vn > 0) { vx -= (1.62 * vn * nx) / nl; vy -= (1.62 * vn * ny) / nl; vx *= 0.9; vy *= 0.9; }
        x = c.x; y = c.y;
      }
      out.push({ x, y, h });
    }
    this.pathAt = this.tau; this.pathCache = out;
    return out;
  }
  private pathAt = -1;
  private pathCache: { x: number; y: number; h: number }[] = [];
  /** How long skater `a` needs to get his stick to a spot: a reaction, turning round (his speed away from it), then skating. */
  private reachTime(a: Sk, at: V2): number {
    const dx = at.x - a.x, dy = at.y - a.y, d = Math.hypot(dx, dy);
    if (d < 0.75) return 0;
    const ux = dx / d, uy = dy / d, along = a.vx * ux + a.vy * uy;
    const vmax = a.max * (0.72 + 0.28 * a.energy) * 1.08, acc = Math.max(4, a.acc);
    const turn = Math.max(0, -along) / (acc * 1.7);
    // from his current speed toward it up to his top speed
    const v0 = Math.max(0, along), ta = Math.max(0, (vmax - v0) / acc), da = v0 * ta + 0.5 * acc * ta * ta, run = d - 0.75;
    const tRun = run <= da ? (-v0 + Math.sqrt(v0 * v0 + 2 * acc * run)) / acc : ta + (run - da) / vmax;
    return 0.12 + turn + tRun + (a.stun > 0 ? a.stun : 0);
  }
  /** Where and when skater `a` can first get to the free puck along its path (else the end of the path). */
  private catchAt(a: Sk): { t: number; at: V2 } {
    const path = this.path();
    for (let i = 0; i < path.length; i++) {
      const q = path[i], t = (i + 1) * 0.05;
      if (q.h > 0.5) continue;
      if (this.reachTime(a, q) <= t) return { t, at: inside(q, 0.6) };
    }
    const q = path[path.length - 1];
    return { t: Math.max(2.4, this.reachTime(a, q)), at: inside(q, 0.6) };
  }
  private blade(a: Sk): V2 { return { x: a.x + Math.cos(a.fa) * REACH, y: a.y + Math.sin(a.fa) * REACH }; }
  private blade2(a: Sk, spot: V2): V2 {
    const dx = spot.x - a.x, dy = spot.y - a.y, d = Math.hypot(dx, dy);
    if (d < 0.6) return { x: spot.x - Math.cos(a.fa) * 0.6, y: spot.y - Math.sin(a.fa) * 0.6 };
    return { x: spot.x - (dx / d) * 0.6, y: spot.y - (dy / d) * 0.6 };
  }
  private setT(a: Sk, l: V2, s: Side, urg: number, back = false) {
    const g = loc(s, l), c = inside(g, 0.8);
    a.tx = c.x; a.ty = c.y; a.urg = urg; a.back = back;
  }
  /** Greedy assignment of players to spots (a man keeps his spot unless another is much closer). */
  private assign(list: Sk[], spots: V2[], s: Side, urg: number, onside: boolean) {
    const left = [...list], used = new Set<number>();
    while (left.length && used.size < spots.length) {
      let best: { a: Sk; i: number; c: number } | null = null;
      for (const a of left) {
        const l = loc(s, a);
        spots.forEach((sp, i) => { if (used.has(i)) return; const c = dist(l, sp) - (a.spot === i ? 3 : 0); if (!best || c < best.c) best = { a, i, c }; });
      }
      if (!best) break;
      const b: { a: Sk; i: number; c: number } = best;
      used.add(b.i); left.splice(left.indexOf(b.a), 1); b.a.spot = b.i;
      let sp = spots[b.i];
      if (onside && !this.zoneIn[s]) sp = { x: Math.min(sp.x, OPP_BLUE - 0.8), y: sp.y };
      const dr = this.drift(b.a, 0.9);
      this.setT(b.a, { x: sp.x + dr.x, y: sp.y + dr.y }, s, urg);
    }
    for (const a of left) this.setT(a, { x: RED, y: MID }, s, 0.6);
  }
  private drift(a: Sk, amp: number): V2 {
    let h = 7;
    for (let i = 0; i < a.id.length; i++) h = (Math.imul(h, 31) + a.id.charCodeAt(i)) | 0;
    const ph = ((h & 1023) / 1023) * Math.PI * 2, w = 0.5 + (((h >>> 10) & 255) / 255) * 0.4;
    return { x: Math.sin(this.tau * w + ph) * amp, y: Math.cos(this.tau * w * 0.73 + ph * 1.7) * amp };
  }
  private attackShape(s: Side, free: Sk[]) {
    const P = loc(s, this.puck), strong = P.y < MID ? -1 : 1;
    const F = free.filter(a => !a.kindD), D = free.filter(a => a.kindD);
    const pp = this.manpower(s) > this.manpower((1 - s) as Side);
    let fs: V2[], ds: V2[];
    if (this.zoneIn[s] && P.x > OPP_BLUE - 3) {
      if (pp) {
        // 1-3-1: net front, bumper, both half-walls; the quarterback at the top
        fs = [{ x: OPP_GOAL - 1.8, y: MID - strong * 0.6 }, { x: OPP_GOAL - 8, y: MID }, { x: OPP_GOAL - 9.5, y: MID + strong * 9 }, { x: OPP_GOAL - 9.5, y: MID - strong * 9 }];
        ds = [{ x: OPP_BLUE + 1.8, y: MID + strong * 2 }, { x: OPP_BLUE + 2.5, y: MID - strong * 7 }];
      } else {
        fs = [{ x: OPP_GOAL - 2.1, y: MID - strong * 0.8 }, { x: OPP_GOAL - 9.5, y: MID + strong * 1.5 }, { x: OPP_GOAL - 6.5, y: MID - strong * 7.5 }, { x: clamp(P.x - 3.5, OPP_BLUE + 2, OPP_GOAL - 1), y: clamp(P.y - strong * 4, 2.5, 27.5) }];
        // the points: the strong-side man on the boards lane at the line (where a clear goes out), the other high in the middle
        ds = [{ x: OPP_BLUE + 1.1, y: MID + strong * 11.2 }, { x: OPP_BLUE + 1.6, y: MID - strong * 2.5 }];
      }
    } else if (P.x > BLUE - 2) {
      const lim = OPP_BLUE - 0.9;
      fs = [{ x: Math.min(lim, P.x + 8), y: 4.5 }, { x: Math.min(lim, P.x + 8), y: 25.5 }, { x: Math.min(lim, P.x + 4), y: MID - strong * 4 }];
      ds = [{ x: Math.max(GOAL + 3, P.x - 8), y: 10 }, { x: Math.max(GOAL + 3, P.x - 8), y: 20 }];
    } else {
      // breakout: wingers on the half-walls, the centre swinging low through the middle, a defenceman behind the puck.
      // The manager's call (d-pad down): stretch — a winger leaves early for a long pass at the far blue line;
      // safe — both wingers low on the walls, the centre close to help.
      const bo = this.breakout[s];
      fs = bo === 1 ? [{ x: BLUE - 3, y: 2.8 }, { x: OPP_BLUE - 1, y: MID - strong * 7 }, { x: clamp(P.x + 6, GOAL + 4, RED), y: MID - strong * 2 }]
        : bo === 2 ? [{ x: GOAL + 6, y: 2.5 }, { x: GOAL + 6, y: 27.5 }, { x: clamp(P.x + 3, GOAL + 3, BLUE - 2), y: MID - strong * 3 }]
        : [{ x: BLUE - 3, y: 2.8 }, { x: BLUE - 3, y: 27.2 }, { x: clamp(P.x + 5, GOAL + 4, BLUE), y: MID - strong * 2 }];
      ds = [{ x: Math.max(GOAL + 1.2, P.x - 3.5), y: clamp(P.y + (MID - P.y) * 0.5, 4, 26) }, { x: GOAL + 2.5, y: MID - strong * 5 }];
    }
    if (pp && this.zoneIn[s]) this.assign([...F, ...D], [...fs, ...ds], s, 0.85, true);
    else { this.assign(F, fs, s, 0.9, true); this.assign(D, ds, s, 0.8, true); }
  }
  private defendShape(s: Side, free: Sk[]) {
    const p = this.puck, P = loc(s, p), o = (1 - s) as Side;
    const carrier = p.carrier && p.carrier.side === o ? p.carrier : null;
    const opps = this.skaters(o, false);
    const pk = this.manpower(s) < this.manpower(o);
    const left = [...free];
    this.finishChecks(s);
    // a rush at our net (the carrier coming with speed from the neutral zone or into our end): the defencemen
    // stay goal-side — they keep their gap and back in, take him on when he gets to them; a forward hunts him from behind
    let rushD: Sk[] = [];
    if (carrier) {
      const cl = loc(s, carrier), vin = -(s ? -1 : 1) * carrier.vx;
      if (vin > 3 && cl.x > GOAL + 7 && cl.x < OPP_BLUE && !pk) {
        rushD = this.backD(s, left.filter(a => a.kindD), cl.x < BLUE + 2 ? BLUE + 1 : RED - 1);
        for (const d of rushD) { left.splice(left.indexOf(d), 1); if (dist(d, carrier) < 2.3) this.aiDefend(d, carrier); }
      }
    }
    // one man pressures the carrier (in his own end a defenceman takes a carrier low in the zone)
    if (carrier && left.length) {
      const cl = loc(s, carrier);
      // in his own end and the neutral zone a forward goes after him, the defencemen keep their gap (one of them
      // only when he is right there and goal-side); in our end whoever is nearest
      const Fs = left.filter(a => !a.kindD);
      const goalSide = (a: Sk) => loc(s, a).x < cl.x - 0.5;
      const pool = cl.x < BLUE + 2 ? left : left.filter(a => !a.kindD || (goalSide(a) && dist(a, carrier) < 4));
      if (!pool.length) pool.push(...(Fs.length ? Fs : left));
      let pr = pool.reduce((b, a) => (dist(a, carrier) < dist(b, carrier) ? a : b));
      const ctlMe = this.ctl ? this.agents.get(this.ctl) : undefined;
      if (ctlMe && ctlMe.side === s && dist(ctlMe, carrier) < dist(pr, carrier) + 1) pr = null as unknown as Sk;
      const fc = this.opts.lineups ? 1 : 1;
      const pkHold = pk && cl.x < BLUE + 1 && dist(pr ?? carrier, carrier) > 5;
      if (pr && !pkHold && !(cl.x > OPP_BLUE + 6 && dist(pr, carrier) > 14 * fc) && !(pr.kindD && cl.x > BLUE + 2 && !goalSide(pr))) {
        // goal-side of where the carrier is going, a stick length away
        const lead = clamp(dist(pr, carrier) / Math.max(1, pr.max), 0, 0.8);
        const fut = { x: carrier.x + carrier.vx * lead, y: carrier.y + carrier.vy * lead };
        const own = loc(s, { x: GOAL, y: MID }), dx = own.x - fut.x, dy = own.y - fut.y, d = Math.hypot(dx, dy) || 1;
        const t = inside({ x: fut.x + (dx / d) * 0.9, y: fut.y + (dy / d) * 0.9 }, 0.7);
        pr.tx = t.x; pr.ty = t.y; pr.urg = 1; pr.back = false;
        left.splice(left.indexOf(pr), 1);
        this.aiDefend(pr, carrier);
      }
    }
    const own = { x: GOAL, y: MID };
    // a carrier coming at the net from the slot: the nearest free man steps into the shooting lane
    if (carrier && left.length && !pk) {
      const cl = loc(s, carrier);
      if (cl.x < BLUE && dist(cl, own) < 11) {
        const lane = left.reduce((b, a) => (dist(a, carrier) < dist(b, carrier) ? a : b));
        if (dist(lane, carrier) < 7) {
          const dx = own.x - cl.x, dy = own.y - cl.y, d = Math.hypot(dx, dy) || 1, k = Math.min(2.2, d * 0.35);
          this.setT(lane, { x: cl.x + (dx / d) * k, y: cl.y + (dy / d) * k }, s, 1);
          left.splice(left.indexOf(lane), 1);
          this.aiDefend(lane, carrier);
        }
      }
    }
    if (P.x < BLUE + 2) {
      if (pk) {
        // the box: defencemen low, forwards high, shading to the puck
        const sh = (P.y - MID) * 0.25;
        const spots = [{ x: GOAL + 3.3, y: MID - 2.8 + sh }, { x: GOAL + 3.3, y: MID + 2.8 + sh }, { x: GOAL + 9.5, y: MID - 4.5 + sh }, { x: GOAL + 9.5, y: MID + 4.5 + sh }];
        this.assign(left.filter(a => a.kindD), spots.slice(0, 2), s, 0.9, false);
        this.assign(left.filter(a => !a.kindD), spots.slice(2), s, 0.9, false);
        return;
      }
      // man coverage: each attacker without the puck gets a man between him and the net
      const threats = opps.filter(a => a !== carrier).map(a => ({ a, l: loc(s, a) })).sort((u, v) => dist(u.l, own) - dist(v.l, own));
      for (const t of threats) {
        if (!left.length) break;
        const m = left.reduce((b, a) => (dist(loc(s, a), t.l) < dist(loc(s, b), t.l) ? a : b));
        left.splice(left.indexOf(m), 1);
        const dx = own.x - t.l.x, dy = own.y - t.l.y, d = Math.hypot(dx, dy) || 1, k = d > 16 ? 4 : 1.4;
        this.setT(m, { x: t.l.x + (dx / d) * k, y: t.l.y + (dy / d) * k }, s, 0.95);
      }
      left.forEach((a, i) => this.setT(a, { x: GOAL + 5.5, y: MID + (i ? 1.5 : -1.5) }, s, 0.9));
      return;
    }
    if (P.x < OPP_BLUE) {
      // neutral zone: defencemen keep the gap skating backwards, forwards backcheck on the attackers
      const D = left.filter(a => a.kindD), F = left.filter(a => !a.kindD);
      const backD = rushD.length ? [] : this.backD(s, D.length ? D : F.slice(0, 1), RED - 1);
      const rest = F.filter(a => !backD.includes(a));
      // forwards backcheck: each takes an attacker (goal-side of him), the deepest first
      const ths = opps.filter(a => a !== carrier).map(a => loc(s, a)).sort((u, v) => u.x - v.x);
      rest.forEach((a, i) => { const t = ths[i]; this.setT(a, t ? { x: t.x - 2, y: t.y + (MID - t.y) * 0.2 } : { x: P.x - 5, y: i % 2 ? 7 : 23 }, s, t && loc(s, a).x > t.x ? 1 : 0.9); });
      return;
    }
    // forecheck in their end: the second man takes away the boards, the third stays high, the points hold the line.
    // The manager's call (d-pad up): aggressive 2-1-2 — two men deep on the puck, the points pinch; passive 1-2-2 —
    // everyone back at the red line waiting for them.
    const style = this.forecheck[s];
    const D = left.filter(a => a.kindD), F = left.filter(a => !a.kindD);
    const fs = style > 0 ? [{ x: P.x - 2.5, y: MID + (P.y - MID) * 0.7 }, { x: P.x - 6, y: MID }]
      : style < 0 ? [{ x: RED + 1.5, y: MID - 5 }, { x: RED + 1.5, y: MID + 5 }]
      : [{ x: P.x - 6, y: MID + (P.y - MID) * 0.4 }, { x: RED + 4, y: MID }];
    this.assign(F, fs, s, style > 0 ? 0.95 : 0.85, false);
    // the defencemen: an aggressive forecheck pinches the strong side (the far one stays at centre ice), the
    // others wait outside the blue line — and all of them back off as soon as the carrier comes up the ice
    // set up in their end (onside), the points hold the line while the carrier is deep (backD lets them off as he comes)
    this.backD(s, D, style > 0 ? OPP_BLUE + 0.8 : style < 0 ? RED - 3 : this.zoneIn[s] ? OPP_BLUE + 1 : OPP_BLUE - 2.5);
  }
  /**
   * The defencemen against a rush: a gap to the carrier that grows with his speed toward our net, never higher
   * than `cap`, always goal-side of the deepest attacker (no man behind them for a stretch pass), the strong-side
   * man in the carrier's lane, the other one deeper across the middle. Backwards while they hold the gap; beaten
   * (the carrier level or past, flying), they turn and race back. Returns the men it placed.
   */
  private backD(s: Side, D: Sk[], cap: number): Sk[] {
    if (!D.length) return [];
    const p = this.puck, o = (1 - s) as Side;
    const threat = p.carrier && p.carrier.side === o ? p.carrier : null;
    const c = loc(s, threat ?? p);
    // velocity in our frame (team 1 sees the rink turned round)
    const vx = (s ? -1 : 1) * (threat ? threat.vx : p.vx);
    const speedIn = Math.max(0, -vx);
    const k = D.reduce((m, a) => m + this.diffOf(a), 0) / D.length;
    // room to build up speed: a wide gap while he is far out, tightening to a stick and a half at our blue line
    const gap = (clamp(3 + 0.33 * (c.x - BLUE), 3.2, 9) + speedIn * 0.3) * (0.8 + 0.2 * k);
    let line = Math.min(cap, c.x - gap);
    // goal-side of every attacker who could take a pass behind us (the carrier excepted)
    for (const a of this.skaters(o, false)) {
      if (a === threat) continue;
      const l = loc(s, a);
      if (l.x < line + 1.2) line = Math.min(line, l.x - 1.8);
    }
    line = Math.max(GOAL + 6, line);
    const strong = c.y < MID ? -1 : 1;
    const spots = [
      { x: line, y: clamp(c.y + (MID - c.y) * 0.35, 4, 26) },
      { x: Math.max(GOAL + 5.5, line - (D.length > 1 ? 1.6 : 0)), y: MID - strong * 3.8 },
    ];
    // the strong-side man is the one nearer the carrier's lane
    const order = D.length > 1 && Math.abs(loc(s, D[1]).y - spots[0].y) < Math.abs(loc(s, D[0]).y - spots[0].y) ? [D[1], D[0]] : D;
    order.slice(0, 2).forEach((a, i) => {
      const me = loc(s, a), sp = spots[i];
      const high = me.x - sp.x, level = me.x > c.x - 1.2;
      if (high < -0.5) {
        // deeper than his spot: he only drifts up (never charges at a man who can still go round him)
        this.setT(a, sp, s, c.x - me.x < 5 ? 0.9 : 0.5, true);
        return;
      }
      // beaten or too high against speed: turn and skate (forwards, flat out) to a spot deeper still, else backwards facing the play
      const race = level || (high > 2.5 && speedIn > 3.5) || high > 6;
      if (race) this.setT(a, { x: Math.max(GOAL + 4, sp.x - 2.5), y: sp.y + (MID - sp.y) * 0.4 }, s, 1, false);
      else this.setT(a, sp, s, high > 1 ? 1 : 0.95, speedIn > 1.5 || high > 0.5);
    });
    return order.slice(0, 2);
  }
  /**
   * Keeping the puck in the zone: a puck on its way out over the blue line we attack is met at the line by the
   * defenceman who gets there first (he stays onside, just inside it); one of theirs carrying it out along the
   * boards is stood up at the line. The other defenceman covers up high. Uses men from `free`.
   */
  private holdLine(s: Side, free: Sk[]) {
    if (!this.zoneIn[s]) return;
    const p = this.puck, P = loc(s, p);
    if (p.dead || p.shot || P.x < OPP_BLUE - 0.6 || P.x > OPP_BLUE + 15) return;
    const D = free.filter(a => a.kindD);
    if (!D.length) return;
    const carrier = p.carrier && p.carrier.side !== s ? p.carrier : null;
    if (p.carrier && !carrier) return;
    let spot: V2 | null = null, tCross = 0;
    if (!carrier) {
      // where the free puck crosses the line (boards and all)
      const path = this.path();
      for (let i = 0; i < path.length; i++) {
        const q = loc(s, path[i]);
        if (q.x <= OPP_BLUE + 0.5) { if (path[i].h < 1.8) { spot = { x: OPP_BLUE + 0.7, y: clamp(q.y, 0.9, W - 0.9) }; tCross = (i + 1) * 0.05; } break; }
      }
    } else {
      const c = loc(s, carrier), vx = (s ? -1 : 1) * carrier.vx, vy = (s ? -1 : 1) * carrier.vy;
      if (c.x < OPP_BLUE + 7 && vx < 0.5) { spot = { x: OPP_BLUE + 0.6, y: clamp(c.y + vy * 0.3, 1, W - 1) }; tCross = Math.max(0.3, (c.x - OPP_BLUE) / Math.max(1, -vx)); }
    }
    if (!spot) return;
    const g = loc(s, spot), at = loc(s, g); void g;
    const best = D.map(a => ({ a, t: this.reachTime(a, at) })).sort((u, v) => u.t - v.t)[0];
    // he only steps up when he can make it (a little late still wins it at the line); else he backs off
    if (best.t > tCross + 0.7) return;
    this.setT(best.a, spot, s, 1);
    free.splice(free.indexOf(best.a), 1);
    if (carrier && dist(best.a, carrier) < 2.3) this.aiDefend(best.a, carrier);
    const other = D.find(a => a !== best.a);
    if (other) { this.setT(other, { x: OPP_BLUE - 3.5, y: MID + (spot.y < MID ? 4 : -4) }, s, 0.95, true); free.splice(free.indexOf(other), 1); }
  }
  /** Finishing the check: a man who has just moved the puck along the boards or in the middle gets hit. */
  private finishChecks(s: Side) {
    const o = (1 - s) as Side;
    for (const a of this.skaters(s, false)) {
      if (a.manual || a.act || this.tau < a.cool || a.stun > 0) continue;
      for (const t of this.skaters(o, false)) {
        if (t.stun > 0 || this.tau - t.lastPuck > 0.6 || this.puck.carrier === t) continue;
        const d = dist(a, t);
        if (d < 1.9 && Math.cos(angDiff(a.fa, Math.atan2(t.y - a.y, t.x - a.x))) > 0.5 && this.rand() < 0.022 * Math.pow(a.check / 70, 2) * this.diffOf(a)) { this.startCheck(a, t); break; }
      }
    }
  }
  /** The pressing defender's stick: poke checks and body checks on the carrier. */
  private aiDefend(a: Sk, c: Sk) {
    if (a.act || this.tau < a.cool || a.stun > 0) return;
    const d = dist(a, c), k = this.diffOf(a);
    const front = Math.cos(angDiff(a.fa, Math.atan2(c.y - a.y, c.x - a.x))) > 0.5;
    if (!front) return;
    // a body check first when he is on the move or along the boards (finishing the check is hockey), else the stick
    const sp = Math.hypot(c.vx, c.vy), boards = inside(c, 2.2).x !== c.x || inside(c, 2.2).y !== c.y;
    // close to his own net the defender has to win it: more sticks and bodies on the carrier
    const cl = loc(a.side, c), danger = cl.x < BLUE && Math.hypot(cl.x - GOAL, cl.y - MID) < 13 ? 1.8 : 1;
    if (d < 2.1 && (sp > 2.0 || boards) && this.rand() < (boards ? 0.05 : 0.03) * danger * Math.pow(a.check / 70, 2) * k) { this.startCheck(a, c); return; }
    if (d < 1.7 && this.rand() < (0.06 + a.check / 1500) * danger * k) this.startPoke(a);
  }

  /** The carrier's choices (AI): shoot, pass, carry, dump, deke. */
  private carrierAct(a: Sk, decide: boolean) {
    const s = a.side, me = loc(s, a), opps = this.skaters((1 - s) as Side, false);
    const pressure = Math.min(99, ...opps.map(o => dist(o, a)));
    if (a.act?.k === 'windup') {
      // a windup started by the AI is let go when it is loaded (or at once under pressure)
      const held = this.tau - a.act.t0, what = a.act.what;
      if (held > (what === 'pass' ? 0.12 : a.act.t0 < 0 ? 0 : this.aiWind(a)) || pressure < 1.0) { a.act = null; if (what === 'shot') this.shoot(a, clamp(held / 0.8, 0.2, 1), held, null); else this.passFrom(a, null, false); }
      return;
    }
    if (decide && this.tau >= a.decideAt) {
      const k = this.diffOf(a);
      a.decideAt = this.tau + (pressure < 2 ? 0.2 : 0.32) / Math.min(1.2, k) + this.rand() * 0.15;
      const net = { x: OPP_GOAL, y: MID };
      const lane = this.laneOpen(a, loc(s, net), 0.75);
      // a called-for pass from the manager's skater
      const ctlMe = this.ctl ? this.agents.get(this.ctl) : undefined;
      if (ctlMe && ctlMe.side === s && this.tau < this.callForPass && ctlMe !== a && this.passLaneOk(a, ctlMe)) { this.callForPass = 0; this.passTo(a, ctlMe, false); return; }
      if (me.x > OPP_BLUE + 0.5 && me.x < OPP_GOAL - 0.4) {
        const z = shotZone(me);
        const base = { crease: 0.4, slot: 0.13, circles: 0.028, point: 0.02, perimeter: 0.005 }[z];
        const traffic = this.skaters(s).some(m => m !== a && dist(loc(s, m), net) < 3);
        // the longer the team has had it in the zone, the readier to put it on net
        const urge = 1 + clamp(this.tau - a.lastPuck - 1.5, 0, 2) * 0.15;
        let ps = base * (lane ? 1 : 0.3) * (a.shoot / 72) * (z === 'point' && traffic ? 1.6 : 1) * urge;
        if (this.opts.kind !== 'reg' && this.zoneIn[s]) ps *= 1.2;
        // in alone on the goalie: a move first (the shot comes at the next decision)
        if ((z === 'crease' || (z === 'slot' && dist(me, net) < 6.5)) && pressure > 1.6 && this.tau > a.cool && this.tau - a.dekeBeat > 1.5 && this.rand() < 0.22 * (a.hands / 75) * k) {
          this.deke(a, 0, 0, undefined, this.aiDekeKind(a, true)); a.decideAt = this.tau + 0.35; return;
        }
        if (this.rand() < ps) {
          if (z === 'point' && pressure > 3.5) { a.act = { k: 'windup', t0: this.tau, what: 'shot' }; return; }
          this.shoot(a, 0.4 + this.rand() * 0.3, 0.15, null); return;
        }
      }
      // pass to a better-placed teammate — but a carrier with room skates with it, and every pass of the possession
      // raises the bar (no tic-tac-toe around the perimeter: the team goes to the net)
      const best = this.bestPass(a);
      const myVal = this.value(s, me) - (pressure < 1.6 ? 0.25 : 0);
      const chain = Math.max(0, this.touches.filter(t => t.side === s).length - 1);
      const held = this.tau - a.lastPuck;
      if (best) {
        const fwd = loc(s, best.m).x - me.x;
        const better = best.v > myVal + 0.12 + chain * 0.06 && held > 0.35 && this.rand() < 0.6;
        const bailout = pressure < 1.7 && held > 0.25 && (fwd > -4 || pressure < 1.0) && best.v > myVal - 0.15 && this.rand() < 0.5;
        // breakout: in our own end the first look is the outlet pass, not a blind clear
        const outlet = me.x < BLUE && pressure < 3 && best.v > myVal - 0.2 && this.rand() < 0.7;
        if (better || bailout || outlet) { this.passTo(a, best.m, false); return; }
      }
      // dump it in against a wall at the blue line; clear it under pressure in our own end
      if (me.x > RED - 4 && me.x < OPP_BLUE && !this.zoneIn[s]) {
        const wall = opps.filter(o => { const l = loc(s, o); return l.x > me.x && l.x < OPP_BLUE + 3 && Math.abs(l.y - me.y) < 6; }).length;
        if (wall >= 2 && pressure < 4 && this.rand() < 0.55) { this.dump(a); return; }
      }
      const pk = this.manpower(s) < this.manpower((1 - s) as Side);
      if (me.x < BLUE && (pk || (pressure < 1.2 && this.rand() < 0.25))) { this.clear(a, pk); return; }
      if (me.x > BLUE - 4 && pressure < 2.4 && !a.kindD && this.rand() < a.hands / 260 * k) {
        const o = opps.find(o => { const rx = o.x - a.x, ry = o.y - a.y, along = rx * Math.cos(a.fa) + ry * Math.sin(a.fa); return along > 0.5 && along < 2.6; });
        if (o) { const lat = (o.x - a.x) * -Math.sin(a.fa) + (o.y - a.y) * Math.cos(a.fa); this.deke(a, 0, 0, lat > 0 ? -1 : 1, this.aiDekeKind(a, false)); return; }
      }
      a.carryT = this.carryTarget(a, me, pressure);
    }
    let t = a.carryT ?? loc(s, { x: me.x + 6, y: me.y });
    // protect the puck: a checker on his hip — curl away from him
    const o = pressure < 1.8 ? opps.reduce((b, x) => (dist(x, a) < dist(b, a) ? x : b)) : null;
    if (o) { const dx = a.x - o.x, dy = a.y - o.y, d = Math.hypot(dx, dy) || 1; t = { x: a.x + (dx / d) * 3 + (t.x - a.x) * 0.5, y: a.y + (dy / d) * 3 + (t.y - a.y) * 0.5 }; }
    // onside: the carrier waits for teammates still over the line
    const tl = loc(s, t);
    if (!this.zoneIn[s] && this.rules.offside && this.skaters(s).some(m => m !== a && loc(s, m).x > OPP_BLUE + 0.1)) tl.x = Math.min(tl.x, OPP_BLUE - 1);
    const c = inside(loc(s, tl), 0.9);
    a.tx = c.x; a.ty = c.y; a.urg = pressure < 3 ? 1 : 0.85; a.back = false;
  }
  private aiWind(a: Sk) { return 0.35 + (a.id.length % 3) * 0.08; }
  private carryTarget(a: Sk, me: V2, pressure: number): V2 {
    const s = a.side;
    if (me.x < BLUE) return loc(s, { x: me.x + 10, y: me.y < MID ? 5 : 25 });
    if (me.x < OPP_BLUE) {
      // the entry lane with the most room at the blue line
      const opps = this.skaters((1 - s) as Side, false).map(o => loc(s, o));
      const lanes = [6, MID, 24].map(y => ({ y, room: Math.min(9, ...opps.map(o => Math.hypot(o.x - OPP_BLUE, o.y - y))) - Math.abs(y - me.y) * 0.08 }));
      const best = lanes.reduce((b, l) => (l.room > b.room ? l : b));
      return loc(s, { x: OPP_BLUE + 4, y: best.y });
    }
    const lane = this.laneOpen(a, { x: OPP_GOAL, y: MID }, 1.0);
    if (lane && pressure > 2 && me.x < OPP_GOAL - 6) return loc(s, { x: OPP_GOAL - 6.5, y: MID + (me.y < MID ? -2 : 2) });
    // cycle: down the wall, behind the net, or curl back up
    if (me.x > OPP_GOAL - 3) return loc(s, { x: OPP_GOAL - 7, y: me.y < MID ? 4 : 26 });
    if (Math.abs(me.y - MID) > 7) return loc(s, { x: OPP_GOAL - 1, y: me.y < MID ? 4.5 : 25.5 });
    return loc(s, { x: OPP_GOAL - 10, y: me.y < MID ? 6 : 24 });
  }
  /** How good the puck is at this spot for side s (local coordinates): a scoring chance in the zone, progress outside. */
  private value(_s: Side, l: V2): number {
    if (l.x > OPP_BLUE && l.x < OPP_GOAL + 0.5) return ZONE_MULT[shotZone(l)] * 0.6 + 0.3;
    return (l.x / L) * 0.55;
  }
  private laneOpen(a: Sk, targetLocal: V2, w: number): boolean {
    const t = loc(a.side, targetLocal);
    return this.skaters((1 - a.side) as Side, false).every(o => segDist(o, a, t) > w);
  }
  private passLaneOk(a: Sk, m: Sk) { return this.skaters((1 - a.side) as Side, false).every(o => segDist(o, a, m) > 0.9) && dist(a, m) > 2.5 && dist(a, m) < 36; }
  private bestPass(a: Sk): { m: Sk; v: number } | null {
    const s = a.side, opps = this.skaters((1 - s) as Side, false);
    let best: { m: Sk; v: number } | null = null;
    for (const m of this.skaters(s, false)) {
      if (m === a || m.stun > 0) continue;
      const d = dist(a, m);
      if (d < 3 || d > 34) continue;
      const ml = loc(s, m);
      if (this.rules.offside && !this.zoneIn[s] && ml.x > OPP_BLUE - 0.2) continue;
      const open = Math.min(6, ...opps.map(o => dist(o, m)));
      const lane = Math.min(4, ...opps.map(o => segDist(o, a, m)));
      if (lane < 0.9) continue;
      const v = this.value(s, ml) + open * 0.05 + lane * 0.06 - d / 70;
      if (!best || v > best.v) best = { m, v };
    }
    return best;
  }

  /* ---------------- goalies ---------------- */
  private goalieTarget(g: Sk) {
    g.manual = false;
    if (g.leaving) { g.tx = this.bench[g.side].x; g.ty = this.bench[g.side].y + 0.5; g.urg = 1; return; }
    const s = g.side, p = this.puck, P = loc(s, p);
    let t: V2;
    if (P.x < GOAL + 0.3) t = { x: GOAL + 0.35, y: MID + (P.y < MID ? -0.7 : 0.7) };
    else {
      const dx = P.x - GOAL, dy = P.y - MID, d = Math.hypot(dx, dy) || 1, depth = d < 4 ? 0.45 : d < 12 ? 0.95 : 1.2;
      t = { x: GOAL + (dx / d) * depth, y: clamp(MID + (dy / d) * depth, MID - 1.25, MID + 1.25) };
    }
    const c = loc(s, t);
    g.tx = c.x; g.ty = c.y; g.urg = 1; g.back = true;
  }
  /** Out of position: how far the goalie is from his angle on this shot (metres). */
  private goalieOff(g: Sk, from: V2): number {
    const s = g.side, P = loc(s, from);
    const dx = P.x - GOAL, dy = P.y - MID, d = Math.hypot(dx, dy) || 1, depth = d < 4 ? 0.45 : d < 12 ? 0.95 : 1.2;
    const ideal = loc(s, { x: GOAL + (dx / d) * depth, y: clamp(MID + (dy / d) * depth, MID - 1.25, MID + 1.25) });
    return dist(g, ideal);
  }

  /* ---------------- skating ---------------- */
  private move(a: Sk) {
    const dt = STEP;
    if (a.stun > 0) {
      a.stun -= dt; if (a.fall > 0) a.fall = Math.max(0, a.fall - dt);
      const k = Math.exp(-dt * (a.fall > 0 ? 1.8 : 3.5)); a.vx *= k; a.vy *= k;
      a.x += a.vx * dt; a.y += a.vy * dt; this.boards(a);
      return;
    }
    const ef = 0.72 + 0.28 * a.energy, k = this.diffOf(a);
    let vmax = a.goalie ? a.max : a.max * ef * (a.sprint ? 1.12 : 1) * (k > 1 ? 1.03 : k < 1 ? 0.95 : 1);
    // with the puck he is a little slower (and the burst gives him less)
    if (this.puck.carrier === a) vmax *= (0.93 + a.hands / 2000) * (a.sprint ? 0.95 : 1);
    if (a.act?.k === 'windup') vmax *= a.act.what === 'shot' ? 0.6 : 0.85;
    // skating backwards: a good defenceman nearly keeps up (crossovers); the manager's vision-control backpedal less so
    if (a.back) vmax *= a.manual ? 0.8 : a.kindD ? 0.9 : 0.84;
    if (this.blockBy === a) vmax *= 0.55;
    let wx: number, wy: number;
    if (a.manual) { wx = a.wx * vmax; wy = a.wy * vmax; }
    else {
      if (!a.goalie) a.sprint = a.urg >= 1 && a.energy > 0.45;
      const dx = a.tx - a.x, dy = a.ty - a.y, d = Math.hypot(dx, dy);
      const want = d < 0.12 ? 0 : Math.min(vmax * a.urg, Math.sqrt(2 * (a.goalie ? 9 : 4.5) * d));
      wx = d > 1e-6 ? (dx / d) * want : 0; wy = d > 1e-6 ? (dy / d) * want : 0;
    }
    const acc = a.acc * ef * (a.sprint ? 1.12 : 1);
    const idle = a.manual && Math.hypot(a.wx, a.wy) < 0.05;
    let dvx = wx - a.vx, dvy = wy - a.vy;
    if (idle) { dvx = -a.vx * Math.min(1, 0.9 * dt); dvy = -a.vy * Math.min(1, 0.9 * dt); }
    else {
      const sp = Math.hypot(a.vx, a.vy), dl = Math.hypot(dvx, dvy);
      const brake = sp > 0.5 && dvx * a.vx + dvy * a.vy < 0 ? 1.7 : 1;
      const lim = acc * brake * dt;
      if (dl > lim) { dvx *= lim / dl; dvy *= lim / dl; }
    }
    a.vx += dvx; a.vy += dvy;
    a.x += a.vx * dt; a.y += a.vy * dt;
    this.boards(a);
    // facing: forward along the stride; standing (or backing up) facing the puck; a goalie always faces out
    const sp = Math.hypot(a.vx, a.vy);
    let face = a.fa;
    if (a.goalie) face = Math.atan2(this.puck.y - a.y, this.puck.x - a.x);
    else if (this.puck.carrier === a) { if (sp > 0.7) face = Math.atan2(a.vy, a.vx); }
    else if (a.back || sp < 1.3) face = Math.atan2(this.puck.y - a.y, this.puck.x - a.x);
    else face = Math.atan2(a.vy, a.vx);
    const rate = (sp > 4 ? 5.5 : 9) * dt;
    a.fa += clamp(angDiff(a.fa, face), -rate, rate);
  }
  private boards(a: Sk) {
    const c = inside(a, a.goalie ? 0.45 : 0.4);
    if (c.x !== a.x || c.y !== a.y) {
      const nx = a.x - c.x, ny = a.y - c.y, n = Math.hypot(nx, ny) || 1, vn = (a.vx * nx + a.vy * ny) / n;
      if (vn > 0) { a.vx -= (1.25 * vn * nx) / n; a.vy -= (1.25 * vn * ny) / n; }
      a.x = c.x; a.y = c.y;
    }
    // around the cages, never through them
    for (const cg of CAGES) if (inBox(a, cg, 0.38)) {
      const pen = [a.x - (cg.x0 - 0.38), cg.x1 + 0.38 - a.x, a.y - (cg.y0 - 0.38), cg.y1 + 0.38 - a.y], k = pen.indexOf(Math.min(...pen));
      if (k === 0) { a.x = cg.x0 - 0.38; a.vx = Math.min(0, a.vx); } else if (k === 1) { a.x = cg.x1 + 0.38; a.vx = Math.max(0, a.vx); }
      else if (k === 2) { a.y = cg.y0 - 0.38; a.vy = Math.min(0, a.vy); } else { a.y = cg.y1 + 0.38; a.vy = Math.max(0, a.vy); }
    }
  }
  private collide() {
    const list = this.onIce();
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const r = (a.goalie ? 0.45 : 0.36) + (b.goalie ? 0.45 : 0.36);
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      if (d >= r || d < 1e-6) continue;
      const nx = dx / d, ny = dy / d, push = (r - d) / 2;
      const wa = a.goalie ? 0.2 : 0.5, wb = b.goalie ? 0.2 : 0.5;
      a.x -= nx * push * (wa / 0.5); a.y -= ny * push * (wa / 0.5); b.x += nx * push * (wb / 0.5); b.y += ny * push * (wb / 0.5);
      const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (vn < 0) { a.vx += nx * vn * 0.5; a.vy += ny * vn * 0.5; b.vx -= nx * vn * 0.5; b.vy -= ny * vn * 0.5; }
      // an attacker who runs into the goalie in his crease (not pushed in, not fighting for a puck right there)
      if (a.goalie !== b.goalie && a.side !== b.side && this.mode === 'play') this.creaseContact(a.goalie ? a : b, a.goalie ? b : a, -vn);
    }
  }

  private creaseContact(g: Sk, a: Sk, speed: number) {
    const gl = loc(g.side, g);
    if (gl.x > GOAL + 1.9 || Math.abs(gl.y - MID) > 1.9 || speed < 2.2 || this.tau - (a.gi ?? -9) < 2) return;
    a.gi = this.tau;
    const p = this.puck, onPuck = !p.dead && dist(a, p) < 1.0 && !p.carrier;
    g.stagger = Math.max(g.stagger, this.tau + 0.35 + speed * 0.05);
    if (onPuck || a.stun > 0) return;
    if (this.rand() < clamp(0.02 + speed * 0.03, 0.06, 0.25)) this.foul(a, PEN_REASON.goalie, g);
  }
  /**
   * After the whistle: an attacker who crashed the net on a frozen puck, a shove or two — usually nothing, sometimes
   * a minor each (4-on-4) or one for the man who started it.
   */
  private scrum(g: Sk) {
    if (!this.rules.penalties) return;
    const near = this.skaters((1 - g.side) as Side, false).filter(a => dist(a, g) < 1.6 && Math.hypot(a.vx, a.vy) > 2.5);
    if (!near.length || this.rand() > 0.12) return;
    const a = near[0], d = this.skaters(g.side, false).sort((u, v) => dist(u, a) - dist(v, a))[0];
    if (!d || dist(d, a) > 3) return;
    this.play('hit', d.side, `Стычка у ворот: ${d.name} и ${a.name}`, d);
    const both = this.rand() < 0.55;
    if (both || this.rand() < 0.5) this.pending.push({ side: a.side, player: a, reason: PEN_REASON.rough, min: 2 });
    if (both || !this.pending.some(q => q.player === a)) this.pending.push({ side: d.side, player: d, reason: PEN_REASON.rough, min: 2 });
  }

  /* ---------------- actions: shots, passes, dekes, checks, pokes ---------------- */
  private releaseRec(a: Sk, kind: ReleaseKind, target: V2, windup: number) {
    const w = this.world(target);
    this.releases.push({ id: a.id, side: a.side, t: this.tau, kind, windup: Math.max(0.08, Math.min(WINDUP[kind], windup)), follow: FOLLOW[kind], tx: w.x, tz: w.z });
  }
  private strength(s: Side): Strength {
    const o = (1 - s) as Side;
    if (!this.goalieOf(o)) return 'EN';
    const bs = Math.min(2, this.boxCount(s)), bo = Math.min(2, this.boxCount(o));
    if (bs < bo) return 'PP';
    if (bs > bo) return 'SH';
    return this.skaters(s).length === 4 && this.skaters(o).length === 4 ? '4v4' : 'EV';
  }
  /** Assists: the last two teammates who had the puck before the scorer since the other team last had it. */
  private assistsFor(scorer: Sk): string[] {
    const out: string[] = [];
    for (let i = this.touches.length - 1; i >= 0 && out.length < 2; i--) {
      const t = this.touches[i];
      if (t.side !== scorer.side) break;
      if (t.id !== scorer.id && !out.includes(t.id)) out.push(t.id);
    }
    return out;
  }
  /**
   * A shot. `power` 0…1 (how long it was loaded), `aim` the stick at the release (presentation-free sim vector:
   * toward one post or the other), null for the AI (it picks the open side).
   */
  private shoot(a: Sk, power: number, held: number, aim: V2 | null, kindIn?: ShotKind) {
    const p = this.puck, s = a.side, o = (1 - s) as Side;
    if (p.carrier !== a && kindIn !== 'tip') return;
    const me = loc(s, a), net = { x: OPP_GOAL, y: MID };
    const g = this.goalieOf(o);
    const gl = g ? loc(s, g) : null;
    // the kind of shot
    const toNet = Math.atan2(loc(s, { x: 0, y: 0 }).y === 0 ? 0 : 0, 1);
    void toNet;
    const facing = Math.atan2(Math.sin(a.fa), Math.cos(a.fa)), netAng = Math.atan2(loc(s, net).y - a.y, loc(s, net).x - a.x);
    const backSide = angDiff(facing, netAng) * a.hand > 1.0;
    let kind: ShotKind = kindIn ?? (held > 0.55 && power > 0.6 ? 'slap' : held > 0.28 ? 'snap' : backSide ? 'backhand' : 'wrist');
    if (!kindIn && this.tau - this.lastSave < 1.3 && dist(me, net) < 5) kind = 'rebound';
    // aimed point on the goal mouth: the manager's man where he aims (the marker on the net shows it), the AI the open side
    const spot = this.aimSpot(a, power, aim, gl, false, kind === 'slap');
    let ty = spot.ty, th = spot.th;
    // aim error: a weak shooter, a hard slapper, skating fast, a man on him, the distance
    const d = dist(me, net);
    const pressure = Math.min(9, ...this.skaters(o, false).map(x => dist(x, a)));
    const k = this.diffOf(a);
    const sig = (0.16 + (88 - a.shoot) * 0.008) * (kind === 'slap' ? 1.25 : kind === 'backhand' ? 1.35 : 1) * (1 + Math.hypot(a.vx, a.vy) / 16) * (pressure < 1.4 ? 1.3 : 1) * clamp(d / 11, 0.5, 2.2) / Math.sqrt(k);
    ty += this.gauss() * sig; th += this.gauss() * sig * 0.55;
    th = Math.max(0.02, th);
    // speed of the puck
    const base = { wrist: 21, snap: 25, slap: 28, backhand: 17, tip: 20, rebound: 19 }[kind];
    let speed = base + a.shoot * 0.1 * (kind === 'slap' ? 0.6 + 0.4 * power : 0.75 + 0.25 * power);
    if (kind === 'tip') speed = Math.max(14, Math.hypot(p.vx, p.vy) * 0.8);
    const target = loc(s, { x: OPP_GOAL, y: ty });
    const onNet = Math.abs(ty - MID) < POST - 0.04 && th < BAR - 0.04;
    const post = !onNet && Math.abs(Math.abs(ty - MID) - POST) < 0.09 && th < BAR;
    // the save: the goalie's rating and the shot
    let outcome: Shot['outcome'] = onNet ? 'save' : 'miss';
    const zone = shotZone(me);
    const q = 1 + (a.shoot - 70) * 0.006;
    const xg = clamp((1 - goalieSavePct(77)) * q * ZONE_MULT[zone], 0.006, 0.42);
    if (onNet) {
      let pg: number;
      if (!g || dist(g, loc(s, { x: OPP_GOAL, y: MID })) > 3.5) pg = 0.92;
      else {
        const sv = goalieSavePct(g.ovr) + (g.rebound - 70) * 0.0002;
        const corner = 0.55 + 0.75 * Math.pow(Math.abs(ty - MID) / POST, 2) + 0.25 * clamp(th / BAR, 0, 1);
        const speedF = Math.pow(speed / 27, 1.3);
        const screen = this.onIce().some(x => x !== a && x !== g && !x.goalie && segDist(x, a, target) < 0.5 && dist(x, target) < 6 && dist(x, target) > 0.6) ? 1.45 : 1;
        const off = this.goalieOff(g, a), move = 1 + clamp(off - 0.3, 0, 2.2) * 1.5;
        const rebound = kind === 'rebound' ? 1.5 : 1;
        const dekeF = this.tau - a.dekeBeat < 0.7 && d < a.dekeR ? a.dekeF : 1;
        const tip = kind === 'tip' ? 1.5 : 1;
        const diff = this.opts.userSide === null ? 1 : s === this.opts.userSide ? (this.difficulty === 'rookie' ? 1.5 : this.difficulty === 'star' ? 0.85 : 1.1) : (this.difficulty === 'rookie' ? 0.7 : this.difficulty === 'star' ? 1.15 : 0.95);
        pg = GOAL_CAL * (1 - sv) * q * ZONE_MULT[zone] * corner * speedF * screen * move * rebound * dekeF * tip * diff;
        pg = clamp(pg, 0.008, 0.8);
      }
      if (this.rand() < pg) outcome = 'goal';
    }
    // the puck flies straight at the aimed point; the height is reached at the goal line
    const dx = target.x - p.x, dy = target.y - p.y, dd = Math.hypot(dx, dy) || 1, T = dd / speed;
    p.carrier = null; p.dead = false; p.leg++; p.passTo = null; p.passBy = null; p.saucer = false;
    p.vx = (dx / dd) * speed; p.vy = (dy / dd) * speed; p.h = 0.05; p.vh = (th - 0.05 + 0.5 * 9.81 * T * T) / T;
    p.noTouch = a; p.noTouchUntil = this.tau + 0.3; p.last = a; this.released(a, kind === 'tip');
    p.icing = me.x < RED ? s : null;
    p.shot = { by: a, side: s, t0: this.tau, outcome, kind, from: { x: a.x, y: a.y }, xg, zone, goalie: g, strength: this.strength(s), ice: this.ice(), assists: this.assistsFor(a), post };
    this.touches.push({ id: a.id, side: s });
    a.lastPuck = this.tau; a.cool = this.tau + 0.35;
    this.releaseRec(a, kind === 'rebound' ? 'snap' : kind, target, held);
  }
  /**
   * Where a shot is aimed (before the shooter's error), team-local: across the goal mouth (ty) and the height (th).
   * The manager's skater: toward the mouse cursor, or the side the skating stick points to (straight at the net:
   * the side the goalie leaves open), low on a quick release and high on a loaded one. The AI: the open side, the
   * height at random.
   */
  private aimSpot(a: Sk, power: number, aim: V2 | null, gl: V2 | null, preview = false, slap = false): { ty: number; th: number } {
    const s = a.side, manual = a.manual && a.id === this.ctl;
    const auto = gl ? (gl.y > MID ? -1 : 1) : preview ? 1 : (this.rand() < 0.5 ? -1 : 1);
    let ty = MID + auto * (POST - 0.2);
    if (manual && this.aimPt) ty = clamp(loc(s, this.aimPt).y, MID - POST + 0.15, MID + POST - 0.15);
    else if (aim && Math.hypot(aim.x, aim.y) > 0.35) {
      const n = (loc(s, { x: L / 2 + aim.x, y: W / 2 + aim.y }).y - W / 2) / Math.hypot(aim.x, aim.y);
      if (!manual) ty = MID + (n < 0 ? -1 : 1) * (POST - 0.2);
      else if (Math.abs(n) > 0.22) ty = MID + clamp(n * 2.2, -1, 1) * (POST - 0.2);
    }
    if (manual) return { ty, th: power >= 0.62 ? 0.92 : 0.16 };
    const high = slap ? this.rand() < 0.4 : this.rand() < (power > 0.6 ? 0.55 : 0.3);
    return { ty, th: high ? 0.85 + this.rand() * 0.25 : 0.1 + this.rand() * 0.2 };
  }
  /**
   * The aim marker on the net (NHL style): where the manager's puck carrier would put a shot now — world metres
   * (x, z on the ice, y the height) and the charge of the shot. Null without the puck or far from the net.
   */
  aimMarker(): { x: number; y: number; z: number; charge: number } | null {
    const me = this.ctl ? this.agents.get(this.ctl) : undefined;
    if (!me || this.mode !== 'play' || this.puck.carrier !== me || !me.manual) return null;
    const s = me.side, mine = loc(s, me);
    if (mine.x < RED - 2) return null;
    const g = this.goalieOf((1 - s) as Side), gl = g ? loc(s, g) : null;
    const act = me.act;
    const charge = act?.k === 'windup' && act.what === 'shot' ? (this.ss.back >= 0 ? stickPower(this.tau - this.ss.back) : buttonPower(this.tau - act.t0)) : 0;
    const spot = this.aimSpot(me, charge, this.aimVec, gl, true);
    const w = this.world(loc(s, { x: OPP_GOAL, y: spot.ty }));
    return { x: w.x, y: spot.th, z: w.z, charge };
  }
  /** Rink percent (the 2D picture: x 0…100 along as drawn, y 0…100 across) → rink coordinates (for the mouse). */
  fromPercent(x: number, y: number): V2 {
    const rx = x * 0.6;
    return { x: this.opts.flip ? L - rx : rx, y: y * 0.3 };
  }
  private gauss() { let u = 0, v = 0; while (u === 0) u = this.rand(); while (v === 0) v = this.rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  /** A pass in the direction of the stick (the manager) to the teammate it points at best. */
  private passFrom(a: Sk, aim: V2 | null, saucer: boolean, power = 0.5) {
    const s = a.side, list = this.skaters(s, false).filter(m => m !== a && m.stun <= 0);
    if (!list.length) return;
    let m: Sk;
    if (aim && Math.hypot(aim.x, aim.y) > 0.3) {
      const ax = aim.x / Math.hypot(aim.x, aim.y), ay = aim.y / Math.hypot(aim.x, aim.y);
      const score = (b: Sk) => { const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1; return ((dx * ax + dy * ay) / d) * 2 - d / 45; };
      m = list.reduce((b, x) => (score(x) > score(b) ? x : b));
    } else {
      const best = this.bestPass(a);
      m = best?.m ?? list.reduce((b, x) => (loc(s, x).x > loc(s, b).x ? x : b));
    }
    this.passTo(a, m, saucer, power);
  }
  /** power 0…1: a soft tap … a hard one (0.5: the usual pass) */
  private passTo(a: Sk, m: Sk, saucer: boolean, power = 0.5) {
    const p = this.puck;
    if (p.carrier !== a) return;
    const d = dist(a, m), k = this.diffOf(a);
    const speed = clamp(9 + d * 0.5, 10, 23) * (0.92 + a.pass / 900) * (0.75 + 0.5 * clamp(power, 0, 1));
    // lead the receiver: where he will be when the puck gets there
    const t = d / speed;
    let tx = m.x + m.vx * t * 0.9, ty = m.y + m.vy * t * 0.9;
    const err = this.gauss() * (0.075 - a.pass / 1800) / Math.sqrt(k);
    const ang = Math.atan2(ty - a.y, tx - a.x) + err, dd = Math.hypot(tx - a.x, ty - a.y);
    tx = a.x + Math.cos(ang) * dd; ty = a.y + Math.sin(ang) * dd;
    p.carrier = null; p.dead = false; p.leg++; p.shot = null; p.saucer = saucer;
    p.vx = Math.cos(ang) * speed; p.vy = Math.sin(ang) * speed; p.h = 0.02; p.vh = saucer ? 3.2 : 0;
    p.passTo = m; p.passBy = a; p.last = a; p.noTouch = a; p.noTouchUntil = this.tau + 0.3; this.released(a);
    p.icing = loc(a.side, a).x < RED ? a.side : null;
    a.lastPuck = this.tau; a.cool = this.tau + 0.25;
    this.releaseRec(a, saucer ? 'saucer' : 'pass', { x: tx, y: ty }, 0.2);
    // the manager's control follows the pass (NHL style)
    if (this.opts.userSide === a.side && a.manual) this.ctl = m.id;
  }
  private dump(a: Sk) {
    const s = a.side, me = loc(s, a), far = me.y < MID ? 26 : 4;
    const t = loc(s, { x: OPP_GOAL + 1.5, y: far });
    this.slide(a, t, 17, 0.25);
    this.play('dump', s, `${a.name} вбрасывает шайбу в зону`, a);
  }
  private clear(a: Sk, pk: boolean) {
    const s = a.side, me = loc(s, a);
    // under a hard forecheck: up off the glass by the blue line, out over the forecheckers' heads — aimed to hit the
    // glass 1.7–2.5 m up; a mishit flies over it (a delay-of-game minor)
    const pressure = Math.min(9, ...this.skaters((1 - s) as Side, false).map(x => dist(x, a)));
    if (!pk && me.x < BLUE - 4 && pressure < 2.2 && this.rand() < 0.4) {
      const side = me.y < MID ? 0 : W, t = loc(s, { x: clamp(me.x + 9, BLUE - 3, BLUE - 0.5), y: side });
      const speed = 19, d = dist(a, t), T = d / speed, k = this.diffOf(a);
      const aimH = 1.75 + this.rand() * 0.7 + this.gauss() * (0.7 - a.pass / 400) / Math.sqrt(k);
      this.slide(a, t, speed, 0);
      this.puck.saucer = true; this.puck.vh = (aimH - 0.02 + 4.905 * T * T) / T;
      this.play('clear', s, `${a.name} выбрасывает шайбу по стеклу`, a);
      return;
    }
    const t = pk ? loc(s, { x: OPP_GOAL + 2, y: me.y < MID ? 6 : 24 }) : loc(s, { x: BLUE + 9, y: me.y < MID ? 1.2 : 28.8 });
    this.slide(a, t, pk ? 24 : 17, pk ? 1.2 : 0.2);
    this.play('clear', s, `${a.name} выбрасывает шайбу из зоны`, a);
  }
  private slide(a: Sk, t: V2, speed: number, loft: number) {
    const p = this.puck, dx = t.x - p.x, dy = t.y - p.y, d = Math.hypot(dx, dy) || 1;
    p.carrier = null; p.dead = false; p.leg++; p.shot = null; p.passTo = null; p.passBy = null; p.saucer = loft > 0.5;
    p.vx = (dx / d) * speed; p.vy = (dy / d) * speed; p.h = 0.02; p.vh = loft * 4;
    p.last = a; p.noTouch = a; p.noTouchUntil = this.tau + 0.4; this.released(a);
    p.icing = loc(a.side, a).x < RED ? a.side : null;
    a.lastPuck = this.tau; a.cool = this.tau + 0.3;
    this.releaseRec(a, 'pass', t, 0.2);
  }
  private deke(a: Sk, mx: number, my: number, forced?: 1 | -1, kindIn?: DekeKind) {
    // the side: where the stick points across his skating line, else away from the nearest defender
    const opps = this.skaters((1 - a.side) as Side, false);
    const nearest = opps.reduce<Sk | null>((b, x) => (!b || dist(x, a) < dist(b, a) ? x : b), null);
    let s: 1 | -1 = forced ?? 1;
    if (!forced) {
      const lat = -Math.sin(a.fa) * mx + Math.cos(a.fa) * my;
      if (Math.abs(lat) > 0.25) s = lat > 0 ? 1 : -1;
      else if (nearest) s = ((nearest.x - a.x) * -Math.sin(a.fa) + (nearest.y - a.y) * Math.cos(a.fa)) > 0 ? -1 : 1;
    }
    const kind: DekeKind = kindIn ?? 'side';
    a.act = { k: 'deke', t0: this.tau, s, kind };
    a.cool = this.tau + DEKE_DUR[kind] + 0.3;
    const g = this.goalieOf((1 - a.side) as Side);
    const nx = -Math.sin(a.fa) * s, ny = Math.cos(a.fa) * s;
    if (kind === 'side') { a.vx += nx * 1.6; a.vy += ny * 1.6; if (g && dist(g, a) < 5.5) { a.dekeBeat = this.tau; a.dekeF = 1.6; a.dekeR = 6; } }
    else if (kind === 'toe') {
      // the puck pulled in to the skates and swept across: the defender reaching for it bites
      a.vx += nx * 1.2; a.vy += ny * 1.2;
      const front = opps.find(o => o.stun <= 0 && dist(o, a) < 2.8 && Math.cos(angDiff(a.fa, Math.atan2(o.y - a.y, o.x - a.x))) > 0.4);
      if (front && this.rand() < 0.35 + (a.hands - front.def) / 150) { front.stun = 0.35; front.stagger = this.tau + 0.4; }
      if (g && dist(g, a) < 5) { a.dekeBeat = this.tau; a.dekeF = 1.7; a.dekeR = 6; }
    } else if (kind === 'between') {
      // the dangle: forehand, through the legs, backhand — the goalie has to move across twice
      a.vx += nx * 1.0; a.vy += ny * 1.0;
      if (g && dist(g, a) < 7) { a.dekeBeat = this.tau; a.dekeF = 1.95; a.dekeR = 7; }
    } else if (kind === 'spin') {
      // a spin-o-rama: the body between the puck and the checker, a turn away from him
      if (nearest && dist(nearest, a) < 3) { const ax = a.x - nearest.x, ay = a.y - nearest.y, d = Math.hypot(ax, ay) || 1; a.vx = a.vx * 0.75 + (ax / d) * 1.4; a.vy = a.vy * 0.75 + (ay / d) * 1.4; } else { a.vx *= 0.85; a.vy *= 0.85; }
      if (g && dist(g, a) < 4.5) { a.dekeBeat = this.tau; a.dekeF = 1.5; a.dekeR = 5; }
    } else {
      // a shot fake: the goalie and the shot blockers go down for a shot that does not come
      if (g && dist(g, a) < 11) { a.dekeBeat = this.tau; a.dekeF = 1.45; a.dekeR = 11; }
      const net = loc(a.side, { x: OPP_GOAL, y: MID });
      for (const o of opps) if (o.stun <= 0 && segDist(o, a, net) < 0.9 && dist(o, a) < 4.5 && this.rand() < 0.55) { o.stun = 0.4; o.stagger = this.tau + 0.4; }
    }
    // a clumsy deke in traffic loses the puck (the harder the move, the bigger the risk)
    const near = opps.some(o => dist(o, a) < 1.5);
    const risk = { side: 0.14, toe: 0.16, between: 0.22, spin: 0.12, fake: 0.05 }[kind] - a.hands / 900;
    if (near && this.rand() < risk) { this.loose(a.vx + Math.cos(a.fa) * 2, a.vy + Math.sin(a.fa) * 2); this.puck.noTouch = a; this.puck.noTouchUntil = this.tau + 0.4; return; }
    if (this.opts.userSide === a.side && a.manual) this.play('loose', a.side, `${a.name}: ${DEKE_NAME[kind]}`, a);
  }
  /** The deke an AI carrier picks: his hands and the situation (a checker on his back: a spin; a man in front: a toe drag). */
  private aiDekeKind(a: Sk, closeGoalie: boolean): DekeKind {
    const r = this.rand(), h = a.hands;
    const behind = this.skaters((1 - a.side) as Side, false).some(o => dist(o, a) < 1.8 && Math.cos(angDiff(a.fa, Math.atan2(o.y - a.y, o.x - a.x))) < -0.2);
    if (behind && r < 0.45) return 'spin';
    if (closeGoalie) return r < 0.25 && h > 72 ? 'between' : r < 0.55 ? 'fake' : 'side';
    if (h > 76 && r < 0.15) return 'between';
    return r < 0.45 ? 'toe' : 'side';
  }
  /** kindIn forces the kind of hit (the NHL buttons: Y a board pin, the stick down-and-up a shoulder check); light: a push check */
  private startCheck(a: Sk, tgt?: Sk, kindIn?: CheckKind, light = false) {
    const o = (1 - a.side) as Side;
    const cands = this.skaters(o, false).filter(b => b.stun <= 0 && dist(a, b) < 2.6 && Math.cos(angDiff(a.fa, Math.atan2(b.y - a.y, b.x - a.x))) > 0.35);
    const t = tgt ?? cands.sort((p, q) => dist(a, p) - dist(a, q))[0];
    // the kind of hit: pinning a man on the boards, a hip check on one cutting across, a shoulder into him
    let kind: CheckKind = 'shoulder';
    if (t) {
      const boards = inside(t, 1.6).x !== t.x || inside(t, 1.6).y !== t.y;
      const dx = t.x - a.x, dy = t.y - a.y, d = Math.hypot(dx, dy) || 1, tsp = Math.hypot(t.vx, t.vy);
      const across = tsp > 2.5 ? Math.abs((t.vx * dy - t.vy * dx) / (d * tsp)) : 0;
      if (boards && Math.hypot(a.vx - t.vx, a.vy - t.vy) < 4.5) kind = 'pin';
      else if (across > 0.75) kind = 'hip';
    }
    if (kindIn) kind = kindIn;
    // was he playing the puck as the check began? (then the hit is fair even if the puck is gone by contact)
    const onPuck = !!t && (this.puck.carrier === t || this.tau - t.ownAt < 0.35);
    a.act = { k: 'check', t0: this.tau, tgt: t ?? (null as unknown as Sk), done: !t, kind, onPuck, ...(light ? { light } : {}) };
    a.cool = this.tau + (light ? 0.6 : 0.9);
    if (t) { const dx = t.x - a.x, dy = t.y - a.y, d = Math.hypot(dx, dy) || 1, kick = light ? 1.2 : 2.2; a.vx += (dx / d) * kick; a.vy += (dy / d) * kick; }
  }
  private startPoke(a: Sk, forceLift = false) {
    // from behind or beside the carrier a poke at the puck is a stick lift instead (A in the NHL scheme: always a lift)
    const c = this.puck.carrier;
    const lift = !!c && c.side !== a.side && dist(a, c) < (forceLift ? 2.1 : 1.9) && (forceLift || Math.cos(angDiff(c.fa, Math.atan2(a.y - c.y, a.x - c.x))) < 0.1);
    a.act = { k: 'poke', t0: this.tau, done: false, lift };
    a.cool = this.tau + 0.7;
  }
  private acts() {
    for (const a of this.onIce()) {
      const act = a.act;
      if (!act) continue;
      if (act.k === 'deke' && this.tau - act.t0 > DEKE_DUR[act.kind]) a.act = null;
      else if (act.k === 'windup' && this.puck.carrier !== a) a.act = null;
      else if (act.k === 'poke') { if (!act.done && this.tau - act.t0 > 0.12) { act.done = true; this.resolvePoke(a); } if (this.tau - act.t0 > 0.38) a.act = null; }
      else if (act.k === 'reach') {
        if (!act.done && this.tau - act.t0 > REACH_DUR * 0.4) { act.done = true; this.resolveReach(a); }
        if (this.tau - act.t0 > REACH_DUR) a.act = null;
      }
      else if (act.k === 'check') {
        const t = act.tgt;
        if (!act.done && t && t.on === 'ice' && dist(a, t) < 0.95) { act.done = true; this.resolveCheck(a, t); }
        if (this.tau - act.t0 > 0.42) {
          // it never landed: thrown at nothing at speed he glides past off balance
          if (!act.done) { act.done = true; if (t && Math.hypot(a.vx, a.vy) > 5.5) a.stagger = this.tau + 0.35; }
          a.act = null;
        }
      }
    }
  }
  private resolvePoke(a: Sk) {
    const p = this.puck, reach = { x: a.x + Math.cos(a.fa) * 1.35, y: a.y + Math.sin(a.fa) * 1.35 };
    const c = p.carrier;
    if (a.act?.k === 'poke' && a.act.lift && c && c.side !== a.side) {
      // a stick lift: his stick comes up off the ice, the puck stays where it was — the lifter usually has it
      if (dist(a, c) < 1.6) {
        const pr = clamp(0.5 + (a.def - c.hands) / 120 - (c.act?.k === 'deke' && c.act.kind === 'spin' ? 0.3 : 0), 0.15, 0.85) * this.diffOf(a) / Math.sqrt(this.diffOf(c));
        if (this.rand() < pr) {
          // the lifter steps in and takes the puck off him (the AI's lift leaves it in the skates half the time)
          c.act = null; c.stagger = this.tau + 0.3; c.cool = Math.max(c.cool, this.tau + 0.5);
          if (a.manual || this.rand() < 0.5) this.steal(a, c);
          else { this.loose(c.vx * 0.25, c.vy * 0.25); p.noTouch = c; p.noTouchUntil = this.tau + 0.5; }
          this.play('takeaway', a.side, `Подбил клюшку: ${a.name}`, a);
        } else {
          // the stick comes up off his and too high, or chops at his hands; a high stick that draws blood is 2+2
          const r = this.rand();
          if (r < 0.012) this.foul(a, PEN_REASON.slash, c);
          else if (r < 0.022) { const blood = this.rand() < 0.25; c.stagger = Math.max(c.stagger, this.tau + 0.4); this.foul(a, PEN_REASON.high, c, blood ? 4 : 2); }
        }
      }
      return;
    }
    if (c && c.side !== a.side) {
      const inReach = dist(reach, p) < 0.8 || (dist(a, p) < 1.7 && Math.cos(angDiff(a.fa, Math.atan2(p.y - a.y, p.x - a.x))) > 0.6);
      const dk = c.act?.k === 'deke' ? c.act.kind : null;
      if (inReach) {
        // quick hands side to side (the manager's stickhandling) keep the puck away from a reaching stick
        const dangle = c.manual && this.tau - this.handleSwing < 0.45 ? 0.14 : 0;
        const pr = clamp(0.42 + ((a.check + a.def) / 2 - c.hands) / 140 - (dk === 'toe' || dk === 'between' ? 0.42 : dk ? 0.28 : 0) - dangle, 0.06, 0.85) * this.diffOf(a) / Math.sqrt(this.diffOf(c));
        if (this.rand() < pr) {
          c.act = null; c.cool = Math.max(c.cool, this.tau + 0.4);
          // a clean poke: the puck comes onto his stick (good hands keep it; the manager's man most of the time,
          // the AI's less often — it pokes a lot), otherwise it is knocked loose toward him
          if (this.rand() < (a.manual ? clamp(0.65 + (a.hands - 60) / 100, 0.5, 0.92) : 0.3)) this.steal(a, c);
          else {
            const dx = a.x - p.x, dy = a.y - p.y, d = Math.hypot(dx, dy) || 1, ang = Math.atan2(dy, dx) + (this.rand() - 0.5) * 0.9;
            this.loose(Math.cos(ang) * Math.min(3, d * 2.2) + a.vx * 0.5, Math.sin(ang) * Math.min(3, d * 2.2) + a.vy * 0.5);
            p.noTouch = c; p.noTouchUntil = this.tau + 0.45;
          }
          this.play('takeaway', a.side, `Отбор клюшкой: ${a.name}`, a);
          return;
        }
      }
      // a stick in the legs instead of on the puck: a trip or a hook
      // (from behind it is a hook more often than not; a trip takes his skates away and puts him down)
      if (dist(a, c) < 1.2) {
        const behind = Math.cos(angDiff(c.fa, Math.atan2(a.y - c.y, a.x - c.x))) < -0.2;
        if (this.rand() < (behind ? 0.15 : 0.08)) {
          const trip = this.rand() < (behind ? 0.35 : 0.65);
          if (trip && this.rand() < 0.6) this.knockDown(c, 'front', 1, 0.85);
          else c.stagger = Math.max(c.stagger, this.tau + 0.35);
          this.foul(a, trip ? PEN_REASON.trip : PEN_REASON.hook, c);
        }
      }
      return;
    }
    // a loose puck or a pass within reach: knocked toward him
    if (!c && !p.dead && dist(reach, p) < 0.9 && p.h < 0.4 && !p.shot) {
      const dx = a.x - p.x, dy = a.y - p.y, d = Math.hypot(dx, dy) || 1;
      p.vx = (dx / d) * 2.5; p.vy = (dy / d) * 2.5; p.leg++; p.passTo = null;
    }
  }
  private resolveCheck(a: Sk, t: Sk) {
    const dx = t.x - a.x, dy = t.y - a.y, d = Math.hypot(dx, dy) || 1, nx = dx / d, ny = dy / d;
    const closing = Math.max(0, (a.vx - t.vx) * nx + (a.vy - t.vy) * ny);
    const act = a.act?.k === 'check' ? a.act : null;
    const kind: CheckKind = act ? act.kind : 'shoulder';
    const dk = t.act?.k === 'deke' ? t.act.kind : null;
    // a hip check uses the victim's own speed; a pin needs no speed at all
    const tsp = Math.hypot(t.vx, t.vy);
    const k = Math.sqrt(this.diffOf(a) / this.diffOf(t));
    const p = this.puck;
    // Was the victim playing the puck? The carrier; the one who had it a moment ago (a finished check on a man
    // who just shot, passed or lost it is fair — the grace of about a second); the check began while he had it;
    // he is fighting for a loose puck at his feet; the pass is on its way to him and close.
    const late = this.tau - t.ownAt;
    const playing = p.carrier === t || late < 1.0 || !!act?.onPuck
      || (!p.carrier && !p.shot && !p.dead && dist(t, p) < 1.8) || (p.passTo === t && dist(t, p) < 6);
    // Not every check lands: an agile man slips it (more so in a deke or a sharp turn), or a strong one rides it out.
    const slip = clamp(0.1 + ((t.hands + t.bal) / 2 - a.check) / 220 + (dk === 'spin' ? 0.3 : dk ? 0.15 : 0) + (kind === 'shoulder' && closing > 8 ? 0.08 : 0) - (kind === 'pin' ? 0.08 : 0), 0.04, 0.5) / k;
    const pr = clamp(0.42 + (a.check - t.bal) / 110 + (kind === 'hip' ? tsp / 16 : kind === 'pin' ? 0.12 : closing / 14), 0.12, 0.92) * k;
    const r = this.rand();
    if (r < slip) {
      // a whiff: he slips it and the checker sails past with all his speed; a big run at nothing can put him down
      const sp = Math.hypot(a.vx, a.vy);
      a.act = null; a.stagger = this.tau + 0.5;
      if (sp > 6 && this.rand() < 0.3) this.knockDown(a, 'front', 1, 0.95);
      else { a.stun = 0.25; }
      t.stagger = Math.max(t.stagger, this.tau + 0.15);
      this.play('hit', t.side, `${t.name} увернулся от силового — ${a.name} мимо`, t);
      return;
    }
    if (r < slip + (1 - slip) * pr) {
      // a push check (NHL: the right stick up) knocks him off the puck but rarely off his feet
      const light = !!act?.light;
      const impact = (kind === 'hip' ? 1.2 + tsp * 0.8 : kind === 'pin' ? 1.0 : 1.5 + closing) * (light ? 0.5 : 1);
      const fall = kind !== 'pin' && (impact > 4.2 || this.rand() < (light ? 0.06 : kind === 'hip' ? 0.45 : 0.3));
      const fromBehind = Math.cos(angDiff(t.fa, Math.atan2(ny, nx))) > 0.6;
      if (fall) {
        // over the hip he flips sideways; from behind he goes face first; a shoulder from the front puts him on his back
        const side = (Math.cos(t.fa) * ny - Math.sin(t.fa) * nx) > 0 ? 1 : -1;
        this.knockDown(t, kind === 'hip' ? 'side' : fromBehind ? 'front' : 'back', side, 1.0 + impact * 0.1);
      } else { t.stun = kind === 'pin' ? 0.9 : 0.45; t.act = null; t.stagger = this.tau + 0.45; }
      if (kind === 'pin') { t.vx *= 0.15; t.vy *= 0.15; a.vx = t.vx; a.vy = t.vy; }
      else { t.vx = t.vx * 0.3 + nx * impact * 0.6; t.vy = t.vy * 0.3 + ny * impact * 0.6; a.vx *= 0.5; a.vy *= 0.5; }
      if (p.carrier === t) { const kk = kind === 'pin' ? 0.3 : 1; this.loose((t.vx * 0.6 + (this.rand() - 0.5) * 3) * kk, (t.vy * 0.6 + (this.rand() - 0.5) * 3) * kk); p.noTouch = t; p.noTouchUntil = this.tau + 0.6; }
      this.hits[a.side]++;
      this.out.push({ type: 'hit', side: a.side, player: a.id, victim: t.id });
      this.play('hit', a.side, `${light ? 'Толчок' : kind === 'hip' ? 'Силовой бедром' : kind === 'pin' ? 'Прижал к борту' : 'Силовой приём'}${fall ? ' — соперник на льду' : ''}: ${a.name} — ${t.name}`, a);
      // fouls: a man not playing the puck (the later, the likelier the call), a charge from far, into the boards from behind
      const nearBoards = inside(t, 1.6).x !== t.x || inside(t, 1.6).y !== t.y;
      // (from behind into the boards he goes face first: a major and more; a violent hit into the boards is a major too;
      // a big run at a man's head with the shoulder or an elbow up; a hip check low at the knees)
      const r2 = this.rand();
      if (!playing && this.rand() < (late < 2 ? 0.3 : 0.6)) this.foul(a, PEN_REASON.interference, t);
      else if (kind !== 'pin' && fromBehind && nearBoards && fall && r2 < 0.3) this.foul(a, PEN_REASON.behind, t, 5);
      else if (kind !== 'pin' && fromBehind && nearBoards && r2 < 0.35) this.foul(a, PEN_REASON.board, t, impact > 5 && fall ? 5 : 2);
      else if (kind === 'shoulder' && !light && closing > 7 && r2 < 0.25) this.foul(a, PEN_REASON.charge, t);
      else if (kind === 'shoulder' && !light && closing > 6.5 && fall && !fromBehind && r2 < 0.255) this.foul(a, PEN_REASON.head, t, 5);
      else if (kind === 'shoulder' && !light && r2 > 0.988) this.foul(a, PEN_REASON.elbow, t, closing > 7 && fall ? 5 : 2);
      else if (kind === 'hip' && fall && r2 > 0.97) this.foul(a, PEN_REASON.knee, t);
      else if (kind === 'pin' && r2 > 0.94) this.foul(a, PEN_REASON.hold, t);
      return;
    }
    // he rides it out: they bump, the checker bounces off and both wobble; the puck stays with him
    a.act = null; a.stun = 0.3; a.stagger = this.tau + 0.4;
    a.vx = a.vx * 0.2 - nx * 1.2; a.vy = a.vy * 0.2 - ny * 1.2;
    t.stagger = Math.max(t.stagger, this.tau + 0.3);
    this.play('hit', t.side, `${t.name} устоял после силового ${a.name}`, t);
    // a bump on a man far from the play is still interference, though it is called less often; beaten, he grabs him
    if (!playing && late > 2 && this.rand() < 0.15) this.foul(a, PEN_REASON.interference, t);
    else if (playing && this.rand() < 0.035) { t.vx *= 0.6; t.vy *= 0.6; this.foul(a, PEN_REASON.hold, t); }
  }
  /** Down on the ice: stunned for `sec` (getting up the last part), falling the given way. */
  private knockDown(a: Sk, kind: FallKind, side: 1 | -1, sec: number) {
    a.stun = sec; a.fall = sec; a.fallK = kind; a.fallS = side; a.fallAt = this.tau; a.act = null;
    if (this.puck.carrier === a) { this.loose(a.vx * 0.5 + (this.rand() - 0.5) * 2, a.vy * 0.5 + (this.rand() - 0.5) * 2); this.puck.noTouch = a; this.puck.noTouchUntil = this.tau + 0.5; }
  }
  private foul(a: Sk, reason: string, victim: Sk, min: 2 | 4 | 5 = 2) {
    if (!this.rules.penalties || this.pending.some(p => p.player === a)) return;
    this.pending.push({ side: a.side, player: a, reason, min });
    this.play('penalty', a.side, `Отложенный штраф: ${a.name} — ${reason}${min === 5 ? ' (большой штраф)' : ''}`, a);
    void victim;
    // the other team has the puck: the referee waits until the offending team touches it
    if (this.puck.carrier?.side === a.side) this.whistlePenalty();
  }
  private delayedWhistle() {
    if (!this.pending.length) return;
    const s = this.pending[0].side, p = this.puck;
    if (p.carrier?.side === s || (p.last?.side === s && p.last !== null && this.tau - p.last.lastPuck < 0.05)) this.whistlePenalty();
  }
  private whistlePenalty() {
    const s = this.pending[0].side;
    this.startStop('penalty', zoneDot(s, this.puck.y), 1.6);
  }
  private loose(vx: number, vy: number) {
    const p = this.puck;
    p.carrier = null; p.vx = vx; p.vy = vy; p.vh = 0; p.h = 0; p.dead = false; p.shot = null; p.passTo = null; p.passBy = null; p.leg++; p.saucer = false;
  }

  /* ---------------- the puck ---------------- */
  private puckStep() {
    const p = this.puck;
    if (p.dead) return;
    if (p.carrier) {
      const c = p.carrier;
      // on the blade, a stick length ahead; stickhandled forehand to backhand while he skates; a deke pulls it wide
      const sp = Math.hypot(c.vx, c.vy);
      let off = Math.sin(this.tau * 7.2 + c.id.length) * 0.2 * clamp(sp / 3, 0.25, 1) * (c.act?.k === 'windup' ? 0 : 1);
      let reach = REACH;
      let fa = c.fa;
      if (c.act?.k === 'deke') {
        const u = clamp((this.tau - c.act.t0) / DEKE_DUR[c.act.kind], 0, 1), bell = Math.sin(Math.PI * u), sd = c.act.s;
        if (c.act.kind === 'side') off = sd * 0.55 * bell;
        else if (c.act.kind === 'toe') { off = sd * 0.6 * bell; reach = REACH - 0.42 * bell; }
        else if (c.act.kind === 'between') { off = sd * 0.35 * Math.sin(Math.PI * 2 * u); reach = REACH - 1.05 * bell; }
        else if (c.act.kind === 'spin') { fa = c.fa + sd * Math.PI * 2 * smooth01(u); reach = 0.62; off = 0; }
        else { reach = 0.5; off = 0; }
      }
      // the manager's stickhandling: the blade carries the puck where his skill stick holds it
      else if (c.manual && this.handle && c.id === this.ctl && (!c.act || (this.handleFast && c.act.k === 'windup' && c.act.what === 'pass'))) { off = this.handle.lat * (this.handleFast ? 0.62 : 0.55); reach = REACH + this.handle.fwd * 0.22; }
      if (c.act?.k === 'windup' && !(this.handleFast && this.handle && c.act.what === 'pass')) reach = c.act.what === 'shot' ? 0.5 : 0.6;
      // pulled in from full stretch
      if (c.act?.k === 'reach') { reach = REACH + 0.55 * (1 - smooth01((this.tau - c.act.t0) / REACH_DUR / 0.6 - 0.66)); off = 0; }
      const b = { x: c.x + Math.cos(fa) * reach - Math.sin(fa) * off, y: c.y + Math.sin(fa) * reach + Math.cos(fa) * off };
      for (const cg of CAGES) if (inBox(b, cg, 0.06)) {
        const pen = [b.x - (cg.x0 - 0.06), cg.x1 + 0.06 - b.x, b.y - (cg.y0 - 0.06), cg.y1 + 0.06 - b.y], k = pen.indexOf(Math.min(...pen));
        if (k === 0) b.x = cg.x0 - 0.06; else if (k === 1) b.x = cg.x1 + 0.06; else if (k === 2) b.y = cg.y0 - 0.06; else b.y = cg.y1 + 0.06;
      }
      const ib = inside(b, 0.12);
      p.x = ib.x; p.y = ib.y; p.h = 0; p.vx = c.vx; p.vy = c.vy; p.vh = 0;
      return;
    }
    const sp = Math.hypot(p.vx, p.vy);
    const n = sp > 16 ? 4 : sp > 6 ? 2 : 1, dt = STEP / n;
    for (let i = 0; i < n && !p.dead && !p.carrier && this.mode === 'play'; i++) this.puckSub(dt);
  }
  private puckSub(dt: number) {
    const p = this.puck;
    const ox = p.x, oy = p.y, oh = p.h;
    // flight: gravity, a bounce on the ice; sliding: ice friction
    if (p.h > 0 || p.vh > 0) {
      p.vh -= 9.81 * dt; p.h += p.vh * dt;
      if (p.h <= 0) { p.h = 0; p.vh = Math.abs(p.vh) > 1.2 ? -p.vh * 0.25 : 0; p.vx *= 0.9; p.vy *= 0.9; p.saucer = false; }
    } else {
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > 0) { const ns = Math.max(0, sp - (0.9 + sp * 0.02) * dt); p.vx *= ns / sp; p.vy *= ns / sp; }
    }
    p.x += p.vx * dt; p.y += p.vy * dt;
    const shot = p.shot;
    // a shot through traffic: blocked by a body in the lane, tipped by a teammate's stick
    if (shot && p.h < 1.0) {
      for (const a of this.onIce()) {
        if (a.goalie || a === shot.by || a.stun > 0 || (p.noTouch === a && this.tau < p.noTouchUntil)) continue;
        const d = segDist(a, { x: ox, y: oy }, p);
        // LB held (the manager's block stance): down on one knee, a much wider and surer body in the lane
        const stance = this.blockBy === a;
        if (a.side !== shot.side && d < (stance ? (p.h < 1.1 ? 0.95 : 0.5) : p.h < 0.5 ? 0.48 : 0.36) && this.rand() < (stance ? 0.96 : 0.8)) { this.block(a, shot); if (stance) a.stun = Math.max(a.stun, 0.3); return; }
        if (a.side === shot.side && p.h < 0.5 && dist(this.blade(a), p) < 0.5 && this.rand() < 0.03 * 60 * dt * (a.manual ? 2 : 1)) { this.tip(a, shot); return; }
      }
    }
    // the goalie
    for (const s of [0, 1] as Side[]) {
      const g = this.goalieOf(s);
      if (!g || g.stun > 0) continue;
      if (shot && shot.side !== s) {
        if (shot.outcome !== 'save') continue;
        const gl = loc(shot.side, g), pl = loc(shot.side, p);
        if (dist(g, p) < 0.7 || pl.x >= gl.x - 0.05) { this.save(g, shot); return; }
        continue;
      }
      if (!shot && p.h < 1.1 && segDist(g, { x: ox, y: oy }, p) < 0.5 && !(p.noTouch === g && this.tau < p.noTouchUntil)) {
        // a pass across the crease or a loose puck into his pads
        const spd = Math.hypot(p.vx, p.vy);
        if (spd < 9 || this.rand() < 0.8) { this.goalieStop(g, spd); return; }
      }
    }
    // the goal line: in between the posts it is a goal, the posts and the bar ring it back out
    for (const s of [0, 1] as Side[]) {
      const gx = s === 0 ? GOAL : OPP_GOAL, before = s === 0 ? ox > gx : ox < gx, after = s === 0 ? p.x <= gx : p.x >= gx;
      if (!before || !after) continue;
      const u = (gx - ox) / (p.x - ox || 1e-9), y = oy + (p.y - oy) * u, h = oh + (p.h - oh) * u;
      const ay = Math.abs(y - MID);
      if (ay < POST - 0.04 && h < BAR - 0.04) { this.goal((1 - s) as Side, { x: gx, y, h }); return; }
      if ((ay >= POST - 0.04 && ay < POST + 0.07 && h < BAR) || (ay < POST + 0.04 && h >= BAR - 0.04 && h < BAR + 0.06)) {
        p.x = gx + (s === 0 ? 0.05 : -0.05); p.y = y; p.vx = -p.vx * 0.55; p.vy = p.vy * 0.8 + (this.rand() - 0.5) * 4; p.leg++; p.defl = true;
        if (shot) this.missed(shot, true);
        this.play('wide', shot?.side ?? null, 'Штанга!');
        return;
      }
      if (shot && shot.side !== s) this.missed(shot, false);
    }
    // the cages from the sides and the back
    for (const cg of CAGES) if (inBox(p, cg, 0.04) && !inBox({ x: ox, y: oy }, cg, 0.04)) {
      const fromX = ox < cg.x0 - 0.04 || ox > cg.x1 + 0.04;
      if (fromX) p.vx = -p.vx * 0.4; else p.vy = -p.vy * 0.4;
      p.x = ox; p.y = oy; p.leg++; p.defl = true;
    }
    // the boards and the glass above them; over the top (or into the netting behind the nets, or into a bench) it is out of play
    const c = inside(p, 0.08);
    if (c.x !== p.x || c.y !== p.y) {
      const wx = c.x - L / 2, wz = c.y - MID;
      if (p.h > glassTop(wx, wz)) {
        if (shot) this.missed(shot, false);
        p.x = c.x; p.y = c.y;
        this.outOfPlay(inBenchFront(wx, wz));
        return;
      }
      const nx = p.x - c.x, ny = p.y - c.y, nl = Math.hypot(nx, ny) || 1, vn = (p.vx * nx + p.vy * ny) / nl;
      // the glass gives a little more than the boards
      const e = p.h > BOARDS_H ? 1.5 : 1.62;
      if (vn > 0) { p.vx -= (e * vn * nx) / nl; p.vy -= (e * vn * ny) / nl; p.vx *= 0.9; p.vy *= 0.9; if (p.h > BOARDS_H) p.vh = Math.min(p.vh, 0) * 0.5; }
      p.x = c.x; p.y = c.y; p.defl = true;
      if (shot) this.missed(shot, false);
    }
    if (shot && this.tau - shot.t0 > 2.5) this.missed(shot, false);
    // icing: shot down the ice from behind the red line, over the goal line, untouched
    if (p.icing !== null && this.rules.icing && !p.shot) {
      const s = p.icing, l = loc(s, p);
      if (l.x > OPP_GOAL && Math.abs(l.y - MID) > POST + 0.1) {
        if (this.manpower(s) < this.manpower((1 - s) as Side)) p.icing = null;
        else {
          this.out.push({ type: 'icing', side: s });
          this.play('icing', s, `Проброс: ${this.teams[s].short ?? this.teams[s].name}`);
          this.startStop('icing', zoneDot(s, p.y), 1.2, s);
        }
      }
    }
  }
  /** The puck leaves a player's stick (or body: `defl`, not played on purpose). */
  private released(a: Sk, defl = false) { this.puck.rel = { by: a, x: a.x, y: a.y }; this.puck.defl = defl; }
  /**
   * Out of play (KHL rules): the whistle; a faceoff at the dot nearest to where the puck was last played — but in
   * the neutral zone when the attacking team sent it out from its attacking zone. A player who sends it straight out
   * over the glass from his own zone (not touching anyone or the boards and glass on the way; not into a players'
   * bench, where there is no glass) gets a minor for delay of game, and the faceoff is in his end.
   */
  private outOfPlay(bench: boolean) {
    const p = this.puck, r = p.rel;
    const by = r?.by ?? p.last;
    const s = by?.side ?? null;
    const from = r ? { x: r.x, y: r.y } : { x: p.x, y: p.y };
    const delay = !!r && !p.defl && !bench && loc(r.by.side, from).x < BLUE && r.by.on === 'ice' && this.rules.penalties;
    this.play('out', s, bench ? 'Шайба улетела в зону скамейки — остановка игры' : 'Шайба улетела за стекло — остановка игры', by ?? undefined);
    p.vx = 0; p.vy = 0; p.vh = 0; p.h = 0;
    if (delay && r) {
      if (!this.pending.some(q => q.player === r.by)) this.pending.push({ side: r.by.side, player: r.by, reason: PEN_REASON.delay, min: 2 });
      this.startStop('penalty', zoneDot(r.by.side, from.y), 1.6);
      return;
    }
    let dot: V2;
    if (s !== null && loc(s, from).x > OPP_BLUE) dot = neutralDot(s, from.y);
    else {
      const all = [FACEOFF_SPOTS.center, ...FACEOFF_SPOTS.end, ...FACEOFF_SPOTS.neutral];
      dot = all.reduce((b, q) => (dist(q, from) < dist(b, from) ? q : b), all[0]);
      dot = { x: dot.x, y: dot.y };
    }
    this.startStop('out', dot, 1.4);
  }
  private missed(shot: Shot, post: boolean) {
    if (this.puck.shot !== shot) return;
    this.puck.shot = null;
    this.out.push({ type: 'shot', side: shot.side, shooter: shot.by.id, goalie: shot.goalie?.id ?? null, outcome: 'miss', post: post || shot.post, assists: [], strength: shot.strength, shotType: shot.kind, ...this.pct(shot), xg: shot.xg, zone: shot.zone, ice: shot.ice });
    if (!post) this.play('wide', shot.side, `Мимо: ${shot.by.name}`, shot.by);
  }
  private pct(shot: Shot) { return { x: Math.round(shot.from.x / 0.6 * 10) / 10, y: Math.round(shot.from.y / 0.3 * 10) / 10 }; }
  private block(a: Sk, shot: Shot) {
    const p = this.puck;
    p.shot = null;
    const ang = this.rand() * Math.PI * 2;
    p.vx = Math.cos(ang) * 4 + p.vx * 0.1; p.vy = Math.sin(ang) * 4 + p.vy * 0.1; p.vh = 0; p.h = Math.min(p.h, 0.2); p.leg++;
    p.noTouch = a; p.noTouchUntil = this.tau + 0.25; p.last = a; p.icing = null;
    this.out.push({ type: 'shot', side: shot.side, shooter: shot.by.id, goalie: shot.goalie?.id ?? null, outcome: 'block', blocker: a.id, assists: [], strength: shot.strength, shotType: shot.kind, ...this.pct(shot), xg: shot.xg, zone: shot.zone, ice: shot.ice });
    this.play('block', a.side, `Блок-шот: ${a.name}`, a);
    // the blocker comes up with it about half the time; otherwise it bounces back out, not onto the shooter's stick
    if (a.on === 'ice' && this.rand() < 0.38 + a.def / 450) { const b = this.blade(a); p.x = b.x; p.y = b.y; p.vx = a.vx; p.vy = a.vy; this.take(a, false); return; }
    const back = Math.atan2(shot.by.y - p.y, shot.by.x - p.x) + (this.rand() - 0.5) * 2.2, v = 3 + this.rand() * 4;
    p.vx = Math.cos(back) * v; p.vy = Math.sin(back) * v; this.released(a, true);
    // off the shaft and up: it can fly out of play
    if (this.rand() < 0.07) { const sp = 7 + this.rand() * 6; p.vx = Math.cos(back + Math.PI) * sp * 0.3 + p.vx; p.vy = Math.sin(back + Math.PI) * sp * 0.3 + p.vy; p.h = 0.6; p.vh = 6 + this.rand() * 5; }
    shot.by.cool = Math.max(shot.by.cool, this.tau + 0.45); p.noTouch = shot.by; p.noTouchUntil = this.tau + 0.45;
  }
  private tip(a: Sk, shot: Shot) {
    const p = this.puck;
    p.shot = null;
    // the deflection becomes his shot
    p.carrier = a;
    this.touches.push({ id: shot.by.id, side: shot.side });
    this.shoot(a, 0.5, 0, null, 'tip');
    p.carrier = null;
  }
  private save(g: Sk, shot: Shot) {
    const p = this.puck;
    p.shot = null;
    this.shots[shot.side]++;
    this.out.push({ type: 'shot', side: shot.side, shooter: shot.by.id, goalie: g.id, outcome: 'save', assists: [], strength: shot.strength, shotType: shot.kind, ...this.pct(shot), xg: shot.xg, zone: shot.zone, ice: shot.ice });
    this.lastSave = this.tau;
    // caught (a high shot more often) or kicked out as a rebound
    const catchP = (p.h > 0.45 ? 0.55 : 0.32) * (0.75 + g.rebound / 280) * (shot.kind === 'slap' ? 0.75 : 1);
    p.x = g.x + Math.cos(g.fa) * 0.45; p.y = g.y + Math.sin(g.fa) * 0.45;
    if (this.rand() < catchP) {
      p.vx = 0; p.vy = 0; p.h = 0.6; p.vh = 0;
      this.play('freeze', g.side, `Сейв: ${g.name} ловит шайбу`, g);
      this.scrum(g);
      this.startStop('freeze', zoneDot(g.side, p.y), 1.3);
      return;
    }
    const out = loc(g.side, { x: 1, y: 0 }).x > 0 ? 0 : Math.PI; // facing out of his net
    const ang = (g.side === 0 ? 0 : Math.PI) + (this.rand() - 0.5) * 2.4;
    void out;
    const spd = 3.5 + this.rand() * 6 * (1.2 - g.rebound / 200);
    p.vx = Math.cos(ang) * spd; p.vy = Math.sin(ang) * spd; p.h = 0.1; p.vh = 0.5; p.leg++;
    p.noTouch = g; p.noTouchUntil = this.tau + 0.4; p.last = g; p.icing = null; this.released(g, true);
    // off his shoulder or the top of his glove: up into the netting or over the glass
    if (shot.kind !== 'tip' && p.vh >= 0 && this.rand() < 0.11) {
      const up = Math.atan2(p.y - MID, (g.side === 0 ? -1 : 1) * 3) + (this.rand() - 0.5) * 1.4, v = 6 + this.rand() * 6;
      p.vx = Math.cos(up) * v; p.vy = Math.sin(up) * v; p.h = 1.2; p.vh = 7 + this.rand() * 4;
      this.play('save', g.side, `Сейв: ${g.name} — шайба уходит вверх`, g);
      return;
    }
    this.play('save', g.side, `Сейв: ${g.name}`, g);
  }
  private goalieStop(g: Sk, spd: number) {
    const p = this.puck, attackers = this.skaters((1 - g.side) as Side).some(a => dist(a, g) < 3.2);
    p.x = g.x + Math.cos(g.fa) * 0.45; p.y = g.y + Math.sin(g.fa) * 0.45;
    if (spd < 9 && attackers) { p.vx = 0; p.vy = 0; p.h = 0; this.play('freeze', g.side, `${g.name} накрывает шайбу`, g); this.scrum(g); this.startStop('freeze', zoneDot(g.side, p.y), 1.2); return; }
    // he plays it to a teammate: to the corner or the nearest defenceman
    const mate = this.skaters(g.side, false).filter(a => a.kindD).sort((a, b) => dist(a, g) - dist(b, g))[0];
    const t = mate ? { x: mate.x, y: mate.y } : loc(g.side, { x: GOAL + 4, y: loc(g.side, g).y < MID ? 4 : 26 });
    const dx = t.x - p.x, dy = t.y - p.y, d = Math.hypot(dx, dy) || 1, sp = clamp(d * 0.9, 5, 14);
    p.vx = (dx / d) * sp; p.vy = (dy / d) * sp; p.h = 0; p.vh = 0; p.leg++; p.passTo = mate ?? null; p.passBy = g;
    p.noTouch = g; p.noTouchUntil = this.tau + 0.4; p.last = g; p.icing = null; this.released(g);
  }
  private goal(side: Side, at: { x: number; y: number; h: number }) {
    const p = this.puck, shot = p.shot;
    // the scorer: the shooter, else the last man of the scoring side who touched it (else the last toucher: an own goal)
    const last = shot?.by ?? (p.last && p.last.side === side ? p.last : [...this.touches].reverse().map(t => this.agents.get(t.id)).find(a => a && a.side === side) ?? p.last);
    if (!last) return;
    const kind: ShotKind = shot?.kind ?? 'rebound';
    const from = shot?.from ?? { x: last.x, y: last.y };
    const lp = loc(side, from), zone = shotZone(lp);
    const strength = shot?.strength ?? this.strength(side);
    const assists = shot?.assists ?? this.assistsFor(last);
    const g = this.goalieOf((1 - side) as Side);
    const xg = shot?.xg ?? clamp((1 - goalieSavePct(77)) * ZONE_MULT[zone], 0.006, 0.42);
    p.shot = null;
    this.shots[side]++;
    this.score[side]++;
    this.goalsFor.push({ id: last.id, side, tau: this.tau, clock: this.clock });
    const pctFrom = { x: Math.round(from.x / 0.6 * 10) / 10, y: Math.round(from.y / 0.3 * 10) / 10 };
    this.out.push({ type: 'shot', side, shooter: last.id, goalie: shot?.goalie?.id ?? g?.id ?? null, outcome: 'goal', assists, strength, shotType: kind, ...pctFrom, xg, zone, ice: shot?.ice ?? this.ice() });
    this.play('goal', side, `ГОЛ! ${last.name}`, last);
    const rel = [...this.releases].reverse().find(r => r.id === last.id);
    this.clips.push({ e: { tau: this.tau, scorer: last.id, side, kind, release: rel?.t ?? this.tau - 0.4, strength }, clip: null });
    // a power-play goal ends the earliest minor of the short-handed team; a goal during a delayed penalty waives it
    if (strength === 'PP') {
      // (a major is served in full; a goal in the first half of a double minor ends only its first two minutes)
      const boxed = [...this.agents.values()].filter(a => a.side !== side && a.on === 'box' && a.boxMin !== 5).sort((a, b) => a.boxUntil - b.boxUntil)[0];
      if (boxed) boxed.boxUntil = boxed.boxMin === 4 && boxed.boxUntil - this.clock > 120 ? this.clock + 120 : this.clock;
    }
    if (this.pending.length && this.pending[0].side !== side) {
      for (const pen of this.pending) this.out.push({ type: 'waived', side: pen.side, text: `Гол при отложенном штрафе: удаление ${pen.player.name} отменено` });
      this.pending = [];
    }
    // into the net: it flies on into the mesh
    p.x = at.x; p.y = at.y; p.h = Math.min(at.h, 1.0); p.inNet = (1 - side) as Side; p.carrier = null;
    this.startStop('goal', { x: 30, y: 15 }, 3.2);
    p.dead = false;
  }
  private netPuck() {
    const p = this.puck, s = p.inNet!;
    const back = s === 0 ? GOAL - NET_DEPTH + 0.12 : OPP_GOAL + NET_DEPTH - 0.12;
    p.vx *= 0.9; p.vy *= 0.85;
    p.x += p.vx * STEP; p.y += p.vy * STEP;
    if (s === 0 ? p.x < back : p.x > back) { p.x = back; p.vx = 0; }
    p.y = clamp(p.y, MID - POST + 0.08, MID + POST - 0.08);
    p.h = Math.max(0, p.h - STEP * 1.8);
  }

  /** Pick-ups and interceptions of a free puck (passes included). */
  private contact() {
    const p = this.puck;
    if (p.carrier || p.dead || p.shot) return;
    if (p.h > 0.5) {
      // up in the air at chest height: knocked down with the glove (onto the ice at his feet), or it flies past
      if (p.h > 1.9) return;
      for (const a of this.onIce()) {
        if (a.goalie || a.stun > 0 || a.leaving || a.gloved === p.leg || (p.noTouch === a && this.tau < p.noTouchUntil) || dist(a, p) > 0.8) continue;
        // (one try with the glove per flight; he can still play it on the ice once it lands)
        a.gloved = p.leg;
        if (this.rand() > 0.55 * this.diffOf(a)) continue;
        p.h = 0; p.vh = 0; p.vx = a.vx; p.vy = a.vy; p.saucer = false; p.passTo = null; p.leg++;
        p.x = a.x + Math.cos(a.fa) * 0.45; p.y = a.y + Math.sin(a.fa) * 0.45; p.last = a; p.icing = null; this.released(a, true);
        this.play('loose', a.side, `${a.name} сбивает шайбу рукой`, a);
        return;
      }
      return;
    }
    const sp = Math.hypot(p.vx, p.vy);
    let best: { a: Sk; d: number } | null = null;
    for (const a of this.onIce()) {
      if (a.goalie || a.stun > 0 || a.leaving || (p.noTouch === a && this.tau < p.noTouchUntil) || a.rolled === p.leg) continue;
      const reach = a === p.passTo ? 1.0 : p.passTo && a.side !== p.passTo.side ? 0.62 : 0.8;
      const d = Math.min(dist(this.blade(a), p), dist(a, p) + 0.15);
      if (d < reach && (!best || d < best.d)) best = { a, d };
    }
    if (!best) { this.reachFor(sp); return; }
    const a = best.a;
    const rel = Math.hypot(p.vx - a.vx, p.vy - a.vy);
    const intercept = p.passTo && a.side !== p.passTo.side;
    let pr = rel < 7 ? 1 : clamp(1.2 - rel / 24 + a.hands / 350, 0.15, 1);
    if (intercept) pr *= 0.55 * this.diffOf(a);
    if (p.saucer && p.h > 0.15) pr *= a === p.passTo ? 0.9 : 0.1;
    a.rolled = p.leg;
    if (this.rand() < pr) { this.take(a, !!intercept); return; }
    // off the stick or the skate
    const ang = Math.atan2(p.vy, p.vx) + (this.rand() - 0.5) * 1.2, ns = sp * 0.45;
    p.vx = Math.cos(ang) * ns; p.vy = Math.sin(ang) * ns; p.leg++; p.passTo = null;
    p.noTouch = a; p.noTouchUntil = this.tau + 0.2;
  }
  /**
   * A free puck just out of reach (a stretch beyond the blade, in front of him): the nearest skater going for it
   * lunges and pulls it in with the stick at full stretch — a short move the 3D figure acts out.
   */
  private reachFor(sp: number) {
    const p = this.puck;
    if (sp > 11 || p.h > 0.3) return;
    let best: { a: Sk; d: number } | null = null;
    for (const a of this.onIce()) {
      if (a.goalie || a.stun > 0 || a.leaving || a.act || a.cool > this.tau || (p.noTouch === a && this.tau < p.noTouchUntil)) continue;
      // a pass on its way to a teammate is left to him
      if (p.passTo && p.passTo !== a && p.passTo.side === a.side && p.passBy?.side === a.side) continue;
      const d = dist(a, p);
      if (d < 0.9 || d > REACH + 1.15) continue;
      // in front of him (a stretch to the forehand or the backhand side, not behind his back)
      if (Math.cos(angDiff(a.fa, Math.atan2(p.y - a.y, p.x - a.x))) < 0.25) continue;
      // the puck coming to him anyway: no need to stretch
      const closing = ((a.x - p.x) * (p.vx - a.vx) + (a.y - p.y) * (p.vy - a.vy)) / d;
      if (closing > 3) continue;
      // the AI stretches when the puck is in a race; the manager's man whenever it is just out of reach
      if (!a.manual && this.rand() > 0.12) continue;
      if (!best || d < best.d) best = { a, d };
    }
    if (!best) return;
    const a = best.a;
    a.act = { k: 'reach', t0: this.tau, done: false };
    a.cool = this.tau + REACH_DUR + 0.25;
  }
  private resolveReach(a: Sk) {
    const p = this.puck;
    if (p.carrier || p.dead || p.shot || p.h > 0.35 || (p.noTouch === a && this.tau < p.noTouchUntil)) return;
    const d = dist(a, p);
    if (d > REACH + 1.35 || Math.cos(angDiff(a.fa, Math.atan2(p.y - a.y, p.x - a.x))) < 0.1) return;
    const intercept = !!p.passTo && a.side !== p.passTo.side;
    const rel = Math.hypot(p.vx - a.vx, p.vy - a.vy);
    // at full stretch the puck is harder to settle: good hands, a slow puck and a short stretch help
    const pr = clamp(0.62 + a.hands / 400 - (d - 1) * 0.18 - rel / 30, 0.2, 0.92) * (intercept ? 0.7 * this.diffOf(a) : 1);
    a.rolled = p.leg;
    if (this.rand() < pr) {
      // the blade pulls it back in to the body
      p.x = a.x + (p.x - a.x) * 0.55; p.y = a.y + (p.y - a.y) * 0.55;
      this.take(a, intercept);
      this.play('takeaway', a.side, `Дотянулся до шайбы: ${a.name}`, a);
      return;
    }
    // a touch at full stretch: knocked on, a little toward him
    const dx = a.x - p.x, dy = a.y - p.y, dd = Math.hypot(dx, dy) || 1;
    p.vx = p.vx * 0.4 + (dx / dd) * 1.8; p.vy = p.vy * 0.4 + (dy / dd) * 1.8; p.leg++; p.passTo = null;
  }
  /** A takeaway: the puck goes from the carrier's blade onto the stealer's (who keeps skating with it). */
  private steal(a: Sk, from: Sk) {
    const p = this.puck;
    this.loose(a.vx, a.vy);
    const b = this.blade(a); p.x = b.x; p.y = b.y;
    p.noTouch = from; p.noTouchUntil = this.tau + 0.5;
    this.take(a, false);
  }
  private take(a: Sk, intercept: boolean) {
    const p = this.puck;
    const wasPass = p.passTo === a && p.passBy?.side === a.side;
    const prevSide = this.touches.length ? this.touches[this.touches.length - 1].side : null;
    if (prevSide !== null && prevSide !== a.side) this.touches = [];
    // a pass that was meant to reach him keeps the chain; anything else from the other side breaks it
    this.touches.push({ id: a.id, side: a.side });
    p.carrier = a; p.passTo = null; p.passBy = null; p.shot = null; p.h = 0; p.vh = 0; p.saucer = false; p.last = a;
    if (p.icing !== null && p.icing !== a.side) {
      // the defending team touched it first: hybrid icing is not called when it is played before the line
    }
    p.icing = null;
    a.lastPuck = this.tau; a.decideAt = this.tau + 0.15 + this.rand() * 0.2; a.carryT = null;
    if (intercept) this.play('interception', a.side, `Перехват: ${a.name}`, a);
    // the manager's control goes to the teammate who gets the puck
    if (this.opts.userSide === a.side) this.ctl = a.id;
    // a one-timer: the stick was loaded as the pass arrived
    if (wasPass && a.oneTimer && a.manual) { a.oneTimer = false; this.shoot(a, 0.85, 0.5, null, Math.hypot(a.x - (a.side ? GOAL : OPP_GOAL), a.y - MID) > 11 ? 'slap' : 'snap'); return; }
    if (wasPass && !a.manual && this.rand() < 0.35 && shotZone(loc(a.side, a)) !== 'perimeter' && loc(a.side, a).x > OPP_BLUE + 4 && this.laneOpen(a, { x: OPP_GOAL, y: MID }, 0.7)) {
      this.shoot(a, 0.8, 0.4, null, loc(a.side, a).x < OPP_GOAL - 12 ? 'slap' : 'snap');
    }
  }

  /** Offside (the puck enters the zone with a teammate already over the line) and zone tracking. */
  private zones() {
    const p = this.puck;
    for (const s of [0, 1] as Side[]) {
      const x = loc(s, p).x;
      if (!this.zoneIn[s] && x > OPP_BLUE + 0.15) {
        const by = p.carrier ?? p.last;
        if (this.rules.offside && by && by.side === s) {
          const over = this.skaters(s).filter(m => m !== p.carrier && loc(s, m).x > OPP_BLUE + 0.35 && !m.leaving);
          if (over.length) {
            const who = over[0];
            this.out.push({ type: 'offside', side: s });
            this.play('offside', s, `Офсайд: ${who.name}`, who);
            this.startStop('offside', neutralDot(s, p.y), 1.2);
            return;
          }
        }
        this.zoneIn[s] = true;
      } else if (this.zoneIn[s] && x < OPP_BLUE - 0.3) this.zoneIn[s] = false;
    }
  }

  /* ---------------- frames ---------------- */
  private snapshot(): Frame {
    const list = [...this.agents.values()].filter(a => a.on === 'ice' || a.on === 'box');
    const ids = list.map(a => a.id);
    const st = this.mode === 'faceoff' ? 1 : this.mode === 'stop' || this.mode === 'end' ? 2 : 0;
    // during a stoppage the next faceoff's dot (the last faceoff's is still in `fo`)
    const dot = this.mode === 'faceoff' && this.fo ? this.fo.dot : this.stopInfo.dot;
    return {
      tau: this.tau, clock: this.clock, px: this.puck.x, py: this.puck.y, ph: this.puck.h,
      carrier: this.puck.carrier ? ids.indexOf(this.puck.carrier.id) : -1, ids,
      sk: list.map(a => ({
        id: a.id, side: a.side, goalie: a.goalie, box: a.on === 'box' && !a.boxGo, x: a.x, y: a.y, fa: a.fa, ctrl: a.id === this.ctl,
        // going down takes a moment (the body tips over), getting up the last 0.35 s
        fall: a.fall > 0 ? smooth01(Math.min(1, (this.tau - a.fallAt) / 0.28)) * smooth01(Math.min(1, a.fall / 0.35)) : 0, fk: a.fallK, fs: a.fallS,
        check: a.act?.k === 'check' ? Math.sin(Math.PI * clamp((this.tau - a.act.t0) / 0.42, 0, 1)) : 0,
        poke: a.act?.k === 'poke' ? Math.sin(Math.PI * clamp((this.tau - a.act.t0) / 0.38, 0, 1)) : 0,
        deke: a.act?.k === 'deke' && (a.act.kind === 'side' || a.act.kind === 'toe') ? a.act.s * Math.sin(Math.PI * clamp((this.tau - a.act.t0) / DEKE_DUR[a.act.kind], 0, 1)) * 0.55 : 0,
        ...this.moveOf(a),
        stag: a.stagger > this.tau ? clamp((a.stagger - this.tau) / 0.45, 0, 1) : 0,
        ...this.stanceOf(a),
        hl: a.manual && this.handle && this.puck.carrier === a ? this.handle.lat : 0,
      })),
      stop: st as 0 | 1 | 2, ox: dot.x, oy: dot.y - OFFICIAL_AT, dx: dot.x, dy: dot.y,
    };
  }
  /**
   * The stance a skater shows (the manager's buttons, and the AI doing the same things): blocking — the manager's
   * block button, or a defender in the lane of a shot being wound up close by; a one-timer — the manager's stick
   * loaded, or a pass on its way to a man set up in the slot; calling for the puck; the vision stance — backing up
   * facing the play; a hustle burst. Blended in over 0.18 s.
   */
  private stanceOf(a: Sk): { st: Stance | null; stT: number } {
    let k: Stance | null = null;
    const p = this.puck, c = p.carrier;
    if (!a.goalie && a.on === 'ice' && a.stun <= 0 && !a.act) {
      const cl = c && c.side !== a.side ? loc(c.side, c) : null;
      if (this.blockBy === a || (cl && c!.act?.k === 'windup' && c!.act.what === 'shot' && dist(a, c!) < 6 && segDist(a, c!, loc(c!.side, { x: OPP_GOAL, y: MID })) < 0.9)) k = 'block';
      else if ((a.oneTimer && a.manual) || (p.passTo === a && !c && p.passBy?.side === a.side && loc(a.side, a).x > OPP_BLUE + 4 && dist(loc(a.side, a), { x: OPP_GOAL, y: MID }) < 15)) k = 'oneTimer';
      else if (a.id === this.ctl && this.tau < this.callForPass) k = 'call';
      else if (a.back && c !== a && Math.hypot(a.vx, a.vy) > 0.6) k = 'vision';
      else if (a.sprint && Math.hypot(a.vx, a.vy) > 5.5) k = 'hustle';
    }
    if (k !== (a.stK ?? null)) { a.stK = k; a.stAt = this.tau; }
    return { st: k, stT: k ? smooth01((this.tau - (a.stAt ?? 0)) / 0.18) : 0 };
  }
  /** The move a skater is acting out (a deke, a check, a stick lift) and how far into it he is, 0…1. */
  private moveOf(a: Sk): { mv: MoveKind | null; mt: number } {
    const act = a.act;
    if (act?.k === 'deke') return { mv: act.kind, mt: clamp((this.tau - act.t0) / DEKE_DUR[act.kind], 0, 1) };
    if (act?.k === 'check') return { mv: act.light ? 'push' : act.kind, mt: clamp((this.tau - act.t0) / 0.42, 0, 1) };
    if (act?.k === 'poke' && act.lift) return { mv: 'lift', mt: clamp((this.tau - act.t0) / 0.38, 0, 1) };
    if (act?.k === 'reach') return { mv: 'reach', mt: clamp((this.tau - act.t0) / REACH_DUR, 0, 1) };
    return { mv: null, mt: 0 };
  }
  private record() {
    this.frames.push(this.snapshot());
    if (this.frames.length > FRAMES_KEPT * 60 + 30 && this.frames[0].tau < this.tau - FRAMES_KEPT) {
      // cut the clips of goals before their frames are gone
      for (const c of this.clips) if (!c.clip && this.tau - c.e.tau > 2.3) c.clip = this.buildClip(c.e);
      this.frames.splice(0, 30);
    }
  }
}

/** Presentation stick (screen) → rink vector for the camera of the 3D match (the 2D rink is a top view: no change). */
export function screenToRink(sx: number, sy: number, camera: string, puckX: number, attack: 1 | -1 = 1): { x: number; y: number } {
  // the cameras turned along the rink: 'end' behind the net of the zone the puck is in, 'vertical' behind the
  // manager's own end looking the way he attacks; looking toward +x, screen up is +x and screen right is +y
  const toward = camera === 'end' ? (puckX >= 50 ? -1 : 1) : camera === 'vertical' ? attack : 0;
  if (!toward) return { x: sx, y: sy };
  return toward > 0 ? { x: -sy, y: sx } : { x: sy, y: -sx };
}

export type { GameEvent };
