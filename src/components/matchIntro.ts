import { RINK } from '../game/rinkGeometry';

/**
 * The teams take the ice before the first period (3D), the way a KHL broadcast shows it:
 *
 *  1. the lights go down and the laser show starts; the four officials skate out to the red line;
 *  2. the visitors come out of their gate one after another — the whole dressed team, the starting goalie first —
 *     and circle their half at an easy warm-up pace (long glides, not a sprint);
 *  3. their reserves peel off to the bench (over the boards onto their seats), the starting five, the goalie and
 *     the captain line up on their blue line facing centre ice; then the home team the same way, louder;
 *  4. the presentation: close-ups of each team's goalie, captain and leader with a caption;
 *  5. the captains skate to centre ice and shake hands with both referees, then with each other;
 *  6. the lights come up and everybody skates to his place for the opening faceoff (a captain who does not start
 *     goes to the bench), where the match takes over.
 *
 * Pure (no three.js): times are seconds of real time since the start, positions world metres (origin at centre
 * ice, x along the rink, z across it; the benches on −z, the cameras' side +z), headings the 3D scene's convention
 * (0 = facing +x, angle = atan2(−dz, dx)). The tests run it in Node.
 */
export type Seat = { x: number; y: number; z: number; heading: number };
export type IntroSkater = {
  id: string; side: 0 | 1; goalie: boolean;
  /** in the opening faceoff: where he has to be when the match starts */
  start: boolean; x: number; z: number;
  /** a reserve's seat on the bench (null / missing: he skates out through the gate, out of the picture) */
  seat?: Seat | null;
  captain?: boolean;
  /** for picking the team's leader for a close-up (the best rated lined-up skater after the captain) */
  rating?: number;
};
export type IntroPose = {
  x: number; y: number; z: number; heading: number; speed: number; visible: boolean;
  /** raising the stick to the crowd 0…1 */ wave: number;
  /** on his bench seat */ sit: boolean;
  /** the right hand out for a handshake 0…1 (and the shake's own time) */ shake: number;
};
export type IntroShot = { id: string; side: 0 | 1; kind: 'goalie' | 'captain' | 'leader'; t0: number; t1: number };
type P2 = { x: number; z: number };
type Path = { pts: P2[]; cum: number[]; len: number };
type Team = {
  side: 0 | 1; end: 1 | -1; out: number; peel: number; arrive: number;
  order: IntroSkater[];
  /** lined up on the blue line: the starting goalie and five, the captain (also when he does not start) */
  lined: IntroSkater[];
  captain: IntroSkater | null;
};
export type IntroPlan = {
  skaters: IntroSkater[]; teams: [Team, Team];
  /** phase times */
  t: { officials: number; away: number; home: number; lineup: number; present: number; hands: number; settle: number; length: number };
  shots: IntroShot[];
  /** per skater: the carousel path, his time out of the gate, his peel time and path, the line spot */
  route: Map<string, { carousel: Path; out: number; peel: number; peelPath: Path; peelDur: number; spot: P2 | null; seat: Seat | null; team: Team }>;
};

