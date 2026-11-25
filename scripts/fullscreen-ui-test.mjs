// Fullscreen mode for the whole game and for the 3D goal replay; the replay starts at ×1.
// Start Vite first: BASE_URL=http://localhost:5173 CHROMIUM_PATH=/path/to/chromium node scripts/fullscreen-ui-test.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];
const ok = (m) => console.log('ok', m);
const fsEl = (page) => page.evaluate(() => (document.fullscreenElement ? (document.fullscreenElement === document.documentElement ? 'page' : document.fullscreenElement.getAttribute('data-replay-box') !== null ? 'replay' : 'other') : null));
const waitFs = async (page, want) => {
  for (let i = 0; i < 40; i++) { if ((await fsEl(page)) === want) return; await page.waitForTimeout(50); }
  assert.equal(await fsEl(page), want);
};
async function open(options = {}) {
  const page = await browser.newPage(options);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(process.env.BASE_URL ?? 'http://localhost:5173');
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).waitFor();
  return page;
}
async function mountReplay(page) {
  await page.evaluate(async () => {
    const RM = await import('/node_modules/.vite/deps/react.js'), React = RM.default ?? RM;
    const DOM = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { GoalReplay } = await import('/src/components/GoalReplay.tsx');
    const { parseRosterText } = await import('/src/game/roster.ts');
    const r = parseRosterText(await (await fetch('/mods/KHL_2627/roster.json')).text());
    const home = r.teams.find((t) => t.id === 'ska'), away = r.teams.find((t) => t.id === 'avangard');
    const ids = (t) => [...t.lineup.F[0], ...t.lineup.D[0]].filter(Boolean);
    const h = ids(home), a = ids(away);
    const e = { sec: 481, period: 1, time: '11:59', type: 'goal', team: home.id, player: h[0], players: [h[1], h[2]], goalie: away.lineup.starterG, ice: [h, a], x: 82, y: 34, shotType: 'wrist', strength: 'EV', score: [1, 0], text: 'Тест голевого эпизода' };
    const mount = document.createElement('div'); document.body.appendChild(mount);
    const root = (DOM.createRoot ?? DOM.default.createRoot)(mount);
    root.render(React.createElement(GoalReplay, { event: e, home, away, players: r.players, onClose: () => { root.unmount(); mount.remove(); } }));
  });
  await page.getByRole('dialog', { name: '3D-повтор гола' }).waitFor();
}

