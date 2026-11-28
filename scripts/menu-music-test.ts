// The menu music's score (sound/menuMusic.ts): the form (intro once, then a 28-bar loop: verse, chorus, verse 2,
// breakdown), the layers by section (drums and the melody only where they belong), notes in a sane range, and the
// settings of the menu music and the interface clicks.
// Run: npx tsx scripts/menu-music-test.ts
import assert from 'node:assert/strict';
import { barInfo, BPM, menuScore, STEP, type MusicEvent } from '../src/components/sound/menuMusic';
import { defaultSettings, sanitizeSettings } from '../src/game/settings';

let pass = 0;
const test = (name: string, fn: () => void) => { fn(); pass++; console.log('✓', name); };
const bar = (b: number) => Array.from({ length: 16 }, (_, s) => menuScore(b * 16 + s)).flat();
const has = (evs: MusicEvent[], k: MusicEvent['k']) => evs.some(e => e.k === k);

test('the form: a 4-bar intro once, then verse 8 · chorus 8 · verse 8 · breakdown 4, looping', () => {
  assert.equal(barInfo(0).section, 'intro');
  assert.deepEqual([4, 12, 20, 28].map(b => barInfo(b).section), ['verse', 'chorus', 'verse2', 'break']);
  for (let b = 4; b < 32; b++) assert.deepEqual(barInfo(b), barInfo(b + 28), `bar ${b} comes back`);
  assert.equal(barInfo(32).section, 'verse', 'after the breakdown — the verse, not the intro');
  assert.ok(Math.abs(STEP - 60 / BPM / 4) < 1e-9);
  const loop = 28 * 16 * STEP;
  assert.ok(loop > 60 && loop < 90, `the loop lasts ${loop.toFixed(0)} s`);
});

test('the layers: the pad every bar; drums in the chorus and the second verse; the melody only in the chorus', () => {
  for (let b = 0; b < 32; b++) assert.ok(has(bar(b), 'pad'), `pad in bar ${b}`);
  for (const b of [0, 1, 4, 8, 28]) assert.ok(!has(bar(b), 'kick'), `no kick in bar ${b}`);
  for (const b of [12, 16, 20, 24]) { assert.ok(has(bar(b), 'kick')); assert.ok(has(bar(b), 'snare')); }
  for (let b = 0; b < 32; b++) assert.equal(has(bar(b), 'bell'), barInfo(b).section === 'chorus', `bell in bar ${b}`);
  assert.ok(!has(bar(0), 'arp') && has(bar(2), 'arp'), 'the arpeggio comes in during the intro');
  assert.ok(!has(bar(0), 'bass') && has(bar(4), 'bass'));
});

test('the notes stay in range: bass low, bell and arpeggio up, the melody resolves home', () => {
  for (let i = 0; i < 32 * 16; i++) for (const e of menuScore(i)) {
    if (e.k === 'bass') assert.ok(e.note >= 24 && e.note <= 48);
    if (e.k === 'bell') assert.ok(e.note >= 60 && e.note <= 88);
    if (e.k === 'arp') assert.ok(e.note >= 60 && e.note <= 96);
    if (e.k === 'pad') assert.ok(e.notes.every(n => n >= 48 && n <= 76));
  }
  const last = bar(19).filter(e => e.k === 'bell');
  assert.equal((last[0] as { note: number }).note % 12, 0, 'the chorus ends on C');
});

test('the settings: menu music normal and the clicks on by default, junk falls back', () => {
  assert.equal(defaultSettings().menuMusic, 'normal');
  assert.equal(defaultSettings().uiSounds, true);
  assert.equal(sanitizeSettings({ menuMusic: 'loud', uiSounds: 'yes' }).menuMusic, 'normal');
  assert.equal(sanitizeSettings({ menuMusic: 'off', uiSounds: false }).uiSounds, false);
  assert.equal(sanitizeSettings({ menuMusic: 'quiet' }).menuMusic, 'quiet');
});

console.log(`\n${pass} menu music tests passed`);
