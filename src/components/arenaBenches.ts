import * as T from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Team } from '../types';
import { RINK } from '../game/rinkGeometry';
import { Parts, type V } from './benchParts';
import { CoachRig } from './coachRig';

/**
 * The team benches and the penalty boxes of the 3D arena: rubber floor, the bench with club-colour cushions,
 * the back wall with the club name, glass, doors in the boards, a ledge with water bottles and towels, a stick
 * rack, the tunnel to the dressing room and the coaches standing behind the players; across the ice the two
 * penalty boxes in glass with the timekeepers' desk between them.
 *
 * Everything is low-poly geometry merged per colour (a couple of dozen draw calls in all). The seated players
 * (`crowd`) are a separate group: the replays and the light preset show them; the live 3D match on the higher
 * presets hides them and seats the real rigged figures of the dressed players instead (`benchSeat`, `boxSeat`).
 *
 * World space as in replayArena: metres, origin at centre ice, +x along the rink, +z across it, +y up. The benches
 * are on the far side (−z), the penalty boxes on the near one (+z).
 */

const HW = RINK.width / 2;
/** Bench layout: home bench centred at x −6, visitors at +6 (the side the 2D rink draws them on). */
export const BENCH = { x: [-6, 6] as const, length: 9, seatZ: -(HW + 1.35), seatTop: .48, floor: .05, slots: 16 };
/** Penalty boxes across the ice from the benches: home at x −2.6, visitors at +2.6. */
export const BOX = { x: [-2.6, 2.6] as const, seatZ: HW + 1.85, slots: 3 };

/** The doors in the boards: the two of each bench (players come out of the tunnel through the outer one), one per
 *  penalty box, and the officials' door beside the boxes (their corridor runs back under the stands). `x` is the middle
 *  of the door on the boards' line `z`; `out` the side it swings to (away from the ice). */
export type DoorKind = 'bench' | 'box' | 'officials';
export type DoorSpot = { kind: DoorKind; side: 0 | 1 | null; x: number; z: number; out: 1 | -1 };
export const OFFICIALS_DOOR_X = 6.2;
export const DOORS: readonly DoorSpot[] = [
  ...BENCH.x.flatMap((x0, side) => [-1, 1].map(s => ({ kind: 'bench' as const, side: side as 0 | 1, x: x0 + s * 3.7, z: -HW, out: -1 as const }))),
  ...BOX.x.map((x0, side) => ({ kind: 'box' as const, side: side as 0 | 1, x: x0, z: HW, out: 1 as const })),
  { kind: 'officials', side: null, x: OFFICIALS_DOOR_X, z: HW, out: 1 },
];
/** The bench door a team comes out of the tunnel through (the outer one, toward its end of the bench). */
export const gateDoor = (side: 0 | 1) => DOORS.find(d => d.kind === 'bench' && d.side === side && Math.abs(d.x) > Math.abs(BENCH.x[side]))!;
/** The tunnels to the dressing rooms (the mouth in the stands wall behind each bench) and the officials' corridor
 *  across the ice; the gap in the bench's back wall the players walk through. */
/** Half the width of the passage through the bench seat in front of the tunnel (the seat slot there is the last one used). */
export const SEAT_GAP = .36;
export const TUNNEL = { z: -(HW + 4.7), gapX: (side: 0 | 1) => BENCH.x[side] - .25, officialsZ: HW + 4.7 };
/** Where the coaches stand behind their bench (offset from the bench centre, facing the ice). */
export const COACH_DX = [-2.4, 1.2, 2.6] as const;
export const COACH_Z = -(HW + 2.15);

