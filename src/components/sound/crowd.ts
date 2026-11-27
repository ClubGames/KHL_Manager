// The arena crowd. First choice: real recordings — the club's own arena bed (src/assets/sounds/crowd_bed.mp3, under
// it all the match long) with the CC0 indoor crowds of src/assets/crowd/CREDITS.md: louder stands for the dangerous moments, the roar after a goal, applause and an "ooh" — looped with the
// game's own crossfades so no seam is heard. Should they fail to load (an old web view's decoder), the crowd is
// synthesized as before:
// The arena crowd, synthesized. Thousands of people heard from the ice are mostly a wash — a sea of voices too many
// to tell apart, shaped like speech (most of it between 250 Hz and 2.5 kHz) and swelling slowly — with a few nearer
// voices rising out of it now and then. So the murmur is a speech-shaped noise bed with a slow, uneven swell, plus a
// few dozen soft voices (a breathy source through two vowel formants, cut into syllables, most of them far away);
// the cheering is the same with open, held, shouted vowels and a brighter bed; the applause a patter of claps.
// Two murmur loops of different lengths (13 s and 9.4 s) play together, so the crowd never audibly repeats, and
// everything goes through the hall's echo (engine.ts). Built once, spread over frames so the page never stalls.
import { audioAny, noise, output, type Bus } from './engine';
import { clip, fadeClip, loadClips, playClip, type ClipHandle } from './clips';
import bedUrl from '../../assets/sounds/crowd_bed.mp3?url';
import standsUrl from '../../assets/crowd/stands.mp3?url';
import cheerUrl from '../../assets/crowd/cheer.mp3?url';
import applauseUrl from '../../assets/crowd/applause.mp3?url';
import oohUrl from '../../assets/crowd/ooh.mp3?url';

type Engine = NonNullable<ReturnType<typeof audioAny>>;
const SR = 22050;
/** [F1, F2] of the vowels a crowd makes (a, o, u, e, i, and the neutral murmur). */
const VOWELS: [number, number][] = [[800, 1200], [520, 880], [350, 700], [480, 1750], [310, 2150], [560, 1450]];

type Voice = { f0: [number, number]; syll: [number, number]; gap: number; gain: number; breath: number; vowels: number[]; /** 0 near … 1 far */ far: [number, number] };

let seed = 0x9e3779b9;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const between = (a: number, b: number) => a + (b - a) * rnd();

/** Adds one voice to `out`: a soft pulse (a low-passed saw with breath) → two band-pass formants, syllable envelopes, distance. */
function addVoice(out: Float32Array, v: Voice) {
  const n = out.length;
  let i = Math.floor(rnd() * SR * .8), phase = rnd(), soft = 0;
  let x1 = 0, x2 = 0, ya1 = 0, ya2 = 0, yb1 = 0, yb2 = 0, lp = 0;
  const far = between(v.far[0], v.far[1]), dull = 1 - far * .88, level = 1 - far * .7;
  while (i < n) {
    const len = Math.floor(between(v.syll[0], v.syll[1]) * SR), gap = Math.floor(between(.05, v.gap) * SR);
    const [F1, F2] = VOWELS[v.vowels[Math.floor(rnd() * v.vowels.length)]];
    const f1 = F1 * between(.9, 1.12), f2 = F2 * between(.9, 1.12);
    const coef = (f: number, q: number) => { const w = 2 * Math.PI * f / SR, al = Math.sin(w) / (2 * q), a0 = 1 + al; return [al / a0, -2 * Math.cos(w) / a0, (1 - al) / a0]; };
    const [ba, a1a, a2a] = coef(f1, 4), [bb, a1b, a2b] = coef(f2, 5);
    const f0a = between(v.f0[0], v.f0[1]), f0b = f0a * between(.88, 1.15);
    const peak = v.gain * level * between(.45, 1);
    for (let k = 0; k < len && i < n; k++, i++) {
      const u = k / len;
      const env = Math.sin(Math.PI * Math.min(1, u * 1.1)) ** 1.2 * peak;
      phase += (f0a + (f0b - f0a) * u) / SR; if (phase >= 1) phase -= 1;
      // the saw's edge rounded off (a throat, not a buzzer), breath mixed in
      soft += ((phase * 2 - 1) - soft) * .22;
      const src = soft * (1 - v.breath) + (rnd() * 2 - 1) * v.breath;
      const ya = ba * src - ba * x2 - a1a * ya1 - a2a * ya2;
      const yb = bb * src - bb * x2 - a1b * yb1 - a2b * yb2;
      x2 = x1; x1 = src; ya2 = ya1; ya1 = ya; yb2 = yb1; yb1 = yb;
      lp += (ya + yb * .5 - lp) * dull;
      out[i] += lp * env;
    }
    i += gap;
  }
}

