import { RINK } from '../game/rinkGeometry';
import { BENCH, gateDoor, OFFICIALS_DOOR_X, TUNNEL, benchSeat } from './arenaBenches';

/**
 * After the final siren (3D): what the teams do when the match is over, as a KHL broadcast shows it.
 *
 *  · every win — the winners pour over the boards (most of them hop it, a few go through the gate) and mob their
 *    goalie at his crease, sticks up, helmets tapped; the losers glide to a stop, heads down, tap their own goalie's
 *    pads and leave through their gate down the tunnel; then the winners line up and salute the crowd with raised
 *    sticks, the star of the match takes a solo bow, and they file off through the gate;
 *  · a playoff series won — the same, and before the salute the handshake line: both teams in single file at centre
 *    ice, gliding past each other, a hand for every man of the other team;
 *  · the final won (the Cup) — sticks and gloves fly, the pile on the goalie, the losers on their knees, the handshake
 *    line; then the red carpet and the table with the Cup at centre ice, the captain lifts it (confetti, lasers), skates
 *    a lap of honour with it over his head and hands it on; last the champions' photo round the Cup.
 *
 * Pure (no three.js), like matchIntro: seconds since the siren, world metres (origin centre ice, x along the rink,
 * z across it; the benches on −z, the cameras' side +z), headings 0 = facing +x, angle = atan2(−dz, dx).
 */
export type OutroKind = 'win' | 'series' | 'cup';
export type OutroSpec = {
  /** who won (0 home, 1 away) */
  winner: 0 | 1;
  kind: OutroKind;
  /** the final score (home, away) and how it ended */
  score: [number, number]; end?: 'ot' | 'so';
  /** the star of the match (a winner) */
  star?: string | null;
  /** the series after this game (home, away wins) */
  series?: [number, number];
  /** the trophy's name and the season (the Cup) */
  cup?: string; season?: string;
};
export type OutroSkater = {
  id: string; side: 0 | 1; goalie: boolean;
  /** where he is at the siren: on the ice (x, z, facing) or on a seat (bench / penalty box) */
  x: number; z: number; heading?: number; onIce: boolean;
  /** the starting goalie of his team (the one in net at the end) */
  starter?: boolean;
  captain?: boolean; rating?: number;
};
export type OutroPose = {
  x: number; y: number; z: number; heading: number; speed: number; visible: boolean;
  /** walking on the skates off the ice 0…1 */ walk: number;
  /** sitting on his seat */ sit: boolean;
  /** stick (or arms) raised 0…1 */ cheer: number;
  /** the free hand pumping / tapping helmets 0…1 */ pump: number;
  /** the right hand out shaking hands 0…1 */ shake: number;
  /** on one knee 0…1 */ kneel: number;
  /** head down, shoulders sunk 0…1 */ slump: number;
  /** holding the Cup: .5 at the chest, 1 high over the head */ trophy: number;
  /** no stick in his hands (thrown away / the Cup in them) */ noStick: boolean;
};
type P2 = { x: number; z: number };
type Path = { pts: P2[]; cum: number[]; len: number };
type Mods = Partial<Pick<OutroPose, 'cheer' | 'pump' | 'shake' | 'kneel' | 'slump' | 'trophy' | 'noStick' | 'sit'>>;
type Seg = {
  t0: number; t1: number; p: Path;
  /** glide: speeds up, cruises, slows (a skater); lin: steady (walking) */ ease: 'glide' | 'lin';
  /** the heading he turns to at the end (and keeps standing) */ face?: number;
  /** 'auto': walking where the path is off the ice; 'hop': over the boards (an arc up and down) */ step?: 'auto' | 'hop';
  /** gone at the end (into the tunnel) */ hide?: boolean;
  mods?: (t: number) => Mods;
};
type Track = { segs: Seg[]; start: P2; startHeading: number; startSit: boolean; startMods?: (t: number) => Mods };
export type OutroShot = { t0: number; t1: number; kind: 'mob' | 'loser' | 'handshake' | 'salute' | 'star' | 'exit' | 'setup' | 'lift' | 'lap' | 'photo'; id?: string };
export type OutroChapter = { t0: number; title: string; who?: string; sub?: string };
export type OutroPlan = {
  spec: OutroSpec; skaters: OutroSkater[]; tracks: Map<string, Track>;
  /** the net each side defended at the siren (world x of its goal line) */
  nets: [number, number];
  /** phase times (mob: when the mob at the goalie breaks up) */
  t: { mob: number; shake: number; salute: number; star: number; exit: number; setup: number; lift: number; lap: number; photo: number; length: number };
  shots: OutroShot[]; chapters: OutroChapter[];
  /** the Cup in hands: who holds it from when to when (the rest of the time it stands on the table) */
  holders: { id: string; t0: number; t1: number }[];
  /** the handshake line (both files are analytic: their positions at any time) */
  line: { t0: number; t1: number; v: number; gap: number; files: [string[], string[]]; z: [number, number]; x0: [number, number] } | null;
  /** thrown sticks and gloves (the Cup): from whom, when */
  throws: { id: string; t: number; seed: number }[];
};

