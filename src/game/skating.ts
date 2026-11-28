/**
 * How a skater can change his velocity on the ice in one step — the same for the watched rink (rinkAI) and the
 * played one (playRink).
 *
 * Skates are not a car with a steering wheel: along the blades he pushes (the first strides from a standstill are the
 * hardest, an explosive start) or digs in to brake (a hockey stop bites hardest); across the blades the edges hold him
 * in a carve. Both share the grip — a friction ellipse — so a man flying at full speed cannot turn a right angle: he
 * carves an arc keeping his speed, or wanting to go back the way he came he stops hard and goes again (at speed a
 * U-turn on the edges is slower than a stop and a restart, and that is what players do).
 */
export interface SteerOpts {
  /** his acceleration along the blades (m/s²) */
  acc: number;
  /** braking against his motion, × acc (a hockey stop comes on top of it) */
  brake?: number;
  /** carving across his motion, × acc (good skaters hold an edge harder) */
  grip?: number;
  /** a goalie (and anyone scripted) moves on his own terms: no start burst, no stop, no carve limit */
  plain?: boolean;
  /** how much of a turn costs speed (0: a pure carve keeps it all, 1: only what is left along his line) */
  scrub?: number;
  /** the explosive start: extra push from a standstill, fading by 4 m/s (default 0.3) */
  burst?: number;
}

export interface SteerResult { dvx: number; dvy: number; stop: boolean }

/**
 * The change of velocity (vx, vy) → toward (wx, wy) allowed in `dt` seconds.
 * `stop` tells the caller he is in a hard stop (wanting to go back, or to stand, at speed).
 */
export function steer(vx: number, vy: number, wx: number, wy: number, dt: number, o: SteerOpts): SteerResult {
  let dvx = wx - vx, dvy = wy - vy;
  const sp = Math.hypot(vx, vy), dl = Math.hypot(dvx, dvy);
  if (dl < 1e-9) return { dvx: 0, dvy: 0, stop: false };
  const brake = o.brake ?? 1.7;
  if (o.plain || sp < 1.2) {
    // slow (or a goalie): he turns on the spot; only the push is limited
    const lim = o.acc * dt * (o.plain ? (sp > 0.5 && dvx * vx + dvy * vy < 0 ? brake : 1) : 1 + (o.burst ?? 0.3) * (1 - sp / 4));
    if (dl > lim) { dvx *= lim / dl; dvy *= lim / dl; }
    return { dvx, dvy, stop: false };
  }
  // along / across his motion
  const tx = vx / sp, ty = vy / sp;
  let along = dvx * tx + dvy * ty, across = -dvx * ty + dvy * tx;
  const wsp = Math.hypot(wx, wy), dot = wx * tx + wy * ty;
  // a hard stop: at speed wanting to stand, or to go more than ~105° away from where he is going
  const stop = sp > 3 && (wsp < 0.8 || dot < -0.26 * wsp);
  // carving: he turns on his edges without giving up speed — along the blades only the change of speed he wants
  // (a sharp turn still scrubs some speed: `scrub` 0 — none, 1 — all he would lose going straight for the new line)
  if (!stop) { const sc = o.scrub ?? 0; along = (1 - sc) * (wsp - sp) + sc * along; }
  // the push along the blades fades with speed from the explosive start; the brake bites harder in a real stop
  const limA = o.acc * dt * (along >= 0 ? 1 + (o.burst ?? 0.3) * Math.max(0, 1 - sp / 4) : stop ? brake * 1.25 : brake);
  // in a stop the blades are across his motion: he does not carve, he slides straight to a halt and goes again
  const limN = o.acc * dt * (stop ? 0.35 : (o.grip ?? 1.6));
  if (stop) along = Math.min(along, 0);
  // the friction ellipse: braking and carving share the edges
  const e = Math.hypot(along / limA, across / limN);
  if (e > 1) { along /= e; across /= e; }
  dvx = along * tx - across * ty; dvy = along * ty + across * tx;
  return { dvx, dvy, stop };
}
