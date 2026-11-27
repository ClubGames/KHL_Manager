// The online match. The host's device plays it: one PlayRink with a human seat for each side (the host's pad and
// the guest's pads as they arrive), the statistical engine keeping the books exactly as in a career game. The
// guest's device shows a copy (PlayRink.mirrorOf) fed with the host's frames 30 times a second, and sends its pad
// back every frame. Periods, intermissions, overtime and the shootout follow the host; either player can pause.
import type { GameEvent, Lineup, Player, Team } from '../types';
import { GameSim, type BlockKind } from '../game/engine';
import { endsSwitched } from '../game/rinkGeometry';
import { NO_PAD, PlayRink, type PadState, type PlayOut, type PlayRinkOptions, type Side } from '../game/playRink';
import { matchTeam } from './teamPack';
import { packTick, unpackTick, type BlockInit, type MatchSettings, type MatchView, type NetMsg, type TeamPack } from './wire';

/** Both clubs as this match knows them (the same on both devices). */
export interface OnlineCtx {
  home: Team; away: Team;
  players: Record<string, Player>;
  lineups: [Lineup, Lineup];
  settings: MatchSettings;
  /** this device's side */
  mySide: Side;
  role: 'host' | 'guest';
}
/** packs: [the host's club, the guest's club]. */
export function buildCtx(packs: [TeamPack, TeamPack], settings: MatchSettings, role: 'host' | 'guest'): OnlineCtx {
  const hs = settings.hostSide;
  const homePack = hs === 0 ? packs[0] : packs[1], awayPack = hs === 0 ? packs[1] : packs[0];
  const H = matchTeam(homePack, 0), A = matchTeam(awayPack, 1);
  return { home: H.team, away: A.team, players: { ...H.players, ...A.players }, lineups: [H.lineup, A.lineup], settings, mySide: role === 'host' ? hs : (1 - hs) as Side, role };
}

const blankView = (): MatchView => ({ phase: 'loading', period: 1, status: 'playing', score: [0, 0], shots: [0, 0], hits: [0, 0], periodScores: [], goals: [], events: [], soEvents: [], ready: [false, false], paused: null, beyond: '' });

/** The commands of the pause menu and the hot keys (line changes, the goalie, tactics). */
export type MatchCommand = 'pull' | 'change' | 'changeF' | 'changeD' | 'forecheck' | 'breakout' | 'timeout';
const COMMANDS = new Set<string>(['pull', 'change', 'changeF', 'changeD', 'forecheck', 'breakout', 'timeout']);
/** The longest one screen may hold the play for itself (the entrance with the anthem; a replay is far shorter). */
const HOLD_MAX = 150;

export interface MatchEvents {
  /** the view changed (phase, score, goals, pause) */
  view(v: MatchView): void;
  /** the period's rink is ready (new) — or gone (null) */
  rink(k: PlayRink | null): void;
  /** plays for the toasts, as they happen on the rink */
  out(o: PlayOut[]): void;
  /** a message for this player (his command's result) */
  toast(text: string): void;
}

/** Both devices: what the screen reads. */
export interface MatchSide {
  readonly ctx: OnlineCtx;
  readonly view: MatchView;
  readonly rink: PlayRink | null;
  /** this device's picture of the period is ready (the 3D figures prepared) */
  loaded(): void;
  /** shots on goal of the match so far */
  shots(): [number, number];
  /** ready for the next period / the next screen */
  next(): void;
  /** the menu open (on) / closed: the match goes on, the AI plays this side's team meanwhile */
  pause(on: boolean): void;
  /** this screen holds the play (the entrance, a replay): the host waits until neither screen holds it */
  hold(on: boolean): void;
  command(c: MatchCommand): void;
  onMessage(m: NetMsg): void;
}

