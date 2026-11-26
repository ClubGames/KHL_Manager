import type { PadState } from '../game/playRink';

/**
 * The controls of a played match: keyboard, gamepad (the standard mapping of the Gamepad API: Xbox / PlayStation
 * pads in a browser) and the on-screen stick and buttons of a touch screen, merged into one PadState per frame.
 * Keys are read by their physical code (KeyW, not «w»), so the controls do not depend on the keyboard layout —
 * a Russian layout works the same.
 */
export type Action = 'shoot' | 'pass' | 'deke' | 'swap' | 'sprint' | 'faceoff';
export type Command = 'pause' | 'pull' | 'change' | 'replay';

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
};
const MOVE: Record<string, [number, number]> = {
  KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0],
};
/** Keys whose browser default (scrolling, focus moves) is suppressed during play. */
export const CAPTURED = new Set([...Object.keys(MOVE), ...Object.values(KEYS).flat()]);

/** Gamepad buttons (standard mapping): A pass · B / RT shoot · X deke · LB switch · LT / RB / L3 sprint · RB / R3 faceoff (at a draw) · Y line change · Back pull goalie · Start pause. */
export const PAD_BUTTONS: Record<Action, number[]> = { shoot: [1, 7], pass: [0], deke: [2], swap: [4], sprint: [5, 6, 10], faceoff: [5, 11] };
export const PAD_COMMANDS: Partial<Record<Command, number[]>> = { pause: [9], change: [3], pull: [8] };

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
  let [mx, my] = deadZone(gp.axes[0] ?? 0, gp.axes[1] ?? 0);
  const [sx, sy] = deadZone(gp.axes[2] ?? 0, gp.axes[3] ?? 0);
  // the d-pad steers as well
  const btn = (i: number) => !!gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5);
  if (btn(12)) my = -1; if (btn(13)) my = 1; if (btn(14)) mx = -1; if (btn(15)) mx = 1;
  const on = (a: Action) => PAD_BUTTONS[a].some(btn);
  const commands = new Set<Command>();
  for (const [c, list] of Object.entries(PAD_COMMANDS) as [Command, number[]][]) if (list.some(btn)) commands.add(c);
  return { pad: { mx, my, sx, sy, shoot: on('shoot'), pass: on('pass'), deke: on('deke'), swap: on('swap'), sprint: on('sprint'), faceoff: on('faceoff') }, commands, connected: true };
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
  return { mx, my, sx, sy, shoot: any('shoot'), pass: any('pass'), deke: any('deke'), swap: any('swap'), sprint: any('sprint'), faceoff: any('faceoff') };
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
