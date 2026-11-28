// The phone controls' layout (touchLayout.ts) and their settings (settings.ts): the standard layout is the one the
// match always had; size scales it about the corner; the shift moves the whole cluster; the settings are sanitized.
// Run: npx tsx scripts/touch-layout-test.ts
import assert from 'node:assert/strict';
import { touchLayout } from '../src/components/touchLayout';
import { defaultSettings, sanitizeSettings, TOUCH_SHIFT } from '../src/game/settings';

let n = 0;
const ok = (m: string) => { n++; console.log('✓', m); };
const std = touchLayout({ touchSize: 1, touchShiftX: 0, touchShiftY: 0, touchLefty: false });

// the old hand-written positions: shot 80 in the corner; pass 64, deke and burst 54 on the arc of 100 round its centre
assert.deepEqual(std.shoot, { x: 0, y: 0, size: 80 });
assert.ok(Math.abs(std.pass.x - 108) < 1e-9 && Math.abs(std.pass.y - 8) < 1e-9 && std.pass.size === 64, JSON.stringify(std.pass));
assert.ok(Math.abs(std.sprint.x - 13) < 1e-9 && Math.abs(std.sprint.y - 113) < 1e-9, JSON.stringify(std.sprint));
assert.deepEqual(std.faceoff, { x: 232, y: 10, w: 136, h: 64 });
assert.equal(std.skillGap, 250);
assert.equal(std.side, 'right');
ok('the standard layout is the one the match always had');

const big = touchLayout({ touchSize: 1.4, touchShiftX: 0, touchShiftY: 0, touchLefty: false });
for (const k of ['shoot', 'pass', 'deke', 'sprint'] as const) {
  assert.ok(Math.abs(big[k].size - std[k].size * 1.4) < 1e-9, k);
  // centres scale about the shot button's centre-to-corner frame: still clear of each other
  const c = (p: { x: number; y: number; size: number }) => [p.x + p.size / 2, p.y + p.size / 2];
  if (k !== 'shoot') { const [ax, ay] = c(big[k]), [bx, by] = c(big.shoot); assert.ok(Math.hypot(ax - bx, ay - by) >= (big[k].size + big.shoot.size) / 2 - 2, `${k} overlaps the shot at 140%`); }
}
assert.ok(big.skillGap > std.skillGap, 'the skill zone keeps clear of the bigger cluster');
ok('the size scales the buttons and their spacing alike');

const moved = touchLayout({ touchSize: 1, touchShiftX: 60, touchShiftY: 40, touchLefty: true });
for (const k of ['shoot', 'pass', 'deke', 'sprint'] as const) { assert.equal(moved[k].x, std[k].x + 60); assert.equal(moved[k].y, std[k].y + 40); }
assert.equal(moved.ring(2, 5).x, std.ring(2, 5).x + 60);
assert.equal(moved.side, 'left');
ok('the shift moves the whole cluster; the left hand mirrors it');

const d = defaultSettings();
assert.equal(d.touchSize, 1); assert.equal(d.touchAlpha, 'normal'); assert.equal(d.touchLefty, false); assert.equal(d.touchSkill, true);
const s = sanitizeSettings({ touchSize: 3, touchAlpha: 'x', touchLefty: 'yes', touchShiftX: 9999, touchShiftY: -5, touchStick: 'fixed', touchHaptics: false });
assert.equal(s.touchSize, 1); assert.equal(s.touchAlpha, 'normal'); assert.equal(s.touchLefty, false);
assert.equal(s.touchShiftX, TOUCH_SHIFT.x); assert.equal(s.touchShiftY, 0); assert.equal(s.touchStick, 'fixed'); assert.equal(s.touchHaptics, false);
assert.equal(sanitizeSettings({ touchShiftX: 33.6 }).touchShiftX, 34);
ok('the settings: defaults, bad values back to the default, the shift clamped and rounded');
console.log(`\n${n} touch layout tests passed`);
