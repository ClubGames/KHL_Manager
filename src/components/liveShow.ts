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
export type ReplayKind = 'goal' | 'save' | 'post' | 'hit' | 'miss' | 'penalty' | 'shootout' | 'pshot';
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

/**
 * Every faceoff, from above: the camera over the faceoff circle looking down at the dot — the dot in the middle of
 * the picture, wherever on the ice it is (an end-zone circle is not off at the side of the screen) — easing down a
 * little while the players take their places (`k` 0…1); the match camera takes over once the puck is dropped. The
 * far side of the rink stays at the top of the picture, as on the match camera.
 * `after`: how long a stoppage runs (s of the match) before the camera goes up over the dot (a replay of the big
 * moment before the whistle is chosen first, see MOMENT_GAP).
 */
export const FACEOFF_CAM = { descend: 3.2, handover: 1.1, after: 1.1 };
export function faceoffCamera(dot: { x: number; z: number }, k: number): Cam {
  const u = clamp(k, 0, 1), e = u * u * (3 - 2 * u);
  // a slight tilt from the near side (≈ 80° down) gives the players some depth; the look stays on the dot
  const pos = { x: dot.x, y: 17 + (12.5 - 17) * e, z: dot.z + .05 + 2.1 * e };
  return { pos, look: { x: dot.x, y: 0, z: dot.z }, fov: 46 - 4 * e };
}
export const mixCam = (a: Cam, b: Cam, k: number): Cam => {
  const l = (x: number, y: number) => x + (y - x) * k;
  return { pos: { x: l(a.pos.x, b.pos.x), y: l(a.pos.y, b.pos.y), z: l(a.pos.z, b.pos.z) }, look: { x: l(a.look.x, b.look.x), y: l(a.look.y, b.look.y), z: l(a.look.z, b.look.z) }, fov: l(a.fov, b.fov) };
};

/* ---------------- a penalty: the referee's call, the replay of the infraction, the walk to the box ---------------- */

/** How long the referee's call is shown (s, the clock held): the arm up, the signal of the infraction, the point to the box. */
export const ANNOUNCE = { armUp: .9, signal: 2.4, point: 1.5, length: 4.8 };
/** The referee's signal `t` seconds into the announcement. */
export function announceGesture(t: number): { phase: 'armUp' | 'signal' | 'point'; t: number } {
  if (t < ANNOUNCE.armUp) return { phase: 'armUp', t };
  if (t < ANNOUNCE.armUp + ANNOUNCE.signal) return { phase: 'signal', t: t - ANNOUNCE.armUp };
  return { phase: 'point', t: t - ANNOUNCE.armUp - ANNOUNCE.signal };
}
/** The penalty's caption from the rinks' text («Удаление: Имя — причина (2 мин)» / «…, 2 мин»). */
export function penaltyCaption(text: string): { name: string; reason: string } {
  const body = text.replace(/^Удаление:\s*/, '');
  const [name, ...rest] = body.split(' — ');
  const reason = rest.join(' — ').replace(/^\s+|\s+$/g, '');
  // the length: "2 мин", "2+2 мин", "2+10 мин", "5 мин + ДдКМ", "ДдКМ", "матч-штраф"
  const LEN = '((?:\\d+(?:\\+\\d+)? мин(?: \\+ ДдКМ)?)|ДдКМ|матч-штраф)';
  const tail = name.match(new RegExp(`^(.*?),\\s*${LEN}$`));
  if (tail) return { name: tail[1].trim(), reason: tail[2] };
  return { name: name.trim(), reason: reason.replace(new RegExp(`,\\s*${LEN}$`), ' ($1)') };
}
/** The infraction's replay: from a few seconds before it (the delayed call marks it, else just before the whistle). */
export function penaltyReplay(callTau: number, infractionTau: number | null, text: string, player?: string): ReplaySpec {
  const key = infractionTau ?? callTau - .25;
  return { kind: 'penalty', from: key - 3, to: Math.min(callTau + .6, key + 1.6), key, netX: null, text, player };
}
/** The camera on the referee making the call: in front of him, a little to the side, at eye height, a long lens. */
export function announceCamera(ref: { x: number; z: number; heading: number }, t: number): Cam {
  const a = ref.heading - .35 + t * .03, d = 4.4 - Math.min(1, t / 4) * .6;
  // the heading convention: facing (cos h, −sin h) in x, z
  const pos = { x: clamp(ref.x + Math.cos(a) * d, -28, 28), y: 1.7, z: clamp(ref.z - Math.sin(a) * d, -13.6, 13.6) };
  return { pos, look: { x: ref.x, y: 1.35, z: ref.z }, fov: 32 };
}
/** Following the penalised man to the box (the near side): from the ice, between him and the middle of the rink. */
export function boxCamera(p: { x: number; z: number }): Cam {
  return { pos: { x: clamp(p.x * .85, -26, 26), y: 2.6, z: clamp(p.z - 7.5, -12, 9) }, look: { x: p.x, y: 1, z: p.z + .4 }, fov: 40 };
}

