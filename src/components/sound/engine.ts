// The game's sound, on the Web Audio API: most of it synthesized in the browser — noise shaped by filters and
// envelopes, oscillators, voices made up of formant filters — plus a few recordings (sounds/, crowd/). The menu music
// and the interface clicks are synthesized too.
//
// One AudioContext for the whole app, created (and resumed) on the first tap / click / key press — browsers and the
// Android WebView only let sound start from a user gesture. Three buses under a master volume and a limiter:
// effects (sticks, boards, whistle, horn…), the crowd, the arena organ; and two outside the arena — the menu music
// and the interface's clicks.
import { getSettings, subscribeSettings, type Settings } from '../../game/settings';

export type Bus = 'sfx' | 'crowd' | 'music' | 'menu' | 'ui';

type Engine = { ctx: AudioContext; master: GainNode; bus: Record<Bus, GainNode>; noise: AudioBuffer; pink: AudioBuffer; /** the arena's echo (a convolution reverb fed from every bus) */ reverb: ConvolverNode | null };
let engine: Engine | null = null;
let unlockInstalled = false;
let muted = false;

/** Volume of each crowd setting (the crowd bus). */
const CROWD_GAIN: Record<Settings['soundCrowd'], number> = { off: 0, quiet: .45, normal: .8, loud: 1.15 };
/** Volume of the menu music settings (the menu bus). */
const MENU_GAIN: Record<Settings['menuMusic'], number> = { off: 0, quiet: .32, normal: .6 };

function makeNoise(ctx: BaseAudioContext, seconds: number, pink: boolean): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
  let s = 0x2545f491;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
  // pink: Paul Kellet's economy filter (−3 dB / octave), the softer hiss of a crowd and of skates
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd();
    if (!pink) { d[i] = w * .9; continue; }
    b0 = .99765 * b0 + w * .099046; b1 = .963 * b1 + w * .2965164; b2 = .57 * b2 + w * 1.0526913;
    d[i] = (b0 + b1 + b2 + w * .1848) * .18;
  }
  return buf;
}

/**
 * The hall's impulse response: a big ice arena (≈2.4 s of reverberation). Stereo noise decaying exponentially, the
 * highs dying faster than the lows (air and seats soak them up), a few discrete early reflections off the glass,
 * the boards and the roof in the first 90 ms, a short pre-delay. Generated, not recorded.
 */
function arenaImpulse(ctx: BaseAudioContext, seconds = 2.4): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor(sr * seconds), buf = ctx.createBuffer(2, n, sr);
  let s = 0x51f15e;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
  const pre = Math.floor(sr * .018), rt = seconds * .42;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      // the cutoff of a one-pole low-pass falls with time: bright at first, dark in the tail
      const k = Math.exp(-t / (rt * .55)) * .75 + .06;
      lp += (rnd() - lp) * k;
      d[i] = lp * Math.exp(-t / rt) * (t < .08 ? t / .08 : 1) * .55;
    }
    // early reflections (different in each ear: the width of the hall)
    for (const [ms, g] of [[11, .5], [23, .38], [37, .32], [52, .24], [71, .2], [89, .16]] as const) {
      const at = pre + Math.floor((ms + (ch ? 3.5 : -2) * (ms / 40)) * sr / 1000);
      if (at < n) d[at] += g * (ch ? -1 : 1) * (.8 + .2 * Math.abs(rnd()));
    }
  }
  return buf;
}