/**
 * The bed: a crowd too big to hear one by one — noise through the speech band (two broad resonances), its level
 * wandering slowly and unevenly (a section laughs, another goes quiet), a little syllabic flutter on top.
 */
function addBed(out: Float32Array, o: { lo: number; hi: number; gain: number; flutter: number }) {
  const n = out.length;
  const coef = (f: number, q: number) => { const w = 2 * Math.PI * f / SR, al = Math.sin(w) / (2 * q), a0 = 1 + al; return [al / a0, -2 * Math.cos(w) / a0, (1 - al) / a0]; };
  const [ba, a1a, a2a] = coef(o.lo, .9), [bb, a1b, a2b] = coef(o.hi, 1.1);
  let x1 = 0, x2 = 0, ya1 = 0, ya2 = 0, yb1 = 0, yb2 = 0;
  // the swell: a sum of slow sines with odd periods (never in step with the loop's length)
  const sw = [0, 1, 2].map(() => ({ f: between(.04, .22), p: rnd() * 6.28, a: between(.12, .28) }));
  const fl = [0, 1, 2, 3].map(() => ({ f: between(2.5, 6), p: rnd() * 6.28 }));
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let g = 1;
    for (const w of sw) g += w.a * Math.sin(t * w.f * 6.283 + w.p);
    let f = 0;
    for (const w of fl) f += Math.sin(t * w.f * 6.283 + w.p);
    g *= 1 + o.flutter * f / 4;
    const src = rnd() * 2 - 1;
    const ya = ba * src - ba * x2 - a1a * ya1 - a2a * ya2;
    const yb = bb * src - bb * x2 - a1b * yb1 - a2b * yb2;
    x2 = x1; x1 = src; ya2 = ya1; ya1 = ya; yb2 = yb1; yb1 = yb;
    out[i] += (ya + yb * .7) * g * o.gain;
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

type Buffers = { murmur: AudioBuffer; murmur2: AudioBuffer; cheer: AudioBuffer; applause: AudioBuffer; /** recorded: the louder stands and the "ooh" */ stands?: AudioBuffer; ooh?: AudioBuffer; rec?: boolean };

/**
 * A recording made into a seamless loop: `head` / `tail` seconds cut off (the encoder's padding, a fade baked in),
 * the last `xf` seconds crossfaded (equal power) into the first, the level set to `rms`.
 */
function recLoop(ctx: BaseAudioContext, b: AudioBuffer, head: number, tail: number, xf: number, rms: number): AudioBuffer {
  const sr = b.sampleRate, h = Math.floor(head * sr), len = b.length - h - Math.floor(tail * sr), x = Math.min(Math.floor(xf * sr), Math.floor(len / 3)), n = len - x;
  const out = ctx.createBuffer(b.numberOfChannels, n, sr);
  let sum = 0;
  for (let c = 0; c < b.numberOfChannels; c++) {
    const src = b.getChannelData(c), d = out.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = src[h + i];
    // the loop's end runs into its start: the tail fades out over the head fading in
    for (let i = 0; i < x; i++) { const w = i / x; d[i] = src[h + i] * Math.sin(w * Math.PI / 2) + src[h + n + i] * Math.cos(w * Math.PI / 2); }
    for (let i = 0; i < n; i++) sum += d[i] * d[i];
  }
  const k = rms / Math.max(1e-6, Math.sqrt(sum / (n * b.numberOfChannels)));
  for (let c = 0; c < b.numberOfChannels; c++) { const d = out.getChannelData(c); for (let i = 0; i < n; i++) d[i] *= k; }
  return out;
}

/** The recorded crowd (null when a file does not load or decode: the synthesized one plays then). */
async function recorded(ctx: BaseAudioContext): Promise<Buffers | null> {
  try {
    const dec = async (u: string) => ctx.decodeAudioData(await (await fetch(u)).arrayBuffer());
    const [m, st, ch, ap, oh] = await Promise.all([bedUrl, standsUrl, cheerUrl, applauseUrl, oohUrl].map(dec));
    // the arena bed (100 s): its last two seconds run into its start
    const murmur = recLoop(ctx, m, .05, .05, 2, .2);
    await nextFrame();
    const ooh = recLoop(ctx, oh, .03, 0, 0, .3);
    return { murmur, murmur2: murmur, stands: recLoop(ctx, st, .06, .06, 1, .2), cheer: recLoop(ctx, ch, .4, 1.1, 1.2, .22), applause: recLoop(ctx, ap, .25, 1.6, .9, .2), ooh, rec: true };
  } catch {
    return null;
  }
}

async function murmurOf(ctx: BaseAudioContext, L: number, voices: number): Promise<AudioBuffer> {
  const X = .8, data = new Float32Array(Math.floor((L + X) * SR));
  addBed(data, { lo: between(380, 460), hi: between(1100, 1400), gain: .55, flutter: .35 });
  await nextFrame();
  for (let k = 0; k < voices; k++) {
    const woman = rnd() < .38;
    addVoice(data, { f0: woman ? [175, 250] : [95, 145], syll: [.09, .3], gap: .9, gain: between(.35, 1), breath: .4, vowels: [0, 1, 3, 4, 5, 5], far: k < 4 ? [.15, .45] : [.55, 1] });
    if (k % 3 === 2) await nextFrame();
  }
  return loopable(ctx, data, L);
}

/** The murmurs, the cheering and the applause (built in slices). */
async function buildBuffers(ctx: BaseAudioContext): Promise<Buffers> {
  const murmur = await murmurOf(ctx, 13, 30);
  const murmur2 = await murmurOf(ctx, 9.4, 22);
  // cheering: a roar is mostly a bright wash, with shouted held vowels through it
  const LC = 9, XC = .8, NC = Math.floor((LC + XC) * SR);
  const cheer = new Float32Array(NC);
  addBed(cheer, { lo: 620, hi: 1900, gain: .9, flutter: .15 });
  await nextFrame();
  for (let k = 0; k < 34; k++) {
    const woman = rnd() < .38;
    addVoice(cheer, { f0: woman ? [290, 460] : [170, 300], syll: [.35, 1.4], gap: .35, gain: between(.5, 1), breath: .5, vowels: [0, 0, 1, 3, 2], far: k < 5 ? [.2, .5] : [.5, 1] });
    if (k % 3 === 2) await nextFrame();
  }
  // fans' whistles over the cheering
  for (let k = 0; k < 6; k++) {
    let at = Math.floor(rnd() * (NC - SR)), ph = 0;
    const len = Math.floor(between(.3, .9) * SR), f = between(1900, 3000), up = between(-.3, .4), g = between(.03, .07);
    for (let i = 0; i < len; i++, at++) { ph += f * (1 + up * i / len) / SR; cheer[at] += Math.sin(2 * Math.PI * ph) * g * Math.sin(Math.PI * i / len); }
  }
  await nextFrame();
  // applause: hundreds of hands, each clap a short band-passed crack; the density breathes
  const LA = 8, NA = Math.floor((LA + XC) * SR), applause = new Float32Array(NA);
  const claps = Math.floor((LA + XC) * 160);
  for (let c = 0; c < claps; c++) {
    const at = Math.floor(rnd() * (NA - 600)), f = between(800, 2600), w = 2 * Math.PI * f / SR, al = Math.sin(w) / 2.4, a0 = 1 + al;
    const b = al / a0, a1 = -2 * Math.cos(w) / a0, a2 = (1 - al) / a0, g = between(.25, 1) * (.75 + .25 * Math.sin(at / SR * 1.3)), dec = between(.0015, .004) * SR;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < 400; i++) {
      const s0 = (rnd() * 2 - 1) * Math.exp(-i / dec) * g;
      const y = b * s0 - b * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = s0; y2 = y1; y1 = y;
      applause[at + i] += y;
    }
    if (c % 150 === 149) await nextFrame();
  }
  return { murmur, murmur2, cheer: loopable(ctx, cheer, LC), applause: loopable(ctx, applause, LA) };
}