const HW = RINK.width / 2, HL = RINK.length / 2;
/** Skating paces (m/s at cruise): rushing to the goalie, an easy glide, the dejected losers, walking off the ice. */
export const OUTRO_PACE = { rush: 6.4, glide: 4.6, slow: 2.6, walk: 2.1, line: 1.9, lap: 6.4 };
/** The Cup's table and the carpet to it (from the boards on the cameras' side). */
export const CUP_TABLE = { x: 0, z: 3.4, h: .82 };
export const CARPET = { x: 0, z0: HW, z1: CUP_TABLE.z + .6, width: 2.2 };

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (v: number) => { const t = clamp(v, 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const dist = (a: P2, b: P2) => Math.hypot(a.x - b.x, a.z - b.z);
const head = (dx: number, dz: number) => Math.atan2(-dz, dx);
const angLerp = (a: number, b: number, u: number) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * u; };
/** Facing +z (the cameras, the main stands), −z (the benches). */
const TO_CAM = -Math.PI / 2, TO_BENCH = Math.PI / 2;
const bell = (a: number, b: number, t: number) => (t > a && t < b ? Math.sin(Math.PI * (t - a) / (b - a)) : 0);
const ramp = (a: number, d: number, t: number) => smooth((t - a) / d);
/** A small stable pseudo-random number per id (0…1). */
const hashOf = (s: string, k = 0) => { let h = 2166136261 ^ k; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return ((h >>> 0) % 10007) / 10007; };

function path(pts: P2[]): Path {
  const clean = pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) > 1e-4);
  if (clean.length < 2) clean.push({ ...clean[0] });
  const cum = [0];
  for (let i = 1; i < clean.length; i++) cum.push(cum[i - 1] + dist(clean[i - 1], clean[i]));
  return { pts: clean, cum, len: cum[cum.length - 1] };
}
function along(p: Path, s: number): P2 & { dx: number; dz: number } {
  const { pts, cum } = p;
  if (p.len <= 0 || s <= 0) return { ...pts[0], dx: pts[1].x - pts[0].x, dz: pts[1].z - pts[0].z };
  if (s >= p.len) { const a = pts[pts.length - 2], b = pts[pts.length - 1]; return { ...b, dx: b.x - a.x, dz: b.z - a.z }; }
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
  const u = (s - cum[lo]) / (cum[hi] - cum[lo] || 1), a = pts[lo], b = pts[hi];
  return { x: lerp(a.x, b.x, u), z: lerp(a.z, b.z, u), dx: b.x - a.x, dz: b.z - a.z };
}
function bezier(a: P2, b: P2, c: P2, d: P2, n = 24): P2[] {
  const out: P2[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, v = 1 - u;
    out.push({ x: v * v * v * a.x + 3 * v * v * u * b.x + 3 * v * u * u * c.x + u * u * u * d.x, z: v * v * v * a.z + 3 * v * v * u * b.z + 3 * v * u * u * c.z + u * u * u * d.z });
  }
  return out;
}
/** A skater's curve from a (going his way `h`) to b, arriving along `arrive` (or straight in). */
function curve(a: P2, h: number | undefined, b: P2, arrive?: number): Path {
  const d = dist(a, b);
  if (d < .05) return path([a, b]);
  const k = Math.min(4, d * .4);
  const out = h === undefined ? { x: (b.x - a.x) / d, z: (b.z - a.z) / d } : { x: Math.cos(h), z: -Math.sin(h) };
  const inn = arrive === undefined ? { x: (b.x - a.x) / d, z: (b.z - a.z) / d } : { x: Math.cos(arrive), z: -Math.sin(arrive) };
  const c1 = { x: clamp(a.x + out.x * k, -HL + 1.2, HL - 1.2), z: clamp(a.z + out.z * k, -HW + 1, HW - 1) };
  return path(bezier(a, c1, { x: b.x - inn.x * k * .7, z: b.z - inn.z * k * .7 }, b));
}
/** Glide easing (accelerate over the first `A` of the time, cruise, slow over the last `A`): position share and speed factor. */
const A = .28;
function glide(u: number): { e: number; v: number } {
  const n = 1 / (1 - A);
  if (u <= 0) return { e: 0, v: 0 };
  if (u >= 1) return { e: 1, v: 0 };
  if (u < A) return { e: u * u / (2 * A) * n, v: u / A * n };
  if (u < 1 - A) return { e: (u - A / 2) * n, v: n };
  const w = 1 - u;
  return { e: 1 - w * w / (2 * A) * n, v: w / A * n };
}
/** How long a glide of `len` metres takes at cruise `pace` (a long way is skated harder: up to 8.2 m/s). */
const glideTime = (len: number, pace: number) => Math.max(.6, len / (Math.min(Math.max(pace, 8.2), pace * (1 + Math.max(0, len - 12) / 36)) * (1 - A)));

/** Off the ice he walks (the bench floor, the tunnel), on it he skates. */
const walkAt = (z: number) => clamp((Math.abs(z) - (HW - .3)) / .5, 0, 1);
/** The bench floor stands a little above the ice. */
const floorAt = (z: number) => (z < -HW - .05 ? BENCH.floor : 0);
/** The ice edge in front of a seat (bench: the −z boards, a penalty box: the +z ones). */
const edgeOf = (s: P2, inset = .7): P2 => ({ x: clamp(s.x, -HL + 3, HL - 3), z: Math.sign(s.z || -1) * (HW - inset) });
/** The walk off: through a team's gate, along the bench floor, out through the gap in its back wall and into the tunnel. */
function tunnelOut(side: 0 | 1, from: P2): Path {
  const door = gateDoor(side), gx = TUNNEL.gapX(side);
  return path([from, { x: door.x, z: -HW + .7 }, { x: door.x, z: -(HW + .72) }, { x: gx, z: -(HW + .72) }, { x: gx, z: -(HW + 2.2) }, { x: gx, z: TUNNEL.z }]);
}
/** Out of a seat through the gate onto the ice (walking along the bench floor first). */
function gateIn(side: 0 | 1, seat: P2, to: P2): Path {
  const door = gateDoor(side);
  const onIce = { x: door.x, z: -HW + .7 };
  return path([seat, { x: seat.x, z: -(HW + .72) }, { x: door.x, z: -(HW + .72) }, onIce, ...curve(onIce, TO_CAM, to).pts.slice(1)]);
}
/** Over the boards from a seat: up onto them (the arc is the pose's job), down onto the ice, away to `to`. */
function hopIn(seat: P2, to: P2): { hop: Path; skate: Path } {
  const e = edgeOf(seat);
  return { hop: path([seat, { x: seat.x, z: Math.sign(seat.z) * (HW + .25) }, e]), skate: curve(e, Math.sign(seat.z) < 0 ? TO_CAM : TO_BENCH, to) };
}

/**
 * Lays the whole scene out (once, at the siren). `nets`: the x of the goal line each side defended at the end.
 */
