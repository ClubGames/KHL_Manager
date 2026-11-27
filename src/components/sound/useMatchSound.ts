// The match's sound in the app: MatchSound's cues played on the Web Audio engine, a crowd and a skating hiss under them.
import { useEffect, useRef } from 'react';
import { audio, audioAny, installSoundUnlock } from './engine';
import { Crowd } from './crowd';
import { MatchSound, type Cue, type SoundSink, type SoundSource } from './matchSound';
import { playRiff, stoppageRiff } from './organ';
import * as sfx from './sfx';

class WebSink implements SoundSink {
  readonly crowdNoise = new Crowd();
  private skate: { src: AudioBufferSourceNode; g: GainNode } | null = null;
  private lastCrowd = 0;
  private closed = false;

  cue(c: Cue) {
    switch (c.k) {
      case 'stick': sfx.stickHit(c.power, c.kind, c.pan); break;
      case 'boards': sfx.boards(c.power, c.pan); break;
      case 'glass': sfx.glass(c.power, c.pan); break;
      case 'post': sfx.post(c.pan); break;
      case 'check': sfx.bodyCheck(c.power, c.wall, c.pan); break;
      case 'save': sfx.save(c.pad, c.pan); break;
      case 'block': sfx.block(c.pan); break;
      case 'whistle': sfx.whistle(c.long); break;
      case 'drop': sfx.faceoffDrop(c.pan); break;
      case 'siren': sfx.periodSiren(); this.crowdNoise.applaud(.6, 4); break;
      case 'skateStop': sfx.skateStop(c.power, c.pan); break;
      case 'ooh': this.crowdNoise.ooh(false); break;
      case 'groan': this.crowdNoise.ooh(true); break;
      case 'applause': this.crowdNoise.applaud(c.k2, 3); break;
      case 'goal':
        sfx.netRipple(c.pan);
        if (c.home) { sfx.goalHorn(); this.crowdNoise.roar(1, 6); }
        else { this.crowdNoise.ooh(true); this.crowdNoise.applaud(.3, 2.5); }
        break;
      case 'organ': {
        const r = playRiff(c.riff === 'goal' ? 'goal' : stoppageRiff());
        if (r?.claps.length) this.crowdNoise.clap(r.claps);
        break;
      }
    }
  }

  crowd(excite: number) {
    const now = performance.now();
    if (now - this.lastCrowd < 120) return;
    this.lastCrowd = now;
    this.crowdNoise.level(excite);
  }

  skating(level: number) {
    const e = audio();
    if (!e || this.closed) return;
    if (!this.skate) {
      // blades on ice: a soft high hiss with the rhythm of strides
      const src = e.ctx.createBufferSource(); src.buffer = e.pink; src.loop = true;
      const hp = e.ctx.createBiquadFilter(); hp.type = 'bandpass'; hp.frequency.value = 4200; hp.Q.value = .6;
      const stride = e.ctx.createGain(); stride.gain.value = .7;
      const lfo = e.ctx.createOscillator(); lfo.frequency.value = 2.2;
      const depth = e.ctx.createGain(); depth.gain.value = .3;
      lfo.connect(depth); depth.connect(stride.gain);
      const g = e.ctx.createGain(); g.gain.value = 0;
      src.connect(hp); hp.connect(stride); stride.connect(g); g.connect(e.bus.sfx);
      src.start(); lfo.start();
      this.skate = { src, g };
      src.onended = () => { try { lfo.stop(); } catch { /* stopped */ } };
    }
    this.skate.g.gain.setTargetAtTime(level * .1, e.ctx.currentTime, .25);
  }

  close() {
    this.closed = true;
    this.crowdNoise.stop();
    const e = audioAny();
    if (this.skate && e) { this.skate.g.gain.setTargetAtTime(0, e.ctx.currentTime, .1); try { this.skate.src.stop(e.ctx.currentTime + .5); } catch { /* stopped */ } }
    this.skate = null;
  }
}

/** Only one match screen sounds at a time (the match screen may mount its rink twice for two layouts). */
let owner: symbol | null = null;

/**
 * The sound of a live match (watched or played): call from the rink view with its LiveSource and ticker; `running`
 * false while paused or while a replay has the screen.
 */
export function useMatchSound(ai: SoundSource | null, ticker: { tau?: number }, running: boolean) {
  const run = useRef(running); run.current = running;
  useEffect(() => {
    if (!ai) return;
    installSoundUnlock();
    const me = Symbol('match-sound');
    const sink = new WebSink();
    const driver = new MatchSound(sink, (Math.random() * 2 ** 31) | 0);
    let raf = 0;
    const tick = () => {
      if (owner === null) owner = me;
      if (owner === me) driver.update(ai, ticker.tau ?? 0, run.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); if (owner === me) owner = null; sink.close(); };
  }, [ai, ticker]);
}