/** Creates the context (only from a user gesture, see `installSoundUnlock`). */
function create(): Engine | null {
  if (engine) return engine;
  const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try {
    const ctx = new AC({ latencyHint: 'interactive' });
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10; limiter.knee.value = 8; limiter.ratio.value = 6; limiter.attack.value = .003; limiter.release.value = .2;
    const master = ctx.createGain();
    master.connect(limiter); limiter.connect(ctx.destination);
    const bus = { sfx: ctx.createGain(), crowd: ctx.createGain(), music: ctx.createGain(), menu: ctx.createGain(), ui: ctx.createGain() };
    for (const b of Object.values(bus)) b.connect(master);
    // the arena: everything also goes into the hall's echo — the crowd most (it surrounds you), the organ a lot,
    // the puck and the boards a little (their slap comes back off the stands)
    let reverb: ConvolverNode | null = null;
    try {
      reverb = ctx.createConvolver();
      reverb.normalize = true;
      reverb.buffer = arenaImpulse(ctx);
      const wet = ctx.createGain(); wet.gain.value = .5;
      reverb.connect(wet); wet.connect(master);
      for (const [b, k] of [[bus.crowd, .3], [bus.music, .45], [bus.sfx, .16], [bus.menu, .18]] as const) { const g = ctx.createGain(); g.gain.value = k; b.connect(g); g.connect(reverb); }
    } catch { reverb = null; }
    engine = { ctx, master, bus, noise: makeNoise(ctx, 2, false), pink: makeNoise(ctx, 4, true), reverb };
    applySettings(getSettings());
    subscribeSettings(() => applySettings(getSettings()));
    return engine;
  } catch {
    return null;
  }
}

function applySettings(s: Settings) {
  if (!engine) return;
  const { ctx, master, bus } = engine;
  const t = ctx.currentTime;
  master.gain.setTargetAtTime(s.sound && !muted ? s.soundVolume * .9 : 0, t, .05);
  bus.sfx.gain.setTargetAtTime(1, t, .05);
  bus.crowd.gain.setTargetAtTime(CROWD_GAIN[s.soundCrowd], t, .1);
  bus.music.gain.setTargetAtTime(s.soundOrgan ? .38 : 0, t, .1);
  bus.menu.gain.setTargetAtTime(MENU_GAIN[s.menuMusic], t, .15);
  bus.ui.gain.setTargetAtTime(s.uiSounds ? .55 : 0, t, .05);
}

/**
 * Starts the sound on the first user gesture (and resumes it after the app comes back from the background). Safe to
 * call more than once.
 */
export function installSoundUnlock() {
  if (unlockInstalled || typeof window === 'undefined') return;
  unlockInstalled = true;
  const unlock = () => {
    if (!getSettings().sound) return;
    const e = create();
    if (e && e.ctx.state !== 'running' && !document.hidden) void e.ctx.resume().catch(() => {});
  };
  for (const ev of ['pointerdown', 'touchend', 'keydown', 'click'] as const) window.addEventListener(ev, unlock, { capture: true, passive: true });
  // a phone call / the home button: no sound from the background
  document.addEventListener('visibilitychange', () => {
    if (!engine) return;
    if (document.hidden) void engine.ctx.suspend().catch(() => {});
    else if (getSettings().sound) void engine.ctx.resume().catch(() => {});
  });
}

/** The running engine, or null (sound off in the settings, not unlocked yet, no Web Audio). */
export function audio(): Engine | null {
  if (!engine || engine.ctx.state !== 'running' || !getSettings().sound || muted) return null;
  return engine;
}

/** The engine even if it is still waiting for its first gesture (to build long-lived nodes such as the crowd loop). */
export function audioAny(): Engine | null { return getSettings().sound ? engine : null; }

/** A quick mute (the match screen's speaker button) on top of the settings. */
export function setMuted(m: boolean) { muted = m; applySettings(getSettings()); }
export function isMuted() { return muted; }

// ——— building blocks ———

export type Env = { a?: number; d: number; peak?: number; hold?: number; curve?: 'exp' | 'lin' };