const HL = RINK.length / 2, HW = RINK.width / 2, BLUE = HL - RINK.blueLine;
/** Skating pace of the warm-up laps (m/s) and the gap between two players coming out (s). */
export const INTRO_PACE = { lap: 5.2, gap: .5, peel: 4.6, officials: 4.2 };
/** Stride length of the entrance's long glides (m per stride cycle): an easy rhythm, not quick little steps. */
export const INTRO_STRIDE = 5.2;
const SHOT = 2.7;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (v: number) => { const t = clamp(v, 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const dist = (a: P2, b: P2) => Math.hypot(a.x - b.x, a.z - b.z);
const head = (dx: number, dz: number) => Math.atan2(-dz, dx);
const angLerp = (a: number, b: number, u: number) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * u; };

function path(pts: P2[]): Path {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return { pts, cum, len: cum[cum.length - 1] };
}
function along(p: Path, s: number): P2 & { dx: number; dz: number } {
  const { pts, cum } = p;
  if (s <= 0) return { ...pts[0], dx: pts[1].x - pts[0].x, dz: pts[1].z - pts[0].z };
  if (s >= p.len) { const a = pts[pts.length - 2], b = pts[pts.length - 1]; return { ...b, dx: b.x - a.x, dz: b.z - a.z }; }
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
  const u = (s - cum[lo]) / (cum[hi] - cum[lo] || 1), a = pts[lo], b = pts[hi];
  return { x: lerp(a.x, b.x, u), z: lerp(a.z, b.z, u), dx: b.x - a.x, dz: b.z - a.z };
}
function bezier(a: P2, b: P2, c: P2, d: P2, n = 40): P2[] {
  const out: P2[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, v = 1 - u;
    out.push({ x: v * v * v * a.x + 3 * v * v * u * b.x + 3 * v * u * u * c.x + u * u * u * d.x, z: v * v * v * a.z + 3 * v * v * u * b.z + 3 * v * u * u * c.z + u * u * u * d.z });
  }
  return out;
}

/** The gate a team comes out of (by its bench, home on the −x side of centre ice). */
export function gateOf(side: 0 | 1) { return { x: side ? 9.7 : -9.7, z: -HW + .6 }; }
/** Which end a team defends at the start (its starters' side of centre ice in the opening formation). */
export function homeEnd(skaters: IntroSkater[], side: 0 | 1): 1 | -1 {
  const own = skaters.filter(s => s.side === side && s.start);
  const list = own.length ? own : skaters.filter(s => s.side === side);
  const mx = list.reduce((a, s) => a + s.x, 0) / Math.max(1, list.length);
  return mx >= 0 ? 1 : -1;
}
/** The order a team comes out in: the starting goalie first (as in the KHL), the skaters, the backup goalie last. */
export function lineup(skaters: IntroSkater[], side: 0 | 1) {
  const own = skaters.filter(s => s.side === side);
  return [...own.filter(s => s.goalie && s.start), ...own.filter(s => !s.goalie), ...own.filter(s => s.goalie && !s.start)];
}
/** The door in the boards in front of a bench seat. */
const doorOf = (s: P2) => ({ x: s.x, z: Math.sign(s.z || -1) * (HW - .45) });

/** The carousel: out of the gate, into a big loop through the team's half, round and round. */
function carousel(side: 0 | 1, end: 1 | -1, lane: number): Path {
  const g = gateOf(side), cx = end * 14.6, R = 7.6 + lane * .9;
  // into the circle where it is nearest to the gate, then round it (counter-clockwise seen from the cameras in the +x half)
  const a0 = Math.atan2(g.z - 0, g.x - cx), dir = -end;
  const entry = { x: cx + Math.cos(a0) * R, z: Math.sin(a0) * R };
  const tangent = { x: -Math.sin(a0) * dir, z: Math.cos(a0) * dir };
  const pts = bezier(g, { x: g.x, z: g.z + 3.2 }, { x: entry.x - tangent.x * 3, z: entry.z - tangent.z * 3 }, entry, 16);
  const steps = 64, laps = 5;
  for (let i = 1; i <= steps * laps; i++) { const a = a0 + dir * i / steps * Math.PI * 2; pts.push({ x: cx + Math.cos(a) * R, z: Math.sin(a) * R }); }
  return path(pts);
}

/** Lays the whole entrance out (once, when it starts). */
export function planIntro(skaters: IntroSkater[]): IntroPlan {
  const route: IntroPlan['route'] = new Map();
  const officials = 1.6, away = 7;
  const mk = (side: 0 | 1, out: number): Team => {
    const order = lineup(skaters, side), end = homeEnd(skaters, side);
    const captain = order.find(s => s.captain && !s.goalie) ?? null;
    const lined = order.filter(s => s.start || s === captain);
    const last = out + Math.max(0, order.length - 1) * INTRO_PACE.gap;
    const peel = last + 4.5;
    return { side, end, out, peel, arrive: peel, order, lined, captain };
  };
  const A = mk(1, away);
  const H = mk(0, A.peel + 1.2);
  for (const team of [A, H]) {
    // the line on the blue line: in the order they reach it (by where they are on the loop when they peel off)
    const spots = new Map<string, P2>();
    const m = team.lined.length;
    const peelAt = (k: number) => team.peel + k * .14;
    team.order.forEach((s, i) => {
      const c = carousel(team.side, team.end, i % 3 === 2 ? 1 : 0);
      const out = team.out + i * INTRO_PACE.gap;
      route.set(s.id, { carousel: c, out, peel: peelAt(i), peelPath: c, peelDur: 0, spot: null, seat: s.seat ?? null, team });
    });
    const byZ = [...team.lined].sort((p, q) => lapAt(route.get(p.id)!, route.get(p.id)!.peel).z - lapAt(route.get(q.id)!, route.get(q.id)!.peel).z);
    byZ.forEach((s, k) => spots.set(s.id, { x: team.end * (BLUE + .9), z: (k - (m - 1) / 2) * 1.75 }));
    for (const s of team.order) {
      const r = route.get(s.id)!;
      const q = lapAt(r, r.peel), dl = Math.hypot(q.dx, q.dz) || 1, tx = q.dx / dl, tz = q.dz / dl;
      const spot = spots.get(s.id) ?? null;
      let pts: P2[];
      if (spot) pts = bezier(q, { x: q.x + tx * 4, z: q.z + tz * 4 }, { x: spot.x + team.end * 3.5, z: spot.z }, spot);
      else {
        const target = r.seat ? doorOf(r.seat) : gateOf(team.side);
        pts = bezier(q, { x: q.x + tx * 4, z: q.z + tz * 4 }, { x: target.x, z: target.z + 3 }, target);
      }
      r.peelPath = path(pts); r.spot = spot;
      r.peelDur = r.peelPath.len / INTRO_PACE.peel * 1.5;
      team.arrive = Math.max(team.arrive, r.peel + r.peelDur + (spot ? .6 : r.seat ? .9 : 0));
    }
  }
  const lineupT = H.peel, present = H.arrive + .6;
  // the close-ups: visitors first — the goalie, the captain, the leader — then the home team
  const shots: IntroShot[] = [];
  let t = present;
  for (const team of [A, H]) {
    const g = team.lined.find(s => s.goalie && s.start);
    const leader = team.lined.filter(s => !s.goalie && s !== team.captain).sort((p, q) => (q.rating ?? 0) - (p.rating ?? 0))[0];
    const list: [IntroSkater | null | undefined, IntroShot['kind']][] = [[g, 'goalie'], [team.captain, 'captain'], [leader, 'leader']];
    for (const [s, kind] of list) if (s) { shots.push({ id: s.id, side: team.side, kind, t0: t, t1: t + SHOT }); t += SHOT; }
  }
  const hands = t + .4, settle = hands + (A.captain && H.captain ? 11.4 : 1.5);
  return { skaters, teams: [H, A], t: { officials, away, home: H.out, lineup: lineupT, present, hands, settle, length: settle + 5 }, shots, route };
}

/** Where a skater is on his carousel at time t (with a gentle start out of the gate). */
function lapAt(r: { carousel: Path; out: number }, t: number) {
  const u = t - r.out;
  const s = u < .8 ? INTRO_PACE.lap * u * u / 1.6 : INTRO_PACE.lap * (u - .4);
  return along(r.carousel, s);
}

/** Smooth moves through key points (x, z at time t); facing the way he skates, or `face` when standing. */
type Key = { t: number; x: number; z: number; face?: number };
function keyed(keys: Key[], t: number): { x: number; z: number; heading: number | null; speed: number } {
  if (t <= keys[0].t) return { x: keys[0].x, z: keys[0].z, heading: keys[0].face ?? null, speed: 0 };
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (t > b.t) continue;
    const d = b.t - a.t, u = d > 0 ? (t - a.t) / d : 1, k = smooth(u);
    const len = dist(a, b);
    if (len < .05) return { x: b.x, z: b.z, heading: b.face ?? a.face ?? null, speed: 0 };
    const sp = len / d * 6 * u * (1 - u);
    // turn into the move at its start, and to the facing at its end
    const travel = head(b.x - a.x, b.z - a.z);
    const h = u < .2 && a.face !== undefined ? angLerp(a.face, travel, u / .2) : u > .8 && b.face !== undefined ? angLerp(travel, b.face, (u - .8) / .2) : travel;
    return { x: lerp(a.x, b.x, k), z: lerp(a.z, b.z, k), heading: h, speed: sp };
  }
  const z = keys[keys.length - 1];
  return { x: z.x, z: z.z, heading: z.face ?? null, speed: 0 };
}

