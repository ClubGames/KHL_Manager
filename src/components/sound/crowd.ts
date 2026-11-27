// The arena crowd, synthesized: a few dozen "voices" — a glottal pulse train through two vowel formants, cut into
// syllables — summed into a murmur; louder, higher, longer vowels for the cheering; a dense patter of claps for the
// applause. Built once (spread over a few frames so the page never stalls), then looped under the match.
import { audioAny, noise, output, type Bus } from './engine';

type Engine = NonNullable<ReturnType<typeof audioAny>>;
const SR = 22050;
/** [F1, F2] of the vowels a crowd makes (a, o, u, e, i, and the neutral murmur). */
const VOWELS: [number, number][] = [[800, 1200], [520, 880], [350, 700], [480, 1750], [310, 2150], [560, 1450]];

type Voice = { f0: [number, number]; syll: [number, number]; gap: number; gain: number; breath: number; vowels: number[] };

let seed = 0x9e3779b9;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const between = (a: number, b: number) => a + (b - a) * rnd();

/** Adds one voice to `out` (n samples): pulse train → two band-pass formants, syllable envelopes, a little distance. */
function addVoice(out: Float32Array, v: Voice) {
  const n = out.length;
  let i = 0, phase = rnd();
  let x1 = 0, x2 = 0, ya1 = 0, ya2 = 0, yb1 = 0, yb2 = 0, lp = 0;
  const far = between(.15, .7); // a farther voice is duller
  while (i < n) {
    // a syllable (or a held vowel) and the pause after it
    const len = Math.floor(between(v.syll[0], v.syll[1]) * SR), gap = Math.floor(between(0, v.gap) * SR);
    const [F1, F2] = VOWELS[v.vowels[Math.floor(rnd() * v.vowels.length)]];
    const f1 = F1 * between(.9, 1.12), f2 = F2 * between(.9, 1.12);
    const coef = (f: number, q: number) => { const w = 2 * Math.PI * f / SR, al = Math.sin(w) / (2 * q), a0 = 1 + al; return [al / a0, -2 * Math.cos(w) / a0, (1 - al) / a0]; };
    const [ba, a1a, a2a] = coef(f1, 5), [bb, a1b, a2b] = coef(f2, 7);
    const f0a = between(v.f0[0], v.f0[1]), f0b = f0a * between(.85, 1.2);
    const peak = v.gain * between(.5, 1);
    for (let k = 0; k < len && i < n; k++, i++) {
      const u = k / len;
      const env = Math.sin(Math.PI * Math.min(1, u * 1.15)) ** .7 * peak;
      const f0 = f0a + (f0b - f0a) * u;
      phase += f0 / SR; if (phase >= 1) phase -= 1;
      const src = (phase * 2 - 1) * (1 - v.breath) + (rnd() * 2 - 1) * v.breath;
      const ya = ba * src - ba * x2 - a1a * ya1 - a2a * ya2;
      const yb = bb * src - bb * x2 - a1b * yb1 - a2b * yb2;
      x2 = x1; x1 = src; ya2 = ya1; ya1 = ya; yb2 = yb1; yb1 = yb;
      lp += (ya + yb * .6 - lp) * (1 - far);
      out[i] += lp * env;
    }
    i += gap;
  }
}

/** A loopable buffer: `seconds` of material with its tail crossfaded into its head. */
function loopable(ctx: BaseAudioContext, data: Float32Array, seconds: number): AudioBuffer {
  const n = Math.floor(seconds * SR), xf = data.length - n;
  for (let i = 0; i < xf; i++) { const w = i / xf; data[i] = data[i] * w + data[n + i] * (1 - w); }
  let peak = 1e-6;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(data[i]));
  const buf = ctx.createBuffer(1, n, SR), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = data[i] / peak * .8;
  return buf;
}

/** Yields to the page between slices (a phone keeps drawing the match while the crowd is built). */
const nextFrame = () => new Promise<void>(r => setTimeout(r, 16));

