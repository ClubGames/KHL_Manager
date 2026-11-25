// Browser vs. app builds: the same bundle detects the Windows app (Electron preload bridge) and the Android
// app (Capacitor bridge) and adapts — download links only in the browser, files saved through the native
// bridge, Android always full screen (no fullscreen button, replay fills the viewport), GPU diagnostics.
// Start Vite first: BASE_URL=http://localhost:5173 CHROMIUM_PATH=/path/to/chromium node scripts/apps-ui-test.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];
const ok = (m) => console.log('ok', m);
const BASE = process.env.BASE_URL ?? 'http://localhost:5173';

async function open(init, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, ...options });
  page.on('pageerror', (e) => errors.push(e.message));
  if (init) await page.addInitScript(init);
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).waitFor();
  return page;
}
async function openSettings(page) {
  await page.locator('[data-startup-settings]').click();
  await page.locator('[data-settings-section="Приложение и графика"]').waitFor();
}

try {
  // 1. Browser: download links, software-rendering hint, fullscreen button present.
  {
    const page = await open();
    assert.equal(await page.locator('[data-startup-apps]').count(), 1, 'start screen links the apps');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.app ?? null), null);
    await openSettings(page);
    assert.equal(await page.locator('[data-app-platform]').getAttribute('data-app-platform'), 'web');
    const links = await page.locator('[data-app-downloads] a').evaluateAll((as) => as.map((a) => a.href));
    assert.ok(links.some((h) => h.endsWith('/releases/download/app/Hockey-Simulator-Manager-Setup.exe')), 'windows installer link');
    assert.ok(links.some((h) => h.endsWith('/releases/download/app/Hockey-Simulator-Manager.apk')), 'android apk link');
    // swiftshader in CI = software rendering: the hint explains the lag and points to the app.
    assert.equal(await page.locator('[data-gpu]').getAttribute('data-gpu'), 'software');
    assert.match(await page.locator('[data-settings-section="Приложение и графика"]').innerText(), /без видеокарты/);
    await page.getByRole('button', { name: 'Готово' }).click();
    assert.ok(await page.getByRole('button', { name: /Во весь экран/ }).count(), 'fullscreen button in the browser');
    await page.close();
    ok('browser: app download links (start screen + settings), GPU diagnostics, fullscreen button');
  }

  // 2. Windows app: detected from the preload bridge; files go through it; no download links.
  {
    const page = await open(() => {
      window.__saved = [];
      window.khlDesktop = {
        platform: 'windows',
        info: async () => ({ version: '1.0.42', electron: '45', chrome: '140', gpu: 'WebGL: enabled' }),
        saveFile: async ({ name, data, kind }) => { window.__saved.push({ name, size: data.byteLength, kind }); return `C:\\Users\\me\\Documents\\${name}`; },
      };
    });
    assert.equal(await page.locator('[data-startup-apps]').count(), 0, 'no app links inside the app');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.app), 'windows');
    await openSettings(page);
    await page.waitForFunction(() => /1\.0\.42/.test(document.querySelector('[data-app-platform]')?.textContent ?? ''));
    assert.match(await page.locator('[data-app-platform]').innerText(), /Приложение для Windows · 1\.0\.42/);
    assert.equal(await page.locator('[data-app-downloads]').count(), 0);
    assert.match(await page.locator('[data-settings]').innerText(), /хранятся в приложении/);
    await page.getByRole('button', { name: 'Готово' }).click();
    // Example roster download → native save dialog bridge.
    await page.getByRole('button', { name: 'Формат JSON', exact: true }).first().click();
    await page.getByRole('button', { name: 'Скачать пример', exact: true }).first().click();
    await page.waitForFunction(() => window.__saved.length > 0);
    const saved = await page.evaluate(() => window.__saved[0]);
    assert.equal(saved.name, 'roster.example.json'); assert.equal(saved.kind, 'roster'); assert.ok(saved.size > 500);
    // Video saving reports the path.
    const where = await page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('/src/components/replayExport.ts'));
      const X = await import(url ?? '/src/components/replayExport.ts');
      return X.saveVideo(new Blob([new Uint8Array(2048)], { type: 'video/mp4' }), 'Gol_Test.mp4');
    });
    assert.equal(where, 'C:\\Users\\me\\Documents\\Gol_Test.mp4');
    assert.equal(await page.evaluate(() => window.__saved[1].kind), 'video');
    await page.goto(BASE); await page.getByRole('button', { name: 'Начать карьеру', exact: true }).waitFor();
    assert.ok(await page.getByRole('button', { name: /Во весь экран/ }).count(), 'window fullscreen still available');
    await page.close();
    ok('Windows app: detected, version shown, files saved through the native dialog (roster, video), no download links');
  }

  // 3. Android app (Capacitor bridge present): always full screen, back button wired, no download links.
  {
    // What the native side injects: the bridge, the plugin list and the call/callback entry points.
    const page = await open(() => {
      window.__bridge = []; window.__listeners = {};
      window.androidBridge = { postMessage: () => {} };
      window.Capacitor = {
        PluginHeaders: [{ name: 'App', methods: [{ name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }, { name: 'minimizeApp', rtype: 'promise' }, { name: 'getInfo', rtype: 'promise' }] }],
        nativePromise: (plugin, method, options) => { window.__bridge.push({ plugin, method, options }); return Promise.resolve(method === 'getInfo' ? { version: '1.0.7' } : undefined); },
        nativeCallback: (plugin, method, options, callback) => { window.__bridge.push({ plugin, method, options }); window.__listeners[options.eventName] = callback; return Promise.resolve('cb-' + options.eventName); },
      };
    }, { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.app), 'android');
    assert.equal(await page.getByRole('button', { name: /Во весь экран/ }).count(), 0, 'no fullscreen button: the app is full screen');
    assert.equal(await page.locator('[data-startup-apps]').count(), 0);
    await page.waitForFunction(() => typeof window.__listeners.backButton === 'function');
    await openSettings(page);
    await page.waitForFunction(() => /1\.0\.7/.test(document.querySelector('[data-app-platform]')?.textContent ?? ''));
    assert.match(await page.locator('[data-app-platform]').innerText(), /Приложение для Android · 1\.0\.7/);
    assert.equal(await page.locator('[data-app-downloads]').count(), 0);
    // «Back» = Escape: closes the settings window…
    await page.evaluate(() => window.__listeners.backButton({ canGoBack: false }));
    await page.locator('[data-settings]').waitFor({ state: 'detached', timeout: 3000 });
    assert.equal(await page.evaluate(() => window.__bridge.some((m) => m.method === 'minimizeApp')), false);
    // … and on the main screen it minimises the app.
    await page.evaluate(() => window.__listeners.backButton({ canGoBack: false }));
    await page.waitForFunction(() => window.__bridge.some((m) => m.method === 'minimizeApp'));
    await page.close();
    ok('Android app: detected, no fullscreen button / download links, «Back» closes windows then minimises');
  }
} catch (e) {
  console.error('FAIL', e.stack ?? e.message);
  process.exitCode = 1;
} finally {
  console.log('page errors', errors);
  if (errors.length) process.exitCode = 1;
  await browser.close();
}
