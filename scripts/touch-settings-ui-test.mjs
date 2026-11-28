// Настройки → Управление → «Сенсорный экран» on a phone: the tab opens by itself on a touch screen; size, see-through,
// the left hand, the skill stick and the buttons dragged in the preview are kept and drawn so in a played match;
// «Вернуть по умолчанию» puts the standard layout back.
// Run: BASE_URL=http://localhost:5173 node scripts/touch-settings-ui-test.mjs
import assert from 'node:assert/strict';
import { chromium, devices } from '@playwright/test';
import { serveTestMod } from './testMod.mjs';

const browser = serveTestMod(await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] }));
const B = process.env.BASE_URL ?? 'http://localhost:5173';
const errors = [];
const ok = (m) => console.log('ok', m);
const phone = { ...devices['Pixel 7 landscape'] ?? { viewport: { width: 863, height: 360 }, isMobile: true, hasTouch: true } };

try {
  const ctx = await browser.newContext({ ...phone, viewport: { width: 844, height: 390 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { sessionStorage.setItem('khl.start', 'menu'); if (!localStorage.getItem('khl.settings')) localStorage.setItem('khl.settings', JSON.stringify({ matchIntro: false, matchView: '2d', menuMusic: 'off', sound: false })); });
  await page.goto(B);
  await page.locator('[data-menu-item="settings"]').click();
  await page.locator('[data-settings-tab-btn="controls"]').click();
  await page.locator('[data-controls-device="touch"]').waitFor();
  await page.locator('[data-touch-settings]').waitFor();
  ok('a touch screen opens «Управление» on «Сенсорный экран»');

  await page.locator('[data-setting="touchAlpha"] [role=radio]', { hasText: 'Плотно' }).click();
  await page.locator('[data-setting="touchLefty"] [role=radio]', { hasText: 'Левша' }).click();
  await page.locator('[data-setting="touchSkill"] [role=radio]', { hasText: 'Выкл' }).click();
  await page.locator('[data-touch-preview="left"]').waitFor();
  // drag the cluster in the preview: right and up (inward for the left hand)
  const drag = page.locator('[data-touch-drag]');
  await drag.scrollIntoViewIfNeeded();
  const box = await drag.boundingBox();
  const x0 = box.x + box.width * .12, y0 = box.y + box.height * .85;
  await page.mouse.move(x0, y0); await page.mouse.down();
  await page.mouse.move(x0 + 20, y0 - 10, { steps: 4 }); await page.mouse.move(x0 + 40, y0 - 20, { steps: 4 });
  await page.mouse.up();
  // (a bigger cluster after the drag: the match lowers it as far as the screen needs)
  await page.locator('[data-setting="touchSize"] [role=radio]', { hasText: '120%' }).click();
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('khl.settings') ?? '{}'));
  assert.equal(st.touchSize, 1.2); assert.equal(st.touchAlpha, 'solid'); assert.equal(st.touchLefty, true); assert.equal(st.touchSkill, false);
  assert.ok(st.touchShiftX > 40 && st.touchShiftY > 20 && st.touchShiftY <= 33, `dragged: ${st.touchShiftX} × ${st.touchShiftY}`);
  ok(`size, see-through, left hand, skill stick and the drag are kept (${st.touchShiftX} × ${st.touchShiftY})`);
  await page.screenshot({ path: '/tmp/tr/touch-settings.png' });

  // a played friendly draws them so
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.reload();
  await page.locator('[data-menu-item="play"]').click();
  await page.locator('[data-menu-item="friendly"]').click();
  await page.locator('[data-quick-picker] button').first().click();
  await page.locator('[data-quick-picker] button').nth(3).click();
  await page.locator('[data-quick-start]').click();
  await page.locator('[data-play-start]').click();
  await page.locator('[data-play-touch]').waitFor({ timeout: 60000 });
  assert.equal(await page.locator('[data-play-touch]').getAttribute('data-touch-side'), 'left');
  const shot = await page.locator('[data-touch="shoot"]').boundingBox();
  assert.ok(Math.abs(shot.width - 96) < 1.5, `the shot button at 120%: ${shot.width}`);
  assert.ok(shot.x < 844 / 2, 'the buttons on the left');
  assert.ok(shot.x > 8 + st.touchShiftX - 2, `moved in by the shift: ${shot.x}`);
  const ring = await page.locator('[data-play-extra] [data-touch]').evaluateAll((b) => Math.min(...b.map((x) => x.getBoundingClientRect().top)));
  assert.ok(ring >= 100, `the outer arc keeps out of the score bar: ${ring}`);
  const stick = await page.locator('[data-play-stick-zone]').boundingBox();
  assert.ok(stick.x > 844 / 2, 'the skating stick on the right');
  assert.equal(await page.locator('[data-play-skill-zone]').count(), 0, 'no skill stick');
  ok('the match draws the player\'s layout: on the left, 120%, moved in, no skill stick');
  await page.screenshot({ path: '/tmp/tr/touch-match.png' });

  // back to the standard layout
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('khl.settings') ?? '{}'); localStorage.setItem('khl.settings', JSON.stringify(s)); });
  await ctx.close();
  const ctx2 = await browser.newContext({ ...phone, viewport: { width: 844, height: 390 } });
  const p2 = await ctx2.newPage();
  await p2.addInitScript(() => { sessionStorage.setItem('khl.start', 'menu'); localStorage.setItem('khl.settings', JSON.stringify({ touchSize: 1.4, touchLefty: true, touchShiftX: 50, menuMusic: 'off' })); });
  await p2.goto(B);
  await p2.locator('[data-menu-item="settings"]').click();
  await p2.locator('[data-settings-tab-btn="controls"]').click();
  await p2.locator('[data-touch-reset]').click();
  const st2 = await p2.evaluate(() => JSON.parse(localStorage.getItem('khl.settings') ?? '{}'));
  assert.equal(st2.touchSize, 1); assert.equal(st2.touchLefty, false); assert.equal(st2.touchShiftX, 0);
  assert.ok(await p2.locator('[data-touch-reset]').isDisabled());
  ok('«Вернуть по умолчанию» puts the standard layout back');
  await ctx2.close();
  assert.deepEqual(errors, [], 'no page errors');
  ok('no page errors');
} finally {
  await browser.close();
}
