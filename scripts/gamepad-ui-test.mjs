// The whole app with a gamepad (gamepadNav.ts): the d-pad moves the focus (with a visible ring), A presses,
// RB / LB switch the main sections, B closes the top window; in a played match the pad skates instead (the focus
// does not move) and Start pauses / resumes.
// Start Vite first. Optional deps: npm install --no-save --package-lock=false @playwright/test
// BASE_URL=http://localhost:5173 CHROMIUM_PATH=/path/to/chromium node scripts/gamepad-ui-test.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { serveTestMod } from './testMod.mjs';
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
serveTestMod(browser);
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(s => {
    localStorage.setItem('khl.settings', JSON.stringify(s));
    const pad = { id: 'Test pad', index: 0, connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    window.__pad = pad; navigator.getGamepads = () => [pad];
  }, { autoReplay: 'off', matchView: '2d', playPeriod: 3 });
  const btn = async (i, ms = 120) => { await page.evaluate(i => { window.__pad.buttons[i] = { pressed: true, value: 1 }; }, i); await page.waitForTimeout(ms); await page.evaluate(i => { window.__pad.buttons[i] = { pressed: false, value: 0 }; }, i); await page.waitForTimeout(150); };
  const focused = () => page.evaluate(() => { const a = document.activeElement; return a && a !== document.body ? (a.textContent || a.getAttribute('aria-label') || a.tagName).trim().slice(0, 40) : null; });
  await page.goto(process.env.BASE_URL ?? 'http://localhost:5173');
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).waitFor();
  // the start screen: the d-pad focuses a control and the ring shows
  await btn(13);
  assert.ok(await focused(), 'the d-pad focuses a control');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('pad-nav')), true, 'the focus ring is on');
  const f1 = await focused(); await btn(13);
  assert.notEqual(await focused(), f1, 'down moves the focus');
  await page.mouse.click(5, 5);
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('pad-nav')), false, 'the mouse hides the ring');
  await page.getByRole('button', { name: /^СКА/ }).click();
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).click();
  const cur = () => page.evaluate(() => document.querySelector('[data-pad-sections] [aria-current="page"]')?.getAttribute('data-nav-view'));
  await page.waitForFunction(() => document.querySelector('[data-pad-sections] [aria-current="page"]'));
  const s0 = await cur();
  await btn(5); const s1 = await cur();
  assert.notEqual(s1, s0, `RB: the next section (${s0} → ${s1})`);
  await btn(4);
  assert.equal(await cur(), s0, 'LB: back to the previous section');
  // A presses the focused button: a window opens; B closes it
  await page.getByRole('button', { name: /Настройки/ }).first().focus();
  await btn(0);
  await page.locator('[data-modal-closing], .fixed.inset-0.z-50').first().waitFor({ timeout: 3000 });
  await btn(13);
  const inModal = await page.evaluate(() => !!document.activeElement?.closest('.fixed.inset-0'));
  assert.ok(inModal, 'the focus stays inside the open window');
  await btn(1); await page.waitForTimeout(400);
  assert.equal(await page.locator('.fixed.inset-0.z-50:not([data-modal-closing])').count(), 0, 'B closes the window');
  // a played match: A on «Начать матч» starts it; during play the pad skates (the focus stays), Start pauses and resumes
  const toMatch = page.getByRole('button', { name: 'Симулировать до матча', exact: true });
  for (let k = 0; k < 8 && await toMatch.count(); k++) { await toMatch.click(); await page.waitForTimeout(150); const go = page.getByRole('button', { name: 'Всё равно продолжить', exact: true }); if (await go.count()) { await go.click(); await page.waitForTimeout(150); } }
  await page.getByRole('button', { name: 'Играть матч', exact: true }).click();
  await page.locator('[data-match-mode="play"]').click();
  await page.locator('[data-play-start]').waitFor();
  await page.locator('[data-play-start]').focus();
  await btn(0);
  await page.locator('[data-play-match][data-phase="playing"]').waitFor({ timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('[data-live-rink][data-stopped]') || document.querySelector('[data-play-fo-cue]'), null, { timeout: 15000 });
  const before = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80));
  await btn(13, 300);
  assert.equal(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)), before, 'in play the d-pad does not move the focus');
  await btn(9);
  await page.locator('[data-play-resume]').waitFor({ timeout: 3000 });
  await btn(9);
  await page.waitForFunction(() => !document.querySelector('[data-play-resume]'), null, { timeout: 3000 });
  assert.deepEqual(errors, []);
  console.log('gamepad-ui-test: ok');
} finally {
  await browser.close();
}
