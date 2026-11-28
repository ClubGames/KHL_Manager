import type { DekeKind, PadState } from '../game/playRink';
import { getSettings, subscribeSettings, type Controls } from '../game/settings';

/**
 * The controls of a played match: keyboard, gamepad (the standard mapping of the Gamepad API: Xbox / PlayStation
 * pads in a browser) and the on-screen stick and buttons of a touch screen, merged into one PadState per frame.
 * Keys are read by their physical code (KeyW, not «w»), so the controls do not depend on the keyboard layout —
 * a Russian layout works the same.
 */
export type Action = 'shoot' | 'pass' | 'deke' | 'swap' | 'sprint' | 'faceoff' | 'mod' | 'lift' | 'pin' | 'push' | 'vision' | 'hustle' | 'r3' | 'fight' | 'o' | 'sq';
export type Command = 'pause' | 'pull' | 'change' | 'replay' | 'changeF' | 'changeD' | 'forecheck' | 'breakout' | 'timeout';

/** The default keys (the settings can rebind any of them: see applyControls). */
export const DEFAULT_KEYS: Readonly<Record<Action, readonly string[]>> = {
  shoot: ['Space', 'KeyJ'],
  pass: ['KeyK', 'KeyE'],
  deke: ['KeyL', 'KeyQ'],
  swap: ['KeyC', 'Tab'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  faceoff: ['KeyF'],
  // the gamepad's NHL buttons on the keyboard: the modifier (LB: block on defence; with the puck a saucer pass with
  // the pass key, special dekes with the deke key), a stick lift (A), a board pin (Y), a push check (the right stick
  // up), vision control (LT), hustle (L3) — right hand round J K L, left hand next to W A S D
  mod: ['KeyU', 'KeyZ'],
  lift: ['KeyI', 'KeyX'],
  pin: ['KeyO', 'KeyY'],
  push: ['KeyH', 'Digit1'],
  vision: ['KeyM', 'Digit3'],
  hustle: ['KeyN', 'Digit2'],
  // R3 (a kick of the puck off the skate / taking a pass on it; a hip check on defence), the fight (△ twice on a
  // pad), ○ and □ (the goal celebrations)
  r3: ['Semicolon', 'Digit5'],
  fight: ['Digit6'],
  o: ['Comma'],
  sq: ['Period'],
};
export const DEFAULT_COMMAND_KEYS: Readonly<Record<Command, readonly string[]>> = {
  pause: ['Escape', 'KeyP'],
  pull: ['KeyG'],
  change: ['KeyV'],
  replay: ['KeyR'],
  // the gamepad's d-pad calls (keys for the keyboard too)
  changeF: [],
  changeD: [],
  forecheck: ['KeyT'],
  breakout: ['KeyB'],
  timeout: ['Digit4'],
};
export type MoveDir = 'up' | 'down' | 'left' | 'right';
export const DEFAULT_MOVE_KEYS: Readonly<Record<MoveDir, readonly string[]>> = { up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'] };
const DIR: Record<MoveDir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
/** Anything a key can be bound to: a move, an action (held), a command (pressed). */
export type KeyBind = MoveDir | Action | Command;

/** The keys in use (the defaults with the player's own bindings over them; kept up to date with the settings). */
export const KEYS: Record<Action, string[]> = cloneMap(DEFAULT_KEYS);
export const COMMAND_KEYS: Record<Command, string[]> = cloneMap(DEFAULT_COMMAND_KEYS);
export const MOVE_KEYS: Record<MoveDir, string[]> = cloneMap(DEFAULT_MOVE_KEYS);
const MOVE: Record<string, [number, number]> = {};
/** Keys whose browser default (scrolling, focus moves) is suppressed during play. */
export const CAPTURED = new Set<string>();

function cloneMap<K extends string, V>(m: Readonly<Record<K, readonly V[]>>): Record<K, V[]> {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...(v as V[])]])) as Record<K, V[]>;
}

