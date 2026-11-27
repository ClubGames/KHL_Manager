// The match sound's driver (src/components/sound/matchSound.ts) on real matches: a watched period (the rink AI) and an
// AI-against-AI played period. The cues must follow the play: a whistle at each stoppage (the horn instead after a
// goal), the puck dropped at each faceoff, the horn for each home goal, a check for each hit, a save for each save,
// stick sounds for passes and shots, the puck off the boards, the siren at the end, a crowd that rises when the home
// team presses — and no flood of sounds.
// Run: npx tsx scripts/sound-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { GameSim } from '../src/game/engine';
import { RinkAI } from '../src/game/rinkAI';
import { NO_PAD, PlayRink } from '../src/game/playRink';
import { MatchSound, type Cue, type SoundSink, type SoundSource } from '../src/components/sound/matchSound';
import { RINK } from '../src/game/rinkGeometry';

const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
const H = r.teams.find(t => t.id === 'ska')!, A = r.teams.find(t => t.id === 'avangard')!;
let pass = 0;
const test = (name: string, fn: () => void) => { const t = Date.now(); fn(); pass++; console.log('✓', name, `(${((Date.now() - t) / 1000).toFixed(1)} s)`); };

class Recorder implements SoundSink {
  cues: (Cue & { tau: number })[] = [];
  crowdBy: { near: number[]; far: number[]; mid: number[] } = { near: [], far: [], mid: [] };
  skate: number[] = [];
  tau = 0; puckX = 50; homeRight = true; stopped = false;
  cue(c: Cue) { this.cues.push({ ...c, tau: this.tau }); }
  crowd(x: number) {
    if (this.stopped) return;
    const toHomeNet = this.homeRight ? this.puckX : 100 - this.puckX; // percent toward the net the home team attacks
    (toHomeNet > 75 ? this.crowdBy.near : toHomeNet < 25 ? this.crowdBy.far : this.crowdBy.mid).push(x);
  }
  skating(l: number) { this.skate.push(l); }
  count(k: Cue['k'], f?: (c: Cue) => boolean) { return this.cues.filter(c => c.k === k && (!f || f(c))).length; }
}
const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);

/** Plays `src` from 0 to `end` (presentation seconds) at 60 frames a second into a recorder. */
function listen(src: SoundSource, end: number) {
  const rec = new Recorder(), drv = new MatchSound(rec, 7);
  rec.homeRight = !src.flipped;
  for (let tau = 0; tau <= end; tau += 1 / 60) {
    const f = src.frameAt(tau);
    rec.tau = tau; rec.puckX = f.puck.x; rec.stopped = !!f.stopped;
    drv.update(src, tau, true);
  }
  return rec;
}
function stops(src: SoundSource, end: number) {
  let stopsN = 0, drops = 0, prev = false;
  for (let tau = 0; tau <= end; tau += 1 / 60) { const s = !!src.frameAt(tau).stopped; if (s && !prev) stopsN++; if (!s && prev) drops++; prev = s; }
  return { stopsN, drops };
}