export class HostMatch implements MatchSide {
  readonly sim: GameSim;
  view = blankView();
  rink: PlayRink | null = null;
  private carry: [[string, number][], [string, number][]] | null = null;
  /** each side's timeout still to take this match */
  private timeouts: [boolean, boolean] = [true, true];
  private guestPads: PadState[] = [];
  private guestLast: PadState = NO_PAD;
  private loadedBy: [boolean, boolean] = [false, false];
  private index = new Map<string, number>();
  private outs: PlayOut[] = [];
  private readonly guest: Side;
  /** each screen's hold (index: side) and since when (seconds of real time the host has run) */
  private holds: [number, number] = [-1, -1];
  private clock = 0;
  constructor(readonly ctx: OnlineCtx, private send: (m: NetMsg) => void, private ev: MatchEvents) {
    this.sim = new GameSim({ id: ctx.home.id, lineup: ctx.lineups[0], name: ctx.home.name }, { id: ctx.away.id, lineup: ctx.lineups[1], name: ctx.away.name }, ctx.players, false, null);
    this.guest = (1 - ctx.mySide) as Side;
  }
  private blockKind(): BlockKind { const s = this.sim; return s.status === 'ot' ? (s.playoff ? 'ot5' : 'ot3') : s.status === 'so' ? 'so' : 'reg'; }
  /** The view from the books (and pushed to the guest). */
  private push(patch: Partial<MatchView> = {}) {
    const s = this.sim, r = s.result();
    this.view = {
      ...this.view, ...patch, period: Math.max(1, s.period), status: s.status, score: [s.score[0], s.score[1]], shots: [s.shots[0], s.shots[1]], hits: [r.homeStats.hits, r.awayStats.hits],
      periodScores: r.periodScores.map(p => [p[0], p[1]] as [number, number]), events: s.events.filter(e => e.type !== 'info' && e.type !== 'hit' && e.type !== 'miss'),
      beyond: s.status === 'done' && s.period > 3 ? (s.hadSO ? 'Б' : 'ОТ') : '',
    };
    this.ev.view(this.view);
    this.send({ t: 'view', v: this.view });
  }
  /** The match begins (the guest has the clubs already). */
  private begun = false;
  /** The first period (once: a screen mounted twice — React's strict mode — does not skip a period). */
  begin() { if (this.begun) return; this.begun = true; this.startBlock(); }
  private startBlock() {
    const k = this.blockKind();
    if (k === 'so') {
      const evs = this.sim.simShootout();
      this.push({ phase: 'shootout', soEvents: evs, ready: [false, false] });
      return;
    }
    const s = this.sim;
    s.beginPlayed(k);
    const start = s.sec;
    const box = this.carry ? ([this.carry[0].map(([id, end]) => [id, end - start]), this.carry[1].map(([id, end]) => [id, end - start])] as [[string, number][], [string, number][]]) : undefined;
    const init: Omit<BlockInit, 'ids'> = { kind: k, flip: endsSwitched(s.period), period: s.period, score: [s.score[0], s.score[1]], goalies: [s.goalies[0] ?? s.team(0).lineup.starterG, s.goalies[1] ?? s.team(1).lineup.starterG], box, timeouts: this.timeouts };
    const rink = new PlayRink(rinkOptions(this.ctx, init, [this.ctx.mySide, this.guest]));
    const ids = rink.agentIds();
    this.index = new Map(ids.map((id, i) => [id, i]));
    this.rink = rink; this.guestPads = []; this.guestLast = NO_PAD; this.loadedBy = [false, false]; this.outs = [];
    this.send({ t: 'block', init: { ...init, ids } });
    this.ev.rink(rink);
    this.holds = [-1, -1];
    this.push({ phase: 'loading', ready: [false, false], paused: null, away: [false, false], timeouts: [rink.timeoutLeft[0], rink.timeoutLeft[1]] });
  }
  loaded() { this.markLoaded(this.ctx.mySide); }
  private markLoaded(side: Side) {
    if (this.view.phase !== 'loading') return;
    this.loadedBy[side] = true;
    if (this.loadedBy[0] && this.loadedBy[1]) this.push({ phase: 'playing' });
  }
  /** The guest's picture never came (a slow phone): the host starts all the same after a while. */
  forceStart() { if (this.view.phase === 'loading' && this.rink) this.push({ phase: 'playing' }); }
  /** Shots on goal of the match so far (the books). */
  shots(): [number, number] { return [this.sim.shots[0], this.sim.shots[1]]; }
  get running() { return this.view.phase === 'playing' && !!this.rink; }
  hold(on: boolean) { this.holdBy(this.ctx.mySide, on); }
  private holdBy(side: Side, on: boolean) { if (on && this.holds[side] < 0) this.holds[side] = this.clock; else if (!on) this.holds[side] = -1; }
  /** A screen holds the play (one stuck for longer than HOLD_MAX is not waited for). */
  get held() { return this.holds.some(h => h >= 0 && this.clock - h < HOLD_MAX); }
  /** The guest's pad for the next step: each one he sent is played at least one step (a quick tap is not lost). */
  private nextGuestPad(): PadState {
    if (this.guestPads.length > 6) this.guestPads.splice(0, this.guestPads.length - 2); // fallen behind: catch up
    const p = this.guestPads.shift();
    if (p) this.guestLast = p;
    return this.guestLast;
  }
  /** Real time `dt` with the host's pad: the rink, the books, the guest's tick. */
  advance(dt: number, pad: PadState) {
    const k = this.rink;
    this.clock += dt;
    const held = this.running && this.held;
    if (held !== !!this.view.held) {
      // the play stops here: every frame up to this moment goes to the guest first (the moment his screen's replay
      // begins at must be in them)
      if (held && k) { const t = k.netTick(1, 1000); if (t) { this.send({ t: 'tick', k: packTick(t, this.index), out: this.outs, sog: this.shots() }); this.outs = []; } }
      this.push({ held });
    }
    if (!k || !this.running || held) return;
    // the seats: [the host, the guest] (whichever side each plays)
    k.advance(dt, () => [pad, this.nextGuestPad()]);
    const out = k.drain();
    if (out.length) { this.book(k, out); this.outs.push(...out); this.ev.out(out); }
    const t = k.netTick(1);
    if (t) { this.send({ t: 'tick', k: packTick(t, this.index), out: this.outs, sog: this.shots() }); this.outs = []; }
    if (k.ended) this.endBlock();
  }
  private book(k: PlayRink, out: PlayOut[]) {
    let changed = false;
    for (const o of out) {
      if (o.type === 'shot') {
        const e = this.sim.recordPlayed(k.clock, o);
        if (o.outcome === 'goal' && e) {
          const g = k.goalsFor[k.goalsFor.length - 1];
          this.view = { ...this.view, goals: [...this.view.goals, { event: e, tau: g?.tau ?? k.tau, period: this.sim.period }] };
          changed = true;
        }
      } else if (o.type === 'penalty' || o.type === 'hit') { this.sim.recordPlayed(k.clock, o); if (o.type === 'penalty') changed = true; }
      else if (o.type === 'waived') this.sim.recordPlayed(k.clock, { type: 'info', side: o.side, text: o.text });
      else if (o.type === 'timeout') { this.sim.recordPlayed(k.clock, { type: 'info', side: o.side, text: `Тайм-аут: ${(o.side ? this.ctx.away : this.ctx.home).name}` }); this.view = { ...this.view, timeouts: [k.timeoutLeft[0], k.timeoutLeft[1]] }; changed = true; }
    }
    if (changed) this.push();
  }
  private endBlock() {
    const k = this.rink;
    if (!k) return;
    const out = k.drain();
    if (out.length) this.book(k, out);
    const t = k.netTick(1, 1000);
    if (t) this.send({ t: 'tick', k: packTick(t, this.index), out: [...this.outs, ...out], sog: this.shots() });
    this.outs = [];
    this.sim.endPlayed(k.clock);
    this.carry = this.sim.playedBox();
    this.timeouts = [k.timeoutLeft[0], k.timeoutLeft[1]];
    this.rink = null;
    this.push({ phase: this.sim.status === 'done' ? 'final' : 'break', ready: [false, false], paused: null, away: [false, false] });
    // (the rink stays on the screen until the next one comes: the goal clips are cut from it)
  }
  next() { this.readyBy(this.ctx.mySide); }
  private readyBy(side: Side) {
    const v = this.view;
    if (v.phase !== 'break' && v.phase !== 'shootout') return;
    const ready: [boolean, boolean] = [v.ready[0], v.ready[1]];
    ready[side] = true;
    if (!(ready[0] && ready[1])) { this.push({ ready }); return; }
    if (v.phase === 'shootout') this.push({ phase: 'final', ready: [false, false] });
    else this.startBlock();
  }
  pause(on: boolean) { this.pauseBy(this.ctx.mySide, on); }
  /** A player in his menu: the match goes on (the other is still playing), the AI takes his team meanwhile. */
  private pauseBy(side: Side, on: boolean) {
    const away: [boolean, boolean] = [...(this.view.away ?? [false, false])] as [boolean, boolean];
    if (away[side] === on) return;
    away[side] = on;
    this.rink?.setAway(side === this.ctx.mySide ? 0 : 1, on);
    this.push({ away });
  }
  command(c: MatchCommand) { const t = this.commandBy(this.ctx.mySide, c); if (t) this.ev.toast(t); }
  private commandBy(side: Side, c: MatchCommand): string | null {
    const k = this.rink;
    if (!k || this.view.phase !== 'playing') return null;
    if (c === 'pull') { const on = !k.pulled[side]; k.setPulled(side, on); return on ? 'Вратарь уходит — шестой полевой' : 'Вратарь возвращается в ворота'; }
    if (c === 'change') { k.requestChange(side); return 'Смена звена'; }
    if (c === 'changeF') { k.requestChange(side, 'F'); return 'Смена звена нападения'; }
    if (c === 'changeD') { k.requestChange(side, 'D'); return 'Смена пары защитников'; }
    if (c === 'forecheck') return `Форчекинг: ${k.cycleForecheck(side)}`;
    if (c === 'breakout') return `Выход из зоны: ${k.cycleBreakout(side)}`;
    if (c === 'timeout') {
      const now = k.timeoutNow();
      if (now) { if (now.side === side) k.endTimeout(); return null; }
      const r = k.callTimeout(side);
      return r === 'next' ? 'Тайм-аут — при следующей остановке игры' : r === null ? (k.timeoutLeft[side] ? 'Тайм-аут уже заказан' : 'Тайм-аут уже взят в этом матче') : null;
    }
    return null;
  }
  onMessage(m: NetMsg) {
    if (m.t === 'pad') { this.guestPads.push(m.p); return; }
    if (m.t === 'loaded') this.markLoaded(this.guest);
    else if (m.t === 'next') this.readyBy(this.guest);
    else if (m.t === 'pause') this.pauseBy(this.guest, m.on);
    else if (m.t === 'hold') this.holdBy(this.guest, m.on);
    else if (m.t === 'cmd' && COMMANDS.has(m.c)) { const t = this.commandBy(this.guest, m.c as MatchCommand); if (t) this.send({ t: 'cmd', c: t }); }
  }
}