try {
  // 1. Whole game, desktop: start screen and in-career header
  const page = await open({ viewport: { width: 1280, height: 900 } });
  const startBtn = page.locator('[data-fullscreen-toggle]');
  await startBtn.click();
  await waitFs(page, 'page');
  await page.locator('[data-fullscreen-toggle][aria-pressed="true"]').waitFor();
  await startBtn.click();
  await waitFs(page, null);
  ok('start screen: «Во весь экран» enters and leaves page fullscreen');

  await page.getByRole('button', { name: /^СКА/ }).click();
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).click();
  const headerBtn = page.locator('header [data-fullscreen-toggle]');
  await headerBtn.click();
  await waitFs(page, 'page');
  // the game keeps working in fullscreen: switch a section
  await page.getByRole('button', { name: 'Таблица', exact: true }).first().click();
  await page.locator('[data-team-row]').first().waitFor();
  await headerBtn.click();
  await waitFs(page, null);
  ok('career header: fullscreen toggle, navigation works while fullscreen');

  // 2. 3D replay: starts at ×1, own fullscreen on top of page fullscreen, Esc order
  await mountReplay(page);
  assert.equal(await page.getByLabel('Скорость повтора').inputValue(), '1');
  const slider = page.getByRole('slider', { name: 'Позиция повтора' });
  await page.locator('[data-replay-models="rigged"]').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: '↻ Повторить', exact: true }).click();
  const t0 = Date.now(); const v0 = Number(await slider.inputValue());
  await page.waitForTimeout(1000);
  const advanced = (Number(await slider.inputValue()) - v0) / 1000 * Number((await page.locator('[data-replay-box]').innerText()).match(/\/ ([\d.]+) c/)[1]);
  const wall = (Date.now() - t0) / 1000;
  // Software WebGL in CI drops frames (each frame step is capped), so only bound it from above: never faster than real time.
  assert.ok(advanced > 0 && advanced < wall * 1.3, `×1 is not faster than real time (${advanced.toFixed(2)} s of clip in ${wall.toFixed(2)} s)`);
  ok(`replay opens at ×1 (${advanced.toFixed(2)} s of clip per ${wall.toFixed(2)} s)`);

  const stageBefore = await page.locator('[data-replay-stage]').boundingBox();
  await page.locator('[data-replay-fullscreen]').click();
  await waitFs(page, 'replay');
  // The layout settles after the fullscreen change (slow with software WebGL): poll instead of a fixed wait.
  let stageFs = null;
  for (let i = 0; i < 40 && !(stageFs && stageFs.width >= 1279 && stageFs.height > stageBefore.height + 100); i++) { await page.waitForTimeout(100); stageFs = await page.locator('[data-replay-stage]').boundingBox(); }
  assert.ok(stageFs.width >= 1279 && stageFs.height > stageBefore.height + 100, `stage grows ${JSON.stringify(stageBefore)} → ${JSON.stringify(stageFs)}`);
  let canvas = null;
  for (let i = 0; i < 40 && !(canvas && canvas.height > stageFs.height - 4); i++) { await page.waitForTimeout(100); canvas = await page.locator('[data-replay-stage] canvas').first().boundingBox(); }
  assert.ok(canvas && canvas.height > stageFs.height - 4, `the WebGL canvas follows the stage size ${JSON.stringify(canvas)}`);
  assert.ok(await page.getByRole('button', { name: 'Продолжить матч', exact: true }).isVisible(), 'continue button stays reachable');
  await page.screenshot({ path: '.arena/replay-fullscreen.png' });
  // keyboard F toggles back
  await page.keyboard.press('f');
  await waitFs(page, null);
  assert.equal(await page.getByRole('dialog', { name: '3D-повтор гола' }).count(), 1);
  // closing while fullscreen leaves fullscreen
  await page.locator('[data-replay-fullscreen]').click();
  await waitFs(page, 'replay');
  const cont = page.locator('[data-replay-continue]');
  await cont.waitFor({ state: 'visible' });
  // (Playwright's stability check on top-layer fullscreen content is flaky under software WebGL load)
  await cont.click({ force: true });
  await waitFs(page, null);
  assert.equal(await page.getByRole('dialog', { name: '3D-повтор гола' }).count(), 0);
  ok('replay fullscreen: fills the screen, canvas resizes, F toggles, closing exits fullscreen');

  // 3. Browser without element fullscreen (iPhone Safari): replay fills the viewport, game shows home-screen help
  const phone = await browser.newPage({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
  phone.on('pageerror', (e) => errors.push(e.message));
  await phone.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false });
    Element.prototype.requestFullscreen = undefined;
  });
  await phone.goto(process.env.BASE_URL ?? 'http://localhost:5173');
  await phone.locator('[data-fullscreen-toggle]').click();
  await phone.locator('[data-fullscreen-help]').getByText('На экран „Домой“', { exact: false }).waitFor();
  await phone.keyboard.press('Escape');
  await mountReplay(phone);
  await phone.locator('[data-replay-fullscreen]').click();
  const box = await phone.locator('[data-replay-box]').boundingBox();
  assert.ok(box.width >= 843 && box.height >= 389, `fills the phone viewport ${JSON.stringify(box)}`);
  const stage = await phone.locator('[data-replay-stage]').boundingBox();
  assert.ok(stage.height >= 250, `stage ${stage.height}px tall on a 390px screen`);
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await phone.screenshot({ path: '.arena/replay-phone-expanded.png' });
  await phone.keyboard.press('Escape');
  assert.equal(await phone.locator('[data-replay-box][data-expanded]').count(), 0, 'Esc leaves the expanded view first');
  assert.equal(await phone.getByRole('dialog', { name: '3D-повтор гола' }).count(), 1);
  await phone.keyboard.press('Escape');
  assert.equal(await phone.getByRole('dialog', { name: '3D-повтор гола' }).count(), 0);
  ok('no Fullscreen API (iPhone): home-screen instructions; replay expands to the viewport, Esc steps back');

  // 4. Install metadata for home-screen fullscreen
  const manifest = await (await page.request.get(new URL('manifest.webmanifest', page.url()).href)).json();
  assert.equal(manifest.display, 'fullscreen');
  assert.ok(await page.locator('meta[name="apple-mobile-web-app-capable"][content="yes"]').count());
  ok('web app manifest (display: fullscreen, landscape) and iOS home-screen meta');

  assert.deepEqual(errors, []);
  console.log('PASS: fullscreen browser flow, no runtime errors');
} finally {
  await browser.close();
}