/** The captains' handshakes at centre ice: their key points, and the referees'. */
function handshake(plan: IntroPlan) {
  const [H, A] = plan.teams, t0 = plan.t.hands;
  if (!H.captain || !A.captain) return null;
  const eh = H.end, ea = A.end;
  const spot = (team: Team) => plan.route.get(team.captain!.id)!.spot!;
  const sh = spot(H), sa = spot(A);
  const faceIn = (e: number) => (e > 0 ? Math.PI : 0); // toward centre from his end
  const faceOut = (e: number) => (e > 0 ? 0 : Math.PI);
  const capH: Key[] = [{ t: t0, ...sh, face: faceIn(eh) }, { t: t0 + 2.2, x: eh * .85, z: -1, face: faceIn(eh) }, { t: t0 + 3.8, x: eh * .85, z: -1, face: faceIn(eh) }, { t: t0 + 5, x: eh * .85, z: 1, face: faceIn(eh) }, { t: t0 + 6.6, x: eh * .85, z: 1, face: faceIn(eh) }, { t: t0 + 7.6, x: eh * .5, z: 0, face: faceIn(eh) }, { t: t0 + 9.2, x: eh * .5, z: 0, face: faceIn(eh) }, { t: t0 + 11.2, ...sh, face: faceIn(eh) }];
  const capA: Key[] = [{ t: t0, ...sa, face: faceIn(ea) }, { t: t0 + 2.2, x: ea * .85, z: 1, face: faceIn(ea) }, { t: t0 + 3.8, x: ea * .85, z: 1, face: faceIn(ea) }, { t: t0 + 5, x: ea * .85, z: -1, face: faceIn(ea) }, { t: t0 + 6.6, x: ea * .85, z: -1, face: faceIn(ea) }, { t: t0 + 7.6, x: ea * .5, z: 0, face: faceIn(ea) }, { t: t0 + 9.2, x: ea * .5, z: 0, face: faceIn(ea) }, { t: t0 + 11.2, ...sa, face: faceIn(ea) }];
  // referee 1 on z −1 first faces the home captain, then the visitors'; referee 2 on z +1 the other way round
  const r1: Key[] = [{ t: t0 + 1.8, x: 0, z: -1, face: faceOut(eh) }, { t: t0 + 3.8, x: 0, z: -1, face: faceOut(eh) }, { t: t0 + 5, x: 0, z: -1.01, face: faceOut(ea) }, { t: t0 + 6.6, x: 0, z: -1.01, face: faceOut(ea) }, { t: t0 + 7.6, x: 0, z: -2.6, face: -Math.PI / 2 }];
  const r2: Key[] = [{ t: t0 + .9, x: 1.5, z: -2.4 }, { t: t0 + 2, x: 0, z: 1, face: faceOut(ea) }, { t: t0 + 3.8, x: 0, z: 1, face: faceOut(ea) }, { t: t0 + 5, x: 0, z: 1.01, face: faceOut(eh) }, { t: t0 + 6.6, x: 0, z: 1.01, face: faceOut(eh) }, { t: t0 + 7.6, x: 0, z: 2.6, face: -Math.PI / 2 }];
  const bell = (a: number, b: number, t: number) => (t > a && t < b ? Math.sin(Math.PI * smooth((t - a) / (b - a))) : 0);
  const shake = (t: number) => bell(t0 + 2.1, t0 + 3.9, t) + bell(t0 + 4.9, t0 + 6.7, t);
  const shakeCaps = (t: number) => shake(t) + bell(t0 + 7.5, t0 + 9.3, t);
  return { capH, capA, r1, r2, shake, shakeCaps, ids: [H.captain.id, A.captain.id] };
}

