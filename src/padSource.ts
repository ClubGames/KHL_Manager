// The game controllers the browser / Android WebView reports, cleaned up before anything reads them.
//
// Phones list built-in input devices as "gamepads" (a fingerprint sensor `uinput-fpc`, `gpio-keys`, volume keys…),
// and some of them report an axis or a trigger stuck at full travel. Read raw, such a device scrolled the menu by itself
// and pressed RT forever. So: devices that are not game controllers are skipped, and a control that has never been
// seen at rest since the pad appeared is read as idle until it is released once (a real stick or trigger starts at rest).

export type PadLike = { id?: string; index?: number; axes: readonly number[]; buttons: readonly { pressed: boolean; value: number }[] };

/** Input devices of phones and tablets that the WebView exposes as gamepads but that are not game controllers. */
const NOT_A_PAD = /uinput|gpio|fpc|fingerprint|goodix|silead|egistec|sensor|keypad|power.?key|volume|headset|hall|touch(screen|pad)?\b|pen\b|stylus/i;

interface Calib { id: string; axisRest: boolean[]; btnRest: boolean[] }
const calib = new Map<number, Calib>();

const AXIS_REST = 0.3, BTN_REST = 0.15;

/** Whether this device looks like a game controller at all. */
export function isGamepadDevice(p: PadLike | null | undefined): boolean {
  if (!p) return false;
  if (p.id && NOT_A_PAD.test(p.id)) return false;
  // a controller has a stick (2 axes) or a D-pad, and at least the four face buttons
  return (p.buttons?.length ?? 0) >= 4 && ((p.axes?.length ?? 0) >= 2 || (p.buttons?.length ?? 0) >= 16);
}

/** A pad with every control that has not yet been at rest read as idle. */
export function calibrated(p: PadLike, slot = p.index ?? 0): PadLike {
  const id = p.id ?? '';
  let c = calib.get(slot);
  if (!c || c.id !== id) { c = { id, axisRest: [], btnRest: [] }; calib.set(slot, c); }
  const axes = p.axes.map((v, i) => {
    if (!c.axisRest[i] && Math.abs(v || 0) < AXIS_REST) c.axisRest[i] = true;
    return c.axisRest[i] && Number.isFinite(v) ? v : 0;
  });
  const buttons = p.buttons.map((b, i) => {
    const v = b ? (b.pressed ? Math.max(b.value, 1) : b.value || 0) : 0;
    if (!c.btnRest[i] && v < BTN_REST) c.btnRest[i] = true;
    return c.btnRest[i] && b ? { pressed: !!b.pressed, value: b.value || 0 } : { pressed: false, value: 0 };
  });
  return { id, index: slot, axes, buttons };
}

/** `navigator.getGamepads()` that never throws (some WebViews throw without a permission / in an insecure frame). */
export function rawPads(): readonly (PadLike | null)[] {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return [];
    return Array.from(navigator.getGamepads() ?? [], (p) => (p ? (p as unknown as PadLike) : null));
  } catch {
    return [];
  }
}

/** The connected game controllers, filtered and calibrated (what the menus and the match read). */
export function pads(source: readonly (PadLike | null)[] = rawPads()): PadLike[] {
  const out: PadLike[] = [];
  source.forEach((p, i) => {
    if (!p) return;
    if (!isGamepadDevice(p)) { calib.delete(p.index ?? i); return; }
    out.push(calibrated(p, p.index ?? i));
  });
  return out;
}

/** Forget the calibration (tests). */
export function resetPadCalibration() { calib.clear(); }
