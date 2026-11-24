import { attackDir, clamp, samplePath, sampleSmooth, type Point, type ReplayClip } from '../game/rinkPlayback';
import { RINK } from '../game/rinkGeometry';

/**
 * Replay cameras. Every pose is a pure function of (clip, time, zoom, aspect): scrubbing, pausing and
 * replaying always show exactly the same picture, and the auto director cuts at deterministic moments.
 */
export type ReplayCamera = 'auto' | 'broadcast' | 'ice' | 'net' | 'goal' | 'chase' | 'end' | 'sky';
export type ReplayView = Exclude<ReplayCamera, 'auto'> | 'celebrate';
export const CAMERAS: [ReplayCamera, string][] = [
  ['auto', 'Авто'], ['broadcast', 'ТВ'], ['ice', 'Со льда'], ['net', 'У ворот'], ['goal', 'Из ворот'], ['chase', 'За автором'], ['end', 'Из-за ворот'], ['sky', 'Сверху'],
];
export const VIEW_LABEL: Record<ReplayView, string> = {
  broadcast: 'ТВ', ice: 'Со льда', net: 'У ворот', goal: 'Из ворот', chase: 'За автором', end: 'Из-за ворот', sky: 'Сверху', celebrate: 'Крупный план',
};
export const ZOOM = { min: .45, max: 1.8 } as const;

type V3 = { x: number; y: number; z: number };
export type CameraPose = { pos: V3; look: V3; fov: number };

/** Replay clip coordinates (0…100 percent) → world metres around centre ice. */
export const toWorld = (p: Point): V3 => ({ x: (p.x - 50) * RINK.length / 100, y: p.h, z: (p.y - 50) * RINK.width / 100 });

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const smooth01 = (v: number) => { const t = clamp(v, 0, 1); return t * t * (3 - 2 * t); };

/**
 * The game's own director: a wide shot of the build-up, a close angle on the shooter, the puck flying into
 * the net from the goal (or the corner), then a close-up of the celebration. Each goal gets its own mix.
 */
export function autoCamera(clip: ReplayClip, time: number): ReplayView {
  const s = (sec: number) => sec / Math.max(.5, clip.duration);
  const seed = hash(`${clip.scorer}:${clip.goal.toFixed(4)}:${clip.release.toFixed(4)}`);
  const approach = clip.release - s(1.8), flight = clip.release - s(.15);
  if (time < approach && approach > s(1)) return seed % 3 === 2 ? 'sky' : 'broadcast';
  if (time < flight) return (['chase', 'ice', 'end', 'chase', 'broadcast'] as const)[seed % 5];
  if (time < clip.goal + s(.55)) return (seed >> 3) % 2 ? 'goal' : 'net';
  return 'celebrate';
}
export const viewFor = (camera: ReplayCamera, clip: ReplayClip, time: number): ReplayView => (camera === 'auto' ? autoCamera(clip, time) : camera);

/** Where the broadcast camera aims: the smoothed puck position, pulled slightly toward the attacked net. */
export function broadcastFocus(clip: ReplayClip, time: number): { x: number; z: number } {
  let x = 0, z = 0, n = 0;
  const span = .25 / Math.max(.5, clip.duration);
  for (let i = -6; i <= 6; i++) { const p = toWorld(samplePath(clip.puck, clamp(time + (i / 6) * span, 0, 1))); const w = 7 - Math.abs(i); x += p.x * w; z += p.z * w; n += w; }
  return { x: clamp(x / n + attackDir(clip) * 2, -21, 21), z: clamp((z / n) * .55, -6, 6) };
}

/** A track position smoothed over ±`window` seconds (for cameras that follow a player). */
function follow(clip: ReplayClip, id: string, time: number, window = .3): V3 & { vx: number; vz: number } {
  const track = clip.tracks.find(t => t.id === id) ?? clip.tracks[0];
  if (!track) return { x: 0, y: 0, z: 0, vx: 1, vz: 0 };
  const span = window / Math.max(.5, clip.duration);
  let x = 0, z = 0, n = 0;
  for (let i = -4; i <= 4; i++) { const p = toWorld(sampleSmooth(track.keys, clamp(time + (i / 4) * span, 0, 1))); const w = 5 - Math.abs(i); x += p.x * w; z += p.z * w; n += w; }
  const a = toWorld(sampleSmooth(track.keys, clamp(time - span, 0, 1))), b = toWorld(sampleSmooth(track.keys, clamp(time + span, 0, 1)));
  return { x: x / n, y: 0, z: z / n, vx: b.x - a.x, vz: b.z - a.z };
}