/**
 * Gamepad buttons (standard mapping), the NHL 25/26 scheme. Offence: left stick skates and aims, the right stick is
 * the skill stick (shots, dekes, stickhandling), RT pass (tap soft, hold harder; held while the right stick moves —
 * stickhandling without dekes), LB + right stick special dekes, LB + RT saucer pass, L3 hustle, d-pad right an
 * offensive line change. Defence: RT switch player, RB poke check, A stick lift, Y board pin, LB block shot, LT vision
 * control, right stick up a push check / down then up a shoulder check, d-pad up forecheck, d-pad down breakout, d-pad
 * left a defensive line change. With the puck: A held protects it, Y held on the boards plays it in the skates, LT
 * held keeps the facing (a tap: a spin-o-rama), LB + a flick of the left stick one-touch dekes, RB + the right stick
 * a dump-in (RB held a while: a flip), R3 kicks it off the skate. Defence: RB held a stick sweep, LB + RB a dive,
 * R3 a hip check. Y twice drops the gloves. After a goal A / B / X / Y, LT, RT and R3 pick the celebration.
 * RB / R3 / the right stick win a draw. Back pulls the goalie, Start pauses.
 */
export const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;
/** The pad's own action: RB — the poke check (with the puck the dump-in / flip with the right stick). */
export type PadAction = Action | 'poke';
export const DEFAULT_PAD_BUTTONS: Readonly<Record<PadAction, readonly number[]>> = { shoot: [], pass: [PAD.RT], deke: [], swap: [], sprint: [], faceoff: [PAD.RB, PAD.R3], mod: [PAD.LB], lift: [PAD.A], pin: [PAD.Y], push: [], vision: [PAD.LT], hustle: [PAD.L3], r3: [PAD.R3], fight: [], o: [PAD.B], sq: [PAD.X], poke: [PAD.RB] };
export const DEFAULT_PAD_COMMANDS: Readonly<Record<Command, readonly number[]>> = { pause: [PAD.START], pull: [PAD.BACK], change: [], replay: [], changeF: [PAD.RIGHT], changeD: [PAD.LEFT], forecheck: [PAD.UP], breakout: [PAD.DOWN], timeout: [] };
/** What a pad button can be bound to (the sticks keep their NHL roles; deke / switch / burst are the right stick, RT and L3 there). */
export type PadBind = Exclude<PadAction, 'deke' | 'swap' | 'sprint'> | Command;
/** The buttons in use (defaults + the player's bindings, kept up to date with the settings). */
export const PAD_BUTTONS: Record<PadAction, number[]> = cloneMap(DEFAULT_PAD_BUTTONS);
export const PAD_COMMANDS: Record<Command, number[]> = cloneMap(DEFAULT_PAD_COMMANDS);

/** The player's own bindings over the defaults (unknown names and broken values are skipped). */
export function effectiveControls(c: Controls | undefined) {
  const pick = <K extends string, V>(def: Readonly<Record<K, readonly V[]>>, over: Record<string, V[]> | undefined): Record<K, V[]> => {
    const out = cloneMap(def);
    if (over) for (const k of Object.keys(def) as K[]) if (Array.isArray(over[k])) out[k] = [...over[k]];
    return out;
  };
  return {
    keys: pick(DEFAULT_KEYS, c?.keys as Record<string, string[]>), commands: pick(DEFAULT_COMMAND_KEYS, c?.keys as Record<string, string[]>), move: pick(DEFAULT_MOVE_KEYS, c?.keys as Record<string, string[]>),
    pad: pick(DEFAULT_PAD_BUTTONS, c?.pad), padCommands: pick(DEFAULT_PAD_COMMANDS, c?.pad),
  };
}
/** Puts the bindings into the live maps every reader uses (the maps keep their identity). */
export function applyControls(c: Controls | undefined) {
  const e = effectiveControls(c);
  const fill = <K extends string, V>(dst: Record<K, V[]>, src: Record<K, V[]>) => { for (const k of Object.keys(src) as K[]) dst[k] = src[k]; };
  fill(KEYS, e.keys); fill(COMMAND_KEYS, e.commands); fill(MOVE_KEYS, e.move); fill(PAD_BUTTONS, e.pad); fill(PAD_COMMANDS, e.padCommands);
  for (const k of Object.keys(MOVE)) delete MOVE[k];
  for (const [d, list] of Object.entries(e.move) as [MoveDir, string[]][]) for (const code of list) MOVE[code] = DIR[d];
  CAPTURED.clear();
  for (const code of [...Object.keys(MOVE), ...Object.values(KEYS).flat()]) CAPTURED.add(code);
}
applyControls(getSettings().controls);
subscribeSettings(() => applyControls(getSettings().controls));

