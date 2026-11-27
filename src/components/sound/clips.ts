// The club's own match recordings (src/assets/sounds, see CREDITS.md there): the goal horn, the end-of-period siren
// and the crowd's joy, boos and whistling. Each file is decoded on its own and its level set by RMS, so one file an
// old web view cannot decode only brings back the synthesized sound in its place (sfx.ts, crowd.ts) — the others
// still play.
import { audioAny, output, type Bus } from './engine';
import hornUrl from '../../assets/sounds/goal_horn.mp3?url';
import sirenUrl from '../../assets/sounds/period_end.mp3?url';
import joyUrl from '../../assets/sounds/crowd_joy.mp3?url';
import booUrl from '../../assets/sounds/crowd_boo.mp3?url';
import whistleUrl from '../../assets/sounds/crowd_whistle.mp3?url';

type Engine = NonNullable<ReturnType<typeof audioAny>>;
export type ClipName = 'horn' | 'siren' | 'joy' | 'boo' | 'whistle';

/** file and the RMS each is brought to (the horn and the siren a little over the crowd, the whistling under it) */
const FILES: Record<ClipName, [string, number]> = {
  horn: [hornUrl, .2], siren: [sirenUrl, .17], joy: [joyUrl, .2], boo: [booUrl, .17], whistle: [whistleUrl, .13],
};

/** Scales a decoded recording in place to `rms` (all channels together). */
export function setRms(b: AudioBuffer, rms: number): AudioBuffer {
  let sum = 0;
  for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) sum += d[i] * d[i]; }
  const k = rms / Math.max(1e-6, Math.sqrt(sum / Math.max(1, b.length * b.numberOfChannels)));
  for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= k; }
  return b;
}

const ready: Partial<Record<ClipName, AudioBuffer | null>> = {};
let loading: Promise<void> | null = null;

/** Starts decoding the recordings (once; call when the sound engine exists — it may still wait for the first tap). */
export function loadClips(e: Engine | null = audioAny()): Promise<void> {
  if (!e) return Promise.resolve();
  return (loading ??= Promise.all((Object.keys(FILES) as ClipName[]).map(async name => {
    const [url, rms] = FILES[name];
    try { ready[name] = setRms(await e.ctx.decodeAudioData(await (await fetch(url)).arrayBuffer()), rms); }
    catch { ready[name] = null; }
  })).then(() => undefined));
}

/** The decoded recording, or null (not loaded yet, or it would not decode: play the synthesized sound instead). */
export function clip(name: ClipName): AudioBuffer | null {
  if (ready[name] === undefined) void loadClips();
  return ready[name] ?? null;
}

export type ClipOpts = {
  bus?: Bus; gain?: number; pan?: number; /** seconds from now */ delay?: number; /** where in the file to start (s) */ offset?: number;
  /** play only this long (s), then fade out over `fade` */ length?: number; fade?: number; /** fade in (s) */ attack?: number; loop?: boolean;
};
export type ClipHandle = { src: AudioBufferSourceNode; g: GainNode; e: Engine };

/** Plays a recording; null when it is not there (the caller falls back to the synthesized sound). */
export function playClip(name: ClipName, o: ClipOpts = {}): ClipHandle | null {
  const e = audioAny(), b = clip(name);
  if (!e || e.ctx.state !== 'running' || !b) return null;
  const { ctx } = e, t = ctx.currentTime + .02 + (o.delay ?? 0), gain = o.gain ?? 1, fade = o.fade ?? .8;
  const src = ctx.createBufferSource(); src.buffer = b; src.loop = !!o.loop;
  const g = ctx.createGain();
  if (o.attack) { g.gain.setValueAtTime(1e-4, t); g.gain.linearRampToValueAtTime(gain, t + o.attack); } else g.gain.setValueAtTime(gain, t);
  src.connect(g); g.connect(output(e, o.bus ?? 'sfx', o.pan ?? 0));
  const offset = Math.max(0, Math.min(b.duration - .1, o.offset ?? 0));
  src.start(t, offset);
  const h: ClipHandle = { src, g, e };
  live.add(h); src.onended = () => live.delete(h);
  if (o.length) {
    const end = t + o.length;
    g.gain.setValueAtTime(gain, Math.max(t + (o.attack ?? 0), end - fade));
    g.gain.linearRampToValueAtTime(1e-4, end);
    src.stop(end + .05);
  }
  return h;
}

/** Every recording still sounding (so leaving the match can silence them all). */
const live = new Set<ClipHandle>();

/** Fades out every recording still playing (the match screen closes: no cheering over the menus). */
export function stopClips(seconds = .4) {
  for (const h of [...live]) { fadeClip(h, seconds); live.delete(h); }
}

/** Fades a playing recording out and stops it. */
export function fadeClip(h: ClipHandle | null, seconds = .8) {
  if (!h) return;
  const t = h.e.ctx.currentTime;
  h.g.gain.cancelScheduledValues(t);
  h.g.gain.setValueAtTime(Math.max(1e-4, h.g.gain.value), t);
  h.g.gain.linearRampToValueAtTime(1e-4, t + seconds);
  try { h.src.stop(t + seconds + .05); } catch { /* stopped */ }
}

/**
 * The home crowd's verdict on the match (call once when it is over): a win — the stands erupt; a loss — they boo.
 * It comes a moment after the final siren.
 */
export function crowdVerdict(homeWon: boolean) {
  if (homeWon) { playClip('joy', { bus: 'crowd', gain: 1.05, delay: 1.2, attack: .25 }); return; }
  const b = clip('boo');
  playClip('boo', { bus: 'crowd', gain: .85, delay: 1.2, attack: .5, offset: b ? Math.random() * Math.max(0, b.duration - 11) : 0, length: 9, fade: 2.5 });
}
