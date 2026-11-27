// Match sound effects, synthesized (see engine.ts): the stick on the puck, the boards and the glass, the post, body
// checks, the goalie's pads and glove, the referee's whistle, the puck dropped at a faceoff, the goal horn, the
// period siren, skates stopping hard.
import { audio, noise, tone } from './engine';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const jitter = (v: number, k = .06) => v * (1 + (Math.random() * 2 - 1) * k);

/** The stick meets the puck: `power` 0…1 (a soft pass … a hard shot); a slap shot cracks after the blade hits the ice. */
export function stickHit(power: number, kind: 'pass' | 'shot' | 'slap' | 'receive', pan = 0) {
  const e = audio(); if (!e) return;
  const t = e.ctx.currentTime + .005, p = clamp01(power);
  if (kind === 'receive') {
    // the puck settles on a blade: a soft dull tick
    noise(e, { t, env: { d: .035 }, filter: 'bandpass', f: jitter(1300), q: 2.5, gain: .4, pan });
    tone(e, { t, f: jitter(330), fTo: 260, env: { d: .05 }, gain: .12, pan });
    return;
  }
  if (kind === 'slap') {
    // the blade slaps the ice just behind the puck, then the crack
    noise(e, { t, env: { d: .07 }, filter: 'lowpass', f: 2600, gain: .35 + .25 * p, pan });
  }
  const at = kind === 'slap' ? t + .028 : t;
  // the click of the contact
  noise(e, { t: at, env: { d: .012 }, filter: 'highpass', f: 2400, gain: .45 + .55 * p, pan });
  // the wooden / composite knock of the blade
  noise(e, { t: at, env: { d: .05 + .04 * p }, filter: 'bandpass', f: jitter(780 + 520 * p), q: 4, gain: .5 + .4 * p, pan });
  tone(e, { t: at, f: jitter(kind === 'pass' ? 440 : 520), fTo: kind === 'pass' ? 300 : 340, env: { d: .06 }, gain: .14 + .1 * p, pan });
  if (kind !== 'pass') noise(e, { t: at, env: { d: .14 }, filter: 'lowpass', f: 900, gain: .3 * p, pan });
}

/** The puck off the boards (`power` 0…1): the hollow thump of the dasher boards with a plastic rattle. */
export function boards(power: number, pan = 0) {
  const e = audio(); if (!e) return;
  const t = e.ctx.currentTime + .005, p = clamp01(power);
  tone(e, { t, f: jitter(105), fTo: 58, env: { d: .2 + .1 * p }, gain: .35 + .45 * p, pan });
  noise(e, { t, env: { d: .14 }, filter: 'lowpass', f: 520, gain: .5 + .4 * p, pan });
  noise(e, { t, env: { d: .07 }, filter: 'bandpass', f: jitter(1900), q: 2, gain: .18 + .2 * p, pan });
}

/** A puck / a man against the glass: a dull boom with the panes rattling in their frames. */
export function glass(power: number, pan = 0) {
  const e = audio(); if (!e) return;
  const t = e.ctx.currentTime + .005, p = clamp01(power);
  tone(e, { t, f: jitter(80), fTo: 50, env: { d: .25 }, gain: .4 * p + .2, pan });
  noise(e, { t, env: { d: .4 }, filter: 'bandpass', f: jitter(2600), q: 1.2, gain: .22 + .25 * p, pan });
  for (const [f, d] of [[1830, .35], [2770, .28], [4120, .2]] as const) tone(e, { t, f: jitter(f, .03), env: { d }, gain: .025 + .03 * p, pan });
  // the frame shakes: a few quick rattles
  for (let i = 1; i < 4; i++) noise(e, { t: t + i * jitter(.045, .3), env: { d: .03 }, filter: 'bandpass', f: 3200, q: 3, gain: (.12 + .1 * p) / i, pan });
}

/** The ring of the post / crossbar: a steel tube's inharmonic modes. */
export function post(pan = 0) {
  const e = audio(); if (!e) return;
  const t = e.ctx.currentTime + .005;
  noise(e, { t, env: { d: .015 }, filter: 'highpass', f: 3000, gain: .6, pan });
  for (const [f, d, g] of [[1180, 1.3, .2], [2840, .9, .12], [4610, .55, .07], [6020, .35, .05]] as const) tone(e, { t, f: jitter(f, .02), env: { d }, gain: g, pan });
}

/** A body check (`power` 0…1); `wall`: into the boards — the boards boom and the glass shakes. */
export function bodyCheck(power: number, wall: boolean, pan = 0) {
  const e = audio(); if (!e) return;
  const t = e.ctx.currentTime + .005, p = clamp01(power);
  // the pads meeting: a padded whump
  noise(e, { t, env: { d: .16 }, filter: 'lowpass', f: 380, gain: .7 + .3 * p, pan });
  noise(e, { t, env: { d: .07 }, filter: 'bandpass', f: 600, q: 1, gain: .35, pan });
  tone(e, { t, f: 72, fTo: 44, env: { d: .22 }, gain: .4 + .3 * p, pan });
  if (wall) { boards(.8 + .2 * p, pan); glass(.6 + .4 * p, pan); }
}

