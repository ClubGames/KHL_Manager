// Real browser checks of the lineup editor's special teams (start Vite first, same env as rink-ui-test.mjs):
// putting a skater on the PP / PK never pulls him out of the 5-on-5 lines; «Авто ЧБ» refills the PP.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { serveTestMod } from './testMod.mjs';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
serveTestMod(browser);
const errors = [];
const ok = (m) => console.log('ok', m);
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('khl.settings', JSON.stringify({ autoReplay: 'off', replay3d: false, replayPrewarm: false })));
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(process.env.BASE_URL ?? 'http://localhost:5173');
  await page.getByRole('button', { name: /^СКА/ }).click();
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).click();
  await page.getByRole('button', { name: /Звенья/ }).first().click();
  const pp1 = page.locator('[data-line-block="1-я бригада большинства"]');
  await pp1.waitFor();

  const evenNames = () => page.evaluate(() => [...document.querySelectorAll('[data-line-block]')]
    .filter((b) => /звено|пара/.test(b.getAttribute('data-line-block') ?? ''))
    .flatMap((b) => [...b.querySelectorAll('[data-slot-name] span:last-child')].map((x) => x.textContent)));
  const before = await evenNames();
  assert.equal(before.length, 18, '12 forwards + 6 defencemen dressed');
  assert.equal(await pp1.locator('[data-slot-note]').count(), 5, 'PP slots show the 5-on-5 line of each player');

  // Quick-swap (⇄) on the first PP forward: candidates are the dressed skaters, labelled with their line.
  await pp1.getByRole('button', { name: 'Быстрая замена' }).first().click();
  const modal = page.locator('[role="dialog"], .fixed').filter({ hasText: 'бригада большинства' }).last();
  await modal.getByText(/4-е звено/).first().waitFor();
  const cand = modal.locator('button').filter({ hasText: /4-е звено/ }).first();
  const candName = (await cand.locator('.truncate').first().textContent()).trim();
  await cand.click();
  await page.waitForTimeout(200);
  assert.equal((await pp1.locator('[data-slot-name] span:last-child').first().textContent()).trim(), candName, 'picked player is on PP1');
  assert.deepEqual(await evenNames(), before, '5-on-5 lines unchanged after a PP pick');
  ok(`PP pick (${candName}, 4th line) keeps the even-strength lines intact`);

  // Click-to-swap: a 5-on-5 player clicked, then a PK slot → copied, not moved.
  const firstD = page.locator('[data-line-block="1-я пара"] [data-slot] > button').first();
  const dName = (await firstD.locator('[data-slot-name] span:last-child').textContent()).trim();
  await firstD.click();
  await page.locator('[data-line-block="2-я четвёрка меньшинства"] [data-slot] > button').nth(3).click();
  await page.waitForTimeout(200);
  assert.equal((await page.locator('[data-line-block="2-я четвёрка меньшинства"] [data-slot-name] span:last-child').nth(3).textContent()).trim(), dName);
  assert.deepEqual(await evenNames(), before, '5-on-5 lines unchanged after a click-swap into the PK');
  ok(`click-swap ${dName}: 1st pair → PK2 copies him, the pair keeps him`);

  await page.getByRole('button', { name: 'Авто ЧБ' }).click();
  await page.waitForTimeout(200);
  assert.equal(await pp1.locator('[data-slot-name]').count(), 5);
  assert.deepEqual(await evenNames(), before);
  ok('«Авто ЧБ» refills the PP without touching the lines');
  await page.screenshot({ path: '.arena/lines-special.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS lines UI');
} finally {
  await browser.close();
}