/** The options of the period's rink (the host builds it, the guest a copy from the same). */
function rinkOptions(ctx: OnlineCtx, init: Omit<BlockInit, 'ids'>, humans: Side[]): PlayRinkOptions {
  return {
    home: ctx.home, away: ctx.away, players: ctx.players, lineups: ctx.lineups, userSide: humans[0], humans, kind: init.kind, flip: init.flip,
    periodMinutes: ctx.settings.periodMinutes, penaltyClock: ctx.settings.penaltyClock, difficulty: 'pro', autoSwitch: true,
    goalies: init.goalies, box: init.box, score: init.score, period: init.period, timeouts: init.timeouts,
  };
}

export class GuestMatch implements MatchSide {
  view = blankView();
  rink: PlayRink | null = null;
  private ids: string[] = [];
  private sog: [number, number] = [0, 0];
  constructor(readonly ctx: OnlineCtx, private send: (m: NetMsg) => void, private ev: MatchEvents) {}
  shots(): [number, number] { return this.view.phase === 'playing' ? this.sog : this.view.shots; }
  loaded() { if (this.view.phase === 'loading' && this.rink) this.send({ t: 'loaded' }); }
  next() { this.send({ t: 'next' }); }
  pause(on: boolean) { this.send({ t: 'pause', on }); }
  private holding = false;
  hold(on: boolean) { if (on !== this.holding) { this.holding = on; this.send({ t: 'hold', on }); } }
  command(c: MatchCommand) { this.send({ t: 'cmd', c }); }
  /** The guest's pad for the host (sent every frame it changes, and every 100 ms all the same). */
  private lastPad = '';
  private lastPadAt = 0;
  pad(p: PadState, now: number) {
    const s = JSON.stringify(p);
    if (s === this.lastPad && now - this.lastPadAt < 100) return;
    this.lastPad = s; this.lastPadAt = now;
    this.send({ t: 'pad', p });
  }
  onMessage(m: NetMsg) {
    if (m.t === 'block') {
      this.ids = m.init.ids;
      const k = PlayRink.mirrorOf(rinkOptions(this.ctx, m.init, [this.ctx.mySide]));
      this.rink = k;
      this.ev.rink(k);
    } else if (m.t === 'tick') {
      if (this.rink) this.rink.ingest(unpackTick(m.k, this.ids));
      this.sog = m.sog;
      if (m.out.length) this.ev.out(m.out);
    } else if (m.t === 'view') {
      this.view = m.v;
      this.ev.view(m.v);
    } else if (m.t === 'cmd') this.ev.toast(m.c);
  }
}