export function planOutro(spec: OutroSpec, skaters: OutroSkater[], nets: [number, number]): OutroPlan {
  const W = spec.winner, L = (1 - W) as 0 | 1, cup = spec.kind === 'cup', series = spec.kind !== 'win';
  const tracks = new Map<string, Track>();
  const team = (side: 0 | 1) => skaters.filter(s => s.side === side);
  const goalieOf = (side: 0 | 1) => team(side).find(s => s.goalie && s.starter) ?? team(side).find(s => s.goalie && s.onIce) ?? team(side).find(s => s.goalie) ?? null;
  const gW = goalieOf(W), gL = goalieOf(L);
  const sgn = (side: 0 | 1) => Math.sign(nets[side]) || (side ? -1 : 1);
  /** In front of a side's crease, facing out toward centre ice. */
  const crease = (side: 0 | 1): P2 => ({ x: nets[side] - sgn(side) * 1.7, z: 0 });
  const outFace = (side: 0 | 1) => (sgn(side) > 0 ? Math.PI : 0);
  const cW = crease(W), cL = crease(L);
  const add = (s: OutroSkater, sit = !s.onIce) => { const t: Track = { segs: [], start: { x: s.x, z: s.z }, startHeading: s.heading ?? (s.onIce ? outFace(s.side) : (s.z < 0 ? TO_CAM : TO_BENCH)), startSit: sit }; tracks.set(s.id, t); return t; };
  const tail = (t: Track): { at: P2; h: number; end: number } => {
    const last = t.segs[t.segs.length - 1];
    if (!last) return { at: t.start, h: t.startHeading, end: 0 };
    const q = along(last.p, last.p.len);
    return { at: { x: q.x, z: q.z }, h: last.face ?? (last.p.len > .05 ? head(q.dx, q.dz) : t.startHeading), end: last.t1 };
  };
  /** Glide from where the track ends to `to` starting at t0 (returns the arrival time). */
  const go = (t: Track, t0: number, to: P2, pace: number, face?: number, mods?: Seg['mods'], arrive?: number): number => {
    const { at, h } = tail(t);
    const p = curve(at, dist(at, to) > 2 ? h : undefined, to, arrive);
    const t1 = t0 + glideTime(p.len, pace);
    t.segs.push({ t0, t1, p, ease: 'glide', face, mods });
    return t1;
  };
  const stay = (t: Track, t0: number, t1: number, face?: number, mods?: Seg['mods']) => {
    const { at, h } = tail(t);
    t.segs.push({ t0, t1, p: path([at, at]), ease: 'lin', face: face ?? h, mods });
  };
  const leave = (t: Track, side: 0 | 1, t0: number, pace: number, mods?: Seg['mods']): number => {
    const { at } = tail(t);
    const p = tunnelOut(side, at);
    // skating to the gate, walking from it: one steady pace that slows off the ice (the time is the sum of both)
    const onIce = dist(at, { x: gateDoor(side).x, z: -HW + .7 }), off = p.len - onIce;
    const t1 = t0 + onIce / (pace * .85) + off / OUTRO_PACE.walk;
    t.segs.push({ t0, t1, p, ease: 'lin', step: 'auto', hide: true, mods });
    return t1;
  };

  // ---- the winners: to the goalie ----
  const wList = team(W), lList = team(L);
  const wSkaters = wList.filter(s => s !== gW);
  // the ring round the goalie: the men on the ice close in, the bench outside them
  const ringFace = outFace(W);
  const ring = (k: number): P2 => {
    const row = k < 6 ? 0 : k < 14 ? 1 : 2, inRow = row === 0 ? k : row === 1 ? k - 6 : k - 14, n = row === 0 ? 6 : row === 1 ? 8 : 10;
    const r = [1.25, 2.15, 3.05][row], a = ringFace + (n > 1 ? lerp(-1.75, 1.75, inRow / (n - 1)) : 0) + (row === 1 ? .12 : 0);
    return { x: cW.x + Math.cos(a) * r, z: clamp(cW.z - Math.sin(a) * r, -HW + 1, HW - 1) };
  };
  const onIceW = wSkaters.filter(s => s.onIce).sort((p, q) => dist(p, cW) - dist(q, cW));
  const benchW = wSkaters.filter(s => !s.onIce).sort((p, q) => dist(p, cW) - dist(q, cW));
  const cheerMods = (t0: number) => (t: number): Mods => ({ cheer: ramp(t0, .4, t) * (cup ? .9 : 1), pump: .5 * bell(t0 + .6, t0 + 3.4, t) + .35 * Math.max(0, Math.sin(t * 2.3 + t0)), noStick: cup && t > t0 + .1, kneel: 0 });
  let mobEnd = 5.6;
  if (gW) {
    const g = add(gW);
    const arrive = go(g, .1, cW, OUTRO_PACE.glide, ringFace, t => ({ cheer: ramp(.3, .5, t), pump: .4 * Math.max(0, Math.sin(t * 2.1)), noStick: cup && t > .35, kneel: cup ? .8 * bell(2.6, 6.4, t) : 0 }));
    mobEnd = Math.max(mobEnd, arrive + 3);
  }
  let k = 0;
  for (const s of onIceW) {
    const tr = add(s), spot = ring(k++), t0 = .15 + hashOf(s.id) * .35;
    const t1 = go(tr, t0, spot, OUTRO_PACE.rush, head(cW.x - spot.x, cW.z - spot.z), cheerMods(t0));
    mobEnd = Math.max(mobEnd, t1 + 2.2);
  }
  benchW.forEach((s, i) => {
    const tr = add(s), spot = ring(k++), t0 = .35 + i * .11 + hashOf(s.id, 1) * .25;
    const seat = { x: s.x, z: s.z };
    // most of them hop the boards; the goalie and every fourth man walk through the gate
    const viaGate = s.goalie || i % 4 === 3 || seat.z > 0 === false && Math.abs(seat.x - gateDoor(W).x) < 1.2;
    let t1: number;
    if (viaGate && seat.z < 0) {
      const p = gateIn(W, seat, spot);
      t1 = t0 + .25 + p.len / (OUTRO_PACE.rush * .7);
      tr.segs.push({ t0: t0 + .25, t1, p, ease: 'lin', step: 'auto', face: head(cW.x - spot.x, cW.z - spot.z), mods: cheerMods(t0) });
    } else {
      const h = hopIn(seat, spot), hop1 = t0 + .25 + .95;
      tr.segs.push({ t0: t0 + .25, t1: hop1, p: h.hop, ease: 'lin', step: 'hop', mods: t => ({ cheer: .2 * ramp(t0, .3, t), noStick: cup }) });
      t1 = hop1 + glideTime(h.skate.len, OUTRO_PACE.rush);
      tr.segs.push({ t0: hop1, t1, p: h.skate, ease: 'glide', face: head(cW.x - spot.x, cW.z - spot.z), mods: cheerMods(hop1) });
    }
    mobEnd = Math.max(mobEnd, t1 + 1.6);
  });
  mobEnd = clamp(mobEnd, 6, cup ? 10.5 : 9);

  // ---- the losers: a stop, heads down, to their goalie, then off (or to the handshake line) ----
  const lSkaters = lList.filter(s => s !== gL);
  const lRing = (i: number): P2 => { const a = outFace(L) + lerp(-1.3, 1.3, (i % 5) / 4), r = 1.7 + Math.floor(i / 5) * .9; return { x: cL.x + Math.cos(a) * r, z: clamp(cL.z - Math.sin(a) * r, -HW + 1, HW - 1) }; };
  const sad = (t: number): Mods => ({ slump: ramp(0, .8, t), cheer: 0 });
  if (gL) {
    const g = add(gL);
    stay(g, 0, 1, outFace(L), sad);
    // he sinks to his knees in the crease for a moment (on the ice after the Cup is lost)
    stay(g, 1, cup ? 5.5 : 3.2, outFace(L), t => ({ slump: 1, kneel: (cup ? .95 : .55) * bell(1, cup ? 5.5 : 3.2, t) }));
  }
  let li = 0;
  for (const s of lSkaters.filter(x => x.onIce)) {
    const tr = add(s);
    // the glide out of the play to a stop, then over to the goalie for a tap on the pads
    const t0 = .1, here = tail(tr).at, h = tr.startHeading, slide = { x: clamp(here.x + Math.cos(h) * 2.2, -HL + 2, HL - 2), z: clamp(here.z - Math.sin(h) * 2.2, -HW + 1.2, HW - 1.2) };
    const t1 = go(tr, t0, slide, OUTRO_PACE.slow, undefined, sad);
    // (the Cup lost: some of them down on one knee where they stopped)
    const knee = cup && li % 2 === 0;
    stay(tr, t1, t1 + (knee ? 3.4 : .6), undefined, t => ({ slump: 1, kneel: knee ? bell(t1, t1 + 3.4, t) * .95 : 0 }));
    go(tr, t1 + (knee ? 3.4 : .6), lRing(li++), OUTRO_PACE.glide * .75, undefined, t => ({ slump: 1, pump: .25 * bell(0, 1, (t % 3) / 3) }));
  }
  // the bench: they stay seated, heads down (they come out later for the handshakes / leave down the tunnel)
  for (const s of lSkaters.filter(x => !x.onIce)) { const tr = add(s); tr.startMods = () => ({ slump: 1, sit: true }); }

  // ---- the handshake line (a series / the Cup) ----
  let line: OutroPlan['line'] = null, shakeEnd = mobEnd;
  if (series) {
    const gap = 1.0, v = OUTRO_PACE.line;
    let gather = mobEnd + 4.6;
    // the winners' file at +z facing −x, the losers' at −z facing +x (right hand to right hand); goalies first
    const order = (side: 0 | 1) => [...team(side).filter(s => s.goalie), ...team(side).filter(s => !s.goalie).sort((p, q) => +!!q.captain - +!!p.captain)].map(s => s.id);
    const files: [string[], string[]] = [order(0), order(1)];
    const zOf = (side: 0 | 1) => (side === W ? .5 : -.5);
    const x0: [number, number] = [0, 0];
    ([0, 1] as const).forEach(side => { x0[side] = side === W ? 2 : -2; });
    const dirOf = (side: 0 | 1) => (side === W ? -1 : 1);
    const nMax = files[W].length + files[L].length;
    const dur = (4 + (nMax - 2) * gap) / (2 * v) + 1.2;
    const fileSegs: { tr: Track; slot: P2; side: 0 | 1; face: number }[] = [];
    ([0, 1] as const).forEach(side => {
      files[side].forEach((id, k2) => {
        const s = skaters.find(q => q.id === id)!, tr = tracks.get(id) ?? add(s);
        const slot = { x: x0[side] - dirOf(side) * k2 * gap, z: zOf(side) };
        const face = dirOf(side) > 0 ? 0 : Math.PI;
        const mods = side === W ? (): Mods => ({ cheer: .15, noStick: cup }) : (): Mods => ({ slump: .55 });
        const from = tail(tr);
        const start = Math.max(mobEnd + (side === W ? 0 : .3) + k2 * .04, from.end);
        if (!s.onIce && side === L && tr.segs.length === 0) {
          // off the bench, through the gate
          const p = gateIn(L, tr.start, slot);
          const t1 = mobEnd - 1.5 + p.len / (OUTRO_PACE.glide * .75);
          tr.segs.push({ t0: mobEnd - 1.5, t1, p, ease: 'lin', step: 'auto', face, mods });
          gather = Math.max(gather, t1 + .2);
        } else gather = Math.max(gather, go(tr, start, slot, OUTRO_PACE.glide, face, mods) + .2);
        fileSegs.push({ tr, slot, side, face });
      });
    });
    // (nobody is late: the line waits till the last man is in it)
    gather = Math.min(gather, mobEnd + 9);
    line = { t0: gather, t1: gather + dur, v, gap, files, z: [zOf(0), zOf(1)], x0 };
    // the files themselves (the hands in `outroPoses`): one segment each that runs the length of the line
    for (const { tr, slot, side, face } of fileSegs) {
      const end = { x: slot.x + dirOf(side) * v * dur, z: slot.z };
      tr.segs.push({ t0: gather, t1: gather + dur, p: path([slot, end]), ease: 'lin', face, mods: side === W ? () => ({ cheer: 0, noStick: cup }) : () => ({ slump: .4 }) });
    }
    shakeEnd = gather + dur + .4;
  }

  // ---- the losers leave ----
  let lGone = 0;
  {
    const t0 = series ? shakeEnd : mobEnd - 2.6;
    lList.forEach((s, i) => {
      const tr = tracks.get(s.id) ?? add(s);
      const start = Math.max(t0 + i * .35, tail(tr).end);
      if (!series && !s.onIce) {
        // from the bench straight down the tunnel (the gap in the back wall)
        const gx = TUNNEL.gapX(L), p = path([tr.start, { x: tr.start.x, z: -(HW + .72) }, { x: gx, z: -(HW + .72) }, { x: gx, z: -(HW + 2.2) }, { x: gx, z: TUNNEL.z }]);
        tr.segs.push({ t0: start, t1: start + .6 + p.len / OUTRO_PACE.walk, p, ease: 'lin', step: 'auto', hide: true, mods: () => ({ slump: 1 }) });
      } else lGone = Math.max(lGone, leave(tr, L, start, series ? OUTRO_PACE.glide * .8 : OUTRO_PACE.slow, () => ({ slump: .9 })));
    });
  }

  // ---- the salute (every win), the star, off the ice ----
  const T: OutroPlan['t'] = { mob: mobEnd, shake: series ? mobEnd : NaN, salute: NaN, star: NaN, exit: NaN, setup: NaN, lift: NaN, lap: NaN, photo: NaN, length: 0 };
  const holders: OutroPlan['holders'] = [];
  const shots: OutroShot[] = [], chapters: OutroChapter[] = [];
  const winners = wList.slice().sort((p, q) => +!!q.goalie - +!!p.goalie || (q.rating ?? 0) - (p.rating ?? 0));
  const star = spec.star && wList.some(s => s.id === spec.star) ? spec.star : null;
  if (!cup) {
    const t0 = shakeEnd + (series ? .3 : 0);
    const sp = 1.2;
    // a line across centre ice facing the main stands, goalies in the middle
    const mid = [...winners].sort((p, q) => +!!q.goalie - +!!p.goalie);
    const slots = new Map<string, P2>();
    mid.forEach((s, i) => { const o = i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2); slots.set(s.id, { x: o * sp, z: 1.6 }); });
    let ready = t0 + 2;
    for (const s of winners) { const tr = tracks.get(s.id) ?? add(s); ready = Math.max(ready, go(tr, Math.max(t0 + hashOf(s.id, 2) * .5, tail(tr).end), slots.get(s.id)!, OUTRO_PACE.glide, TO_CAM, () => ({ cheer: .25, noStick: false }))); }
    const salute = ready + .2;
    for (const s of winners) {
      const tr = tracks.get(s.id)!;
      stay(tr, salute, salute + 3.6, TO_CAM, t => ({ cheer: ramp(salute, .5, t) * (1 - ramp(salute + 3, .5, t)), pump: .3 * bell(salute + .4, salute + 3.4, t) }));
    }
    T.salute = salute;
    let exitT = salute + 3.8;
    if (star) {
      const tr = tracks.get(star)!, base = slots.get(star)!;
      const st = salute + 3.8;
      // out of the line a few strides, a stop, the stick raised to all four sides of the arena
      const t1 = go(tr, st, { x: base.x * .3, z: 5.4 }, OUTRO_PACE.glide * .8, TO_CAM, () => ({ cheer: .2 }));
      stay(tr, t1, t1 + 3.2, TO_CAM, t => ({ cheer: ramp(t1, .4, t), pump: .5 * Math.max(0, Math.sin((t - t1) * 3)) }));
      T.star = st; exitT = t1 + 3.4;
      go(tr, exitT, base, OUTRO_PACE.glide * .8, TO_CAM);
      exitT += 1.2;
    }
    T.exit = exitT;
    // off in a file through the gate (the ones nearest it first)
    const byGate = [...winners].sort((p, q) => Math.abs((slots.get(p.id)!.x) - gateDoor(W).x) - Math.abs((slots.get(q.id)!.x) - gateDoor(W).x));
    let gone = exitT;
    byGate.forEach((s, i) => { const tr = tracks.get(s.id)!; gone = Math.max(gone, leave(tr, W, Math.max(exitT + i * .32, tail(tr).end), OUTRO_PACE.glide, () => ({ cheer: 0 }))); });
    T.length = Math.max(Math.min(gone, exitT + 6.5), Math.min(lGone, exitT + 9));
    shots.push({ t0: 0, t1: 3.4, kind: 'mob' }, { t0: 3.4, t1: 6, kind: 'loser', id: gL?.id }, { t0: 6, t1: series ? T.shake : salute - 1.2, kind: 'mob' });
    if (series) shots.push({ t0: T.shake, t1: shakeEnd, kind: 'handshake' });
    shots.push({ t0: shots[shots.length - 1].t1, t1: star ? T.star : exitT, kind: 'salute' });
    if (star) shots.push({ t0: T.star, t1: exitT, kind: 'star', id: star });
    shots.push({ t0: exitT, t1: T.length + 1, kind: 'exit' });
  } else {
    // ---- the Cup: the carpet and the table, the lift, the lap, the photo ----
    const setup = shakeEnd + .2;
    T.setup = setup;
    // the champions gather in an arc on the far side of the table, facing it (and the cameras)
    const capt = winners.find(s => s.captain && !s.goalie) ?? winners.filter(s => !s.goalie).sort((p, q) => (q.rating ?? 0) - (p.rating ?? 0))[0] ?? winners[0];
    const arc = winners.filter(s => s !== capt);
    const arcSpot = (i: number, n: number): P2 => { const row = i < 12 ? 0 : 1, m = row ? n - 12 : Math.min(12, n), j = row ? i - 12 : i; const a = lerp(-1.05, 1.05, m > 1 ? j / (m - 1) : .5); const r = 4.4 + row * 1.25; return { x: CUP_TABLE.x + Math.sin(a) * r * 1.35, z: CUP_TABLE.z - Math.cos(a) * r }; };
    let gathered = setup + 3;
    arc.forEach((s, i) => { const tr = tracks.get(s.id) ?? add(s); gathered = Math.max(gathered, go(tr, Math.max(setup + i * .08, tail(tr).end), arcSpot(i, arc.length), OUTRO_PACE.glide, TO_CAM, () => ({ cheer: .2, noStick: true }))); });
    const ctr = tracks.get(capt.id) ?? add(capt);
    const standBy = { x: CUP_TABLE.x, z: CUP_TABLE.z - 2.6 };
    gathered = Math.max(gathered, go(ctr, Math.max(setup, tail(ctr).end), standBy, OUTRO_PACE.glide * .8, TO_CAM, () => ({ cheer: .2, noStick: true })));
    const lift = Math.max(gathered + .8, setup + 7.5);
    T.lift = lift;
    // the captain to the table, the Cup up to the chest, then high over his head
    const atTable = { x: CUP_TABLE.x, z: CUP_TABLE.z - .75 };
    const pick = go(ctr, lift - 1.6, atTable, 2.4, TO_CAM, () => ({ noStick: true }));
    const up = pick + .3;
    holders.push({ id: capt.id, t0: up, t1: NaN });
    stay(ctr, pick, up + 4.4, TO_CAM, t => ({ noStick: true, trophy: t < up ? 0 : lerp(.5, 1, ramp(up + .6, .7, t)) - .08 * Math.max(0, Math.sin((t - up) * 4.2)) * ramp(up + 1.4, .3, t) }));
    // the team: arms up the moment it goes up
    for (const s of arc) { const tr = tracks.get(s.id)!; stay(tr, lift - .5, up + 4.4, TO_CAM, t => ({ noStick: true, cheer: ramp(up + .3, .35, t), pump: .5 * Math.max(0, Math.sin((t - up) * 3 + hashOf(s.id) * 6)) * ramp(up + .4, .3, t) })); }
    // the lap of honour: round the rink with it over his head (the team waits at the table)
    const lapStart = up + 4.4;
    T.lap = lapStart;
    const ex = 13, ez = 7.6, lapPts: P2[] = [atTable];
    const a0 = Math.atan2(atTable.z / ez, atTable.x / ex);
    for (let i = 1; i <= 72; i++) { const a = a0 - (i / 72) * Math.PI * 2; lapPts.push({ x: Math.cos(a) * ex, z: Math.sin(a) * ez }); }
    lapPts.push({ x: CUP_TABLE.x + 1.2, z: CUP_TABLE.z - 1.4 });
    const lapPath = path(lapPts);
    const lapEnd = lapStart + glideTime(lapPath.len, OUTRO_PACE.lap);
    const holding = (t: number): Mods => ({ noStick: true, trophy: .9 + .1 * Math.sin(t * 2.4) });
    ctr.segs.push({ t0: lapStart, t1: lapEnd, p: lapPath, ease: 'glide', face: Math.PI, mods: holding });
    // the hand-off: to the goalie (or the best man) — a short skate in front of the team, then the photo
    const next = winners.find(s => s.goalie && s.onIce) ?? arc.slice().sort((p, q) => (q.rating ?? 0) - (p.rating ?? 0))[0];
    holders[0].t1 = lapEnd + .5;
    let handEnd = lapEnd + .5;
    if (next && next !== capt) {
      const ntr = tracks.get(next.id)!, meet = { x: CUP_TABLE.x + 1.9, z: CUP_TABLE.z - 1.5 };
      go(ntr, lapEnd - 1.6, meet, 2.6, 0, () => ({ noStick: true, cheer: .4 }));
      const h0 = lapEnd + .5, run: P2[] = [meet];
      for (let i = 1; i <= 30; i++) { const a = (i / 30) * Math.PI; run.push({ x: meet.x + Math.sin(a) * 7.5, z: meet.z + 2.2 + (1 - Math.cos(a)) * -1.6 - 2.2 + Math.sin(a) * 3.2 }); }
      const p = path(run), h1 = h0 + .4 + glideTime(p.len, OUTRO_PACE.lap * .75);
      stay(ntr, h0, h0 + .4, 0, () => ({ noStick: true, trophy: .5 }));
      ntr.segs.push({ t0: h0 + .4, t1: h1, p, ease: 'glide', face: TO_CAM, mods: holding });
      holders.push({ id: next.id, t0: h0, t1: h1 + .4 });
      stay(ctr, lapEnd, h1, TO_CAM, () => ({ noStick: true, cheer: .9, pump: .5 }));
      handEnd = h1 + .4;
    }
    // the photo: two rows round the Cup at centre ice, the front one on a knee, the captain in the middle holding it
    const photo = handEnd + .4;
    T.photo = photo;
    const all = [capt, ...winners.filter(s => s !== capt)];
    const front = Math.min(11, Math.ceil(all.length / 2));
    // the captain takes it back for the photo
    holders.push({ id: capt.id, t0: handEnd, t1: Infinity });
    let posed = photo + 2;
    all.forEach((s, i) => {
      const tr = tracks.get(s.id) ?? add(s);
      const row = i < front ? 0 : 1, j = row ? i - front : i, n = row ? all.length - front : front;
      const o = j === 0 ? 0 : (j % 2 ? 1 : -1) * Math.ceil(j / 2);
      const spot = { x: o * (row ? .78 : .86) + (row ? (n % 2 ? 0 : .39) : 0), z: row ? .4 : 1.55 };
      posed = Math.max(posed, go(tr, Math.max(photo + j * .05, tail(tr).end), spot, OUTRO_PACE.glide * .7, TO_CAM, () => (s === capt ? { noStick: true, trophy: .5 } : { noStick: true, cheer: .1 })));
    });
    const snap = posed + .3;
    for (const [i, s] of all.entries()) {
      const tr = tracks.get(s.id)!;
      const kneel = i < front ? 1 : 0;
      stay(tr, snap - .6, snap + 5.4, TO_CAM, t => ({ noStick: true, kneel: kneel * ramp(snap - .6, .5, t), trophy: s === capt ? .5 : 0, cheer: i >= front ? .6 * ramp(snap + 2.2, .4, t) : 0, pump: i < front && s !== capt ? .4 * bell(snap + 2.2, snap + 5.2, t) : 0 }));
    }
    T.length = snap + 5.6;
    shots.push({ t0: 0, t1: 3.6, kind: 'mob' }, { t0: 3.6, t1: 6.4, kind: 'loser', id: gL?.id }, { t0: 6.4, t1: mobEnd, kind: 'mob' });
    if (line) shots.push({ t0: mobEnd, t1: shakeEnd, kind: 'handshake' });
    shots.push({ t0: setup, t1: lift - 1.8, kind: 'setup' }, { t0: lift - 1.8, t1: lapStart, kind: 'lift', id: capt.id }, { t0: lapStart, t1: handEnd, kind: 'lap', id: capt.id });
    if (next && next !== capt) shots[shots.length - 1].t1 = lapEnd + .5, shots.push({ t0: lapEnd + .5, t1: handEnd, kind: 'lap', id: next.id });
    shots.push({ t0: handEnd, t1: T.length + 1, kind: 'photo' });
  }

  // ---- the captions ----
  const how = spec.end === 'ot' ? ' в овертайме' : spec.end === 'so' ? ' по буллитам' : '';
  const sc = `${spec.score[0]}:${spec.score[1]}`;
  if (cup) chapters.push({ t0: 0, title: 'Чемпион!', sub: `${spec.cup ?? 'Кубок'}${spec.season ? ` · ${spec.season}` : ''} · ${sc}${how}` });
  else if (series) chapters.push({ t0: 0, title: 'Серия выиграна', sub: `${spec.series ? `${Math.max(...spec.series)}–${Math.min(...spec.series)} в серии · ` : ''}${sc}${how}` });
  else chapters.push({ t0: 0, title: 'Финальная сирена', sub: `Победа · ${sc}${how}` });
  if (series) chapters.push({ t0: T.shake, title: 'Рукопожатия' });
  if (!cup) {
    chapters.push({ t0: T.salute - 1.2, title: 'Салют болельщикам' });
    if (star) chapters.push({ t0: T.star, title: 'Звезда матча', who: star });
    chapters.push({ t0: T.exit, title: 'Уход с площадки' });
  } else {
    const capt = holders[0]?.id, next = holders[1] && holders[1].id !== capt ? holders[1].id : undefined;
    chapters.push({ t0: T.setup, title: `Вручение: ${spec.cup ?? 'Кубок'}` });
    chapters.push({ t0: T.lift - .2, title: 'Капитан поднимает Кубок', who: capt });
    chapters.push({ t0: T.lap, title: 'Круг почёта', who: capt });
    if (next) chapters.push({ t0: holders[1].t0, title: 'Кубок переходит из рук в руки', who: next });
    chapters.push({ t0: T.photo, title: 'Фото чемпионов', sub: spec.season });
  }
  chapters.sort((a, b) => a.t0 - b.t0);
  const throws = cup ? wList.filter(s => s.onIce || s.goalie).map(s => ({ id: s.id, t: .25 + hashOf(s.id, 3) * .5, seed: hashOf(s.id, 4) })) : [];
  return { spec, skaters, tracks, nets, t: T, shots, chapters, holders, line, throws };
}

