import type { PadState } from '../game/playRink';

/**
 * The controls of a played match: keyboard, gamepad (the standard mapping of the Gamepad API: Xbox / PlayStation
 * pads in a browser) and the on-screen stick and buttons of a touch screen, merged into one PadState per frame.
 * Keys are read by their physical code (KeyW, not «w»), so the controls do not depend on the keyboard layout —
 * a Russian layout works the same.
 */
export type Action = 'shoot' | 'pass' | 'deke' | 'swap' | 'sprint' | 'faceoff';
export type Command = 'pause' | 'pull' | 'change' | 'replay' | 'changeF' | 'changeD' | 'forecheck' | 'breakout';

export const KEYS: Record<Action, string[]> = {
  shoot: ['Space', 'KeyJ'],
  pass: ['KeyK', 'KeyE'],
  deke: ['KeyL', 'KeyQ'],
  swap: ['KeyC', 'Tab'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  faceoff: ['KeyF'],
};
export const COMMAND_KEYS: Record<Command, string[]> = {
  pause: ['Escape', 'KeyP'],
  pull: ['KeyG'],
  change: ['KeyV'],
  replay: ['KeyR'],
  // the gamepad's d-pad calls (keys for the keyboard too)
  changeF: [],
  changeD: [],
  forecheck: ['KeyT'],
  breakout: ['KeyB'],
};
const MOVE: Record<string, [number, number]> = {
  KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0],
};
/** Keys whose browser default (scrolling, focus moves) is suppressed during play. */
export const CAPTURED = new Set([...Object.keys(MOVE), ...Object.values(KEYS).flat()]);

/**
 * Gamepad buttons (standard mapping), the NHL 25/26 scheme. Offence: left stick skates and aims, the right stick is
 * the skill stick (shots, dekes, stickhandling), RT pass (tap soft, hold harder; held while the right stick moves —
 * stickhandling without dekes), LB + right stick special dekes, LB + RT saucer pass, L3 hustle, d-pad right an
 * offensive line change. Defence: RT switch player, RB poke check, A stick lift, Y board pin, LB block shot, LT vision
 * control, right stick up a push check / down then up a shoulder check, d-pad up forecheck, d-pad down breakout, d-pad
 * left a defensive line change. B shoots on offence (an extra, not in the NHL list). RB / R3 / the right stick win a
 * draw. Back pulls the goalie, Start pauses.
 */
export const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;
export const PAD_BUTTONS: Record<Action, number[]> = { shoot: [PAD.B], pass: [PAD.RT], deke: [], swap: [], sprint: [], faceoff: [PAD.RB, PAD.R3] };
export const PAD_COMMANDS: Partial<Record<Command, number[]>> = { pause: [PAD.START], pull: [PAD.BACK], changeF: [PAD.RIGHT], changeD: [PAD.LEFT], forecheck: [PAD.UP], breakout: [PAD.DOWN] };

export interface TouchState { mx: number; my: number; sx: number; sy: number; shoot: boolean; pass: boolean; deke: boolean; swap: boolean; sprint: boolean; faceoff: boolean }
export const emptyTouch = (): TouchState => ({ mx: 0, my: 0, sx: 0, sy: 0, shoot: false, pass: false, deke: false, swap: false, sprint: false, faceoff: false });

export function keyboardPad(down: ReadonlySet<string>): PadState {
  let mx = 0, my = 0;
  for (const [code, [x, y]] of Object.entries(MOVE)) if (down.has(code)) { mx += x; my += y; }
  const m = Math.hypot(mx, my);
  if (m > 1) { mx /= m; my /= m; }
  const on = (a: Action) => KEYS[a].some(k => down.has(k));
  return { mx, my, shoot: on('shoot'), pass: on('pass'), deke: on('deke'), swap: on('swap'), sprint: on('sprint'), faceoff: on('faceoff') };
}

type PadLike = { axes: readonly number[]; buttons: readonly { pressed: boolean; value: number }[] };
/** The first connected gamepad's state: the left stick skates, the right stick is the skill stick (radial dead zones). */
export function gamepadPad(pads: readonly (PadLike | null)[] | null | undefined): { pad: PadState; commands: Set<Command>; connected: boolean } {
  const gp = pads ? pads.find((p): p is PadLike => !!p) : undefined;
  const none = { mx: 0, my: 0, shoot: false, pass: false, deke: false, swap: false, sprint: false };
  if (!gp) return { pad: none, commands: new Set(), connected: false };
  const [mx, my] = deadZone(gp.axes[0] ?? 0, gp.axes[1] ?? 0);
  const [sx, sy] = deadZone(gp.axes[2] ?? 0, gp.axes[3] ?? 0);
  // (the d-pad is the line changes and the tactics in the NHL scheme, it does not skate)
  const btn = (i: number) => !!gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5);
  const on = (a: Action) => PAD_BUTTONS[a].some(btn);
  const commands = new Set<Command>();
  for (const [c, list] of Object.entries(PAD_COMMANDS) as [Command, number[]][]) if (list.some(btn)) commands.add(c);
  return {
    pad: {
      mx, my, sx, sy, shoot: on('shoot'), pass: on('pass'), deke: false, swap: false, sprint: false,
      // a draw is also won with the right stick, as in NHL
      faceoff: on('faceoff') || Math.hypot(sx, sy) > 0.6,
      nhl: true, poke: btn(PAD.RB), lift: btn(PAD.A), pin: btn(PAD.Y), lb: btn(PAD.LB), vision: btn(PAD.LT), hustle: btn(PAD.L3),
    },
    commands, connected: true,
  };
}

