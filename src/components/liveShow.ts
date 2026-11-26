import type { RinkPlay } from '../game/rinkAI';

/**
 * The live 3D match as a TV broadcast shows it between the plays: after a goal the scorer's celebration in
 * close-up and then the replay of the goal; at a stoppage the replay of a dangerous or spectacular moment that came
 * just before it (a big save, a shot off the post, a hit that put a man down). The replays are the real thing —
 * the very frames the rink played, read again — with a slow-motion stretch around the key moment and TV angles
 * (a low side camera along the play, then behind the net or at ice level). The viewer can skip all of it.
 *
 * Pure (no three.js): rink presentation time `tau`, world metres (origin at centre ice). The tests run it in Node.
 */
export type ReplayKind = 'goal' | 'save' | 'post' | 'hit' | 'miss';
export type ReplaySpec = {
  kind: ReplayKind; from: number; to: number;
  /** the key moment: the slow motion runs around it and the camera cuts to the close angle before it */
  key: number;
  /** the net the play went at (world x), null for a hit away from the nets */
  netX: number | null;
  text: string; player?: string;
};

/** Goals: the live celebration (rink seconds), then the replay from a few seconds before the goal. */
export const GOAL_SHOW = { celebrate: 3.4, before: 5.4, after: 1.5 };
/** Slow motion around the key moment: from `before` seconds ahead to `after` past it, at `rate`. */
export const SLOW = { before: 1.0, after: .55, rate: .36 };
/** The least game time between two replays of moments at stoppages (seconds of the game clock). */
export const MOMENT_GAP = 150;

/** Real seconds the replay lasts. */
export function replayLength(r: ReplaySpec): number {
  const a = Math.max(r.from, r.key - SLOW.before), b = Math.min(r.to, r.key + SLOW.after);
  return (a - r.from) + Math.max(0, b - a) / SLOW.rate + Math.max(0, r.to - b);
}
/** The rink time shown `real` seconds into the replay. */
export function replayTau(r: ReplaySpec, real: number): number {
  const a = Math.max(r.from, r.key - SLOW.before), b = Math.min(r.to, r.key + SLOW.after);
  if (real <= a - r.from) return r.from + Math.max(0, real);
  const slow = (b - a) / SLOW.rate;
  if (real <= a - r.from + slow) return a + (real - (a - r.from)) * SLOW.rate;
  return Math.min(r.to, b + real - (a - r.from) - slow);
}

/** How much a play is worth a replay (0: not). */
export function momentScore(p: RinkPlay): { kind: ReplayKind; score: number } | null {
  const t = p.text.toLowerCase();
  if (p.kind === 'wide' && t.includes('штанга')) return { kind: 'post', score: 3 };
  if (p.kind === 'wide' && t.includes('пустых')) return { kind: 'miss', score: 2.5 };
  if (p.kind === 'save' || (p.kind === 'freeze' && (t.includes('сейв') || t.includes('ловит')))) return { kind: 'save', score: 2.2 };
  if (p.kind === 'freeze' && t.includes('накрывает')) return { kind: 'save', score: 2 };
  if (p.kind === 'hit' && t.includes('на льду')) return { kind: 'hit', score: 2.6 };
  if (p.kind === 'hit' && !t.includes('увернулся') && !t.includes('устоял')) return { kind: 'hit', score: 1.2 };
  if (p.kind === 'block') return { kind: 'save', score: 1.4 };
  return null;
}

/**
 * The moment worth a replay among the plays in (from, to] — the best one (the latest of equals), at least a
 * proper chance or a big hit; none when a goal is among them (the goal has its own show).
 */
export function pickMoment(plays: readonly RinkPlay[], from: number, to: number): (RinkPlay & { kind2: ReplayKind; score: number }) | null {
  let best: (RinkPlay & { kind2: ReplayKind; score: number }) | null = null;
  for (const p of plays) {
    if (p.tau <= from || p.tau > to) continue;
    if (p.kind === 'goal') return null;
    if (p.kind === 'freeze' && p.text.startsWith('Сирена')) return null;
    const m = momentScore(p);
    if (!m || m.score < 2) continue;
    if (!best || m.score >= best.score) best = { ...p, kind2: m.kind, score: m.score };
  }
  return best;
}

/** A moment's replay window: a few seconds of the build-up, the key moment, a moment after (not past `limit`). */
export function momentReplay(m: RinkPlay & { kind2: ReplayKind }, netX: number | null, limit: number): ReplaySpec {
  const key = m.tau;
  return { kind: m.kind2, from: key - (m.kind2 === 'hit' ? 3 : 3.8), to: Math.min(limit, key + 1.5), key, netX: m.kind2 === 'hit' ? null : netX, text: m.text, player: m.player };
}
/** A goal's replay window. */
export function goalReplay(goalTau: number, netX: number, text: string, player?: string): ReplaySpec {
  return { kind: 'goal', from: goalTau - GOAL_SHOW.before, to: goalTau + GOAL_SHOW.after, key: goalTau, netX, text, player };
}

type V3 = { x: number; y: number; z: number };
export type Cam = { pos: V3; look: V3; fov: number };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Which angle the replay is on at rink time `vt`: the side camera along the build-up, the close one from before the key moment. */
export function replayAngle(r: ReplaySpec, vt: number): 'side' | 'close' {
  return vt < r.key - SLOW.before - .1 ? 'side' : 'close';
}

/**
 * The replay's camera at rink time `vt`, looking at `focus` (the puck, smoothed by the caller): a low camera on
 * the near side along the build-up; then, for a play at a net, from behind and above the net looking out at the
 * shooter; for a hit, low at ice level beside it.
 */
export function replayCamera(r: ReplaySpec, vt: number, focus: { x: number; z: number }): Cam {
  if (replayAngle(r, vt) === 'side') {
    return { pos: { x: clamp(focus.x * .82, -22, 22), y: 4.4, z: 17.5 }, look: { x: focus.x, y: .7, z: focus.z * .6 }, fov: 36 };
  }
  if (r.netX !== null) {
    const s = Math.sign(r.netX) || 1;
    // behind the net, a little to the side away from the play, above the glass line
    return { pos: { x: s * 29.2, y: 2.9, z: clamp(-focus.z * .35, -3.5, 3.5) + 1.2 }, look: { x: focus.x - s * 1.5, y: .6, z: focus.z }, fov: 44 };
  }
  const zSide = focus.z > 0 ? -1 : 1;
  return { pos: { x: clamp(focus.x + 4.5, -27, 27), y: 1.35, z: clamp(focus.z + zSide * 7.5, -13.8, 13.8) }, look: { x: focus.x, y: 1, z: focus.z }, fov: 38 };
}

/** The celebration close-up: in front of the scorer (on the side of centre ice), slowly circling him. */
export function celebrateCamera(t: number, scorer: { x: number; z: number }): Cam {
  const a = Math.atan2(-scorer.z, -scorer.x) + Math.sin(t * .4) * .55;
  const d = 4.8 - Math.min(1, t / 3) * .8;
  const pos = { x: clamp(scorer.x + Math.cos(a) * d, -28.5, 28.5), y: 1.9, z: clamp(scorer.z + Math.sin(a) * d, -13.5, 13.5) };
  return { pos, look: { x: scorer.x, y: 1.2, z: scorer.z }, fov: 34 };
}