/** An attack / hold / exponential-decay envelope on a gain node starting at `t`; returns the end time. */
export function envelope(g: GainNode, t: number, e: Env): number {
  const a = e.a ?? .002, peak = Math.max(1e-4, e.peak ?? 1), hold = e.hold ?? 0;
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(1e-4, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  if (hold) g.gain.setValueAtTime(peak, t + a + hold);
  const end = t + a + hold + e.d;
  if (e.curve === 'lin') g.gain.linearRampToValueAtTime(1e-4, end);
  else g.gain.exponentialRampToValueAtTime(1e-4, end);
  return end;
}

/** A stereo panner (or a plain gain where StereoPanner is missing) feeding the bus. */
export function output(e: Engine, bus: Bus, pan = 0): AudioNode {
  const out = e.bus[bus];
  if (!pan || !e.ctx.createStereoPanner) return out;
  const p = e.ctx.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  p.connect(out);
  return p;
}

export type NoiseOpts = {
  t?: number; env: Env; filter?: BiquadFilterType; f?: number; fTo?: number; q?: number; gain?: number;
  pan?: number; bus?: Bus; pink?: boolean; rate?: number; second?: { type: BiquadFilterType; f: number; q?: number };
};
/** A burst of filtered noise (the body of most impacts: sticks, boards, pads, skates, claps). */
export function noise(e: Engine, o: NoiseOpts) {
  const { ctx } = e, t = o.t ?? ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = o.pink ? e.pink : e.noise;
  src.loop = true;
  if (o.rate) src.playbackRate.value = o.rate;
  let node: AudioNode = src;
  if (o.filter) {
    const f = ctx.createBiquadFilter();
    f.type = o.filter; f.frequency.setValueAtTime(o.f ?? 1000, t); f.Q.value = o.q ?? .7;
    if (o.fTo) f.frequency.exponentialRampToValueAtTime(o.fTo, t + (o.env.a ?? .002) + (o.env.hold ?? 0) + o.env.d);
    node.connect(f); node = f;
  }
  if (o.second) {
    const f = ctx.createBiquadFilter();
    f.type = o.second.type; f.frequency.value = o.second.f; f.Q.value = o.second.q ?? .7;
    node.connect(f); node = f;
  }
  const g = ctx.createGain();
  node.connect(g); g.connect(output(e, o.bus ?? 'sfx', o.pan));
  const end = envelope(g, t, { ...o.env, peak: (o.env.peak ?? 1) * (o.gain ?? 1) });
  src.start(t, Math.random() * 1.5);
  src.stop(end + .05);
}

export type ToneOpts = {
  t?: number; f: number; fTo?: number; glide?: number; type?: OscillatorType; env: Env; gain?: number; pan?: number; bus?: Bus;
  /** vibrato / trill: rate (Hz) and depth (Hz) */
  vib?: [number, number]; filter?: { type: BiquadFilterType; f: number; q?: number };
  /** where it plays into instead of the bus (a gate the caller can close: the organ's riffs) */
  out?: AudioNode;
};
/** An oscillator with an envelope (resonances, the post's ring, the whistle's pea, the horn's reeds, the organ). */
export function tone(e: Engine, o: ToneOpts) {
  const { ctx } = e, t = o.t ?? ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.f, t);
  if (o.fTo) osc.frequency.exponentialRampToValueAtTime(o.fTo, t + (o.glide ?? o.env.d));
  let lfo: OscillatorNode | null = null;
  if (o.vib) {
    lfo = ctx.createOscillator(); lfo.frequency.value = o.vib[0];
    const depth = ctx.createGain(); depth.gain.value = o.vib[1];
    lfo.connect(depth); depth.connect(osc.frequency);
  }
  let node: AudioNode = osc;
  if (o.filter) {
    const f = ctx.createBiquadFilter(); f.type = o.filter.type; f.frequency.value = o.filter.f; f.Q.value = o.filter.q ?? .7;
    node.connect(f); node = f;
  }
  const g = ctx.createGain();
  node.connect(g); g.connect(o.out ?? output(e, o.bus ?? 'sfx', o.pan));
  const end = envelope(g, t, { ...o.env, peak: (o.env.peak ?? 1) * (o.gain ?? 1) });
  osc.start(t); osc.stop(end + .05);
  if (lfo) { lfo.start(t); lfo.stop(end + .05); }
}