/** The murmur, the cheering and the applause (built in slices: one voice per tick). */
async function buildBuffers(ctx: BaseAudioContext): Promise<{ murmur: AudioBuffer; cheer: AudioBuffer; applause: AudioBuffer }> {
  const L = 6, X = .6, N = Math.floor((L + X) * SR);
  const murmur = new Float32Array(N), cheer = new Float32Array(N), applause = new Float32Array(N);
  for (let k = 0; k < 26; k++) {
    // talking: men and women, short syllables with pauses
    const woman = rnd() < .35;
    addVoice(murmur, { f0: woman ? [180, 260] : [95, 150], syll: [.08, .26], gap: .5, gain: between(.4, 1), breath: .25, vowels: [0, 1, 3, 4, 5, 5] });
    if (k % 2 === 1) await nextFrame();
  }
  for (let k = 0; k < 22; k++) {
    // shouting: high, open, held vowels
    const woman = rnd() < .35;
    addVoice(cheer, { f0: woman ? [300, 470] : [180, 320], syll: [.35, 1.3], gap: .25, gain: between(.5, 1), breath: .4, vowels: [0, 0, 1, 3, 2] });
    if (k % 2 === 1) await nextFrame();
  }
  // fans' whistles over the cheering
  for (let k = 0; k < 5; k++) {
    let at = Math.floor(rnd() * (N - SR)), ph = 0;
    const len = Math.floor(between(.3, .9) * SR), f = between(1900, 3000), up = between(-.3, .4), g = between(.05, .1);
    for (let i = 0; i < len; i++, at++) { ph += f * (1 + up * i / len) / SR; cheer[at] += Math.sin(2 * Math.PI * ph) * g * Math.sin(Math.PI * i / len); }
  }
  await nextFrame();
  // applause: hundreds of hands, each clap a short band-passed crack
  const claps = Math.floor((L + X) * 140);
  for (let c = 0; c < claps; c++) {
    const at = Math.floor(rnd() * (N - 600)), f = between(900, 2600), w = 2 * Math.PI * f / SR, al = Math.sin(w) / 2.4, a0 = 1 + al;
    const b = al / a0, a1 = -2 * Math.cos(w) / a0, a2 = (1 - al) / a0, g = between(.3, 1), dec = between(.0015, .004) * SR;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < 400; i++) {
      const s = (rnd() * 2 - 1) * Math.exp(-i / dec) * g;
      const y = b * s - b * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = s; y2 = y1; y1 = y;
      applause[at + i] += y;
    }
    if (c % 120 === 119) await nextFrame();
  }
  return { murmur: loopable(ctx, murmur, L), cheer: loopable(ctx, cheer, L), applause: loopable(ctx, applause, L) };
}

let buffers: Promise<{ murmur: AudioBuffer; cheer: AudioBuffer; applause: AudioBuffer }> | null = null;
function getBuffers(e: Engine) { return (buffers ??= buildBuffers(e.ctx)); }

/** The crowd of one match: a looping murmur, cheering and applause whose levels follow the play. */
export class Crowd {
  private e: Engine | null = null;
  private nodes: { src: AudioBufferSourceNode[]; murmur: GainNode; cheer: GainNode; applause: GainNode; room: GainNode } | null = null;
  private stopped = false;
  private bufs: { murmur: AudioBuffer; cheer: AudioBuffer; applause: AudioBuffer } | null = null;

  /** Builds the loops once the sound engine exists (the first tap); call often, it is cheap. */
  ensure() {
    if (this.nodes || this.stopped) return;
    const e = audioAny();
    if (!e || e.ctx.state !== 'running') return;
    if (!this.bufs) { if (!this.e) { this.e = e; void getBuffers(e).then(b => { this.bufs = b; }); } return; }
    const { ctx } = e;
    const loop = (buf: AudioBuffer, rate: number, bus: Bus, f?: number) => {
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; src.playbackRate.value = rate;
      const g = ctx.createGain(); g.gain.value = 0;
      let node: AudioNode = src;
      if (f) { const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = f; node.connect(lp); node = lp; }
      node.connect(g); g.connect(output(e, bus));
      src.start(ctx.currentTime + .05, Math.random() * buf.duration);
      return { src, g };
    };
    // two copies of the murmur at slightly different speeds: never the same crowd twice
    const m1 = loop(this.bufs.murmur, 1, 'crowd', 3200), m2 = loop(this.bufs.murmur, .93, 'crowd', 2600);
    const murmur = ctx.createGain(); m1.g.disconnect(); m2.g.disconnect(); m1.g.gain.value = .7; m2.g.gain.value = .55;
    m1.g.connect(murmur); m2.g.connect(murmur); murmur.connect(output(e, 'crowd')); murmur.gain.value = 0;
    const ch = loop(this.bufs.cheer, 1, 'crowd', 5000), ap = loop(this.bufs.applause, 1, 'crowd', 7000);
    // the hall itself: a low wash of air and distant voices
    const roomSrc = ctx.createBufferSource(); roomSrc.buffer = e.pink; roomSrc.loop = true;
    const roomLp = ctx.createBiquadFilter(); roomLp.type = 'lowpass'; roomLp.frequency.value = 500;
    const room = ctx.createGain(); room.gain.value = 0;
    roomSrc.connect(roomLp); roomLp.connect(room); room.connect(output(e, 'crowd'));
    roomSrc.start();
    this.nodes = { src: [m1.src, m2.src, ch.src, ap.src, roomSrc], murmur, cheer: ch.g, applause: ap.g, room };
    this.e = e;
    murmur.gain.setTargetAtTime(.35, ctx.currentTime, 1);
    room.gain.setTargetAtTime(.25, ctx.currentTime, 1);
  }

