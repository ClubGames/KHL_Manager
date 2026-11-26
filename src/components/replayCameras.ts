import { attackDir, clamp, samplePath, sampleSmooth, type Point, type ReplayClip } from '../game/rinkPlayback';
import { RINK } from '../game/rinkGeometry';

/**
 * Replay cameras. Every pose is a pure function of (clip, time, zoom, aspect): scrubbing, pausing and
 * replaying always show exactly the same picture, and the auto director cuts at deterministic moments.
 */
export type ReplayCamera = 'auto' | 'broadcast' | 'ice' | 'net' | 'goal' | 'chase' | 'end' | 'sky'
  | 'stands' | 'corner' | 'overhead' | 'blue' | 'rail' | 'puck';
export type ReplayView = Exclude<ReplayCamera, 'auto'> | 'celebrate';
export const CAMERAS: [ReplayCamera, string][] = [
  ['auto', 'Авто'], ['broadcast', 'ТВ'], ['ice', 'Со льда'], ['net', 'У ворот'], ['goal', 'Из ворот'], ['chase', 'За автором'], ['end', 'Из-за ворот'], ['sky', 'Сверху'],
  ['stands', 'Трибуна'], ['corner', 'Угол'], ['overhead', 'Над зоной'], ['blue', 'С синей линии'], ['rail', 'Рельсовая'], ['puck', 'За шайбой'],
];
/** Cameras that stand still (fixed position and aim; only the zoom changes the lens). */
export const STATIC_CAMERAS: ReadonlySet<ReplayView> = new Set<ReplayView>(['stands', 'corner', 'overhead', 'blue']);
export const VIEW_LABEL: Record<ReplayView, string> = {
  broadcast: 'ТВ', ice: 'Со льда', net: 'У ворот', goal: 'Из ворот', chase: 'За автором', end: 'Из-за ворот', sky: 'Сверху', celebrate: 'Крупный план',
  stands: 'Трибуна', corner: 'Угол', overhead: 'Над зоной', blue: 'С синей линии', rail: 'Рельсовая', puck: 'За шайбой',
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
  if (time < approach && approach > s(1)) return (['broadcast', 'sky', 'broadcast', 'stands', 'broadcast', 'blue'] as const)[seed % 6];
  if (time < flight) return (['chase', 'ice', 'end', 'chase', 'broadcast', 'rail', 'puck', 'corner'] as const)[seed % 8];
  if (time < clip.goal + s(.55)) return (['goal', 'net', 'goal', 'net', 'overhead'] as const)[(seed >>> 3) % 5];
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

/** The puck smoothed over ±0.15 s and its direction of travel (for the cameras that ride along with it). */
function puckSmooth(clip: ReplayClip, time: number): V3 & { vx: number; vz: number } {
  const span = .15 / Math.max(.5, clip.duration);
  let x = 0, z = 0, n = 0;
  for (let i = -3; i <= 3; i++) { const p = toWorld(samplePath(clip.puck, clamp(time + (i / 3) * span, 0, 1))); const w = 4 - Math.abs(i); x += p.x * w; z += p.z * w; n += w; }
  const a = toWorld(samplePath(clip.puck, clamp(time - span, 0, 1))), b = toWorld(samplePath(clip.puck, clamp(time + span, 0, 1)));
  return { x: x / n, y: 0, z: z / n, vx: b.x - a.x, vz: b.z - a.z };
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
      // (it stays inside the building: past 27 m back a portrait screen or a wide zoom-out widens the lens instead)
      const raw = (17 - 5.5 * tight) * wide * z, d = Math.min(raw, 27);
      return { pos: { x: focus.x, y: d * .56, z: focus.z + d * .83 }, look: { x: focus.x, y: .4, z: focus.z }, fov: clamp(40 * raw / d, 40, 76) };
    }
    case 'ice': {
      // Low rink-side camera at the near boards that pans with the play (inside the glass, over the boards).
      const x = clamp(focus.x * .85, -24, 24);
      return { pos: { x, y: 2.5, z: RINK.width / 2 - .35 }, look: { x: focus.x, y: .6, z: focus.z - 1.2 }, fov: clamp(44 * z * Math.min(1.3, wide), 16, 78) };
    }
    case 'sky': {
      const h = 24 * wide * z;
      return { pos: { x: focus.x, y: h, z: focus.z + h * .18 }, look: { x: focus.x, y: 0, z: focus.z }, fov: 40 };
    }
    case 'net': {
      // Low in the corner next to the attacked net, looking across the crease.
      // (it stays inside the corner boards: a wider zoom-out widens the lens)
      const look = { x: dir * 21.5, y: .6, z: focus.z * .45 }, base = { x: dir * 27.4, y: 2.1, z: 7.4 }, k = Math.min(z, 1.05);
      return { pos: { x: look.x + (base.x - look.x) * k, y: look.y + (base.y - look.y) * Math.sqrt(k), z: look.z + (base.z - look.z) * k }, look, fov: clamp(46 * z / k, 30, 78) };
    }
    case 'goal': {
      // Inside the net, behind the goalie, looking out at the shooter (the netting in the foreground).
      const p = toWorld(samplePath(clip.puck, clamp(time, 0, clip.release)));
      return { pos: { x: net.x + dir * .85, y: .85, z: 0 }, look: { x: p.x, y: .5, z: p.z * .8 }, fov: clamp(58 * z, 22, 80) };
    }
    case 'end': {
      // High behind the attacked net, looking down the ice.
      // (it stays in front of the end stands: a wider zoom-out widens the lens)
      const look = { x: dir * 14, y: 0, z: focus.z * .6 }, base = { x: dir * 35, y: 12, z: 0 }, k = Math.min(z, 1.1);
      return { pos: { x: look.x + (base.x - look.x) * k, y: base.y * Math.sqrt(k), z: look.z + (base.z - look.z) * k }, look, fov: clamp(42 * z / k, 30, 76) };
    }
    case 'chase': {
      // Behind the scorer, on the line from the net through him: shooter and goal in one frame.
      const p = follow(clip, clip.scorer, time);
      let bx = p.x - net.x, bz = p.z - net.z; const bl = Math.hypot(bx, bz) || 1; bx /= bl; bz /= bl;
      const d = 5.2 * z;
      return { pos: { x: p.x + bx * d, y: 2.4 * Math.sqrt(z), z: p.z + bz * d }, look: { x: (p.x * 2 + net.x) / 3, y: .8, z: (p.z * 2 + net.z) / 3 }, fov: 50 };
    }
    /* static cameras: bolted to the building, they do not pan */
    case 'stands': {
      // A wide camera high in the stands at centre ice, aimed at the attacked zone.
      return { pos: { x: dir * 4, y: 15, z: 27 }, look: { x: dir * 16, y: 0, z: 0 }, fov: clamp(40 * z * Math.min(1.3, wide), 16, 78) };
    }
    case 'corner': {
      // High in the corner of the stands behind the attacked net's side.
      return { pos: { x: dir * 33, y: 8, z: 17 }, look: { x: dir * 21, y: .4, z: 0 }, fov: clamp(44 * z * Math.min(1.3, wide), 16, 78) };
    }
    case 'overhead': {
      // Straight down from the roof over the attacked zone (the crease and the slot like a tactics board).
      return { pos: { x: dir * 19.5, y: 21, z: 2.6 }, look: { x: dir * 19.5, y: 0, z: 0 }, fov: clamp(52 * z * Math.min(1.25, wide), 18, 80) };
    }
    case 'blue': {
      // On the far boards at the blue line, glass height (inside the glass, in front of the benches), looking in at the net.
      return { pos: { x: dir * 7.2, y: 2.7, z: -(RINK.width / 2 - .35) }, look: { x: dir * 24, y: .6, z: 1.5 }, fov: clamp(38 * z * Math.min(1.3, wide), 14, 75) };
    }
    /* moving cameras */
    case 'rail': {
      // A rail camera on the dasher boards at ice level: it slides with the puck and looks straight across.
      const p = puckSmooth(clip, time);
      return { pos: { x: clamp(p.x, -22, 22), y: .8, z: RINK.width / 2 - .25 }, look: { x: clamp(p.x, -27, 27), y: .45, z: p.z * .5 - 2 }, fov: clamp(56 * z * Math.min(1.3, wide), 20, 80) };
    }
    case 'puck': {
      // Right behind the puck along its path, low: the pass, the shot and the net ahead.
      const p = puckSmooth(clip, time);
      let vx = p.vx, vz = p.vz, vl = Math.hypot(vx, vz);
      if (vl < .3) { vx = net.x - p.x; vz = net.z - p.z; vl = Math.hypot(vx, vz) || 1; }
      vx /= vl; vz /= vl;
      const d = 4.2 * z;
      return { pos: { x: clamp(p.x - vx * d, -33, 33), y: 1.6 * Math.sqrt(z), z: clamp(p.z - vz * d, -17, 17) }, look: { x: p.x + vx * 3, y: .35, z: p.z + vz * 3 }, fov: 54 };
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

/* ---------------- the live 3D match ---------------- */

/**
 * NHL-style cameras of the played match: the TV broadcast, a high one, ice level, from behind the net, and the
 * ones of the NHL games — overhead (straight down), dynamic (low and close, it pulls back as the play speeds up),
 * zone (holds the whole zone the puck is in) and vertical (behind your own net, looking up the ice the way you
 * attack; the stick turns with it).
 */
export type LiveCamera = 'broadcast' | 'high' | 'ice' | 'end' | 'overhead' | 'dynamic' | 'zone' | 'vertical';
export const LIVE_CAMERAS: [LiveCamera, string][] = [
  ['broadcast', 'ТВ'], ['dynamic', 'Динамичная'], ['high', 'Высокая'], ['zone', 'Зона'], ['overhead', 'Сверху'], ['vertical', 'Вертикальная'], ['ice', 'Со льда'], ['end', 'Из-за ворот'],
];
/** What some live cameras need besides the point of play: the way the manager's team attacks (+1: toward +x) and the puck speed (m/s). */
export interface LiveCameraContext { attack?: 1 | -1; speed?: number }

/** Camera of the live picture around the (smoothed) point of play. Pure: tests check it in Node. */
export function liveCameraPose(mode: LiveCamera, focus: { x: number; z: number }, zoom: number, aspect: number, ctx: LiveCameraContext = {}): { pos: V3; look: V3; fov: number } {
  const wide = clamp(1.65 / Math.max(.4, aspect), 1, 2.1); // portrait screens pull back
  const z = clamp(zoom, ZOOM.min, ZOOM.max);
  const fx = clamp(focus.x, -21, 21), fz = clamp(focus.z * .55, -6, 6);
  switch (mode) {
    case 'broadcast': {
      // The TV camera high in the stands opposite the benches: pans with the play, as on a hockey broadcast.
      // (portrait screens and a wide zoom-out widen the lens instead of leaving the building)
      // Far enough to keep both boards in the picture, like an NHL broadcast.
      const k = wide * z, d = 25 * Math.min(k, 1.5), lz = fz * .45;
      return { pos: { x: fx * .9, y: d * .5, z: lz + d * .86 }, look: { x: fx, y: .3, z: lz - 1.2 }, fov: clamp(38 * Math.max(1, k / 1.5), 28, 72) };
    }
    case 'high': {
      const k = wide * z, h = 27 * Math.min(k, 1.5);
      return { pos: { x: fx * .7, y: h, z: fz + h * .42 }, look: { x: fx * .7, y: 0, z: fz * .5 }, fov: clamp(42 * Math.max(1, k / 1.5), 30, 75) };
    }
    case 'ice': {
      // Low at the near boards, just above the glass line, panning with the play (inside the glass: the boards and
      // the penalty boxes behind it never cut into the picture).
      return { pos: { x: clamp(fx * .85, -24, 24), y: 2.6, z: RINK.width / 2 - .35 }, look: { x: fx, y: .6, z: fz - 1.5 }, fov: clamp(48 * z * Math.min(1.3, wide), 18, 80) };
    }
    case 'end': {
      // High behind the net of the zone the puck is in, looking down the ice.
      const dir = focus.x >= 0 ? 1 : -1;
      const look = { x: dir * 12 + (fx - dir * 12) * .35, y: 0, z: fz * .6 }, base = { x: dir * 35, y: 12.5, z: 0 };
      const k = Math.min(z, 1.15);
      return { pos: { x: look.x + (base.x - look.x) * k, y: base.y * Math.sqrt(k), z: look.z + (base.z - look.z) * k }, look, fov: clamp(44 * Math.max(1, z / 1.15) * Math.min(1.3, wide), 30, 72) };
    }
    case 'overhead': {
      // Almost straight down from the roof (tilted a touch so «up» on the screen stays the far boards).
      const k = wide * z, h = 30 * Math.min(k, 1.4);
      return { pos: { x: fx, y: h, z: fz + h * .12 }, look: { x: fx, y: 0, z: fz }, fov: clamp(44 * Math.max(1, k / 1.4), 30, 78) };
    }
    case 'dynamic': {
      // Low and close to the play; it pulls back and up as the puck speeds up (a rush, a long pass, a shot).
      const k = wide * z, sp = clamp(ctx.speed ?? 0, 0, 30), d = (13.5 + sp * .3) * Math.min(k, 1.5), lz = fz * .5;
      return { pos: { x: fx * .95, y: d * (.4 + sp * .004), z: lz + d * .9 }, look: { x: fx, y: .5, z: lz - .6 }, fov: clamp(40 * Math.max(1, k / 1.5), 28, 72) };
    }
    case 'zone': {
      // Holds the zone the puck is in (and centre ice in the neutral zone) instead of following every pass.
      const k = wide * z, zx = Math.sign(fx) * 17 * smooth01((Math.abs(fx) - 5) / 8), d = 23 * Math.min(k, 1.5), lz = fz * .3;
      return { pos: { x: zx * .9, y: d * .52, z: lz + d * .85 }, look: { x: zx, y: .3, z: lz - 1 }, fov: clamp(40 * Math.max(1, k / 1.5), 28, 74) };
    }
    case 'vertical': {
      // Behind the manager's own net side, looking up the ice toward the net he attacks, following the puck.
      const att = ctx.attack ?? 1, k = Math.min(wide * z, 1.35), d = 12.5 * k, h = 8.5 * k;
      return { pos: { x: fx - att * d, y: h, z: fz * .45 }, look: { x: clamp(fx + att * 6, -30, 30), y: 0, z: fz * .65 }, fov: clamp(50 * Math.max(1, wide * z / 1.35), 30, 78) };
    }
  }
}

