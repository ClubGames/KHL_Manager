// The menu music: an original piece written for the game and played by a small synthesizer in the browser — a warm
// pad, a plucked arpeggio through an echo, a round bass, soft drums and a bell melody. No recording, nothing to
// license, nothing added to the download.
//
// The score is data (`menuScore`): a 4-bar intro, then a 28-bar loop — the verse twice (pad, arpeggio, bass), the
// chorus with the drums and the melody, the verse again with the drums and the arpeggio an octave up, a short
// breakdown. A look-ahead scheduler plays it on the engine's «menu» bus; it fades in when a menu screen shows and
// out when a match opens (the match screens silence it while they are open).
import { useEffect } from 'react';
import { getSettings, subscribeSettings } from '../../game/settings';
import { audio } from './engine';

export const BPM = 92;
/** One 16th note, seconds. */
export const STEP = 60 / BPM / 4;
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** A chord: the pad's voicing (an added colour note), the bass root, the arpeggio's tones. */
type Chord = { pad: number[]; bass: number; arp: number[] };
const CH: Record<string, Chord> = {
  Am: { pad: [57, 60, 64, 71], bass: 33, arp: [69, 72, 76, 79] },
  F: { pad: [53, 57, 60, 64], bass: 29, arp: [65, 69, 72, 76] },
  C: { pad: [55, 60, 64, 74], bass: 36, arp: [67, 72, 76, 79] },
  G: { pad: [55, 59, 62, 69], bass: 31, arp: [67, 71, 74, 79] },
  Em: { pad: [52, 55, 59, 66], bass: 28, arp: [64, 67, 71, 76] },
};
const VERSE = ['Am', 'F', 'C', 'G'];
const CHORUS = ['F', 'G', 'Em', 'Am', 'F', 'G', 'C', 'C'];
/** The chorus melody: [bar of the chorus, 16th, midi, length in 16ths]. */
const MELODY: [number, number, number, number][] = [
  [0, 0, 69, 4], [0, 4, 72, 4], [0, 8, 77, 6], [0, 14, 76, 2],
  [1, 0, 74, 6], [1, 6, 71, 2], [1, 8, 74, 4], [1, 12, 79, 4],
  [2, 0, 76, 8], [2, 8, 79, 2], [2, 10, 74, 2], [2, 12, 76, 4],
  [3, 0, 72, 6], [3, 6, 71, 2], [3, 8, 69, 8],
  [4, 0, 69, 2], [4, 2, 72, 2], [4, 4, 77, 4], [4, 8, 81, 4], [4, 12, 79, 4],
  [5, 0, 77, 4], [5, 4, 76, 2], [5, 6, 74, 2], [5, 8, 71, 4], [5, 12, 74, 4],
  [6, 0, 76, 8], [6, 8, 74, 4], [6, 12, 72, 4],
  [7, 0, 72, 12], [7, 12, 67, 2], [7, 14, 69, 2],
];
const ARP = [0, 1, 2, 3, 2, 1, 2, 3];
const INTRO = 4, LOOP = 28;

export type Section = 'intro' | 'verse' | 'chorus' | 'verse2' | 'break';
/** Where a bar of the endless piece falls: its section, its chord, its bar inside the section. */
export function barInfo(bar: number): { section: Section; chord: string; inSection: number } {
  if (bar < INTRO) return { section: 'intro', chord: VERSE[bar % 4], inSection: bar };
  const b = (bar - INTRO) % LOOP;
  if (b < 8) return { section: 'verse', chord: VERSE[b % 4], inSection: b };
  if (b < 16) return { section: 'chorus', chord: CHORUS[b - 8], inSection: b - 8 };
  if (b < 24) return { section: 'verse2', chord: VERSE[(b - 16) % 4], inSection: b - 16 };
  return { section: 'break', chord: VERSE[(b - 24) % 4], inSection: b - 24 };
}

export type MusicEvent =
  | { k: 'pad'; notes: number[]; len: number }
  | { k: 'bass'; note: number; len: number }
  | { k: 'arp'; note: number; bright: number }
  | { k: 'bell'; note: number; len: number }
  | { k: 'kick' } | { k: 'snare' } | { k: 'hat'; open?: boolean };

