// The post-match show (matchOutro.ts → LiveScene3D): a friendly played to its end in 3D opens the show with its
// caption and «К итогам матча ▸»; the button (or the show's end) brings the final sheet; the setting turns it off.
// Uses the development hook window.__playRink (PlayMatch.tsx) to fast-forward each period.
// Run: BASE_URL=http://localhost:5173 node scripts/outro-ui-test.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { serveTestMod } from './testMod.mjs';

const browser = serveTestMod(await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }));
const B = process.env.BASE_URL ?? 'http://localhost:5173';
const errors = [];
const ok = (m) => console.log('ok', m);

/** A friendly between the first and the fourth club, played to the final siren. */
async function playFriendly(settings) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((s) => { localStorage.setItem('khl.settings', JSON.stringify(s)); sessionStorage.setItem('khl.start', 'menu'); },
    { autoReplay: 'off', matchView: '3d', playPeriod: 3, matchIntro: false, matchReplays: false, menuMusic: 'off', sound: false, ...settings });
  await page.goto(B);
  await page.locator('[data-menu-item="play"]').click();
  await page.locator('[data-menu-item="friendly"]').click();
  await page.locator('[data-quick-picker] button').first().click();
  await page.locator('[data-quick-picker] button').nth(3).click();
  await page.locator('[data-quick-start]').click();
  await page.locator('[data-play-start]').click();
  await page.locator('[data-live-3d="ready"]').waitFor({ timeout: 120000 });
  for (let i = 0; i < 8; i++) {
    if (await page.locator('[data-live-outro], [data-play-final], [data-play-so-next]').count()) break;
    await page.evaluate(() => window.__playRink?.()?.runToEnd());
    await page.waitForTimeout(1500);
    const next = page.getByRole('button', { name: /период|овертайм|К буллитам/i });
    if (await next.count() && !await page.locator('[data-live-outro]').count()) { await next.first().click().catch(() => {}); await page.waitForTimeout(800); }
  }
  return page;
}

try {
  const p = await playFriendly({});
  await p.locator('[data-live-outro]').waitFor({ timeout: 60000 });
  await p.locator('[data-live-caption]').filter({ hasText: /Финальная сирена|Чемпион|Серия выиграна/i }).first().waitFor({ timeout: 30000 });
  assert.equal(await p.locator('[data-play-final]').count(), 0, 'the final sheet waits for the show');
  ok('the show opens with its caption after the final siren');
  await p.locator('[data-live-outro-skip]').click();
  const soNext = p.locator('[data-play-so-next]');
  await Promise.race([p.locator('[data-play-final]').waitFor({ timeout: 60000 }), soNext.waitFor({ timeout: 60000 })]);
  if (await soNext.count()) await soNext.click();
  await p.locator('[data-play-final]').waitFor({ timeout: 60000 });
  assert.equal(await p.locator('[data-live-outro]').count(), 0);
  ok('«К итогам матча ▸» brings the final sheet');
  await p.close();

  const q = await playFriendly({ matchOutro: false });
  const soNext2 = q.locator('[data-play-so-next]');
  await Promise.race([q.locator('[data-play-final]').waitFor({ timeout: 60000 }), soNext2.waitFor({ timeout: 60000 })]);
  if (await soNext2.count()) await soNext2.click();
  await q.locator('[data-play-final]').waitFor({ timeout: 60000 });
  assert.equal(await q.locator('[data-live-outro]').count(), 0, 'no show with the setting off');
  ok('«После финальной сирены» off: straight to the final sheet');
  await q.close();
  assert.deepEqual(errors.filter((e) => !/ResizeObserver/.test(e)), [], 'no page errors');
  ok('no page errors');
} finally {
  await browser.close();
}