export function cameraPose(clip: ReplayClip, time: number, view: ReplayView, zoom: number, aspect: number): CameraPose {
  const dir = attackDir(clip), net = { x: dir * (RINK.length / 2 - RINK.goalLine), y: 0, z: 0 };
  const s = (sec: number) => sec / Math.max(.5, clip.duration);
  const wide = clamp(1.65 / Math.max(.4, aspect), 1, 2.1); // portrait screens pull back
  const z = clamp(zoom, ZOOM.min, ZOOM.max);
  const focus = broadcastFocus(clip, time);
  switch (view) {
    case 'broadcast': {
      // Zooms in as the shot comes: wide for the build-up, tight on the release and the goal.
      const tight = smooth01((time - (clip.release - s(1.2))) / s(.9)) * (1 - smooth01((time - (clip.goal + s(1.2))) / s(.8)));
      const d = (17 - 5.5 * tight) * wide * z;
      return { pos: { x: focus.x, y: d * .56, z: focus.z + d * .83 }, look: { x: focus.x, y: .4, z: focus.z }, fov: 40 };
    }
    case 'ice': {
      // Low rink-side camera behind the glass that pans with the play.
      const x = clamp(focus.x * .85, -24, 24);
      return { pos: { x, y: 2.3, z: RINK.width / 2 + 2.6 }, look: { x: focus.x, y: .7, z: focus.z }, fov: clamp(42 * z * Math.min(1.3, wide), 16, 75) };
    }
    case 'sky': {
      const h = 24 * wide * z;
      return { pos: { x: focus.x, y: h, z: focus.z + h * .18 }, look: { x: focus.x, y: 0, z: focus.z }, fov: 40 };
    }
    case 'net': {
      // Low in the corner next to the attacked net, looking across the crease.
      const look = { x: dir * 21.5, y: .6, z: focus.z * .45 }, base = { x: dir * 28.6, y: 2.1, z: 8.2 };
      return { pos: { x: look.x + (base.x - look.x) * z, y: look.y + (base.y - look.y) * Math.sqrt(z), z: look.z + (base.z - look.z) * z }, look, fov: 46 };
    }
    case 'goal': {
      // Inside the net, behind the goalie, looking out at the shooter (the netting in the foreground).
      const p = toWorld(samplePath(clip.puck, clamp(time, 0, clip.release)));
      return { pos: { x: net.x + dir * .85, y: .85, z: 0 }, look: { x: p.x, y: .5, z: p.z * .8 }, fov: clamp(58 * z, 22, 80) };
    }
    case 'end': {
      // High behind the attacked net, looking down the ice.
      const look = { x: dir * 14, y: 0, z: focus.z * .6 }, base = { x: dir * 37, y: 10.5, z: 0 };
      return { pos: { x: look.x + (base.x - look.x) * z, y: base.y * Math.sqrt(z), z: look.z + (base.z - look.z) * z }, look, fov: 42 };
    }
    case 'chase': {
      // Behind the scorer, on the line from the net through him: shooter and goal in one frame.
      const p = follow(clip, clip.scorer, time);
      let bx = p.x - net.x, bz = p.z - net.z; const bl = Math.hypot(bx, bz) || 1; bx /= bl; bz /= bl;
      const d = 5.2 * z;
      return { pos: { x: p.x + bx * d, y: 2.4 * Math.sqrt(z), z: p.z + bz * d }, look: { x: (p.x * 2 + net.x) / 3, y: .8, z: (p.z * 2 + net.z) / 3 }, fov: 50 };
    }
    case 'celebrate': {
      // In front of the scorer, at head height, as he turns away from the net.
      const p = follow(clip, clip.scorer, time, .45);
      let fx = p.vx, fz = p.vz; let fl = Math.hypot(fx, fz);
      if (fl < .4) { fx = -p.x; fz = -p.z; fl = Math.hypot(fx, fz) || 1; }
      fx /= fl; fz /= fl;
      const d = 4.2 * z;
      return { pos: { x: p.x + fx * d - fz * 1.2, y: 1.8, z: p.z + fz * d + fx * 1.2 }, look: { x: p.x, y: 1.25, z: p.z }, fov: 44 };
    }
  }
}
