// «Установить мод» in the browser (and the Android app, which runs the same page): a .zip picked with the file
// chooser is unpacked into IndexedDB, the service worker (public/mod-sw.js) serves its files from ./mods/<id>/, the
// mod opens at once (roster and cover through the worker), is still there after a reload, and can be removed.
// Start Vite first: BASE_URL=http://localhost:5173 CHROMIUM_PATH=/path/to/chromium node scripts/mod-store-ui-test.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
import { START_IN_CAREER } from './testMod.mjs';

const require = createRequire(import.meta.url);
const { writeZip } = require('../desktop/modInstall.cjs');
const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
mkdirSync('.arena', { recursive: true });
const zipPath = '.arena/test-league.zip';
writeFileSync(zipPath, writeZip({
  'TestLeague/roster.json': readFileSync('scripts/fixtures/test-roster.json'),
  'TestLeague/mod.json': JSON.stringify({ name: 'Лига из архива', description: 'установлена из .zip', cover: 'logos/cover.png', schedule: null }),
  'TestLeague/logos/cover.png': readFileSync('public/icon-192.png'),
}));

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const errors = [];
const ok = (m) => console.log('ok', m);
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(START_IN_CAREER);
  await context.addInitScript(() => localStorage.setItem('khl.settings', JSON.stringify({ autoReplay: 'off', replay3d: false, replayPrewarm: false, matchIntro: false })));
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  // the built-in league «ХЛ» is open; «Установить мод…» sits next to it in the picker
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).waitFor({ timeout: 60000 });
  assert.ok((await page.locator('[data-mod="HL_2627"]').getAttribute('class')).includes('border-accent'));
  const btn = page.locator('[data-mod-install]').first();
  await btn.waitFor();
  assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), false, 'no service worker before a mod is installed');
  ok('browser: «Установить мод…» is offered');

  const chooser = page.waitForEvent('filechooser');
  await btn.click();
  await (await chooser).setFiles(zipPath);
  await page.locator('[data-mod-install-result]').getByText('Лига из архива').waitFor({ timeout: 30000 });
  assert.ok((await page.locator('[data-mod-install-result]').innerText()).includes('в память браузера'), 'the result says where it went');
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).waitFor({ timeout: 60000 });
  const card = page.locator('[data-mod="TestLeague"]');
  assert.ok((await card.getAttribute('class')).includes('border-accent'), 'the installed mod is opened');
  assert.ok((await card.innerText()).includes('в браузере'), 'marked as installed in the browser');
  assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true, 'the worker controls the page');
  await page.waitForFunction(() => { const i = document.querySelector('[data-mod="TestLeague"] img'); return i && i.complete && i.naturalWidth > 100; }, null, { timeout: 15000 });
  const r = await page.evaluate(async () => { const x = await fetch('./mods/TestLeague/roster.json', { cache: 'no-store' }); return { status: x.status, type: x.headers.get('content-type'), teams: (await x.json()).teams.length }; });
  assert.deepEqual(r, { status: 200, type: 'application/json', teams: 25 });
  ok('zip → IndexedDB → served from ./mods/TestLeague/ (roster with 25 clubs, cover picture), the mod opened');
  await page.locator('[data-mod-picker]').screenshot({ path: '.arena/mod-store.png' });

  await page.reload();
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).waitFor({ timeout: 60000 });
  assert.ok((await page.locator('[data-mod="TestLeague"]').getAttribute('class')).includes('border-accent'), 'still there and picked after a reload');
  ok('after a reload the stored mod is listed and loads');

  page.once('dialog', (d) => void d.accept());
  await page.locator('[data-mod-remove="TestLeague"]').click();
  await page.waitForFunction(() => document.querySelector('[data-mod="HL_2627"]')?.className.includes('border-accent'), null, { timeout: 30000 });
  assert.equal(await page.locator('[data-mod="TestLeague"]').count(), 0);
  const left = await page.evaluate(async () => (await fetch('./mods/TestLeague/roster.json', { cache: 'no-store' })).headers.get('content-type'));
  assert.ok(!String(left).includes('application/json'), 'its files are gone');
  ok('remove: the mod and its files are deleted, the built-in league is picked again');

  const bad = '.arena/bad.zip';
  writeFileSync(bad, writeZip({ 'readme.txt': 'not a mod' }));
  const ch2 = page.waitForEvent('filechooser');
  await page.locator('[data-mod-install]').first().click();
  await (await ch2).setFiles(bad);
  await page.locator('[data-mod-install-result]').getByText(/нет roster\.json/).waitFor();
  ok('an archive without roster.json is reported');
  assert.deepEqual(errors, []);
  console.log('PASS mod install in the browser');
} catch (e) {
  console.error('FAIL', e);
  await page?.screenshot({ path: '.arena/mod-store-fail.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
