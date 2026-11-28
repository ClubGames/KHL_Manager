// The online match's messages (one JSON object per line over the LAN socket, see lan.ts) and the compact form of the
// rink frames the host streams to the guest. Bump PROTO whenever a message changes shape: two builds with different
// numbers refuse to play each other (the lobby says which one has to be updated).
import type { GameEvent, Lineup, Player } from '../types';
import type { PadState, PenaltyClock, PlayOut, RinkFrame, RinkTick, Side } from '../game/playRink';

export const PROTO = 2;
/** TCP port of the host's game; the UDP port its «game here» beacons go to (see lan.ts). */
export const LAN_PORT = 47810;
export const BEACON_PORT = 47811;

/** A mod as the lobby compares them: the same id and version on both devices is «the same mod». */
export interface ModInfo { id: string; name: string; version?: string }

/** A club ready to be played on another device: everything the match needs, nothing that needs its mod's files. */
export interface TeamPack {
  /** the mod it comes from (null: a roster file picked by hand) */
  mod: ModInfo | null;
  team: { id: string; name: string; short: string; city: string; primaryColor: string; secondaryColor: string; logo?: string };
  players: Player[];
  lineup: Lineup;
  /** a short fingerprint of the club's data (two devices with the same mod build the same) */
  hash: string;
}

export interface MatchSettings {
  /** real minutes a 20-minute period takes */
  periodMinutes: number;
  penaltyClock: PenaltyClock;
  /** the host's side: 0 — he is the home team */
  hostSide: Side;
}
export const DEFAULT_SETTINGS: MatchSettings = { periodMinutes: 5, penaltyClock: 'period', hostSide: 0 };

/** What both screens show of the match around the rink: the host keeps it, the guest gets a copy. */
export interface MatchView {
  phase: 'loading' | 'playing' | 'break' | 'shootout' | 'final';
  period: number;
  status: 'playing' | 'ot' | 'so' | 'done';
  score: [number, number];
  shots: [number, number];
  hits: [number, number];
  periodScores: [number, number][];
  goals: { event: GameEvent; tau: number; period: number }[];
  /** the goal events with what led to them (the replays read the play-by-play) */
  events: GameEvent[];
  soEvents: GameEvent[];
  /** who is ready for the next period (index: side) */
  ready: [boolean, boolean];
  /** the side that paused the game (null: running) — online the match never stops for a menu now (see `away`) */
  paused: Side | null;
  /** who is in his menu right now (the match goes on, the AI skates his team meanwhile) */
  away?: [boolean, boolean];
  /** the timeouts each side still has */
  timeouts?: [boolean, boolean];
  /** the host waits for a screen (an entrance, a replay): the guest's picture catches up to the last frame, so a
   *  replay the host's screen started at that moment starts on the guest's too */
  held?: boolean;
  /** a shootout / overtime finish */
  beyond: '' | 'ОТ' | 'Б';
}

/** The options the host built the period's rink with (the guest builds its copy from the same). */
export interface BlockInit {
  kind: 'reg' | 'ot3' | 'ot5';
  flip: boolean;
  period: number;
  score: [number, number];
  goalies: [string | null, string | null];
  box?: [[string, number, boolean?][], [string, number, boolean?][]];
  /** each side's timeout still to take this match */
  timeouts?: [boolean, boolean];
  ids: string[];
}

/** A packed frame: see packFrame. */
type PackedFrame = (number | string | null | (number | string | null)[][])[];
export interface PackedTick extends Omit<RinkTick, 'frames'> { f: PackedFrame[] }