test('a watched period (rink AI): whistles, faceoffs, goals, hits, saves, sticks, boards, the siren — in step with the play', () => {
  const sim = new GameSim(H, A, r.players);
  const start = sim.sec, evs = sim.simPeriod();
  const ai = new RinkAI(evs, H, A, r.players, start, sim.sec).runToEnd();
  const end = ai.frames[ai.frames.length - 1].tau;
  const rec = listen(ai, end + 1);
  const { stopsN, drops } = stops(ai, end + 1);
  const plays = (k: string) => ai.plays.filter(p => p.kind === k);
  const goals = plays('goal'), homeGoals = goals.filter(p => p.side === 0).length;
  const c = (k: Cue['k'], f?: (c: Cue) => boolean) => rec.count(k, f);
  const minutes = end / 60;
  console.log(`   ${minutes.toFixed(1)} min: stops ${stopsN} whistles ${c('whistle')} drops ${c('drop')}/${drops} goals ${c('goal')}/${goals.length} (home horn ${c('goal', x => x.k === 'goal' && x.home)}/${homeGoals}) hits ${c('check')}/${plays('hit').length} saves ${c('save')}/${plays('save').length}`);
  console.log(`   passes ${c('stick', x => x.k === 'stick' && x.kind === 'pass')} shots ${c('stick', x => x.k === 'stick' && x.kind === 'shot')} slaps ${c('stick', x => x.k === 'stick' && x.kind === 'slap')} receptions ${c('stick', x => x.k === 'stick' && x.kind === 'receive')} boards ${c('boards')} glass ${c('glass')} stops ${c('skateStop')} sirens ${c('siren')} organ ${c('organ')} ooh ${c('ooh')} boo ${c('boo')} fans whistle ${c('fansWhistle', x => x.k === 'fansWhistle' && x.on)}`);
  console.log(`   crowd: home pressing ${avg(rec.crowdBy.near).toFixed(2)}, centre ${avg(rec.crowdBy.mid).toFixed(2)}, own end ${avg(rec.crowdBy.far).toFixed(2)}; skating ${avg(rec.skate).toFixed(2)}`);
  assert.equal(c('goal'), goals.length, 'a cue for every goal');
  assert.equal(c('goal', x => x.k === 'goal' && x.home), homeGoals, 'the horn for the home goals only');
  assert.equal(c('check'), plays('hit').length, 'every hit is heard');
  assert.equal(c('save'), plays('save').length, 'every save is heard');
  assert.equal(c('drop'), drops, 'every faceoff: the puck dropped');
  // (the opening faceoff has no whistle, the end of the period has the siren, a goal the horn)
  assert.ok(c('whistle') >= stopsN - goals.length - 2 && c('whistle') <= stopsN, `a whistle at the stoppages (${c('whistle')} of ${stopsN})`);
  assert.equal(c('siren'), 1, 'one siren at the end of the period');
  assert.ok(c('stick', x => x.k === 'stick' && x.kind === 'pass') > minutes * 4, 'passes are heard');
  assert.ok(c('stick', x => x.k === 'stick' && (x.kind === 'shot' || x.kind === 'slap')) > 5, 'shots are heard');
  assert.ok(c('stick', x => x.k === 'stick' && x.kind === 'receive') > minutes * 4, 'receptions are heard');
  assert.ok(c('boards') > 3, 'the puck off the boards');
  assert.ok(rec.cues.length < minutes * 160, 'no flood of sounds');
  assert.ok(avg(rec.crowdBy.near) > avg(rec.crowdBy.far) + .1, 'the crowd rises when the home team presses');
  assert.ok(avg(rec.skate) > .15, 'skating is heard');
});

