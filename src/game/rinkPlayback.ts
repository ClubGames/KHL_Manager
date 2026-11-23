import type { GameEvent, Player, Team } from '../types';

// Presentation only. The engine records shot locations, not tracking data.
// All paths are deterministic reconstructions; never consume unrevealed engine events here.
export type Point = { x: number; y: number; h: number };
export type Key = Point & { t: number };
export type Track = { id: string; side: 0 | 1; goalie?: boolean; keys: Key[] };
export type ReplayClip = { label: string; duration: number; release: number; goal: number; tracks: Track[]; puck: Key[]; scorer: string; attacking: 0 | 1 };
export const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
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
export function eventSeed(e: GameEvent): number {
  let n = (e.sec * 101 + e.period * 17) | 0;
  for (const c of `${e.team}:${e.player}:${e.shotType}`) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
  return n >>> 0;
}
export function lineupIds(team: Team, players: Record<string, Player>): string[] {
  return team.players.filter(id => players[id] && players[id].position !== 'G' && !players[id].inVhl).slice(0, 5);
}
export function buildReplayClip(e: GameEvent, home: Team, away: Team, players: Record<string, Player>): ReplayClip | null {
  if (!e.player || !players[e.player]) return null;
  const side: 0 | 1 = e.team === away.id ? 1 : 0;
  const other: 0 | 1 = side === 0 ? 1 : 0;
  const teams = [home, away];
  const seed = eventSeed(e), sign = seed % 2 ? 1 : -1;
  const sx = clamp(e.x === undefined ? (e.zone === 'point' ? 72 : e.zone === 'crease' ? 89 : 81) : side ? 100 - e.x : e.x, 5, 92);
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
    const hx = i === 0 ? (shot === 'tip' || shot === 'rebound' ? 73 : sx - 8) : 66 + i * 3;
    const hy = i === 0 ? clamp(50 - sign * 27, 8, 92) : [22, 78, 42, 62, 50][i % 5];
    tracks.push({ id, side, keys: [key(0, hx - (rush ? 22 : 3), hy + sign * 4), key(.32, hx, hy), key(.54, hx + 1, hy + sign * 2), key(1, Math.min(88, hx + 10), hy - sign * 7)] });
  });
  defense.forEach((id, i) => {
    // Collapse into lanes, trail the shooter, contest the crease; not five stationary spectators.
    const ex = [sx - 2, 85, 78, 70, 81][i % 5], ey = [sy + sign * 7, 49, 27, 72, 65][i % 5];
    tracks.push({ id, side: other, keys: [key(0, clamp(ex - (rush ? 20 : 2), 12, 91), clamp(ey - sign * 9, 8, 92)), key(.54, clamp(ex, 10, 91), clamp(ey, 8, 92)), key(1, clamp(ex + 3, 10, 91), clamp(ey - sign * 4, 8, 92))] });
  });
  const at = (id: string, t: number) => ({ ...samplePath(tracks.find(tr => tr.id === id)!.keys, t), t });
  let puck: Key[];
  if (helpers.length) {
    const primary = helpers[0], secondary = helpers[1];
    puck = secondary ? [at(secondary, 0), at(secondary, .16), at(primary, .29), at(primary, .32), at(primary, .43)] : [at(primary, 0), at(primary, .32), at(primary, .43)];
    puck.push(at(e.player, .56), at(e.player, release));
  } else puck = scorer.filter(k => k.t <= release).map(k => ({ ...k }));
  const targetY = 50 + sign * (1.6 + seed % 13 / 10);
  const height = shot === 'rebound' ? .14 : shot === 'backhand' ? .7 : .4 + seed % 60 / 100;
  if (shot === 'tip' || shot === 'rebound') {
    // First attempt from the point; rebound off the goalie or a stick deflection at the actual shot location.
    const origin = helpers[0] ? at(helpers[0], .43) : key(.43, 72, 50 - sign * 23);
    puck = helpers[0] ? [at(helpers[0], 0), origin] : [key(0, 72, 50 - sign * 23), origin];
    if (shot === 'rebound') puck.push(key(.53, 90, 50 + (origin.y - 50) * .12, .15));
    puck.push(key(.61, sx, sy, shot === 'tip' ? .28 : 0), key(release, sx, sy, shot === 'tip' ? .28 : 0));
  }
  puck.push(key(release + flight / 2, (sx + 93) / 2, (sy + targetY) / 2, height), key(goal, 93.3, targetY, height * .8), key(goal + .06, 95.4, targetY, .2), key(1, 94.4, targetY + .5, 0));
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
  const mirror = (p: Key) => side ? { ...p, x: 100 - p.x } : p;
  return { label: e.strength === 'EN' ? 'Бросок в пустые ворота' : labels[shot], duration: 8, release, goal, tracks: tracks.map(tr => ({ ...tr, keys: tr.keys.map(mirror) })), puck: puck.map(mirror), scorer: e.player, attacking: side };
}

export type LiveFrame = { puck: Point; skaters: { id: string; side: 0 | 1; pos: Point; goalie?: boolean }[] };
export function liveRinkFrame(sec: number, ids: [string[], string[]], goalies: [string | null, string | null], event: GameEvent | null, homeId: string): LiveFrame {
  // Continuous presentation between discrete events. The same clock as the feed freezes on pause/replay.
  const phase = sec / 110;
  const cx = 50 + 23 * Math.sin(phase), cy = 50 + 22 * Math.sin(phase * 1.7);
  let puck: Point = { x: cx + 5 * Math.sin(phase * 4), y: cy + 4 * Math.cos(phase * 3), h: 0 };
  const skaters: LiveFrame['skaters'] = [];
  ids.forEach((list, side) => list.forEach((id, i) => {
    const attack = side === 0 ? 1 : -1;
    skaters.push({ id, side: side as 0 | 1, pos: { x: clamp(cx + attack * (i < 3 ? 5 : -16) + 8 * Math.sin(phase * 1.3 + i * 2 + side), 9, 91), y: clamp(cy + (i % 3 - 1) * 21 + 5 * Math.cos(phase * 2 + i), 8, 92), h: 0 } });
  }));
  // Carry, then pass to a moving teammate, rather than letting a free-floating puck orbit the rink.
  const possession = Math.floor(phase / 2) % 2;
  const carriers = skaters.filter(s => s.side === possession);
  if (carriers.length) {
    const cycle = phase * 2, index = Math.floor(cycle) % carriers.length;
    const a = carriers[index].pos, b = carriers[(index + 1) % carriers.length].pos;
    const pass = clamp(((cycle % 1) - .70) / .30, 0, 1);
    puck = { x: a.x + (b.x - a.x) * pass + .8, y: a.y + (b.y - a.y) * pass, h: 0 };
  }
  const age = event ? sec - event.sec : Infinity;
  if (event && event.x !== undefined && event.y !== undefined && age >= 0 && age < 35) {
    const u = clamp(age / 12, 0, 1), right = event.team === homeId;
    const shooter = skaters.find(s => s.id === event.player);
    if (shooter) shooter.pos = { x: event.x, y: event.y, h: 0 };
    const endX = event.type === 'goal' ? (right ? 94 : 6) : (right ? 90 : 10);
    puck = { x: event.x + (endX - event.x) * u, y: event.y + (50 - event.y) * u, h: 0 };
  }
  goalies.forEach((id, side) => {
    if (id) skaters.push({ id, side: side as 0 | 1, goalie: true, pos: { x: side ? 90 : 10, y: 50 + (puck.y - 50) * .1, h: 0 } });
  });
  return { puck, skaters };
}
