/**
 * IIHF / KHL ice surface (IIHF Rule Book, section 2 "The rink"), in metres, origin at the left end boards,
 * x along the rink (0…60), y across it (0…30). All views (2D rink, shot map, 3D replay) and the rink AI use
 * these numbers, so the blue lines, circles and dots sit at the same real proportions everywhere.
 *
 *  - goal lines 4.0 m from the end boards, 5 cm wide;
 *  - blue lines 22.86 m from the end boards (measured to their far edge), 30 cm wide → zones of ≈18.9 m
 *    and a neutral zone of ≈14.3 m;
 *  - end-zone faceoff spots on a line 6 m out from each goal line, 7 m either side of the long axis,
 *    circles of radius 4.5 m;
 *  - four neutral-zone spots 1.5 m outside each blue line (used after offsides, among others);
 *  - centre circle 4.5 m; corner radius 8.5 m; goal crease semicircle 1.83 m; goal 1.83 × 1.22 m, ≈1.1 m deep.
 */
export const RINK = {
  length: 60,
  width: 30,
  corner: 8.5,
  goalLine: 4,
  /** Centre of the 30 cm blue line, measured from the nearer end boards. */
  blueLine: 22.86 - 0.15,
  blueWidth: 0.3,
  redWidth: 0.3,
  lineWidth: 0.05,
  circleR: 4.5,
  /** End-zone faceoff spots: distance from the end boards. */
  endDot: 4 + 6,
  /** Neutral-zone faceoff spots: distance from the end boards (1.5 m outside the blue line). */
  neutralDot: 22.86 + 1.5,
  /** Lateral offset of all non-centre faceoff spots from the long axis. */
  dotOffset: 7,
  dotR: 0.3,
  crease: 1.83,
  goalWidth: 1.83,
  goalHeight: 1.22,
  goalDepth: 1.12,
} as const;

/** Metres → the 0…100 (along) / 0…100 (across) percentage coordinates used by engine events and replay clips. */
export const pctX = (m: number) => (m / RINK.length) * 100;
export const pctY = (m: number) => (m / RINK.width) * 100;

export type RinkSpot = { x: number; y: number };
/** All nine faceoff spots in metres. */
export const FACEOFF_SPOTS: { center: RinkSpot; end: RinkSpot[]; neutral: RinkSpot[] } = {
  center: { x: RINK.length / 2, y: RINK.width / 2 },
  end: [RINK.endDot, RINK.length - RINK.endDot].flatMap(x => [RINK.width / 2 - RINK.dotOffset, RINK.width / 2 + RINK.dotOffset].map(y => ({ x, y }))),
  neutral: [RINK.neutralDot, RINK.length - RINK.neutralDot].flatMap(x => [RINK.width / 2 - RINK.dotOffset, RINK.width / 2 + RINK.dotOffset].map(y => ({ x, y }))),
};

/** Ends switch every period (2nd period and the first overtime are played the other way round). */
export const endsSwitched = (period: number) => period % 2 === 0;
