import { RINK } from '../game/rinkGeometry';

/**
 * The teams take the ice before the first period (3D): the lights go down and the laser show starts, the
 * officials skate out to the red line, then the visitors come out of their gate one after another — a lap of
 * their half and into line on their blue line — then the home team the same way, louder (the show peaks); the
 * lights come up and everybody skates to his place for the opening faceoff, where the match takes over.
 *
 * Pure (no three.js): times are seconds of real time since the start, positions world metres (origin at centre
 * ice, x along the rink, z across it; the benches and their gates on −z), headings the 3D scene's convention
 * (0 = facing +x, angle = atan2(−dz, dx)). The tests run it in Node.
 */
export type IntroSkater = { id: string; side: 0 | 1; goalie: boolean;
  /** where he has to be when the match starts (the opening faceoff formation) */ x: number; z: number };
export type IntroPose = { x: number; z: number; heading: number; speed: number; visible: boolean;
  /** raising the stick to the crowd 0…1 */ wave: number };

const HL = RINK.length / 2, HW = RINK.width / 2, BLUE = HL - RINK.blueLine;
export const INTRO = {
  /** the officials skate out */ officials: 1,
  /** the visitors' first man comes out / the home team's */ away: 2.6, home: 7.8,
  /** between two players coming out */ gap: .38,
  /** the lights come up, everybody to his place, the match starts */ settle: 14, length: 16.8,
};
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (v: number) => { const t = clamp(v, 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

/** The gate a team comes out of (by its bench, home on the −x side of centre ice). */
export function gateOf(side: 0 | 1) { return { x: side ? 9.7 : -9.7, z: -HW + .6 }; }
/** Which end a team defends at the start (its skaters' side of centre ice in the opening formation). */
export function homeEnd(skaters: IntroSkater[], side: 0 | 1): 1 | -1 {
  const own = skaters.filter(s => s.side === side);
  const mx = own.reduce((a, s) => a + s.x, 0) / Math.max(1, own.length);
  return mx >= 0 ? 1 : -1;
}

/**
 * A team's route: out of the gate, a lap through its own half (a loop around the end-zone circles), into line on
 * its blue line facing centre ice. Returned as a polyline; `lineSpot` is the place in the line.
 */
function route(side: 0 | 1, end: 1 | -1, lineSpot: { x: number; z: number }) {
  const g = gateOf(side);
  const pts = [g, { x: end * 12, z: -10 }, { x: end * 19, z: -4 }, { x: end * 18.5, z: 5 }, { x: end * 13, z: 7.5 }, { x: lineSpot.x + end * 2.2, z: lineSpot.z * .7 + 1.5 }, lineSpot];
  return pts;
}
function along(pts: { x: number; z: number }[], s: number) {
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]);
    if (s <= d) { const u = d > 0 ? s / d : 1; return { x: lerp(pts[i - 1].x, pts[i].x, u), z: lerp(pts[i - 1].z, pts[i].z, u), dx: pts[i].x - pts[i - 1].x, dz: pts[i].z - pts[i - 1].z, done: false }; }
    s -= d;
  }
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  return { x: b.x, z: b.z, dx: b.x - a.x, dz: b.z - a.z, done: true };
}
const length = (pts: { x: number; z: number }[]) => pts.slice(1).reduce((a, p, i) => a + dist(pts[i], p), 0);

/** The order a team comes out in: the starting goalie first (as in the KHL), then the skaters. */
export function lineup(skaters: IntroSkater[], side: 0 | 1) {
  const own = skaters.filter(s => s.side === side);
  return [...own.filter(s => s.goalie), ...own.filter(s => !s.goalie)];
}

/** Where everyone is at time t of the intro. */
export function introPoses(skaters: IntroSkater[], t: number): Map<string, IntroPose> {
  const out = new Map<string, IntroPose>();
  for (const side of [1, 0] as const) {
    const end = homeEnd(skaters, side), order = lineup(skaters, side), start = side === 1 ? INTRO.away : INTRO.home;
    order.forEach((s, i) => {
      // the line on the blue line: centred on the long axis, 1.6 m apart, goalie at the end by the boards
      const lineSpot = { x: end * (BLUE + .9), z: (i - (order.length - 1) / 2) * 1.7 };
      const pts = route(side, end, lineSpot), len = length(pts);
      const t0 = start + i * INTRO.gap, speed = 10.5;
      const run = t - t0;
      if (run < 0) { out.set(s.id, { x: pts[0].x, z: pts[0].z, heading: Math.PI / 2, speed: 0, visible: false, wave: 0 }); return; }
      // skate the route (easing off into line), then stand facing centre ice; finally to the faceoff place
      const ease = Math.min(len, run * speed - Math.max(0, run * speed - len * .85) * .45);
      const p = along(pts, Math.min(len, ease));
      const arrived = p.done || ease >= len - .05;
      let x = p.x, z = p.z, heading = arrived ? (end > 0 ? Math.PI : 0) : Math.atan2(-p.dz, p.dx), sp = arrived ? 0 : speed;
      // a wave to the crowd as he comes out, and once more in line when the whole team is out
      const outT = run, lined = t - (start + order.length * INTRO.gap + 2.2);
      let wave = smooth(outT / .4) * (1 - smooth((outT - 1.6) / .5)) * .8 + (lined > 0 ? smooth(lined / .4) * (1 - smooth((lined - 1.4) / .5)) * .6 : 0);
      const settle = smooth((t - INTRO.settle - i * .08) / 2.3);
      if (settle > 0) {
        const tx = s.x, tz = s.z;
        const k = settle;
        const nx = lerp(x, tx, k), nz = lerp(z, tz, k);
        if (k < .98) heading = Math.atan2(-(tz - z), tx - x);
        else heading = end > 0 ? Math.PI : 0;
        sp = k < .98 ? Math.max(sp, dist({ x, z }, { x: tx, z: tz }) * .9) : 0;
        x = nx; z = nz; wave *= 1 - k;
      }
      out.set(s.id, { x, z, heading, speed: sp, visible: true, wave });
    });
  }
  return out;
}

