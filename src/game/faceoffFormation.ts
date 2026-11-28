/**
 * Where a team lines up for a faceoff, in its own frame (its goal at low x; the dot at `d`): the centre at the dot,
 * the wingers wide on the hash marks, the defence back on the points — whatever the strength. Every man gets a place
 * of his own (4-on-4, a penalty kill, a power play with four forwards, an extra attacker for a pulled goalie, a lone
 * defenceman playing the middle at 3-on-3): nobody is sent to a place already taken. Used by both rinks (the watched
 * match's RinkAI and the played PlayRink), so they agree.
 */
import { RINK } from './rinkGeometry';

type V2 = { x: number; y: number };
const W = RINK.width, MID = W / 2, GOAL = RINK.goalLine;

/** The places, as offsets from the dot (x toward the team's own goal is negative). */
export const FO_PLACE = {
  C: { x: -0.95, y: 0 },
  LW: { x: -1.2, y: -4.3 }, RW: { x: -1.2, y: 4.3 },
  LD: { x: -6.8, y: -3.6 }, RD: { x: -6.8, y: 3.6 }, D: { x: -6.8, y: 0 },
  X: { x: -4.2, y: 0 }, XL: { x: -3.4, y: -2.4 }, XR: { x: -3.4, y: 2.4 },
} as const;
export type FoPlace = keyof typeof FO_PLACE;

/**
 * The places of nF forwards and nD defencemen (in the order the caller ranks them: its centre first, its first
 * defenceman first). `boards`: which way the nearer boards are from the dot in the team's frame (-1 / +1; 0 at
 * centre ice) — a lone winger lines up on that side, where the puck goes off the boards.
 */
export function foPlaces(nF: number, nD: number, boards: -1 | 0 | 1 = 0): { F: FoPlace[]; D: FoPlace[] } {
  const free = new Set<FoPlace>(Object.keys(FO_PLACE) as FoPlace[]);
  const take = (prefs: FoPlace[]): FoPlace => {
    const p = prefs.find(x => free.has(x)) ?? [...free][0] ?? 'X';
    free.delete(p);
    return p;
  };
  // the middle or the two points; a third one in the slot
  if (nD === 1) free.delete('LD'), free.delete('RD'); else free.delete('D');
  const D: FoPlace[] = [];
  const F: FoPlace[] = [];
  // a team with no forward on the ice: its first defenceman takes the draw
  if (nF === 0 && nD > 0) D.push(take(['C']));
  for (let i = D.length; i < nD; i++) D.push(take(nD === 1 ? ['D'] : ['LD', 'RD', 'X', 'XL', 'XR', 'LW', 'RW']));
  const lone: FoPlace[] = boards > 0 ? ['RW', 'LW'] : ['LW', 'RW'];
  for (let i = 0; i < nF; i++) F.push(take(i === 0 ? ['C'] : nF === 2 ? [...lone, 'X'] : ['LW', 'RW', 'X', 'XL', 'XR', 'LD', 'RD', 'D']));
  return { F, D };
}

/**
 * A place on the ice for a team (its frame): kept in front of the goal line and off the boards. Places that would
 * meet there (the points of a defensive-zone draw would be behind the goal line) come out in front of it, apart.
 */
export function foSpot(d: V2, place: FoPlace, minX = GOAL + 1.4): V2 {
  const o = FO_PLACE[place];
  let x = d.x + o.x, y = d.y + o.y;
  // the points of a draw in the own end: up along the goal line, wider apart
  // a draw in the own end: the points would be behind the goal line — the inside man (or a lone one) steps into the
  // slot off the near post, clear of the goalie and of the inside winger; the boards-side man behind his winger
  if (x < minX) {
    const toMid = Math.sign(MID - d.y) || 1, inside = place === 'D' || Math.sign(o.y) === toMid;
    if (inside) { x = GOAL + 3.4; y = MID - toMid * 1.3; }
    else { x = GOAL + 2.0; y = d.y + o.y * 1.25; }
  }
  return { x, y: Math.min(W - 1, Math.max(1, y)) };
}

/** Which way the nearer boards are from a dot in a team's frame. */
export const boardsSide = (dl: V2): -1 | 0 | 1 => (Math.abs(dl.y - MID) < 1 ? 0 : dl.y < MID ? -1 : 1);
