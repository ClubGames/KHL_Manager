/**
 * The whole app with a gamepad (the standard mapping of the Gamepad API: Xbox / PlayStation pads in a browser,
 * the Windows and Android apps): the d-pad or the left stick moves the focus to the nearest button / field in that
 * direction on the screen, A presses it, B goes back (closes the top window — what Esc does), Start too (and it
 * pauses / resumes a played match), LB / RB switch the main sections, LT / RT and the right stick scroll. The
 * focused element gets a clear ring while the pad is in use; the mouse or a touch hides it again.
 *
 * Inside a played match the pad skates the player: the match suspends this (suspendPadNav) while play runs and
 * gives it back on the pause menu, the intermission and the final screen.
 */

type PadLike = { axes: readonly number[]; buttons: readonly { pressed: boolean; value: number }[] };
type Dir = 'up' | 'down' | 'left' | 'right';

const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;
const FOCUSABLE = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"]), [role="button"], [role="tab"], [role="radio"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"]';
const SCOPES = '[role="dialog"], [aria-modal="true"], div.fixed.inset-0, [data-pad-scope]';
const REPEAT_FIRST = 380, REPEAT_NEXT = 110;

let suspended = false;
let started = false;

/** The played match takes the pad for the game (true) and gives it back (false). */
export function suspendPadNav(on: boolean) { suspended = on; }

const visible = (el: Element): boolean => {
  const h = el as HTMLElement;
  if (h.closest('[inert], [aria-hidden="true"], [data-modal-closing]')) return false;
  if ((h as HTMLButtonElement).disabled) return false;
  const r = h.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = getComputedStyle(h);
  return st.visibility !== 'hidden' && st.display !== 'none' && st.pointerEvents !== 'none' && Number(st.opacity) > 0.05;
};

/** The topmost window (a modal, a sheet over the match): the focus stays inside it. */
function scope(): HTMLElement {
  const cands = [...document.querySelectorAll<HTMLElement>(SCOPES)].filter((el) => visible(el) && el.querySelector(FOCUSABLE));
  let best: HTMLElement | null = null;
  for (const el of cands) {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(window.innerHeight - 1, Math.max(0, r.top + Math.min(r.height / 2, 40))));
    if (!top || !el.contains(top)) continue;
    // the innermost one on top wins (a sheet inside the match screen, a window over a window)
    if (!best || best.contains(el) || (!el.contains(best) && (best.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))) best = el;
  }
  return best ?? document.body;
}

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => visible(el) && !el.closest('[data-pad-skip]'));
}

const center = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