test('a played period (AI against AI on the playable rink): the same sounds, the siren from the clock, no sound while paused', () => {
  const k = new PlayRink({ home: H, away: A, players: r.players, lineups: [H.lineup, A.lineup], userSide: null, kind: 'reg', periodMinutes: 4, seed: 11 });
  // the played rink keeps only recent frames: listen live, as the match screen does
  const rec = new Recorder(), drv = new MatchSound(rec, 5);
  let stopsN = 0, drops = 0, prev = false;
  for (let i = 0; i < 60 * 60 * 6 && !k.ended; i++) {
    k.advance(1 / 60, NO_PAD);
    const tau = Math.max(0, k.tau - 1 / 60), f = k.frameAt(tau);
    rec.tau = tau; rec.puckX = f.puck.x; rec.stopped = !!f.stopped;
    drv.update(k, tau, true);
    const st = !!f.stopped; if (st && !prev) stopsN++; if (!st && prev) drops++; prev = st;
  }
  for (let i = 0; i < 120; i++) drv.update(k, k.tau + i / 60, true);
  assert.ok(k.ended, 'the period is played to its end');
  const end = k.tau;
  const c = (kk: Cue['k'], f?: (c: Cue) => boolean) => rec.count(kk, f);
  const goals = k.plays.filter(p => p.kind === 'goal');
  console.log(`   ${(end / 60).toFixed(1)} min: stops ${stopsN} whistles ${c('whistle')} drops ${c('drop')}/${drops} goals ${c('goal')}/${goals.length} hits ${c('check')} saves ${c('save')} passes ${c('stick', x => x.k === 'stick' && x.kind === 'pass')} shots ${c('stick', x => x.k === 'stick' && x.kind !== 'pass' && x.kind !== 'receive')} receptions ${c('stick', x => x.k === 'stick' && x.kind === 'receive')} boards ${c('boards')} glass ${c('glass')} posts ${c('post')} sirens ${c('siren')} organ ${c('organ')}`);
  assert.equal(c('goal'), goals.length);
  assert.equal(c('drop'), drops);
  assert.equal(c('siren'), 1, 'the siren once (the play and the clock agree)');
  assert.ok(c('whistle') >= stopsN - goals.length - 2, `a whistle at the stoppages (${c('whistle')} of ${stopsN})`);
  assert.ok(c('stick') > end / 60 * 15 && c('boards') + c('glass') + c('post') >= 3, 'sticks and boards');
  // paused: no cues however long
  const rec2 = new Recorder(), drv2 = new MatchSound(rec2, 3);
  drv2.update(k, 10, true);
  for (let i = 0; i < 600; i++) drv2.update(k, 10 + i / 60, false);
  assert.equal(rec2.cues.length, 0, 'nothing while paused');
  // a jump (a replay of a moment, back in time) is skipped silently
  drv2.update(k, 200, true); drv2.update(k, 60, true); drv2.update(k, 60.02, true);
  assert.ok(rec2.cues.length <= 1, 'jumps in time are not replayed as a burst of sounds');
});

test('the home crowd: boos at a home penalty, whistling only while the home team is short-handed and the opponent has the puck in its zone', () => {
  // several watched periods, so there are penalties both ways
  let homePens = 0, boos = 0, on = 0, off = 0, bad = 0, checked = 0;
  for (let n = 0; n < 3; n++) {
    const sim = new GameSim(H, A, r.players);
    const start = sim.sec, evs = sim.simPeriod();
    const ai = new RinkAI(evs, H, A, r.players, start, sim.sec, { flip: n === 1 }).runToEnd();
    const end = ai.frames[ai.frames.length - 1].tau;
    const rec = listen(ai, end + 1);
    homePens += ai.plays.filter(p => p.kind === 'penalty' && p.side === 0 && !p.text.startsWith('Отложенный')).length;
    boos += rec.count('boo');
    // the cues alternate on, off, on … and each "on" comes while home skaters outnumber away ones in the box
    let state = false;
    for (const c of rec.cues) {
      if (c.k !== 'fansWhistle') continue;
      assert.notEqual(c.on, state, 'the whistling turns on and off in turn');
      state = c.on; c.on ? on++ : off++;
      if (c.on) {
        checked++;
        const f = ai.frameAt(c.tau);
        const boxed = f.skaters.reduce((k, s) => k + (s.box ? (s.side === 0 ? 1 : -1) : 0), 0);
        const ownEnd = ai.flipped ? 100 : 0;
        const holder = f.skaters.find(s => s.id === f.carrier);
        if (!(boxed > 0) || Math.abs(f.puck.x - ownEnd) > 45 || holder?.side !== 1) bad++;
      }
    }
  }
  console.log(`   home penalties ${homePens}, boos ${boos}; fans' whistling on ${on} / off ${off}`);
  assert.equal(boos, homePens, 'boos for each home penalty');
  assert.equal(bad, 0, `the whistling only when short-handed with the puck in the home zone (${bad} of ${checked})`);
  assert.ok(on - off <= 1, 'every whistling also stops');
});

test('the rink geometry the driver relies on', () => {
  assert.equal(RINK.length, 60); assert.equal(RINK.width, 30); assert.equal(RINK.goalLine, 4);
});

console.log(`\n${pass} sound tests passed`);
