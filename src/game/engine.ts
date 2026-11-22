import type { GameEvent, GameResult, Lineup, Player, PlayerGameLine, ScoringPlay, ShotPoint, ShotZone, Strength, TeamGameStats } from '../types';
import { clamp, goalieSavePct, isGoalie, lineAttack, lineDefense, pairAttack, pairDefense, unitAttack, unitDefense } from './ratings';

export interface SimTeam {
  id: string;
  lineup: Lineup;
  /** club name used in commentary (as written in the roster) */
  name?: string;
}
type TI = 0 | 1;
type Mode = 'ev' | '4v4' | 'pp' | 'pk' | 'ot3' | 'ot5';
export type BlockKind = 'reg' | 'ot3' | 'ot5' | 'so';

const SHIFT = 40;
const F_SHARE = [0.33, 0.27, 0.22, 0.18];
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

const blockLen = (k: BlockKind) => (k === 'ot3' ? 300 : k === 'so' ? 0 : 1200);
export const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export function periodName(period: number, kind: BlockKind): string {
  if (kind === 'so') return 'Буллиты';
  if (period <= 3) return `${period}-й период`;
  if (kind === 'ot3') return 'Овертайм';
  return period === 4 ? 'Овертайм' : `${period - 3}-й овертайм`;
}

const skatersOf = (ids: (string | null)[], P: Record<string, Player>): string[] =>
  ids.filter((id): id is string => !!id && !!P[id] && !isGoalie(P[id]));

const ZONE_MULT: Record<ShotZone, number> = {
  crease: 2.04,
  slot: 1.48,
  circles: 0.96,
  point: 0.54,
  perimeter: 0.41,
};