/** Where everyone is at time t of the entrance. */
export function introPoses(plan: IntroPlan, t: number): Map<string, IntroPose> {
  const out = new Map<string, IntroPose>();
  const hs = handshake(plan);
  const S = plan.t.settle;
  const hidden = (p: P2): IntroPose => ({ x: p.x, y: 0, z: p.z, heading: Math.PI / 2, speed: 0, visible: false, wave: 0, sit: false, shake: 0 });
  // before the settle: the entrance itself
  const before = (s: IntroSkater, tt: number): IntroPose => {
    const r = plan.route.get(s.id)!, team = r.team;
    if (tt < r.out) return hidden(gateOf(s.side));
    const faceIn = team.end > 0 ? Math.PI : 0;
    // the captains at centre ice
    if (hs && (s.id === hs.ids[0] || s.id === hs.ids[1]) && tt >= plan.t.hands) {
      const k = keyed(s.id === hs.ids[0] ? hs.capH : hs.capA, tt);
      return { x: k.x, y: 0, z: k.z, heading: k.heading ?? faceIn, speed: k.speed, visible: true, wave: 0, sit: false, shake: hs.shakeCaps(tt) };
    }
    if (tt < r.peel) {
      const p = lapAt(r, tt), u = tt - r.out;
      const speed = u < .8 ? INTRO_PACE.lap * u / .8 : INTRO_PACE.lap;
      // a wave to the crowd as he comes out
      const wave = smooth(u / .4) * (1 - smooth((u - 1.4) / .5)) * .8;
      return { x: p.x, y: 0, z: p.z, heading: head(p.dx, p.dz), speed, visible: true, wave, sit: false, shake: 0 };
    }
    const v = clamp((tt - r.peel) / r.peelDur, 0, 1);
    const sN = 1.5 * v - .5 * v * v * v, p = along(r.peelPath, sN * r.peelPath.len);
    const speed = r.peelPath.len / r.peelDur * 1.5 * (1 - v * v);
    if (v < 1) return { x: p.x, y: 0, z: p.z, heading: head(p.dx, p.dz), speed, visible: true, wave: 0, sit: false, shake: 0 };
    if (r.spot) {
      // in line, facing centre ice; a nod and the stick up in his close-up
      const shot = plan.shots.find(x => x.id === s.id && tt >= x.t0 && tt < x.t1);
      const wave = shot ? Math.sin(Math.PI * smooth((tt - shot.t0 - .5) / 1.6)) * .45 : 0;
      const k = clamp((tt - r.peel - r.peelDur) / .6, 0, 1);
      return { x: p.x, y: 0, z: p.z, heading: angLerp(head(p.dx, p.dz), faceIn, k), speed: 0, visible: true, wave: Math.max(0, wave), sit: false, shake: 0 };
    }
    // a reserve: over the boards onto his seat (or out through the gate)
    if (!r.seat) return hidden(p);
    const w = clamp((tt - r.peel - r.peelDur) / .9, 0, 1), k = smooth(w);
    const x = lerp(p.x, r.seat.x, k), z = lerp(p.z, r.seat.z, k), y = Math.sin(Math.PI * k) * .95 + r.seat.y * k;
    return { x, y, z, heading: angLerp(Math.atan2(-(r.seat.z - p.z), r.seat.x - p.x), r.seat.heading, k * k), speed: w < 1 ? 1.5 : 0, visible: true, wave: 0, sit: w >= 1, shake: 0 };
  };
  for (const s of plan.skaters) {
    if (!plan.route.has(s.id)) continue;
    const r = plan.route.get(s.id)!;
    if (t < S) { out.set(s.id, before(s, t)); continue; }
    // the settle: everybody to his place for the opening faceoff (a captain who does not start: to the bench)
    const from = before(s, S);
    if (!from.visible || from.sit) { out.set(s.id, from); continue; }
    if (!s.start) {
      const seat = r.seat, door = seat ? doorOf(seat) : gateOf(s.side);
      const k = keyed([{ t: S, x: from.x, z: from.z, face: from.heading }, { t: S + 3, x: door.x, z: door.z }], t);
      if (t < S + 3) { out.set(s.id, { x: k.x, y: 0, z: k.z, heading: k.heading ?? from.heading, speed: k.speed, visible: true, wave: 0, sit: false, shake: 0 }); continue; }
      if (!seat) { out.set(s.id, hidden(door)); continue; }
      const w = clamp((t - S - 3) / .9, 0, 1), kk = smooth(w);
      out.set(s.id, { x: lerp(door.x, seat.x, kk), y: Math.sin(Math.PI * kk) * .95 + seat.y * kk, z: lerp(door.z, seat.z, kk), heading: angLerp(from.heading, seat.heading, kk), speed: 0, visible: true, wave: 0, sit: w >= 1, shake: 0 });
      continue;
    }
    const face = r.team.end > 0 ? Math.PI : 0, j = Math.max(0, r.team.lined.indexOf(s));
    const dur = clamp(dist(from, s) / 3.8, 2.6, 4.4);
    const k = keyed([{ t: S + j * .07, x: from.x, z: from.z, face: from.heading }, { t: S + j * .07 + dur, x: s.x, z: s.z, face }], t);
    out.set(s.id, { x: k.x, y: 0, z: k.z, heading: k.heading ?? face, speed: k.speed, visible: true, wave: 0, sit: false, shake: 0 });
  }
  return out;
}