/** Where everybody is and what he does `t` seconds after the siren. */
export function outroPoses(plan: OutroPlan, t: number): Map<string, OutroPose> {
  const out = new Map<string, OutroPose>();
  plan.tracks.forEach((tr, id) => out.set(id, poseOf(tr, t)));
  // the handshake line: a hand out to every man of the other file passing him
  const L = plan.line;
  if (L && t > L.t0 - .2 && t < L.t1 + .2) {
    const xs: [{ id: string; x: number }[], { id: string; x: number }[]] = [[], []];
    ([0, 1] as const).forEach(side => L.files[side].forEach(id => { const p = out.get(id); if (p?.visible && Math.abs(p.z - L.z[side]) < .3) xs[side].push({ id, x: p.x }); }));
    for (const side of [0, 1] as const) for (const me of xs[side]) {
      let s = 0;
      for (const o of xs[1 - side]) s = Math.max(s, 1 - smooth(Math.abs(o.x - me.x) / 1.1));
      const p = out.get(me.id)!;
      p.shake = Math.max(p.shake, s);
    }
  }
  return out;
}

function poseOf(tr: Track, t: number): OutroPose {
  const base = (x: number, z: number, heading: number, mods: Mods = {}): OutroPose => ({
    x, y: 0, z, heading, speed: 0, visible: true, walk: 0, sit: false, cheer: 0, pump: 0, shake: 0, kneel: 0, slump: 0, trophy: 0, noStick: false, ...mods,
  });
  const segs = tr.segs;
  if (!segs.length || t < segs[0].t0) {
    const m = tr.startMods?.(t) ?? {};
    const p = base(tr.start.x, tr.start.z, tr.startHeading, m);
    p.sit = tr.startSit; p.y = tr.startSit ? 0 : 0;
    return p;
  }
  let i = segs.length - 1;
  while (i > 0 && segs[i].t0 > t) i--;
  const sg = segs[i];
  const m = sg.mods?.(t) ?? {};
  if (t >= sg.t1) {
    const q = along(sg.p, sg.p.len);
    const h = sg.face ?? (sg.p.len > .05 ? head(q.dx, q.dz) : tr.startHeading);
    const p = base(q.x, q.z, h, m);
    if (sg.hide) p.visible = false;
    p.y = floorAt(q.z);
    p.walk = p.y > 0 ? 1 : 0;
    return p;
  }
  const d = sg.t1 - sg.t0, u = d > 0 ? (t - sg.t0) / d : 1;
  let e = u, v = 1;
  if (sg.ease === 'glide') { const g = glide(u); e = g.e; v = g.v; }
  const q = along(sg.p, e * sg.p.len), speed = sg.p.len / Math.max(1e-3, d) * v;
  const travel = sg.p.len > .05 ? head(q.dx, q.dz) : (sg.face ?? tr.startHeading);
  // turning to the facing over the last of the move (a skater stops side-on, then squares up)
  const h = sg.face !== undefined && sg.p.len > .05 ? angLerp(travel, sg.face, smooth((u - .78) / .22)) : travel;
  const p = base(q.x, q.z, h, m);
  p.speed = speed;
  if (sg.step === 'hop') {
    // up off the bench onto the boards (both skates swung over), down onto the ice
    p.y = Math.sin(Math.PI * clamp(u * 1.08, 0, 1)) * .95 + floorAt(q.z) * (1 - u);
    p.walk = .35 * (1 - u);
  } else {
    p.y = floorAt(q.z);
    p.walk = sg.step === 'auto' ? walkAt(q.z) : 0;
  }
  return p;
}

