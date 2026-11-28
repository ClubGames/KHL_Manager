// Real browser checks for player photos and the club card. Start Vite first (same env as rink-ui-test.mjs).
// khl.ru photos are answered locally with a stub picture so the test works offline; one URL is made to fail
// to check the initials fallback.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { HAS_REAL_MOD, START_IN_CAREER } from './testMod.mjs';
// player photos come from the KHL_2627 mod, which is not in the repository (the game ships with its own invented league «ХЛ» instead)
if (!HAS_REAL_MOD) {
  console.log('SKIP: put the KHL_2627 mod into public/mods to run this test');
  process.exit(0);
}

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const errors = [];
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><rect width="120" height="160" fill="#2a4466"/><circle cx="60" cy="58" r="30" fill="#e8c9a8"/><rect x="20" y="100" width="80" height="60" rx="20" fill="#c41e24"/></svg>';
let broken = null;
const ok = (m) => console.log('ok', m);
const open = async (viewport = { width: 1280, height: 900 }, extra = {}) => {
  const page = await browser.newPage({ viewport, ...extra });
  await page.addInitScript(START_IN_CAREER);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/khl\.ru\/img\//, (route) => {
    if (!broken) broken = route.request().url();
    return route.request().url() === broken ? route.fulfill({ status: 404, body: '' }) : route.fulfill({ status: 200, contentType: 'image/svg+xml', body: SVG });
  });
  await page.goto(process.env.BASE_URL ?? 'http://localhost:5173');
  return page;
};
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

try {
  const page = await open();
  // Selection screen: picking a club shows its overview with photos
  await page.getByRole('button', { name: /^СКА/ }).click();
  const preview = page.locator('[data-club-preview="ska"]');
  await preview.waitFor();
  await preview.getByText('Лучшие игроки').waitFor();
  await page.waitForTimeout(400);
  assert.ok((await preview.locator('[data-face="photo"]').count()) >= 3, 'photos in the preview');
  await page.screenshot({ path: '.arena/select-preview.png', fullPage: true });
  ok('club selection: overview with staff, units and photos appears after a tap');

  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).click();
  // Dashboard: next-match block opens the club card
  const nextTeam = page.locator('[data-team-link]').first();
  await nextTeam.click();
  const modal = page.locator('[data-team-modal]');
  await modal.waitFor();
  const teamId = await modal.getAttribute('data-team-modal');
  await modal.getByText('Тренерский штаб').waitFor();
  ok(`dashboard: club card opens (${teamId})`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: '.arena/team-card.png' });

  // Roster tab and player card on top; Escape closes only the top modal
  await modal.getByRole('button', { name: /^Состав \(/ }).click();
  await modal.locator('[data-team-roster] button').first().click();
  const face = page.locator('[data-player-face]');
  await face.waitFor();
  await page.keyboard.press('Escape');
  await face.waitFor({ state: 'detached' });
  assert.equal(await modal.count(), 1, 'club card is still open');
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'detached' });
  ok('club card → roster → player card; Escape closes one modal at a time');

  // Standings row
  await page.getByRole('button', { name: 'Таблица', exact: true }).first().click();
  await page.locator('[data-team-row="avangard"]').first().click();
  await page.locator('[data-team-modal="avangard"]').waitFor();
  assert.ok(await noOverflow(page));
  // From the card: «Обмен с клубом» opens trades with this partner
  await page.locator('[data-team-modal="avangard"]').getByRole('button', { name: /Обмен с клубом/ }).click();
  await page.locator('select').filter({ has: page.locator('option[value="avangard"]') }).first().waitFor();
  assert.equal(await page.locator('select').filter({ has: page.locator('option[value="avangard"]') }).first().inputValue(), 'avangard');
  ok('standings row opens the card; «Обмен с клубом» preselects the partner');

  // Roster photos + failed photo falls back to initials
  await page.getByRole('button', { name: 'Состав', exact: true }).first().click();
  await page.waitForTimeout(600);
  const photos = await page.locator('main [data-face="photo"]').count();
  const initials = await page.locator('main [data-face="initials"]').count();
  assert.ok(photos > 10, `roster photos ${photos}`);
  assert.ok(initials >= 1, 'players without a photo (or with a broken link) show initials');
  await page.screenshot({ path: '.arena/roster-faces.png' });
  ok(`roster: ${photos} photos, ${initials} initials badges`);

  // Phone landscape: card fits, no horizontal scroll
  const land = await open({ width: 844, height: 390 }, { isMobile: true, hasTouch: true });
  await land.getByRole('button', { name: /^СКА/ }).click();
  await land.getByRole('button', { name: 'Начать карьеру', exact: true }).click();
  await land.locator('[data-team-link]').first().waitFor();
  await land.locator('[data-team-link]').first().click();
  await land.locator('[data-team-modal]').waitFor();
  assert.ok(await noOverflow(land));
  await land.waitForTimeout(500);
  await land.screenshot({ path: '.arena/team-card-land.png' });
  ok('landscape phone: club card fits the screen');

  assert.deepEqual(errors, []);
  console.log('PASS: photos and club card browser flow, no runtime errors');
} catch (e) {
  console.error(errors);
  throw e;
} finally {
  await browser.close();
}
