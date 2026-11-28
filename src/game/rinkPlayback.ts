import type { GameEvent, Player, Team } from '../types';
import { endsSwitched, FACEOFF_SPOTS, pctX, pctY, RINK } from './rinkGeometry';

// Presentation only. The engine records shot locations, not tracking data.
// Deterministic motion is prepared privately; scores, names and outcomes are revealed only by Match at event.sec.
export type Point = { x: number; y: number; h: number };
export type Key = Point & { t: number };
export type Track = { id: string; side: 0 | 1; goalie?: boolean; keys: Key[] };
/** `bodies`: track positions are skater bodies (agent simulation), not stick blades (legacy reconstruction).
 *  `dir`: the attacked net is at +x (1) or -x (-1); teams switch ends between periods. */
/** `touches`: who had the puck on his stick, when (clip time 0..1) — passes and shots are animated from them.
 *  `shot`: the type of the goal shot (windup and follow-through of the scorer). */
export type ReplayClip = { label: string; duration: number; release: number; goal: number; tracks: Track[]; puck: Key[]; scorer: string; attacking: 0 | 1; bodies?: boolean; dir?: 1 | -1; touches?: { id: string; t0: number; t1: number }[]; shot?: GameEvent['shotType'] };
export const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
/** Direction of the attack in a clip: +1 toward the right-hand net (x = 100), -1 toward the left one. */
export const attackDir = (clip: Pick<ReplayClip, 'attacking' | 'dir'>): 1 | -1 => clip.dir ?? (clip.attacking ? -1 : 1);
const key = (t: number, x: number, y: number, h = 0): Key => ({ t, x, y, h });
export function samplePath(path: Key[], time: number, smooth = false): Point {
  if (!path.length) return { x: 50, y: 50, h: 0 };
  if (time <= path[0].t) return { ...path[0] };
  for (let i = 1; i < path.length; i++) {
    if (time > path[i].t) continue;
    const a = path[i - 1], b = path[i];
    let u = clamp((time - a.t) / (b.t - a.t || 1), 0, 1);
    if (smooth) u = u * u * (3 - 2 * u);
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, h: a.h + (b.h - a.h) * u };
  }
  return { ...path[path.length - 1] };
}
/** Smooth (Catmull–Rom) sampling through the keys, for bodies: no velocity kinks at every 0.1 s key. */
export function sampleSmooth(path: Key[], time: number): Point {
  const n = path.length;
  if (n < 3) return samplePath(path, time);
  if (time <= path[0].t) return { ...path[0] };
  if (time >= path[n - 1].t) return { ...path[n - 1] };
  let i = 1;
  while (i < n - 1 && time > path[i].t) i++;
  const p1 = path[i - 1], p2 = path[i], p0 = path[Math.max(0, i - 2)], p3 = path[Math.min(n - 1, i + 1)];
  const u = clamp((time - p1.t) / (p2.t - p1.t || 1), 0, 1), u2 = u * u, u3 = u2 * u;
  // Non-uniform key spacing: tangents scaled to the segment length so the curve never overshoots wildly.
  const d = p2.t - p1.t || 1, m1 = d / ((p2.t - p0.t) || 1), m2 = d / ((p3.t - p1.t) || 1);
  const f = (a: number, b: number, c: number, e: number) => {
    const t1 = (c - a) * m1, t2 = (e - b) * m2;
    return (2 * u3 - 3 * u2 + 1) * b + (u3 - 2 * u2 + u) * t1 + (-2 * u3 + 3 * u2) * c + (u3 - u2) * t2;
  };
  return { x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y), h: p1.h + (p2.h - p1.h) * u };
}
export function eventSeed(e: GameEvent): number {
  let n = (e.sec * 101 + e.period * 17) | 0;
  for (const c of `${e.team}:${e.player}:${e.shotType}`) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
  return n >>> 0;
}
export function lineupIds(team: Team, players: Record<string, Player>): string[] {
  return [...new Set([...(team.lineup.F[0] ?? []), ...(team.lineup.D[0] ?? []), ...team.players])].filter((id): id is string => !!id && !!players[id] && players[id].position !== 'G' && !players[id].inVhl).slice(0, 5);
}
export function buildReplayClip(e: GameEvent, home: Team, away: Team, players: Record<string, Player>): ReplayClip | null {
  if (!e.player || !players[e.player]) return null;
  const side: 0 | 1 = e.team === away.id ? 1 : 0;
  const other: 0 | 1 = side === 0 ? 1 : 0;
  const teams = [home, away];
  const seed = eventSeed(e), sign = seed % 2 ? 1 : -1;
  const sx = clamp(e.x === undefined ? (e.zone === 'point' ? 65 : e.zone === 'crease' ? 89 : 81) : side ? 100 - e.x : e.x, 5, 92);
  const sy = clamp(e.y ?? 50 + sign * 16, 6, 94);
  const shot = e.shotType ?? 'wrist';
  const rush = e.strength === 'SH' || (shot === 'backhand' && sx > 78);
  const labels = { wrist: rush ? 'Выход к воротам' : 'Кистевой бросок', snap: 'Бросок с ходу', slap: 'Щелчок', tip: 'Подставление на пятаке', rebound: 'Борьба за отскок', backhand: 'Перекладка и бросок с неудобной' };
  const release = shot === 'slap' ? .70 : shot === 'snap' ? .59 : shot === 'backhand' ? .72 : .66;
  const flight = shot === 'slap' ? .09 : shot === 'snap' ? .095 : shot === 'tip' ? .08 : shot === 'rebound' ? .10 : .14;
  const goal = release + flight;
  const rawAttack = e.ice?.[side] ?? lineupIds(teams[side], players).slice(0, e.period > 3 ? 3 : 5);
  const ids = [...new Set([e.player, ...(e.players ?? []), ...rawAttack])].filter((id): id is string => !!id && !!players[id] && players[id].position !== 'G').slice(0, 6);
  const defense = [...new Set(e.ice?.[other] ?? lineupIds(teams[other], players).slice(0, e.period > 3 ? 3 : 5))].filter((id): id is string => !!id && !!players[id] && players[id].position !== 'G');
  const helpers = (e.players ?? []).filter(id => ids.includes(id) && id !== e.player);
  const tracks: Track[] = [];
  const scorer = [key(0, sx - (rush ? 32 : shot === 'tip' || shot === 'rebound' ? 3 : 9), sy + sign * (rush ? 13 : 6)), key(.32, sx - (rush ? 15 : 4), sy - sign * 4), key(.54, sx - 1.4, sy + (shot === 'backhand' ? sign * 5 : 0)), key(release, sx, sy), key(1, Math.min(91, sx + 4), clamp(sy + sign * 10, 9, 91))];
  tracks.push({ id: e.player, side, keys: scorer });
  ids.slice(1).forEach((id, i) => {
    const hx = i === 0 ? (shot === 'tip' || shot === 'rebound' ? 66 : sx - 8) : 64 + i * 3;
    const hy = i === 0 ? clamp(50 - sign * 27, 8, 92) : [22, 78, 42, 62, 50][i % 5];
    tracks.push({ id, side, keys: [key(0, hx - (rush ? 22 : 3), hy + sign * 4), key(.32, hx, hy), key(.54, hx + 1, hy + sign * 2), key(1, Math.min(88, hx + 10), hy - sign * 7)] });
  });
  defense.forEach((id, i) => {
    // Collapse into lanes, trail the shooter, contest the crease; not five stationary spectators.
    const ex = [sx - 2, 85, 78, 67, 81][i % 5], ey = [sy + sign * 7, 49, 27, 72, 65][i % 5];
    tracks.push({ id, side: other, keys: [key(0, clamp(ex - (rush ? 20 : 2), 12, 91), clamp(ey - sign * 9, 8, 92)), key(.54, clamp(ex, 10, 91), clamp(ey, 8, 92)), key(1, clamp(ex + 3, 10, 91), clamp(ey - sign * 4, 8, 92))] });
  });
  const at = (id: string, t: number) => ({ ...samplePath(tracks.find(tr => tr.id === id)!.keys, t), t });
  let puck: Key[];
  if (helpers.length) {
    const primary = helpers[0], secondary = helpers[1];
    puck = secondary ? [at(secondary, 0), at(secondary, .16), at(primary, .29), at(primary, .32), at(primary, .43)] : [at(primary, 0), at(primary, .32), at(primary, .43)];
    puck.push(at(e.player, .56), at(e.player, release));
  } else puck = scorer.filter(k => k.t <= release).map(k => ({ ...k }));
  const targetY = e.type === 'miss' ? 50 + sign * 9 : 50 + sign * (1.6 + seed % 13 / 10);
  const height = shot === 'rebound' ? .14 : shot === 'backhand' ? .7 : .4 + seed % 60 / 100;
  if (shot === 'tip' || shot === 'rebound') {
    // First attempt from the point; rebound off the goalie or a stick deflection at the actual shot location.
    const origin = helpers[0] ? at(helpers[0], .43) : key(.43, 65, 50 - sign * 23);
    puck = helpers[0] ? [at(helpers[0], 0), origin] : [key(0, 65, 50 - sign * 23), origin];
    if (shot === 'rebound') puck.push(key(.53, 90, 50 + (origin.y - 50) * .12, .15));
    puck.push(key(.61, sx, sy, shot === 'tip' ? .28 : 0), key(release, sx, sy, shot === 'tip' ? .28 : 0));
  }
  const goalLine = 100 - pctX(RINK.goalLine), netBack = goalLine + pctX(RINK.goalDepth);
  const endX = e.type === 'shot' ? goalLine - 2.4 : goalLine + .3;
  puck.push(key(release + flight / 2, (sx + endX) / 2, (sy + targetY) / 2, height), key(goal, endX, targetY, e.type === 'shot' ? .1 : height * .8));
  if (e.type === 'shot') puck.push(key(1, endX, targetY, 0));
  else puck.push(key(goal + .06, netBack - .3, targetY, .2), key(1, netBack - 1, targetY + .5, 0));
  if (e.goalie !== null && e.strength !== 'EN') {
    const gid = e.goalie ?? teams[other].players.find(id => players[id]?.position === 'G');
    if (gid && players[gid]) {
      // Track the puck angle, then push TOWARD the shot. Remain in the crease instead of vacating the net.
      const goalieKeys = [0, .2, .43, .54, release, release + flight / 2, goal, 1].map(t => {
        const p = samplePath(puck, Math.max(0, t - .035));
        const y = t >= release + flight / 2 ? targetY : 50 + (p.y - 50) * .12;
        return key(t, t < release ? 90 : 90.8, clamp(y, 45.5, 54.5));
      });
      tracks.push({ id: gid, side: other, goalie: true, keys: goalieKeys });
    }
  }
  const ownGoalie = teams[side].lineup.starterG;
  if (ownGoalie && players[ownGoalie]) tracks.push({ id: ownGoalie, side, goalie: true, keys: [key(0, 10, 50), key(1, 10, 50)] });
  // Away attacks the left net in the 1st period; everybody switches ends every period.
  const flip = (side === 1) !== endsSwitched(e.period);
  const mirror = (p: Key) => flip ? { ...p, x: 100 - p.x } : p;
  return { label: e.strength === 'EN' ? 'Бросок в пустые ворота' : labels[shot], duration: 8, release, goal, tracks: tracks.map(tr => ({ ...tr, keys: tr.keys.map(mirror) })), puck: puck.map(mirror), scorer: e.player, attacking: side, dir: flip ? -1 : 1, shot };
}