/** The goalie stops it: `pad` — the hollow thwack of a leg pad / blocker, otherwise the snap of the glove. */
export function save(pad: boolean, pan = 0) {
  const e = audio(); if (!e) return;
  const t = e.ctx.currentTime + .005;
  if (pad) {
    noise(e, { t, env: { d: .1 }, filter: 'lowpass', f: 700, gain: 2, pan });
    noise(e, { t, env: { d: .05 }, filter: 'bandpass', f: 260, q: 1.5, gain: 1.3, pan });
    tone(e, { t, f: 150, fTo: 95, env: { d: .09 }, gain: .25, pan });
  } else {
    noise(e, { t, env: { d: .045 }, filter: 'bandpass', f: 1250, q: 1.6, gain: 1.4, pan });
    noise(e, { t, env: { d: .08 }, filter: 'lowpass', f: 420, gain: 1.2, pan });
  }
}

/** A shot blocked by a skater's shin pads / body. */
export function block(pan = 0) {
  const e = audio(); if (!e) return;
  const t = e.ctx.currentTime + .005;
  noise(e, { t, env: { d: .09 }, filter: 'lowpass', f: 480, gain: 1.4, pan });
  tone(e, { t, f: 140, fTo: 90, env: { d: .08 }, gain: .35, pan });
}

/** The referee's pea whistle: a shrill tone warbling as the pea spins, with breath noise; `blasts` short or one long. */
export function whistle(long = false, blasts = 1) {
  const e = audio(); if (!e) return;
  let t = e.ctx.currentTime + .01;
  for (let i = 0; i < blasts; i++) {
    const hold = long ? .55 : .26;
    const f = jitter(2850, .02);
    tone(e, { t, f, type: 'sine', vib: [jitter(34, .1), 170], env: { a: .015, hold, d: .07 }, gain: .2 });
    tone(e, { t, f: f * 2, type: 'sine', vib: [34, 340], env: { a: .015, hold, d: .06 }, gain: .03 });
    noise(e, { t, env: { a: .02, hold, d: .08 }, filter: 'bandpass', f: f, q: 3, gain: .07 });
    t += hold + .16;
  }
}

/** The puck dropped at a faceoff: it smacks the ice and the two sticks clash for it. */
export function faceoffDrop(pan = 0) {
  const e = audio(); if (!e) return;
  const t = e.ctx.currentTime + .005;
  noise(e, { t, env: { d: .03 }, filter: 'bandpass', f: 1500, q: 2, gain: .6, pan });
  let at = t + .05;
  for (let i = 0; i < 3; i++) {
    noise(e, { t: at, env: { d: .035 }, filter: 'bandpass', f: jitter(1000, .2), q: 3, gain: .7 - i * .14, pan: pan + (i % 2 ? .1 : -.1) });
    tone(e, { t: at, f: jitter(480, .15), fTo: 330, env: { d: .04 }, gain: .14, pan });
    at += jitter(.06, .4);
  }
}

/** The puck into the net: the mesh swishes and the frame rings softly. */
export function netRipple(pan = 0) {
  const e = audio(); if (!e) return;
  const t = e.ctx.currentTime + .005;
  noise(e, { t, env: { a: .01, d: .35 }, filter: 'bandpass', f: 700, fTo: 400, q: .8, gain: 1.1, pan });
  tone(e, { t, f: 1180, env: { d: .5 }, gain: .08, pan });
}

/** The goal horn: a deep, slightly rough brass chord swelling in, held, dying away (the ship-horn of the KHL arenas). */
export function goalHorn(seconds = 3.2) {
  const e = audio(); if (!e) return;
  const t = e.ctx.currentTime + .02;
  for (const [f, g] of [[110, .15], [138.6, .12], [165, .1], [220, .055]] as const) {
    for (const det of [-.004, .004]) {
      tone(e, { t, f: f * (1 + det), type: 'sawtooth', vib: [5.2, f * .004], filter: { type: 'lowpass', f: 1300, q: 1.2 }, env: { a: .12, hold: seconds, d: .6 }, gain: g });
    }
  }
  tone(e, { t, f: 55, type: 'sine', env: { a: .15, hold: seconds, d: .5 }, gain: .22 });
}

/** The siren at the end of a period: a hard buzzer. */
export function periodSiren() {
  const e = audio(); if (!e) return;
  const t = e.ctx.currentTime + .02;
  for (const f of [392, 397]) tone(e, { t, f, type: 'square', filter: { type: 'lowpass', f: 2400, q: .8 }, env: { a: .03, hold: 2.1, d: .25 }, gain: .09 });
  tone(e, { t, f: 196, type: 'sawtooth', filter: { type: 'lowpass', f: 900 }, env: { a: .03, hold: 2.1, d: .25 }, gain: .08 });
}

/** A hockey stop: the blades scrape sideways and throw snow (`power` 0…1 from the speed he stopped from). */
export function skateStop(power: number, pan = 0) {
  const e = audio(); if (!e) return;
  const t = e.ctx.currentTime + .005, p = clamp01(power);
  noise(e, { t, env: { a: .02, d: .22 + .2 * p, curve: 'lin' }, filter: 'bandpass', f: 5200, fTo: 2600, q: .9, gain: .12 + .2 * p, pan });
  noise(e, { t, env: { a: .03, d: .25 + .2 * p }, filter: 'highpass', f: 1800, gain: .05 + .08 * p, pan, pink: true });
}

/** One push of a skate blade (`power` 0…1): a short, airy scrape, its pitch a little different every time. */
export function stride(power: number, pan = 0) {
  const e = audio(); if (!e) return;
  const t = e.ctx.currentTime + .005, p = clamp01(power);
  noise(e, { t, env: { a: .035 + Math.random() * .03, d: .12 + Math.random() * .1, curve: 'lin' }, filter: 'bandpass', f: jitter(3800, .25), fTo: jitter(2900, .2), q: 1.1, gain: .035 + .05 * p, pan, pink: true });
}
