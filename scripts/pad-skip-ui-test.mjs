// A on the gamepad presses the broadcast's skip buttons (gamepadNav.ts, data-pad-a) even while the played match holds
// the pad: the teams' entrance («Пропустить ▸») and the post-match show («К итогам матча ▸»); the button shows an «A»
// once the pad is in use, and the press does not reach the game (padSwallow.ts).
// Run: BASE_URL=http://localhost:5173 node scripts/pad-skip-ui-test.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { serveTestMod } from './testMod.mjs';

const browser = serveTestMod(await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }));
const B = process.env.BASE_URL ?? 'http://localhost:5173';
const errors = [];
const ok = (m) => console.log('ok', m);

try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((s) => {
    localStorage.setItem('khl.settings', JSON.stringify(s)); sessionStorage.setItem('khl.start', 'menu');
    const pad = { id: 'Test pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 1, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    window.__pad = pad; navigator.getGamepads = () => [pad];
  }, { autoReplay: 'off', matchView: '3d', playPeriod: 3, matchIntro: true, matchReplays: false, menuMusic: 'off', sound: false });
  // (held long enough for a frame of the software-rendered 3D in the test browser)
  const btn = async (i, ms = 700) => {
    await page.evaluate((i) => { window.__pad.buttons[i] = { pressed: true, value: 1 }; window.__pad.timestamp++; }, i); await page.waitForTimeout(ms);
    await page.evaluate((i) => { window.__pad.buttons[i] = { pressed: false, value: 0 }; window.__pad.timestamp++; }, i); await page.waitForTimeout(200);
  };
  await page.goto(B);
  await page.locator('[data-menu-item="play"]').click();
  await page.locator('[data-menu-item="friendly"]').click();
  await page.locator('[data-quick-picker] button').first().click();
  await page.locator('[data-quick-picker] button').nth(3).click();
  await page.locator('[data-quick-start]').click();
  await page.locator('[data-play-start]').click();
  await page.locator('[data-live-intro-skip]').waitFor({ timeout: 120000 });
  const shots0 = await page.evaluate(() => window.__playRink?.()?.passes ?? null);
  await btn(0);
  await page.locator('[data-live-intro]').waitFor({ state: 'detached', timeout: 20000 });
  assert.ok(await page.evaluate(() => document.documentElement.classList.contains('pad-nav')), 'the pad in use');
  ok('A skips the teams\' entrance while the match holds the pad');
  void shots0;

  for (let i = 0; i < 8; i++) {
    if (await page.locator('[data-live-outro], [data-play-final], [data-play-so-next]').count()) break;
    await page.evaluate(() => window.__playRink?.()?.runToEnd());
    await page.waitForTimeout(1500);
    const next = page.getByRole('button', { name: /период|овертайм|К буллитам/i });
    if (await next.count() && !await page.locator('[data-live-outro]').count()) { await next.first().click().catch(() => {}); await page.waitForTimeout(800); }
  }
  await page.locator('[data-live-outro-skip]').waitFor({ timeout: 60000 });
  // the pad in use: an «A» on the button (a stick nudge, not a press)
  await page.evaluate(() => { window.__pad.buttons[12] = { pressed: true, value: 1 }; });
  await page.waitForFunction(() => document.documentElement.classList.contains('pad-nav'), null, { timeout: 10000 });
  await page.evaluate(() => { window.__pad.buttons[12] = { pressed: false, value: 0 }; });
  assert.ok(await page.locator('[data-live-outro-skip] [data-pad-glyph]').isVisible(), 'an «A» on the button');
  await btn(0);
  const soNext = page.locator('[data-play-so-next]');
  await Promise.race([page.locator('[data-play-final]').waitFor({ timeout: 60000 }), soNext.waitFor({ timeout: 60000 })]);
  assert.equal(await page.locator('[data-live-outro]').count(), 0);
  ok('A skips the post-match show');
  assert.deepEqual(errors, [], 'no page errors');
  ok('no page errors');
} finally {
  await browser.close();
}