/** Moves of the played match the 3D figures act out: dekes (side, toe drag, between the legs, spin-o-rama, shot fake), body checks (shoulder, hip, board pin), a stick lift, a kick off the skate, a dive, a fight, the goalie's freeze (glove / cover), the goal celebrations — and the infractions (FoulMove). */
export type LiveMove = 'side' | 'toe' | 'between' | 'spin' | 'fake' | 'shoulder' | 'hip' | 'pin' | 'lift' | 'reach' | 'push' | FoulMove
  /** a kick of the puck off the skate, a dive to block, a fight, the goalie's freeze (glove / covered), the goal celebrations */
  | 'kick' | 'dive' | 'fight' | 'glove' | 'cover' | 'cel1' | 'cel2' | 'cel3' | 'cel4' | 'celStick' | 'celKnee' | 'celPump' | 'celStickPump' | 'celKneePump';
/**
 * The infraction itself, acted out by the man who commits it: a forearm / elbow up into the head, an elbow, a knee,
 * a slash (the stick raised and chopped down), a high stick, a trip (the stick swept into the skates), a hook (the
 * blade round his waist, pulled), holding (a glove grabbing him), a cross-check (the shaft in both hands shoved into
 * him), roughing (punches), boarding / checking from behind (both arms shoving him into the boards).
 */