export type NetMsg =
  | { t: 'hello'; v: number; app: string; name: string; platform: string; mods: ModInfo[] }
  /** the host already has a guest */
  | { t: 'busy' }
  /** host → guest: the lobby (index 0 — the host, 1 — the guest) */
  | { t: 'lobby'; settings: MatchSettings; ready: [boolean, boolean] }
  | { t: 'team'; pack: TeamPack | null }
  | { t: 'ready'; on: boolean }
  /** host → guest: both clubs, the settings, the match begins */
  | { t: 'start'; settings: MatchSettings; packs: [TeamPack, TeamPack] }
  /** guest → host: its picture of the period is ready (the 3D figures prepared) */
  | { t: 'loaded' }
  | { t: 'block'; init: BlockInit }
  /** sog: the match's shots on goal by the books */
  | { t: 'tick'; k: PackedTick; out: PlayOut[]; sog: [number, number] }
  | { t: 'view'; v: MatchView }
  | { t: 'pad'; p: PadState }
  | { t: 'cmd'; c: string }
  /** in the menu (on) / back (off): the match goes on, his team plays itself meanwhile */
  | { t: 'pause'; on: boolean }
  /** guest → host: its screen holds the play (the teams' entrance, a goal's replay) — the host waits for it */
  | { t: 'hold'; on: boolean }
  /** guest → host: ready for the next period / the end of the match screen */
  | { t: 'next' }
  /** host → guest: back to the lobby (a rematch) */
  | { t: 'lobbyAgain' }
  | { t: 'ping'; at: number }
  | { t: 'pong'; at: number }
  | { t: 'bye'; reason?: string };

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** A frame as arrays with the people as indices into the period's id table (a third of the JSON). */
export function packFrame(f: RinkFrame, index: Map<string, number>): PackedFrame {
  const sk = f.sk.map(s => [index.get(s.id) ?? -1, s.side, s.goalie ? 1 : 0, s.box ? 1 : 0, r3(s.x), r3(s.y), r3(s.fa), s.ctrl ? 1 : 0, r3(s.fall), s.fk, s.fs, r3(s.check), r3(s.poke), r3(s.deke), s.mv, r3(s.mt), r3(s.stag), s.st, r3(s.stT), r3(s.hl), r3(s.hop), r3(s.jx), r3(s.jy), r3(s.jk), s.gate ? 1 : 0]);
  return [r3(f.tau), r3(f.clock), r3(f.px), r3(f.py), r3(f.ph), f.carrier, f.stop, r3(f.ox), r3(f.oy), r3(f.dx), r3(f.dy), sk];
}
export function unpackFrame(a: PackedFrame, ids: string[]): RinkFrame {
  const sk = (a[11] as (number | string | null)[][]).map(e => ({
    id: ids[e[0] as number] ?? '?', side: e[1] as Side, goalie: !!e[2], box: !!e[3], x: e[4] as number, y: e[5] as number, fa: e[6] as number, ctrl: !!e[7],
    fall: e[8] as number, fk: e[9] as RinkFrame['sk'][number]['fk'], fs: e[10] as 1 | -1, check: e[11] as number, poke: e[12] as number, deke: e[13] as number,
    mv: e[14] as RinkFrame['sk'][number]['mv'], mt: e[15] as number, stag: e[16] as number, st: e[17] as RinkFrame['sk'][number]['st'], stT: e[18] as number, hl: e[19] as number, hop: (e[20] as number) || 0,
    // (the jolt behind a stagger: appended, so an older peer's frames still read)
    jx: (e[21] as number) || 0, jy: (e[22] as number) || 0, jk: (e[23] as number) || 0,
    // (the way through the boards: appended too)
    gate: e[24] ? 1 as const : 0 as const,
  }));
  return { tau: a[0] as number, clock: a[1] as number, px: a[2] as number, py: a[3] as number, ph: a[4] as number, carrier: a[5] as number, stop: a[6] as 0 | 1 | 2, ox: a[7] as number, oy: a[8] as number, dx: a[9] as number, dy: a[10] as number, sk, ids: sk.map(s => s.id) };
}
export function packTick(t: RinkTick, index: Map<string, number>): PackedTick {
  const { frames, ...rest } = t;
  return { ...rest, f: frames.map(f => packFrame(f, index)) };
}
export function unpackTick(p: PackedTick, ids: string[]): RinkTick {
  const { f, ...rest } = p;
  return { ...rest, frames: f.map(x => unpackFrame(x, ids)) };
}

/** Pads are sent as they are, minus the defaults (most buttons are up most of the time). */
export function packPad(p: PadState): PadState {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== false && v !== null && v !== 0) o[k] = typeof v === 'number' ? r3(v) : v;
  return { mx: 0, my: 0, sprint: false, shoot: false, pass: false, deke: false, swap: false, ...o } as PadState;
}
export const samePad = (a: PadState, b: PadState) => JSON.stringify(packPad(a)) === JSON.stringify(packPad(b));

/** FNV-1a of a string, base 36 (the fingerprint of a club's data). */
export function hash36(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/** A message from the wire (anything that is not one of ours is dropped). */
export function parseMsg(line: string): NetMsg | null {
  try {
    const m = JSON.parse(line);
    return m && typeof m === 'object' && typeof m.t === 'string' ? (m as NetMsg) : null;
  } catch {
    return null;
  }
}
