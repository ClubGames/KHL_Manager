// «Установить мод» in the Windows app UI, with a stub desktop bridge (start Vite first, same env as rink-ui-test.mjs):
// the button and the folder path show up, a dropped .zip goes to installMod as bytes, the result is reported.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { START_IN_CAREER } from './testMod.mjs';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const errors = [];
const ok = (m) => console.log('ok', m);
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  // the career screen (with the mod list) is behind the main menu: open it directly
  await context.addInitScript(START_IN_CAREER);
  await context.addInitScript(() => {
    localStorage.setItem('khl.settings', JSON.stringify({ autoReplay: 'off', replay3d: false, replayPrewarm: false, matchIntro: false }));
    const calls = (window.__installCalls = []);
    window.khlDesktop = {
      platform: 'windows',
      info: async () => ({ version: '9.9.9', electron: '45', chrome: '140', gpu: 'stub', modsDir: 'D:\\Games\\Hockey Simulator Manager\\mods' }),
      saveFile: async () => null,
      openModsFolder: async () => 'D:\\Games\\Hockey Simulator Manager\\mods',
      installMod: async (file) => {
        calls.push(file ? { name: file.name, size: file.data.length, bytes: file.data instanceof Uint8Array } : 'dialog');
        if (file && file.name === 'bad.zip') return { installed: [], errors: ['bad.zip: В архиве нет roster.json — это не мод игры.'], dir: 'D:\\Games\\Hockey Simulator Manager\\mods' };
        return { installed: [{ id: 'VHL_2627', name: 'ВХЛ 2026/27', replaced: false }], errors: [], dir: 'D:\\Games\\Hockey Simulator Manager\\mods' };
      },
    };
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(process.env.BASE_URL ?? 'http://localhost:5173');
  const btn = page.locator('[data-mod-install]');
  await btn.waitFor();
  await page.locator('[data-mod-dir]').getByText('D:\\Games\\Hockey Simulator Manager\\mods').waitFor();
  ok('Windows app: «Установить мод…» and the real mods folder path (next to the game) are shown');

  await btn.click();
  await page.locator('[data-mod-install-result]').getByText('ВХЛ 2026/27').waitFor();
  assert.deepEqual(await page.evaluate(() => window.__installCalls), ['dialog']);
  ok('button → system dialog → «Установлен мод ВХЛ 2026/27»');

  // drag-and-drop of a .zip onto the mod list
  const drop = async (name) => {
    const dt = await page.evaluateHandle((n) => { const d = new DataTransfer(); d.items.add(new File([new Uint8Array([80, 75, 5, 6, 1, 2, 3])], n, { type: 'application/zip' })); return d; }, name);
    await page.dispatchEvent('[data-mod-picker]', 'dragover', { dataTransfer: dt });
    await page.locator('[data-mod-dropzone]').waitFor();
    await page.dispatchEvent('[data-mod-picker]', 'drop', { dataTransfer: dt });
  };
  await drop('VHL_2627.zip');
  await page.waitForFunction(() => window.__installCalls.length === 2);
  assert.deepEqual((await page.evaluate(() => window.__installCalls))[1], { name: 'VHL_2627.zip', size: 7, bytes: true });
  assert.equal(await page.locator('[data-mod-dropzone]').count(), 0, 'drop overlay hidden after the drop');
  ok('drop a .zip → its bytes go to the app');

  await drop('bad.zip');
  await page.locator('[data-mod-install-result]').getByText(/нет roster\.json/).waitFor();
  await drop('photo.png');
  await page.locator('[data-mod-install-result]').getByText(/нужен архив \.zip/).waitFor();
  assert.equal((await page.evaluate(() => window.__installCalls)).length, 3, 'a non-zip never reaches the app');
  ok('errors are shown: an archive without roster.json, a file that is not a .zip');
  await page.locator('[data-mod-picker]').screenshot({ path: '.arena/mod-install.png' });
  assert.deepEqual(errors, []);
  console.log('PASS mod install UI');
} finally {
  await browser.close();
}
