// The arena organ, synthesized: a drawbar organ (sine partials at 16', 8', 4', 2 2/3', 2') with a rotating-speaker
// shimmer. The riffs are original short phrases written for the game (no borrowed tunes); some end with a rhythm the
// crowd claps back.
import { audio, tone } from './engine';

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
/** [midi notes (a chord), start beat, length in beats] */
type Note = [number[], number, number];
type Riff = { bpm: number; notes: Note[]; claps?: number[] };

const C4 = 60;
export const RIFFS: Record<string, Riff> = {
  // a rising run that winds the building up, a stab at the top
  climb: { bpm: 168, notes: [...[0, 1, 2, 3, 4, 5, 6, 7].map((k, i): Note => [[C4 - 5 + k], i * .5, .45]), [[C4 + 3, C4 + 7, C4 + 10], 4, 1.4]] },
  // a three-note call, twice, and the crowd claps the answer
  call: { bpm: 132, notes: [[[C4 + 7], 0, .5], [[C4 + 7], .5, .5], [[C4 + 10], 1, 1], [[C4 + 7], 3, .5], [[C4 + 7], 3.5, .5], [[C4 + 12], 4, 1]], claps: [6, 6.5, 7.25, 7.75, 8.25] },
  // a stomping minor bass figure with chord hits
  stomp: { bpm: 120, notes: [[[C4 - 20], 0, .4], [[C4 - 20], 1, .4], [[C4 - 17], 1.5, .4], [[C4 - 20], 2, .4], [[C4 - 8, C4 - 5, C4 - 1], 2.5, .8], [[C4 - 22], 4, .4], [[C4 - 22], 5, .4], [[C4 - 19], 5.5, .4], [[C4 - 10, C4 - 7, C4 - 3], 6, 1.2]] },
  // a bright little fanfare
  fanfare: { bpm: 150, notes: [[[C4 + 2], 0, .5], [[C4 + 6], .5, .5], [[C4 + 9], 1, .5], [[C4 + 14], 1.5, 1], [[C4 + 9], 2.75, .25], [[C4 + 11], 3, .5], [[C4 + 14, C4 + 18, C4 + 21], 3.5, 1.6]] },
  // after a home goal: a quick celebratory roll up to a big chord
  goal: { bpm: 176, notes: [...[0, 2, 4, 5, 7, 9, 11].map((k, i): Note => [[C4 + k], i * .5, .45]), [[C4 + 12, C4 + 16, C4 + 19, C4 + 24], 3.5, 2.5]] },
};

/** One organ note (a chord) at `t` for `dur` seconds. */
function organNote(midi: number[], t: number, dur: number, vel = 1) {
  const e = audio(); if (!e) return;
  for (const m of midi) {
    const f = hz(m);
    // drawbars 8 8 6 0 0 0 4 0 0-ish: fundamental, sub-octave, octave, twelfth, fifteenth
    for (const [mult, g] of [[1, .32], [.5, .2], [2, .2], [3, .1], [4, .08]] as const) {
      tone(e, { t, f: f * mult, type: 'sine', vib: [6.3, f * mult * .0035], env: { a: .008, hold: Math.max(.02, dur - .05), d: .09 }, gain: g * vel / Math.sqrt(midi.length), bus: 'music' });
    }
  }
}

/** Plays a riff now; returns the claps' times (seconds from now) for the crowd, and how long the riff lasts. */
export function playRiff(name: keyof typeof RIFFS): { claps: number[]; length: number } | null {
  const e = audio(); if (!e) return null;
  const r = RIFFS[name], beat = 60 / r.bpm, t0 = e.ctx.currentTime + .05;
  let end = 0;
  for (const [notes, at, len] of r.notes) { organNote(notes, t0 + at * beat, len * beat); end = Math.max(end, (at + len) * beat); }
  const claps = (r.claps ?? []).map(b => b * beat);
  return { claps, length: Math.max(end, ...claps, 0) };
}

/** A riff for a stoppage (not the goal one). */
export function stoppageRiff(): keyof typeof RIFFS {
  const names = ['climb', 'call', 'stomp', 'fanfare'] as const;
  return names[Math.floor(Math.random() * names.length)];
}