/** The goal toast from this player's side of the ice. */
export function outToast(o: PlayOut, mySide: Side, P: Record<string, Player>): { text: string; tone: 'goal' | 'pen' | 'info'; ms: number } | null {
  if (o.type === 'shot' && o.outcome === 'goal') {
    const mine = o.side === mySide;
    return { text: `${mine ? 'ГОЛ!' : 'Гол соперника'} ${P[o.shooter]?.name ?? ''}${o.assists.length ? ` (${o.assists.map(a => P[a]?.name).join(', ')})` : ''}`, tone: 'goal', ms: 3600 };
  }
  if (o.type === 'penalty') return { text: `Удаление: ${P[o.player]?.name ?? ''} — ${o.reason}, ${o.min} мин`, tone: 'pen', ms: 2600 };
  if (o.type === 'waived') return { text: o.text, tone: 'info', ms: 2600 };
  if (o.type === 'timeout') return { text: o.side === mySide ? 'Тайм-аут — тренер объясняет, игроки отдыхают' : 'Тайм-аут взял соперник', tone: 'info', ms: 2600 };
  if (o.type === 'icing') return { text: 'Проброс', tone: 'info', ms: 1600 };
  if (o.type === 'offside') return { text: 'Офсайд', tone: 'info', ms: 1600 };
  return null;
}

export type { GameEvent };