/** The officials: out from the timekeepers' side to the red line, the referees to the handshakes, then to their places. */
export function introOfficials(plan: IntroPlan, t: number, places: P2[]): (IntroPose & { gesture: 'none' | 'shake' })[] {
  const hs = handshake(plan);
  const S = plan.t.settle;
  return places.map((p, i) => {
    const t0 = plan.t.officials + i * .4;
    const from = { x: (i - 1.5) * .9, z: HW - .6 }, line = { x: 0, z: -2.6 - i * 2.1 };
    const toCam = -Math.PI / 2;
    const at = (tt: number) => {
      if (tt < t0) return { x: from.x, z: from.z, heading: -Math.PI / 2, speed: 0, shake: 0 };
      if (hs && i < 2 && tt >= plan.t.hands) {
        const k = keyed([{ t: plan.t.hands, ...line, face: toCam }, ...(i === 0 ? hs.r1 : hs.r2)], tt);
        return { x: k.x, z: k.z, heading: k.heading ?? toCam, speed: k.speed, shake: hs.shake(tt) };
      }
      const k = keyed([{ t: t0, ...from, face: Math.PI / 2 }, { t: t0 + dist(from, line) / INTRO_PACE.officials * 1.5, ...line, face: toCam }], tt);
      return { x: k.x, z: k.z, heading: k.heading ?? toCam, speed: k.speed, shake: 0 };
    };
    const a = at(Math.min(t, S));
    let pose = { ...a };
    if (t > S) { const k = keyed([{ t: S + .2, x: a.x, z: a.z, face: a.heading }, { t: S + 3.4, x: p.x, z: p.z }], t); pose = { x: k.x, z: k.z, heading: k.heading ?? a.heading, speed: k.speed, shake: 0 }; }
    return { x: pose.x, y: 0, z: pose.z, heading: pose.heading, speed: pose.speed, visible: t >= t0, wave: 0, sit: false, shake: pose.shake, gesture: pose.shake > .02 ? 'shake' : 'none' };
  });
}

