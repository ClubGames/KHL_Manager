/**
 * Where the phone controls go (TouchControls in the match, the preview in Настройки → Управление → «Сенсорный
 * экран»): the right thumb's cluster laid out from its corner — the shot the biggest, in the corner under the thumb;
 * pass, deke and burst in an arc above it; the situation's extras in an outer arc — scaled by the size setting, moved
 * in from the corner by the shift, and on the left for a left-handed player.
 * All values are px from the cluster's corner (right / bottom, or left / bottom when mirrored).
 */
import type { Settings } from '../game/settings';

export type TouchOpts = Pick<Settings, 'touchSize' | 'touchShiftX' | 'touchShiftY' | 'touchLefty'>;
/** A round button: its offset from the corner (to its own edge) and its diameter. */
export type Spot = { x: number; y: number; size: number };

export type TouchLayout = {
  /** the side the buttons sit on ('right' unless mirrored) */
  side: 'left' | 'right';
  shoot: Spot; pass: Spot; deke: Spot; sprint: Spot;
  /** the outer arc's buttons, i of n */
  ring: (i: number, n: number) => Spot;
  /** the draw's wide button */
  faceoff: { x: number; y: number; w: number; h: number };
  /** how far from the buttons' edge the skill stick's zone ends (it stays clear of the cluster) */
  skillGap: number;
};

/** The top of the screen kept clear of the buttons (the score bar and the view toggles), px. */
export const TOUCH_TOP = 104;

/** How far up the cluster can go on a screen of height `screenH` at size `k` before it reaches the score bar, px. */
export function maxShiftY(k: number, screenH: number) {
  return Math.max(0, Math.floor(screenH - TOUCH_TOP - (65 * k + Math.max(180, 155 * k + 6) + 8)));
}

/**
 * The layout; with `screenH` (the screen's height, px) the cluster is not lifted into the score bar: the upward shift
 * gives way first.
 */
export function touchLayout(o: TouchOpts, screenH?: number): TouchLayout {
  const k = o.touchSize, dx = o.touchShiftX;
  // the outer arc clears the inner one at any size (a bigger cluster does not grow the arc as fast as the buttons)
  const R = Math.max(180, 155 * k + 6);
  const dy = screenH === undefined ? o.touchShiftY : Math.min(o.touchShiftY, maxShiftY(k, screenH));
  /** A button of `size` on the arc of radius r round the shot button's centre, at angle a (π: inward of it, π/2: above). */
  const arc = (a: number, r: number, size: number): Spot => ({
    x: Math.max(2, 40 * k - Math.cos(a) * r - size * k / 2) + dx,
    y: 40 * k + Math.sin(a) * r - size * k / 2 + dy,
    size: size * k,
  });
  return {
    side: o.touchLefty ? 'left' : 'right',
    shoot: { x: dx, y: dy, size: 80 * k },
    pass: arc(Math.PI, 100 * k, 64), deke: arc(Math.PI * .75, 100 * k, 54), sprint: arc(Math.PI * .5, 100 * k, 54),
    ring: (i, n) => arc(n > 1 ? Math.PI + (Math.PI * .5 - Math.PI) * (i / (n - 1)) : Math.PI * .75, R, 50),
    faceoff: { x: 232 * k + dx, y: 10 * k + dy, w: 136 * k, h: 64 * k },
    skillGap: 250 * k + dx,
  };
}

/** The buttons' look by the see-through setting (on top of the standard classes). */
export const TOUCH_ALPHA: Record<Settings['touchAlpha'], { cls: string; opacity: number }> = {
  faint: { cls: '', opacity: .45 },
  normal: { cls: '', opacity: 1 },
  solid: { cls: '!bg-black/50 !border-white/60', opacity: 1 },
};

/** A short buzz on a press, where the phone can and the setting allows. */
export function touchBuzz(on: boolean) {
  if (!on) return;
  try { (navigator as Navigator & { vibrate?: (ms: number) => boolean }).vibrate?.(12); } catch { /* not allowed here */ }
}
