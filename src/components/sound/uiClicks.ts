// The interface's clicks: a soft synthesized tick on the buttons, tabs, links and switches of the menus and the
// windows — a little higher for a switch turned on, lower for one turned off. The match controls stay silent: the
// on-screen stick and buttons, the bench calls on the rink, anything on the played match's screen outside its menus.
import { getSettings } from '../../game/settings';
import { audio } from './engine';

export type ClickKind = 'tap' | 'on' | 'off' | 'tab';

/** The control a click lands on, and its kind; null — no sound (not a control, disabled, a match control). */
export function clickTarget(el: Element | null): { el: Element; kind: ClickKind } | null {
  const c = el?.closest('button, a[href], [role="tab"], [role="radio"], [role="switch"], [role="menuitem"], [role="option"], summary, select, input[type="checkbox"], input[type="radio"]');
  if (!c) return null;
  if ((c as HTMLButtonElement).disabled || c.getAttribute('aria-disabled') === 'true') return null;
  if (c.closest('[data-no-click-sound], [data-play-touch]')) return null;
  // the played match: only its menus (the sheets over the rink) click
  if (c.closest('[data-play-match]') && !c.closest('[data-pad-scope]')) return null;
  const role = c.getAttribute('role');
  if (role === 'switch') return { el: c, kind: c.getAttribute('aria-checked') === 'true' ? 'off' : 'on' };
  if (role === 'tab' || role === 'radio') return { el: c, kind: 'tab' };
  return { el: c, kind: 'tap' };
}

let last = 0;
/** One tick (soft, short: two sines and a breath of noise). */
export function playClick(kind: ClickKind) {
  const e = audio();
  if (!e || !getSettings().uiSounds) return;
  const { ctx } = e, t = ctx.currentTime + .005;
  if (t - last < .03) return; // a double fire of one tap
  last = t;
  const f = kind === 'on' ? 1650 : kind === 'off' ? 1050 : kind === 'tab' ? 1250 : 1400;
  const g = ctx.createGain();
  g.connect(e.bus.ui);
  g.gain.setValueAtTime(1e-4, t); g.gain.linearRampToValueAtTime(.32, t + .002); g.gain.exponentialRampToValueAtTime(1e-4, t + .06);
  const o = ctx.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * .62, t + .05);
  o.connect(g); o.start(t); o.stop(t + .08);
  // the body: a quiet octave below, a touch later for on/off (a two-step «tick-tock»)
  const g2 = ctx.createGain(); g2.connect(e.bus.ui);
  const t2 = t + (kind === 'on' || kind === 'off' ? .035 : 0);
  g2.gain.setValueAtTime(1e-4, t2); g2.gain.linearRampToValueAtTime(.16, t2 + .003); g2.gain.exponentialRampToValueAtTime(1e-4, t2 + .07);
  const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.setValueAtTime(kind === 'on' ? f * .75 : f * .5, t2);
  o2.connect(g2); o2.start(t2); o2.stop(t2 + .09);
  const src = ctx.createBufferSource(); src.buffer = e.noise;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5000;
  const g3 = ctx.createGain(); g3.gain.setValueAtTime(.05, t); g3.gain.exponentialRampToValueAtTime(1e-4, t + .015);
  src.connect(hp); hp.connect(g3); g3.connect(e.bus.ui); src.start(t, Math.random()); src.stop(t + .03);
}

let installed = false;
/** Listens to every click of the app (capture: before a window closes and takes the button away). */
export function installUiClicks() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('click', (ev) => {
    const hit = clickTarget(ev.target as Element | null);
    if (hit) playClick(hit.kind);
  }, { capture: true, passive: true });
}
