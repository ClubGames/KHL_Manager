// index.html boot watchdog: an empty screen (nothing of the interface under the probe points) brings up the boot
// diagnostics; «Безопасный запуск» reloads without opening a league by itself; a phantom phone "gamepad" (fingerprint
// sensor, a stuck axis and RT) does not scroll the page.
// BASE_URL=http://localhost:5173 CHROMIUM_PATH=/path/to/chromium node scripts/boot-watchdog-test.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { serveTestMod } from './testMod.mjs';
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
serveTestMod(browser);
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 360 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const mk = (id, axes) => ({ id, index: 0, connected: true, mapping: '', timestamp: 1, axes, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === 7, touched: false, value: i === 7 ? 1 : 0 })) });
    const sensor = mk('uinput-fpc', [0, 0, 0, 1]), stuck = { ...mk('Generic joystick', [0, 0, 0, 1]), index: 1 };
    navigator.getGamepads = () => [sensor, stuck, null, null];
  });
  await page.goto(process.env.BASE_URL ?? 'http://localhost:5173');
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).waitFor();
  await page.waitForTimeout(2500);
  assert.equal(await page.evaluate(() => scrollY), 0, 'a phantom pad does not scroll the start screen');
  assert.equal(await page.locator('#khl-boot-diag').count(), 0, 'no diagnostics over a working interface');
  await page.evaluate(() => window.__khlBootCheck());
  assert.equal(await page.locator('#khl-boot-diag').count(), 0, 'the check sees the interface');
  // the interface vanishes: the check brings up the diagnostics
  await page.evaluate(() => { document.getElementById('root').style.display = 'none'; window.__khlBootCheck(); });
  await page.locator('#khl-boot-diag').waitFor({ timeout: 2000 });
  assert.match(await page.locator('#khl-boot-diag').innerText(), /Безопасный запуск/);
  await page.locator('#khl-boot-safe').click();
  await page.locator('[data-safe-start]').waitFor({ timeout: 15000 });
  assert.equal(await page.getByRole('button', { name: 'Начать карьеру', exact: true }).count(), 0, 'safe start opens no league by itself');
  assert.equal(await page.evaluate(() => localStorage.getItem('khl.safe')), null, 'the safe start flag is used once');
  await page.reload();
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).waitFor({ timeout: 15000 });
  assert.deepEqual(errors, []);
  console.log('boot-watchdog-test: ok');
} finally {
  await browser.close();
}