function generateShotGeometry(
  ti: TI,
  sp: Player,
  onPP: boolean,
  mode: Mode,
  emptyNetOpp: boolean
): { x: number; y: number; zone: ShotZone; zMult: number; shotType: NonNullable<GameEvent['shotType']> } {
  if (emptyNetOpp) {
    const depth = Math.random() < 0.45 ? 48 + Math.random() * 20 : 72 + Math.random() * 15;
    const x = ti === 0 ? depth : 100 - depth;
    const y = 26 + Math.random() * 48;
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, zone: 'slot', zMult: 1, shotType: 'wrist' };
  }

  let zone: ShotZone;
  const r = Math.random();
  if (sp.position === 'D') {
    if (r < 0.03) zone = 'crease';
    else if (r < 0.15) zone = 'slot';
    else if (r < 0.37) zone = 'circles';
    else if (r < 0.9) zone = 'point';
    else zone = 'perimeter';
  } else if (onPP || mode === 'ot3') {
    if (r < 0.21) zone = 'crease';
    else if (r < 0.52) zone = 'slot';
    else if (r < 0.85) zone = 'circles';
    else if (r < 0.91) zone = 'point';
    else zone = 'perimeter';
  } else {
    if (r < 0.13) zone = 'crease';
    else if (r < 0.38) zone = 'slot';
    else if (r < 0.76) zone = 'circles';
    else if (r < 0.83) zone = 'point';
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
      depth = 69.5 + Math.random() * 6;
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
  /** absolute game second until which each team is short-handed */
  penEnd: [number, number] = [0, 0];
  /** true while the running penalty is a single minor: it ends early if the opponent scores on the power play */
  private penMinor: [boolean, boolean] = [false, false];
  period = 0;
  sec = 0;
  status: 'playing' | 'ot' | 'so' | 'done' = 'playing';
  hadSO = false;
  private unitIdx: [number, number] = [0, 0];
  private blockKind: BlockKind = 'reg';
  private blockStart = 0;
  private teamOf: Record<string, TI> = {};

  constructor(public home: SimTeam, public away: SimTeam, public P: Record<string, Player>, public playoff = false) {
    this.goalies = [home.lineup.starterG || null, away.lineup.starterG || null];
  }

  team(i: TI): SimTeam {
    return i === 0 ? this.home : this.away;
  }
  setLineup(i: TI, lineup: Lineup) {
    if (i === 0) this.home = { ...this.home, lineup };
    else this.away = { ...this.away, lineup };
    this.units.clear();
  }
  /** When true no play-by-play is produced (nobody watches the game): only the box score. */
  quiet = false;
  /** Keep shot coordinates even when quiet=true (used for user team's simulated games). */
  keepShotMap = false;
  private units = new Map<string, { ids: (string | null)[]; skaters: string[]; att: number; def: number }>();
  /** The five (four, three) on the ice for a line and manpower situation, with its ratings — computed once per game. */
  private unit(i: TI, li: number, mode: Mode) {
    const special = mode === 'pp' || mode === 'pk';
    const key = `${i}|${mode}|${special ? this.unitIdx[i] % 2 : mode === 'ot3' ? 0 : li}`;
    let u = this.units.get(key);
    if (!u) {
      const ids = this.onIce(i, li, mode);
      const skaters = skatersOf(ids, this.P);
      for (const id of skaters) this.teamOf[id] = i;
      u = { ids, skaters, att: this.attackOf(i, li, mode), def: this.defenseOf(i, li, mode) };
      this.units.set(key, u);
    }
    return u;
  }
  private label(i: TI): string {
    const t = this.team(i);
    return t.name ?? t.id;
  }
  private penUntil(): [number, number] {
    return [this.penEnd[0], this.penEnd[1]];
  }
  setGoalie(i: TI, id: string | null) {
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
  private push(e: Partial<GameEvent> & { type: GameEvent['type']; text: string }) {
    if (this.quiet) return;
    this.events.push({ sec: this.sec, period: this.period, time: this.clock(), team: null, ...e });
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

  private onIce(i: TI, li: number, mode: Mode): (string | null)[] {
    const L = this.team(i).lineup;
    const F = L.F[li] ?? [null, null, null];
    const D = L.D[li % 3] ?? [null, null];
    switch (mode) {
      case 'pp':
        return this.unitIds(i, 'pp');
      case 'pk':
        return this.unitIds(i, 'pk');
      case '4v4':
        return [F[0] ?? null, F[1] ?? null, D[0] ?? null, D[1] ?? null];
      case 'ot3': {
        const f0 = L.F[0] ?? [];
        const d0 = L.D[0] ?? [];
        return [f0[0] ?? null, f0[1] ?? null, d0[0] ?? null];
      }
      default:
        return [F[0] ?? null, F[1] ?? null, F[2] ?? null, D[0] ?? null, D[1] ?? null];
    }
  }

  private attackOf(i: TI, li: number, mode: Mode): number {
    const L = this.team(i).lineup;
    const P = this.P;
    if (mode === 'ot3') return unitAttack(this.onIce(i, 0, 'ot3'), 3, P);
    if (mode === 'pp') return unitAttack(this.unitIds(i, 'pp'), 5, P);
    if (mode === 'pk') return unitAttack(this.unitIds(i, 'pk'), 4, P) + 3;
    return 0.6 * lineAttack(L.F[li], P) + 0.4 * pairAttack(L.D[li % 3], P);
  }
  private defenseOf(o: TI, lo: number, modeO: Mode): number {
    const L = this.team(o).lineup;
    const P = this.P;
    if (modeO === 'ot3') return unitDefense(this.onIce(o, 0, 'ot3'), 3, P);
    if (modeO === 'pk') return unitDefense(this.unitIds(o, 'pk'), 4, P) + 4;
    if (modeO === 'pp') return unitDefense(this.unitIds(o, 'pp'), 5, P) - 10;
    return 0.5 * lineDefense(L.F[lo], P) + 0.5 * pairDefense(L.D[lo % 3], P);
  }

  private pickLine(i: TI, kind: BlockKind): number {
    if (kind !== 'reg') return 0;
    const w = [...F_SHARE];
    if (this.period === 3) {
      const diff = this.score[i] - this.score[1 - i];
      if (diff < 0 && diff >= -2) { w[0] *= 1.5; w[1] *= 1.2; w[3] *= 0.5; }
      else if (diff > 0) { w[0] *= 0.85; w[2] *= 1.1; w[3] *= 1.15; }
    }
    return pickWeighted([0, 1, 2, 3], (x) => w[x]) ?? 0;
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

  private simBlock(kind: BlockKind): GameEvent[] {
    const start = this.events.length;
    const period = ++this.period;
    const dur = blockLen(kind);
    const s0: [number, number] = [this.score[0], this.score[1]];
    this.blockKind = kind;
    this.blockStart = this.sec;
    this.push({ type: 'period_start', text: `${periodName(period, kind)} начался` });
    let ended = false;
    for (let t = 0; t < dur && !ended; t += SHIFT) {
      const sec = this.blockStart + t;
      this.sec = sec;
      const li: [number, number] = [this.pickLine(0, kind), this.pickLine(1, kind)];
      // Manpower is evaluated at the exact second of every event: a penalty may start, expire or be
      // cancelled by a power-play goal in the middle of a shift.
      const situation = (): { modes: [Mode, Mode]; ice: [(string | null)[], (string | null)[]] } => {
        const short0 = this.penEnd[0] > this.sec;
        const short1 = this.penEnd[1] > this.sec;
        const homePP = short1 && !short0;
        const awayPP = short0 && !short1;
        const four = short0 && short1;
        const modeOf = (i: TI): Mode => (kind === 'ot3' ? 'ot3' : kind === 'ot5' ? 'ot5' : four ? '4v4' : (i === 0 ? homePP : awayPP) ? 'pp' : (i === 0 ? awayPP : homePP) ? 'pk' : 'ev');
        const modes: [Mode, Mode] = [modeOf(0), modeOf(1)];
        const ice: [(string | null)[], (string | null)[]] = [this.unit(0, li[0], modes[0]).ids, this.unit(1, li[1], modes[1]).ids];
        return { modes, ice };
      };
      let { modes, ice } = situation();
      let emptyNet: TI | -1 = -1;
      if (kind === 'reg' && period === 3 && dur - t <= 150) {
        const diff = Math.abs(this.score[0] - this.score[1]);
        if (diff >= 1 && diff <= 2) emptyNet = this.score[0] < this.score[1] ? 0 : 1;
      }
      // Events of one shift are spread over its 40 seconds (in this order), so the feed does not tick in 40-second steps.
      const order: TI[] = Math.random() < 0.5 ? [0, 1] : [1, 0];
      for (let k = 0; k < order.length; k++) {
        const i = order[k];
        this.sec = sec + (k === 0 ? 1 + Math.floor(Math.random() * 14) : 16 + Math.floor(Math.random() * 12));
        ({ modes, ice } = situation());
        const r = this.tryShot(i, (1 - i) as TI, kind, ice, modes, emptyNet, li);
        if (kind !== 'reg' && r === 'goal') {
          ended = true;
          break;
        }
      }
      if (ended) {
        this.sec += 4;
        break;
      }
      if (kind === 'reg' && Math.random() < PENALTY_RATE) {
        const pi: TI = Math.random() < 0.5 ? 0 : 1;
        this.sec = sec + 29 + Math.floor(Math.random() * 5);
        ({ modes, ice } = situation());
        this.takePenalty(pi, ice[pi]);
      }
      if (Math.random() < 0.14) {
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
    return this.events.slice(start);
  }

  private tryShot(i: TI, o: TI, _kind: BlockKind, ice: [(string | null)[], (string | null)[]], modes: [Mode, Mode], emptyNet: TI | -1, li: [number, number]): 'none' | 'goal' | 'shot' {
    const mine = this.unit(i, li[i], modes[i]);
    const theirs = this.unit(o, li[o], modes[o]);
    const skaters = mine.skaters;
    const oppSkaters = theirs.skaters;
    if (!skaters.length) return 'none';
    const mode = modes[i];
    const onPP = mode === 'pp';
    const onSH = mode === 'pk';
    const att = mine.att;
    const def = theirs.def;
    let pShot = 0.33 + (att - def) * 0.0035;
    pShot *= i === 0 ? HOME_EDGE : 2 - HOME_EDGE; // last change and home crowd
    if (onPP) pShot *= PP_SHOT;
    if (onSH) pShot *= 0.6;
    if (mode === '4v4') pShot *= 1.1;
    if (mode === 'ot3') pShot *= 1.3;
    if (emptyNet === i) pShot *= 1.15;
    if (emptyNet === o) pShot *= 1.1;
    pShot = clamp(pShot, 0.1, 0.62);
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
    let sv = goalieSavePct(g ? g.overall : 55) + ((g?.skills.endurance ?? 70) - 70) * 0.0003;
    const sa = goalieId ? this.line(goalieId).shotsAgainst : this.shots[i];
    if (sa > 22) sv -= Math.min(0.012, (sa - 22) * 0.0005);
    let q = 1 + ((sp.skills.shooting ?? 65) - 70) * 0.006;
    if (onPP) q *= PP_QUALITY;
    if (onSH) q *= 0.75;
    if (mode === '4v4' || mode === 'ot3') q *= 1.1;

    const geo = generateShotGeometry(i, sp, onPP, mode, emptyNet === o);
    const avgSv = goalieSavePct(77);
    const rawXg = emptyNet === o ? 0.32 : clamp((1 - avgSv) * q * geo.zMult, 0.015, 0.42);
    const xg = Math.round(rawXg * 1000) / 1000;
    const pGoal = emptyNet === o ? 0.32 : clamp((1 - sv) * q * geo.zMult, 0.015, 0.42);
    const goal = Math.random() < pGoal;
    const strength: Strength = emptyNet === o ? 'EN' : onPP ? 'PP' : onSH ? 'SH' : mode === '4v4' ? '4v4' : 'EV';
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
      if (onPP) {
        this.stats[i].ppGoals++;
        // a power-play goal ends a minor penalty
        if (this.penMinor[o]) {
          this.penEnd[o] = this.sec;
          this.penMinor[o] = false;
        }
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
    if (!misconduct) {
      const serving = this.penEnd[i] > this.sec;
      this.penMinor[i] = min === 2 && !serving;
      this.penEnd[i] = (serving ? this.penEnd[i] : this.sec) + min * 60;
      this.stats[1 - i].ppChances++;
      this.unitIdx[1 - i]++;
    }
    this.push({ type: 'penalty', team: teamId, player: p, pim: min, pp: !misconduct, penUntil: this.penUntil(), text: `Штраф ${min} мин: ${this.P[p].name} (${this.label(i)}) — ${type}` });
  }

  private takeHit(i: TI, iceI: (string | null)[], iceO: (string | null)[]) {
    const a = pickWeighted(skatersOf(iceI, this.P), (id) => 0.4 + (this.P[id].skills.checking ?? 60) / 50);
    const v = pick(skatersOf(iceO, this.P));
    if (!a || !v) return;
    this.stats[i].hits++;
    if (!this.quiet) this.push({ type: 'hit', team: this.team(i).id, player: a, players: [v], text: `Силовой приём: ${this.P[a].name} против ${this.P[v].name}` });
  }

  private simSO(): GameEvent[] {
    const start = this.events.length;
    this.period++;
    this.blockKind = 'so';
    this.blockStart = this.sec;
    this.push({ type: 'period_start', text: 'Начинается серия буллитов' });
    const shooters = ([0, 1] as TI[]).map((i) => {
      const L = this.team(i).lineup;
      const ids = skatersOf([...(L.F[0] ?? []), ...(L.F[1] ?? []), ...(L.D[0] ?? [])], this.P);
      return [...new Set(ids)].sort((a, b) => (this.P[b].skills.shooting ?? 60) - (this.P[a].skills.shooting ?? 60)).slice(0, 5);
    });
    const so: [number, number] = [0, 0];
    const attempt = (i: TI, r: number) => {
      const sh = shooters[i][r % Math.max(1, shooters[i].length)];
      const gid = this.goalies[1 - i];
      const g = gid ? this.P[gid] : null;
      if (!sh) return false;
      const sp = this.P[sh];
      const p = clamp(0.33 + ((sp.skills.shooting ?? 65) - 70) * 0.004 + ((sp.skills.skating ?? 65) - 70) * 0.001 - ((g?.overall ?? 55) - 70) * 0.0035, 0.12, 0.6);
      const ok = Math.random() < p;
      this.push({ type: ok ? 'so_goal' : 'so_miss', team: this.team(i).id, player: sh, time: `${r + 1}-й раунд`, text: `${sp.name} — ${ok ? 'ЗАБИВАЕТ' : 'не реализует буллит'} (${g?.name ?? ''})` });
      return ok;
    };
    for (let r = 0; r < 3; r++) {
      if (attempt(0, r)) so[0]++;
      if (attempt(1, r)) so[1]++;
    }
    let round = 3;
    while (so[0] === so[1] && round < 12) {
      const a = attempt(0, round);
      const b = attempt(1, round);
      if (a) so[0]++;
      if (b) so[1]++;
      round++;
    }
    if (so[0] === so[1]) {
      if (Math.random() < 0.5) so[0]++;
      else so[1]++;
    }
    const w: TI = so[0] > so[1] ? 0 : 1;
    this.score[w]++;
    this.periodScores.push([so[0], so[1]]);
    this.push({ type: 'period_end', text: `Буллиты ${so[0]}:${so[1]}. Победа ${this.label(w)} — ${this.score[0]}:${this.score[1]}`, score: [this.score[0], this.score[1]], so: [so[0], so[1]] });
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
    for (const i of [0, 1] as TI[]) {
      const gid = this.goalies[i];
      if (gid) this.line(gid).minutes = mins;
    }
    const dressed = (st: SimTeam) => [...st.lineup.F.flat(), ...st.lineup.D.flat(), st.lineup.starterG, st.lineup.backupG].filter((x): x is string => !!x);
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
