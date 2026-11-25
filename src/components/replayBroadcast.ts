import type { GameEvent } from '../types';
import type { ReplayClip } from '../game/rinkPlayback';

/**
 * Broadcast data of a goal replay (the TV score bug): the scoreboard is shown as it was during the episode —
 * the score before the goal, the game clock running down to the moment the puck went in, then frozen
 * (the whistle), and the strength of each team.
 */
export type Broadcast = {
  /** game clock (seconds left in the period) at the moment of the goal */
  goalClock: number;
  /** «1», «2», «3», «ОТ» */
  period: string;
  before: [number, number]; after: [number, number];
  /** per team: 'pp' — on the power play, 'pk' — short-handed, 'en' — empty net, null — even strength */
  strength: [BroadcastStrength, BroadcastStrength];
};
export type BroadcastStrength = 'pp' | 'pk' | 'en' | '4v4' | null;

export const parseClock = (s: string | undefined): number => {
  const m = /^(\d+):(\d{1,2})$/.exec((s ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};
export const fmtGameClock = (sec: number): string => {
  const s = Math.max(0, Math.ceil(sec - 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function broadcastFor(event: GameEvent, homeId: string): Broadcast {
  const side: 0 | 1 = event.team === homeId ? 0 : 1, other = (1 - side) as 0 | 1;
  const after = (event.score ?? [0, 0]) as [number, number];
  const before: [number, number] = [Math.max(0, after[0] - (side === 0 ? 1 : 0)), Math.max(0, after[1] - (side === 1 ? 1 : 0))];
  const strength: [BroadcastStrength, BroadcastStrength] = [null, null];
  if (event.strength === 'PP') { strength[side] = 'pp'; strength[other] = 'pk'; }
  else if (event.strength === 'SH') { strength[side] = 'pk'; strength[other] = 'pp'; }
  else if (event.strength === 'EN') strength[other] = 'en';
  else if (event.strength === '4v4') strength[0] = strength[1] = '4v4';
  return { goalClock: parseClock(event.time), period: event.period <= 3 ? String(event.period) : 'ОТ', before, after, strength };
}

/** The game clock at clip time `t` (0..1): it runs during the play and stops on the goal. */
export const clockAt = (b: Broadcast, clip: ReplayClip, t: number): number => b.goalClock + Math.max(0, clip.goal - t) * clip.duration;

export const STRENGTH_TEXT: Record<Exclude<BroadcastStrength, null>, string> = { pp: 'БОЛ', pk: 'МЕН', en: 'ПУСТ', '4v4': '4×4' };
export const STRENGTH_TITLE: Record<Exclude<BroadcastStrength, null>, string> = { pp: 'в большинстве', pk: 'в меньшинстве', en: 'без вратаря', '4v4': 'четыре на четыре' };
