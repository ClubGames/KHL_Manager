import type { GameEvent, Lineup, Player, ShotZone, Strength, Team } from '../types';
import type { FoulMove, Key, LiveFrame, ReplayClip, Track } from './rinkPlayback';
import { FOUL_MOVE_DUR, foulMove } from './rinkPlayback';
import { steer } from './skating';
import type { RinkPlay, PlayKind } from './rinkAI';
import { BOARDS_H, FACEOFF_SPOTS, RINK, glassTop, inBenchFront } from './rinkGeometry';
import { goalieSavePct } from './ratings';
import { boardsSide, foPlaces, foSpot, type FoPlace } from './faceoffFormation';
import { EJECT_END, ejects, penLength, SHORT_MIN, type PenaltyCall, type PenKind } from './penalties';
import { soNext, soShooter, soTally, type SoAttempt } from './shootout';

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
  push?: boolean;
  /**
   * R3: with the puck a kick (off the skate ahead onto his own stick; a pass coming to him is taken on the skate), on
   * defence a hip check, after a goal of his team fist pumps (on their own or on top of riding the stick / the knee)
   */
  r3?: boolean;
  /** a fight (its own key / touch button; the pad: Y twice quickly) — at a stoppage or in play, with the nearest opponent */
  fight?: boolean;
  /** B (○) and X (□) on the pad (their own keys / touch buttons elsewhere): the goal celebrations 2 and 3 */
  o?: boolean; sq?: boolean;
  /**
   * The deke the touch button was swiped for (up a spin-o-rama, down between the legs, to a side a toe drag that way;
   * a plain tap leaves it unset — the usual deke); read on the deke press with the puck.
   */
  dekeKind?: DekeKind;
  /** the side of that deke as the picture shows it: 1 — his right, -1 — his left (unset: the stick / the defender decide) */
  dekeSide?: 1 | -1 }
export const NO_PAD: PadState = { mx: 0, my: 0, sprint: false, shoot: false, pass: false, deke: false, swap: false };
/** The kinds of dekes and body checks (the 3D figures act them out). */
export type DekeKind = 'side' | 'toe' | 'between' | 'spin' | 'fake';
export type CheckKind = 'shoulder' | 'hip' | 'pin';
/** The clock while short-handed (see PlayOpts.penaltyClock). */
export type PenaltyClock = 'period' | 'real' | 2 | 4;
/** The goal celebrations the manager picks (✕ ○ □ △, L2 riding the stick, R2 down on one knee, R3 fist pumps — also on the stick / the knee). */
export type CelebKind = 'cel1' | 'cel2' | 'cel3' | 'cel4' | 'celStick' | 'celKnee' | 'celPump' | 'celStickPump' | 'celKneePump';
/** The moves the 3D figures act out: dekes, checks, a stick lift, a stretch, a push, the fouls; a kick of the puck, a dive
 *  to block, a fight; the goalie's freeze (the puck caught in the glove / covered under him); the goal celebrations. */
export type MoveKind = DekeKind | CheckKind | 'lift' | 'reach' | 'push' | FoulMove | 'kick' | 'dive' | 'fight' | 'glove' | 'cover' | CelebKind;
/**
 * A held stance the 3D figure shows: down to block a shot, the stick cocked for a one-timer, tapping the stick for
 * a pass, the defensive «vision» stance (skating backwards facing the puck, stick out in front), a hustle burst.
 */
export type Stance = 'block' | 'oneTimer' | 'call' | 'vision' | 'hustle' | 'protect' | 'board' | 'sweep';
/** How a skater goes down: knocked over backwards, face first (hit from behind, a whiffed check), over the hip sideways. */
export type FallKind = 'back' | 'front' | 'side';
/** A stretch for a puck just out of reach: the stick shot out one-handed (seconds). */
const REACH_DUR = 0.36;
const DEKE_DUR: Record<DekeKind, number> = { side: 0.45, toe: 0.55, between: 0.6, spin: 0.65, fake: 0.5 };
export const FORECHECK_NAME = ['пассивный 1-2-2', 'сбалансированный', 'агрессивный 2-1-2'];
export const BREAKOUT_NAME = ['стандартный выход', 'длинный пас (stretch)', 'надёжный выход'];
const DEKE_NAME: Record<DekeKind, string> = { side: 'финт', toe: 'протяжка', between: 'между ног', spin: 'вертушка', fake: 'ложный замах' };
export const CELEB_NAME: Record<CelebKind, string> = { cel1: 'руки вверх', cel2: 'лук и стрела', cel3: 'палец в небо', cel4: 'слышу трибуны', celStick: 'верхом на клюшке', celKnee: 'на одном колене', celPump: 'кулак', celStickPump: 'на клюшке с кулаком', celKneePump: 'на колене с кулаком' };

export interface PlayRules { offside: boolean; icing: boolean; penalties: boolean }
export interface PlayRinkOptions {
  home: Team; away: Team; players: Record<string, Player>; lineups: [Lineup, Lineup];
  /** the manager's side (null: both benches are AI — tests, finishing a period in the background) */
  userSide: Side | null;
  /** two humans (online): the sides of seat 0 and seat 1 (overrides userSide); step / advance take a pad per seat */
  humans?: Side[];
  /** a period, an overtime (3 on 3 / 5 on 5) — or a shootout ('so': the series, attempt after attempt, see `so`) */
  kind: 'reg' | 'ot3' | 'ot5' | 'so';
  /** the shootout: each side's shooters in order (the first `rounds` different men), the side shooting first, rounds */
  so?: { order: [string[], string[]]; first?: Side; rounds?: number };
  /** the teams have switched ends: presentation is mirrored lengthwise */
  flip?: boolean;
  /** real minutes a 20-minute period takes (the clock runs 20 / periodMinutes times faster) */
  periodMinutes?: number;
  /**
   * How fast the clock runs while one side is short-handed (power play / penalty kill): 'period' — like the rest of
   * the period (a 2-minute minor lasts 2 × periodMinutes / 20 real minutes), 'real' — real time (the whole 2 minutes
   * are played), 2 / 4 — real time ×2 / ×4. Never slower than real time, never faster than the period's clock.
   */
  penaltyClock?: PenaltyClock;
  difficulty?: Difficulty;
  rules?: Partial<PlayRules>;
  goalies?: [string | null, string | null];
  /** penalties carried over from the previous period: [player, end] with `end` in seconds of this block's clock */
  box?: [[string, number, boolean?][], [string, number, boolean?][]];
  /** score before this block [home, away] (late-game decisions: pulling the goalie) */
  score?: [number, number];
  /** period number (1…3 regulation, 4+ overtime) */
  period?: number;
  seed?: number;
  /** on defence the control moves by itself to the man nearest the puck when the controlled one is out of the play */
  autoSwitch?: boolean;
  /** each team's timeout still to take this match (one per game; default both) */
  timeouts?: [boolean, boolean];
}

/** A timeout: 30 seconds, both teams at their benches. */
export const TIMEOUT_SEC = 30;

/** What happened on the ice, for the books (GameSim.recordPlayed) and the match screen. */
export type PlayOut =
  | { type: 'shot'; side: Side; shooter: string; goalie: string | null; outcome: 'goal' | 'save' | 'miss' | 'block'; post?: boolean; blocker?: string; assists: string[]; strength: Strength; shotType: ShotKind; x: number; y: number; xg: number; zone: ShotZone; ice: [(string | null)[], (string | null)[]] }
  | { type: 'penalty'; side: Side; player: string; /** the minutes his team plays short (a misconduct: its 10, a ДдКМ 20) */ min: number; reason: string; /** a coincidental major (a fight): the team is not short-handed */ coin?: boolean;
      /** the KHL kind and what comes with it (10 minutes, the automatic ДдКМ of a major) */ kind?: PenKind; plus?: PenaltyCall['plus'] }
  /** a penalty shot taken (the foul on a breakaway): its result */
  | { type: 'penaltyShot'; side: Side; shooter: string; goalie: string | null; goal: boolean; fouler?: string; reason: string }
  /** a shootout attempt (kind 'so'): its result and the series after it */
  | { type: 'soAttempt'; side: Side; shooter: string; goalie: string | null; goal: boolean; round: number; so: [number, number] }
  | { type: 'hit'; side: Side; player: string; victim: string }
  | { type: 'faceoff'; side: Side; player: string }
  | { type: 'icing' | 'offside'; side: Side }
  | { type: 'waived'; side: Side; text: string }
  | { type: 'timeout'; side: Side }
  | { type: 'end' };

/** A release as the 3D view animates it (shared with replayMotion's Release shape, plus the side). */
export type PlayRelease = { id: string; side: Side; t: number; kind: ReleaseKind; windup: number; follow: number; tx: number; tz: number };

const L = 60, W = 30, MID = 15;
const GOAL = RINK.goalLine, OPP_GOAL = L - RINK.goalLine, BLUE = RINK.blueLine, OPP_BLUE = L - RINK.blueLine, RED = 30;
const POST = RINK.goalWidth / 2, BAR = RINK.goalHeight;
const BENCH: [V2, V2] = [{ x: 24, y: 0.9 }, { x: 36, y: 0.9 }];
/** Seconds a man takes to get onto the ice: over the boards on the fly, through the bench door at a whistle. */
export const HOP_FLY = 0.85, HOP_DOOR = 1.15;
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
/** Calibration of the goal chance of a shot on target (AI against AI: a save % of about .910, as in the KHL — the AI
 *  takes its real chances, so the shots on net are better ones on average). */
const GOAL_CAL = 0.62;
/** a penalty shot / shootout attempt against the goalie's chances of a shot from the same spot in play (calibrated) */
const PS_CAL = 5.0;
/** The calls of the played match, in the wording of the KHL (and of the text simulation's list). */
const PEN_REASON = {
  trip: 'подножка', hook: 'задержка клюшкой', interference: 'атака игрока, не владеющего шайбой', charge: 'атака с разбега', board: 'толчок на борт', slash: 'удар клюшкой',
  hold: 'задержка соперника', high: 'игра высоко поднятой клюшкой', goalie: 'помеха вратарю', elbow: 'удар локтем', head: 'атака в голову или шею', behind: 'атака сзади',
  knee: 'удар коленом', rough: 'грубость', bench: 'нарушение численного состава', delay: 'выброс шайбы за пределы площадки',
  fight: 'драка', dive: 'симуляция', unsport: 'неспортивное поведение',
} as const;

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const dist = (a: V2, b: V2) => Math.hypot(a.x - b.x, a.y - b.y);
/** The skill stick's charge: a slap / snap shot loads to full power in about a third of a second. */
const stickPower = (held: number) => clamp(0.6 + held * 1.15, 0.6, 1);
/** A one-timer swung through at most this long before the pass arrives still meets the puck (s): the timing window. */
const ONE_TIMER_WINDOW = 0.45;
/** The shot button's charge: held longer, harder (full in a little under half a second). */
const buttonPower = (held: number) => clamp(0.25 + held / 0.6, 0.25, 1);
const smooth01 = (v: number) => { const t = clamp(v, 0, 1); return t * t * (3 - 2 * t); };
/** The official who drops the puck stands this far from the dot, across the rink on its far side (m): his hand is over the dot. */
const OFFICIAL_AT = 0.75;
/** The longest the players take to skate to their faceoff places after a whistle (s). */
const FO_GATHER_MAX = 11;
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
/** Within m of the boards. */
const nearBoards = (p: V2, m: number) => { const c = inside(p, m); return c.x !== p.x || c.y !== p.y; };
/** How long a goal celebration the manager picked lasts (s). */
const CELEB_DUR = 2.8;
/** A fight: from the gloves dropped to the linesmen stepping in (s). */
const FIGHT_DUR = 5.2;
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
  | { k: 'deke'; t0: number; s: 1 | -1; kind: DekeKind }
  /** the puck kicked off the skate (ahead onto his own stick, or a pass taken on the skate) */
  | { k: 'kick'; t0: number }
  /** a stick sweep (R1 held on defence): the blade swept along the ice side to side, `at` the next sweep through */
  | { k: 'sweep'; t0: number; at: number };

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
  /**
   * The manager's one-timer: the windup began at `otAt` (the stick pulled back or the shot button pressed while the
   * pass was on its way), by which control; `otFire` when it was swung through (or the button let go) — the shot then
   * goes off the pass the moment it arrives, if that is soon enough; `otHold`: the pass arrived with the stick still back,
   * the puck sits on the blade for the slap shot.
   */
  otAt?: number; otBy?: 'stick' | 'button'; otFire?: number; otHold?: boolean;
  /** the infraction he just committed, acted out (a high stick, a trip, an elbow…) from `t0` */
  foulMv?: { kind: FoulMove; t0: number };
  /** the last moment he had the puck on his stick (carried, shot or passed): a hit within the grace after it is no interference */
  ownAt: number;
  /** stepping onto the ice (over the boards / through the bench door) until this moment: he stands at the boards, the AI waits */
  hopTo?: number;
  /** a fall: how, which way (side falls: ±1), when it began */
  fallK: FallKind; fallS: 1 | -1; fallAt: number;
  /** the manager's man protecting the puck (✕ held): his body between the puck and the nearest checker */
  protect?: boolean;
  /** board play (△ held with the puck along the boards): the puck pinned in his skates against the boards */
  boardPlay?: boolean;
  /** vision control with the puck (L2 held): the facing he keeps while he skates any way */
  keepFa?: number;
  /** R3 as a pass comes: he takes it on the skate (until this moment) */
  kickRecv?: number;
  /** laid out in a dive to block (L1 + R1) until this moment: a wide body on the ice */
  diveUntil?: number;
  /** the next pass of the stick swept across the ice in front of him while he is laid out in a dive */
  diveSweepAt?: number; diveSweepDir?: 1 | -1;
  /** serving a coincidental major (a fight): his team plays at full strength meanwhile, back to the bench after it */
  coin?: boolean;
  /** out of the match (ДдКМ, a match penalty): to the dressing room, never back on the ice */
  ejected?: boolean;
  /** a 10-minute misconduct after his minor (2+10): he stays in the box until this clock, his team at full strength */
  miscUntil?: number;
  /** the way his next stick sweep goes (±1: it swings back and forth) */
  sweepDir?: number;
}
interface Shot { by: Sk; side: Side; t0: number; outcome: 'goal' | 'save' | 'miss'; kind: ShotKind; from: V2; xg: number; zone: ShotZone; goalie: Sk | null; strength: Strength; ice: [(string | null)[], (string | null)[]]; assists: string[]; post: boolean }
interface Puck {
  x: number; y: number; h: number; vx: number; vy: number; vh: number;
  carrier: Sk | null; last: Sk | null; noTouch: Sk | null; noTouchUntil: number;
  shot: Shot | null; passTo: Sk | null; passBy: Sk | null; icing: Side | null; dead: boolean; inNet: Side | null; leg: number; saucer: boolean;
  /** who sent it on its way last and from where (the rules on a puck out of play); `defl`: it has hit something since */
  rel?: { by: Sk; x: number; y: number }; defl?: boolean;
  /**
   * Hybrid icing (KHL rule 65) while `icing` is pending: where across the rink it was played (the faceoff dot follows
   * it), whether it has crossed the goal line and when, and the linesman's call once the race is decided (true: the
   * defender would have been first — icing as soon as the puck is over the line)
   */
  icingY?: number; icingCrossed?: boolean; icingT?: number; icingCall?: boolean;
}
interface Pending { side: Side; player: Sk; reason: string; min: 2 | 4 | 5; /** the KHL kind (default from min: a minor, a double minor, a major with its ДдКМ) */ kind?: PenKind; plus?: PenaltyCall['plus'];
  /** a foul from behind on a clean breakaway: the man fouled takes a penalty shot instead of a power play */ ps?: Sk }
/** One simulation step as recorded (and, online, streamed to the guest). */
export type RinkFrame = Frame;
interface Frame { tau: number; clock: number; px: number; py: number; ph: number; carrier: number; ids: string[]; sk: { id: string; side: Side; goalie: boolean; box: boolean; x: number; y: number; fa: number; ctrl: boolean; fall: number; fk: FallKind; fs: 1 | -1; check: number; poke: number; deke: number; mv: MoveKind | null; mt: number; stag: number; st: Stance | null; stT: number; hl: number; /** seconds left of stepping onto the ice */ hop: number }[]; stop: 0 | 1 | 2; ox: number; oy: number; dx: number; dy: number }

/** The HUD of one seat (see PlayRink.hud). */
export type PlayHud = { ctl: string | null; power: number; context: 'carry' | 'support' | 'defend' | 'celebrate' | 'stop'; labels: { shoot: string; pass: string; deke: string }; energy: number; faceoff: boolean; foCue: 'ready' | 'now' | null; foCall: string | null; move: string | null };
export type AimMark = { x: number; y: number; z: number; charge: number };
export type GoalClipKey = { tau: number; scorer: string; side: Side; kind: ShotKind; release: number; strength: Strength };
/**
 * Online: what the host's rink sends the guest's copy (PlayRink.netTick → PlayRink.ingest) — the frames, plays,
 * releases and goals since the last tick, the windups in progress, and the state its HUD shows.
 */
export interface RinkTick {
  frames: Frame[]; plays: RinkPlay[]; releases: PlayRelease[]; clips: GoalClipKey[];
  wind: [string, 'shot' | 'pass', number][];
  tau: number; clock: number; mode: PlayRink['mode']; score: [number, number]; shots: [number, number]; pulled: [boolean, boolean];
  men: [number, number]; boxed: [{ id: string; left: number }[], { id: string; left: number }[]]; delayed: Side | null;
  hud: PlayHud; aim: AimMark | null;
  /** the timeout under way, and the timeouts each team still has */
  to?: { side: Side; left: number } | null; tol?: [boolean, boolean];
  /** the units on the ice in words (lineOn) */
  lines?: [string, string];
}

/** One human at the controls (see PlayRink.seats). */
interface Seat {
  side: Side;
  ctl: string | null;
  prevPad: PadState;
  pressAt: { shoot: number; pass: number };
  /** skill-stick gesture state: when it was pulled back (-1: not), when it was last at rest, the last sideways flick, the turn swept */
  ss: { back: number; loadEnd: number; rest: number; ang: number; sweep: number; sweepAt: number; wasOut: boolean; ot: boolean; otEnd: number; still: number; backSweep: number; handSide: 0 | 1 | -1; sideAt: number; pend: null | { at: number; f: number; l: number; s: 1 | -1; sweep: number; drag: boolean } };
  /** the skill stick held out with the puck: where the blade carries it (lateral −1…1 to the left of his facing, forward −1…1) */
  handle: { lat: number; fwd: number } | null;
  /** online: the human is in his menu — the match goes on, his team plays itself until he is back */
  away?: boolean;
  /** the last quick side-to-side of the stickhandling (a man reaching in has a harder time) */
  handleSwing: number;
  /** where he aims: the mouse cursor on the ice (null: the skating stick decides) */
  aimPt: V2 | null;
  aimVec: V2;
  lastDekeAt: number;
  /** L3 hustle latched on (until the stick is let go or L3 is pressed again) */
  hustleOn: boolean;
  /** his man in the shot-block stance this step (LB on defence) */
  blockBy: Sk | null;
  /** RT held with the puck (NHL scheme): the right stick only stickhandles, quicker */
  handleFast: boolean;
  callForPass: number;
  autoAt: number;
  /** how he timed the last draw (the HUD shows it for a moment) */
  foCall: { text: string; until: number } | null;
  /** his press for the current draw (-1: none yet) and whether it was the faceoff button */
  foPress: number;
  foBtn: boolean;
  /** when L2, R1 were last pressed (a tap or a hold), the last △ (twice quickly: a fight), the left stick last at rest
   *  (a flick of it with L1 held: a one-touch deke), R1 + the right stick already used for a dump-in / flip */
  ltAt: number; rbAt: number; pinTapAt: number; lRest: number; rbFlick: boolean;
  /** the facing L2 holds with the puck (undefined: not held) */
  faHold?: number;
}
/** The presses of one step (a button down now, up the step before). */
interface Press { shoot: boolean; pass: boolean; deke: boolean; swap: boolean; faceoff: boolean; poke: boolean; lift: boolean; pin: boolean; hustle: boolean; push: boolean;
  r3: boolean; fight: boolean; o: boolean; sq: boolean; lb: boolean; vision: boolean }
