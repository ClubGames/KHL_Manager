// Device settings (not part of a career save): replays, video export, live match and fast simulation.
// Stored in localStorage under one key; every reader gets defaults for missing or broken values, so the
// list can grow without migrations.
import { useSyncExternalStore } from 'react';
import type { ReplayCamera } from '../components/replayCameras';
import type { LiveCamera } from '../components/replayCameras';

export type ReplayQualitySetting = 'auto' | 'standard' | 'high' | 'ultra';
export type AutoReplay = 'all' | 'mine' | 'off';

export type Settings = {
  /** 3D goal replays; off = the same episode on the 2D rink (light, works everywhere) */
  replay3d: boolean;
  /** goals that open their replay by themselves in a live match */
  autoReplay: AutoReplay;
  replayQuality: ReplayQualitySetting;
  /** playback speed a replay opens with */
  replaySpeed: number;
  replayCamera: ReplayCamera;
  /** build the 3D arena and players in the background when a match starts, so the first replay opens at once */
  replayPrewarm: boolean;
  videoHeight: 720 | 1080;
  videoFps: 30 | 60;
  /** the slow-motion replay of the shot after the real-time part */
  videoSlowmo: boolean;
  /** score bug, «ГОЛ» lower third, watermark */
  videoGraphics: boolean;
  /** fast: light preset (no ice reflection, small shadow map) — the export takes noticeably less time */
  videoQuality: 'fast' | 'view';
  matchSpeed: 1 | 2 | 4;
  /** the rink below the match centre on wide screens */
  matchRink2d: boolean;
  /** the live match picture: the whole game in 3D (in sync with the 2D rink) or the 2D rink */
  matchView: '2d' | '3d';
  /** camera of the 3D match */
  matchCamera: LiveCamera;
  /** small 2D rink in the corner of the 3D picture */
  matchMinimap: boolean;
  /** before the first period in 3D: the teams skate out (visitors first, then the home team) with a laser show */
  matchIntro: boolean;
  /** 3D match: the scorer's celebration and the goal's replay after a goal, replays of big moments at stoppages */
  matchReplays: boolean;
  /** at a whistle the match pauses when the bench should act: timeout, goalie change, pulling the goalie */
  matchAdvice: boolean;
  /** a fast simulation that played one of the club's games opens its report */
  simOpenReport: boolean;
  /** confirm before a fast simulation (open inbox tasks, simulating a game without watching it) */
  simConfirm: boolean;
  /** a played match (the manager controls a skater): real minutes per 20-minute period */
  playPeriod: 3 | 5 | 8 | 12 | 20;
  /** a played match: how good the opponents are */
  playDifficulty: 'rookie' | 'pro' | 'star';
  /** a played match: the player switches automatically to the puck carrier / the nearest defender */
  playAutoSwitch: boolean;
  /** a played match: on-screen controls on a touch screen (stick and buttons) */
  playTouch: 'auto' | 'on' | 'off';
};

const KEY = 'khl.settings';
const coarse = () => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

export function defaultSettings(): Settings {
  return {
    replay3d: true, autoReplay: 'all', replayQuality: 'auto', replaySpeed: 1, replayCamera: 'auto', replayPrewarm: true,
    videoHeight: coarse() ? 720 : 1080, videoFps: 30, videoSlowmo: true, videoGraphics: true, videoQuality: 'view',
    matchSpeed: 2, matchRink2d: true, matchView: '3d', matchCamera: 'broadcast', matchMinimap: true, matchIntro: true, matchReplays: true, matchAdvice: true, simOpenReport: true, simConfirm: true,
    playPeriod: 5, playDifficulty: 'pro', playAutoSwitch: true, playTouch: 'auto',
  };
}

const CAMS: ReplayCamera[] = ['auto', 'broadcast', 'ice', 'net', 'goal', 'chase', 'end', 'sky', 'stands', 'corner', 'overhead', 'blue', 'rail', 'puck'];
export const REPLAY_SPEEDS = [.25, .5, .75, 1, 1.5, 2];

/** Keeps only known keys with valid values (anything else falls back to the default). */
export function sanitizeSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const bool = (k: keyof Settings) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : (d[k] as boolean));
  const one = <V,>(k: keyof Settings, list: readonly V[]) => (list.includes(r[k] as V) ? (r[k] as V) : (d[k] as V));
  return {
    replay3d: bool('replay3d'), autoReplay: one('autoReplay', ['all', 'mine', 'off'] as const),
    replayQuality: one('replayQuality', ['auto', 'standard', 'high', 'ultra'] as const), replaySpeed: one('replaySpeed', REPLAY_SPEEDS),
    replayCamera: one('replayCamera', CAMS), replayPrewarm: bool('replayPrewarm'),
    videoHeight: one('videoHeight', [720, 1080] as const), videoFps: one('videoFps', [30, 60] as const),
    videoSlowmo: bool('videoSlowmo'), videoGraphics: bool('videoGraphics'), videoQuality: one('videoQuality', ['fast', 'view'] as const),
    matchSpeed: one('matchSpeed', [1, 2, 4] as const), matchRink2d: bool('matchRink2d'), matchView: one('matchView', ['2d', '3d'] as const), matchCamera: one('matchCamera', ['broadcast', 'high', 'ice', 'end', 'overhead', 'dynamic', 'zone', 'vertical'] as const), matchMinimap: bool('matchMinimap'), matchIntro: bool('matchIntro'), matchReplays: bool('matchReplays'), matchAdvice: bool('matchAdvice'), simOpenReport: bool('simOpenReport'), simConfirm: bool('simConfirm'),
    playPeriod: one('playPeriod', [3, 5, 8, 12, 20] as const), playDifficulty: one('playDifficulty', ['rookie', 'pro', 'star'] as const), playAutoSwitch: bool('playAutoSwitch'), playTouch: one('playTouch', ['auto', 'on', 'off'] as const),
  };
}

function load(): Settings {
  try {
    const text = localStorage.getItem(KEY);
    if (text) return sanitizeSettings(JSON.parse(text));
    // Before the settings screen the replay remembered only its picture quality.
    const legacy = localStorage.getItem('khl.replayQuality');
    if (legacy) return sanitizeSettings({ replayQuality: legacy });
  } catch { /* private mode / broken JSON */ }
  return defaultSettings();
}

let current: Settings | null = null;
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  if (!current) current = load();
  return current;
}

export function setSettings(patch: Partial<Settings>) {
  const next = sanitizeSettings({ ...getSettings(), ...patch });
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: kept for this session */ }
  listeners.forEach(l => l());
}

export function resetSettings() {
  try { localStorage.removeItem(KEY); localStorage.removeItem('khl.replayQuality'); } catch { /* private mode */ }
  current = defaultSettings();
  listeners.forEach(l => l());
}

export function subscribeSettings(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, getSettings, getSettings);
}

/** Whether a goal should open its replay by itself in a live match. */
export function autoReplayFor(s: Settings, scoringTeam: string | null | undefined, userTeam: string): boolean {
  return s.autoReplay === 'all' || (s.autoReplay === 'mine' && scoringTeam === userTeam);
}