let buffers: Promise<Buffers> | null = null;
function getBuffers(e: Engine) { return (buffers ??= recorded(e.ctx).then(r => r ?? buildBuffers(e.ctx))); }

/** The crowd of one match: a looping murmur, cheering and applause whose levels follow the play. */
export class Crowd {
  private e: Engine | null = null;
  private nodes: { src: AudioBufferSourceNode[]; murmur: GainNode; cheer: GainNode; applause: GainNode; room: GainNode; stands: GainNode | null } | null = null;
  private stopped = false;
  private bufs: Buffers | null = null;
  /** the crowd's own slow wander (it is never quite the same level for long) */
  private drift = 0;
  private driftTo = 0;
  private driftAt = 0;

  /** Builds the loops once the sound engine exists (the first tap); call often, it is cheap. */
  ensure() {
    if (this.nodes || this.stopped) return;
    const e = audioAny();
    if (!e || e.ctx.state !== 'running') return;
    if (!this.bufs) { if (!this.e) { this.e = e; void loadClips(e); void getBuffers(e).then(b => { this.bufs = b; }); } return; }
    const { ctx } = e;
    const loop = (buf: AudioBuffer, rate: number, bus: Bus, f?: number, pan = 0, at = Math.random() * buf.duration) => {
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; src.playbackRate.value = rate;
      const g = ctx.createGain(); g.gain.value = 0;
      let node: AudioNode = src;
      if (f) { const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = f; node.connect(lp); node = lp; }
      node.connect(g); g.connect(output(e, bus, pan));
      src.start(ctx.currentTime + .05, at % buf.duration);
      return { src, g };
    };
    const b = this.bufs, rec = !!b.rec;
    // two murmurs, one each side: the stands all round, never the same twice (synthesized: two loops of different
    // lengths; recorded: the one recording twice, half of it apart and a shade slower on one side)
    const at1 = Math.random() * b.murmur.duration;
    const m1 = loop(b.murmur, 1, 'crowd', rec ? undefined : 2800, rec ? -.35 : -.55, at1);
    const m2 = loop(b.murmur2, rec ? .985 : .97, 'crowd', rec ? 6500 : 2400, rec ? .35 : .55, rec ? at1 + b.murmur.duration / 2 : undefined);
    const murmur = ctx.createGain(); m1.g.disconnect(); m2.g.disconnect(); m1.g.gain.value = rec ? .5 : .62; m2.g.gain.value = rec ? .5 : .55;
    m1.g.connect(murmur); m2.g.connect(murmur); murmur.connect(output(e, 'crowd')); murmur.gain.value = 0;
    const ch = loop(b.cheer, 1, 'crowd', rec ? undefined : 4600), ap = loop(b.applause, 1, 'crowd', rec ? undefined : 6500);
    // recorded: the louder stands come up with the danger
    const sd = b.stands ? loop(b.stands, 1, 'crowd') : null;
    // the hall itself: ventilation, the ice plant, a distant hum (very low, felt more than heard)
    const roomSrc = ctx.createBufferSource(); roomSrc.buffer = e.pink; roomSrc.loop = true;
    const roomLp = ctx.createBiquadFilter(); roomLp.type = 'lowpass'; roomLp.frequency.value = 260;
    const room = ctx.createGain(); room.gain.value = 0;
    roomSrc.connect(roomLp); roomLp.connect(room); room.connect(output(e, 'crowd'));
    roomSrc.start();
    this.nodes = { src: [m1.src, m2.src, ch.src, ap.src, roomSrc, ...(sd ? [sd.src] : [])], murmur, cheer: ch.g, applause: ap.g, room, stands: sd?.g ?? null };
    this.e = e;
    murmur.gain.setTargetAtTime(rec ? .3 : .24, ctx.currentTime, 1.5);
    room.gain.setTargetAtTime(rec ? .05 : .1, ctx.currentTime, 1.5);
  }