/** What sounds on a 16th of the piece (len in 16ths). */
export function menuScore(step: number): MusicEvent[] {
  const bar = Math.floor(step / 16), s = step % 16, { section, chord, inSection } = barInfo(bar), c = CH[chord];
  const out: MusicEvent[] = [];
  if (s === 0) out.push({ k: 'pad', notes: c.pad, len: 16 });
  const arpOn = section !== 'intro' || inSection >= 2;
  if (arpOn && s % 2 === 0) {
    const up = section === 'verse2' ? 12 : 0;
    // the intro's arpeggio opens up bar by bar; the breakdown thins to quarters
    if (section !== 'break' || s % 4 === 0) out.push({ k: 'arp', note: c.arp[ARP[(s / 2) % 8]] + up, bright: section === 'intro' ? .35 : section === 'break' ? .5 : section === 'chorus' ? 1 : .75 });
  }
  if (section === 'verse' || section === 'chorus' || section === 'verse2') {
    if (s === 0 || s === 8) out.push({ k: 'bass', note: c.bass, len: 6 });
    if (s === 6 || s === 14) out.push({ k: 'bass', note: c.bass + (s === 14 && inSection % 2 ? 7 : 0), len: 2 });
  }
  if (section === 'break' && s === 0) out.push({ k: 'bass', note: c.bass, len: 16 });
  if (section === 'chorus' || section === 'verse2') {
    if (s === 0 || s === 8 || (s === 10 && inSection % 2 === 1)) out.push({ k: 'kick' });
    if (s === 4 || s === 12) out.push({ k: 'snare' });
    if (s % 4 === 2) out.push({ k: 'hat', open: s === 14 && inSection % 4 === 3 });
  }
  if (section === 'verse' && inSection >= 4 && s % 4 === 2) out.push({ k: 'hat' });
  if (section === 'chorus') for (const [mb, ms, note, len] of MELODY) if (mb === inSection && ms === s) out.push({ k: 'bell', note, len });
  return out;
}

/* ---- the synthesizer ---- */

/** What the synthesizer needs of the engine (an offline context renders it the same way: the preview, the tests). */
type E = { ctx: BaseAudioContext; noise: AudioBuffer; bus: { menu: AudioNode } };
type Voice = { gate: GainNode; echo: GainNode; ctx: BaseAudioContext; nodes: AudioNode[] };

/** The music's own output: a gate (the fades) into the menu bus, and an echo (a dotted 8th) for the plucks and the bell. */
function voiceOf(e: E): Voice {
  const { ctx } = e;
  const gate = ctx.createGain(); gate.gain.value = 0;
  gate.connect(e.bus.menu);
  const echo = ctx.createGain(); echo.gain.value = 1;
  const delay = ctx.createDelay(1); delay.delayTime.value = STEP * 3;
  const fb = ctx.createGain(); fb.gain.value = .32;
  const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 2600;
  const wet = ctx.createGain(); wet.gain.value = .38;
  echo.connect(delay); delay.connect(tone); tone.connect(fb); fb.connect(delay); tone.connect(wet); wet.connect(gate);
  return { gate, echo, ctx, nodes: [gate, echo, delay, fb, tone, wet] };
}

function env(g: GainNode, t: number, a: number, peak: number, hold: number, rel: number) {
  g.gain.setValueAtTime(1e-4, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  if (hold > 0) g.gain.setValueAtTime(peak, t + a + hold);
  g.gain.exponentialRampToValueAtTime(1e-4, t + a + hold + rel);
  return t + a + hold + rel;
}
function osc(ctx: BaseAudioContext, type: OscillatorType, f: number, t: number, end: number, detune = 0): OscillatorNode {
  const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); o.detune.value = detune;
  o.start(t); o.stop(end + .05);
  return o;
}

function play(e: E, v: Voice, ev: MusicEvent, t: number) {
  const { ctx } = e;
  switch (ev.k) {
    case 'pad': {
      // two detuned saws per note through a soft low-pass that breathes over the bar
      const len = ev.len * STEP, f = ctx.createBiquadFilter(), g = ctx.createGain();
      f.type = 'lowpass'; f.Q.value = .4;
      f.frequency.setValueAtTime(700, t); f.frequency.linearRampToValueAtTime(1500, t + len * .5); f.frequency.linearRampToValueAtTime(900, t + len + .8);
      f.connect(g); g.connect(v.gate);
      const end = env(g, t, .7, .065, len - .5, 1.1);
      for (const n of ev.notes) for (const d of [-7, 7]) osc(ctx, 'sawtooth', hz(n), t, end, d).connect(f);
      break;
    }
    case 'bass': {
      const len = ev.len * STEP, g = ctx.createGain(), f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 420;
      f.connect(g); g.connect(v.gate);
      const end = env(g, t, .012, .15, Math.max(.05, len - .12), .18);
      osc(ctx, 'sine', hz(ev.note), t, end).connect(f);
      const tri = osc(ctx, 'triangle', hz(ev.note + 12), t, end); const tg = ctx.createGain(); tg.gain.value = .4; tri.connect(tg); tg.connect(f);
      break;
    }
    case 'arp': {
      // a pluck: a triangle and a quiet square an octave up, the filter snapping shut
      const g = ctx.createGain(), f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.Q.value = 2;
      f.frequency.setValueAtTime(900 + 2600 * ev.bright, t); f.frequency.exponentialRampToValueAtTime(500, t + .22);
      f.connect(g); g.connect(v.gate); g.connect(v.echo);
      const end = env(g, t, .004, .085, 0, .32);
      osc(ctx, 'triangle', hz(ev.note), t, end).connect(f);
      const sq = osc(ctx, 'square', hz(ev.note), t, end); const sg = ctx.createGain(); sg.gain.value = .18; sq.connect(sg); sg.connect(f);
      break;
    }
    case 'bell': {
      // an FM-ish bell: the fundamental, a soft inharmonic partial, a long ring
      const len = ev.len * STEP, g = ctx.createGain();
      g.connect(v.gate); g.connect(v.echo);
      const end = env(g, t, .006, .13, Math.min(.25, len * .3), Math.max(.6, len * 1.1));
      osc(ctx, 'sine', hz(ev.note), t, end).connect(g);
      const p = osc(ctx, 'sine', hz(ev.note) * 2.76, t, end); const pg = ctx.createGain(); env(pg, t, .004, .22, 0, .35); p.connect(pg); pg.connect(g);
      const o2 = osc(ctx, 'sine', hz(ev.note) * 2, t, end); const og = ctx.createGain(); og.gain.value = .18; o2.connect(og); og.connect(g);
      break;
    }
    case 'kick': {
      const g = ctx.createGain(); g.connect(v.gate);
      const end = env(g, t, .002, .5, 0, .28);
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(42, t + .12);
      o.connect(g); o.start(t); o.stop(end + .05);
      break;
    }
    case 'snare':
    case 'hat': {
      const src = ctx.createBufferSource(); src.buffer = e.noise; src.loop = true;
      const f = ctx.createBiquadFilter(), g = ctx.createGain();
      if (ev.k === 'snare') { f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = .8; }
      else { f.type = 'highpass'; f.frequency.value = 7500; }
      src.connect(f); f.connect(g); g.connect(v.gate);
      const end = env(g, t, .002, ev.k === 'snare' ? .16 : .08, 0, ev.k === 'snare' ? .16 : ev.open ? .22 : .045);
      src.start(t, Math.random()); src.stop(end + .05);
      if (ev.k === 'snare') { const b = ctx.createGain(); b.connect(v.gate); const be = env(b, t, .002, .12, 0, .09); osc(ctx, 'triangle', 190, t, be).connect(b); }
      break;
    }
  }
}

