// padSource.ts: phone sensors listed as gamepads are skipped, and a control stuck at full travel from the start
// (seen on Android: an axis at 1 and RT held) is idle until it has been released once.
// npx tsx scripts/pad-source-test.ts
import assert from 'node:assert/strict';
import { pads, resetPadCalibration, type PadLike } from '../src/padSource';

const mk = (id: string, axes = [0, 0, 0, 0], n = 17): PadLike & { buttons: { pressed: boolean; value: number }[] } =>
  ({ id, index: 0, axes: [...axes], buttons: Array.from({ length: n }, () => ({ pressed: false, value: 0 })) });

resetPadCalibration();
assert.equal(pads([mk('uinput-fpc')]).length, 0, 'fingerprint sensor is no gamepad');
assert.equal(pads([mk('gpio-keys', [], 4)]).length, 0, 'gpio keys are no gamepad');
assert.equal(pads([mk('tiny', [], 2)]).length, 0, 'two buttons and no stick: no gamepad');
assert.equal(pads([null, mk('Xbox Wireless Controller (STANDARD GAMEPAD)')]).length, 1, 'a real pad is kept');

resetPadCalibration();
const stuck = mk('Generic USB Joystick', [0, 0, 0, 1]);
stuck.buttons[7] = { pressed: true, value: 1 };
let [p] = pads([stuck]);
assert.equal(p.axes[3], 0, 'an axis stuck from the start reads idle');
assert.equal(p.buttons[7].value, 0, 'a trigger held from the start reads idle');
assert.equal(p.buttons[7].pressed, false);
// released once, then it works
stuck.axes = [0, 0, 0, 0]; stuck.buttons[7] = { pressed: false, value: 0 };
pads([stuck]);
stuck.axes = [0, 0, 0, -0.9]; stuck.buttons[7] = { pressed: true, value: 1 };
[p] = pads([stuck]);
assert.equal(p.axes[3], -0.9, 'after a release the stick reads');
assert.equal(p.buttons[7].pressed, true, 'after a release the trigger reads');

// a different device in the same slot is calibrated afresh
const other = mk('Another pad', [0.95, 0, 0, 0]);
[p] = pads([other]);
assert.equal(p.axes[0], 0, 'a new pad in the slot starts calibrating again');
assert.ok(Number.isFinite(pads([mk('NaN pad', [Number.NaN, 0, 0, 0])])[0].axes[0]), 'NaN axes read as 0');
console.log('pad-source-test: ok');