interface Release { shoot: boolean; pass: boolean; vision: boolean; poke: boolean }
function newSeat(side: Side): Seat {
  return { side, ctl: null, prevPad: NO_PAD, pressAt: { shoot: -1, pass: -1 },
    ss: { back: -1, loadEnd: -1, rest: 0, ang: 0, sweep: 0, sweepAt: 0, wasOut: false, ot: false, otEnd: -1, still: 0, backSweep: 0, handSide: 0, sideAt: -9, pend: null },
    handle: null, handleSwing: -9, aimPt: null, aimVec: { x: 0, y: 0 }, lastDekeAt: -9, hustleOn: false, blockBy: null, handleFast: false, callForPass: 0, autoAt: 0, foCall: null, foPress: -1, foBtn: false,
    ltAt: -9, rbAt: -9, pinTapAt: -9, lRest: 0, rbFlick: false };
}

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
  mode: 'stop' | 'faceoff' | 'play' | 'end' | 'timeout' = 'stop';
  /** each team's timeout still to take (one per match; see callTimeout) */
  timeoutLeft: [boolean, boolean] = [true, true];
  /** a timeout called in play, taken at the next whistle */
  private toPending: Side | null = null;
  private toInfo: { side: Side; dot: V2; icingSide: Side | null; until: number; t0: number } | null = null;
  score: [number, number];
  readonly shots: [number, number] = [0, 0];
  readonly hits: [number, number] = [0, 0];
  readonly faceoffWins: [number, number] = [0, 0];
  readonly goalsFor: { id: string; side: Side; tau: number; clock: number }[] = [];
  /** the skater the manager controls (the current seat's: see `z`) */
  get ctl(): string | null { return this.z.ctl; }
  set ctl(v: string | null) { this.z.ctl = v; }
  /** set by the 3D view: a screen point → rink percent (the mouse aims with it) */
  screenPick: ((cx: number, cy: number) => { x: number; y: number } | null) | null = null;
  /** goalie pulled for an extra attacker (the manager's choice for his side, the AI's for the other) */
  readonly pulled: [boolean, boolean] = [false, false];
  private agents = new Map<string, Sk>();
  private rand: () => number;
  private puck: Puck = { x: 30, y: 15, h: 0, vx: 0, vy: 0, vh: 0, carrier: null, last: null, noTouch: null, noTouchUntil: 0, shot: null, passTo: null, passBy: null, icing: null, dead: true, inNet: null, leg: 0, saucer: false };
  private stopInfo: { reason: 'start' | 'goal' | 'freeze' | 'icing' | 'offside' | 'penalty' | 'out' | 'end' | 'so'; dot: V2; until: number; icingSide: Side | null } = { reason: 'start', dot: { x: 30, y: 15 }, until: 0.6, icingSide: null };
  /** the faceoff: `gather` while the players skate to their places (spots by id), then the official sets, winds up and throws the puck down
   *  (`drop`: the moment it leaves his hand), and the centres battle for it for a moment (`decide`) */
  private fo: { dot: V2; setAt: number; drop: number; done: boolean; gather: boolean; until: number; spots: Map<string, V2>; decide: number } | null = null;
  private get foCall() { return this.z.foCall; }
  private set foCall(v: { text: string; until: number } | null) { this.z.foCall = v; }
  private pending: Pending[] = [];
  /** the goalie's freeze: the puck caught in his glove or covered under him until the faceoff */
  private held: { g: Sk; kind: 'glove' | 'cover'; t0: number } | null = null;
  /** a fight under way (at a stoppage): the two of them, since when, who wins it, the loser already down */
  private fightOn: { a: Sk; b: Sk; t0: number; win: Sk; down: boolean } | null = null;
  /** a penalty shot (a breakaway fouled from behind): awarded at the whistle, taken alone against the goalie */
  private ps: { shooter: Sk; side: Side; fouler: Sk | null; reason: string; live: boolean; t0: number; goals: number; shotSeen: boolean; round?: number } | null = null;
  /** A penalty shot is being taken (the match screen may show it; the clock is stopped). */
  get penaltyShot(): { shooter: string; side: Side } | null { return this.ps?.live ? { shooter: this.ps.shooter.id, side: this.ps.side } : null; }
  /** The shootout (kind 'so'): the attempts so far. */
  readonly soAttempts: SoAttempt[] = [];
  /** The shootout: the series score, the next shooter (null: decided) and whether an attempt is under way. */
  get shootout(): { so: [number, number]; next: { side: Side; round: number; shooter: string | null } | null; live: { side: Side; shooter: string; round: number } | null } | null {
    if (this.opts.kind !== 'so') return null;
    const next = this.ps && !this.ps.live ? { side: this.ps.side, round: this.ps.round ?? 1, shooter: this.ps.shooter.id } : null;
    const live = this.ps?.live ? { side: this.ps.side, shooter: this.ps.shooter.id, round: this.ps.round ?? 1 } : null;
    return { so: soTally(this.soAttempts), next, live };
  }
  /** the goal celebration the scorer's manager picked */
  private celeb: { id: string; kind: CelebKind; t0: number } | null = null;
  private zoneIn: [boolean, boolean] = [false, false];
  private touches: { id: string; side: Side }[] = [];
  private lastSave = -9;
  /** a man jumped on before the one he replaces got to the bench (too many men while both are out there) */
  private early: [{ id: string; leaver: Sk } | null, { id: string; leaver: Sk } | null] = [null, null];
  /**
   * The humans at the controls, each with his own skater and input state (a seat): one in a match against the AI,
   * two in an online match. The code that reads a seat's state (`ctl`, `ss`, `handle`, …) reads the current one,
   * `z`; step() makes each seat current in turn for its controls, the rest of the rink asks seatFor / seatOf.
   */
  private seat0: Seat = newSeat(0);
  private twin: Seat[] | null = null;
  private z: Seat = this.seat0;
  /** (the tests reset the current seat's last pad through these) */
  protected get prevPad() { return this.z.prevPad; }
  protected set prevPad(v: PadState) { this.z.prevPad = v; }
  protected get pressAt() { return this.z.pressAt; }
  private lineIdx: [number, number] = [0, 0];
  private get ss() { return this.z.ss; }
  private set ss(v: Seat['ss']) { this.z.ss = v; }
  private get handle() { return this.z.handle; }
  private set handle(v: { lat: number; fwd: number } | null) { this.z.handle = v; }
  private get handleSwing() { return this.z.handleSwing; }
  private set handleSwing(v: number) { this.z.handleSwing = v; }
  private get aimPt() { return this.z.aimPt; }
  private set aimPt(v: V2 | null) { this.z.aimPt = v; }
  private get aimVec() { return this.z.aimVec; }
  private set aimVec(v: V2) { this.z.aimVec = v; }
  private get lastDekeAt() { return this.z.lastDekeAt; }
  private set lastDekeAt(v: number) { this.z.lastDekeAt = v; }
  private get hustleOn() { return this.z.hustleOn; }
  private set hustleOn(v: boolean) { this.z.hustleOn = v; }
  private get blockBy() { return this.z.blockBy; }
  private set blockBy(v: Sk | null) { this.z.blockBy = v; }
  private get handleFast() { return this.z.handleFast; }
  private set handleFast(v: boolean) { this.z.handleFast = v; }
  /** The seats in play now (none: both benches are the AI's). */
  private seats(): Seat[] {
    if (this.opts.humans?.length) {
      if (!this.twin || this.twin.length !== this.opts.humans.length) { this.twin = this.opts.humans.map((side, i) => (i === 0 ? Object.assign(this.seat0, { side }) : newSeat(side))); }
      return this.twin;
    }
    if (this.opts.userSide === null) return [];
    this.seat0.side = this.opts.userSide;
    return [this.seat0];
  }
  /** The human playing side s (undefined: the AI's bench). */
  private seatFor(s: Side): Seat | undefined { return this.seats().find(z => z.side === s); }
  /** The human skating `a` right now. */
  private seatOf(a: Sk | null | undefined): Seat | undefined { return a ? this.seats().find(z => z.ctl === a.id && z.side === a.side) : undefined; }
  private human(s: Side): boolean { return !!this.seatFor(s); }
  /** Runs `f` with seat `z` current. */
  private as<T>(z: Seat, f: () => T): T { const o = this.z; this.z = z; try { return f(); } finally { this.z = o; } }
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
  private get callForPass() { return this.z.callForPass; }
  private set callForPass(v: number) { this.z.callForPass = v; }
  private get autoAt() { return this.z.autoAt; }
  private set autoAt(v: number) { this.z.autoAt = v; }
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
      for (const [id, end, coin] of opts.box?.[s] ?? []) {
        const a = this.agents.get(id);
        if (!a || a.goalie || end <= 0) continue;
        // ejected earlier in the match (the books give him an end no match reaches): he is not here at all
        if (end > EJECT_END / 10) { a.ejected = true; a.on = 'bench'; continue; }
        a.on = 'box'; a.boxUntil = end; a.coin = !!coin; const seat = this.boxSeat(a); a.x = seat.x; a.y = seat.y;
      }
    }
    if (opts.timeouts) this.timeoutLeft = [opts.timeouts[0], opts.timeouts[1]];
    if (opts.kind === 'so') {
      // the shootout: no rules to whistle, everybody at the benches, the goalies in their nets, the first shooter up
      this.rules = { offside: false, icing: false, penalties: false };
      this.len = 1e9;
      this.soQueue();
      this.startStop('so', { x: 30, y: 15 }, 1.6);
      return;
    }
    for (const s of [0, 1] as Side[]) this.setUnit(s, true, false);
    // lined up for the opening faceoff from the first frame (nobody is seen jumping from the bench to his place)
    this.setupFaceoff({ x: 30, y: 15 }, null, false);
    this.startStop('start', { x: 30, y: 15 }, 0.4);
  }
  /** The shootout: the next attempt is set up (or, the series decided, nothing — the stop under way ends the block). */
  private soQueue() {
    const so = this.opts.so, next = soNext(this.soAttempts, so?.first ?? 0, so?.rounds ?? 3);
    if (!next || next.round > 200) { this.ps = null; return; }
    const order = so?.order[next.side] ?? [];
    const valid = order.filter(id => { const a = this.agents.get(id); return a && !a.goalie && !a.ejected; });
    const id = soShooter(valid.length ? valid : [...this.agents.values()].filter(a => a.side === next.side && !a.goalie).map(a => a.id), next.round);
    const sh = id ? this.agents.get(id) : undefined;
    if (!sh) { this.soAttempts.push({ side: next.side, shooter: '', goalie: null, goal: false, round: next.round }); this.soQueue(); return; }
    this.ps = { shooter: sh, side: next.side, fouler: null, reason: 'буллит', live: false, t0: this.tau, goals: this.goalsFor.length, shotSeen: false, round: next.round };
  }

  /* ---------------- public API ---------------- */
  get flipped() { return !!this.opts.flip; }
  /** the automatic switch to the carrier / the defender, turned on or off mid-period (a control preference) */
  setAutoSwitch(on: boolean) { this.opts.autoSwitch = on; }
  /** The way the manager's team attacks in presentation terms (+1: toward +x); undefined without a manager. */
  get attack(): 1 | -1 | undefined { const s = this.seats()[0]?.side ?? null; return s === null ? undefined : (s === 0) !== this.flipped ? 1 : -1; }
  /** The interactive rink is simulated as it is played: nothing to compute ahead. */
  ensure(_tau: number) { /* frames are produced by step() */ }
  get ended() { return this.mode === 'end'; }
  get lastTau() { return this.frames.length ? this.frames[this.frames.length - 1].tau : 0; }
  /** Events since the last call. */
  drain(): PlayOut[] {
    const o = this.out; this.out = [];
    // a shootout's shots are not the game's (no shots on goal, no saves in the books): its attempts go as 'soAttempt'
    return this.opts.kind === 'so' ? o.filter(x => x.type !== 'shot') : o;
  }
  /** Advances real time by `dt` seconds (fixed internal steps of 1/60 s) with the manager's controls. */
  advance(dt: number, pad: PadState | readonly PadState[] | (() => readonly PadState[]) = NO_PAD) {
    if (this.mirror) return;
    this.stepAcc = Math.min(this.stepAcc + dt, 0.25);
    while (this.stepAcc >= STEP - 1e-9) { this.stepAcc -= STEP; this.step(typeof pad === 'function' ? pad() : pad); }
  }

  /* ---------------- online ---------------- */
  /** The guest's copy of the host's rink: frames are streamed in (ingest), nothing is simulated here. */
  mirror = false;
  private remote: Pick<RinkTick, 'hud' | 'aim' | 'men' | 'boxed' | 'delayed' | 'to' | 'lines'> | null = null;
  /** how far the host's ticks have got: the last frame sent, and plays / releases / goals by running count */
  private sent = { tau: -1, plays: 0, releases: 0, clips: 0 };
  private playN = 0;
  private releaseN = 0;
  /** Every skater and goalie of both teams (the guest's copy must know the same people). */
  agentIds(): string[] { return [...this.agents.keys()]; }
  /** A copy for the online guest: built from the same options, its own opening frames dropped (the host's come). */
  static mirrorOf(opts: PlayRinkOptions): PlayRink {
    const k = new PlayRink(opts);
    k.mirror = true; k.frames.length = 0; k.plays.length = 0; k.releases.length = 0; k.clips.length = 0;
    return k;
  }
  /**
   * The host: everything new since the last call for the guest whose seat is `seat` (null when no new frame is due:
   * the frames go at `hz` per second, the guest's picture interpolates between them).
   */
  netTick(seat: number, hz = 30): RinkTick | null {
    const gap = 1 / hz - 1e-6, frames: Frame[] = [];
    let last = this.sent.tau;
    // every 1/hz s (the end of the period flushes the rest with a high hz)
    for (const f of this.frames) if (f.tau > last + gap) { frames.push(f); last = f.tau; }
    if (!frames.length) return null;
    this.sent.tau = last;
    const fromEnd = <T>(list: T[], total: number, sentN: number) => (total - sentN > 0 ? list.slice(Math.max(0, list.length - (total - sentN))) : []);
    const plays = fromEnd(this.plays, this.playN, this.sent.plays), releases = fromEnd(this.releases, this.releaseN, this.sent.releases);
    const clips = this.clips.slice(this.sent.clips).map(c => c.e);
    this.sent.plays = this.playN; this.sent.releases = this.releaseN; this.sent.clips = this.clips.length;
    const wind: RinkTick['wind'] = [];
    for (const a of this.agents.values()) if (a.act?.k === 'windup' && a.on === 'ice') wind.push([a.id, a.act.what, a.act.t0]);
    return {
      frames, plays, releases, clips, wind, tau: this.tau, clock: this.clock, mode: this.mode, score: [this.score[0], this.score[1]], shots: [this.shots[0], this.shots[1]],
      pulled: [this.pulled[0], this.pulled[1]], men: this.men(), boxed: this.boxed(), delayed: this.delayed, hud: this.hud(seat), aim: this.aimMarker(seat),
      to: this.timeoutNow(), tol: [this.timeoutLeft[0], this.timeoutLeft[1]], lines: [this.lineOn(0), this.lineOn(1)],
    };
  }
  /** The guest: the host's tick into this copy. */
  ingest(t: RinkTick) {
    for (const f of t.frames) if (!this.frames.length || f.tau > this.frames[this.frames.length - 1].tau) this.keep(f);
    for (const p of t.plays) this.plays.push(p);
    if (this.plays.length > 200) this.plays.splice(0, this.plays.length - 150);
    for (const r of t.releases) this.releases.push(r);
    for (const e of t.clips) this.clips.push({ e, clip: null });
    this.tau = t.tau; this.clock = t.clock; this.mode = t.mode;
    this.score[0] = t.score[0]; this.score[1] = t.score[1]; this.shots[0] = t.shots[0]; this.shots[1] = t.shots[1];
    this.pulled[0] = t.pulled[0]; this.pulled[1] = t.pulled[1];
    // windups in progress: the 3D stick goes back before the release arrives
    const wind = new Map(t.wind.map(([id, what, t0]) => [id, { what, t0 }] as const));
    for (const a of this.agents.values()) {
      const w = wind.get(a.id);
      if (w) a.act = { k: 'windup', t0: w.t0, what: w.what };
      else if (a.act?.k === 'windup') a.act = null;
    }
    this.remote = { hud: t.hud, aim: t.aim, men: t.men, boxed: t.boxed, delayed: t.delayed, to: t.to ?? null, lines: t.lines };
    if (t.tol) this.timeoutLeft = [t.tol[0], t.tol[1]];
  }
  /** Skaters per side right now (in the box ones excluded, an extra attacker included). */
  men(): [number, number] { if (this.mirror) return this.remote?.men ?? [5, 5]; return [this.skaters(0).length, this.skaters(1).length]; }
  /** Men in the box per side with the time left on their penalties (period-clock seconds). */
  boxed(): [{ id: string; left: number }[], { id: string; left: number }[]] {
    if (this.mirror) return this.remote?.boxed ?? [[], []];
    return [0, 1].map(s => [...this.agents.values()].filter(a => a.side === s && a.on === 'box' && !a.coin).map(a => ({ id: a.id, left: Math.max(0, a.boxUntil - this.clock) })).sort((p, q) => p.left - q.left)) as [{ id: string; left: number }[], { id: string; left: number }[]];
  }
  /** A delayed penalty is signalled against this side (the referee's arm is up). */
  get delayed(): Side | null { if (this.mirror) return this.remote?.delayed ?? null; return this.pending.length ? this.pending[0].side : null; }
  /** On-ice skaters per side (ids), for the books. */
  ice(): [(string | null)[], (string | null)[]] { return [this.skaters(0, true).map(a => a.id), this.skaters(1, true).map(a => a.id)]; }
  goalieOn(s: Side): string | null { return this.goalieOf(s)?.id ?? null; }
  /** The manager's view of his controlled player: what each button does right now and the charge of a windup. */
  hud(seat = 0): PlayHud {
    if (this.mirror) return this.remote?.hud ?? { ctl: null, power: 0, context: 'defend', labels: { shoot: 'Силовой', pass: 'Смена', deke: 'Отбор' }, energy: 1, faceoff: false, foCue: null, foCall: null, move: null };
    const z = this.seats()[seat];
    if (z && z !== this.z) return this.as(z, () => this.hud(seat));
    const me = this.ctl ? this.agents.get(this.ctl) : undefined, s = z ? z.side : null;
    const p = this.puck;
    const lastG = this.goalsFor[this.goalsFor.length - 1], st = this.stopInfo;
    // a goal of his team: the scorer's celebration on the buttons; another stoppage: a fight can start
    const context: PlayHud['context'] = this.mode === 'stop' && st.reason === 'goal' && s !== null && lastG?.side === s ? 'celebrate'
      : this.mode === 'stop' && st.reason !== 'end' && st.reason !== 'start' && st.reason !== 'goal' && st.reason !== 'so' ? 'stop'
      : me && p.carrier === me ? 'carry' : s !== null && (p.carrier?.side === s || (p.passTo && p.passTo.side === s)) ? 'support' : 'defend';
    const act = me?.act;
    const otLoad = me?.oneTimer && me.otAt !== undefined && !act ? (me.otBy === 'stick' ? stickPower : buttonPower)(this.tau - me.otAt) : 0;
    const power = act?.k === 'windup' ? (act.what === 'shot' ? (this.ss.back >= 0 ? stickPower(this.tau - this.ss.back) : buttonPower(this.tau - act.t0)) : clamp((this.tau - act.t0) / 0.5, 0, 1)) : otLoad;
    const labels = context === 'celebrate' ? { shoot: 'Руки', pass: 'Колено', deke: 'Палец' } : context === 'carry' ? { shoot: 'Бросок', pass: 'Пас', deke: 'Финт' } : context === 'support' ? { shoot: 'В касание', pass: 'Дай пас', deke: 'Финт' } : { shoot: 'Силовой', pass: 'Смена', deke: 'Отбор' };
    const mv = me ? this.moveOf(me).mv : null;
    // the draw: «ready» while the referee holds the puck, «now» once it falls (until the draw is decided)
    const fo = this.mode === 'faceoff' ? this.fo : null;
    const foCue = fo && !fo.done && !fo.gather && s !== null ? (this.tau >= fo.drop ? 'now' : 'ready') : null;
    const foCall = this.foCall && this.tau < this.foCall.until ? this.foCall.text : null;
    // the move he is making right now (the HUD names it: a deke on a button press is otherwise easy to miss)
    const move = act?.k === 'deke' ? DEKE_NAME[act.kind] : act?.k === 'poke' ? (act.lift ? 'подбил клюшку' : 'отбор клюшкой')
      : me?.otHold && act?.k === 'windup' ? 'щелчок в касание — бей!' : me?.oneTimer && !act ? 'замах в касание'
      : act?.k === 'sweep' ? 'клюшка по льду' : act?.k === 'kick' ? 'шайба коньком' : mv === 'dive' ? 'бросок под шайбу' : mv === 'fight' ? 'драка!'
      : me?.boardPlay ? 'игра у борта' : me?.protect ? 'прикрывает шайбу' : me?.keepFa !== undefined ? 'контроль обзора'
      : context === 'celebrate' ? (this.celeb ? CELEB_NAME[this.celeb.kind] : 'празднование: ✕ ○ □ △, L2, R2, R3') : null;
    return { ctl: this.ctl, power, context, labels, energy: me?.energy ?? 1, faceoff: this.mode === 'faceoff', foCue, foCall, move };
  }
  /** The manager hands his skater back to the AI (the rest of the period is simulated). */
  autopilot() { this.opts.userSide = null; this.opts.humans = undefined; for (const z of [this.seat0, ...(this.twin ?? [])]) z.ctl = null; this.twin = null; this.z = this.seat0; }
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
      return { id: s.id, side: s.side, goalie: s.goalie || undefined, box: s.box || undefined, pos: { x: this.px(x), y: y / 0.3, h: 0 }, dir: { x: this.opts.flip ? -Math.cos(fa) : Math.cos(fa), y: Math.sin(fa) }, ctrl: (t.ctrl && s.side === this.opts.userSide) || undefined, fall: t.fall || undefined, fallKind: t.fall ? t.fk : undefined, fallSide: t.fall && t.fk === 'side' ? t.fs : undefined, check: t.check || undefined, poke: t.poke && !t.mv ? t.poke : undefined, deke: t.deke || undefined, move: t.mv ?? undefined, moveT: t.mv ? s.mv === t.mv ? s.mt + (t.mt - s.mt) * u : t.mt : undefined, stagger: t.stag || undefined,
        stance: t.st ?? undefined, stanceT: t.st ? (s.st === t.st ? s.stT + (t.stT - s.stT) * u : t.stT) : undefined, handle: t.hl ? s.hl + (t.hl - s.hl) * u : undefined,
        hop: t.hop ? Math.max(0, (s.hop || t.hop) + (t.hop - (s.hop || t.hop)) * u) : undefined };
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
    return !!p && p.position !== 'G' && !p.inVhl && !this.agents.get(id!)?.ejected;
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
  /** men serving penalties that leave the team short (a coincidental major — a fight — does not) */
  private boxCount(side: Side) { return [...this.agents.values()].filter(a => a.side === side && a.on === 'box' && !a.coin).length; }
  /** How many skaters side s should have: five (three in the 3-on-3 overtime) less the men in the box. */
  /** Period-clock seconds per real second now: the special-teams clock while the sides are uneven (penalties). */
  clockRate(): number {
    const pc = this.opts.penaltyClock ?? 'period';
    if (pc === 'period' || this.manpower(0) === this.manpower(1)) return this.rate;
    return Math.min(this.rate, pc === 'real' ? 1 : pc);
  }
  private manpower(s: Side): number {
    const mine = Math.min(2, this.boxCount(s)), theirs = Math.min(2, this.boxCount((1 - s) as Side));
    // KHL 3-on-3 overtime: a penalty gives the other team a fourth (fifth) skater instead
    if (this.opts.kind === 'ot3') return clamp(3 + Math.max(0, theirs - mine), 3, 5);
    return 5 - mine;
  }
  private play(kind: PlayKind, side: Side | null, text: string, who?: Sk) {
    this.plays.push({ tau: this.tau, g: this.clock, kind, side, player: who?.id, text }); this.playN++;
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
  private setUnit(s: Side, force = false, hop = true) {
    const want = this.unitFor(s);
    const extra = this.pulled[s] && this.goalieOf(s) === null;
    const cur = this.skaters(s);
    if (!force && cur.length === want.length + (extra ? 1 : 0) && want.every(id => cur.some(a => a.id === id))) return;
    for (const a of cur) if (!want.includes(a.id)) { a.on = 'bench'; a.leaving = false; a.act = null; }
    // the new men step on along the bench front, side by side (not all on one spot, pushed apart in a frame)
    let k = 0;
    for (const id of want) {
      const a = this.agents.get(id)!;
      if (a.on !== 'ice') { const x = this.bench[s].x + (k++ - 2) * 0.9, y = this.bench[s].y + 1; if (hop) this.stepOn(a, x, y, true); else { a.on = 'ice'; a.x = x; a.y = y; a.vx = 0; a.vy = 0; } }
      a.leaving = false;
    }
    if (extra) this.addExtra(s);
    this.assignRoles(s);
  }
  /** Facing out from the bench onto the ice. */
  private toIce(s: Side) { return Math.sign(MID - this.bench[s].y) >= 0 ? Math.PI / 2 : -Math.PI / 2; }
  /**
   * A man comes onto the ice at (x, y) by the bench: over the boards on the fly, through the bench door at a whistle
   * (`door`). He stands there while the 3D picture shows him getting out of the bench (the frames carry `hop`), and
   * only then skates — never sliding off before he is on the ice.
   */
  private stepOn(a: Sk, x: number, y: number, door: boolean) {
    a.on = 'ice'; a.leaving = false; a.act = null;
    a.x = x; a.y = y; a.vx = 0; a.vy = 0; a.fa = this.toIce(a.side);
    a.hopTo = this.tau + (door ? HOP_DOOR : HOP_FLY);
  }
  private addExtra(s: Side) {
    const Lu = this.opts.lineups[s];
    const id = [...Lu.F.flat(), ...Lu.D.flat()].find(x => this.validSkater(x) && this.agents.get(x)?.on === 'bench');
    if (!id) return;
    const a = this.agents.get(id)!;
    this.stepOn(a, this.bench[s].x, this.bench[s].y + 1, this.mode !== 'play');
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
    this.held = null;
    if (reason !== 'goal') {
      p.dead = true;
      // the whistle does not stop the puck: whoever had it lets it go, and it slides on (deadSlide) until it stops
      if (p.carrier) { const c = p.carrier; p.carrier = null; p.vx = c.vx * 0.85; p.vy = c.vy * 0.85; p.h = 0; p.vh = 0; }
    }
    p.shot = null; p.passTo = null; p.passBy = null; p.icing = null;
    for (const a of this.onIce()) { if (a.act?.k !== 'deke') a.act = null; a.oneTimer = false; }
    // penalties are called at the whistle
    if (this.pending.length) {
      const list = this.pending; this.pending = [];
      for (const pen of list) this.assess(pen);
    }
  }
  /** The KHL kind of a call: given, else from its minutes (a major for a dangerous foul brings the automatic ДдКМ). */
  private callOf(pen: Pending): PenaltyCall {
    if (pen.kind) return { kind: pen.kind, reason: pen.reason, ...(pen.plus ? { plus: pen.plus } : {}) };
    if (pen.min === 5) return { kind: 'major', reason: pen.reason, plus: pen.plus ?? 'game' };
    return { kind: pen.min === 4 ? 'double' : pen.reason === PEN_REASON.bench ? 'bench' : 'minor', reason: pen.reason, ...(pen.plus ? { plus: pen.plus } : {}) };
  }
  private assess(pen: Pending, coin = false) {
    const a = pen.player;
    if (a.on !== 'ice') return;
    // a foul from behind on a breakaway: a penalty shot instead of the minor (if the man fouled can still take it)
    if (pen.ps && !coin && pen.ps.on === 'ice' && !pen.ps.ejected) { this.awardPenaltyShot(pen); return; }
    const call = coin ? { kind: 'major' as const, reason: pen.reason } : this.callOf(pen);
    // now and then the man called argues with the referee: ten more minutes (2+10)
    if (!coin && !call.plus && (call.kind === 'minor' || call.kind === 'double') && this.rand() < (call.reason === PEN_REASON.rough ? 0.08 : 0.02)) call.plus = 'misconduct';
    const short = coin ? 0 : SHORT_MIN[call.kind], out = !coin && ejects(call);
    // a misconduct (or a ДдКМ) alone leaves the team at full strength, like a coincidental major
    a.coin = coin || short === 0;
    a.on = 'box'; a.leaving = false; a.act = null;
    a.boxUntil = this.clock + (short ? short : call.kind === 'misconduct' ? 10 : 20) * 60;
    a.boxMin = coin ? pen.min : short === 4 ? 4 : short === 5 ? 5 : 2;
    a.ejected = out || undefined;
    a.miscUntil = call.plus === 'misconduct' ? a.boxUntil + 600 : undefined;
    if (this.early[a.side]?.leaver === a || this.early[a.side]?.id === a.id) this.early[a.side] = null;
    if (coin) { this.play('penalty', pen.side, `${a.name} — ${pen.reason} (5 мин, взаимные: составы равные)`, a); a.boxGo = true; a.stun = 0; a.fall = 0; this.out.push({ type: 'penalty', side: pen.side, player: a.id, min: pen.min, reason: pen.reason, coin: true }); for (const z of this.seats()) if (z.ctl === a.id) z.ctl = null; return; }
    // he skates to the penalty box door himself (out of the play at once), then sits down — or, ejected, goes on
    // through it to the dressing room while a teammate takes his seat for the minutes his team plays short
    a.boxGo = true; a.stun = 0; a.fall = 0;
    if (this.puck.carrier === a) this.puck.carrier = null;
    this.out.push({ type: 'penalty', side: pen.side, player: a.id, min: short || (call.kind === 'misconduct' ? 10 : 20), reason: pen.reason, kind: call.kind, ...(call.plus ? { plus: call.plus } : {}) });
    const len = penLength(call);
    this.play('penalty', pen.side, `Удаление: ${a.name} — ${pen.reason}${call.kind === 'bench' ? ' (малый скамеечный)' : ''}, ${len}${out ? ' — до конца матча' : ''}`, a);
    if (short) { this.ppIdx[(1 - pen.side) as Side] = 0; this.ppIdx[pen.side] = 0; }
    for (const z of this.seats()) if (z.ctl === a.id) z.ctl = null;
  }
  private stepStop() {
    const st = this.stopInfo, fg = this.fightOn;
    const ring = fg ? { x: (fg.a.x + fg.b.x) / 2, y: (fg.a.y + fg.b.y) / 2 } : null;
    for (const a of this.onIce()) {
      if (a.goalie) { this.goalieTarget(a); continue; }
      a.manual = false;
      if (fg && ring && (a === fg.a || a === fg.b)) {
        // the two of them squared up, an arm's length apart, circling a little
        const o = a === fg.a ? fg.b : fg.a, d = dist(a, o) || 1, sw = Math.sin((this.tau - fg.t0) * 1.3) * 0.35;
        a.tx = ring.x + (a.x - o.x) / d * 0.42 - (a.y - o.y) / d * sw; a.ty = ring.y + (a.y - o.y) / d * 0.42 + (a.x - o.x) / d * sw; a.urg = 0.45;
        a.fa += angDiff(a.fa, Math.atan2(o.y - a.y, o.x - a.x)) * 0.3;
        continue;
      }
      if (ring && dist(a, ring) < 4.5) {
        // everybody else gives them room (the linesmen wait for the right moment)
        const d = dist(a, ring) || 1; a.tx = ring.x + (a.x - ring.x) / d * 5; a.ty = ring.y + (a.y - ring.y) / d * 5; a.urg = 0.5;
        continue;
      }
      if (st.reason === 'goal' && this.goalsFor.length) {
        // the scorer's teammates gather round him, the others drift away
        const g = this.goalsFor[this.goalsFor.length - 1], sc = this.agents.get(g.id);
        if (sc && a.side === g.side && a !== sc) { a.tx = sc.x - (sc.x - a.x) * 0.25; a.ty = sc.y - (sc.y - a.y) * 0.25; a.urg = 0.7; }
        else if (a === sc) { const t = inside({ x: a.x + a.vx * 0.6, y: a.y + a.vy * 0.6 }, 2); a.tx = t.x; a.ty = t.y; a.urg = 0.5; }
        else { a.tx = a.x; a.ty = a.y; a.urg = 0.3; }
      } else { a.tx = a.x + a.vx * 0.15; a.ty = a.y + a.vy * 0.15; a.urg = 0.3; }
    }
    for (const a of this.onIce()) this.move(a);
    if (fg) for (const a of [fg.a, fg.b]) if (a.stun <= 0) a.fa += angDiff(a.fa, Math.atan2((a === fg.a ? fg.b : fg.a).y - a.y, (a === fg.a ? fg.b : fg.a).x - a.x)) * 0.5;
    this.collide();
    if (this.puck.inNet !== null) this.netPuck();
    else if (this.held) this.holdPuck();
    else this.deadSlide();
    if (fg) this.stepFight();
    if (this.tau < st.until || this.fightOn) return;
    if (this.opts.kind === 'so') {
      // the shootout: the next attempt, or the series is over
      if (this.ps && !this.ps.live) this.startPenaltyShot();
      else if (!this.ps) this.finish();
      return;
    }
    if (st.reason === 'end' || (st.reason === 'goal' && this.opts.kind !== 'reg' && this.goalsFor.length)) {
      // a timeout asked for as the period ended is not lost
      if (this.toPending !== null) { this.timeoutLeft[this.toPending] = true; this.toPending = null; }
      this.finish(); return;
    }
    if (this.ps && !this.ps.live) { this.startPenaltyShot(); return; }
    if (st.reason !== 'start') this.aiTimeout(st.icingSide);
    if (this.toPending !== null && st.reason !== 'start') { this.beginTimeout(this.toPending, st.dot, st.icingSide); return; }
    this.setupFaceoff(st.dot, st.icingSide, st.reason !== 'start');
  }
  /** The foul on a breakaway: no power play — the man fouled takes a penalty shot after the whistle. */
  private awardPenaltyShot(pen: Pending) {
    const v = pen.ps!, a = pen.player;
    this.ps = { shooter: v, side: v.side, fouler: a, reason: pen.reason, live: false, t0: this.tau, goals: this.goalsFor.length, shotSeen: false };
    this.play('penalty', a.side, `Штрафной бросок! ${a.name} — ${pen.reason} при выходе один на один. Исполняет ${v.name}`, a);
    this.stopInfo.until = Math.max(this.stopInfo.until, this.tau + 2.5);
  }
  /** Everybody else to the benches, the shooter at centre ice with the puck, the goalie in his net: go. */
  private startPenaltyShot() {
    const ps = this.ps!, s = ps.side, o = (1 - s) as Side, sh = ps.shooter;
    this.held = null; this.celeb = null;
    for (const a of this.onIce()) if (!a.goalie && a !== sh) { a.on = 'bench'; a.leaving = false; a.act = null; a.x = this.bench[a.side].x; a.y = this.bench[a.side].y; a.vx = 0; a.vy = 0; }
    for (const side of [0, 1] as Side[]) {
      const g = this.goalieOf(side);
      if (g) { const n = loc(side, { x: GOAL + 1, y: MID }); g.x = n.x; g.y = n.y; g.vx = 0; g.vy = 0; g.fa = side ? Math.PI : 0; g.act = null; }
    }
    const at = loc(s, { x: RED - 2, y: MID });
    sh.on = 'ice';
    sh.x = at.x; sh.y = at.y; sh.fa = s ? Math.PI : 0; sh.vx = Math.cos(sh.fa) * 2; sh.vy = 0; sh.act = null; sh.stun = 0; sh.fall = 0; sh.stagger = 0; sh.leaving = false;
    const p = this.puck;
    p.dead = false; p.inNet = null; p.shot = null; p.passTo = null; p.passBy = null; p.icing = null; p.h = 0; p.vh = 0; p.vx = 0; p.vy = 0;
    p.x = 30; p.y = MID; p.carrier = sh; p.last = sh; sh.ownAt = this.tau;
    for (const z of this.seats()) z.ctl = z.side === s ? sh.id : null;
    ps.live = true; ps.t0 = this.tau; ps.goals = this.goalsFor.length; ps.shotSeen = false;
    this.mode = 'play';
    void o;
  }
  /** The penalty shot ends: a goal (the usual goal stoppage follows), a save, the puck lost or going back, too long. */
  private penaltyShotWatch() {
    const ps = this.ps!, p = this.puck, sh = ps.shooter, s = ps.side, o = (1 - s) as Side;
    if (p.shot) ps.shotSeen = true;
    const goal = this.goalsFor.length > ps.goals;
    const back = p.carrier === sh && loc(s, { x: p.x + p.vx, y: 0 }).x < loc(s, p).x - 0.6 && loc(s, sh).x > RED + 3;
    const over = goal || (ps.shotSeen && !p.shot) || this.held !== null || (p.carrier !== sh && !p.shot && this.tau - ps.t0 > 1) || back || this.tau - ps.t0 > 14;
    if (!over) return;
    this.ps = null;
    if (this.opts.kind === 'so') {
      // the shootout: the attempt into the series, the next one queued for the end of this stop
      const a: SoAttempt = { side: s, shooter: sh.id, goalie: this.goalieOf(o)?.id ?? null, goal, round: ps.round ?? 1 };
      this.soAttempts.push(a);
      const so = soTally(this.soAttempts);
      this.out.push({ type: 'soAttempt', ...a, so });
      this.play(goal ? 'goal' : 'freeze', s, `Буллит, ${a.round}-й раунд: ${sh.name} — ${goal ? 'ГОЛ!' : 'не забил'}. Серия ${so[0]}:${so[1]}`, sh);
      this.soQueue();
      if (!goal && this.mode === 'play') this.startStop('so', { x: 30, y: 15 }, 1.8);
      else if (goal) this.stopInfo.until = Math.max(this.stopInfo.until, this.tau + 2.6);
      return;
    }
    this.out.push({ type: 'penaltyShot', side: s, shooter: sh.id, goalie: this.goalieOf(o)?.id ?? null, goal, ...(ps.fouler ? { fouler: ps.fouler.id } : {}), reason: ps.reason });
    if (goal) return; // the goal's own stoppage, the faceoff at centre after it
    this.play('freeze', o, `Штрафной бросок не реализован: ${sh.name}`, sh);
    if (this.mode === 'play') this.startStop('freeze', zoneDot(o, MID), 1.4);
  }
  /**
   * A timeout (one per team per match): at a stoppage at once, in play at the next whistle. Both teams go to their
   * benches for 30 seconds, the coach draws on his card, the men out there get their breath back. Returns what
   * happened: 'now', 'next' (at the next whistle), or null (none left / not now).
   */
  callTimeout(s: Side): 'now' | 'next' | null {
    if (this.mirror || !this.timeoutLeft[s] || this.mode === 'end' || this.mode === 'timeout' || this.toPending !== null) return null;
    this.timeoutLeft[s] = false;
    if (this.mode === 'faceoff' && this.fo && !this.fo.done) { this.beginTimeout(s, this.fo.dot, null); return 'now'; }
    this.toPending = s;
    return this.mode === 'stop' ? 'now' : 'next';
  }
  /** Online: seat `i`'s player is in his menu (away) or back; meanwhile the AI skates his whole team. */
  setAway(i: number, on: boolean) { const z = this.seats()[i]; if (z) { z.away = on; if (on) z.ctl = null; } }
  /** Ends the timeout now (the manager skips the rest). */
  endTimeout() { if (this.toInfo) this.toInfo.until = Math.min(this.toInfo.until, this.tau); }
  /** The timeout under way: whose and the seconds left (null: none). */
  timeoutNow(): { side: Side; left: number } | null {
    if (this.mirror) return this.remote?.to ?? null;
    return this.mode === 'timeout' && this.toInfo ? { side: this.toInfo.side, left: Math.max(0, this.toInfo.until - this.tau) } : null;
  }
  /** The AI bench's timeouts: its tired men pinned after an icing, or late in the game a goal or two down. */
  private aiTimeout(icingSide: Side | null) {
    if (this.toPending !== null) return;
    for (const s of [0, 1] as Side[]) {
      if (this.human(s) || !this.timeoutLeft[s]) continue;
      const men = this.skaters(s, false), e = men.length ? men.reduce((m, a) => m + a.energy, 0) / men.length : 1;
      const diff = (this.opts.score?.[1 - s] ?? 0) + this.score[1 - s] - (this.opts.score?.[s] ?? 0) - this.score[s];
      const late = this.opts.kind === 'reg' && (this.opts.period ?? 1) >= 3 && this.len - this.clock < 90;
      // a coach spends his one timeout dearly: dead-tired men pinned after their icing past the first half of
      // the match, or the last minute and a half down by a goal or two
      const pinned = icingSide === s && e < 0.5 && ((this.opts.period ?? 1) >= 2 || this.clock > this.len / 2) && this.rand() < 0.5;
      if (pinned || (late && diff >= 1 && diff <= 2 && this.rand() < 0.5)) { this.timeoutLeft[s] = false; this.toPending = s; return; }
    }
  }
  private beginTimeout(s: Side, dot: V2, icingSide: Side | null) {
    this.toPending = null;
    this.mode = 'timeout';
    this.toInfo = { side: s, dot, icingSide, until: this.tau + TIMEOUT_SEC, t0: this.tau };
    const p = this.puck;
    p.dead = true; p.carrier = null; p.shot = null; p.passTo = null; p.icing = null;
    for (const a of this.onIce()) { a.act = null; a.manual = false; a.oneTimer = false; a.hopTo = undefined; }
    this.out.push({ type: 'timeout', side: s });
    this.play('timeout', s, `Тайм-аут: ${(s ? this.opts.away : this.opts.home).name}`);
  }
  /** Each team gathers at its bench in front of the coaches; everybody gets his breath back. */
  private stepTimeout() {
    const to = this.toInfo!;
    for (const s of [0, 1] as Side[]) {
      const men = this.skaters(s), b = this.bench[s];
      men.forEach((a, i) => {
        // a half-ring at the boards in front of the bench, the coach in the middle behind them
        const k = i - (men.length - 1) / 2;
        a.tx = b.x + k * 0.95; a.ty = b.y + 0.75 + 0.35 * Math.abs(k) * 0.5; a.urg = 0.55; a.back = false; a.manual = false;
      });
      const g = this.goalieOf(s);
      if (g) { const n = loc(s, { x: GOAL + 1.2, y: MID }); g.tx = n.x; g.ty = n.y; g.urg = 0.4; }
    }
    for (const a of this.onIce()) {
      this.move(a);
      // there: turned to the bench, listening
      if (!a.goalie && Math.hypot(a.tx - a.x, a.ty - a.y) < 0.4 && Math.hypot(a.vx, a.vy) < 0.6) a.fa += angDiff(a.fa, -Math.PI / 2 * Math.sign(MID - this.bench[a.side].y || 1)) * 0.08;
    }
    this.collide();
    for (const a of this.agents.values()) if (!a.goalie && a.on !== 'box') a.energy = Math.min(1, a.energy + STEP / 55);
    if (this.tau < to.until) return;
    this.toInfo = null;
    this.setupFaceoff(to.dot, to.icingSide, true);
  }
  private finish() {
    if (this.mode === 'end') return;
    this.mode = 'end';
    this.out.push({ type: 'end' });
  }
  private setupFaceoff(dot: V2, icingSide: Side | null, gather = true) {
    this.held = null; this.celeb = null; this.fightOn = null;
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
        if (ex > 0) { const cut = this.skaters(s).filter(a => a.id !== this.seatFor(s)?.ctl).slice(-ex); cut.forEach(a => { a.on = 'bench'; }); }
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
      // the centre first (assignRoles), then the wingers; the defence on the points — a place of his own for everybody
      // at any strength (faceoffFormation.ts; 4-on-4 used to send both defencemen to one spot)
      const F = list.filter(a => !a.kindD), D = list.filter(a => a.kindD);
      const places = foPlaces(F.length, D.length, boardsSide(d));
      const take = (a: Sk, q: FoPlace) => {
        const l = inside(foSpot(d, q, GOAL + 1.4), 1);
        const g = loc(s, l);
        place.set(a.id, g);
        a.act = null; a.stun = 0; a.fall = 0; a.leaving = false;
        // the opening faceoff: everybody is there already; at a whistle they skate there (no teleporting)
        if (!gather) { a.x = g.x; a.y = g.y; a.vx = 0; a.vy = 0; a.fa = s ? Math.PI : 0; a.hopTo = undefined; }
        a.tx = g.x; a.ty = g.y;
      };
      F.forEach((a, i) => take(a, places.F[i]));
      D.forEach((a, i) => take(a, places.D[i]));
      const g = this.goalieOf(s);
      if (g) { const n = loc(s, { x: GOAL + 1.0, y: MID }); place.set(g.id, n); if (!gather) { g.x = n.x; g.y = n.y; g.vx = 0; g.vy = 0; g.fa = s ? Math.PI : 0; } }
    }
    // the manager takes his centre for the draw
    for (const z of this.seats()) { z.foPress = -1; z.foBtn = false; const c = this.center(z.side); if (c) z.ctl = c.id; }
    this.mode = 'faceoff';
    const setAt = this.tau;
    // the official skates to the dot and holds the puck out before he drops it (see officialCrew)
    // (the men just through the bench door get the time it takes them to come out)
    const late = [...this.agents.values()].some(a => a.on === 'ice' && a.hopTo !== undefined && a.hopTo > this.tau) ? HOP_DOOR : 0;
    this.fo = { dot, setAt, drop: setAt + 1.5 + this.rand() * 0.6, done: false, gather, until: setAt + FO_GATHER_MAX + late, spots: place, decide: NaN };
    this.zoneIn = [loc(0, dot).x > OPP_BLUE, loc(1, dot).x > OPP_BLUE];
  }
  /** A man standing in the straight path to `to` (within 0.8 m of it, ahead): the point beside him to skate for. */
  private inTheWay(a: Sk, to: V2): V2 | null {
    const dx = to.x - a.x, dy = to.y - a.y, d = Math.hypot(dx, dy);
    if (d < 1e-6) return null;
    const ux = dx / d, uy = dy / d;
    let best: Sk | null = null, bestAlong = Infinity, bestOff = 0;
    for (const b of this.onIce()) {
      if (b === a) continue;
      const rx = b.x - a.x, ry = b.y - a.y, along = rx * ux + ry * uy, off = -rx * uy + ry * ux;
      if (along <= 0.2 || along >= d + 0.3 || Math.abs(off) >= 0.8 || along >= bestAlong) continue;
      best = b; bestAlong = along; bestOff = off;
    }
    if (!best) return null;
    // pass on the side he leaves more room on (the target's side when it is level)
    const sg = bestOff > 0 ? -1 : 1, gap = 1.05;
    return { x: best.x - uy * sg * gap, y: best.y + ux * sg * gap };
  }
  private center(s: Side): Sk | null {
    const list = this.skaters(s), d = this.fo?.dot ?? this.puck;
    return list.length ? list.reduce((b, a) => (dist(a, d) < dist(b, d) ? a : b)) : null;
  }
  private stepFaceoff(presses: { shoot: boolean; pass: boolean; faceoff: boolean }[]) {
    const fo = this.fo!;
    const p = this.puck;
    if (fo.gather) {
      // everybody skates to his place (the goalies to their nets); the official waits with the puck at the dot
      let ready = true;
      for (const a of this.onIce()) {
        a.manual = false;
        const sp = fo.spots.get(a.id);
        if (!sp) { if (a.goalie) this.goalieTarget(a); else { a.tx = a.x; a.ty = a.y; a.urg = 0.3; } }
        else {
          a.tx = sp.x; a.ty = sp.y; const d = Math.hypot(sp.x - a.x, sp.y - a.y); a.urg = d > 8 ? 0.85 : 0.6; if (d > 0.6) ready = false;
          // a man already set in the way (an opponent on the line): around him, not into him
          const by = d > 0.6 ? this.inTheWay(a, sp) : null;
          if (by) { a.tx = by.x; a.ty = by.y; }
        }
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
    this.seats().forEach((z, i) => { const press = presses[i]; if (press && (press.faceoff || press.shoot || press.pass) && z.foPress < 0) { z.foPress = this.tau; z.foBtn = press.faceoff; } });
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
    for (const z of this.seats()) {
      if (z.away) continue; // in his menu: his centre takes the draw like the AI's would
      // timing the drop: the manager's centre wins clean with a press right as the puck falls
      // the faceoff button has a wider clean window than the shot / pass fallback
      const t = z.foPress < 0 ? 9 : z.foPress - fo.drop, clean = z.foBtn ? 0.2 : 0.14;
      const bonus = t < -0.07 ? -0.45 : t <= clean ? (z.foBtn ? 0.36 : 0.3) : t <= 0.32 ? 0.1 : -0.12;
      pr += z.side === 0 ? bonus : -bonus;
      z.foCall = { text: t < -0.07 ? 'Рано!' : t <= clean ? 'Идеально!' : t <= 0.32 ? 'Неплохо' : z.foPress < 0 ? 'Не нажали' : 'Поздно', until: this.tau + 1.4 };
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

  /* ---------------- after the whistle: the puck slides on, the goalie's freeze, fights, celebrations ---------------- */
  /** The goalie holds the frozen puck: in his glove at the chest, or covered on the ice under his glove / pads. */
  private holdPuck() {
    const h = this.held!, g = h.g, p = this.puck;
    const lat = h.kind === 'glove' ? 0.28 * g.hand : 0.04, fwd = h.kind === 'glove' ? 0.28 : 0.42;
    p.x = g.x + Math.cos(g.fa) * fwd - Math.sin(g.fa) * lat; p.y = g.y + Math.sin(g.fa) * fwd + Math.cos(g.fa) * lat;
    p.h = h.kind === 'glove' ? 1.0 : 0.02; p.vx = 0; p.vy = 0; p.vh = 0;
  }
  /** A dead puck (after the whistle) slides on, off the boards and the cages, until it stops — no rules apply to it. */
  private deadSlide() {
    const p = this.puck, dt = STEP, ox = p.x, oy = p.y;
    if (p.h > 0 || p.vh > 0) {
      p.vh -= 9.81 * dt; p.h += p.vh * dt;
      if (p.h <= 0) { p.h = 0; p.vh = Math.abs(p.vh) > 1.2 ? -p.vh * 0.25 : 0; p.vx *= 0.9; p.vy *= 0.9; }
    } else {
      const sp = Math.hypot(p.vx, p.vy);
      // a little more than the ice's own friction: somebody usually stops it or knocks it to the official
      if (sp > 0) { const ns = Math.max(0, sp - (1.6 + sp * 0.04) * dt); p.vx *= ns / sp; p.vy *= ns / sp; }
    }
    if (!p.vx && !p.vy) return;
    p.x += p.vx * dt; p.y += p.vy * dt;
    for (const cg of CAGES) if (inBox(p, cg, 0.04) && !inBox({ x: ox, y: oy }, cg, 0.04)) {
      if (ox < cg.x0 - 0.04 || ox > cg.x1 + 0.04) p.vx = -p.vx * 0.4; else p.vy = -p.vy * 0.4;
      p.x = ox; p.y = oy;
    }
    const c = inside(p, 0.08);
    if (c.x !== p.x || c.y !== p.y) {
      const nx = p.x - c.x, ny = p.y - c.y, nl = Math.hypot(nx, ny) || 1, vn = (p.vx * nx + p.vy * ny) / nl;
      if (vn > 0) { p.vx -= (1.5 * vn * nx) / nl; p.vy -= (1.5 * vn * ny) / nl; p.vx *= 0.85; p.vy *= 0.85; }
      p.x = c.x; p.y = c.y; p.h = Math.min(p.h, 1.5);
    }
  }
  /**
   * The manager's man drops the gloves with the nearest opponent (in play: the whistle goes at once). The other man
   * may turn it down (then the one who started it gets a minor for roughing); a fight lasts a few seconds, the
   * weaker one usually ends up on the ice, and both get five minutes — coincidental majors: the teams play on at
   * full strength, the two serve them in full and go to their benches after.
   */
  private tryFight(me: Sk): boolean {
    if (!this.rules.penalties || this.fightOn || me.goalie || me.on !== 'ice' || me.coin) return false;
    const o = this.skaters((1 - me.side) as Side, false).filter(b => b.stun <= 0).sort((u, v) => dist(u, me) - dist(v, me))[0];
    if (!o || dist(o, me) > (this.mode === 'stop' ? 7 : 3.5)) { this.play('loose', me.side, `${me.name}: рядом нет соперника для драки`, me); return false; }
    const accept = clamp(0.42 + (o.check - 60) / 90 + (o.bal - 60) / 220, 0.2, 0.85);
    if (this.rand() > accept) {
      this.play('hit', o.side, `${o.name} отказывается от драки — ${me.name} наказан за грубость`, o);
      if (this.mode === 'stop') { me.foulMv = { kind: 'fRough', t0: this.tau }; this.assess({ side: me.side, player: me, reason: PEN_REASON.rough, min: 2 }); }
      else this.foul(me, PEN_REASON.rough, o);
      return true;
    }
    const power = (a: Sk) => a.check + a.bal * 0.6 + (a.kindD ? 4 : 0);
    const win = this.rand() < clamp(0.5 + (power(me) - power(o)) / 120, 0.15, 0.85) ? me : o;
    me.act = null; o.act = null; me.foulMv = undefined; o.foulMv = undefined; me.oneTimer = false; o.oneTimer = false;
    if (this.mode === 'play') {
      const all = [FACEOFF_SPOTS.center, ...FACEOFF_SPOTS.end, ...FACEOFF_SPOTS.neutral], at = { x: this.puck.x, y: this.puck.y };
      const dot = all.reduce((b, q) => (dist(q, at) < dist(b, at) ? q : b), all[0]);
      this.startStop('penalty', { x: dot.x, y: dot.y }, FIGHT_DUR + 1.5);
    }
    this.fightOn = { a: me, b: o, t0: this.tau, win, down: false };
    this.stopInfo.until = Math.max(this.stopInfo.until, this.tau + FIGHT_DUR + 1.2);
    this.play('penalty', me.side, `Драка! ${me.name} и ${o.name} сбросили перчатки`, me);
    return true;
  }
  private stepFight() {
    const fg = this.fightOn!, u = this.tau - fg.t0, lose = fg.win === fg.a ? fg.b : fg.a;
    if (!fg.down && u > FIGHT_DUR - 1.1) {
      fg.down = true; this.knockDown(lose, 'back', 1, 1.0);
      this.play('hit', fg.win.side, `${fg.win.name} выигрывает драку у ${lose.name}`, fg.win);
    }
    if (u < FIGHT_DUR) return;
    // the linesmen step in: five minutes each (coincidental: the teams stay at full strength)
    this.fightOn = null;
    for (const a of [fg.a, fg.b]) if (a.on === 'ice') this.assess({ side: a.side, player: a, reason: PEN_REASON.fight, min: 5 }, true);
    this.stopInfo.until = Math.max(this.stopInfo.until, this.tau + 0.8);
  }
  /**
   * The buttons at a stoppage: after a goal of his team the scorer celebrates the way the manager picks (✕ ○ □ △,
   * L2 riding the stick, R2 down on one knee, R3 fist pumps — on top of the stick or the knee too); otherwise △
   * twice (or the fight key) drops the gloves.
   */
  private stopInput(press: Press) {
    const z = this.z, st = this.stopInfo;
    if (st.reason === 'goal') {
      const g = this.goalsFor[this.goalsFor.length - 1];
      const sc = g && g.side === z.side ? this.agents.get(g.id) : undefined;
      if (!g || !sc || sc.on !== 'ice') return;
      const cur = this.celeb?.id === sc.id ? this.celeb.kind : null;
      let k: CelebKind | null = press.lift || press.shoot ? 'cel1' : press.o ? 'cel2' : press.sq || press.deke ? 'cel3' : press.pin ? 'cel4' : press.vision ? 'celStick' : press.pass ? 'celKnee' : null;
      if (press.r3) k = cur === 'celStick' || cur === 'celStickPump' ? 'celStickPump' : cur === 'celKnee' || cur === 'celKneePump' ? 'celKneePump' : 'celPump';
      if (!k || k === cur) return;
      // fist pumps on top of riding the stick / the knee go on with it
      const keep = !!cur && (k === 'celStickPump' || k === 'celKneePump');
      this.celeb = { id: sc.id, kind: k, t0: keep ? this.celeb!.t0 : this.tau };
      st.until = Math.max(st.until, Math.min(g.tau + 9, this.tau + (keep ? 1.6 : CELEB_DUR - 0.2)));
      return;
    }
    if (st.reason === 'end' || st.reason === 'start' || st.reason === 'so') return;
    if (press.pin) { if (this.tau - z.pinTapAt < 0.38) { press.fight = true; z.pinTapAt = -9; } else z.pinTapAt = this.tau; }
    if (!press.fight) return;
    const me = this.ctl ? this.agents.get(this.ctl) : undefined;
    if (me && me.on === 'ice' && !me.goalie && me.side === z.side) this.tryFight(me);
  }
  /** Whether seat `seat`'s team has just scored and its scorer can celebrate (the buttons pick the celebration). */
  celebrating(seat = 0): boolean {
    if (this.mirror) return this.remote?.hud?.context === 'celebrate';
    const z = this.seats()[seat], g = this.goalsFor[this.goalsFor.length - 1];
    return !!z && !!g && this.mode === 'stop' && this.stopInfo.reason === 'goal' && g.side === z.side;
  }

  /* ---------------- the main step ---------------- */
  private step(padIn: PadState | readonly PadState[]) {
    this.tau += STEP;
    const seats = this.seats(), pads = Array.isArray(padIn) ? padIn as readonly PadState[] : [padIn as PadState];
    const input = seats.map((z, i) => {
      const pad = pads[i] ?? NO_PAD, prev = z.prevPad;
      const press: Press = { shoot: pad.shoot && !prev.shoot, pass: pad.pass && !prev.pass, deke: pad.deke && !prev.deke, swap: pad.swap && !prev.swap, faceoff: !!pad.faceoff && !prev.faceoff,
        poke: !!pad.poke && !prev.poke, lift: !!pad.lift && !prev.lift, pin: !!pad.pin && !prev.pin, hustle: !!pad.hustle && !prev.hustle, push: !!pad.push && !prev.push,
        r3: !!pad.r3 && !prev.r3, fight: !!pad.fight && !prev.fight, o: !!pad.o && !prev.o, sq: !!pad.sq && !prev.sq, lb: !!pad.lb && !prev.lb, vision: !!pad.vision && !prev.vision };
      const release: Release = { shoot: !pad.shoot && prev.shoot, pass: !pad.pass && prev.pass, vision: !pad.vision && !!prev.vision, poke: !pad.poke && !!prev.poke };
      z.prevPad = { ...pad };
      if (press.shoot) z.pressAt.shoot = this.tau;
      if (press.pass) z.pressAt.pass = this.tau;
      return { z, pad, press, release };
    });
    this.boxWalk();
    if (this.mode === 'end') { this.record(); return; }
    if (this.mode === 'stop') { for (const x of input) if (!x.z.away) this.as(x.z, () => this.stopInput(x.press)); this.stepStop(); this.record(); return; }
    if (this.mode === 'timeout') { this.stepTimeout(); this.record(); return; }
    if (this.mode === 'faceoff') { this.stepFaceoff(input.map(x => x.press)); this.record(); return; }
    // (a penalty shot runs no clock)
    if (!this.ps?.live) this.clock += STEP * this.clockRate();
    if (this.clock >= this.len) { this.clock = this.len; this.play('freeze', null, 'Сирена: конец периода'); this.startStop('end', { x: 30, y: 15 }, 1.2); this.record(); return; }
    this.boxes();
    this.energy();
    if (!this.ps?.live) { this.goaliePulls(); this.changes(); }
    if (this.puck.carrier) this.puck.carrier.ownAt = this.tau;
    for (const a of this.onIce()) { a.manual = false; a.protect = false; a.boardPlay = false; a.keepFa = undefined; }
    for (const x of input) { if (x.z.away) { x.z.ctl = null; continue; } this.as(x.z, () => this.user(x.pad, x.press, x.release)); }
    this.think();
    for (const a of this.onIce()) this.move(a);
    this.collide();
    this.acts();
    this.puckStep();
    if (this.ps?.live && this.mode !== 'play') this.penaltyShotWatch();
    if (this.mode !== 'play') { this.record(); return; }
    this.contact();
    if (this.puck.carrier) this.puck.carrier.ownAt = this.tau;
    if (this.ps?.live) { this.penaltyShotWatch(); this.record(); return; }
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
      if (d < 0.35) {
        a.boxGo = false;
        if (a.ejected) { this.toDressingRoom(a); continue; }
        const seat = this.boxSeat(a); a.x = seat.x; a.y = seat.y; a.vx = 0; a.vy = 0; a.fa = -Math.PI / 2; continue;
      }
      const v = Math.min(5.5, 1.2 + d * 1.6), k = Math.min(1, STEP * 5);
      a.vx += (dx / d * v - a.vx) * k; a.vy += (dy / d * v - a.vy) * k;
      a.x += a.vx * STEP; a.y += a.vy * STEP;
      a.fa = Math.atan2(a.vy, a.vx);
    }
  }
  /**
   * An ejected man leaves through the box door; if his team plays short for it (a major with its ДдКМ, a match
   * penalty) a teammate from the bench serves those minutes in the box.
   */
  private toDressingRoom(a: Sk) {
    const left = a.boxUntil - this.clock, short = !a.coin && left > 0;
    a.on = 'bench'; a.boxGo = false; a.coin = false; a.vx = 0; a.vy = 0; a.x = this.box[a.side].x; a.y = this.box[a.side].y;
    this.play('change', a.side, `${a.name} отправляется в раздевалку`, a);
    if (!short) return;
    const Lu = this.opts.lineups[a.side];
    const id = [...Lu.F.flat().reverse(), ...Lu.D.flat().reverse(), Lu.u20F, Lu.u20D].find(x => this.validSkater(x) && this.agents.get(x)?.on === 'bench');
    const b = id ? this.agents.get(id) : undefined;
    if (!b) return;
    b.on = 'box'; b.coin = false; b.boxUntil = a.boxUntil; b.boxMin = a.boxMin; b.boxGo = false; b.miscUntil = undefined;
    const seat = this.boxSeat(b); b.x = seat.x; b.y = seat.y; b.vx = 0; b.vy = 0; b.fa = -Math.PI / 2;
    this.play('change', a.side, `Штраф ${a.name} отбывает ${b.name}`, b);
  }
  private boxes() {
    for (const a of this.agents.values()) {
      if (a.on !== 'box' || this.clock < a.boxUntil - 1e-6) continue;
      // ejected (ДдКМ alone): out of the box only to the dressing room
      if (a.ejected) { this.toDressingRoom(a); continue; }
      // his minor is over, the 10 minutes after it are not: his team is back at full strength, he sits on
      if (a.miscUntil && this.clock < a.miscUntil - 1e-6) { a.coin = true; a.boxUntil = a.miscUntil; a.miscUntil = undefined; continue; }
      // a fighting major served (his team played on at full strength): he goes to the bench, not onto the ice
      if (a.coin) { a.coin = false; a.on = 'bench'; a.boxGo = false; a.x = this.bench[a.side].x; a.y = this.bench[a.side].y; a.vx = 0; a.vy = 0; this.play('change', a.side, `${a.name} отбыл штраф`, a); continue; }
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
      if (this.human(s)) continue;
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
          const off = this.skaters(s).filter(a => a !== this.puck.carrier && a.id !== this.seatFor(s)?.ctl).sort((a, b) => dist(a, this.bench[s]) - dist(b, this.bench[s]))[0];
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
  /**
   * Which of side s's units is out there now, in words for the HUD: «2-е звено · 1-я пара», «1-я бригада
   * большинства», «смешанный состав» — by the men actually on the ice (a line counts with two of its three).
   */
  lineOn(s: Side): string {
    if (this.mirror) return this.remote?.lines?.[s] ?? '';
    const on = new Set(this.skaters(s, false).map(a => a.id)), Lu = this.opts.lineups[s];
    const best = (groups: readonly (readonly (string | null)[])[], need: number) => {
      let at = -1, top = 0;
      groups.forEach((g, i) => { const n = g.filter(id => id && on.has(id)).length; if (n >= need && n > top) { top = n; at = i; } });
      return at;
    };
    const n = this.manpower(s), other = this.manpower((1 - s) as Side);
    if (this.opts.kind !== 'ot3' && n !== other && on.size >= 3) {
      const pp = n > other, list = pp ? [Lu.pp1, Lu.pp2] : [Lu.pk1, Lu.pk2], i = best(list, Math.max(2, on.size - 1));
      return i >= 0 ? `${i + 1}-я бригада ${pp ? 'большинства' : 'меньшинства'}` : pp ? 'большинство' : 'меньшинство';
    }
    const f = best(Lu.F, 2), d = best(Lu.D, 2);
    const parts = [f >= 0 ? `${f + 1}-е звено` : '', d >= 0 ? `${d + 1}-я пара` : ''].filter(Boolean);
    return parts.length ? parts.join(' · ') : 'смешанный состав';
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
        for (const z of this.seats()) if (z.ctl && this.agents.get(z.ctl)?.leaving) this.as(z, () => this.pickControl(true));
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
      for (const z of this.seats()) if (z.ctl && this.agents.get(z.ctl)?.leaving) this.as(z, () => this.pickControl(true));
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
    this.stepOn(b, this.bench[s].x + (this.rand() - 0.5), this.bench[s].y + 0.6, false);
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
      else this.stepOn(b, this.bench[s].x + (this.rand() - 0.5), this.bench[s].y + 0.6, this.mode !== 'play');
    }
    this.assignRoles(s);
    for (const z of this.seats()) if (z.ctl === a.id) this.as(z, () => this.pickControl(true));
  }

  /* ---------------- the manager's skater ---------------- */
  private pickControl(nearestToPuck = true, exclude?: Sk) {
    const s = this.z.side;
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
  private user(pad: PadState, press: Press, release: Release) {
    const s = this.z.side;
    this.blockBy = null; this.handleFast = false;
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
    const z = this.z;
    const mx = this.opts.flip ? -pad.mx : pad.mx, my = pad.my, mag = Math.min(1, Math.hypot(mx, my));
    me.wx = mag > 0.12 ? mx / Math.max(mag, 1e-6) * mag : 0; me.wy = mag > 0.12 ? my / Math.max(mag, 1e-6) * mag : 0;
    // L3 hustle (NHL): a click starts the burst, it lasts while he keeps skating
    if (press.hustle) this.hustleOn = !this.hustleOn;
    if (mag < 0.15 || me.energy <= 0.08) this.hustleOn = false;
    me.sprint = (pad.sprint || this.hustleOn) && me.energy > 0.08;
    if (press.vision) z.ltAt = this.tau;
    if (press.poke) z.rbAt = this.tau;
    const rbHeld = pad.poke ? this.tau - z.rbAt : 0;
    // LT vision control on defence: he keeps his eyes (and chest) on the puck, backing up instead of turning
    me.back = !!pad.vision && !hasPuck && !teamHas;
    // … with the puck (L2 held): he keeps facing the way he faces and skates any way (a tap of L2: a spin-o-rama)
    z.faHold = hasPuck && pad.vision ? z.faHold ?? me.fa : undefined;
    me.keepFa = z.faHold;
    // ✕ held with the puck: he protects it (the body between the puck and the checker); △ held along the boards: board play
    me.protect = hasPuck && !!pad.lift && !pad.pin;
    me.boardPlay = hasPuck && !!pad.pin && nearBoards(me, 1.9);
    // LB (the modifier on every device) on defence: down in the shooting lane to block (slower, a much wider body in front of the puck)
    if (pad.lb && !hasPuck && !teamHas) this.blockBy = me;
    this.handleFast = !!pad.nhl && hasPuck && pad.pass;
    // the aim of a shot or a pass: toward the cursor when the mouse aims, else the skating stick
    const aim = pad.aimAt ? { x: pad.aimAt.x - me.x, y: pad.aimAt.y - me.y } : { x: mx, y: my };
    this.aimVec = aim;
    // △ twice quickly (or the fight key / button): he drops the gloves with the nearest opponent
    if (press.pin) { if (this.tau - z.pinTapAt < 0.38) { press.fight = true; z.pinTapAt = -9; } else z.pinTapAt = this.tau; }
    if (press.fight && me.stun <= 0 && this.tryFight(me)) return;
    if (me.stun > 0) { this.ss.back = -1; return; }
    // a sweep ends when R1 is let go (or the puck is ours again)
    if (me.act?.k === 'sweep' && (!pad.poke || hasPuck || teamHas)) me.act = null;
    // R1 held with the puck: the right stick and the shot button dump it in (a quick press) or flip it (R1 held a while)
    const rbPuck = hasPuck && !!pad.poke;
    if (rbPuck) {
      const ssx = pad.sx ?? 0, ssy = pad.sy ?? 0, sm = Math.hypot(ssx, ssy), ss = this.ss;
      const up = sm > 0.6 && -ssy > 0.5 * sm;
      ss.rest = -9; ss.back = -1; ss.pend = null; ss.wasOut = sm >= 0.3; ss.sweep = 0; this.handle = null;
      if ((press.shoot || (up && !z.rbFlick)) && (!me.act || me.act.k === 'windup') && this.tau > me.cool - 0.2) {
        z.rbFlick = true; me.act = null;
        if (rbHeld >= 0.4) this.flipPuck(me, aim); else this.dumpIn(me, aim);
        return;
      }
      if (sm < 0.3) z.rbFlick = false;
    } else z.rbFlick = false;
    if (!rbPuck && this.skillStick(me, pad, hasPuck, teamHas)) return;
    if (hasPuck) {
      // L2 tapped (let go within a moment): a spin-o-rama
      if (release.vision && this.tau - z.ltAt < 0.22 && !me.act && this.tau > me.cool) { this.deke(me, 0, 0, undefined, 'spin'); return; }
      // R3: the puck kicked off the skate a little ahead, onto his own stick
      if (press.r3 && !me.act && this.tau > me.cool) { this.kick(me); return; }
      // L1 + the left stick flicked (one-touch dekes): to a side — a deke that way, back — between the legs, ahead — a toe drag
      if (mag < 0.3) z.lRest = this.tau;
      if (pad.lb && mag > 0.8 && this.tau - z.lRest < 0.16 && !me.act && this.tau > me.cool && !pad.pass) {
        z.lRest = -9;
        const rel = angDiff(me.fa, Math.atan2(my, mx));
        this.deke(me, mx, my, undefined, Math.cos(rel) < -0.4 ? 'between' : Math.cos(rel) > 0.6 ? 'toe' : 'side');
        return;
      }
      if (press.shoot && !me.act && this.tau > me.cool) me.act = { k: 'windup', t0: this.tau, what: 'shot' };
      if (me.act?.k === 'windup' && me.act.what === 'shot') {
        const held = this.tau - me.act.t0;
        // a tap still takes a moment to get the shot off (no machine-gun releases)
        if (release.shoot) me.act.fire = true;
        if (press.deke && held < 0.6) { me.act = null; this.deke(me, mx, my, undefined, 'fake'); return; }
        if (me.act.fire && held >= 0.12) { me.act = null; this.shoot(me, buttonPower(held), held, aim); return; }
      }
      if (press.pass && !me.act) me.act = { k: 'windup', t0: this.tau, what: 'pass' };
      // L1 pressed while the pass is loading (not together with it — that is the saucer): the pass is called off
      if (press.lb && me.act?.k === 'windup' && me.act.what === 'pass' && me.act.t0 < this.tau - 1e-6) { me.act = null; this.play('loose', s, `${me.name}: пас отменён`, me); return; }
      if (release.pass && me.act?.k === 'windup' && me.act.what === 'pass') {
        const held = this.tau - me.act.t0;
        me.act = null;
        if (pad.nhl) {
          // NHL: a tap is a soft pass, held longer it goes harder; with R1 (or LB) held it is a saucer pass. Let go while
          // the right stick still stickhandles, it was only the "stickhandle without dekes" hold — no pass.
          if (Math.hypot(pad.sx ?? 0, pad.sy ?? 0) >= 0.3) return;
          this.passFrom(me, aim, !!pad.lb || !!pad.poke, clamp(held / 0.6, 0, 1));
        } else this.passFrom(me, aim, held > 0.35 || !!pad.lb || !!pad.poke);
        return;
      }
      if (press.deke && !me.act && this.tau > me.cool) {
        // the deke button: with the burst held a spin-o-rama, a second tap right after a deke goes between the legs,
        // the stick pulled back a toe drag, otherwise a side-to-side deke
        // the touch button swiped one way: that deke (and its side), whatever else is held
        if (pad.dekeKind) {
          const side = pad.dekeSide ? ((this.opts.flip ? -pad.dekeSide : pad.dekeSide) as 1 | -1) : undefined;
          this.deke(me, mx, my, side, pad.dekeKind);
          this.lastDekeAt = -9;
          return;
        }
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
      // R3 as the pass comes: he takes it on the skate (a bad pass behind him is kicked up onto the stick)
      if (press.r3 && p.passTo === me) me.kickRecv = this.tau + 0.8;
      // the shot button: pressed — the windup for a one-timer; let go while the pass is coming — the shot goes off the
      // pass as it arrives (held until it arrives — the puck stops on the blade and the release shoots)
      if (press.shoot) { me.oneTimer = true; me.otAt = this.tau; me.otBy = 'button'; me.otFire = undefined; }
      if (release.shoot && me.oneTimer && me.otBy === 'button') { if (p.passTo === me) me.otFire = this.tau; else me.oneTimer = false; }
      return;
    }
    me.oneTimer = false; me.otHold = false;
    const ready = !me.act && this.tau > me.cool;
    // L1 + R1 together: he lays out in a dive to block the shot or the pass
    if (pad.lb && pad.poke && (press.lb || press.poke) && (ready || me.act?.k === 'poke')) { this.dive(me); return; }
    // R1 held on (after its poke): a stick sweep along the ice, side to side, while it is held
    if (pad.poke && rbHeld > 0.38 && (!me.act || (me.act.k === 'poke' && me.act.done))) { me.act = { k: 'sweep', t0: this.tau, at: this.tau + 0.12 }; return; }
    // NHL defence on the gamepad: RB poke check (aimed with the right stick), A stick lift, Y board pin, R3 a hip check
    // (the body checks are on the right stick)
    if (press.poke && ready) {
      const ssx = pad.srx ?? pad.sx ?? 0, ssy = pad.sry ?? pad.sy ?? 0;
      if (Math.hypot(ssx, ssy) > 0.4) me.fa += clamp(angDiff(me.fa, Math.atan2(ssy, this.opts.flip ? -ssx : ssx)), -0.9, 0.9);
      this.startPoke(me); return;
    }
    if (press.lift && ready) { this.startPoke(me, true); return; }
    if (press.pin && ready) { this.startCheck(me, undefined, 'pin'); return; }
    if (press.r3 && ready) { this.startCheck(me, undefined, 'hip'); return; }
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
    if (m < 0.3 && ss.ot && !hasPuck && teamHas) {
      // a one-timer windup swung forward passes through the centre: a moment's grace before it counts as let go
      if (ss.otEnd < 0) ss.otEnd = this.tau;
      if (this.tau - ss.otEnd < 0.2) return false;
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
      if (ss.ot) { if (!me.otFire) me.oneTimer = false; ss.ot = false; ss.otEnd = -1; }
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
      // without the puck on offence: the stick held back is the windup for a one-timer (the longer, the harder); swung
      // forward while the pass is on its way, the shot goes off the pass as it arrives — the timing is his
      if (m > 0.55 && f < -0.5 * m) {
        if (!ss.ot || !me.oneTimer) { me.otAt = this.tau; me.otFire = undefined; }
        me.oneTimer = true; me.otBy = 'stick'; ss.ot = true; ss.otEnd = -1;
        return false;
      }
      if (ss.ot && f > 0.3 * m && m > 0.45) {
        ss.ot = false; ss.otEnd = -1; ss.rest = -9;
        if (this.puck.passTo === me) me.otFire = this.tau; else me.oneTimer = false;
        return true;
      }
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
    // two humans: everybody plays «pro»
    if (this.seats().length !== 1 || this.human(a.side)) return 1;
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
    const zc = this.seatFor(s)?.ctl, ctlMe = zc ? this.agents.get(zc) : undefined;
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
      const zc = this.seatFor(s)?.ctl, ctlMe = zc ? this.agents.get(zc) : undefined;
      if (ctlMe && ctlMe.side === s && dist(ctlMe, carrier) < dist(pr, carrier) + 1) pr = null as unknown as Sk;
      const fc = this.opts.lineups ? 1 : 1;
      const pkHold = pk && cl.x < BLUE + 1 && dist(pr ?? carrier, carrier) > 5;
      if (pr && !pkHold && !(cl.x > OPP_BLUE + 6 && dist(pr, carrier) > 14 * fc) && !(pr.kindD && cl.x > BLUE + 2 && !goalSide(pr))) {
        // goal-side of where the carrier is going, a stick length away
        const lead = clamp(dist(pr, carrier) / Math.max(1, pr.max), 0, 0.8);
        const fut = { x: carrier.x + carrier.vx * lead, y: carrier.y + carrier.vy * lead };
        const own = loc(s, { x: GOAL, y: MID }), dx = own.x - fut.x, dy = own.y - fut.y, d = Math.hypot(dx, dy) || 1;
        let t = inside({ x: fut.x + (dx / d) * 0.9, y: fut.y + (dy / d) * 0.9 }, 0.7);
        // a carrier standing still (or nearly) shields the puck with his body: go round to the side the puck is on,
        // where a stick can get at it (sticks meet only where they really meet — his skates are in the way otherwise)
        const pq = this.puck;
        if (Math.hypot(carrier.vx, carrier.vy) < 2.5 && dist(pr, carrier) < 4) {
          const ux = pq.x - carrier.x, uy = pq.y - carrier.y, ud = Math.hypot(ux, uy) || 1;
          const side = inside({ x: pq.x + (ux / ud) * 1.0 + (dx / d) * 0.3, y: pq.y + (uy / ud) * 1.0 + (dy / d) * 0.3 }, 0.7);
          if (!this.pokeLine(pr, this.liftFrom(pr, carrier), false)) t = side;
        }
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
    if (d < 1.7 && this.rand() < (0.06 + a.check / 1500) * danger * k) {
      // he reads the play: with the carrier's skates in the way of the puck a good defender keeps his stick home
      // (the weaker and the more desperate ones go for it anyway — and trip him)
      const lift = this.liftFrom(a, c), line = this.pokeLine(a, lift, false);
      // a lift with no way to his stick is only a hook: most keep it home
      if (!line) { if (this.holdsBack(a)) return; }
      else if (this.stickContact(line.pts, c)?.what === 'legs' && this.holdsBack(a)) return;
      this.startPoke(a);
    }
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
      const zs = this.seatFor(s), ctlMe = zs?.ctl ? this.agents.get(zs.ctl) : undefined;
      if (zs && ctlMe && ctlMe.side === s && this.tau < zs.callForPass && ctlMe !== a && this.passLaneOk(a, ctlMe)) { zs.callForPass = 0; this.passTo(a, ctlMe, false); return; }
      const prime = me.x > OPP_BLUE + 0.5 && me.x < OPP_GOAL - 0.4 && lane && (shotZone(me) === 'crease' || shotZone(me) === 'slot');
      if (me.x > OPP_BLUE + 0.5 && me.x < OPP_GOAL - 0.4) {
        const z = shotZone(me);
        const base = { crease: 0.4, slot: 0.13, circles: 0.022, point: 0.015, perimeter: 0.004 }[z];
        const traffic = this.skaters(s).some(m => m !== a && dist(loc(s, m), net) < 3);
        // the longer the team has had it in the zone, the readier to put it on net
        const urge = 1 + clamp(this.tau - a.lastPuck - 1.5, 0, 2) * 0.15;
        let ps = base * (lane ? 1 : 0.3) * (a.shoot / 72) * (z === 'point' && traffic ? 1.6 : 1) * urge;
        if (this.opts.kind !== 'reg' && this.zoneIn[s]) ps *= 1.2;
        // a real chance — in the slot or at the crease with a lane to the net: he puts it on net (quickly, not after a
        // look around for a pass); a man right on him rushes it a little less often
        if (prime) ps = (z === 'crease' ? 0.8 : 0.6) * clamp(a.shoot / 72, 0.8, 1.2) * (pressure < 1.2 ? 0.5 : 1);
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
        // with a real chance of his own only a clearly better one (a tap-in at the far post) is worth the pass
        const better = best.v > myVal + (prime ? 0.3 : 0.12 + chain * 0.06) && held > 0.35 && this.rand() < 0.6;
        const bailout = pressure < (prime ? 1.0 : 1.7) && held > 0.25 && (fwd > -4 || pressure < 1.0) && best.v > myVal - 0.15 && this.rand() < 0.5;
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
    // climbing over the boards / walking through the door: he is not skating yet
    if (a.hopTo !== undefined) {
      if (this.tau < a.hopTo) { a.vx = 0; a.vy = 0; a.fa = this.toIce(a.side); return; }
      a.hopTo = undefined;
    }
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
    if (this.seats().some(z => z.blockBy === a)) vmax *= 0.55;
    if (a.protect) vmax *= 0.85;
    if (a.boardPlay) vmax *= 0.55;
    if (a.act?.k === 'sweep') vmax *= 0.8;
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
    let dvx: number, dvy: number;
    if (idle) { dvx = -a.vx * Math.min(1, 0.9 * dt); dvy = -a.vy * Math.min(1, 0.9 * dt); }
    else {
      // skates, not wheels: an explosive start, arcs at speed (no right angles), a hard stop to go back (skating.ts)
      const st = steer(a.vx, a.vy, wx, wy, dt, { acc, plain: a.goalie, grip: a.manual ? 1.9 : 1.8, scrub: 0.9 });
      dvx = st.dvx; dvy = st.dvy;
    }
    a.vx += dvx; a.vy += dvy;
    a.x += a.vx * dt; a.y += a.vy * dt;
    this.boards(a);
    // facing: forward along the stride; standing (or backing up) facing the puck; a goalie always faces out
    const sp = Math.hypot(a.vx, a.vy);
    let face = a.fa;
    if (a.goalie) face = Math.atan2(this.puck.y - a.y, this.puck.x - a.x);
    else if (this.puck.carrier === a) {
      if (a.boardPlay) { const c = inside(a, 1.9); face = Math.atan2(a.y - c.y, a.x - c.x); } // facing the boards, his back to the checker
      else if (a.keepFa !== undefined) face = a.keepFa; // L2 held: he keeps his facing
      else if (sp > 0.7) face = Math.atan2(a.vy, a.vx);
    }
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
    // the shoves and punches of the scrum
    for (const q of this.pending) if ((q.player === a || q.player === d) && q.reason === PEN_REASON.rough) q.player.foulMv = { kind: 'fRough', t0: this.tau };
  }

  /* ---------------- actions: shots, passes, dekes, checks, pokes ---------------- */
  private releaseRec(a: Sk, kind: ReleaseKind, target: V2, windup: number) {
    const w = this.world(target);
    this.releaseN++;
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
        const diff = !this.seats().length ? 1 : this.human(s) ? (this.difficulty === 'rookie' ? 1.5 : this.difficulty === 'star' ? 0.85 : 1.1) : (this.difficulty === 'rookie' ? 0.7 : this.difficulty === 'star' ? 1.15 : 0.95);
        // alone on the goalie (a penalty shot, a shootout attempt): a move of the shooter's choosing at his own pace —
        // about three in ten go in (the KHL's and the NHL's shootouts)
        const solo = this.ps?.live && this.ps.shooter === a ? PS_CAL : 1;
        pg = GOAL_CAL * (1 - sv) * q * ZONE_MULT[zone] * corner * speedF * screen * move * rebound * dekeF * tip * diff * solo;
        pg = clamp(pg, 0.008, 0.8);
      }
      if (this.rand() < pg) outcome = 'goal';
    }
    // released in front of the goal line: a blade reaching over the line (a shot from the post, a wraparound) lets it
    // go from the near side of it, so it flies into the mouth instead of along the line (or straight up, with no room)
    const pl = loc(s, p);
    if (pl.x > OPP_GOAL - 0.3) { const q = loc(s, { x: OPP_GOAL - 0.3, y: pl.y }); p.x = q.x; p.y = q.y; }
    // the puck flies straight at the aimed point; the height is reached at the goal line
    const dx = target.x - p.x, dy = target.y - p.y, dd = Math.hypot(dx, dy) || 1, T = dd / speed;
    p.carrier = null; p.dead = false; p.leg++; p.passTo = null; p.passBy = null; p.saucer = false;
    p.vx = (dx / dd) * speed; p.vy = (dy / dd) * speed; p.h = 0.05; p.vh = (th - 0.05 + 0.5 * 9.81 * T * T) / T;
    p.noTouch = a; p.noTouchUntil = this.tau + 0.3; p.last = a; this.released(a, kind === 'tip');
    this.armIcing(a);
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
    const zs = this.seatOf(a), s = a.side, manual = a.manual && !!zs;
    const auto = gl ? (gl.y > MID ? -1 : 1) : preview ? 1 : (this.rand() < 0.5 ? -1 : 1);
    let ty = MID + auto * (POST - 0.2);
    if (manual && zs!.aimPt) ty = clamp(loc(s, zs!.aimPt).y, MID - POST + 0.15, MID + POST - 0.15);
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
  aimMarker(seat = 0): AimMark | null {
    if (this.mirror) return this.remote?.aim ?? null;
    const zs = this.seats()[seat];
    if (!zs) return null;
    if (zs !== this.z) return this.as(zs, () => this.aimMarker(seat));
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
    this.armIcing(a);
    a.lastPuck = this.tau; a.cool = this.tau + 0.25;
    this.releaseRec(a, saucer ? 'saucer' : 'pass', { x: tx, y: ty }, 0.2);
    // the manager's control follows the pass (NHL style)
    const zp = this.seatFor(a.side);
    if (zp && a.manual) zp.ctl = m.id;
  }
  private dump(a: Sk) {
    const s = a.side, me = loc(s, a), far = me.y < MID ? 26 : 4;
    const t = loc(s, { x: OPP_GOAL + 1.5, y: far });
    this.slide(a, t, 17, 0.25);
    this.play('dump', s, `${a.name} вбрасывает шайбу в зону`, a);
  }
  /** R1 + the shot (a quick one): a dump-in round the boards into the far corner (or the corner the stick points to). */
  private dumpIn(a: Sk, aim: V2) {
    const s = a.side, me = loc(s, a), ay = Math.hypot(aim.x, aim.y) > 0.3 ? (s ? -aim.y : aim.y) : 0;
    const side = Math.abs(ay) > 0.3 ? (ay > 0 ? 26 : 4) : me.y < MID ? 26 : 4;
    this.slide(a, loc(s, { x: OPP_GOAL + 1.5, y: side }), 18, 0.25);
    this.play('dump', s, `${a.name} вбрасывает шайбу в зону`, a);
  }
  /** R1 held + the shot: a flip — the puck lobbed high (about 2 m) over the sticks, some 16 m on where he aims. */
  private flipPuck(a: Sk, aim: V2) {
    let ax = aim.x, ay = aim.y;
    if (Math.hypot(ax, ay) < 0.3) { ax = Math.cos(a.fa); ay = Math.sin(a.fa); }
    const d = Math.hypot(ax, ay) || 1, t = inside({ x: a.x + (ax / d) * 17, y: a.y + (ay / d) * 17 }, 1.5);
    this.slide(a, t, 13, 0);
    this.puck.saucer = true; this.puck.h = 0.1; this.puck.vh = 6.2;
    this.play('clear', a.side, `${a.name} подбрасывает шайбу`, a);
  }
  /** R3 with the puck: kicked off the skate a little ahead of him, onto his own stick a moment later. */
  private kick(a: Sk) {
    const p = this.puck;
    if (p.carrier !== a) return;
    const along = Math.max(0, Math.cos(a.fa) * a.vx + Math.sin(a.fa) * a.vy), sp = along + 1.8;
    this.loose(Math.cos(a.fa) * sp, Math.sin(a.fa) * sp);
    p.x = a.x + Math.cos(a.fa) * 0.3; p.y = a.y + Math.sin(a.fa) * 0.3;
    p.noTouch = a; p.noTouchUntil = this.tau + 0.2; p.last = a; this.released(a);
    a.act = { k: 'kick', t0: this.tau }; a.cool = this.tau + 0.35; a.lastPuck = this.tau;
    this.play('loose', a.side, `${a.name}: пнул шайбу коньком`, a);
  }
  /** L1 + R1 on defence: he lays out along the ice (a dive) — a wide body to block a shot or a pass for a second. */
  private dive(a: Sk) {
    a.act = null;
    // laid out forward, the way he is going (a man skating backwards turns and goes down head first along it)
    if (Math.hypot(a.vx, a.vy) > 1.2) a.fa = Math.atan2(a.vy, a.vx);
    a.vx += Math.cos(a.fa) * 2.2; a.vy += Math.sin(a.fa) * 2.2;
    a.diveUntil = this.tau + 1.15;
    a.diveSweepAt = this.tau + 0.25; a.diveSweepDir = 1;
    a.stun = 1.15; a.fall = 1.15; a.fallK = 'front'; a.fallS = 1; a.fallAt = this.tau;
    a.cool = this.tau + 1.3;
    this.play('block', a.side, `${a.name} ложится под шайбу`, a);
  }
  /** One pass of a stick sweep (R1 held on defence): the blade along the ice in an arc in front of him. */
  private resolveSweep(a: Sk) {
    const p = this.puck, c = p.carrier;
    if (!c || c.side === a.side || dist(a, c) > 2.4) return;
    // the blade along the ice in an arc a stick's length out, from the side it was on to the other
    const from = a.fa - 1.0 * (a.sweepDir ?? 1), pts: V2[] = [];
    for (let k = 0; k <= 20; k++) { const ang = from + (a.sweepDir ?? 1) * 2.0 * k / 20; pts.push({ x: a.x + Math.cos(ang) * 1.3, y: a.y + Math.sin(ang) * 1.3 }); }
    a.sweepDir = -(a.sweepDir ?? 1);
    const hit = this.stickContact(pts, c);
    if (!hit) return;
    if (hit.what === 'puck' || hit.what === 'blade') {
      // knocked sideways, the way the blade was sweeping
      c.act = null; c.cool = Math.max(c.cool, this.tau + 0.4);
      const ang = from + (-(a.sweepDir) * 2.0 * hit.i / 20), tx = -Math.sin(ang) * -(a.sweepDir), ty = Math.cos(ang) * -(a.sweepDir);
      const sp = hit.what === 'puck' ? 2.6 : 1.6;
      this.loose(c.vx * 0.4 + tx * sp, c.vy * 0.4 + ty * sp);
      p.noTouch = c; p.noTouchUntil = this.tau + 0.45;
      this.play('takeaway', a.side, `Выбил шайбу клюшкой: ${a.name}`, a);
      return;
    }
    if (hit.what === 'legs') this.stickInLegs(a, c, true);
  }
  /**
   * One pass of the stick swept across the ice in front of a man laid out in a dive: his hands are out past his
   * helmet (some 0.75 m ahead of him), the blade a stick's length beyond them in an arc from one side to the other.
   * It knocks the puck off a carrier's stick (or a loose puck) away sideways.
   */
  private diveSweep(a: Sk) {
    const p = this.puck, c = p.carrier, dir = a.diveSweepDir ?? 1;
    a.diveSweepDir = (dir > 0 ? -1 : 1);
    // (a shot is the block's business — the body in the lane, in the puck step)
    if (p.dead || p.shot || p.h > 0.25 || (c && c.side === a.side) || dist(a, p) > 2.6) return;
    const hx = a.x + Math.cos(a.fa) * 0.75, hy = a.y + Math.sin(a.fa) * 0.75, from = a.fa - 0.75 * dir, pts: V2[] = [];
    for (let k = 0; k <= 20; k++) { const ang = from + dir * 1.5 * k / 20; pts.push({ x: hx + Math.cos(ang) * 1.35, y: hy + Math.sin(ang) * 1.35 }); }
    let i = -1;
    if (c) { const hit = this.stickContact(pts, c); if (hit && (hit.what === 'puck' || hit.what === 'blade')) i = hit.i; }
    else i = pts.findIndex(q => dist(q, p) < 0.22);
    if (i < 0) return;
    // away the way the blade was going
    const ang = from + dir * 1.5 * i / 20, tx = -Math.sin(ang) * dir, ty = Math.cos(ang) * dir;
    if (c) { c.act = null; c.cool = Math.max(c.cool, this.tau + 0.4); }
    this.loose((c ? c.vx * 0.4 : p.vx * 0.3) + tx * 3, (c ? c.vy * 0.4 : p.vy * 0.3) + ty * 3);
    if (c) { p.noTouch = c; p.noTouchUntil = this.tau + 0.45; }
    p.last = a; p.icing = null; this.released(a, true);
    this.play('takeaway', a.side, `${a.name} в падении выбивает шайбу клюшкой`, a);
  }
  /**
   * The puck is played toward the far end (a shot, a pass, a clear, a dump): icing is pending if it left from the
   * team's own half — the puck itself short of the red line (the line counts as the attacking half) — and the team
   * is not short-handed by penalties at that moment (a pulled goalie does not count).
   */
  private armIcing(a: Sk) {
    const p = this.puck, s = a.side;
    p.icing = loc(s, p).x < RED - 0.1 && this.manpower(s) >= this.manpower((1 - s) as Side) ? s : null;
    p.icingY = p.y; p.icingCrossed = false; p.icingCall = false; p.icingT = 0;
  }
  private callIcing() {
    const p = this.puck, s = p.icing!;
    this.out.push({ type: 'icing', side: s });
    this.play('icing', s, `Проброс: ${this.teams[s].short ?? this.teams[s].name}`);
    // the faceoff at the icing team's end-zone dot nearest to where the puck was played
    this.startStop('icing', zoneDot(s, p.icingY ?? p.y), 1.2, s);
  }
  /**
   * Hybrid icing (KHL rules 65–66), watched as the puck travels: no icing if a defender could have played it on its
   * way (or let it go on his way to the bench), if the defending goalie comes out of his crease for it, or if it hits
   * the goal frame (see puckSub); otherwise the race to the end-zone faceoff dots decides — the defender first (or too
   * close to call): icing as soon as the puck is over the goal line; the attacker first: play on. A puck rimmed round
   * behind the net and coming back out: whoever is nearer the puck. Only a defender going for it: icing once he is over
   * his blue line; nobody going for it: icing a moment after the puck crossed.
   */
  private icingWatch(ox: number, oy: number) {
    const p = this.puck, s = p.icing!, o = (1 - s) as Side, l = loc(s, p), lo = loc(s, { x: ox, y: oy });
    if (p.inNet !== null || p.carrier) return;
    const team = this.teams[s].short ?? this.teams[s].name;
    const wave = (why: string) => {
      p.icing = null;
      // (announced only with the puck in the end zone: a long pass picked off in the neutral zone is just play)
      if (l.x < OPP_BLUE) return;
      this.out.push({ type: 'waived', side: s, text: `Проброс не зафиксирован (${team}): ${why}` });
      this.play('loose', s, `Проброса нет: ${why}`);
    };
    if (!p.icingCrossed && p.h < 0.5 && Math.hypot(p.vx, p.vy) < 30) {
      for (const d of this.skaters(o)) if (d.stun <= 0 && segDist(d, { x: ox, y: oy }, p) < 1.2 && !(p.noTouch === d && this.tau < p.noTouchUntil)) { wave(`${d.name} мог сыграть шайбу`); return; }
    }
    const g = this.goalieOf(o);
    if (g && l.x > OPP_BLUE && dist(loc(s, g), { x: OPP_GOAL, y: MID }) > 2.5) { wave(`вратарь ${g.name} вышел за шайбой`); return; }
    // over the goal line (between the posts it is a goal, not icing)
    if (!p.icingCrossed && lo.x <= OPP_GOAL && l.x > OPP_GOAL && Math.abs(l.y - MID) > POST + 0.1) { p.icingCrossed = true; p.icingT = this.tau; }
    const sp = Math.hypot(p.vx, p.vy);
    if (p.icingCall) { if (p.icingCrossed) this.callIcing(); else if (sp < 0.4) p.icing = null; return; }
    // it stops short of the goal line: no icing
    if (!p.icingCrossed && sp < 0.4) { p.icing = null; return; }
    // the race is judged as the puck comes into the end zone
    if (l.x < OPP_BLUE) return;
    const DOT = L - RINK.endDot;
    const att = this.skaters(s, false).filter(a => a.stun <= 0), def = this.skaters(o, false).filter(a => a.stun <= 0);
    const lead = (list: Sk[]) => list.reduce<Sk | null>((b, a) => (!b || loc(s, a).x > loc(s, b).x ? a : b), null);
    const la = lead(att), ld = lead(def), ax = la ? loc(s, la).x : -99, dx = ld ? loc(s, ld).x : -99;
    const decide = (attFirst: boolean) => {
      if (attFirst && la) { wave(`${la.name} первым успевает к точкам`); return; }
      p.icingCall = true;
      if (p.icingCrossed) this.callIcing();
    };
    const lvx = s ? -p.vx : p.vx;
    if (ax >= DOT || dx >= DOT) decide(ax >= DOT && ax - dx > 0.6);
    else if (p.icingCrossed && l.x < OPP_GOAL - 0.3 && lvx < -0.5) {
      const near = (list: Sk[]) => Math.min(99, ...list.map(a => dist(a, p)));
      decide(near(att) < near(def) - 0.6);
    } else if (p.icingCrossed && (this.tau - p.icingT! > 2.5 || (dx > OPP_BLUE && ax < dx - 4))) decide(false);
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
    this.armIcing(a);
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
    if (this.human(a.side) && a.manual) this.play('loose', a.side, `${a.name}: ${DEKE_NAME[kind]}`, a);
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
  /** An AI defender who sees the carrier's skates between his stick and the puck pulls it back (the better, the surer). */
  private holdsBack(a: Sk) { return !a.manual && this.rand() < clamp(0.66 + (a.check - 60) / 120 + (this.diffOf(a) - 1) * 0.2, 0.5, 0.93); }
  /** Whether a's poke at the carrier c is a stick lift: from beside or behind him (or always, when asked for). */
  private liftFrom(a: Sk, c: Sk, force = false) {
    return c.side !== a.side && dist(a, c) < (force ? 2.1 : 1.9) && (force || Math.cos(angDiff(c.fa, Math.atan2(a.y - c.y, a.x - c.x))) < 0.1);
  }
  private startPoke(a: Sk, forceLift = false) {
    // from behind or beside the carrier a poke at the puck is a stick lift instead (A in the NHL scheme: always a lift)
    const c = this.puck.carrier;
    const lift = !!c && this.liftFrom(a, c, forceLift);
    a.act = { k: 'poke', t0: this.tau, done: false, lift };
    a.cool = this.tau + 0.7;
  }
  private acts() {
    for (const a of this.onIce()) {
      if ((a.diveUntil ?? 0) > this.tau && this.tau >= (a.diveSweepAt ?? Infinity)) { a.diveSweepAt = this.tau + 0.4; this.diveSweep(a); }
      const act = a.act;
      if (!act) continue;
      if (act.k === 'deke' && this.tau - act.t0 > DEKE_DUR[act.kind]) a.act = null;
      else if (act.k === 'kick') { if (this.tau - act.t0 > 0.4) a.act = null; }
      else if (act.k === 'sweep') { if (this.tau >= act.at) { act.at = this.tau + 0.4; this.resolveSweep(a); } }
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
  /**
   * What a stick laid along `pts` (the blade's path: a poke's thrust, a sweep's arc — nearest first) touches first
   * on the carrier c: the puck, his blade, his shaft, or his skates. The carrier's stick runs from his hands (in
   * front of his chest) to the blade cupping the puck; his skates are a disc under him.
   */
  private stickContact(pts: V2[], c: Sk): { what: 'puck' | 'blade' | 'shaft' | 'legs'; at: V2; i: number } | null {
    const p = this.puck, b = { x: p.x, y: p.y };
    const h = { x: c.x + Math.cos(c.fa) * 0.3, y: c.y + Math.sin(c.fa) * 0.3 };
    const hb = Math.hypot(h.x - b.x, h.y - b.y) || 1, heel = { x: b.x + (h.x - b.x) / hb * 0.3, y: b.y + (h.y - b.y) / hb * 0.3 };
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i];
      if (dist(q, b) < 0.17) return { what: 'puck', at: q, i };
      if (segDist(q, b, heel) < 0.13) return { what: 'blade', at: q, i };
      if (segDist(q, heel, h) < 0.09) return { what: 'shaft', at: q, i };
      // his body is wider when he protects the puck (✕) or pins it on the boards (△): it covers more of the puck
      if (dist(q, c) < (c.boardPlay ? 0.48 : c.protect ? 0.42 : 0.3)) return { what: 'legs', at: q, i };
    }
    return null;
  }
  /**
   * The blade's path of a poke from a toward `dir`: from the end of his natural reach out to full stretch. `side`
   * shifts where it starts across his body (a lift reaching round the carrier's hip on the forehand or backhand).
   */
  private pokePath(a: Sk, dir: number, from = 0.25, to = 1.6, side = 0): V2[] {
    const out: V2[] = [], ox = a.x - Math.sin(dir) * side, oy = a.y + Math.cos(dir) * side;
    for (let r = from; r <= to + 1e-9; r += 0.05) out.push({ x: ox + Math.cos(dir) * r, y: oy + Math.sin(dir) * r });
    return out;
  }
  /** A blade path bent round a point (his hip) on to a target: from `from` metres out, null if longer than `reach`. */
  private bentPath(a: V2, via: V2, to: V2, from: number, reach: number): V2[] | null {
    const l1 = dist(a, via), l2 = dist(via, to);
    if (l1 + l2 > reach || l1 < from) return null;
    const out: V2[] = [];
    for (let r = from; r <= l1 + l2 + 1e-9; r += 0.05) {
      if (r <= l1) out.push({ x: a.x + (via.x - a.x) * r / l1, y: a.y + (via.y - a.y) * r / l1 });
      else { const u = (r - l1) / (l2 || 1); out.push({ x: via.x + (to.x - via.x) * u, y: via.y + (to.y - via.y) * u }); }
    }
    return out;
  }
  /**
   * Where a stick goes: the manager's man pokes the way he faces (helped onto the puck when it is roughly
   * there); the AI aims at the puck, less precisely on the easy levels. A lift goes for the carrier's stick instead
   * of the puck — the first point along his shaft it can reach without his skates in the way, straight on or
   * reaching round his hip; `null` when there is none (the stick would only find his legs).
   */
  private pokeLine(a: Sk, lift = a.act?.k === 'poke' && !!a.act.lift, noisy = true): { dir: number; pts: V2[] } | null {
    const p = this.puck, toPuck = Math.atan2(p.y - a.y, p.x - a.x), off = angDiff(a.fa, toPuck), c = p.carrier;
    // (the manager's lift is helped onto the carrier's stick like the AI's, below — without the AI's misses)
    if (a.manual && !(lift && c && c.side !== a.side)) { const dir = Math.abs(off) < 0.6 ? a.fa + off * 0.85 : a.fa; return { dir, pts: this.pokePath(a, dir) }; }
    if (a.manual) noisy = false;
    const noise = noisy ? (this.rand() - 0.5) * 0.24 / this.diffOf(a) : 0;
    if (c && c.side !== a.side && lift) {
      const h = { x: c.x + Math.cos(c.fa) * 0.3, y: c.y + Math.sin(c.fa) * 0.3 };
      for (const side of [0, 0.4, -0.4]) for (const f of [0.55, 0.35, 0.75, 0.2, 0.9]) {
        const t = { x: h.x + (p.x - h.x) * f, y: h.y + (p.y - h.y) * f };
        const o = { x: a.x, y: a.y }, d0 = Math.atan2(t.y - o.y, t.x - o.x);
        // aim from the shifted start so the line still runs through the target
        const ox = a.x - Math.sin(d0) * side, oy = a.y + Math.cos(d0) * side, dir = Math.atan2(t.y - oy, t.x - ox);
        if (Math.hypot(t.x - ox, t.y - oy) > 1.6) continue;
        const hit = this.stickContact(this.pokePath(a, dir, 0.45, 1.6, side), c);
        if (hit && hit.what !== 'legs') return { dir: dir + noise, pts: this.pokePath(a, dir + noise, 0.45, 1.6, side) };
      }
      // from behind: the blade round his hip (past it on whichever side is nearer) and in onto his shaft
      const px = -Math.sin(c.fa), py = Math.cos(c.fa), near = (a.x - c.x) * px + (a.y - c.y) * py >= 0 ? 1 : -1;
      for (const sd of [near, -near]) {
        const hip = { x: c.x + px * 0.46 * sd + Math.cos(c.fa) * 0.1, y: c.y + py * 0.46 * sd + Math.sin(c.fa) * 0.1 };
        for (const f of [0.5, 0.25, 0.8]) {
          const t = { x: h.x + (p.x - h.x) * f + (noisy ? (this.rand() - 0.5) * 0.12 / this.diffOf(a) : 0), y: h.y + (p.y - h.y) * f };
          const pts = this.bentPath(a, hip, t, 0.45, 1.9);
          if (!pts) continue;
          const hit = this.stickContact(pts, c);
          if (hit && hit.what !== 'legs') return { dir: Math.atan2(hip.y - a.y, hip.x - a.x), pts };
        }
      }
      return null;
    }
    return { dir: toPuck + noise, pts: this.pokePath(a, toPuck + noise) };
  }
  /**
   * The stick in the carrier's skates instead of on the puck: whether he goes down depends on his speed and his
   * balance — down, it is a trip; staying up but held up, a hook now and then (the referee's call either way).
   */
  private stickInLegs(a: Sk, c: Sk, sweep = false) {
    const spd = Math.hypot(c.vx, c.vy);
    const pFall = clamp(0.12 + spd / 14 - (c.bal - 60) / 160, 0.06, 0.75) * (sweep ? 0.8 : 1);
    if (this.rand() < pFall) {
      this.knockDown(c, 'front', 1, 0.85);
      if (this.rand() < 0.8) this.foul(a, PEN_REASON.trip, c);
      else this.play('loose', a.side, `${c.name} падает после контакта клюшкой — свисток молчит`, c);
    } else {
      c.stagger = Math.max(c.stagger, this.tau + 0.3);
      c.vx *= 0.75; c.vy *= 0.75;
      const behind = Math.cos(angDiff(c.fa, Math.atan2(a.y - c.y, a.x - c.x))) < -0.2;
      if (this.rand() < (behind ? 0.12 : 0.04)) this.foul(a, PEN_REASON.hook, c);
    }
  }
  /**
   * A poke check / a stick lift resolved by where the sticks actually meet (no dice for the takeaway itself):
   * on the puck — it is knocked off his blade along the thrust (met close in, the poker gathers it); on his blade —
   * it is jarred loose at his feet; on the shaft — a lift takes his stick off the ice and the puck stays, a chop
   * makes him fumble it; in his skates — he may go down: a trip.
   */
  private resolvePoke(a: Sk) {
    const p = this.puck, c = p.carrier;
    const lift = a.act?.k === 'poke' && !!a.act.lift;
    if (c && c.side !== a.side) {
      const line = this.pokeLine(a);
      // a lift that cannot get to his stick goes through to his skates (or he pulls it back)
      const dir = line?.dir ?? Math.atan2(p.y - a.y, p.x - a.x);
      const hit = this.stickContact(line?.pts ?? this.pokePath(a, dir, 0.45), c);
      if (!hit) return;
      // the carrier turned his body into it while the stick was on its way: a defender who reads it pulls up
      if (hit.what === 'legs' && this.holdsBack(a)) return;
      const reachAt = dist(a, hit.at);
      const take = (how: string) => { c.act = null; c.cool = Math.max(c.cool, this.tau + 0.4); this.play('takeaway', a.side, `${how}: ${a.name}`, a); };
      if (lift && (hit.what === 'shaft' || hit.what === 'blade')) {
        // his stick comes up off the ice: the puck stays where it was (it keeps a little of his speed)
        take('Подбил клюшку');
        c.stagger = this.tau + 0.3; c.cool = Math.max(c.cool, this.tau + 0.5);
        if (dist(this.blade(a), p) < 0.9) this.steal(a, c);
        else { this.loose(c.vx * 0.25, c.vy * 0.25); p.noTouch = c; p.noTouchUntil = this.tau + 0.5; }
        // a lift that rides up his shaft into his hands or face: a high stick (2+2 if it draws blood)
        if (this.rand() < (hit.what === 'shaft' ? 0.05 : 0.015)) { const blood = this.rand() < 0.25; c.stagger = Math.max(c.stagger, this.tau + 0.4); this.foul(a, PEN_REASON.high, c, blood ? 4 : 2); }
        return;
      }
      if (hit.what === 'puck') {
        take(lift ? 'Подбил клюшку' : 'Отбор клюшкой');
        // met within his own reach: the blade pulls it onto his stick; at full stretch it is only knocked away
        // (soft hands cushion a poke now and then: the puck stays on his blade)
        if (this.rand() < clamp((c.hands - a.check) / 160 + 0.08, 0.02, 0.3)) { c.stagger = Math.max(c.stagger, this.tau + 0.12); return; }
        if (reachAt < 1.25 && Math.hypot(a.vx - c.vx, a.vy - c.vy) < 6) { this.steal(a, c); return; }
        const n = { x: p.x - hit.at.x, y: p.y - hit.at.y }, nd = Math.hypot(n.x, n.y) || 1;
        const kx = Math.cos(dir) * 0.6 + n.x / nd * 0.4, ky = Math.sin(dir) * 0.6 + n.y / nd * 0.4, kd = Math.hypot(kx, ky) || 1;
        const sp = 1.6 + 1.8 * clamp((reachAt - 0.6) / 1, 0, 1) + (a.check - 60) / 50;
        this.loose(c.vx * 0.35 + kx / kd * sp, c.vy * 0.35 + ky / kd * sp);
        p.noTouch = c; p.noTouchUntil = this.tau + 0.45;
        return;
      }
      if (hit.what === 'blade') {
        // his blade knocked aside: the puck squirts off it at his feet
        take('Выбил шайбу с крюка');
        // a chop on the blade that follows through onto his hands or legs: a slash
        if (this.rand() < 0.025) this.foul(a, PEN_REASON.slash, c);
        this.loose(c.vx * 0.8 + Math.cos(dir) * 1.3, c.vy * 0.8 + Math.sin(dir) * 1.3);
        p.noTouch = c; p.noTouchUntil = this.tau + 0.25;
        return;
      }
      if (hit.what === 'shaft') {
        // a chop on his stick: a strong pair of hands holds on, otherwise the puck gets away from him
        if (this.rand() < clamp(0.35 + (c.hands - 60) / 80, 0.15, 0.8)) { c.stagger = Math.max(c.stagger, this.tau + 0.15); }
        else { take('Выбил клюшку'); this.loose(c.vx * 0.7 + Math.cos(dir) * 0.6, c.vy * 0.7 + Math.sin(dir) * 0.6); p.noTouch = c; p.noTouchUntil = this.tau + 0.25; }
        // too hard on the stick (or on his hands) is a slash; a lift that comes up high, a high stick (2+2 if it draws blood)
        const r = this.rand();
        if (r < (lift ? 0.012 : 0.03)) this.foul(a, PEN_REASON.slash, c);
        else if (lift && r < 0.022) { const blood = this.rand() < 0.25; c.stagger = Math.max(c.stagger, this.tau + 0.4); this.foul(a, PEN_REASON.high, c, blood ? 4 : 2); }
        return;
      }
      // in his skates
      this.stickInLegs(a, c);
      return;
    }
    // a loose puck or a pass within reach: knocked toward him
    const reach = { x: a.x + Math.cos(a.fa) * 1.35, y: a.y + Math.sin(a.fa) * 1.35 };
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
    // a man protecting the puck braces for it; one working it on the boards is all but pinned already (a battle, not a hit)
    const pr = clamp(0.42 + (a.check - t.bal) / 110 + (kind === 'hip' ? tsp / 16 : kind === 'pin' ? 0.12 : closing / 14), 0.12, 0.92) * k * (t.boardPlay ? 0.6 : t.protect ? 0.8 : 1);
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
  private foul(a: Sk, reason: string, victim: Sk, min: 2 | 4 | 5 = 2, kind?: PenKind) {
    if (!this.rules.penalties || this.pending.some(p => p.player === a)) return;
    // the most dangerous of the majors: a match penalty now and then instead of the 5 + ДдКМ
    if (min === 5 && !kind && (reason === PEN_REASON.head || reason === PEN_REASON.behind) && this.rand() < 0.08) kind = 'match';
    const ps = min === 2 && !kind && this.breakaway(a, victim, reason) ? victim : undefined;
    this.pending.push({ side: a.side, player: a, reason, min, ...(kind ? { kind } : {}), ...(ps ? { ps } : {}) });
    // a man who went down too easily: the referee gives him a minor for embellishment as well (4-on-4)
    if (!ps && min === 2 && victim.fall > 0 && (reason === PEN_REASON.hook || reason === PEN_REASON.hold) && this.rand() < 0.06 && !this.pending.some(p => p.player === victim)) {
      this.pending.push({ side: victim.side, player: victim, reason: PEN_REASON.dive, min: 2 });
    }
    // the infraction acted out (it is decided at the contact: the move picks up from the check or the stick already there)
    const mv = foulMove(reason);
    if (mv) a.foulMv = { kind: mv, t0: this.tau - 0.08 };
    this.play('penalty', a.side, `Отложенный штраф: ${a.name} — ${reason}${min === 5 ? ' (большой штраф)' : ''}`, a);
    void victim;
    // the other team has the puck: the referee waits until the offending team touches it
    if (this.puck.carrier?.side === a.side) this.whistlePenalty();
  }
  /**
   * A clean breakaway fouled from behind (KHL rule: a penalty shot): the man fouled had the puck in the attacking
   * half, nobody but the goalie between him and the net, and the foul was a trip, a hook, a hold or a slash.
   */
  private breakaway(a: Sk, victim: Sk, reason: string): boolean {
    if (this.opts.kind === 'ot3' || victim.goalie) return false;
    if (![PEN_REASON.trip, PEN_REASON.hook, PEN_REASON.hold, PEN_REASON.slash].includes(reason as typeof PEN_REASON.trip)) return false;
    const p = this.puck, had = p.carrier === victim || this.tau - victim.ownAt < 0.6;
    if (!had) return false;
    const s = victim.side, me = loc(s, victim);
    if (me.x < RED + 2) return false;
    // a clear chance: past the far blue line or close to it, skating at the net
    if (me.x < OPP_BLUE - 4 || Math.hypot(me.x - OPP_GOAL, me.y - MID) > 24) return false;
    const vToNet = loc(s, { x: victim.x + victim.vx, y: victim.y + victim.vy }).x - me.x;
    if (vToNet < 2.5) return false;
    // the foul from behind: the fouler behind him, both skating the same way
    const behind = Math.cos(angDiff(victim.fa, Math.atan2(a.y - victim.y, a.x - victim.x))) < -0.3;
    if (!behind) return false;
    // nobody (but the fouler) between him and the net
    return !this.skaters((1 - s) as Side, false).some(d => d !== a && loc(s, d).x > me.x - 0.5);
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
      const zc = this.seatOf(c);
      if (c.manual && zc?.handle && (!c.act || (zc.handleFast && c.act.k === 'windup' && c.act.what === 'pass'))) { off = zc.handle.lat * (zc.handleFast ? 0.62 : 0.55); reach = REACH + zc.handle.fwd * 0.22; }
      if (c.act?.k === 'windup' && !(zc?.handleFast && zc.handle && c.act.what === 'pass')) reach = c.act.what === 'shot' ? 0.5 : 0.6;
      // pulled in from full stretch
      if (c.act?.k === 'reach') { reach = REACH + 0.55 * (1 - smooth01((this.tau - c.act.t0) / REACH_DUR / 0.6 - 0.66)); off = 0; }
      // board play: the puck in his skates against the boards; protecting it: out on the side away from the nearest checker
      if (c.boardPlay) { reach = 0.32; off = 0; }
      else if (c.protect && !c.act) {
        const o = this.skaters((1 - c.side) as Side, false).reduce<Sk | null>((b, x) => (!b || dist(x, c) < dist(b, c) ? x : b), null);
        if (o && dist(o, c) < 4) { const side = (o.x - c.x) * -Math.sin(fa) + (o.y - c.y) * Math.cos(fa) > 0 ? 1 : -1; off = -side * 0.62; reach = 0.42; }
      }
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
        const dive = (a.diveUntil ?? 0) > this.tau;
        if (a.goalie || a === shot.by || (a.stun > 0 && !dive) || (p.noTouch === a && this.tau < p.noTouchUntil)) continue;
        const d = segDist(a, { x: ox, y: oy }, p);
        // LB held (the manager's block stance): down on one knee, a much wider and surer body in the lane; laid out in a dive wider still
        const stance = dive || this.seats().some(z => z.blockBy === a);
        if (a.side !== shot.side && d < (dive ? (p.h < 0.6 ? 1.15 : 0.3) : stance ? (p.h < 1.1 ? 0.95 : 0.5) : p.h < 0.5 ? 0.48 : 0.36) && this.rand() < (stance ? 0.96 : 0.8)) { this.block(a, shot); if (stance) a.stun = Math.max(a.stun, 0.3); return; }
        if (a.side === shot.side && p.h < 0.5 && dist(this.blade(a), p) < 0.5 && this.rand() < 0.03 * 60 * dt * (a.manual ? 2 : 1)) { this.tip(a, shot); return; }
      }
    }
    // a pass through a man in the block stance (L1), laid out in a dive (L1 + R1) or sweeping his stick (R1 held): cut off
    if (!shot && p.passBy && p.h < 0.6) {
      for (const a of this.onIce()) {
        if (a.goalie || a.side === p.passBy.side || a.rolled === p.leg || (p.noTouch === a && this.tau < p.noTouchUntil)) continue;
        const dive = (a.diveUntil ?? 0) > this.tau;
        if (a.stun > 0 && !dive) continue;
        const lane = dive ? 1.2 : this.seats().some(z => z.blockBy === a) ? 0.95 : a.act?.k === 'sweep' ? 1.4 : 0;
        if (!lane || segDist(a, { x: ox, y: oy }, p) > lane) continue;
        a.rolled = p.leg;
        if (this.rand() > (dive ? 0.9 : 0.8)) continue;
        const ang = Math.atan2(p.vy, p.vx) + Math.PI + (this.rand() - 0.5) * 2.4, v = 2 + this.rand() * 3;
        p.vx = Math.cos(ang) * v; p.vy = Math.sin(ang) * v; p.vh = 0; p.h = 0; p.leg++; p.passTo = null; p.passBy = null; p.saucer = false;
        p.last = a; p.icing = null; p.noTouch = null; this.released(a, true);
        this.play('interception', a.side, `${a.name} перекрывает передачу`, a);
        return;
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
        // off the goal frame and over the line: no icing
        if (p.icing !== null && p.icing !== s) p.icing = null;
        if (shot) this.missed(shot, true);
        this.play('wide', shot?.side ?? null, 'Штанга!');
        return;
      }
      if (shot && shot.side !== s) this.missed(shot, false);
    }
    // the cages from the sides and the back
    for (const cg of CAGES) if (inBox(p, cg, 0.04) && !inBox({ x: ox, y: oy }, cg, 0.04)) {
      const fromX = ox < cg.x0 - 0.04 || ox > cg.x1 + 0.04;
      // the mouth is open: a puck coming at it between the posts and under the bar crosses the line next frame
      const mouth = cg.x0 < L / 2 ? ox > cg.x1 : ox < cg.x0;
      if (fromX && mouth && Math.abs(p.y - MID) < POST - 0.04 && p.h < BAR - 0.04) continue;
      if (fromX) p.vx = -p.vx * 0.4; else p.vy = -p.vy * 0.4;
      p.x = ox; p.y = oy; p.leg++; p.defl = true;
      if (p.icing !== null && (cg.x0 < L / 2 ? 0 : 1) !== p.icing) p.icing = null;
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
    // icing (hybrid): from the team's own half down the ice, untouched — see icingWatch
    if (p.icing !== null && this.rules.icing && !p.shot) this.icingWatch(ox, oy);
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
      // a high one into the glove (held up at his chest), a low one smothered on the ice under the glove and pads
      const kind = p.h > 0.32 ? 'glove' : 'cover';
      p.vx = 0; p.vy = 0; p.vh = 0;
      this.play('freeze', g.side, kind === 'glove' ? `Сейв: ${g.name} ловит шайбу в ловушку` : `Сейв: ${g.name} ловит и накрывает шайбу`, g);
      this.scrum(g);
      this.startStop('freeze', zoneDot(g.side, p.y), 1.3);
      this.held = { g, kind, t0: this.tau }; this.holdPuck();
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
    if (spd < 9 && attackers) {
      p.vx = 0; p.vy = 0; p.h = 0; this.play('freeze', g.side, `${g.name} накрывает шайбу`, g); this.scrum(g); this.startStop('freeze', zoneDot(g.side, p.y), 1.2);
      this.held = { g, kind: 'cover', t0: this.tau }; this.holdPuck();
      return;
    }
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
    if (this.opts.kind === 'so') {
      // a shootout goal: into the net and the scorer's celebration — the series keeps its own count (soAttempts)
      this.goalsFor.push({ id: last.id, side, tau: this.tau, clock: this.clock });
      const rel = [...this.releases].reverse().find(r => r.id === last.id);
      this.clips.push({ e: { tau: this.tau, scorer: last.id, side, kind, release: rel?.t ?? this.tau - 0.4, strength: 'EV' }, clip: null });
      p.x = at.x; p.y = at.y; p.h = Math.min(at.h, 1.0); p.inNet = (1 - side) as Side; p.carrier = null;
      this.startStop('goal', { x: 30, y: 15 }, this.human(side) ? 3.4 : 2.8);
      p.dead = false;
      return;
    }
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
      const boxed = [...this.agents.values()].filter(a => a.side !== side && a.on === 'box' && a.boxMin !== 5 && !a.coin && !a.ejected).sort((a, b) => a.boxUntil - b.boxUntil)[0];
      if (boxed) boxed.boxUntil = boxed.boxMin === 4 && boxed.boxUntil - this.clock > 120 ? this.clock + 120 : this.clock;
    }
    if (this.pending.length && this.pending[0].side !== side) {
      for (const pen of this.pending) this.out.push({ type: 'waived', side: pen.side, text: `Гол при отложенном штрафе: удаление ${pen.player.name} отменено` });
      this.pending = [];
    }
    // into the net: it flies on into the mesh
    p.x = at.x; p.y = at.y; p.h = Math.min(at.h, 1.0); p.inNet = (1 - side) as Side; p.carrier = null;
    // (a little longer when the manager's team scored: time to pick the celebration)
    this.startStop('goal', { x: 30, y: 15 }, this.human(side) ? 3.8 : 3.2);
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
      if (a.goalie || a.stun > 0 || a.leaving || (p.noTouch === a && this.tau < p.noTouchUntil) || a.rolled === p.leg || (a.hopTo !== undefined && this.tau < a.hopTo)) continue;
      const kickIt = a === p.passTo && (a.kickRecv ?? 0) > this.tau;
      const reach = a === p.passTo ? (kickIt ? 1.25 : 1.0) : a.act?.k === 'sweep' ? 1.45 : p.passTo && a.side !== p.passTo.side ? 0.62 : 0.8;
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
    // R3 as it came: taken on the skate and kicked up onto the stick, a bad pass too
    if (a === p.passTo && (a.kickRecv ?? 0) > this.tau) { pr = 1; a.kickRecv = 0; a.act = { k: 'kick', t0: this.tau }; }
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
    a.otHold = false;
    const prevSide = this.touches.length ? this.touches[this.touches.length - 1].side : null;
    if (prevSide !== null && prevSide !== a.side) this.touches = [];
    // a pass that was meant to reach him keeps the chain; anything else from the other side breaks it
    this.touches.push({ id: a.id, side: a.side });
    // icing pending, a defender plays it: past the goal line — icing; before it (he could play it) — no icing
    if (p.icing !== null && p.icing !== a.side && this.rules.icing && this.mode === 'play') {
      if (p.icingCrossed && !a.goalie) { this.touches.pop(); this.callIcing(); return; }
      const s = p.icing, team = this.teams[s].short ?? this.teams[s].name;
      if (loc(s, p).x > OPP_BLUE) this.out.push({ type: 'waived', side: s, text: `Проброс не зафиксирован (${team}): ${a.name} сыграл шайбу` });
    }
    p.carrier = a; p.passTo = null; p.passBy = null; p.shot = null; p.h = 0; p.vh = 0; p.saucer = false; p.last = a;
    p.icing = null;
    a.lastPuck = this.tau; a.decideAt = this.tau + 0.15 + this.rand() * 0.2; a.carryT = null;
    if (intercept) this.play('interception', a.side, `Перехват: ${a.name}`, a);
    // the manager's control goes to the teammate who gets the puck
    const zt = this.seatFor(a.side);
    if (zt) zt.ctl = a.id;
    // the manager's one-timer: swung through as the pass arrived — the shot goes off the pass at once (the windup's
    // length is its power); still wound up — the puck stops on the blade and the swing forward (or the button let go)
    // is the slap shot; swung far too early — a whiff, he just takes the pass
    if (wasPass && a.oneTimer && a.manual) {
      const t0 = a.otAt ?? this.tau, by = a.otBy ?? 'button';
      a.oneTimer = false;
      if (a.otFire !== undefined) {
        const fired = a.otFire, early = this.tau - fired;
        a.otFire = undefined;
        if (early < ONE_TIMER_WINDOW) {
          // the windup: from the stick going back (or the button) to the swing through
          const wind = Math.max(0, fired - t0);
          const far = Math.hypot(a.x - (a.side ? GOAL : OPP_GOAL), a.y - MID) > 9;
          this.shoot(a, (by === 'stick' ? stickPower : buttonPower)(wind), Math.max(wind, 0.4), zt?.aimVec ?? null, far || wind > 0.32 ? 'slap' : 'snap');
          return;
        }
        this.play('loose', a.side, `${a.name}: замах раньше времени — принял шайбу`, a);
      } else {
        a.act = { k: 'windup', t0, what: 'shot' }; a.otHold = true;
        if (by === 'stick' && zt) { zt.ss.back = t0; zt.ss.loadEnd = -1; }
      }
    }
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
    const st = this.mode === 'faceoff' ? 1 : this.mode === 'stop' || this.mode === 'end' || this.mode === 'timeout' ? 2 : 0;
    // during a stoppage the next faceoff's dot (the last faceoff's is still in `fo`)
    const dot = this.mode === 'faceoff' && this.fo ? this.fo.dot : this.stopInfo.dot;
    return {
      tau: this.tau, clock: this.clock, px: this.puck.x, py: this.puck.y, ph: this.puck.h,
      carrier: this.puck.carrier ? ids.indexOf(this.puck.carrier.id) : -1, ids,
      sk: list.map(a => ({
        id: a.id, side: a.side, goalie: a.goalie, box: a.on === 'box' && !a.boxGo, x: a.x, y: a.y, fa: a.fa, ctrl: !!this.seatOf(a),
        // going down takes a moment (the body tips over), getting up the last 0.35 s
        fall: a.fall > 0 ? smooth01(Math.min(1, (this.tau - a.fallAt) / 0.28)) * smooth01(Math.min(1, a.fall / 0.35)) : 0, fk: a.fallK, fs: a.fallS,
        check: a.act?.k === 'check' && !a.foulMv ? Math.sin(Math.PI * clamp((this.tau - a.act.t0) / 0.42, 0, 1)) : 0,
        poke: a.act?.k === 'poke' ? Math.sin(Math.PI * clamp((this.tau - a.act.t0) / 0.38, 0, 1)) : 0,
        deke: a.act?.k === 'deke' && (a.act.kind === 'side' || a.act.kind === 'toe') ? a.act.s * Math.sin(Math.PI * clamp((this.tau - a.act.t0) / DEKE_DUR[a.act.kind], 0, 1)) * 0.55 : 0,
        ...this.moveOf(a),
        stag: a.stagger > this.tau ? clamp((a.stagger - this.tau) / 0.45, 0, 1) : 0,
        ...this.stanceOf(a),
        hl: a.manual && this.puck.carrier === a ? this.seatOf(a)?.handle?.lat ?? 0 : 0,
        hop: a.hopTo !== undefined && this.tau < a.hopTo ? a.hopTo - this.tau : 0,
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
    // (the manager's one-timer held on the blade keeps the stick cocked until he swings)
    if (a.otHold && a.act?.k === 'windup' && a.on === 'ice') k = 'oneTimer';
    // the manager's puck protection (✕), board play (△) and the stick sweep (R1 held)
    else if (a.act?.k === 'sweep' && a.on === 'ice') k = 'sweep';
    else if (a.boardPlay && c === a) k = 'board';
    else if (a.protect && c === a && !a.act) k = 'protect';
    else if (!a.goalie && a.on === 'ice' && a.stun <= 0 && !a.act) {
      const cl = c && c.side !== a.side ? loc(c.side, c) : null;
      if (this.seats().some(z => z.blockBy === a) || (cl && c!.act?.k === 'windup' && c!.act.what === 'shot' && dist(a, c!) < 6 && segDist(a, c!, loc(c!.side, { x: OPP_GOAL, y: MID })) < 0.9)) k = 'block';
      else if ((a.oneTimer && a.manual) || (p.passTo === a && !c && p.passBy?.side === a.side && loc(a.side, a).x > OPP_BLUE + 4 && dist(loc(a.side, a), { x: OPP_GOAL, y: MID }) < 15)) k = 'oneTimer';
      else if (this.tau < (this.seatOf(a)?.callForPass ?? 0)) k = 'call';
      else if (a.back && c !== a && Math.hypot(a.vx, a.vy) > 0.6) k = 'vision';
      else if (a.sprint && Math.hypot(a.vx, a.vy) > 5.5) k = 'hustle';
    }
    if (k !== (a.stK ?? null)) { a.stK = k; a.stAt = this.tau; }
    return { st: k, stT: k ? smooth01((this.tau - (a.stAt ?? 0)) / 0.18) : 0 };
  }
  /** The move a skater is acting out (a deke, a check, a stick lift) and how far into it he is, 0…1. */
  private moveOf(a: Sk): { mv: MoveKind | null; mt: number } {
    const act = a.act;
    // the goalie's freeze; a fight; the scorer's celebration; a dive to block
    if (this.held?.g === a) return { mv: this.held.kind, mt: smooth01((this.tau - this.held.t0) / 0.3) };
    const fg = this.fightOn;
    if (fg && (fg.a === a || fg.b === a) && a.fall <= 0) return { mv: 'fight', mt: clamp((this.tau - fg.t0) / FIGHT_DUR, 0, 1) };
    if (this.celeb?.id === a.id && this.mode === 'stop') { const u = (this.tau - this.celeb.t0) / CELEB_DUR; if (u >= 0 && u < 1) return { mv: this.celeb.kind, mt: u }; }
    if ((a.diveUntil ?? 0) > this.tau) return { mv: 'dive', mt: clamp(1 - (a.diveUntil! - this.tau) / 1.15, 0, 1) };
    if (a.foulMv) {
      const u = (this.tau - a.foulMv.t0) / FOUL_MOVE_DUR[a.foulMv.kind];
      if (u >= 0 && u < 1 && (a.on === 'ice' || a.boxGo)) return { mv: a.foulMv.kind, mt: u }; // (also on his way to the box: an immediate whistle)
      if (u >= 1) a.foulMv = undefined;
    }
    if (act?.k === 'deke') return { mv: act.kind, mt: clamp((this.tau - act.t0) / DEKE_DUR[act.kind], 0, 1) };
    if (act?.k === 'check') return { mv: act.light ? 'push' : act.kind, mt: clamp((this.tau - act.t0) / 0.42, 0, 1) };
    if (act?.k === 'poke' && act.lift) return { mv: 'lift', mt: clamp((this.tau - act.t0) / 0.38, 0, 1) };
    if (act?.k === 'reach') return { mv: 'reach', mt: clamp((this.tau - act.t0) / REACH_DUR, 0, 1) };
    if (act?.k === 'kick') return { mv: 'kick', mt: clamp((this.tau - act.t0) / 0.4, 0, 1) };
    return { mv: null, mt: 0 };
  }
  private record() { this.keep(this.snapshot()); }
  private keep(f: Frame) {
    this.frames.push(f);
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