/** The nearest element in a direction from the current one (in screen terms, rows and columns preferred). */
function nearest(from: HTMLElement, dir: Dir, list: HTMLElement[]): HTMLElement | null {
  const a = from.getBoundingClientRect(), ca = center(a);
  let best: HTMLElement | null = null, bestScore = Infinity;
  for (const el of list) {
    if (el === from || el.contains(from) || from.contains(el)) continue;
    const b = el.getBoundingClientRect(), cb = center(b);
    // the gap across the direction (0 when the two overlap in that column / row)
    const gapX = b.right >= a.left && b.left <= a.right ? 0 : Math.min(Math.abs(b.left - a.right), Math.abs(a.left - b.right));
    const gapY = b.bottom >= a.top && b.top <= a.bottom ? 0 : Math.min(Math.abs(b.top - a.bottom), Math.abs(a.top - b.bottom));
    let main: number, cross: number;
    if (dir === 'down') { if (cb.y <= ca.y + 1) continue; main = b.top - a.bottom; cross = gapX; }
    else if (dir === 'up') { if (cb.y >= ca.y - 1) continue; main = a.top - b.bottom; cross = gapX; }
    else if (dir === 'right') { if (cb.x <= ca.x + 1) continue; main = b.left - a.right; cross = gapY; }
    else { if (cb.x >= ca.x - 1) continue; main = a.left - b.right; cross = gapY; }
    // mostly beyond the current one in that direction (not a neighbour of a slightly different width)
    if (main < -(dir === 'up' || dir === 'down' ? Math.min(a.height, b.height) : Math.min(a.width, b.width)) / 2) continue;
    const score = Math.max(-8, main) + cross * 3 + (dir === 'up' || dir === 'down' ? Math.abs(cb.x - ca.x) : Math.abs(cb.y - ca.y)) * 0.05;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}

/** The first element to focus in a window: its primary button if it shows one, else the top-left one in view. */
function first(list: HTMLElement[]): HTMLElement | null {
  const inView = list.filter((el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight; });
  const pool = inView.length ? inView : list;
  return pool.find((el) => el.matches('[data-play-start], [data-play-resume], [data-play-next], [data-play-finish], [autofocus]')) ?? [...pool].sort((p, q) => { const a = p.getBoundingClientRect(), b = q.getBoundingClientRect(); return Math.abs(a.top - b.top) > 8 ? a.top - b.top : a.left - b.left; })[0] ?? null;
}

function setFocus(el: HTMLElement) {
  document.documentElement.classList.add('pad-nav');
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function current(root: HTMLElement): HTMLElement | null {
  const a = document.activeElement as HTMLElement | null;
  return a && a !== document.body && root.contains(a) && visible(a) ? a : null;
}

/** A select or a range field takes left / right itself (the value steps). */
function stepValue(el: HTMLElement, dir: Dir): boolean {
  if (dir !== 'left' && dir !== 'right') return false;
  const d = dir === 'right' ? 1 : -1;
  if (el instanceof HTMLSelectElement) {
    const i = Math.max(0, Math.min(el.options.length - 1, el.selectedIndex + d));
    if (i === el.selectedIndex) return true;
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    set?.call(el, el.options[i].value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (el instanceof HTMLInputElement && el.type === 'range') {
    const step = Number(el.step) || 1, v = Math.max(Number(el.min || 0), Math.min(Number(el.max || 100), Number(el.value) + d * step));
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    set?.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}

function move(dir: Dir) {
  const root = scope();
  const list = focusables(root);
  if (!list.length) return;
  const cur = current(root);
  if (!cur) { const f = first(list); if (f) setFocus(f); return; }
  if (stepValue(cur, dir)) return;
  const next = nearest(cur, dir, list);
  if (next) setFocus(next);
  else if (dir === 'up' || dir === 'down') scrollBy(dir === 'down' ? 160 : -160);
}

function press() {
  const root = scope();
  const cur = current(root);
  if (!cur) { const f = first(focusables(root)); if (f) setFocus(f); return; }
  document.documentElement.classList.add('pad-nav');
  if (cur instanceof HTMLInputElement && /^(text|search|number|email|password|tel|url)$/.test(cur.type)) { cur.focus(); cur.select?.(); return; }
  if (cur instanceof HTMLTextAreaElement) { cur.focus(); return; }
  cur.click();
}

function key(code: 'Escape') {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', { key: code, code, bubbles: true, cancelable: true }));
  target.dispatchEvent(new KeyboardEvent('keyup', { key: code, code, bubbles: true, cancelable: true }));
}

/** The scrolling box of the focused element (or the page). */
function scroller(): HTMLElement | null {
  let el = (document.activeElement as HTMLElement | null) ?? null;
  if (!el || el === document.body) el = scope();
  for (let e: HTMLElement | null = el; e && e !== document.body; e = e.parentElement) {
    const st = getComputedStyle(e);
    if (/(auto|scroll)/.test(st.overflowY) && e.scrollHeight > e.clientHeight + 2) return e;
  }
  return null;
}
function scrollBy(dy: number) {
  const s = scroller();
  if (s) s.scrollBy({ top: dy }); else window.scrollBy({ top: dy });
}

/** LB / RB: the previous / next main section (the side rail, the bottom bar or the menu, whichever is shown). */
function section(d: 1 | -1) {
  const nav = [...document.querySelectorAll<HTMLElement>('[data-pad-sections]')].find(visible);
  if (!nav || scope() !== document.body) return;
  const items = [...nav.querySelectorAll<HTMLElement>('[data-nav-view]')].filter(visible);
  if (!items.length) return;
  let i = items.findIndex((el) => el.getAttribute('aria-current') === 'page');
  if (i < 0) i = items.findIndex((el) => el === document.activeElement);
  const next = items[(i + d + items.length) % items.length];
  next.click();
  setFocus(next);
}

export function initGamepadNav() {
  if (started || typeof window === 'undefined' || typeof navigator === 'undefined' || !navigator.getGamepads) return;
  started = true;
  const prev: boolean[] = [];
  const hold: Partial<Record<Dir, number>> = {};
  let raf = 0, running = false;
  // the mouse or a finger takes over: no focus ring
  const off = () => document.documentElement.classList.remove('pad-nav');
  window.addEventListener('pointerdown', off, true);
  window.addEventListener('mousemove', (e) => { if (Math.abs(e.movementX) + Math.abs(e.movementY) > 3) off(); }, true);

  const frame = (now: number) => {
    const gp = [...navigator.getGamepads()].find((p): p is Gamepad => !!p) as PadLike | undefined;
    if (!gp) { running = false; prev.length = 0; return; }
    const btn = (i: number) => !!gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5);
    const down = gp.buttons.map((_, i) => btn(i));
    const edge = (i: number) => down[i] && !prev[i];
    if (!suspended && !document.hidden) {
      const ax = gp.axes[0] ?? 0, ay = gp.axes[1] ?? 0;
      const dirs: Record<Dir, boolean> = {
        up: btn(BTN.UP) || ay < -0.6, down: btn(BTN.DOWN) || ay > 0.6, left: btn(BTN.LEFT) || ax < -0.6, right: btn(BTN.RIGHT) || ax > 0.6,
      };
      for (const d of Object.keys(dirs) as Dir[]) {
        if (!dirs[d]) { delete hold[d]; continue; }
        const t = hold[d];
        if (t === undefined) { hold[d] = now + REPEAT_FIRST; move(d); }
        else if (now >= t) { hold[d] = now + REPEAT_NEXT; move(d); }
      }
      if (edge(BTN.A)) press();
      if (edge(BTN.B) || edge(BTN.START)) key('Escape');
      if (edge(BTN.LB)) section(-1);
      if (edge(BTN.RB)) section(1);
      // scrolling: the triggers by pages, the right stick smoothly
      const lt = gp.buttons[BTN.LT]?.value ?? 0, rt = gp.buttons[BTN.RT]?.value ?? 0, ry = gp.axes[3] ?? 0;
      const sp = (Math.abs(ry) > 0.25 ? ry * 18 : 0) + (rt > 0.2 ? rt * 22 : 0) - (lt > 0.2 ? lt * 22 : 0);
      if (sp) scrollBy(sp);
    } else for (const d of Object.keys(hold) as Dir[]) delete hold[d];
    down.forEach((v, i) => { prev[i] = v; });
    raf = requestAnimationFrame(frame);
  };
  const start = () => { if (running) return; running = true; cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); };
  window.addEventListener('gamepadconnected', start);
  // some browsers list a pad only after a button press and fire no event for an already connected one
  setInterval(() => { if (!running && [...navigator.getGamepads()].some((p) => !!p)) start(); }, 1000);
  start();
}