/** Mean position of a team's skaters on the ice. */
function teamFocus(plan: IntroPlan, poses: Map<string, IntroPose>, side: 0 | 1): P2 | null {
  let x = 0, z = 0, n = 0;
  for (const s of plan.skaters) { if (s.side !== side) continue; const p = poses.get(s.id); if (p?.visible && !p.sit && p.y < .05) { x += p.x; z += p.z; n++; } }
  return n ? { x: x / n, z: z / n } : null;
}

/**
 * The show: `level` 0…1 how dark the arena is and how strong the lasers are; `team` whose colours the lasers and
 * the ice projection play (−1 both); `focus` where the spotlights are (the team coming out, the man in close-up).
 */
export function introShow(plan: IntroPlan, t: number, poses = introPoses(plan, t)): { level: number; team: 0 | 1 | -1; focus: P2; burst: number } {
  const T = plan.t;
  const level = smooth(t / 1.2) * (1 - smooth((t - T.settle + .4) / 1.6));
  const shot = plan.shots.find(s => t >= s.t0 && t < s.t1);
  const team: 0 | 1 | -1 = t < T.away - .3 ? -1 : t < T.home - .2 ? 1 : t < T.present ? 0 : shot ? shot.side : -1;
  let focus: P2 = { x: 0, z: 0 };
  if (shot) { const p = poses.get(shot.id); if (p) focus = { x: p.x, z: p.z }; }
  else if (team !== -1) focus = teamFocus(plan, poses, team) ?? focus;
  const burst = Math.max(0, 1 - Math.abs(t - T.home) / .6) + Math.max(0, 1 - Math.abs(t - T.away) / .6) * .6 + (shot ? Math.max(0, 1 - (t - shot.t0) / .5) * .35 : 0);
  return { level, team, focus, burst };
}