/** The Cup: in whose hands (and how high) at `t`, else standing on the table (once the table is out). */
export function outroCup(plan: OutroPlan, t: number): { holder: string | null; onTable: boolean; table: number; carpet: number } {
  if (plan.spec.kind !== 'cup') return { holder: null, onTable: false, table: 0, carpet: 0 };
  const h = plan.holders.find(x => t >= x.t0 && t < x.t1);
  const T = plan.t;
  const carpet = smooth((t - T.setup) / 2.6) * (1 - smooth((t - T.photo) / 1.2));
  const table = smooth((t - T.setup - 1.4) / .8) * (1 - smooth((t - T.photo) / .8));
  return { holder: h?.id ?? null, onTable: !h && t > T.setup + 1.6 && t < T.photo, table, carpet };
}

/** The arena: the lights and lasers (level 0 normal … 1 dark show), a burst of fireworks, confetti falling (0…1). */
export function outroShow(plan: OutroPlan, t: number): { level: number; burst: number; confetti: number; flashes: number } {
  const T = plan.t, cup = plan.spec.kind === 'cup';
  const siren = Math.max(0, 1 - t / 2.2);
  if (!cup) return { level: .25 * siren, burst: siren * .8, confetti: 0, flashes: 1 + siren };
  const lift = Number.isNaN(T.lift) ? 0 : Math.max(0, 1 - Math.abs(t - T.lift - .4) / 1.4);
  const dim = smooth((t - T.setup) / 2) * (1 - smooth((t - T.photo - 2) / 3));
  return { level: Math.max(.35 * siren, .5 * dim), burst: Math.max(siren, lift), confetti: Math.max(smooth(t / .6) * (1 - smooth((t - 9) / 3)), smooth((t - T.lift - .3) / .5)), flashes: 1 + 2 * smooth((t - T.photo - 1) / 1) };
}