/** Where the n-th seat of a team's bench is (world metres) and the heading that faces the ice (the live scene's convention: 0 = facing +x). */
export function benchSeat(side: 0 | 1, slot: number) {
  const span = BENCH.length - .9, i = ((slot % BENCH.slots) + BENCH.slots) % BENCH.slots;
  return { x: BENCH.x[side] - span / 2 + span * (i + .5) / BENCH.slots, y: BENCH.floor, z: BENCH.seatZ - .08, heading: -Math.PI / 2 };
}
/** A seat in a team's penalty box, facing the ice. */
export function boxSeat(side: 0 | 1, slot: number) {
  const i = ((slot % BOX.slots) + BOX.slots) % BOX.slots;
  return { x: BOX.x[side] + (i - 1) * .85, y: BENCH.floor, z: BOX.seatZ + .08, heading: Math.PI / 2 };
}

/** Kit colours of the low-poly bench players. */
export type BenchKit = { jersey: string; trim: string; pants: string; socks: string; helmet: string; glove: string };
export function defaultBenchKit(team: Team, side: 0 | 1): BenchKit {
  return side === 0
    ? { jersey: team.primaryColor, trim: team.secondaryColor, pants: '#1a1f27', socks: team.primaryColor, helmet: team.primaryColor, glove: '#1a1f27' }
    : { jersey: '#f4f7fa', trim: team.primaryColor, pants: '#1a1f27', socks: '#f4f7fa', helmet: '#f4f7fa', glove: team.primaryColor };
}

const SKIN = ['#e3b796', '#d6a585', '#c48f6c', '#ebc3a4'], HAIR = ['#3b2a20', '#8f8f8f', '#1c1c1c', '#6b4a2e', '#c9c2b8'];
const SUIT = ['#1d222b', '#2a2f3a', '#23272f'];

/** A seated person (penalty box timekeeper): suit, at a desk. Seat surface at y = seat. */
function official(p: Parts, o: { suit: string; skin: string; hair: string; seat: number }) {
  const y = o.seat;
  for (const s of [-1, 1]) {
    p.limb(o.suit, .07, [s * .11, y + .07, -.02], [s * .12, y + .03, .4]);
    p.limb(o.suit, .062, [s * .12, y + .03, .4], [s * .12, .1, .44]);
    p.box('#0e1013', .1, .07, .25, [s * .12, .035, .5]);
  }
  p.box(o.suit, .36, .16, .3, [0, y + .08, -.02]);
  p.cyl(o.suit, .21, .18, .58, [0, y + .44, -.04], [.08, 0, 0], [1, 1, .64], 10);
  p.box('#eef1f4', .1, .2, .02, [0, y + .6, .1]);
  p.cyl(o.skin, .048, .055, .1, [0, y + .76, -.01]);
  p.ball(o.skin, .108, [0, y + .88, .0], [1, 1.12, 1.05]);
  p.ball(o.hair, .113, [0, y + .925, -.03], [1.02, .78, 1.02]);
  for (const s of [-1, 1]) { p.limb(o.suit, .055, [s * .21, y + .66, -.04], [s * .23, y + .42, .12], .05); p.limb(o.suit, .05, [s * .23, y + .42, .12], [s * .12, y + .43, .38], .045); p.ball(o.skin, .045, [s * .1, y + .44, .42]); }
}