/** The officials: out from the timekeepers' side to the red line, then away to their places for the start. */
export function introOfficials(t: number, places: { x: number; z: number }[]): IntroPose[] {
  return places.map((p, i) => {
    const t0 = INTRO.officials + i * .35, run = t - t0;
    const from = { x: (i - 1.5) * .9, z: HW - .6 }, line = { x: 0, z: (i - 1.5) * 2.2 - 3.5 };
    let x = from.x, z = from.z, heading = -Math.PI / 2, speed = 0;
    if (run > 0) {
      const k = smooth(run / 2.6);
      x = lerp(from.x, line.x, k); z = lerp(from.z, line.z, k); speed = k < 1 ? 6 : 0;
      heading = k < .95 ? Math.atan2(-(line.z - from.z), line.x - from.x) : Math.PI / 2 * (i % 2 ? 1 : -1);
      if (k >= .95) heading = Math.PI / 2; // facing the near side (the cameras) for the line-up
    }
    const settle = smooth((t - INTRO.settle) / 2.3);
    if (settle > 0) { const nx = lerp(x, p.x, settle), nz = lerp(z, p.z, settle); if (settle < .98) { heading = Math.atan2(-(p.z - z), p.x - x); speed = 5; } x = nx; z = nz; }
    return { x, z, heading, speed, visible: run > 0, wave: 0 };
  });
}

/**
 * The show: `level` 0…1 how dark the arena is and how strong the lasers are; `team` whose colours the lasers and
 * the ice projection play (−1 both); `focus` where the spotlights are (the team coming out).
 */
export function introShow(t: number, skaters: IntroSkater[]): { level: number; team: 0 | 1 | -1; focus: { x: number; z: number }; burst: number } {
  const level = smooth(t / 1.2) * (1 - smooth((t - INTRO.settle + .4) / 1.6));
  const team: 0 | 1 | -1 = t < INTRO.away - .3 ? -1 : t < INTRO.home - .2 ? 1 : t < INTRO.settle - 1 ? 0 : -1;
  const poses = introPoses(skaters, t);
  let x = 0, z = 0, n = 0;
  if (team >= 0) for (const s of skaters) { if (s.side !== team) continue; const p = poses.get(s.id); if (p?.visible) { x += p.x; z += p.z; n++; } }
  const burst = Math.max(0, 1 - Math.abs(t - INTRO.home) / .6) + Math.max(0, 1 - Math.abs(t - INTRO.away) / .6) * .6;
  return { level, team, focus: n ? { x: x / n, z: z / n } : { x: 0, z: 0 }, burst };
}

/** The intro's camera: a high sweep over the dark arena, then down to each team as it comes out. */
export function introCamera(t: number, focus: { x: number; z: number }): { pos: { x: number; y: number; z: number }; look: { x: number; y: number; z: number }; fov: number } {
  if (t < INTRO.away) {
    const a = -1.9 + t * .12;
    return { pos: { x: Math.cos(a) * 34, y: lerp(24, 15, smooth(t / INTRO.away)), z: Math.sin(a) * -24 + 4 }, look: { x: 0, y: 1, z: 0 }, fov: 50 };
  }
  // a crane on the near side, drifting with the team coming out
  const k = smooth((t - INTRO.away) / 1.5);
  const a = -1.9 + INTRO.away * .12;
  const from = { x: Math.cos(a) * 34, y: 15, z: Math.sin(a) * -24 + 4 };
  const to = { x: clamp(focus.x * .7, -16, 16), y: 9.5, z: 23 };
  const pos = { x: lerp(from.x, to.x, k), y: lerp(from.y, to.y, k), z: lerp(from.z, to.z, k) };
  return { pos, look: { x: lerp(0, focus.x, k * .9), y: 1, z: lerp(0, focus.z * .4, k) }, fov: lerp(50, 44, k) };
}