/* ---------------- after a goal: the scorers skate along their bench for the fist bumps ---------------- */

/** The fist-bump line: pace (m/s), the gap between two men (s), the lane along the bench boards (world z), how far past the bench ends. */
export const BUMP = { pace: 2.9, gap: .55, z: -(15 - .85), over: 5.6 };
export type BumpPlan = { ids: string[]; benchX: number; x0: number; x1: number; length: number };
/** The line: the scorer first, the others after him; they skate toward −x so the bench (−z) is on their right. */
export function bumpPlan(ids: string[], benchX: number): BumpPlan {
  const x0 = benchX + BUMP.over, x1 = benchX - BUMP.over;
  return { ids, benchX, x0, x1, length: (x0 - x1 + Math.max(0, ids.length - 1) * BUMP.gap * BUMP.pace) / BUMP.pace + .5 };
}
/** Everybody in the line at time t: on the lane, the glove out while he passes the bench. */
export function bumpPose(plan: BumpPlan, t: number): Map<string, { x: number; z: number; heading: number; speed: number; bump: number }> {
  const out = new Map<string, { x: number; z: number; heading: number; speed: number; bump: number }>();
  // a gentle curve in to the boards before the bench and out again after it
  const zAt = (x: number) => {
    const outside = Math.max(0, Math.abs(x - plan.benchX) - (BUMP.over - 1.2));
    return BUMP.z + Math.min(2.4, outside * outside * .12);
  };
  plan.ids.forEach((id, k) => {
    const x = plan.x0 + k * BUMP.gap * BUMP.pace - BUMP.pace * t, z = zAt(x);
    // skating toward −x: the heading from the slope of the lane (facing (cos h, −sin h))
    const slope = (zAt(x + .05) - zAt(x - .05)) / .1;
    const bump = clamp((Math.min(x - (plan.benchX - 4.6), plan.benchX + 4.6 - x)) / .8, 0, 1);
    out.set(id, { x, z, heading: Math.atan2(slope, -1), speed: BUMP.pace, bump });
  });
  return out;
}
/** How much a man on the bench at `seatX` reaches out over the boards (a skater passing in front of him). */
export function bumpReach(poses: Map<string, { x: number; bump: number }>, seatX: number): number {
  let r = 0;
  poses.forEach(p => { r = Math.max(r, p.bump * clamp(1 - Math.abs(p.x - seatX) / 1.8, 0, 1)); });
  return r;
}
/** The fist-bump camera: on the ice ahead of the line, looking back along the bench at the scorer. */
export function bumpCamera(lead: { x: number; z: number }): Cam {
  return { pos: { x: clamp(lead.x - 4.4, -27, 27), y: 1.8, z: BUMP.z + 4.6 }, look: { x: lead.x + 1.2, y: 1.15, z: BUMP.z - .5 }, fov: 42 };
}