/**
 * The first `steps` 16ths of the piece into `out` of an (offline) context, starting at its time 0 — the preview and
 * the level check render it this way.
 */
export function renderMenuMusic(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, steps: number) {
  const v = voiceOf({ ctx, noise, bus: { menu: out } });
  v.gate.gain.value = 1;
  for (let i = 0; i < steps; i++) for (const ev of menuScore(i)) play({ ctx, noise, bus: { menu: out } }, v, ev, .05 + i * STEP);
}

/* ---- the player ---- */

let voice: Voice | null = null;
let timer = 0, poll = 0;
let step = 0, nextAt = 0;
/** a menu screen wants the music (the App while no match is open) */
let wanted = false;
/** match screens open now (each silences the music while it is open) */
let silencers = 0;

const shouldPlay = () => { const s = getSettings(); return wanted && silencers === 0 && s.sound && s.menuMusic !== 'off'; };

function start(e: E) {
  if (voice && voice.ctx === e.ctx) return;
  voice = voiceOf(e);
  const t = e.ctx.currentTime;
  voice.gate.gain.setValueAtTime(0, t); voice.gate.gain.linearRampToValueAtTime(1, t + 2.5);
  nextAt = t + .12;
  timer = window.setInterval(tick, 60);
  tick();
}
function tick() {
  const e = audio();
  if (!e || !voice || voice.ctx !== e.ctx) return;
  // a look-ahead of a quarter second; a frozen context (the app in the background) schedules nothing
  if (nextAt < e.ctx.currentTime - .5) nextAt = e.ctx.currentTime + .05;
  while (nextAt < e.ctx.currentTime + .25) {
    for (const ev of menuScore(step)) play(e, voice, ev, nextAt);
    step++; nextAt += STEP;
  }
}
function stop(fade = 1.2) {
  window.clearInterval(timer); timer = 0;
  const v = voice; voice = null;
  if (!v) return;
  const t = v.ctx.currentTime;
  v.gate.gain.cancelScheduledValues(t); v.gate.gain.setValueAtTime(v.gate.gain.value, t); v.gate.gain.linearRampToValueAtTime(0, t + fade);
  window.setTimeout(() => { for (const n of v.nodes) try { n.disconnect(); } catch { /* gone */ } }, (fade + 1.5) * 1000);
}
/** Starts or stops the music as the screens and the settings want; until the first gesture unlocks the sound it keeps trying. */
function sync() {
  if (typeof window === 'undefined') return;
  if (!shouldPlay()) { stop(); window.clearInterval(poll); poll = 0; return; }
  const e = audio();
  if (e) { window.clearInterval(poll); poll = 0; start(e); return; }
  if (!poll) poll = window.setInterval(sync, 700);
}
let subscribed = false;
function ensureSubscribed() { if (!subscribed) { subscribed = true; subscribeSettings(sync); } }

/** The App: the music plays while `on` (no match open). */
export function useMenuMusic(on: boolean) {
  useEffect(() => { ensureSubscribed(); wanted = on; sync(); }, [on]);
  useEffect(() => () => { wanted = false; sync(); }, []);
}
/** A match screen: the menu music fades out while it is open. */
export function useSilenceMenuMusic() {
  useEffect(() => { ensureSubscribed(); silencers++; sync(); return () => { silencers = Math.max(0, silencers - 1); sync(); }; }, []);
}
/** For tests: is the music running now. */
export const menuMusicPlaying = () => !!voice;