export type FoulMove = 'fHead' | 'fElbow' | 'fKnee' | 'fSlash' | 'fHigh' | 'fTrip' | 'fHook' | 'fHold' | 'fCross' | 'fRough' | 'fBoard';
/** How long each infraction takes (s): the move's progress 0…1 runs over it. */
export const FOUL_MOVE_DUR: Record<FoulMove, number> = { fHead: .8, fElbow: .7, fKnee: .65, fSlash: .6, fHigh: .7, fTrip: .6, fHook: .9, fHold: .9, fCross: .6, fRough: 1.3, fBoard: .65 };
/** The infraction move for a call (the KHL wording of the rinks and of the text simulation); null: a body check shows it (charging, interference) or nothing does. */
export function foulMove(reason: string): FoulMove | null {
  const t = reason.toLowerCase();
  if (t.includes('в голову') || t.includes('голов')) return 'fHead';
  if (t.includes('локт')) return 'fElbow';
  if (t.includes('колен') || t.includes('ногой')) return 'fKnee';
  if (t.includes('подножк') || t.includes('отсечен')) return 'fTrip';
  if (t.includes('задержка клюшкой') || t.includes('крюк')) return 'fHook';
  if (t.includes('задержка руками') || t.includes('захват') || t.includes('удержание') || (t.includes('задержка') && !t.includes('игры'))) return 'fHold';
  if (t.includes('толчок клюшкой') || t.includes('кросс') || t.includes('концом клюшки') || t.includes('колющ')) return 'fCross';
  if (t.includes('удар клюшкой') || t.includes('рубящ')) return 'fSlash';
  if (t.includes('высок') || t.includes('высота')) return 'fHigh';
  if (t.includes('груб') || t.includes('драк')) return 'fRough';
  if (t.includes('сзади') || t.includes('на борт')) return 'fBoard';
  return null;
}
/** Held stances of the played match: blocking a shot, a one-timer ready, calling for a pass, the defensive vision stance, a hustle burst, protecting the puck, board play, a stick sweep. */
export type LiveStance = 'block' | 'oneTimer' | 'call' | 'vision' | 'hustle' | 'protect' | 'board' | 'sweep';
export type LiveFrame = { puck: Point; skaters: { id: string; side: 0 | 1; pos: Point; goalie?: boolean; box?: boolean; /** facing (unit vector, metres: x along the rink, y across) when the rink AI knows it */ dir?: { x: number; y: number };
  /** the played match: the skater the manager controls; body language 0…1 (a fall, a body check, a poke check) and a deke (−1…1) */
  ctrl?: boolean; fall?: number; check?: number; poke?: number; deke?: number;
  /** the played match: a named move being acted out (deke kinds, body-check kinds, a stick lift) and its progress 0…1; a stagger after a hit 0…1 */
  move?: LiveMove; moveT?: number; stagger?: number;
  /** the jolt behind a stagger: the way he was knocked (unit vector, metres like `dir`) and how hard 0…1 */
  staggerDir?: { x: number; y: number }; staggerK?: number;
  /** the played match: a held stance and its blend 0…1; the manager's stickhandling (the blade forehand −1 … backhand 1 across him) */
  stance?: LiveStance; stanceT?: number; handle?: number;
  /** how a fallen skater went down (on his back, face first, sideways over the hip) and, sideways, to which side (±1) */
  fallKind?: 'back' | 'front' | 'side'; fallSide?: 1 | -1;
  /** stepping onto the ice from the bench: seconds left (he stands at the boards meanwhile; the 3D shows the climb) */
  hop?: number;
  /** through the bench door (stepping on, or on his way off) rather than over the boards */
  gate?: boolean }[]; faceoff?: boolean; stopped?: boolean; carrier?: string | null; caption?: string;
  /** during a stoppage: where the official who drops the puck at the next faceoff stands (known from the whistle) */
  official?: Point;
  /** during a stoppage: the dot of the next faceoff */
  dot?: Point;
  /** a penalty shot being got ready (the played match): the others going off, the puck put on the centre spot, the
   * shooter coming out, set for the whistle */
  psStage?: 'away' | 'place' | 'skate' | 'set' };
