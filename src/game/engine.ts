import type { CoachingEffects } from './coaching';
import type { AttackStyle, ForecheckStyle, GameEvent, GameResult, Lineup, Player, PlayerGameLine, PullGoaliePolicy, ScoringPlay, ShotPoint, ShotZone, Strength, TeamGameStats, TeamTactics } from '../types';
import { clamp, goalieSavePct, isGoalie, lineAttack, lineDefense, pairAttack, pairDefense, unitAttack, unitDefense } from './ratings';
import { defaultTactics } from './defaults';
import { ATTACK_STYLE_INFO, calcDefenseChemistry, calcForwardChemistry, effectiveGoalieOvr, FORECHECK_INFO, goalieFreshness, PULL_GOALIE_INFO } from './chemistry';
import type { DerbyInfo } from './derbies';

export interface SimTeam {
  id: string;
  lineup: Lineup;
  /** club name used in commentary (as written in the roster) */
  name?: string;
  tactics?: TeamTactics;
  chemGP?: Record<string, number>;
  leadershipBonus?: number;
  roadStreak?: number;
  coaching?: CoachingEffects;
}
type TI = 0 | 1;
type Mode = 'ev' | '4v4' | 'pp' | 'pk' | 'ot3' | 'ot5';
export type BlockKind = 'reg' | 'ot3' | 'ot5' | 'so';

interface SimSnap {
  score: [number, number];
  shots: [number, number];
  stats: [TeamGameStats, TeamGameStats];
  scorersLen: number;
  shotMapLen: number;
  lines: Record<string, PlayerGameLine>;
  pens: [Pen[], Pen[]];
  misconducts: [Pen[], Pen[]];
  boxShown: boolean;
  unitIdx: [number, number];
  unansweredGoals: [number, number];
  timeoutUsed: [boolean, boolean];
  focusUntil: [number, number];
  tactics: [TeamTactics, TeamTactics];
  shortBench: [boolean, boolean];
  shortSince: [number, number];
  aiDone: string[];
  enShown: [boolean, boolean];
}

interface ActiveBlockMeta {
  kind: BlockKind;
  dur: number;
  startEventIdx: number;
  s0: [number, number];
  blockStart: number;
}

/** One penalty being served (or waiting: a third penalty starts only when one of the first two ends). */
export interface Pen {
  player: string;
  /** 2, 4 (double minor) or 5 (major) */
  min: number;
  start: number;
  end: number;
}
/** Skaters a team has with `n` penalties running: never fewer than three. */
export const skatersFor = (running: number) => 5 - Math.min(2, running);

const SHIFT = 40;
const F_SHARE = [0.33, 0.27, 0.22, 0.18];
/**
 * Does the extra forward / defenceman (the KHL's 13th forward and 7th defenceman) take this even-strength shift?
 * Mostly with the bottom six and the third pair, about 5–7 minutes a game each. Bit 1: the 13th forward (bits 2–3:
 * the line slot he takes, a winger or the centre), bit 2: the 7th defenceman (bit 4: left or right of the pair).
 */
function extraShift(li: number): number {
  const f = li === 3 ? 0.5 : li === 2 ? 0.12 : 0;
  const d = li === 2 ? 0.4 : li === 1 ? 0.06 : 0;
  let code = 0;
  if (Math.random() < f) code |= 1 | ((Math.random() < 0.2 ? 0 : Math.random() < 0.5 ? 1 : 2) << 2);
  if (Math.random() < d) code |= 2 | ((Math.random() < 0.5 ? 0 : 1) << 4);
  return code;
}
/** chance of a penalty per 40-second shift */
const PENALTY_RATE = 0.062;
const PP_SHOT = 1.6;
const PP_QUALITY = 1.8;
const HOME_EDGE = 1.035;