  /** The crowd's excitement 0…1 (smoothed): the murmur grows, above about half the cheering comes in. */
  level(excite: number) {
    this.ensure();
    if (!this.nodes || !this.e) return;
    const t = this.e.ctx.currentTime, x = Math.max(0, Math.min(1, excite));
    this.nodes.murmur.gain.setTargetAtTime(.3 + .45 * x, t, .6);
    this.nodes.cheer.gain.setTargetAtTime(Math.max(0, x - .5) * .9, t, .5);
  }

  /** A goal (or a big moment): the cheering explodes, applause follows; `k` 0…1 how big. */
  roar(k = 1, seconds = 5) {
    this.ensure();
    if (!this.nodes || !this.e) return;
    const { cheer, applause } = this.nodes, t = this.e.ctx.currentTime;
    for (const [g, peak, at, len] of [[cheer, 1.3 * k, .02, seconds], [applause, .9 * k, .8, seconds + 3]] as const) {
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(peak, t + at, .12);
      g.gain.setTargetAtTime(0, t + at + len * .5, len * .3);
    }
  }

  /** Polite applause (the visitors' fans after their goal, a big save). */
  applaud(k = .5, seconds = 3) {
    this.ensure();
    if (!this.nodes || !this.e) return;
    const g = this.nodes.applause, t = this.e.ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setTargetAtTime(k, t, .15);
    g.gain.setTargetAtTime(0, t + seconds * .4, seconds * .3);
  }

  /** "Ooh!" (a post, a big chance) — or, `down`, the groan of the home crowd (a penalty, a goal against). */
  ooh(down = false) {
    this.ensure();
    if (!this.nodes || !this.e || !this.bufs) return;
    const e = this.e, { ctx } = e, t = ctx.currentTime + .03;
    const src = ctx.createBufferSource(); src.buffer = this.bufs.cheer; src.playbackRate.value = down ? .8 : 1.05;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.6;
    // the vowel glides: "oo-OH" rises then falls; a groan sinks
    f.frequency.setValueAtTime(down ? 560 : 420, t);
    f.frequency.linearRampToValueAtTime(down ? 300 : 720, t + (down ? 1.2 : .45));
    if (!down) f.frequency.linearRampToValueAtTime(480, t + 1.3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1e-4, t);
    g.gain.linearRampToValueAtTime(down ? 1.3 : 2.2, t + .18);
    g.gain.exponentialRampToValueAtTime(1e-4, t + (down ? 1.6 : 1.5));
    src.connect(f); f.connect(g); g.connect(output(e, 'crowd'));
    src.start(t, Math.random() * 4); src.stop(t + 1.7);
  }

  /** The crowd claps a rhythm (answering the organ): `beats` in seconds from now. */
  clap(beats: number[]) {
    const e = audioAny();
    if (!e || e.ctx.state !== 'running') return;
    const t0 = e.ctx.currentTime + .02;
    for (const b of beats) for (let j = 0; j < 4; j++) {
      noise(e, { t: t0 + b + (Math.random() - .5) * .03, env: { d: .05 }, filter: 'bandpass', f: 1100 + Math.random() * 1200, q: .9, gain: .22, bus: 'crowd' });
    }
  }

  /** Fades the crowd out and frees it (the match screen closes). */
  stop() {
    this.stopped = true;
    if (!this.nodes || !this.e) return;
    const t = this.e.ctx.currentTime;
    for (const g of [this.nodes.murmur, this.nodes.cheer, this.nodes.applause, this.nodes.room]) g.gain.setTargetAtTime(0, t, .3);
    for (const s of this.nodes.src) { try { s.stop(t + 1.5); } catch { /* already stopped */ } }
    this.nodes = null;
  }
}