export function clipFrame(clip: ReplayClip, time: number): LiveFrame {
  return { puck: samplePath(clip.puck, time), skaters: clip.tracks.map(tr => ({ id: tr.id, side: tr.side, goalie: tr.goalie, pos: samplePath(tr.keys, time) })) };
}
/** Stable formation, used before play and at faceoffs. No event-triggered teleport logic. */
export function liveRinkFrame(sec: number, ids: [string[], string[]], goalies: [string | null, string | null], _event: GameEvent | null, _homeId: string): LiveFrame {
  const skaters: LiveFrame['skaters'] = [];
  ids.forEach((list, side) => list.forEach((id, i) => skaters.push({ id, side: side as 0 | 1, pos: {
    x: (side ? 53 : 47) + (side ? 1 : -1) * (i > 2 ? 17 : i * 6) + Math.sin(sec / 3 + i) * 2,
    y: [50, 24, 76, 35, 65, 50][i % 6], h: 0,
  } })));
  goalies.forEach((id, side) => { if (id) skaters.push({ id, side: side as 0 | 1, goalie: true, pos: { x: side ? 90 : 10, y: 50, h: 0 } }); });
  return { puck: { ...(skaters.find(s => !s.goalie)?.pos ?? { x: 50, y: 50, h: 0 }) }, skaters };
}
export type MotionSegment = { start: number; end: number; duration: number; clip?: ReplayClip; event?: GameEvent; from?: LiveFrame; to?: LiveFrame; faceoff?: boolean };
export type RinkTimeline = MotionSegment[];
const mix = (a: Point, b: Point, u: number): Point => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, h: a.h + (b.h - a.h) * u });
function blendFrames(a: LiveFrame, b: LiveFrame, u: number): LiveFrame {
  return { puck: mix(a.puck, b.puck, u), skaters: b.skaters.map((p, i) => {
    const old = a.skaters.find(q => q.id === p.id) ?? a.skaters.filter(q => q.side === p.side && !!q.goalie === !!p.goalie)[i % Math.max(1, a.skaters.filter(q => q.side === p.side && !!q.goalie === !!p.goalie).length)];
    return { ...p, pos: mix(old?.pos ?? p.pos, p.pos, u) };
  }) };
}
function faceoffFrame(ids: [string[], string[]], goalies: [string | null, string | null], x = 50, y = 50): LiveFrame {
  const frame = liveRinkFrame(0, ids, goalies, null, '');
  frame.skaters.forEach(p => { if (!p.goalie) {
    const index = ids[p.side].indexOf(p.id), sign = p.side ? 1 : -1;
    p.pos = { x: clamp(x + sign * (index === 0 ? 2 : index > 2 ? 17 : 9), 8, 92), y: clamp(y + [0, -19, 19, -12, 12, 0][index % 6], 8, 92), h: 0 };
  } });
  frame.puck = { x, y, h: .8 }; frame.faceoff = true; return frame;
}
const DOT_X = pctX(FACEOFF_SPOTS.end[0].x), DOT_Y = pctY(FACEOFF_SPOTS.end[0].y);
/** One authoritative set of paths. The 3D viewer receives these very clip objects, not a second reconstruction. */
export function buildRinkTimeline(events: GameEvent[], home: Team, away: Team, players: Record<string, Player>, start: number, end: number, initialFrame?: LiveFrame): RinkTimeline {
  const result: RinkTimeline = [];
  const ids: [string[], string[]] = [lineupIds(home, players), lineupIds(away, players)];
  const goalies: [string | null, string | null] = [home.lineup.starterG, away.lineup.starterG];
  let previous = initialFrame ?? faceoffFrame(ids, goalies), cursor = start;
  const bridge = (to: LiveFrame, until: number) => {
    if (until > cursor) result.push({ start: cursor, end: until, duration: clamp((until - cursor) / 15, 1.2, 2.5), from: previous, to });
    cursor = until; previous = to;
  };
  const faceoff = (until: number, x = 50, y = 50) => {
    const ready = faceoffFrame(ids, goalies, x, y);
    bridge(ready, Math.min(until, cursor + .5));
    if (until > cursor) {
      const dropped = { ...ready, puck: { x, y, h: 0 } };
      result.push({ start: cursor, end: until, duration: 1.5, from: ready, to: dropped, faceoff: true });
      previous = dropped; cursor = until;
    }
  };
  const shots = events.filter(e => ['goal', 'shot', 'miss', 'penalty'].includes(e.type) && e.player && players[e.player]).sort((a, b) => a.sec - b.sec || Number(b.type === 'goal') - Number(a.type === 'goal'));
  if (!initialFrame) faceoff(Math.min(end, start + 1, start + ((shots[0]?.sec ?? start + 5) - start) * .2));
  shots.forEach((e, i) => {
    if (e.sec <= cursor + .05) return;
    if (e.type === 'penalty') {
      bridge(previous, e.sec);
      faceoff(Math.min(end, (shots[i + 1]?.sec ?? end) - .1, e.sec + 1), (e.team === home.id) !== endsSwitched(e.period) ? DOT_X : 100 - DOT_X, DOT_Y);
      return;
    }
    const clip = buildReplayClip(e, home, away, players);
    if (!clip) return;
    const span = Math.min(8, (e.sec - cursor) * .8 / clip.goal);
    const begins = e.sec - clip.goal * span;
    // Never cross the next event or period boundary; event always lands at clip.goal.
    const nextSec = Math.min(end, shots[i + 1]?.sec ?? end);
    const tail = Math.min((1 - clip.goal) * span, Math.max(0, nextSec - e.sec) * .2);
    bridge(clipFrame(clip, 0), begins);
    result.push({ start: begins, end: e.sec, duration: clip.duration * clip.goal, clip, event: e });
    // Prefix and tail use normalized clip time separately (see timelineFrame).
    cursor = e.sec; previous = clipFrame(clip, clip.goal);
    if (tail > 0) {
      result.push({ start: cursor, end: cursor + tail, duration: clip.duration * (1 - clip.goal), clip, event: e });
      cursor += tail; previous = clipFrame(clip, 1);
    }
    if (e.ice) { ids[0] = e.ice[0].filter((id): id is string => !!id && !!players[id] && players[id].position !== 'G'); ids[1] = e.ice[1].filter((id): id is string => !!id && !!players[id] && players[id].position !== 'G'); }
    if (e.type !== 'miss' && nextSec > cursor + 1) faceoff(Math.min(nextSec - .1, cursor + 1), e.type === 'goal' ? 50 : (e.team === home.id) !== endsSwitched(e.period) ? 100 - DOT_X : DOT_X, e.type === 'goal' ? 50 : (e.y ?? 50) > 50 ? 100 - DOT_Y : DOT_Y);
  });
  bridge(previous, end);
  return result;
}
export function timelineFrame(timeline: RinkTimeline, sec: number): LiveFrame | null {
  const segment = timeline.find(s => sec <= s.end && sec >= s.start) ?? (sec < (timeline[0]?.start ?? 0) ? timeline[0] : timeline.at(-1));
  if (!segment) return null;
  const u = clamp((sec - segment.start) / (segment.end - segment.start || 1), 0, 1);
  if (segment.clip && segment.event) {
    const t = segment.end === segment.event.sec ? u * segment.clip.goal : segment.clip.goal + u * (1 - segment.clip.goal);
    return clipFrame(segment.clip, t);
  }
  const frame = blendFrames(segment.from!, segment.to!, u);
  frame.faceoff = segment.faceoff;
  return frame;
}
/** Consume wall time at selected speed, stopping at segment boundaries even on a slow frame. */
export function advanceRinkClock(timeline: RinkTimeline, sec: number, dt: number, speed: number): number {
  let remaining = dt * speed, clock = sec;
  for (const segment of timeline) {
    if (segment.end <= clock) continue;
    const rate = (segment.end - segment.start) / Math.max(.01, segment.duration);
    const needed = (segment.end - clock) / rate;
    if (remaining <= needed) return clock + remaining * rate;
    remaining -= needed; clock = segment.end;
  }
  return clock;
}
export function timelineGoalClip(timeline: RinkTimeline, event: GameEvent): ReplayClip | undefined {
  return timeline.find(s => s.event === event && s.end === event.sec)?.clip;
}