/** A seated hockey player in full kit, stick upright between the knees (low poly). */
function benchPlayer(p: Parts, k: BenchKit, skin: string, seat: number, v: number) {
  const y = seat, lean = .18 + v * .14, sp = .13 + v * .03;
  for (const s of [-1, 1]) {
    const hip: V = [s * .12, y + .1, .02], knee: V = [s * sp, y + .08, .44], ankle: V = [s * (sp + .01), .13, .5];
    p.limb(k.pants, .1, hip, knee, .095);
    p.limb(k.socks, .078, knee, ankle, .065);
    p.ball(k.socks, .08, knee);
    p.box('#111418', .1, .11, .3, [ankle[0], .085, ankle[2] + .05]);
    p.box('metal:#c9d6de', .016, .035, .3, [ankle[0], .018, ankle[2] + .05]);
  }
  p.box(k.pants, .42, .26, .36, [0, y + .14, .02]);
  p.cyl(k.trim, .222, .222, .06, [0, y + .3, .03], [lean * .5, 0, 0], [1, 1, .72], 10);
  p.cyl(k.jersey, .25, .215, .52, [0, y + .55, .07], [lean, 0, 0], [1, 1, .72], 10);
  for (const s of [-1, 1]) p.ball(k.jersey, .135, [s * .21, y + .76, .14], [1, .82, 1]);
  p.ball(skin, .1, [0, y + .93, .2], [1, 1.08, 1]);
  p.ball(k.helmet, .128, [0, y + .97, .18], [1, .9, 1.1]);
  p.box('#1b2430', .19, .055, .02, [0, y + .93, .31]);
  // stick: blade on the floor in front, the knob up at the chin, both gloves on it
  const blade: V = [.02, .03, .86], knob: V = [0, y + .78, .4];
  p.limb('#15181c', .016, blade, knob);
  p.box('#15181c', .3, .06, .018, [.13, .035, .87]);
  p.box('#f2f4f6', .035, .06, .035, [knob[0], knob[1] - .02, knob[2] + .005]);
  const g1: V = [0, y + .66, .45], g2: V = [.01, y + .5, .52];
  p.box(k.glove, .13, .12, .14, g1); p.box(k.glove, .13, .12, .14, g2);
  p.limb(k.jersey, .07, [.22, y + .74, .15], [.2, y + .5, .3], .065); p.limb(k.jersey, .062, [.2, y + .5, .3], g2, .06);
  p.limb(k.jersey, .07, [-.22, y + .74, .15], [-.2, y + .6, .32], .065); p.limb(k.jersey, .062, [-.2, y + .6, .32], g1, .06);
}

/** A player standing at the bench boards, waiting for the change (gloves on the top of the boards). */
function standingPlayer(p: Parts, k: BenchKit, skin: string) {
  for (const s of [-1, 1]) {
    p.limb(k.pants, .1, [s * .12, .98, 0], [s * .13, .56, .06], .09);
    p.limb(k.socks, .078, [s * .13, .56, .06], [s * .14, .14, 0], .065);
    p.box('#111418', .1, .11, .3, [s * .14, .085, .05]);
  }
  p.box(k.pants, .42, .28, .34, [0, 1.0, 0]);
  p.cyl(k.jersey, .25, .215, .52, [0, 1.4, .06], [.3, 0, 0], [1, 1, .72], 10);
  for (const s of [-1, 1]) p.ball(k.jersey, .135, [s * .21, 1.6, .15], [1, .82, 1]);
  p.ball(skin, .1, [0, 1.76, .24], [1, 1.08, 1]);
  p.ball(k.helmet, .128, [0, 1.8, .22], [1, .9, 1.1]);
  p.box('#1b2430', .19, .055, .02, [0, 1.76, .35]);
  for (const s of [-1, 1]) { p.limb(k.jersey, .07, [s * .22, 1.58, .16], [s * .3, 1.25, .3], .065); p.limb(k.jersey, .062, [s * .3, 1.25, .3], [s * .22, 1.1, .5], .06); p.box(k.glove, .13, .12, .15, [s * .22, 1.1, .52]); }
  p.limb('#15181c', .016, [.24, 1.14, .52], [.42, .03, .22]); p.box('#15181c', .26, .055, .016, [.53, .035, .2], [0, -.4, 0]);
}

export type BenchBuild = {
  home: Team; away: Team; kits?: [BenchKit, BenchKit];
  /** the static part (benches, boxes, coaches, officials) */ group: T.Group;
  /** the low-poly seated players */ crowd: T.Group;
  mesh: (g: T.BufferGeometry, m: T.Material, parent: T.Object3D) => T.Mesh;
  mat: <M extends T.Material>(m: M) => M;
  texture: (c: HTMLCanvasElement) => T.Texture;
  canvas: (w: number, h: number) => { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D | null };
};