/** A caption for the presentation's close-ups: whose turn it is (the scene writes the name). */
export function introShotAt(plan: IntroPlan, t: number): IntroShot | null {
  return plan.shots.find(s => t >= s.t0 && t < s.t1) ?? null;
}
/** Which chapter of the entrance is on (for the caption over the picture). */
export function introChapter(plan: IntroPlan, t: number): string {
  const T = plan.t;
  if (t < T.away) return 'Выход судей';
  if (t < T.present) return 'Выход команд';
  if (t < T.hands) return 'Стартовые составы';
  if (t < T.settle) return 'Приветствие капитанов';
  return 'На вбрасывание';
}

type Cam = { pos: { x: number; y: number; z: number }; look: { x: number; y: number; z: number }; fov: number };
const mixCam = (a: Cam, b: Cam, k: number): Cam => ({
  pos: { x: lerp(a.pos.x, b.pos.x, k), y: lerp(a.pos.y, b.pos.y, k), z: lerp(a.pos.z, b.pos.z, k) },
  look: { x: lerp(a.look.x, b.look.x, k), y: lerp(a.look.y, b.look.y, k), z: lerp(a.look.z, b.look.z, k) },
  fov: lerp(a.fov, b.fov, k),
});

/**
 * The entrance's camera: a high sweep over the dark arena, a crane on the near side following each team round its
 * loop, a wide shot of the line-ups, cuts to the close-ups, a two-shot of the handshakes, back out wide for the settle.
 */
export function introCamera(plan: IntroPlan, t: number, poses = introPoses(plan, t)): Cam {
  const T = plan.t;
  const sweepAt = (tt: number): Cam => { const a = -1.9 + tt * .09; return { pos: { x: Math.cos(a) * 34, y: lerp(24, 15, smooth(tt / T.away)), z: Math.sin(a) * -24 + 4 }, look: { x: 0, y: 1, z: 0 }, fov: 50 }; };
  const crane = (f: P2): Cam => ({ pos: { x: clamp(f.x * .75, -18, 18), y: 8.5, z: 22 }, look: { x: f.x * .92, y: 1, z: f.z * .4 }, fov: 42 });
  const wide = (tt: number): Cam => ({ pos: { x: Math.sin(tt * .05) * 3, y: 10.5 - smooth((tt - T.lineup) / 6) * 2, z: 25 - smooth((tt - T.lineup) / 6) * 3 }, look: { x: 0, y: 1, z: 0 }, fov: 48 });
  if (t < T.away) return sweepAt(t);
  const shot = plan.shots.find(s => t >= s.t0 && t < s.t1);
  if (shot) {
    const p = poses.get(shot.id), r = plan.route.get(shot.id)!;
    const e = r.team.end, u = (t - shot.t0) / (shot.t1 - shot.t0);
    const px = p?.x ?? 0, pz = p?.z ?? 0, d = lerp(3.6, 2.9, smooth(u)), side = shot.kind === 'goalie' ? .2 : .6;
    // in front of him (toward centre ice), at eye height, the lens long
    return { pos: { x: px - e * d, y: shot.kind === 'goalie' ? 1.55 : 1.7, z: pz + side + u * .3 }, look: { x: px, y: shot.kind === 'goalie' ? 1.15 : 1.42, z: pz }, fov: 30 };
  }
  if (t >= T.hands && t < T.settle) {
    const u = t - T.hands;
    return { pos: { x: Math.sin(u * .18) * 2.6, y: 2.3, z: 7.4 - Math.min(1, u / 9) }, look: { x: 0, y: 1.25, z: 0 }, fov: 36 };
  }
  if (t >= T.settle) return wide(t);
  // the carousels: the crane drifts with the team going round, the line-ups wide
  const fa = teamFocus(plan, poses, 1) ?? { x: 0, z: 0 }, fh = teamFocus(plan, poses, 0) ?? fa;
  const f = { x: lerp(fa.x, fh.x, smooth((t - T.home) / 2.5)), z: lerp(fa.z, fh.z, smooth((t - T.home) / 2.5)) };
  const c = mixCam(sweepAt(T.away), crane(f), smooth((t - T.away) / 1.8));
  if (t < T.lineup) return c;
  return mixCam(c, wide(t), smooth((t - T.lineup) / 2.5));
}