/** The officials: off through their door at the siren; for the Cup they come back to stand by the table. */
export function outroOfficials(plan: OutroPlan, t: number, from: P2[]): { x: number; z: number; heading: number; speed: number; visible: boolean; walk: number }[] {
  const door = { x: OFFICIALS_DOOR_X, z: HW - .6 }, out = { x: OFFICIALS_DOOR_X, z: TUNNEL.officialsZ };
  const T = plan.t, cup = plan.spec.kind === 'cup';
  return from.map((f, i) => {
    const t0 = .6 + i * .5;
    const p1 = curve(f, undefined, door), d1 = glideTime(p1.len, 4.2);
    const p2 = path([door, { x: door.x, z: HW + .4 }, out]), d2 = p2.len / OUTRO_PACE.walk;
    if (cup && t > T.setup) {
      // back out of the corridor to the table: wide of it on either side, level with the captain (out of the cameras' way)
      const spot = { x: CUP_TABLE.x + (i % 2 ? 1 : -1) * (2.6 + (i >> 1) * 1.1), z: CUP_TABLE.z - .9 - (i >> 1) * .4 };
      const back = path([out, { x: door.x, z: HW + .4 }, door, spot]), s0 = T.setup + i * .4, dur = back.len / 3;
      if (t > T.photo) return { ...spot, heading: TO_BENCH, speed: 0, visible: false, walk: 0 };
      const u = clamp((t - s0) / dur, 0, 1), q = along(back, u * back.len);
      return { x: q.x, z: q.z, heading: u >= 1 ? TO_BENCH : head(q.dx, q.dz), speed: u > 0 && u < 1 ? 3 : 0, visible: t > s0, walk: walkAt(q.z) };
    }
    if (t < t0) return { x: f.x, z: f.z, heading: TO_CAM, speed: 0, visible: true, walk: 0 };
    if (t < t0 + d1) { const g = glide((t - t0) / d1), q = along(p1, g.e * p1.len); return { x: q.x, z: q.z, heading: head(q.dx, q.dz), speed: p1.len / d1 * g.v, visible: true, walk: 0 }; }
    const u = (t - t0 - d1) / d2;
    if (u >= 1) return { ...out, heading: TO_CAM, speed: 0, visible: false, walk: 1 };
    const q = along(p2, u * p2.len);
    return { x: q.x, z: q.z, heading: head(q.dx, q.dz), speed: OUTRO_PACE.walk, visible: true, walk: walkAt(q.z) };
  });
}

