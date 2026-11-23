// Start Vite first. Optional deps: npm install --no-save --package-lock=false @playwright/test
// BASE_URL=http://localhost:5173 CHROMIUM_PATH=/path/to/chromium node scripts/rink-ui-test.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];
async function open(options = {}) {
  const page = await browser.newPage(options);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(process.env.BASE_URL ?? 'http://localhost:5173');
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).waitFor();
  return page;
}
async function mount(page, change = {}) {
  await page.evaluate(async change => {
    const RM = await import('/node_modules/.vite/deps/react.js'), React = RM.default ?? RM;
    const DOM = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { GoalReplay } = await import('/src/components/GoalReplay.tsx');
    const { parseRosterText } = await import('/src/game/roster.ts');
    const r = parseRosterText(await (await fetch('/roster.json')).text());
    const home = r.teams.find(t => t.id === 'ska'), away = r.teams.find(t => t.id === 'avangard');
    const ids = t => [...t.lineup.F[0], ...t.lineup.D[0]].filter(Boolean);
    const h = ids(home), a = ids(away);
    const e = { sec: 481, period: 1, time: '11:59', type: 'goal', team: home.id, player: h[0], players: [h[1], h[2]], goalie: away.lineup.starterG, ice: [h, a], x: 82, y: 34, shotType: 'wrist', strength: 'EV', score: [1, 0], text: 'Тест голевого эпизода', ...change };
    const mount = document.createElement('div'); document.body.appendChild(mount);
    const root = (DOM.createRoot ?? DOM.default.createRoot)(mount);
    root.render(React.createElement(GoalReplay, { event: e, home, away, players: r.players, onClose: () => { root.unmount(); mount.remove(); } }));
  }, change);
  await page.getByRole('dialog', { name: '3D-повтор гола' }).waitFor();
}
try {
  const page = await open({ viewport: { width: 1280, height: 950 } });
  await mount(page);
  await page.waitForTimeout(800);
  assert.equal(await page.locator('[data-replay-renderer]').getAttribute('data-replay-renderer'), 'webgl');
  // Rigged club-kit player models (inlined GLB) replace the simple figures.
  await page.locator('[data-replay-models="rigged"]').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Пауза повтора', exact: true }).click();
  const slider = page.getByRole('slider', { name: 'Позиция повтора' });
  await slider.fill('660');
  const before = await slider.inputValue(); await page.waitForTimeout(250); assert.equal(await slider.inputValue(), before);
  const tv = await page.locator('[data-replay-renderer]').screenshot();
  await page.getByRole('button', { name: 'Со льда', exact: true }).click();
  assert.equal(await slider.inputValue(), '660');
  const ice = await page.locator('[data-replay-renderer]').screenshot(); assert.ok(!tv.equals(ice), 'camera must change real rendered image');
  await page.getByRole('button', { name: 'У ворот', exact: true }).click();
  await slider.fill('900'); assert.ok(await page.getByText('ГОЛ', { exact: true }).isVisible());
  await slider.fill('500'); assert.equal(await page.getByText('ГОЛ', { exact: true }).count(), 0);
  await page.getByLabel('Скорость повтора').selectOption('0.25');
  await page.getByRole('button', { name: '↻ Повторить', exact: true }).click();
  await page.waitForTimeout(300); assert.ok(Number(await slider.inputValue()) < 200);
  await page.keyboard.press('Escape'); assert.equal(await page.getByRole('dialog', { name: '3D-повтор гола' }).count(), 0);
  console.log('ok real WebGL, rigged club-kit models, 3 cameras, seek, pause, slow motion, restart, goal timing and Escape');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const shotType of ['tip', 'rebound', 'slap', 'backhand']) {
    await mount(page, { shotType });
    assert.ok(await page.getByRole('button', { name: 'Воспроизвести', exact: true }).isVisible());
    await page.getByRole('slider', { name: 'Позиция повтора' }).fill('660');
    await page.getByRole('button', { name: 'Продолжить матч', exact: true }).click();
  }
  console.log('ok repeated WebGL disposal/reopen and reduced-motion default');
  await page.close();

  const mobile = await open({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await mount(mobile);
  const bounds = await mobile.getByRole('dialog').evaluate(el => ({ width: el.scrollWidth, viewport: innerWidth })); assert.ok(bounds.width <= bounds.viewport);
  await mobile.getByRole('button', { name: 'Со льда', exact: true }).click();
  await mobile.getByRole('button', { name: 'Продолжить матч', exact: true }).click();
  await mobile.close(); console.log('ok mobile layout and controls');

  const fallback = await open({ reducedMotion: 'reduce' });
  await fallback.evaluate(() => { Object.defineProperty(window, 'WebGLRenderingContext', { value: undefined }); Object.defineProperty(window, 'WebGL2RenderingContext', { value: undefined }); });
  await mount(fallback);
  await fallback.locator('[data-replay-renderer="svg"]').waitFor();
  assert.equal(await fallback.locator('[data-rink-player]').count(), 12);
  await fallback.getByRole('slider').fill('950');
  assert.ok(await fallback.getByText('ГОЛ', { exact: true }).isVisible());
  await fallback.keyboard.press('Escape'); await fallback.close();
  console.log('ok WebGL-unavailable fallback uses same timeline and stays dismissible');

  const match = await open();
  await match.getByRole('button', { name: /^СКА/ }).click();
  await match.getByRole('button', { name: 'Начать карьеру', exact: true }).click();
  const toMatch = match.getByRole('button', { name: 'Симулировать до матча', exact: true });
  if (await toMatch.count()) await toMatch.click();
  await match.getByRole('button', { name: 'Играть матч', exact: true }).click();
  await match.getByRole('button', { name: 'Начать матч', exact: true }).click();
  await match.locator('[data-live-rink]').waitFor();
  for (let i = 0; i < 4; i++) { await match.waitForTimeout(200); const close = match.getByRole('button', { name: 'Закрыть повтор', exact: true }); if (await close.count()) await close.click(); }
  await match.getByRole('button', { name: 'Пауза', exact: true }).click();
  const rink = match.locator('[data-live-rink]');
  await match.waitForTimeout(100); const frozen = await rink.locator('[data-rink-puck]').getAttribute('cx');
  await match.waitForTimeout(250); assert.equal(await rink.locator('[data-rink-puck]').getAttribute('cx'), frozen);
  await match.getByRole('button', { name: 'Возобновить', exact: true }).click();
  // (the puck may rest on a faceoff dot during a stoppage, so allow it a few seconds to move again)
  let moved = false;
  for (let i = 0; i < 30 && !moved; i++) { await match.waitForTimeout(250); moved = (await rink.locator('[data-rink-puck]').getAttribute('cx')) !== frozen; }
  assert.ok(moved, 'puck moves after resume');
  await match.getByRole('button', { name: 'Скрыть площадку 2D', exact: true }).click(); assert.equal(await rink.count(), 0);
  await match.getByRole('button', { name: 'Показать площадку 2D', exact: true }).click(); assert.equal(await rink.count(), 1);
  await match.close(); console.log('ok actual match: moving 2D rink, freeze/resume and hide/show');

  // The replay is centred in the viewport even inside a transformed, scrolled page (phone held sideways).
  const sideways = await open({ viewport: { width: 844, height: 390 }, reducedMotion: 'reduce', isMobile: true, hasTouch: true });
  await sideways.evaluate(() => { document.body.style.minHeight = '3000px'; const root = document.getElementById('root'); if (root) root.style.transform = 'translateY(0)'; window.scrollTo(0, 900); });
  await mount(sideways);
  const box = await sideways.locator('[data-goal-replay] > div').boundingBox();
  assert.ok(box && box.y >= -1 && box.y + box.height <= 391, `replay inside viewport ${JSON.stringify(box)}`);
  assert.ok(Math.abs(box.y - (390 - box.y - box.height)) < 2, 'replay vertically centred');
  assert.equal(await sideways.locator('[data-goal-replay]').evaluate(el => el.parentElement === document.body), true);
  assert.ok(await sideways.getByRole('button', { name: 'Продолжить матч', exact: true }).isVisible());
  await sideways.keyboard.press('Escape'); await sideways.close();
  console.log('ok replay centred in a landscape phone viewport, portalled out of transformed ancestors');

  // Landscape match: nothing but the side list scrolls, the clock waits for the opening faceoff.
  const land = await open({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  await land.getByRole('button', { name: /^СКА/ }).click();
  await land.getByRole('button', { name: 'Начать карьеру', exact: true }).click();
  const toMatch2 = land.getByRole('button', { name: 'Симулировать до матча', exact: true });
  if (await toMatch2.count()) await toMatch2.click();
  await land.getByRole('button', { name: 'Играть матч', exact: true }).click();
  await land.getByRole('button', { name: 'Начать матч', exact: true }).click();
  await land.locator('[data-match-land]').waitFor();
  assert.equal(await land.locator('[data-live-rink][data-faceoff]').count(), 1, 'opening faceoff is shown');
  assert.equal(await land.locator('[data-clock]').innerText(), '20:00', 'clock does not run before the drop');
  const fit = await land.evaluate(() => ({ sh: document.documentElement.scrollHeight, ih: innerHeight, rink: document.querySelector('[data-rink-svg]').getBoundingClientRect().bottom }));
  assert.ok(fit.sh <= fit.ih && fit.rink <= fit.ih, `fits the screen ${JSON.stringify(fit)}`);
  assert.equal(await land.locator('[data-land-side]').evaluate(el => getComputedStyle(el).overflowY), 'auto');
  let running = false;
  for (let i = 0; i < 40 && !running; i++) { await land.waitForTimeout(250); running = (await land.locator('[data-clock]').innerText()) !== '20:00'; }
  assert.ok(running, 'clock runs after the drop');
  await land.waitForTimeout(500);
  assert.ok(await land.locator('[data-feed-play="faceoff"]').count() >= 1, 'faceoff reported in the feed');
  await land.getByRole('button', { name: /^Статистика/ }).click();
  assert.ok(await land.locator('[data-faceoffs]').count() === 1);
  await land.close(); console.log('ok landscape match screen: fixed layout, faceoff stops the clock, rink plays in feed and stats');
  assert.deepEqual(errors, []); console.log('PASS: rink browser flow, no runtime errors');
} finally { await browser.close(); }