  /** The crowd's excitement 0…1 (smoothed): the murmur grows, above about half the cheering comes in. */
  level(excite: number) {
    this.ensure();
    if (!this.nodes || !this.e) return;
    const t = this.e.ctx.currentTime, x = Math.max(0, Math.min(1, excite));
    // a new direction for the wander every few seconds, glided to slowly
    if (t > this.driftAt) { this.driftTo = (Math.random() - .5) * .16; this.driftAt = t + 3 + Math.random() * 6; }
    this.drift += (this.driftTo - this.drift) * .03;
    // quiet in ordinary play — a crowd does not shout all the time — and up with the danger
    if (this.nodes.stands) {
      // recorded: the murmur is always there; the stands rise with the danger; the roar only at the very top
      this.nodes.murmur.gain.setTargetAtTime(Math.max(.12, .28 + .12 * x + this.drift * .6), t, 1.1);
      this.nodes.stands.gain.setTargetAtTime(.04 + .5 * x * x, t, .8);
      this.nodes.cheer.gain.setTargetAtTime(Math.max(0, x - .7) * 1.2, t, .7);
      return;
    }
    this.nodes.murmur.gain.setTargetAtTime(Math.max(.08, .18 + .3 * x * x + this.drift * .5), t, 1.1);
    this.nodes.cheer.gain.setTargetAtTime(Math.max(0, x - .58) * 1.1, t, .7);
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
    if (this.bufs.ooh) {
      // recorded: the real "ooh"; the groan is the same voices lower, slower and duller
      const src = ctx.createBufferSource(); src.buffer = this.bufs.ooh; src.playbackRate.value = down ? .74 : .95 + Math.random() * .1;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = down ? 1100 : 5000;
      const g = ctx.createGain(); g.gain.value = down ? .8 : 1;
      src.connect(lp); lp.connect(g); g.connect(output(e, 'crowd'));
      src.start(t); return;
    }
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

  /**
   * The fans' joy (the club's recording) over the bed: `k` how loud (1 a home goal; quiet — the visitors' sector — after
   * an away goal), `pan` where in the stands. False when the recording is not there (the caller roars instead).
   */
  joy(k = 1, pan = 0): boolean {
    if (this.stopped || !clip('joy')) return false;
    return !!playClip('joy', { bus: 'crowd', gain: k, pan, attack: .15 });
  }

  /** The home crowd booing for `seconds` (a penalty, a goal against): a stretch of the recording, faded in and out. */
  boo(k = .6, seconds = 4): boolean {
    const b = clip('boo');
    if (this.stopped || !b) return false;
    const len = Math.min(seconds, b.duration - .5);
    fadeClip(this.booing, .3);
    this.booing = playClip('boo', { bus: 'crowd', gain: k, attack: .4, offset: Math.random() * Math.max(0, b.duration - len - .5), length: len, fade: Math.min(1.5, len * .4) });
    return !!this.booing;
  }
  private booing: ClipHandle | null = null;

  /** The home fans whistling (their team short-handed, the opponent in its zone): on — it swells; off — it dies away. */
  whistling(on: boolean) {
    if (on && !this.whistle && !this.stopped) this.whistle = playClip('whistle', { bus: 'crowd', gain: .9, attack: .7, loop: true, offset: Math.random() * 10 });
    else if (!on && this.whistle) { fadeClip(this.whistle, 1.2); this.whistle = null; }
  }
  private whistle: ClipHandle | null = null;

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
    this.whistling(false);
    fadeClip(this.booing, .4); this.booing = null;
    this.stopped = true;
    if (!this.nodes || !this.e) return;
    const t = this.e.ctx.currentTime;
    for (const g of [this.nodes.murmur, this.nodes.cheer, this.nodes.applause, this.nodes.room, this.nodes.stands]) g?.gain.setTargetAtTime(0, t, .3);
    for (const s of this.nodes.src) { try { s.stop(t + 1.5); } catch { /* already stopped */ } }
    this.nodes = null;
  }
}
