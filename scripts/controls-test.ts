// Rebinding the controls of a played match (settings → «Управление»): a key into a slot (taken from the binding that
// held it), clearing a slot, pad buttons (shared allowed), the reset per device, the stored form (only what differs
// from the defaults, sanitized), and the live maps every reader uses following the settings at once.
// Run: npx tsx scripts/controls-test.ts
import assert from 'node:assert/strict';
import { getSettings, resetSettings, sanitizeSettings, setSettings } from '../src/game/settings';
import {
  bindButton, bindButtons, bindKey, bindKeys, CAPTURED, COMMAND_KEYS, DEFAULT_KEYS, gamepadPad, KEY_BINDS, keyBindsOf, keyboardPad, keyLabel, KEYS, PAD, PAD_BINDS, padBindsOf, resetControls,
} from '../src/components/playInput';

let pass = 0;
const test = (name: string, fn: () => void) => { fn(); pass++; console.log('✓', name); };
const btns = (...on: number[]) => Array.from({ length: 17 }, (_, j) => ({ pressed: on.includes(j), value: on.includes(j) ? 1 : 0 }));
const gp = (...on: number[]) => gamepadPad([{ axes: [0, 0, 0, 0], buttons: btns(...on) }]);

test('the defaults: every key does one thing, the labels read like the keys', () => {
  const all = Object.values(keyBindsOf({})).flat();
  assert.equal(new Set(all).size, all.length, 'no key twice');
  assert.equal(keyLabel('KeyW'), 'W'); assert.equal(keyLabel('Space'), 'Пробел'); assert.equal(keyLabel('Digit4'), '4'); assert.equal(keyLabel('ArrowUp'), '↑'); assert.equal(keyLabel('Semicolon'), ';');
  assert.equal(bindKeys('shoot'), 'Пробел / J');
  assert.equal(bindButtons('pass'), 'RT');
});

test('a key into a slot: taken from the binding that held it; only the changes are stored', () => {
  const r = bindKey({}, 'shoot', 1, 'KeyK');
  assert.deepEqual(r.moved, ['pass']);
  assert.deepEqual(r.controls.keys, { shoot: ['Space', 'KeyK'], pass: ['KeyE'] });
  // back to J: shoot as by default again, pass keeps only E
  const r2 = bindKey(r.controls, 'shoot', 1, 'KeyJ');
  assert.deepEqual(r2.controls.keys, { pass: ['KeyE'] });
  // clearing a slot; the first slot of an empty binding
  assert.deepEqual(bindKey({}, 'pull', 0, null).controls.keys, { pull: [] });
  assert.deepEqual(bindKey({}, 'changeF', 0, 'Digit7').controls.keys, { changeF: ['Digit7'] });
  // the move keys too
  const m = bindKey({}, 'up', 0, 'KeyI');
  assert.deepEqual(m.moved, ['lift']);
  assert.deepEqual(m.controls.keys?.up, ['KeyI', 'ArrowUp']);
});

test('the live maps follow the settings at once: keyboardPad, the commands, the captured keys', () => {
  resetSettings();
  setSettings({ controls: bindKey(bindKey({}, 'shoot', 0, 'KeyP').controls, 'up', 0, 'KeyI').controls });
  assert.deepEqual(KEYS.shoot, ['KeyP', 'KeyJ']);
  assert.equal(keyboardPad(new Set(['KeyP'])).shoot, true);
  assert.equal(keyboardPad(new Set(['Space'])).shoot, false, 'the old key does nothing now');
  assert.ok(!COMMAND_KEYS.pause.includes('KeyP'), 'P left the pause');
  assert.deepEqual(COMMAND_KEYS.pause, ['Escape']);
  assert.equal(keyboardPad(new Set(['KeyI'])).my, -1, 'I skates forward');
  assert.equal(keyboardPad(new Set(['KeyI'])).lift, false, 'and no longer lifts');
  assert.equal(keyboardPad(new Set(['KeyW'])).my, 0);
  assert.ok(CAPTURED.has('KeyI') && !CAPTURED.has('KeyW'));
  resetSettings();
  assert.deepEqual(KEYS.shoot, [...DEFAULT_KEYS.shoot]);
  assert.equal(keyboardPad(new Set(['KeyW'])).my, -1);
});

test('pad buttons: rebound, shared allowed (with the others named), cleared; gamepadPad follows', () => {
  const r = bindButton({}, 'pass', 0, PAD.A);
  assert.deepEqual(r.shared, ['lift']);
  assert.deepEqual(r.controls.pad, { pass: [PAD.A] });
  resetSettings();
  setSettings({ controls: r.controls });
  assert.equal(gp(PAD.A).pad.pass, true);
  assert.equal(gp(PAD.RT).pad.pass, false);
  // RB pokes by its binding now
  setSettings({ controls: bindButton(getSettings().controls, 'poke', 0, PAD.X).controls });
  assert.equal(gp(PAD.X).pad.poke, true);
  assert.equal(gp(PAD.RB).pad.poke, false);
  // a command on a button
  setSettings({ controls: bindButton(getSettings().controls, 'timeout', 0, PAD.L3).controls });
  assert.ok(gp(PAD.L3).commands.has('timeout'));
  assert.deepEqual(bindButton({}, 'pull', 0, null).controls.pad, { pull: [] });
  assert.ok(PAD_BINDS.every(b => Array.isArray(padBindsOf({})[b])));
  resetSettings();
  assert.equal(gp(PAD.RB).pad.poke, true);
});

test('the reset per device keeps the other one', () => {
  const c = { keys: { shoot: ['KeyP'] }, pad: { pass: [0] } };
  assert.deepEqual(resetControls(c, 'keyboard'), { pad: { pass: [0] } });
  assert.deepEqual(resetControls(c, 'gamepad'), { keys: { shoot: ['KeyP'] } });
});

test('stored bindings are sanitized (junk dropped, duplicates merged)', () => {
  const s = sanitizeSettings({ controls: { keys: { shoot: ['KeyP', 'KeyP'], 'bad name!': ['KeyA'], pass: 'KeyE', deke: [1] }, pad: { pass: [7, 99], poke: [5] } } });
  assert.deepEqual(s.controls, { keys: { shoot: ['KeyP'] }, pad: { poke: [5] } });
  assert.deepEqual(sanitizeSettings({ controls: 'x' }).controls, {});
  assert.deepEqual(sanitizeSettings({}).controls, {});
  assert.ok(KEY_BINDS.length >= 29);
});

console.log(`\n${pass} controls tests passed`);