/** The caption at `t`: the chapter, whose moment it is. */
export function outroChapter(plan: OutroPlan, t: number): OutroChapter {
  let c = plan.chapters[0];
  for (const x of plan.chapters) if (x.t0 <= t) c = x;
  return c;
}
export const outroShotAt = (plan: OutroPlan, t: number): OutroShot => plan.shots.find(s => t >= s.t0 && t < s.t1) ?? plan.shots[plan.shots.length - 1];

type V3 = { x: number; y: number; z: number };
export type OutroCam = { pos: V3; look: V3; fov: number };
const camMix = (a: OutroCam, b: OutroCam, k: number): OutroCam => {
  const l = (x: number, y: number) => x + (y - x) * k;
  return { pos: { x: l(a.pos.x, b.pos.x), y: l(a.pos.y, b.pos.y), z: l(a.pos.z, b.pos.z) }, look: { x: l(a.look.x, b.look.x), y: l(a.look.y, b.look.y), z: l(a.look.z, b.look.z) }, fov: l(a.fov, b.fov) };
};
/** The middle of a group of visible skaters. */
function centroid(poses: Map<string, OutroPose>, ids: string[]): P2 | null {
  let x = 0, z = 0, n = 0;
  for (const id of ids) { const p = poses.get(id); if (p?.visible) { x += p.x; z += p.z; n++; } }
  return n ? { x: x / n, z: z / n } : null;
}

/** The broadcast's camera for the scene: a cut per shot, eased over half a second between them. */
export function outroCamera(plan: OutroPlan, t: number, poses: Map<string, OutroPose>): OutroCam {
  const at = (tt: number) => shotCam(plan, plan.shots.find(s => tt >= s.t0 && tt < s.t1) ?? plan.shots[plan.shots.length - 1], tt, poses);
  const cur = plan.shots.find(s => t >= s.t0 && t < s.t1);
  if (cur && t - cur.t0 < .6 && cur.t0 > 0) {
    const prev = plan.shots.find(s => cur.t0 - .01 >= s.t0 && cur.t0 - .01 < s.t1);
    if (prev) return camMix(shotCam(plan, prev, t, poses), shotCam(plan, cur, t, poses), smooth((t - cur.t0) / .6));
  }
  return at(t);
}