export function buildBenches(b: BenchBuild) {
  const { home, away } = b;
  const kits = b.kits ?? [defaultBenchKit(home, 0), defaultBenchKit(away, 1)];
  const cache = new Map<string, T.Material>();
  const material = (key: string) => {
    let m = cache.get(key);
    if (m) return m;
    if (key === 'glass') m = new T.MeshStandardMaterial({ color: '#cfe8f4', transparent: true, opacity: .14, roughness: .05, metalness: .1, depthWrite: false, side: T.DoubleSide });
    else if (key.startsWith('lit:')) m = new T.MeshBasicMaterial({ color: key.slice(4) });
    else if (key.startsWith('metal:')) m = new T.MeshStandardMaterial({ color: key.slice(6), metalness: .6, roughness: .35 });
    else m = new T.MeshStandardMaterial({ color: key, roughness: .75 });
    b.mat(m); cache.set(key, m); return m;
  };
  const p = new Parts(), crowd = new Parts();
  const coaches: BenchCoach[] = [];
  const tinted = new T.MeshStandardMaterial({ vertexColors: true, roughness: .75 }); b.mat(tinted);
  const D = '#1b232c', FLOOR = '#20272f', SEAT = '#2d3743', CAP = '#d8dee4';
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const pick = <X,>(list: X[]) => list[Math.floor(rnd() * list.length) % list.length];

  /* ---------- the benches (far side) ---------- */
  const bz = -(HW + 1.4), wallZ = -(HW + 2.62);
  BENCH.x.forEach((x0, side) => {
    const team = side ? away : home, L = BENCH.length;
    p.world();
    p.box(FLOOR, L, .05, 2.45, [x0, .025, bz]);
    // the seat, with a passage in front of the tunnel (the players walk in from the dressing room through it)
    const gx = TUNNEL.gapX(side as 0 | 1), g0 = gx - .7, g1 = gx + .7, a0 = x0 - L / 2, a1 = x0 + L / 2;
    for (const [u, v] of [[x0 - (L - .4) / 2, gx - SEAT_GAP], [gx + SEAT_GAP, x0 + (L - .4) / 2]]) {
      p.box(SEAT, v - u, .4, .42, [(u + v) / 2, .2, BENCH.seatZ]);
      p.box(team.primaryColor, v - u, .08, .45, [(u + v) / 2, .44, BENCH.seatZ]);
    }
    // the back wall, with a gap in front of the tunnel
    for (const [u, v] of [[a0, g0], [g1, a1]]) {
      p.box(D, v - u, 1.25, .12, [(u + v) / 2, .625, wallZ]);
      p.box(CAP, v - u + .02, .05, .18, [(u + v) / 2, 1.275, wallZ]);
      p.box('glass', v - u, 1.1, .03, [(u + v) / 2, 1.85, wallZ]);
    }
    p.box(CAP, .08, 1.3, .2, [g0, .65, wallZ]); p.box(CAP, .08, 1.3, .2, [g1, .65, wallZ]);
    for (const s of [-1, 1]) {
      p.box(D, .1, 1.25, 2.45, [x0 + s * L / 2, .625, bz]);
      p.box('glass', .03, 1.15, 2.45, [x0 + s * L / 2, 1.85, bz]);
      p.box('metal:#b7c4cc', .06, 1.15, .06, [x0 + s * L / 2, 1.85, wallZ + .05]);
      // the two doors in the boards (white frames on the ice side) and their hinges
      for (const e of [-.45, .45]) p.box('#f4f6f8', .05, 1.0, .014, [x0 + s * 3.7 + e, .53, -HW + .008]);
      p.box('#c9d3db', .9, .03, .012, [x0 + s * 3.7, 1.0, -HW + .009]);
    }
    // the ledge on the inside of the boards: water bottles and towels
    p.box('#cfd8df', L - .3, .04, .2, [x0, 1.02, -(HW + .31)]);
    for (let i = 0; i < 9; i++) {
      const bx = x0 - L / 2 + .9 + i * .95 + (rnd() - .5) * .2;
      p.cyl('#e9eef2', .034, .036, .22, [bx, 1.15, -(HW + .3)], [0, 0, 0], [1, 1, 1], 8);
      p.cyl(team.primaryColor, .024, .03, .05, [bx, 1.285, -(HW + .3)]);
      if (i % 3 === 1) p.box('#f6f7f8', .32, .025, .17, [bx + .4, 1.053, -(HW + .31)], [0, (rnd() - .5) * .5, 0]);
    }
    // the club name along the back wall, the stick rack at the end of the bench
    const tag = b.canvas(1024, 96);
    if (tag.ctx) {
      const c = tag.ctx; c.fillStyle = team.primaryColor; c.fillRect(0, 0, 1024, 96);
      c.fillStyle = team.secondaryColor; c.fillRect(0, 0, 1024, 8); c.fillRect(0, 88, 1024, 8);
      c.fillStyle = '#ffffff'; c.font = 'bold 54px Oswald, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      for (const cx of [256, 768]) c.fillText((team.short ?? team.name).toUpperCase(), cx, 50, 480);
    }
    // the name plate on both parts of the wall (the gap in the middle stays open)
    const plateMat = b.mat(new T.MeshBasicMaterial({ map: b.texture(tag.c) }));
    for (const [u, v] of [[a0 + .1, g0 - .05], [g1 + .05, a1 - .1]]) {
      const geo = new T.PlaneGeometry(v - u, .7), uv = geo.getAttribute('uv') as T.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setX(i, ((u + (v - u) * uv.getX(i)) - (a0 + .1)) / (L - .2));
      const plate = b.mesh(geo, plateMat, b.group);
      plate.position.set((u + v) / 2, .78, wallZ + .065); plate.updateMatrix();
    }
    const rackX = x0 + (side ? -1 : 1) * (L / 2 - .55);
    p.box(D, .9, .08, .2, [rackX, 1.45, wallZ + .14]);
    for (let i = 0; i < 12; i++) {
      const sx = rackX - .4 + i * .072;
      p.limb('#15181c', .013, [sx + .06, .07, wallZ + .2], [sx, 1.52, wallZ + .17]);
      p.box(i % 4 ? '#15181c' : '#f2f4f6', .26, .055, .016, [sx + .18, .05, wallZ + .22]);
      p.box('#f2f4f6', .03, .07, .03, [sx, 1.5, wallZ + .17]);
    }
    // the tunnel to the dressing room in the stands wall behind the bench
    p.box('#04060a', 2.4, 2.25, .05, [x0, 1.125, -(HW + 4.97)]);
    p.box(team.primaryColor, 2.6, .2, .06, [x0, 2.33, -(HW + 4.96)]);
    p.box(FLOOR, 2.4, .04, 2.3, [x0, .02, -(HW + 3.8)]);
    // coaches: the head coach arms crossed, an assistant with the line card, one with the tablet / pointing
    // (each one his own little group: the live match walks them out of the tunnel after the players)
    const poses = ['clip', 'cross', 'point'] as const;
    COACH_DX.forEach((dx, i) => {
      const x = x0 + dx + (rnd() - .5) * .3, yaw = (rnd() - .5) * .3;
      const g = new T.Group(); g.position.set(x, 0, COACH_Z); g.rotation.y = yaw; g.updateMatrix(); b.group.add(g);
      // jointed (see coachRig): the live match brings him to life, the replays leave him standing
      const rig = new CoachRig(g, BENCH.floor, poses[i], { suit: SUIT[(i + side) % SUIT.length], tie: i === 1 ? team.primaryColor : pick(['#7a1f2b', '#22426b', team.secondaryColor]), skin: pick(SKIN), hair: pick(HAIR) },
        (c, node) => c.buildTinted(node, b.mesh, tinted, material), i * 1.7 + side * 3.1);
      coaches.push({ side: side as 0 | 1, group: g, x, z: COACH_Z, yaw, rig, head: i === 1 });
    });
    // the players who are not on the ice (light preset and the replays): seated, one standing at the door
    const k = kits[side];
    for (let i = 0; i < BENCH.slots; i++) {
      if (i === 0 || i === BENCH.slots - 1 || i === 7) continue; // room at the doors and in the middle
      const s = benchSeat(side as 0 | 1, i);
      crowd.at(s.x + (rnd() - .5) * .06, BENCH.floor, s.z + .08, (rnd() - .5) * .4);
      benchPlayer(crowd, k, pick(SKIN), BENCH.seatTop, rnd());
    }
    crowd.at(x0 + (side ? -1 : 1) * 3.7, BENCH.floor, -(HW + .62), (rnd() - .5) * .3);
    standingPlayer(crowd, k, pick(SKIN));
  });
  p.world();
  // between the benches: a solid divider with glass on top
  p.box(D, 3, 1.25, 2.45, [0, .625, bz]);
  p.box(CAP, 3, .05, 2.45, [0, 1.275, bz]);

  /* ---------- the penalty boxes and the timekeepers (near side) ---------- */
  const pz = HW + 1.25, pwall = HW + 2.3;
  p.box(FLOOR, 8.8, .05, 2.1, [0, .025, pz]);
  p.box('#16304d', 8.8, 1.25, .1, [0, .625, pwall]);
  p.box(CAP, 8.84, .05, .16, [0, 1.275, pwall]);
  p.box('glass', 8.8, 1.15, .03, [0, 1.85, pwall]);
  for (const x of [-4.4, -.8, .8, 4.4]) {
    p.box(Math.abs(x) > 1 ? D : '#2a3440', .08, 1.25, 2.1, [x, .625, pz]);
    p.box('glass', .03, 1.15, 2.1, [x, 1.85, pz]);
    p.box('metal:#b7c4cc', .05, 2.42, .05, [x, 1.21, pwall - .05]);
  }
  BOX.x.forEach((x0, side) => {
    p.box(SEAT, 3.2, .4, .4, [x0, .2, BOX.seatZ]);
    p.box('#2b4a6b', 3.2, .08, .42, [x0, .44, BOX.seatZ]);
    for (const e of [-.45, .45]) p.box('#f4f6f8', .05, 1.0, .014, [x0 + e, .53, HW - .008]);
    // the penalty clock on the back glass
    p.box('#0b0d10', .62, .26, .08, [x0, 2.55, pwall]);
    p.box('lit:#ff3b30', .5, .14, .01, [x0, 2.55, pwall - .045]);
    p.box(side ? away.primaryColor : home.primaryColor, .62, .04, .085, [x0, 2.7, pwall]);
  });
  // the timekeepers' desk: two officials, a laptop, the horn
  p.box('#2a3440', 1.5, .75, .5, [0, .375, HW + .7]);
  p.box('#cfd8df', 1.54, .03, .54, [0, .765, HW + .7]);
  p.box('#15181c', .34, .015, .23, [-.3, .79, HW + .72]);
  p.box('lit:#9fd0ff', .32, .2, .01, [-.3, .89, HW + .62], [.25, 0, 0]);
  p.box('#15181c', .14, .08, .1, [.35, .82, HW + .72]);
  p.box('#cf2a2a', .1, .06, .1, [.35, .88, HW + .72]);
  [-.35, .35].forEach((dx, i) => { p.at(dx, BENCH.floor, HW + 1.55, Math.PI); official(p, { suit: i ? '#1d222b' : '#2a2f3a', skin: pick(SKIN), hair: pick(HAIR), seat: .48 }); });
  p.world();
  p.box(SEAT, 1.4, .45, .4, [0, .225, HW + 1.6]);

  /* ---------- the officials' corridor (near side, beside the visitors' box) ---------- */
  {
    const x = OFFICIALS_DOOR_X, z0 = HW + .2, z1 = TUNNEL.officialsZ + .27, zc = (z0 + z1) / 2, len = z1 - z0;
    p.box(FLOOR, 1.7, .05, len, [x, .025, zc]);
    for (const s of [-1, 1]) {
      p.box(D, .1, 1.25, len, [x + s * .85, .625, zc]);
      p.box(CAP, .14, .05, len, [x + s * .85, 1.275, zc]);
    }
    p.box('#04060a', 1.9, 2.25, .05, [x, 1.125, z1]);
    p.box('#2b2f36', 2.1, .3, .07, [x, 2.38, z1 - .01]);
    const sign = b.canvas(256, 40);
    if (sign.ctx) { const c = sign.ctx; c.fillStyle = '#2b2f36'; c.fillRect(0, 0, 256, 40); c.fillStyle = '#f2f4f6'; c.font = 'bold 26px Oswald, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('СУДЬИ', 128, 21); }
    const plate = b.mesh(new T.PlaneGeometry(2, .28), b.mat(new T.MeshBasicMaterial({ map: b.texture(sign.c) })), b.group);
    plate.position.set(x, 2.38, z1 - .05); plate.rotation.y = Math.PI; plate.updateMatrix();
    for (const e of [-.45, .45]) p.box('#f4f6f8', .05, 1.0, .014, [x + e, .53, HW - .008]);
  }

  p.build(b.group, b.mesh, material);
  crowd.build(b.crowd, b.mesh, material);

  /* ---------- the doors: a panel hinged on one post that swings open away from the ice, and the dark gap behind it ---------- */
  const panelMat = material('#eef2f5'), gapMat = material(FLOOR);
  const doors: BenchDoor[] = DOORS.map(d => {
    const hinge = new T.Group();
    hinge.position.set(d.x - .45, .03, d.z - d.out * .028);
    const panelGeo = new T.BoxGeometry(.89, 1.0, .045); panelGeo.translate(.445, .5, 0);
    const trimGeo = new T.BoxGeometry(.89, .05, .05); trimGeo.translate(.445, 1.0, 0);
    const doorGeo = mergeGeometries([panelGeo, trimGeo], false)!; panelGeo.dispose(); trimGeo.dispose();
    b.mesh(doorGeo, panelMat, hinge);
    const gap = b.mesh(new T.BoxGeometry(.86, 1.02, .26), gapMat, b.group);
    gap.position.set(d.x, .53, d.z + d.out * .1); gap.visible = false; gap.updateMatrix();
    hinge.updateMatrix(); hinge.children.forEach(c => c.updateMatrix());
    b.group.add(hinge);
    let open = 0;
    return {
      ...d, hinge, gap,
      get open() { return open; },
      set(v: number) {
        v = Math.max(0, Math.min(1, v));
        if (Math.abs(v - open) < 1e-4) return;
        open = v;
        // out = −1 (the benches, behind the boards at −z): a positive turn about +y swings the panel's free end to −z
        hinge.rotation.y = -d.out * 1.75 * v * v * (3 - 2 * v);
        hinge.updateMatrix(); hinge.updateMatrixWorld(true);
        gap.visible = v > .01;
      },
    };
  });
  return { doors, coaches };
}

export type BenchDoor = DoorSpot & { hinge: T.Group; gap: T.Mesh; readonly open: number; set: (v: number) => void };
export type BenchCoach = { side: 0 | 1; group: T.Group; x: number; z: number; yaw: number; /** his joints */ rig: CoachRig; /** the head coach (arms crossed, in the middle) */ head: boolean };