export function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
export function pickWeighted<T>(items: T[], w: (t: T) => number): T | null {
  if (!items.length) return null;
  let total = 0;
  const ws = items.map((it) => {
    const x = Math.max(0, w(it));
    total += x;
    return x;
  });
  if (total <= 0) return pick(items);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= ws[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

const MINOR = ['подножка', 'удар клюшкой', 'задержка', 'помеха вратарю', 'атака игрока без шайбы', 'высота клюшки', 'задержка руками', 'нарушение численного состава', 'бросок клюшки'];
const MAJOR = ['удар в голову', 'атака сзади', 'толчок на борт', 'удар локтем'];
export const INJURY_TYPES = ['ушиб', 'растяжение', 'повреждение связок', 'перелом', 'сотрясение мозга', 'повреждение плеча', 'травма колена', 'растяжение паха', 'травма кисти', 'ушиб ноги', 'повреждение спины'];

/** Length of a block on the game clock: a period 20:00, the regular-season 3-on-3 overtime 5:00. */
export const blockLen = (k: BlockKind) => (k === 'ot3' ? 300 : k === 'so' ? 0 : 1200);
export const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export function periodName(period: number, kind: BlockKind): string {
  if (kind === 'so') return 'Буллиты';
  if (period <= 3) return `${period}-й период`;
  if (kind === 'ot3') return 'Овертайм';
  return period === 4 ? 'Овертайм' : `${period - 3}-й овертайм`;
}

/** Shootout ability: finishing, hands and speed. */
export const shootoutSkill = (p: Player) => (p.skills.shooting ?? 65) * 0.55 + (p.skills.puckControl ?? p.skills.puckHandling ?? 65) * 0.3 + (p.skills.skating ?? 65) * 0.15;

const skatersOf = (ids: (string | null)[], P: Record<string, Player>): string[] =>
  ids.filter((id): id is string => !!id && !!P[id] && !isGoalie(P[id]));

/**
 * Danger of a shot by where it is taken (× the goalie's base goal rate). Calibrated on KHL/NHL shot maps: a clean
 * look from the crease goes in ≈18 % of the time, the slot ≈12 %, the circles ≈7 %, while a shot from the blue line
 * (≈3 %) or a sharp angle (≈2 %) only beats a goalie through traffic or a deflection.
 */
const ZONE_MULT: Record<ShotZone, number> = {
  crease: 2.04,
  slot: 1.46,
  circles: 0.9,
  point: 0.33,
  perimeter: 0.26,
};

function generateShotGeometry(
  ti: TI,
  sp: Player,
  onPP: boolean,
  mode: Mode,
  emptyNetOpp: boolean,
  style: AttackStyle
): { x: number; y: number; zone: ShotZone; zMult: number; shotType: NonNullable<GameEvent['shotType']> } {
  if (emptyNetOpp) {
    const depth = Math.random() < 0.45 ? 48 + Math.random() * 20 : 72 + Math.random() * 15;
    const x = ti === 0 ? depth : 100 - depth;
    const y = 26 + Math.random() * 48;
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, zone: 'slot', zMult: 1, shotType: 'wrist' };
  }

  let zone: ShotZone;
  const r = Math.random();
  const cycleShift = style === 'cycle' ? 0.06 : style === 'shoot' ? -0.04 : 0;
  if (sp.position === 'D') {
    if (r < 0.03 + (style === 'cycle' ? 0.02 : 0)) zone = 'crease';
    else if (r < 0.15 + cycleShift) zone = 'slot';
    else if (r < 0.37) zone = 'circles';
    else if (r < 0.92) zone = 'point';
    else zone = 'perimeter';
  } else if (onPP || mode === 'ot3') {
    if (r < 0.21 + cycleShift * 0.5) zone = 'crease';
    else if (r < 0.52 + cycleShift) zone = 'slot';
    else if (r < 0.85) zone = 'circles';
    else if (r < 0.91) zone = 'point';
    else zone = 'perimeter';
  } else {
    if (r < 0.13 + cycleShift * 0.6) zone = 'crease';
    else if (r < 0.38 + cycleShift) zone = 'slot';
    else if (r < 0.76) zone = 'circles';
    else if (r < 0.84) zone = 'point';
    else zone = 'perimeter';
  }

  let depth = 80;
  let y = 50;
  const wingSign = sp.position === 'LW' ? (Math.random() < 0.72 ? -1 : 1) : sp.position === 'RW' ? (Math.random() < 0.72 ? 1 : -1) : Math.random() < 0.5 ? -1 : 1;
  switch (zone) {
    case 'crease':
      depth = 86.5 + Math.random() * 4.5;
      y = 50 + (Math.random() - 0.5) * 18;
      break;
    case 'slot':
      depth = 77.5 + Math.random() * 8.5;
      y = 50 + (Math.random() - 0.5) * 24;
      break;
    case 'circles':
      depth = 74 + Math.random() * 11.5;
      y = 50 + wingSign * (14 + Math.random() * 19);
      break;
    case 'point':
      // Just inside the blue line (IIHF: 22.86 m from the end boards → 61.9…62.4 % of the length).
      depth = 63.2 + Math.random() * 4.6;
      y = 50 + (Math.random() - 0.5) * 64;
      break;
    case 'perimeter':
      depth = 74 + Math.random() * 15;
      y = 50 + wingSign * (34 + Math.random() * 11);
      break;
  }
  const x = ti === 0 ? depth : 100 - depth;
  const rs = Math.random();
  let shotType: NonNullable<GameEvent['shotType']> = 'wrist';
  if (zone === 'point') shotType = rs < 0.65 ? 'slap' : 'wrist';
  else if (zone === 'crease') shotType = rs < 0.36 ? 'tip' : rs < 0.74 ? 'rebound' : 'backhand';
  else if (zone === 'slot') shotType = rs < 0.44 ? 'snap' : rs < 0.86 ? 'wrist' : 'backhand';
  else shotType = rs < 0.22 ? 'slap' : rs < 0.56 ? 'snap' : 'wrist';

  return {
    x: Math.round(clamp(x, 4, 96) * 10) / 10,
    y: Math.round(clamp(y, 6, 94) * 10) / 10,
    zone,
    zMult: ZONE_MULT[zone],
    shotType,
  };
}

function cloneLines(src: Record<string, PlayerGameLine>): Record<string, PlayerGameLine> {
  const out: Record<string, PlayerGameLine> = {};
  for (const k in src) out[k] = { ...src[k] };
  return out;
}

export class GameSim {
  score: [number, number] = [0, 0];
  shots: [number, number] = [0, 0];
  stats: [TeamGameStats, TeamGameStats] = [this.blank(), this.blank()];
  events: GameEvent[] = [];
  scorers: ScoringPlay[] = [];
  shotMap: ShotPoint[] = [];
  periodScores: [number, number][] = [];
  lines: Record<string, PlayerGameLine> = {};
  goalies: [string | null, string | null] = [null, null];
  tactics: [TeamTactics, TeamTactics];
  timeoutUsed: [boolean, boolean] = [false, false];
  focusUntil: [number, number] = [0, 0];
  unansweredGoals: [number, number] = [0, 0];
  forceEmptyNet: [boolean, boolean] = [false, false];
  /** side controlled by the manager (its bench decisions come from the UI); null = both benches are AI */
  userSide: TI | null = null;
  /** playing three forward lines only: leaders get more ice time and tire later in the game */
  shortBench: [boolean, boolean] = [false, false];
  private shortSince: [number, number] = [0, 0];
  /** AI bench decisions already taken this game (so each happens once) */
  private aiDone = new Set<string>();
  /** an automatic empty net has been announced in the play-by-play */
  private enShown: [boolean, boolean] = [false, false];
  /**
   * Penalties of each team, each with its own clock (IIHF/KHL): two at once make it 3-on-5, a third waits
   * until one of them ends; a power-play goal frees one minor.
   */
  pens: [Pen[], Pen[]] = [[], []];
  /** 10-minute misconducts: the player sits, the team stays at full strength */
  misconducts: [Pen[], Pen[]] = [[], []];
  /** the last event carried the penalty box (so an empty box is reported once when it clears) */
  private boxShown = false;
  period = 0;
  sec = 0;
  status: 'playing' | 'ot' | 'so' | 'done' = 'playing';
  hadSO = false;
  /** the manager's first three shootout shooters per side (null = the bench picks the best shooters) */
  soOrder: [string[] | null, string[] | null] = [null, null];
  private unitIdx: [number, number] = [0, 0];
  private blockKind: BlockKind = 'reg';
  private blockStart = 0;
  private teamOf: Record<string, TI> = {};
  private snaps = new WeakMap<GameEvent, SimSnap>();
  private curBlockMeta: ActiveBlockMeta | null = null;

  constructor(
    public home: SimTeam,
    public away: SimTeam,
    public P: Record<string, Player>,
    public playoff = false,
    public derby: DerbyInfo | null = null
  ) {
    this.goalies = [home.lineup.starterG || null, away.lineup.starterG || null];
    this.tactics = [
      home.tactics ? { ...defaultTactics(), ...home.tactics } : defaultTactics(),
      away.tactics ? { ...defaultTactics(), ...away.tactics } : defaultTactics(),
    ];
  }

  team(i: TI): SimTeam {
    return i === 0 ? this.home : this.away;
  }
  setLineup(i: TI, lineup: Lineup) {
    if (i === 0) this.home = { ...this.home, lineup };
    else this.away = { ...this.away, lineup };
    this.units.clear();
  }
  setTactics(i: TI, patch: Partial<TeamTactics>) {
    this.tactics[i] = { ...this.tactics[i], ...patch };
  }
  setForecheck(i: TI, forecheck: ForecheckStyle) {
    this.tactics[i] = { ...this.tactics[i], forecheck };
  }
  setAttackStyle(i: TI, style: AttackStyle) {
    this.tactics[i] = { ...this.tactics[i], style };
  }
  setPullGoaliePolicy(i: TI, pullGoalie: PullGoaliePolicy) {
    this.tactics[i] = { ...this.tactics[i], pullGoalie };
  }
  setForceEmptyNet(i: TI, active: boolean) {
    this.forceEmptyNet[i] = active;
  }
  /** Shorten the bench to three forward lines (true) or roll all four again. */
  setShortBench(i: TI, on: boolean) {
    if (this.shortBench[i] === on) return;
    this.shortBench[i] = on;
    this.shortSince[i] = this.sec;
  }
  useTeamTimeout(i: TI, atSec: number): boolean {
    if (this.timeoutUsed[i]) return false;
    this.timeoutUsed[i] = true;
    this.unansweredGoals[1 - i] = 0;
    this.focusUntil[i] = atSec + 300;
    return true;
  }

  /** When true no play-by-play is produced (nobody watches the game): only the box score. */
  quiet = false;
  /** Keep shot coordinates even when quiet=true (used for user team's simulated games). */
  keepShotMap = false;
  private units = new Map<string, { ids: (string | null)[]; skaters: string[]; att: number; def: number }>();

  private captureSnap(): SimSnap {
    return {
      score: [this.score[0], this.score[1]],
      shots: [this.shots[0], this.shots[1]],
      stats: [{ ...this.stats[0] }, { ...this.stats[1] }],
      scorersLen: this.scorers.length,
      shotMapLen: this.shotMap.length,
      lines: cloneLines(this.lines),
      pens: [this.pens[0].map((x) => ({ ...x })), this.pens[1].map((x) => ({ ...x }))],
      misconducts: [this.misconducts[0].map((x) => ({ ...x })), this.misconducts[1].map((x) => ({ ...x }))],
      boxShown: this.boxShown,
      unitIdx: [this.unitIdx[0], this.unitIdx[1]],
      unansweredGoals: [this.unansweredGoals[0], this.unansweredGoals[1]],
      timeoutUsed: [this.timeoutUsed[0], this.timeoutUsed[1]],
      focusUntil: [this.focusUntil[0], this.focusUntil[1]],
      tactics: [{ ...this.tactics[0] }, { ...this.tactics[1] }],
      shortBench: [this.shortBench[0], this.shortBench[1]],
      shortSince: [this.shortSince[0], this.shortSince[1]],
      aiDone: [...this.aiDone],
      enShown: [this.enShown[0], this.enShown[1]],
    };
  }

  private restoreSnap(s: SimSnap) {
    this.score = [s.score[0], s.score[1]];
    this.shots = [s.shots[0], s.shots[1]];
    this.stats = [{ ...s.stats[0] }, { ...s.stats[1] }];
    this.scorers.length = s.scorersLen;
    this.shotMap.length = s.shotMapLen;
    this.lines = cloneLines(s.lines);
    this.pens = [s.pens[0].map((x) => ({ ...x })), s.pens[1].map((x) => ({ ...x }))];
    this.misconducts = [s.misconducts[0].map((x) => ({ ...x })), s.misconducts[1].map((x) => ({ ...x }))];
    this.boxShown = s.boxShown;
    this.unitIdx = [s.unitIdx[0], s.unitIdx[1]];
    this.unansweredGoals = [s.unansweredGoals[0], s.unansweredGoals[1]];
    this.timeoutUsed = [s.timeoutUsed[0], s.timeoutUsed[1]];
    this.focusUntil = [s.focusUntil[0], s.focusUntil[1]];
    // The manager's own tactical settings are always current (some are changed without a replan).
    this.tactics = [this.userSide === 0 ? this.tactics[0] : { ...s.tactics[0] }, this.userSide === 1 ? this.tactics[1] : { ...s.tactics[1] }];
    this.shortBench = [s.shortBench[0], s.shortBench[1]];
    this.shortSince = [s.shortSince[0], s.shortSince[1]];
    this.aiDone = new Set(s.aiDone);
    this.enShown = [s.enShown[0], s.enShown[1]];
  }

  /** The five (four, three) on the ice for a line and manpower situation, with its ratings. */
  private unit(i: TI, li: number, mode: Mode, useU20 = 0, n = 5) {
    const special = mode === 'pp' || mode === 'pk';
    const u20Tag = useU20 && mode === 'ev' ? `|u20:${useU20}` : '';
    const key = `${i}|${mode}|${special ? `${this.unitIdx[i] % 2}|${n}` : mode === 'ot3' ? 0 : li}${u20Tag}`;
    let u = this.units.get(key);
    if (!u) {
      const ids = this.onIce(i, li, mode, useU20, n);
      const skaters = skatersOf(ids, this.P);
      for (const id of skaters) this.teamOf[id] = i;
      u = { ids, skaters, att: this.attackOf(i, li, mode, ids) + (this.team(i).coaching?.attack ?? 0), def: this.defenseOf(i, li, mode, ids) + (this.team(i).coaching?.defense ?? 0) };
      this.units.set(key, u);
    }
    return u;
  }
  private label(i: TI): string {
    const t = this.team(i);
    return t.name ?? t.id;
  }
  /** Absolute second at which each team is back at full strength (queued penalties included). */
  private penUntil(): [number, number] {
    const last = (i: TI) => this.pens[i].reduce((m, x) => Math.max(m, x.end), 0);
    return [last(0), last(1)];
  }
  /** Penalties running at second `t`. */
  private running(i: TI, t = this.sec): Pen[] {
    return this.pens[i].filter((x) => x.start <= t && t < x.end);
  }
  /** Skaters on the ice for each team right now (5, 4 or 3). */
  men(t = this.sec): [number, number] {
    return [skatersFor(this.running(0, t).length), skatersFor(this.running(1, t).length)];
  }
  /** Earliest moment ≥ now with fewer than two penalties running: a third penalty waits for it. */
  private penSlot(i: TI): number {
    const list = this.pens[i];
    const cands = [this.sec, ...list.map((x) => x.end).filter((t) => t > this.sec)].sort((a, b) => a - b);
    for (const t of cands) if (list.filter((x) => x.start <= t && t < x.end).length < 2) return t;
    return cands[cands.length - 1];
  }
  /** Queued penalties move up when a running one ends early. */
  private reschedule(i: TI) {
    const waiting = this.pens[i].filter((x) => x.start > this.sec).sort((a, b) => a.start - b.start);
    this.pens[i] = this.pens[i].filter((x) => x.start <= this.sec);
    for (const w of waiting) {
      const start = this.penSlot(i);
      this.pens[i].push({ ...w, start, end: start + w.min * 60 });
    }
  }
  /**
   * A power-play goal ends one minor of the short-handed team — the one closest to its end. A double minor in its
   * first half restarts as a fresh two minutes; majors are served in full.
   */
  private releaseOnPPGoal(o: TI) {
    const run = this.running(o).filter((x) => x.min === 2 || x.min === 4).sort((a, b) => a.end - b.end)[0];
    if (!run) return;
    run.end = run.min === 4 && run.end - this.sec > 120 ? this.sec + 120 : this.sec;
    if (run.end > this.sec) run.min = 2;
    this.pens[o] = this.pens[o].filter((x) => x.end > this.sec);
    this.reschedule(o);
  }
  /** The penalty box as [start, end] pairs per team, for the live scoreboard and the rink. */
  private boxNow(): [[number, number][], [number, number][]] {
    return [this.pens[0].map((x): [number, number] => [x.start, x.end]), this.pens[1].map((x): [number, number] => [x.start, x.end])];
  }
  /** Minutes of goalies already replaced this game, and the second the goalie now in net came in. */
  private gMin: Record<string, number> = {};
  private gOn: [number, number] = [0, 0];
  setGoalie(i: TI, id: string | null) {
    const prev = this.goalies[i];
    if (prev && prev !== id) this.gMin[prev] = (this.gMin[prev] ?? 0) + Math.max(0, Math.round((this.sec - this.gOn[i]) / 60));
    if (prev !== id) this.gOn[i] = this.sec;
    this.goalies[i] = id;
  }
  get tied() {
    return this.score[0] === this.score[1];
  }
  blank(): TeamGameStats {
    return { shots: 0, ppGoals: 0, ppChances: 0, pim: 0, hits: 0, xg: 0, dangerShots: 0 };
  }
  line(id: string): PlayerGameLine {
    if (!this.lines[id])
      this.lines[id] = { id, goals: 0, assists: 0, plusMinus: 0, pim: 0, shots: 0, saves: 0, shotsAgainst: 0, goalsAgainst: 0, minutes: 0 };
    return this.lines[id];
  }
  private clock(): string {
    const rem = blockLen(this.blockKind) - (this.sec - this.blockStart);
    return fmtClock(Math.max(0, rem));
  }
  /** `always`: recorded even in a quiet game (the shootout series is shown in every match report). */
  private push(e: Partial<GameEvent> & { type: GameEvent['type']; text: string }, always = false) {
    if (this.quiet && !always) return;
    const ev: GameEvent = { sec: this.sec, period: this.period, time: this.clock(), team: null, ...e };
    for (const i of [0, 1] as TI[]) this.pens[i] = this.pens[i].filter((x) => x.end > this.sec);
    if (this.pens[0].length || this.pens[1].length) {
      ev.box = this.boxNow();
      this.boxShown = true;
    } else if (this.boxShown) {
      ev.box = [[], []];
      this.boxShown = false;
    }
    this.events.push(ev);
    this.snaps.set(ev, this.captureSnap());
  }

  private unitIds(i: TI, kind: 'pp' | 'pk'): (string | null)[] {
    const L = this.team(i).lineup;
    const n = kind === 'pp' ? 5 : 4;
    const primary = kind === 'pp' ? L.pp1 : L.pk1;
    const secondary = kind === 'pp' ? L.pp2 : L.pk2;
    const chosen = this.unitIdx[i] % 2 === 1 && secondary.length >= n ? secondary : primary;
    const out: (string | null)[] = [];
    for (const id of chosen) if (id && this.P[id] && !isGoalie(this.P[id]) && !out.includes(id)) out.push(id);
    const fb = [...(L.F[0] ?? []), ...(L.F[1] ?? []), ...(L.D[0] ?? []), ...(L.D[1] ?? []), ...(L.F[2] ?? [])];
    for (const id of fb) {
      if (out.length >= n) break;
      if (id && this.P[id] && !isGoalie(this.P[id]) && !out.includes(id)) out.push(id);
    }
    while (out.length < n) out.push(null);
    return out;
  }

  private onIce(i: TI, li: number, mode: Mode, useU20 = 0, n = 5): (string | null)[] {
    const L = this.team(i).lineup;
    const F = L.F[li] ?? [null, null, null];
    const D = L.D[li % 3] ?? [null, null];
    switch (mode) {
      case 'pp': {
        // 5 on 4 / 5 on 3: the whole unit; 4 on 3: three forwards and the first defenceman
        const u = this.unitIds(i, 'pp');
        return n >= 5 ? u : u.slice(0, n);
      }
      case 'pk': {
        // 4 on 5: two forwards and a pair; 3 on 5 / 3 on 4: one forward in front of the pair
        const u = this.unitIds(i, 'pk');
        return n >= 4 ? u : [u[0], u[2], u[3]];
      }
      case '4v4':
        return [F[0] ?? null, F[1] ?? null, D[0] ?? null, D[1] ?? null];
      case 'ot3': {
        const f0 = L.F[0] ?? [];
        const d0 = L.D[0] ?? [];
        return [f0[0] ?? null, f0[1] ?? null, d0[0] ?? null];
      }
      default: {
        // the extra skaters (13th forward, 7th defenceman) take a turn in place of one man of the line / pair
        const out = [F[0] ?? null, F[1] ?? null, F[2] ?? null, D[0] ?? null, D[1] ?? null];
        if (mode === 'ev' && useU20 & 1 && L.u20F && this.P[L.u20F] && !out.includes(L.u20F)) out[(useU20 >> 2) & 3] = L.u20F;
        if (mode === 'ev' && useU20 & 2 && L.u20D && this.P[L.u20D] && !out.includes(L.u20D)) out[3 + ((useU20 >> 4) & 1)] = L.u20D;
        return out;
      }
    }
  }

  /** Players of team i sitting in the penalty box right now (waiting penalties and misconducts included). */
  private inBox(i: TI, t = this.sec): Set<string> {
    const out = new Set<string>();
    for (const x of this.pens[i]) if (x.end > t) out.add(x.player);
    for (const x of this.misconducts[i]) if (x.end > t) out.add(x.player);
    return out;
  }
  /**
   * The unit as it can actually take the ice: a man in the penalty box (or an empty lineup slot) is replaced
   * by a dressed skater of the same kind — a defenceman for a defenceman — who is not out there already.
   */
  private seat(i: TI, ids: (string | null)[]): (string | null)[] {
    const box = this.inBox(i);
    const ok = (id: string | null | undefined): id is string => !!id && !!this.P[id] && !isGoalie(this.P[id]) && !box.has(id);
    if (ids.every((id) => ok(id))) return ids;
    const L = this.team(i).lineup;
    const out = ids.map((id) => (ok(id) ? id : null));
    const used = new Set(out.filter((id): id is string => !!id));
    const dPool = [...L.D.flat(), L.u20D ?? null];
    const fPool = [...L.F.flat(), L.u20F ?? null];
    const n = ids.length;
    ids.forEach((id, k) => {
      if (out[k]) return;
      const wasD = id && this.P[id] ? this.P[id].position === 'D' : n >= 4 ? k >= n - 2 : k === n - 1;
      const pool = wasD ? [...dPool, ...fPool] : [...fPool, ...dPool];
      const sub = pool.find((c) => ok(c) && !used.has(c));
      if (sub) { out[k] = sub; used.add(sub); }
    });
    return out;
  }

  private lineChemBonus(i: TI, li: number): number {
    const T = this.team(i);
    const L = T.lineup;
    const cf = calcForwardChemistry(L.F[li], this.P, T.chemGP).score;
    const cd = calcDefenseChemistry(L.D[li % 3], this.P, T.chemGP).score;
    return (0.6 * cf + 0.4 * cd - 0.5) * 0.55;
  }

  private attackOf(i: TI, li: number, mode: Mode, ids: (string | null)[]): number {
    const P = this.P;
    if (mode === 'ot3') return unitAttack(ids, 3, P);
    if (mode === 'pp') return unitAttack(ids, ids.length, P);
    if (mode === 'pk') return unitAttack(ids, ids.length, P) + 3;
    return 0.6 * lineAttack(ids.slice(0, 3), P) + 0.4 * pairAttack(ids.slice(3, 5), P) + this.lineChemBonus(i, li);
  }
  private defenseOf(o: TI, lo: number, modeO: Mode, ids: (string | null)[]): number {
    const P = this.P;
    if (modeO === 'ot3') return unitDefense(ids, 3, P);
    if (modeO === 'pk') return unitDefense(ids, ids.length, P) + 4;
    if (modeO === 'pp') return unitDefense(ids, ids.length, P) - 10;
    return 0.5 * lineDefense(ids.slice(0, 3), P) + 0.5 * pairDefense(ids.slice(3, 5), P) + this.lineChemBonus(o, lo) * 0.35;
  }

  private pickLine(i: TI, kind: BlockKind): number {
    if (kind !== 'reg') return 0;
    const w = [...F_SHARE];
    if (this.focusUntil[i] > this.sec) {
      w[0] *= 1.35;
      w[1] *= 1.15;
    }
    if (this.period === 3) {
      const diff = this.score[i] - this.score[1 - i];
      if (diff < 0 && diff >= -2) { w[0] *= 1.5; w[1] *= 1.2; w[3] *= 0.5; }
      else if (diff > 0) { w[0] *= 0.85; w[2] *= 1.1; w[3] *= 1.15; }
    }
    if (this.shortBench[i]) {
      w[3] = 0;
      w[0] *= 1.12;
      w[1] *= 1.06;
    }
    return pickWeighted([0, 1, 2, 3], (x) => w[x]) ?? 0;
  }

  private benchTired(i: TI): boolean {
    return this.shortBench[i] && this.sec - this.shortSince[i] > 600;
  }

  /**
   * Bench decisions of the AI coach(es): a timeout to stop the opponent's run or to set up the
   * six-on-five, and the late-game switch to pressing (trailing) or to a protective shell (leading).
   */
  private aiBench(dur: number, t: number) {
    const left = dur - t;
    for (const i of [0, 1] as TI[]) {
      if (this.userSide === i) continue;
      const o = (1 - i) as TI;
      const diff = this.score[i] - this.score[o];
      const tag = (k: string) => `${i}:${k}`;
      const note = (text: string) => this.push({ type: 'info', team: this.team(i).id, penUntil: this.penUntil(), score: [this.score[0], this.score[1]], text });
      // 1. Timeout to break the opponent's momentum.
      const run = tag(`run${this.score[o]}`);
      if (!this.timeoutUsed[i] && this.unansweredGoals[o] >= 2 && (diff <= -2 || (this.period >= 2 && diff <= -1)) && !this.aiDone.has(run)) {
        this.aiDone.add(run);
        if (Math.random() < 0.5 && this.useTeamTimeout(i, this.sec)) {
          note(`⏱ Тайм-аут «${this.label(i)}»: тренер останавливает игру, чтобы сбить натиск соперника.`);
          continue;
        }
      }
      // 2. A goalie change at the intermission: a bad night (too many goals on too few shots) or a worn-out goalie.
      if (t === 0 && this.period >= 2 && !this.aiDone.has(tag('goalie'))) {
        const gid = this.goalies[i], backup = this.team(i).lineup.backupG;
        if (gid && backup && backup !== gid && this.P[backup] && !this.P[backup].injury) {
          const gl = this.line(gid), sv = gl.shotsAgainst ? gl.saves / gl.shotsAgainst : 1;
          const bad = gl.goalsAgainst >= 5 || (gl.goalsAgainst >= 4 && sv < 0.87) || (gl.goalsAgainst >= 3 && sv < 0.8);
          const spent = this.period === 3 && goalieFreshness(this.P[gid]) < 40 && goalieFreshness(this.P[backup]) >= 70 && gl.shotsAgainst >= 18 && diff <= 0;
          if (bad || spent) {
            this.aiDone.add(tag('goalie'));
            this.setGoalie(i, backup);
            note(`🔄 «${this.label(i)}» меняет вратаря: в воротах ${this.P[backup].name} вместо ${this.P[gid]?.name ?? 'стартового'} (${bad ? `${gl.goalsAgainst} шайб после ${gl.shotsAgainst} бросков` : 'стартовый вратарь выдохся'}).`);
            continue;
          }
        }
      }
      if (this.period !== 3) continue;
      // 3. Timeout before pulling the goalie in a close game.
      const pullSec = PULL_GOALIE_INFO[this.tactics[i].pullGoalie].secondsLeft;
      if (!this.timeoutUsed[i] && diff < 0 && diff >= -2 && pullSec > 0 && left <= pullSec + 40 && left > pullSec - 40) {
        this.useTeamTimeout(i, this.sec);
        note(`⏱ Тайм-аут «${this.label(i)}» перед концовкой — тренер готовит игру в большинстве с шестым полевым.`);
        continue;
      }
      // 4. Late game shape.
      if (left <= 420 && diff < 0 && diff >= -2 && !this.aiDone.has(tag('press'))) {
        this.aiDone.add(tag('press'));
        this.tactics[i] = { ...this.tactics[i], forecheck: 'aggressive', style: 'shoot' };
        note(`«${this.label(i)}» бросается в атаку: агрессивный форчек и броски с любых позиций.`);
      } else if (left <= 360 && diff === 1 && !this.aiDone.has(tag('protect'))) {
        this.aiDone.add(tag('protect'));
        this.tactics[i] = { ...this.tactics[i], forecheck: 'trap' };
        this.setShortBench(i, true);
        note(`«${this.label(i)}» закрывается: ловушка в средней зоне и три звена на концовку.`);
      }
    }
  }

  simPeriod(): GameEvent[] {
    const ev = this.simBlock('reg');
    if (this.period >= 3) this.status = this.tied ? 'ot' : 'done';
    return ev;
  }
  simOT(): GameEvent[] {
    const ev = this.playoff ? this.simBlock('ot5') : this.simBlock('ot3');
    this.status = this.tied ? (this.playoff ? 'ot' : 'so') : 'done';
    return ev;
  }
  simShootout(): GameEvent[] {
    this.hadSO = true;
    const ev = this.simSO();
    this.status = 'done';
    return ev;
  }
  runAll() {
    this.simPeriod();
    this.simPeriod();
    this.simPeriod();
    let guard = 0;
    while (this.status !== 'done' && guard++ < 30) {
      if (this.status === 'ot') this.simOT();
      else this.simShootout();
    }
    if (this.status !== 'done') {
      this.score[Math.random() < 0.5 ? 0 : 1]++;
      this.status = 'done';
    }
    return this.result();
  }

  /**
   * Live mid-period coaching intervention: keeps all revealed events of the active period untouched,
   * applies the manager's tactical / goalie / timeout action at `currentClockSec`, and re-simulates
   * only the remaining shifts of the period.
   */
  replanLivePeriod(
    revealedPeriodEvents: GameEvent[],
    currentClockSec: number,
    teamId: string,
    applyAction: () => string | null
  ): GameEvent[] | null {
    const meta = this.curBlockMeta;
    if (this.quiet || !meta || meta.kind === 'so' || revealedPeriodEvents.length === 0) return null;
    const lastEv = revealedPeriodEvents[revealedPeriodEvents.length - 1];
    const snap = this.snaps.get(lastEv);
    if (!snap) return null;

    this.restoreSnap(snap);
    this.events.length = meta.startEventIdx + revealedPeriodEvents.length;
    this.periodScores.length = Math.max(0, this.period - 1);
    this.blockKind = meta.kind;
    this.blockStart = meta.blockStart;

    const clampedSec = clamp(Math.floor(currentClockSec), meta.blockStart, meta.blockStart + meta.dur - 1);
    this.sec = Math.max(lastEv.sec, clampedSec);

    const note = applyAction();
    if (note) {
      this.push({
        type: 'info',
        team: teamId,
        penUntil: this.penUntil(),
        score: [this.score[0], this.score[1]],
        text: note,
      });
    }

    const nextT = (Math.floor(Math.max(0, this.sec - meta.blockStart) / SHIFT) + 1) * SHIFT;
    this.runShiftsFrom(meta.kind, meta.dur, nextT, meta.s0);

    if (meta.kind === 'reg') {
      if (this.period >= 3) this.status = this.tied ? 'ot' : 'done';
      else this.status = 'playing';
    } else {
      this.status = this.tied ? (this.playoff ? 'ot' : 'so') : 'done';
    }
    return this.events.slice(meta.startEventIdx);
  }

  private simBlock(kind: BlockKind): GameEvent[] {
    const start = this.events.length;
    const period = ++this.period;
    const dur = blockLen(kind);
    const s0: [number, number] = [this.score[0], this.score[1]];
    this.blockKind = kind;
    this.blockStart = this.sec;
    if (!this.quiet) {
      this.curBlockMeta = { kind, dur, startEventIdx: start, s0, blockStart: this.blockStart };
    }
    if (period === 1 && this.derby && !this.quiet) {
      this.push({
        type: 'info',
        text: `🔥 ${this.derby.title}! ${this.derby.subtitle} — аншлаг на трибунах!`,
      });
    }
    this.push({ type: 'period_start', text: `${periodName(period, kind)} начался` });
    this.runShiftsFrom(kind, dur, 0, s0);
    return this.events.slice(start);
  }

  private runShiftsFrom(kind: BlockKind, dur: number, startT: number, s0: [number, number]) {
    const period = this.period;
    let ended = false;
    for (let t = startT; t < dur && !ended; t += SHIFT) {
      const sec = this.blockStart + t;
      this.sec = sec;
      if (kind === 'reg') this.aiBench(dur, t);
      const li: [number, number] = [this.pickLine(0, kind), this.pickLine(1, kind)];
      const u20Shift: [number, number] = [kind === 'reg' ? extraShift(li[0]) : 0, kind === 'reg' ? extraShift(li[1]) : 0];
      const situation = (): { modes: [Mode, Mode]; ice: [(string | null)[], (string | null)[]]; men: [number, number] } => {
        // Overtime 3-on-3 ignores penalties; regulation and the playoff 5-on-5 overtime count every man in the box.
        const men: [number, number] = kind === 'ot3' ? [3, 3] : this.men();
        const modeOf = (i: TI): Mode => {
          if (kind === 'ot3') return 'ot3';
          const me = men[i], them = men[1 - i];
          if (me > them) return 'pp';
          if (me < them) return 'pk';
          return me === 5 ? (kind === 'ot5' ? 'ot5' : 'ev') : me === 4 ? '4v4' : 'ot3';
        };
        const modes: [Mode, Mode] = [modeOf(0), modeOf(1)];
        const ice: [(string | null)[], (string | null)[]] = [
          this.seat(0, this.unit(0, li[0], modes[0], u20Shift[0], men[0]).ids),
          this.seat(1, this.unit(1, li[1], modes[1], u20Shift[1], men[1]).ids),
        ];
        return { modes, ice, men };
      };
      let { modes, ice, men } = situation();
      let emptyNet: TI | -1 = -1;
      if (this.forceEmptyNet[0]) emptyNet = 0;
      else if (this.forceEmptyNet[1]) emptyNet = 1;
      else if (kind === 'reg' && period === 3) {
        const diff = Math.abs(this.score[0] - this.score[1]);
        if (diff >= 1 && diff <= 2) {
          const trailing: TI = this.score[0] < this.score[1] ? 0 : 1;
          const pullSec = PULL_GOALIE_INFO[this.tactics[trailing].pullGoalie].secondsLeft;
          if (pullSec > 0 && dur - t <= pullSec) emptyNet = trailing;
        }
      }
      for (const side of [0, 1] as TI[]) {
        const auto = emptyNet === side && !this.forceEmptyNet[side];
        if (auto && !this.enShown[side]) {
          this.enShown[side] = true;
          this.push({ type: 'info', team: this.team(side).id, penUntil: this.penUntil(), score: [this.score[0], this.score[1]], text: `⚡ «${this.label(side)}» снимает вратаря — шестой полевой игрок!` });
        } else if (!auto && this.enShown[side] && !this.forceEmptyNet[side]) {
          this.enShown[side] = false;
          if (this.status !== 'done') this.push({ type: 'info', team: this.team(side).id, penUntil: this.penUntil(), score: [this.score[0], this.score[1]], text: `Вратарь «${this.label(side)}» возвращается в ворота.` });
        }
      }

      const order: TI[] = Math.random() < 0.5 ? [0, 1] : [1, 0];
      for (let k = 0; k < order.length; k++) {
        const i = order[k];
        this.sec = sec + (k === 0 ? 1 + Math.floor(Math.random() * 14) : 16 + Math.floor(Math.random() * 12));
        ({ modes, ice, men } = situation());
        const r = this.tryShot(i, (1 - i) as TI, kind, ice, modes, emptyNet, li, u20Shift, men);
        if (kind !== 'reg' && r === 'goal') {
          ended = true;
          break;
        }
      }
      if (ended) {
        this.sec += 4;
        break;
      }

      const fc0 = FORECHECK_INFO[this.tactics[0].forecheck];
      const fc1 = FORECHECK_INFO[this.tactics[1].forecheck];
      const penChance = PENALTY_RATE * 0.5 * (fc0.penMult + fc1.penMult) * (this.derby?.penMult ?? 1);
      if (kind === 'reg' && Math.random() < penChance) {
        const pi: TI = Math.random() < 0.5 * (fc0.penMult / ((fc0.penMult + fc1.penMult) * 0.5)) ? 0 : 1;
        this.sec = sec + 29 + Math.floor(Math.random() * 5);
        ({ modes, ice, men } = situation());
        this.takePenalty(pi, ice[pi]);
      }

      const hitChance = 0.14 * 0.5 * (fc0.hitMult + fc1.hitMult) * (this.derby?.hitMult ?? 1);
      if (Math.random() < hitChance) {
        const hi: TI = Math.random() < 0.5 ? 0 : 1;
        this.sec = sec + 35 + Math.floor(Math.random() * 5);
        this.takeHit(hi, ice[hi], ice[1 - hi]);
      }
    }
    if (!ended) this.sec = this.blockStart + dur;
    else this.sec = Math.min(this.blockStart + dur, this.sec);
    this.periodScores.push([this.score[0] - s0[0], this.score[1] - s0[1]]);
    this.push({
      type: 'period_end',
      text: `${periodName(period, kind)} завершён. Счёт ${this.score[0]}:${this.score[1]}`,
      score: [this.score[0], this.score[1]],
    });
  }

  private tryShot(
    i: TI,
    o: TI,
    kind: BlockKind,
    ice: [(string | null)[], (string | null)[]],
    modes: [Mode, Mode],
    emptyNet: TI | -1,
    li: [number, number],
    u20Shift: [number, number],
    men: [number, number] = [5, 5]
  ): 'none' | 'goal' | 'shot' {
    const mine = this.unit(i, li[i], modes[i], u20Shift[i], men[i]);
    const theirs = this.unit(o, li[o], modes[o], u20Shift[o], men[o]);
    /** +2 = five on three, −2 = three on five */
    const adv = men[i] - men[o];
    const skaters = mine.skaters;
    const oppSkaters = theirs.skaters;
    if (!skaters.length) return 'none';
    const mode = modes[i];
    const onPP = mode === 'pp';
    const onSH = mode === 'pk';

    const clutch = kind !== 'reg' || this.playoff || !!this.derby || (this.period === 3 && Math.abs(this.score[0] - this.score[1]) <= 1);
    const att = mine.att + (clutch ? (this.team(i).leadershipBonus ?? 0) : 0);
    const def = theirs.def + (clutch ? (this.team(o).leadershipBonus ?? 0) * 0.6 : 0);

    const fcI = FORECHECK_INFO[this.tactics[i].forecheck];
    const fcO = FORECHECK_INFO[this.tactics[o].forecheck];
    const stI = ATTACK_STYLE_INFO[this.tactics[i].style];

    let pShot = 0.33 + (att - def) * 0.0035;
    pShot *= i === 0 ? HOME_EDGE : 2 - HOME_EDGE;
    pShot *= fcI.shotMult * fcO.oppShotMult * stI.shotMult;
    if (this.focusUntil[i] > this.sec) pShot *= 1.07;
    if (this.unansweredGoals[i] >= 2) pShot *= 1.04;
    if (onPP) pShot *= PP_SHOT * (adv >= 2 ? 1.22 : 1);
    if (onSH) pShot *= adv <= -2 ? 0.42 : 0.6;
    if (mode === '4v4') pShot *= 1.1;
    if (mode === 'ot3') pShot *= 1.3;
    if (emptyNet === i) pShot *= 1.18;
    if (emptyNet === o) pShot *= 1.1;
    // Three lines for a long time: the legs go.
    if (this.benchTired(i)) pShot *= 0.96;
    if (this.benchTired(o)) pShot *= 1.04;
    pShot = clamp(pShot, 0.1, 0.64);
    if (Math.random() > pShot) return 'none';

    const shooter = pickWeighted(skaters, (id) => {
      const p = this.P[id];
      const sh = p.skills.shooting ?? 60;
      return p.position === 'D' ? Math.pow(sh / 60, 3) * 0.45 : Math.pow(sh / 55, 3.2);
    });
    if (!shooter) return 'none';
    const sp = this.P[shooter];
    this.shots[i]++;
    this.stats[i].shots++;
    this.line(shooter).shots++;

    const goalieId = emptyNet === o ? null : this.goalies[o];
    const g = goalieId ? this.P[goalieId] : null;
    const gEffOvr = g ? effectiveGoalieOvr(g, this.team(o).roadStreak ?? 0) + (this.team(o).coaching?.goalie ?? 0) : 55;
    let sv = goalieSavePct(gEffOvr) + ((g?.skills.endurance ?? 70) - 70) * 0.0003;
    const sa = goalieId ? this.line(goalieId).shotsAgainst : this.shots[i];
    if (sa > 22) sv -= Math.min(0.012, (sa - 22) * 0.0005);
    let q = 1 + ((sp.skills.shooting ?? 65) - 70) * 0.006;
    q *= fcI.xgMult * fcO.oppXgMult * stI.xgMult;
    if (this.focusUntil[i] > this.sec) q *= 1.05;
    if (onPP) q *= PP_QUALITY * (adv >= 2 ? 1.3 : 1) * (1 + (this.team(i).coaching?.special ?? 0)) / (1 + (this.team(o).coaching?.special ?? 0));
    if (onSH) q *= adv <= -2 ? 0.7 : 0.75;
    if (mode === '4v4' || mode === 'ot3') q *= 1.1;

    const geo = generateShotGeometry(i, sp, onPP, mode, emptyNet === o, this.tactics[i].style);
    const avgSv = goalieSavePct(77);
    const rawXg = emptyNet === o ? 0.32 : clamp((1 - avgSv) * q * geo.zMult, 0.006, 0.42);
    const xg = Math.round(rawXg * 1000) / 1000;
    const pGoal = emptyNet === o ? 0.32 : clamp((1 - sv) * q * geo.zMult, 0.006, 0.42);
    const goal = Math.random() < pGoal;
    const strength: Strength = emptyNet === o ? 'EN' : onPP ? 'PP' : onSH ? 'SH' : mode === '4v4' || (mode === 'ot3' && kind !== 'ot3') ? '4v4' : 'EV';
    const teamId = this.team(i).id;
    const liTuple: [number, number] = [li[0], li[1]];
    const time = this.clock();

    this.stats[i].xg = Math.round(((this.stats[i].xg ?? 0) + xg) * 1000) / 1000;
    if (xg >= 0.12) this.stats[i].dangerShots = (this.stats[i].dangerShots ?? 0) + 1;

    if (!this.quiet || this.keepShotMap) {
      const outcome: ShotPoint['outcome'] = goal ? 'goal' : goalieId ? 'save' : 'miss';
      this.shotMap.push({
        t: i,
        player: shooter,
        period: this.period,
        time,
        x: geo.x,
        y: geo.y,
        xg,
        outcome,
        zone: geo.zone,
        strength,
        shotType: geo.shotType,
      });
    }

    if (goal) {
      this.score[i]++;
      this.unansweredGoals[i]++;
      this.unansweredGoals[o] = 0;
      if (this.forceEmptyNet[i] && this.score[i] >= this.score[o]) this.forceEmptyNet[i] = false;
      if (onPP) {
        this.stats[i].ppGoals++;
        this.releaseOnPPGoal(o);
      }
      this.line(shooter).goals++;
      const others = skaters.filter((id) => id !== shooter);
      const assists: string[] = [];
      const a1 = Math.random() < 0.93 ? pickWeighted(others, (id) => 0.3 + (this.P[id].skills.passing ?? 60) / 60) : null;
      if (a1) {
        assists.push(a1);
        const rest = others.filter((id) => id !== a1);
        const a2 = Math.random() < 0.72 ? pickWeighted(rest, (id) => 0.3 + (this.P[id].skills.passing ?? 60) / 60) : null;
        if (a2) assists.push(a2);
      }
      if (strength === 'EV' || strength === '4v4') {
        for (const id of skaters) this.line(id).plusMinus++;
        for (const id of oppSkaters) this.line(id).plusMinus--;
      } else if (strength === 'SH') {
        for (const id of skaters) this.line(id).plusMinus++;
      }
      for (const a of assists) this.line(a).assists++;
      if (goalieId) {
        const gl = this.line(goalieId);
        gl.shotsAgainst++;
        gl.goalsAgainst++;
      }
      this.scorers.push({ period: this.period, time, team: teamId, scorer: shooter, assists, strength });
      const shotType = geo.shotType;
      const label = onPP ? ' — в большинстве' : onSH ? ' — в меньшинстве' : emptyNet === o ? ' — пустые ворота!' : '';
      this.push({
        type: 'goal',
        team: teamId,
        player: shooter,
        players: assists,
        strength,
        shotType,
        x: geo.x,
        y: geo.y,
        xg,
        zone: geo.zone,
        score: [this.score[0], this.score[1]],
        lines: liTuple,
        goalie: goalieId,
        pp: onPP,
        penUntil: this.penUntil(),
        ice: [ice[0], ice[1]],
        text: `ГОЛ! ${sp.name}${assists.length ? ` (${assists.map((a) => this.P[a]?.name).join(', ')})` : ''}${label}`,
      });
      return 'goal';
    }
    if (goalieId) {
      const gl = this.line(goalieId);
      gl.shotsAgainst++;
      gl.saves++;
      if (!this.quiet)
        this.push({
          type: 'shot',
          team: teamId,
          player: shooter,
          shotType: geo.shotType,
          strength,
          x: geo.x,
          y: geo.y,
          xg,
          zone: geo.zone,
          lines: liTuple,
          goalie: goalieId,
          ice: [ice[0], ice[1]],
          text: `Бросок ${sp.name} — сейв ${g?.name ?? ''}`,
        });
    } else {
      this.push({
        type: 'miss',
        team: teamId,
        player: shooter,
        shotType: geo.shotType,
        strength,
        x: geo.x,
        y: geo.y,
        xg,
        zone: geo.zone,
        lines: liTuple,
        goalie: null,
        ice: [ice[0], ice[1]],
        text: `Бросок ${sp.name} — мимо пустых ворот (${this.label(o)})`,
      });
    }
    return 'shot';
  }

  private takePenalty(i: TI, ice: (string | null)[]) {
    const skaters = skatersOf(ice, this.P);
    const p = pickWeighted(skaters, (id) => 0.5 + (this.P[id].skills.checking ?? 60) / 50);
    if (!p) return;
    const r = Math.random();
    let min = 2;
    let type = pick(MINOR);
    let misconduct = false;
    if (r < 0.02) {
      misconduct = true;
      min = 10;
      type = 'грубость (10 минут)';
    } else if (r < 0.07) {
      min = 4;
      type = 'удар клюшкой (двойной малый)';
    } else if (r < 0.14) {
      min = 5;
      type = pick(MAJOR);
    }
    this.line(p).pim += min;
    this.stats[i].pim += min;
    const teamId = this.team(i).id;
    let boxUntil = this.sec + min * 60;
    let note = '';
    if (misconduct) this.misconducts[i] = [...this.misconducts[i].filter((x) => x.end > this.sec), { player: p, min, start: this.sec, end: boxUntil }];
    else {
      this.pens[i] = this.pens[i].filter((x) => x.end > this.sec);
      const start = this.penSlot(i);
      boxUntil = start + min * 60;
      this.pens[i].push({ player: p, min, start, end: boxUntil });
      this.stats[1 - i].ppChances++;
      this.unitIdx[1 - i]++;
      const m = this.men();
      if (start > this.sec) note = ` Штраф начнётся, когда закончится одно из удалений — «${this.label(i)}» до тех пор втроём.`;
      else if (m[i] === 3) note = ` «${this.label(i)}» остаётся втроём: ${m[1 - i]} на 3!`;
    }
    this.push({ type: 'penalty', team: teamId, player: p, pim: min, pp: !misconduct, penUntil: this.penUntil(), boxUntil, text: `Штраф ${min} мин: ${this.P[p].name} (${this.label(i)}) — ${type}${note ? `.${note}` : ''}` });
  }

  private takeHit(i: TI, iceI: (string | null)[], iceO: (string | null)[]) {
    const a = pickWeighted(skatersOf(iceI, this.P), (id) => 0.4 + (this.P[id].skills.checking ?? 60) / 50);
    const v = pick(skatersOf(iceO, this.P));
    if (!a || !v) return;
    this.stats[i].hits++;
    if (!this.quiet) this.push({ type: 'hit', team: this.team(i).id, player: a, players: [v], text: `Силовой приём: ${this.P[a].name} против ${this.P[v].name}` });
  }

  /** Skaters dressed for the shootout, best shooters first (the manager's picker and the AI order use it). */
  shootoutCandidates(i: TI): string[] {
    const L = this.team(i).lineup;
    const ids = skatersOf([...L.F.flat(), ...L.D.flat(), L.u20F ?? null, L.u20D ?? null], this.P).filter((id) => !this.P[id].injury || this.P[id].playingThroughInjury);
    return [...new Set(ids)].sort((a, b) => shootoutSkill(this.P[b]) - shootoutSkill(this.P[a]));
  }

  /**
   * KHL shootout: three different shooters per team; it stops as soon as one side can no longer catch up. Still level
   * after three rounds, it goes on one pair at a time (any skater may shoot again) until a round is won.
   */
  private simSO(): GameEvent[] {
    const start = this.events.length;
    this.period++;
    this.blockKind = 'so';
    this.blockStart = this.sec;
    this.push({ type: 'period_start', text: 'Начинается серия буллитов: по три броска, при равенстве — по одному до первого промаха' });
    const order = ([0, 1] as TI[]).map((i) => {
      const all = this.shootoutCandidates(i);
      const picked = (this.soOrder[i] ?? []).filter((id, k, arr) => all.includes(id) && arr.indexOf(id) === k).slice(0, 3);
      return [...picked, ...all.filter((id) => !picked.includes(id))];
    });
    const so: [number, number] = [0, 0];
    const taken: [number, number] = [0, 0];
    const attempt = (i: TI, round: number) => {
      const list = order[i];
      // Sudden death: the next best shooters, round after round (repeats allowed once everybody has shot).
      const sh = list.length ? list[(round - 1) % list.length] : null;
      const gid = this.goalies[1 - i];
      const g = gid ? this.P[gid] : null;
      taken[i]++;
      if (!sh) return false;
      const sp = this.P[sh];
      const gOvr = g ? effectiveGoalieOvr(g, this.team((1 - i) as TI).roadStreak ?? 0) + (this.team((1 - i) as TI).coaching?.goalie ?? 0) : 55;
      const lead = (this.team(i).leadershipBonus ?? 0) * 0.008;
      const pr = clamp(0.27 + lead + (shootoutSkill(sp) - 70) * 0.0055 - (gOvr - 70) * 0.0035, 0.12, 0.6);
      const ok = Math.random() < pr;
      if (ok) so[i]++;
      const how = ok ? pick(['ЗАБИВАЕТ финтом', 'ЗАБИВАЕТ кистевым', 'ЗАБИВАЕТ под перекладину', 'ЗАБИВАЕТ между щитков', 'ЗАБИВАЕТ с бэкхенда']) : pick(['вратарь берёт бросок', 'щиток вратаря', 'мимо ворот', 'штанга!', 'вратарь не купился на финт']);
      this.push({
        type: ok ? 'so_goal' : 'so_miss', team: this.team(i).id, player: sh, goalie: gid ?? null, round,
        time: `${round}-й раунд`, so: [so[0], so[1]],
        text: `Буллит, ${round}-й раунд: ${sp.name} — ${how}${g ? ` (${g.name})` : ''}. Серия ${so[0]}:${so[1]}`,
      }, true);
      return ok;
    };
    // The first three rounds, ended early once the result cannot change.
    const decided = () => so[0] > so[1] + (3 - taken[1]) || so[1] > so[0] + (3 - taken[0]);
    for (let r = 1; r <= 3 && !decided(); r++) {
      attempt(0, r);
      if (decided()) break;
      attempt(1, r);
    }
    let round = 4;
    while (so[0] === so[1] && round < 200) {
      attempt(0, round);
      attempt(1, round);
      round++;
    }
    const w: TI = so[0] > so[1] ? 0 : 1;
    this.score[w]++;
    this.periodScores.push([so[0], so[1]]);
    this.push({ type: 'period_end', text: `Буллиты ${so[0]}:${so[1]}. Победа ${this.label(w)} — ${this.score[0]}:${this.score[1]}`, score: [this.score[0], this.score[1]], so: [so[0], so[1]] }, true);
    return this.events.slice(start);
  }

  private computeStars(winner: TI): string[] {
    const cand: { id: string; v: number; ti: TI }[] = [];
    for (const id in this.lines) {
      const l = this.lines[id];
      const p = this.P[id];
      if (!p) continue;
      const ti = this.teamOf[id] ?? (isGoalie(p) ? (this.goalies[0] === id ? 0 : 1) : 0);
      const won = ti === winner;
      let v = 0;
      if (isGoalie(p)) v = l.saves * 0.12 - l.goalsAgainst * 0.6 + (won ? 2 : 0) + (won && l.goalsAgainst === 0 ? 2 : 0);
      else {
        v = l.goals * 2 + l.assists + l.plusMinus * 0.3 + l.shots * 0.1 + (won ? 0.5 : 0);
        if (l.goals >= 3) v += 2;
      }
      if (l.goals + l.assists + l.saves > 0) cand.push({ id, v, ti });
    }
    cand.sort((a, b) => b.v - a.v);
    if (cand.length > 1 && cand[0].ti !== winner) {
      const i = cand.findIndex((c) => c.ti === winner);
      if (i > 0) {
        const [c] = cand.splice(i, 1);
        cand.unshift(c);
      }
    }
    return cand.slice(0, 3).map((c) => c.id);
  }

  result(): GameResult {
    const [h, a] = this.score;
    const winner: TI = h > a ? 0 : 1;
    const mins = this.hadSO ? 65 : Math.min(65, Math.round(this.sec / 60));
    for (const [id, m] of Object.entries(this.gMin)) this.line(id).minutes = m;
    for (const i of [0, 1] as TI[]) {
      const gid = this.goalies[i];
      if (gid) this.line(gid).minutes = (this.gMin[gid] ?? 0) + Math.max(0, mins - Math.round(this.gOn[i] / 60));
    }
    const dressed = (st: SimTeam) =>
      [...st.lineup.F.flat(), ...st.lineup.D.flat(), st.lineup.u20F, st.lineup.u20D, st.lineup.starterG, st.lineup.backupG].filter(
        (x): x is string => !!x
      );
    for (const id of [...dressed(this.home), ...dressed(this.away)]) this.line(id);
    return {
      home: this.home.id,
      away: this.away.id,
      homeScore: h,
      awayScore: a,
      ot: this.period > 3 && !this.hadSO,
      so: this.hadSO,
      periods: this.period,
      periodScores: this.periodScores,
      homeStats: this.stats[0],
      awayStats: this.stats[1],
      events: this.events,
      scorers: this.scorers,
      lines: this.lines,
      homeGoalie: this.goalies[0],
      awayGoalie: this.goalies[1],
      homeDressed: dressed(this.home),
      awayDressed: dressed(this.away),
      stars: this.computeStars(winner),
      shotMap: this.shotMap.length ? this.shotMap : undefined,
    };
  }
}
