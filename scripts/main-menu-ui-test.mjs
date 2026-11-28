// The main menu (MainMenu.tsx): «Играть» → «Карьера», «Онлайн», «Настройки»; ↑ ↓ and Esc; the career screen's
// «← Меню» and Esc back; a reload keeps the screen; «Продолжить» opens the latest career; phones fit without scrolling.
// Run: BASE_URL=http://localhost:5173 node scripts/main-menu-ui-test.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { serveTestMod } from './testMod.mjs';

const browser = serveTestMod(await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] }));
const B = process.env.BASE_URL ?? 'http://localhost:5173';
const errors = [];
const ok = (m) => console.log('ok', m);
/** A page on the main menu (the tests open on the career screen by default, see testMod.mjs). */
async function menuPage(opts) {
  const page = await browser.newPage(opts);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(B);
  await page.evaluate(() => sessionStorage.setItem('khl.start', 'menu'));
  await page.reload();
  await page.locator('[data-main-menu="main"]').waitFor();
  return page;
}
const startCareer = (p) => p.getByRole('button', { name: 'Начать карьеру', exact: true });

try {
  const p = await menuPage({ viewport: { width: 1366, height: 800 } });
  assert.deepEqual(await p.locator('[data-menu-item]').evaluateAll((b) => b.map((x) => x.dataset.menuItem)), ['play', 'online', 'settings'], 'no save yet: no «Продолжить»');
  await p.waitForFunction(() => document.activeElement?.dataset?.menuItem === 'play');
  await p.keyboard.press('ArrowDown');
  assert.equal(await p.evaluate(() => document.activeElement?.dataset?.menuItem), 'online');
  await p.keyboard.press('ArrowUp'); await p.keyboard.press('ArrowUp');
  assert.equal(await p.evaluate(() => document.activeElement?.dataset?.menuItem), 'settings', '↑ wraps round');
  ok('first level: Играть / Онлайн / Настройки, ↑ ↓ walk them');

  await p.locator('[data-menu-item="play"]').click();
  await p.locator('[data-main-menu="play"]').waitFor();
  assert.equal(await p.evaluate(() => document.activeElement?.dataset?.menuItem), 'career');
  await p.keyboard.press('Escape');
  await p.locator('[data-main-menu="main"]').waitFor({ timeout: 2000 });
  await p.locator('[data-menu-item="play"]').click();
  await p.locator('[data-menu-back]').click();
  await p.locator('[data-main-menu="main"]').waitFor({ timeout: 2000 });
  ok('«Играть»: the second level, Esc and «← Назад» go back');

  await p.locator('[data-menu-item="play"]').click();
  await p.locator('[data-menu-item="career"]').click();
  await startCareer(p).waitFor();
  await p.reload();
  await startCareer(p).waitFor();
  await p.keyboard.press('Escape');
  await p.locator('[data-main-menu="main"]').waitFor({ timeout: 2000 });
  await p.locator('[data-menu-item="play"]').click(); await p.locator('[data-menu-item="career"]').click();
  await p.locator('[data-startup-back]').click();
  await p.locator('[data-main-menu="main"]').waitFor({ timeout: 2000 });
  ok('career screen: kept by a reload; Esc and «← Меню» back to the menu');

  await p.locator('[data-menu-item="settings"]').click();
  await p.locator('[data-settings]').waitFor();
  await p.keyboard.press('Escape');
  await p.locator('[data-settings]').waitFor({ state: 'detached' });
  assert.equal(await p.locator('[data-main-menu="main"]').count(), 1, 'Esc closed the settings only');
  await p.locator('[data-menu-item="online"]').click();
  await p.locator('[data-online-screen]').waitFor();
  ok('settings open over the menu; «Онлайн» opens the network game');

  // a career → the menu offers to continue it
  await p.goto(B);
  await p.evaluate(() => sessionStorage.setItem('khl.start', 'career'));
  await p.reload();
  await p.getByRole('button', { name: /^СКА/ }).click();
  await startCareer(p).click();
  await p.getByRole('button', { name: 'Симулировать до матча', exact: true }).first().waitFor();
  await p.waitForTimeout(1200);
  await p.evaluate(() => sessionStorage.setItem('khl.start', 'menu'));
  await p.goto(B);
  await p.locator('[data-menu-item="continue"]').waitFor();
  assert.match(await p.locator('[data-menu-item="continue"]').innerText(), /Продолжить[\s\S]*СКА[\s\S]*матч 1 из/i);
  await p.locator('[data-menu-item="continue"]').click();
  await p.getByRole('button', { name: 'Симулировать до матча', exact: true }).first().waitFor({ timeout: 15000 });
  ok('«Продолжить»: the latest career, one click');

  for (const [w, h] of [[390, 844], [844, 390]]) {
    const ph = await menuPage({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
    const over = await ph.evaluate(() => [document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight]);
    assert.deepEqual(over, [0, 0], `${w}×${h}: no scrolling`);
    const last = await ph.locator('[data-menu-item="settings"]').boundingBox();
    assert.ok(last.y + last.height <= h && last.x + last.width <= w, `${w}×${h}: the menu is on screen`);
    await ph.close();
  }
  ok('phone portrait and landscape: the whole menu on screen');
  assert.deepEqual(errors, []);
  console.log('main-menu-ui-test: ok');
} finally {
  await browser.close();
}