function shotCam(plan: OutroPlan, shot: OutroShot, t: number, poses: Map<string, OutroPose>): OutroCam {
  const W = plan.spec.winner, sg = Math.sign(plan.nets[W]) || 1;
  const winners = plan.skaters.filter(s => s.side === W).map(s => s.id);
  const u = (t - shot.t0) / Math.max(.1, shot.t1 - shot.t0);
  const who = shot.id ? poses.get(shot.id) : undefined;
  switch (shot.kind) {
    case 'mob': {
      // on the pile at the crease (the bench pours over the boards toward it)
      const crease = { x: plan.nets[W] - sg * 1.7, z: 0 }, cc = centroid(poses, winners) ?? crease;
      const c = { x: lerp(crease.x, cc.x, .25), z: lerp(crease.z, cc.z, .25) };
      // from the slot in front of the pile, a little to the cameras' side, easing in
      const d = lerp(9.5, 7, smooth(u));
      return { pos: { x: clamp(c.x - sg * d * .8, -27, 27), y: lerp(4.2, 2.8, smooth(u)), z: clamp(c.z + d * .6, -12, 13.5) }, look: { x: c.x, y: 1, z: c.z }, fov: 40 };
    }
    case 'loser': {
      const p = who ?? { x: plan.nets[1 - W] * .9, z: 0 };
      const s2 = Math.sign(plan.nets[1 - W]) || 1;
      return { pos: { x: clamp(p.x - s2 * 4.2, -28, 28), y: 1.6, z: clamp(p.z + 2.2, -13, 13.5) }, look: { x: p.x, y: .9, z: p.z }, fov: 36 };
    }
    case 'handshake': {
      const L = plan.line;
      const mid = { x: 0, z: 0 };
      const drift = L ? Math.sin((t - L.t0) * .12) * 2.5 : 0;
      // broadside from the cameras' side, on the middle of the line where the hands meet
      return { pos: { x: mid.x + 2.5 + drift, y: 2.1, z: mid.z + 7.2 }, look: { x: mid.x + drift * .3, y: 1.05, z: mid.z }, fov: 46 };
    }
    case 'salute': {
      const c = centroid(poses, winners) ?? { x: 0, z: 1.6 };
      return { pos: { x: c.x + Math.sin(t * .15) * 3, y: 2.4, z: Math.min(13.5, c.z + 11.5) }, look: { x: c.x, y: 1.1, z: c.z }, fov: 44 };
    }
    case 'star': {
      const p = who ?? { x: 0, z: 5 };
      const a = -Math.PI / 2 + Math.sin(t * .4) * .5;
      return { pos: { x: p.x + Math.cos(a) * 4.2, y: 1.8, z: clamp(p.z - Math.sin(a) * 4.2, -13, 13.8) }, look: { x: p.x, y: 1.25, z: p.z }, fov: 34 };
    }
    case 'exit': {
      const g = gateDoor(W);
      return { pos: { x: g.x + (g.x > 0 ? -5 : 5), y: 2.3, z: -HW + 6.8 }, look: { x: g.x, y: 1, z: -HW + .5 }, fov: 42 };
    }
    case 'setup': {
      const k = smooth(u);
      return { pos: { x: lerp(12, 4, k), y: lerp(9, 4.5, k), z: lerp(16, 12.5, k) }, look: { x: CUP_TABLE.x, y: .6, z: CUP_TABLE.z - 1.6 }, fov: 42 };
    }
    case 'lift': {
      const p = who ?? { x: 0, z: CUP_TABLE.z - .8 };
      const k = smooth(u * 1.4);
      return { pos: { x: p.x + lerp(2.6, .8, k), y: lerp(1.5, 1.8, k), z: Math.min(13.8, p.z + lerp(9, 5.6, k)) }, look: { x: p.x, y: lerp(1.3, 1.9, k), z: p.z }, fov: lerp(38, 34, k) };
    }
    case 'lap': {
      const p = who ?? { x: 0, z: 0, heading: 0 };
      // from outside the lap (the team waits in the middle), a little ahead of him, looking back at him
      const r = Math.hypot(p.x, p.z) > 1 ? { x: p.x / Math.hypot(p.x, p.z), z: p.z / Math.hypot(p.x, p.z) } : { x: 0, z: 1 };
      const fwd = { x: Math.cos(p.heading), z: -Math.sin(p.heading) };
      return { pos: { x: clamp(p.x + r.x * 4.2 + fwd.x * 3.6, -27, 27), y: 2.4, z: clamp(p.z + r.z * 4.2 + fwd.z * 3.6, -13, 13.6) }, look: { x: p.x, y: 1.55, z: p.z }, fov: 40 };
    }
    case 'photo': {
      const k = smooth(u * 2);
      return { pos: { x: 0, y: lerp(2.6, 1.7, k), z: lerp(13, 9.6, k) }, look: { x: 0, y: .95, z: 1 }, fov: lerp(44, 40, k) };
    }
  }
}

/** A seat for a dressed man who has none yet (the light preset seats nobody): the n-th of his bench. */
export const spareSeat = (side: 0 | 1, n: number) => benchSeat(side, n);

/** What the match screen knows when the match is over (a playoff series as it stood before this game). */
export type OutroContext = {
  home: string; away: string;
  series?: { high: string; low: string; wins: [number, number]; final: boolean } | null;
  cup?: string; season?: string;
  /** whose a player is (for the star of the match: a winner) */
  teamOf: (id: string) => string | null | undefined;
};
/**
 * The scene for a finished match: a plain win; the clinching game of a playoff series (the handshake line); the
 * clinching game of the final (the Cup).
 */
export function outroSpecOf(res: { homeScore: number; awayScore: number; ot?: boolean; so?: boolean; stars?: string[] }, ctx: OutroContext): OutroSpec {
  const winner: 0 | 1 = res.homeScore >= res.awayScore ? 0 : 1;
  const wId = winner ? ctx.away : ctx.home;
  let kind: OutroKind = 'win', series: [number, number] | undefined;
  const s = ctx.series;
  if (s) {
    const wins: [number, number] = [s.wins[0], s.wins[1]];
    wins[wId === s.high ? 0 : 1]++;
    const homeHigh = ctx.home === s.high;
    series = homeHigh ? wins : [wins[1], wins[0]];
    if (Math.max(...wins) >= 4) kind = s.final ? 'cup' : 'series';
  }
  const star = res.stars?.find(id => ctx.teamOf(id) === wId) ?? null;
  return { winner, kind, score: [res.homeScore, res.awayScore], end: res.so ? 'so' : res.ot ? 'ot' : undefined, star, series, cup: ctx.cup, season: ctx.season };
}

/** What the scene after the final siren needs to know besides the score (a playoff series, the Cup). */
export type OutroInfo = Pick<OutroContext, 'series' | 'cup' | 'season'>;
/** A career game: its playoff series as it stands before the game (a copy) and the trophy the final is played for. */
export function careerOutroInfo(s: { playoffs?: { series: { id: number; round: number; high: string; low: string; wins: [number, number] }[] } | null; league: { season: string } }, game: { kind: string; seriesId: number | null }): OutroInfo {
  const sr = game.kind === 'playoff' && game.seriesId != null ? s.playoffs?.series.find((x) => x.id === game.seriesId) : undefined;
  return { series: sr ? { high: sr.high, low: sr.low, wins: [sr.wins[0], sr.wins[1]], final: sr.round === 3 } : null, cup: 'Кубок Гагарина', season: s.league.season };
}