function deadZone(x: number, y: number): [number, number] {
  const m = Math.hypot(x, y);
  if (m < 0.18) return [0, 0];
  const k = Math.min(1, (m - 0.18) / 0.82) / m;
  return [x * k, y * k];
}

/** Keyboard + gamepad + touch: sticks add up (capped at full tilt), buttons are held if any source holds them. */
export function mergePads(...pads: PadState[]): PadState {
  let mx = 0, my = 0, sx = 0, sy = 0;
  for (const p of pads) { mx += p.mx; my += p.my; sx += p.sx ?? 0; sy += p.sy ?? 0; }
  const m = Math.hypot(mx, my), sm = Math.hypot(sx, sy);
  if (m > 1) { mx /= m; my /= m; }
  if (sm > 1) { sx /= sm; sy /= sm; }
  const any = (k: keyof PadState) => pads.some(p => !!p[k]);
  const out: PadState = { mx, my, sx, sy, shoot: any('shoot'), pass: any('pass'), deke: any('deke'), swap: any('swap'), sprint: any('sprint'), faceoff: any('faceoff') };
  // the gamepad's NHL buttons (only a gamepad sets them)
  if (any('nhl')) Object.assign(out, { nhl: true, poke: any('poke'), lift: any('lift'), pin: any('pin'), lb: any('lb'), vision: any('vision'), hustle: any('hustle') });
  return out;
}

/** The touch stick: the thumb's offset from where it touched down, as a vector of length ≤ 1 (radius in px). */
export function stickVector(dx: number, dy: number, radius: number): { x: number; y: number } {
  const d = Math.hypot(dx, dy);
  if (d < radius * 0.12) return { x: 0, y: 0 };
  const k = Math.min(1, d / radius) / d;
  return { x: dx * k, y: dy * k };
}

/** What the manager plays on: a connected gamepad wins, then a touch screen, then the keyboard. */
export type InputDevice = 'gamepad' | 'touch' | 'keyboard';
export function detectDevice(padConnected: boolean, touchUI: boolean): InputDevice {
  return padConnected ? 'gamepad' : touchUI ? 'touch' : 'keyboard';
}
/** Whether any gamepad is connected (browsers list one only after a button press on it). */
export function anyGamepad(pads: readonly (PadLike | null)[] | null | undefined): boolean {
  return !!pads && pads.some(p => !!p);
}

/**
 * The mouse on a PC: the cursor aims (the played match turns it into a point on the ice), the left button shoots
 * (held — harder) or, dragged, is the skill stick (down and up — a slap shot, a flick up — a wrist shot, sideways
 * — a deke), the right button passes toward the cursor, the middle (or the «back» side) button dekes, the
 * «forward» side button switches the player. A left press waits a moment to see whether it becomes a drag.
 */
export interface MouseState { x: number; y: number; at: number; lmb: boolean; rmb: boolean; mid: boolean; side: boolean; fwd: boolean; mode: 'none' | 'pending' | 'shot' | 'stick'; ox: number; oy: number; downAt: number; sx: number; sy: number; tapUntil: number }
export const newMouse = (): MouseState => ({ x: 0, y: 0, at: -1, lmb: false, rmb: false, mid: false, side: false, fwd: false, mode: 'none', ox: 0, oy: 0, downAt: 0, sx: 0, sy: 0, tapUntil: 0 });
/** A press longer than this without a drag is a shot; a drag beyond DRAG_PX first is the skill stick. */
const MOUSE_WAIT = 90, DRAG_PX = 12, MOUSE_R = 80;
export function mouseDown(m: MouseState, button: number, x: number, y: number, now: number) {
  m.x = x; m.y = y; m.at = now;
  if (button === 0) { m.lmb = true; m.mode = 'pending'; m.ox = x; m.oy = y; m.downAt = now; m.sx = m.sy = 0; }
  else if (button === 2) m.rmb = true;
  else if (button === 1) m.mid = true;
  else if (button === 3) m.side = true;
  else if (button === 4) m.fwd = true;
}
export function mouseMove(m: MouseState, x: number, y: number, now: number) {
  m.x = x; m.y = y; m.at = now;
  if (!m.lmb) return;
  const dx = x - m.ox, dy = y - m.oy;
  if (m.mode === 'pending' && Math.hypot(dx, dy) > DRAG_PX) m.mode = 'stick';
  if (m.mode === 'stick') { const v = stickVector(dx, dy, MOUSE_R); m.sx = v.x; m.sy = v.y; }
}
export function mouseUp(m: MouseState, button: number, now: number) {
  if (button === 0) {
    // a quick click: still a shot (held a couple of frames so the rink sees the press and the release)
    if (m.mode === 'pending') m.tapUntil = now + 50;
    m.lmb = false; m.mode = 'none'; m.sx = m.sy = 0;
  } else if (button === 2) m.rmb = false;
  else if (button === 1) m.mid = false;
  else if (button === 3) m.side = false;
  else if (button === 4) m.fwd = false;
}
export function mousePad(m: MouseState, now: number): PadState {
  if (m.lmb && m.mode === 'pending' && now - m.downAt > MOUSE_WAIT) m.mode = 'shot';
  const shoot = (m.lmb && m.mode === 'shot') || now < m.tapUntil;
  return { mx: 0, my: 0, sx: m.sx, sy: m.sy, shoot, pass: m.rmb, deke: m.mid || m.side, swap: m.fwd, sprint: false };
}