/** A key's name on the screen (by its physical code). */
export function keyLabel(code: string): string {
  const named: Record<string, string> = { Space: 'Пробел', ShiftLeft: 'Shift', ShiftRight: 'Правый Shift', ControlLeft: 'Ctrl', ControlRight: 'Правый Ctrl', AltLeft: 'Alt', AltRight: 'Правый Alt', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: '⌫', CapsLock: 'Caps Lock',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`', NumpadEnter: 'Num Enter', IntlBackslash: '\\' };
  if (named[code]) return named[code];
  let m = code.match(/^Key([A-Z])$/); if (m) return m[1];
  m = code.match(/^Digit(\d)$/); if (m) return m[1];
  m = code.match(/^Numpad(.+)$/); if (m) return `Num ${({ Add: '+', Subtract: '-', Multiply: '*', Divide: '/', Decimal: '.' } as Record<string, string>)[m[1]] ?? m[1]}`;
  return code;
}
const PAD_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L3', 'R3', 'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →', 'Home'];
/** A pad button's name (standard mapping, Xbox names). */
export const padLabel = (i: number) => PAD_NAMES[i] ?? `Кнопка ${i}`;
/** The keys of a binding as the help shows them («Пробел / J»); unbound — «—». */
export function bindKeys(b: KeyBind): string {
  const list = (MOVE_KEYS as Record<string, string[]>)[b] ?? (KEYS as Record<string, string[]>)[b] ?? (COMMAND_KEYS as Record<string, string[]>)[b] ?? [];
  // both Shifts (Ctrls, Alts) read as one
  const names = list.map(keyLabel);
  const shown = names.filter(n => !(n.startsWith('Правый ') && names.includes(n.slice(7))));
  return shown.length ? shown.join(' / ') : '—';
}
export function bindButtons(b: PadBind): string {
  const list = (PAD_BUTTONS as Record<string, number[]>)[b] ?? (PAD_COMMANDS as Record<string, number[]>)[b] ?? [];
  return list.length ? list.map(padLabel).join(' / ') : '—';
}

/** The touch screen: the sticks, the main buttons, and the extra ones (lb — the modifier, lift, pin, push, vision, hustle, r3, fight, ○, □). */
export interface TouchState { mx: number; my: number; sx: number; sy: number; shoot: boolean; pass: boolean; deke: boolean; swap: boolean; sprint: boolean; faceoff: boolean;
  lb: boolean; lift: boolean; pin: boolean; push: boolean; vision: boolean; hustle: boolean; r3: boolean; fight: boolean; o: boolean; sq: boolean;
  /** the deke button swiped: the kind and side of the deke (see PadState.dekeKind) */
  dekeKind?: DekeKind; dekeSide?: 1 | -1 }
export const emptyTouch = (): TouchState => ({ mx: 0, my: 0, sx: 0, sy: 0, shoot: false, pass: false, deke: false, swap: false, sprint: false, faceoff: false, lb: false, lift: false, pin: false, push: false, vision: false, hustle: false, r3: false, fight: false, o: false, sq: false });

export function keyboardPad(down: ReadonlySet<string>): PadState {
  let mx = 0, my = 0;
  for (const [code, [x, y]] of Object.entries(MOVE)) if (down.has(code)) { mx += x; my += y; }
  const m = Math.hypot(mx, my);
  if (m > 1) { mx /= m; my /= m; }
  const on = (a: Action) => KEYS[a].some(k => down.has(k));
  return { mx, my, shoot: on('shoot'), pass: on('pass'), deke: on('deke'), swap: on('swap'), sprint: on('sprint'), faceoff: on('faceoff'),
    lb: on('mod'), lift: on('lift'), pin: on('pin'), push: on('push'), vision: on('vision'), hustle: on('hustle'), r3: on('r3'), fight: on('fight'), o: on('o'), sq: on('sq') };
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
  const on = (a: PadAction) => PAD_BUTTONS[a].some(btn);
  const commands = new Set<Command>();
  for (const [c, list] of Object.entries(PAD_COMMANDS) as [Command, number[]][]) if (list.some(btn)) commands.add(c);
  return {
    pad: {
      mx, my, sx, sy, shoot: on('shoot'), pass: on('pass'), deke: false, swap: false, sprint: false,
      // a draw is also won with the right stick, as in NHL
      faceoff: on('faceoff') || Math.hypot(sx, sy) > 0.6,
      nhl: true, poke: on('poke'), push: on('push'), fight: on('fight'), lift: on('lift'), pin: on('pin'), lb: on('mod'), vision: on('vision'), hustle: on('hustle'), r3: on('r3'), o: on('o'), sq: on('sq'),
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
  // the extra buttons (every device has them now); the NHL scheme itself only when a gamepad is in use
  Object.assign(out, { poke: any('poke'), lift: any('lift'), pin: any('pin'), lb: any('lb'), vision: any('vision'), hustle: any('hustle'), push: any('push'), r3: any('r3'), fight: any('fight'), o: any('o'), sq: any('sq') });
  if (any('nhl')) out.nhl = true;
  const sw = pads.find(p => p.deke && p.dekeKind);
  if (sw) { out.dekeKind = sw.dekeKind; if (sw.dekeSide) out.dekeSide = sw.dekeSide; }
  return out;
}

/** Which way the thumb went across the deke button (px, screen y down): null — a tap (it hardly moved). */
export type SwipeDir = 'up' | 'down' | 'left' | 'right';
export const SWIPE_PX = 18;
export function swipeDir(dx: number, dy: number, min = SWIPE_PX): SwipeDir | null {
  if (Math.hypot(dx, dy) < min) return null;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
}
/** The deke a swipe of the touch button asks for: up a spin-o-rama, down between the legs, left / right a toe drag that way. */
export function swipeDeke(dir: SwipeDir | null): { kind?: DekeKind; side?: 1 | -1 } {
  if (dir === 'up') return { kind: 'spin' };
  if (dir === 'down') return { kind: 'between' };
  if (dir === 'left') return { kind: 'toe', side: -1 };
  if (dir === 'right') return { kind: 'toe', side: 1 };
  return {};
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

/* ---- Rebinding (the settings' «Управление» tab) ---- */

export const KEY_BINDS: KeyBind[] = ['up', 'down', 'left', 'right', 'shoot', 'pass', 'deke', 'sprint', 'swap', 'faceoff', 'mod', 'lift', 'pin', 'push', 'vision', 'hustle', 'r3', 'fight', 'o', 'sq', 'change', 'changeF', 'changeD', 'pull', 'timeout', 'forecheck', 'breakout', 'replay', 'pause'];
export const PAD_BINDS: PadBind[] = ['pass', 'poke', 'shoot', 'lift', 'pin', 'mod', 'vision', 'hustle', 'r3', 'push', 'fight', 'faceoff', 'o', 'sq', 'change', 'changeF', 'changeD', 'pull', 'timeout', 'forecheck', 'breakout', 'replay', 'pause'];
/** How many keys / buttons one binding holds. */
export const KEY_SLOTS = 2, PAD_SLOTS = 2;
/** Keys the rebinding does not take: Esc cancels the wait, Backspace / Delete clear the slot; the system keys stay the system's. */
export const RESERVED_KEYS = new Set(['Escape', 'Backspace', 'Delete', 'MetaLeft', 'MetaRight', 'ContextMenu', 'F5', 'F11', 'F12', 'PrintScreen']);

const DEFAULT_KEY_BINDS: Record<string, readonly string[]> = { ...DEFAULT_MOVE_KEYS, ...DEFAULT_KEYS, ...DEFAULT_COMMAND_KEYS };
const DEFAULT_PAD_BINDS: Record<string, readonly number[]> = { ...DEFAULT_PAD_BUTTONS, ...DEFAULT_PAD_COMMANDS };
const sameList = <V,>(a: readonly V[], b: readonly V[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Every key binding in effect (defaults + the player's). */
export function keyBindsOf(c: Controls | undefined): Record<KeyBind, string[]> {
  const out = {} as Record<KeyBind, string[]>;
  for (const b of KEY_BINDS) out[b] = [...(c?.keys?.[b] ?? DEFAULT_KEY_BINDS[b] ?? [])];
  return out;
}
export function padBindsOf(c: Controls | undefined): Record<PadBind, number[]> {
  const out = {} as Record<PadBind, number[]>;
  for (const b of PAD_BINDS) out[b] = [...(c?.pad?.[b] ?? DEFAULT_PAD_BINDS[b] ?? [])];
  return out;
}
/** Only what differs from the defaults is kept. */
function storeKeys(all: Record<KeyBind, string[]>, pad: Controls['pad']): Controls {
  const keys: Record<string, string[]> = {};
  for (const b of KEY_BINDS) if (!sameList(all[b], DEFAULT_KEY_BINDS[b] ?? [])) keys[b] = all[b];
  return { ...(Object.keys(keys).length ? { keys } : {}), ...(pad && Object.keys(pad).length ? { pad } : {}) };
}
function storePad(all: Record<PadBind, number[]>, keys: Controls['keys']): Controls {
  const pad: Record<string, number[]> = {};
  for (const b of PAD_BINDS) if (!sameList(all[b], DEFAULT_PAD_BINDS[b] ?? [])) pad[b] = all[b];
  return { ...(keys && Object.keys(keys).length ? { keys } : {}), ...(Object.keys(pad).length ? { pad } : {}) };
}

/**
 * A key into a binding's slot (null: the slot cleared). A key does one thing: taken from any other binding it held
 * (those are returned, for the notice).
 */
export function bindKey(c: Controls | undefined, bind: KeyBind, slot: number, code: string | null): { controls: Controls; moved: KeyBind[] } {
  const all = keyBindsOf(c);
  const moved: KeyBind[] = [];
  if (code) for (const b of KEY_BINDS) {
    const i = all[b].indexOf(code);
    if (i < 0 || (b === bind && i === slot)) continue;
    all[b] = all[b].filter(x => x !== code);
    if (b !== bind) moved.push(b);
  }
  const list = [...all[bind]];
  if (code) { if (slot < list.length) list[slot] = code; else list.push(code); }
  else if (slot < list.length) list.splice(slot, 1);
  all[bind] = list.slice(0, KEY_SLOTS);
  return { controls: storeKeys(all, c?.pad), moved };
}
/**
 * A pad button into a binding's slot (null: cleared). A button may serve several bindings (by default RB both pokes
 * and wins the draw); the others on it are returned, for the notice.
 */
export function bindButton(c: Controls | undefined, bind: PadBind, slot: number, button: number | null): { controls: Controls; shared: PadBind[] } {
  const all = padBindsOf(c);
  const list = [...all[bind]];
  if (button === null) { if (slot < list.length) list.splice(slot, 1); }
  else {
    const j = list.indexOf(button);
    if (j >= 0 && j !== slot) list.splice(j, 1);
    if (slot < list.length) list[slot] = button; else list.push(button);
  }
  all[bind] = [...new Set(list)].slice(0, PAD_SLOTS);
  const shared = button === null ? [] : PAD_BINDS.filter(b => b !== bind && all[b].includes(button));
  return { controls: storePad(all, c?.keys), shared };
}
/** The keyboard or the pad back to its defaults (the other device kept). */
export function resetControls(c: Controls | undefined, device: 'keyboard' | 'gamepad'): Controls {
  return device === 'keyboard' ? (c?.pad ? { pad: c.pad } : {}) : (c?.keys ? { keys: c.keys } : {});
}
