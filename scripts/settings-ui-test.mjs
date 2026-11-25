// Settings window (replays, video, match, simulation) and the optimized 3D replay: cached scene, 2D mode,
// export options and the instant re-download, auto-replay setting in a live match.
// Start Vite first: BASE_URL=http://localhost:5173 CHROMIUM_PATH=/path/to/chromium node scripts/settings-ui-test.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { serveTestMod } from './testMod.mjs';

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
serveTestMod(browser);
const errors = [];
const ok = (m) => console.log('ok', m);
const SHOTS = process.env.SHOTS;
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, timeout: 10000 }).catch(() => {}); };

async function open(options = {}) {
  const page = await browser.newPage({ acceptDownloads: true, ...options });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(process.env.BASE_URL ?? 'http://localhost:5173');
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).waitFor();
  return page;
}
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('khl.settings') ?? '{}'));

/** Mounts a goal replay; returns ms until the 3D picture is ready (or the 2D one is shown). */
async function mountReplay(page, k = 0) {
  return page.evaluate(async (k) => {
    const RM = await import('/node_modules/.vite/deps/react.js'), React = RM.default ?? RM;
    const DOM = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { GoalReplay } = await import('/src/components/GoalReplay.tsx');
    const { parseRosterText } = await import('/src/game/roster.ts');
    window.__roster ??= parseRosterText(await (async () => { for (const u of ['/mods/KHL_2627/roster.json', '/scripts/fixtures/test-roster.json']) { const t = (await (await fetch(u)).text()).trim(); if (t.startsWith('{')) return t; } return ''; })());
    const r = window.__roster;
    const home = r.teams.find((t) => t.id === 'ska'), away = r.teams.find((t) => t.id === 'avangard');
    const ids = (t) => [...t.lineup.F[0], ...t.lineup.D[0]].filter(Boolean);
    const h = ids(home), a = ids(away);
    const e = { sec: 481 + k, period: 1, time: '11:59', type: 'goal', team: home.id, player: h[k % 3], players: [h[1], h[2]], goalie: away.lineup.starterG, ice: [h, a], x: 82, y: 34, shotType: 'wrist', strength: 'EV', score: [1, 0], text: 'Тест голевого эпизода' };
    const mount = document.createElement('div'); document.body.appendChild(mount);
    const root = (DOM.createRoot ?? DOM.default.createRoot)(mount);
    window.__closeReplay = () => { root.unmount(); mount.remove(); };
    const t0 = performance.now();
    root.render(React.createElement(GoalReplay, { event: e, home, away, players: r.players, onClose: () => window.__closeReplay() }));
    for (;;) {
      await new Promise((res) => setTimeout(res, 10));
      if (document.querySelector('[data-replay-flat]')) break;
      if (document.querySelector('[data-replay-stage] canvas') && !document.querySelector('[data-replay-preparing]') && document.querySelector('[data-replay-models="rigged"]')) break;
      if (performance.now() - t0 > 60000) throw new Error('replay never got ready');
    }
    return Math.round(performance.now() - t0);
  }, k);
}
const closeReplay = (page) => page.evaluate(() => window.__closeReplay());

try {
  // 1. Settings window from the start screen: switches and choices are applied and remembered.
  const page = await open({ viewport: { width: 1280, height: 860 } });
  await page.locator('[data-startup-settings]').click();
  const dialog = page.locator('[data-settings]');
  await dialog.waitFor();
  for (const title of ['Повторы голов', 'Скачивание видео', 'Матч', 'Симуляция']) assert.equal(await page.locator(`[data-settings-section="${title}"]`).count(), 1, title);
  await shot(page, 'settings');
  await page.locator('[data-setting="autoReplay"] [role="radio"]', { hasText: 'Только мои' }).click();
  await page.locator('[data-setting="videoSlowmo"]').click();
  await page.locator('[data-setting="videoQuality"] [role="radio"]', { hasText: 'Быстро' }).click();
  await page.locator('[data-setting="videoHeight"] [role="radio"]', { hasText: '720p' }).click();
  await page.locator('[data-setting="matchSpeed"] [role="radio"]', { hasText: '×4' }).click();
  let st = await stored(page);
  assert.equal(st.autoReplay, 'mine'); assert.equal(st.videoSlowmo, false); assert.equal(st.videoQuality, 'fast'); assert.equal(st.videoHeight, 720); assert.equal(st.matchSpeed, 4);
  await page.locator('[data-setting="replay3d"]').click();
  assert.equal(await page.locator('[data-setting="replayQuality"] [role="radio"]').first().isDisabled(), true, '3D-only options are disabled without 3D');
  assert.equal((await stored(page)).replay3d, false);
  await page.reload();
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).waitFor();
  await page.locator('[data-startup-settings]').click();
  assert.equal(await page.locator('[data-setting="replay3d"]').getAttribute('aria-checked'), 'false', 'remembered after reload');
  await page.getByRole('button', { name: 'Готово' }).click();
  ok('settings window: sections, switches and choices persist across a reload');

  // 2. 3D off: the replay is drawn on the 2D rink (no WebGL), download hidden; the 3D/2D switch turns 3D on.
  await mountReplay(page);
  assert.equal(await page.locator('[data-replay-flat]').count(), 1);
  assert.equal(await page.locator('[data-replay-stage] canvas').count(), 0, 'no WebGL canvas in 2D mode');
  assert.equal(await page.locator('[data-replay-export]').count(), 0, 'no video export in 2D mode');
  // The 2D picture plays by itself: players move without touching the scrubber (they used to stand still).
  const flatPos = () => page.locator('[data-replay-flat] svg').innerHTML();
  const p0 = await flatPos(); await page.waitForTimeout(1200); const p1 = await flatPos();
  assert.notEqual(p0, p1, '2D replay must animate during playback');
  assert.ok(Number(await page.getByRole('slider', { name: 'Позиция повтора' }).inputValue()) > 0, 'the scrubber follows playback');
  await page.locator('[data-replay-mode="3D"]').click();
  await page.locator('[data-replay-stage] canvas').waitFor({ timeout: 30000 });
  await page.locator('[data-replay-preparing]').waitFor({ state: 'detached', timeout: 60000 });
  assert.equal((await stored(page)).replay3d, true);
  await closeReplay(page);
  ok('2D replay without WebGL; the in-replay switch turns 3D back on (and saves it)');

  // 3. Cached scene: the next replay of the same match reuses renderer, arena, figures and compiled shaders.
  const first = await mountReplay(page, 1);
  const glFirst = await page.evaluate(() => document.querySelector('[data-replay-stage] canvas'));
  await closeReplay(page);
  const times = [];
  for (let k = 2; k < 5; k++) { times.push(await mountReplay(page, k)); await closeReplay(page); }
  const best = Math.min(...times);
  console.log(`   open: ${first} ms after a 3D warm-up, then ${times.join(' / ')} ms`);
  assert.ok(best < 1500, `a cached replay is ready fast (${best} ms)`);
  void glFirst;
  ok(`cached 3D replay opens in ${best} ms`);

  // 4. Export with the settings (720p, fast, no slow motion) produces an MP4; the same download again is instant.
  // (~5 min of software rendering in CI; SKIP_EXPORT=1 to leave it out.)
  if (!process.env.SKIP_EXPORT) {
    await mountReplay(page, 7);
    assert.match(await page.locator('[data-replay-export]').getAttribute('title'), /настройках/);
    const t0 = Date.now();
    const download = page.waitForEvent('download', { timeout: 600000 });
    await page.locator('[data-replay-export]').click();
    await page.locator('[data-export-progress]').waitFor();
    assert.match(await page.locator('[data-export-progress]').innerText(), /720p30 · быстрый/);
    const file = await download;
    assert.match(file.suggestedFilename(), /^Gol_.*\.mp4$/);
    await page.locator('[data-export-note]').waitFor({ timeout: 60000 });
    const note = await page.locator('[data-export-note]').innerText();
    assert.match(note, /MP4 готов/); assert.match(note, /720p30/);
    const seconds = Number(note.match(/([\d.]+) с видео/)?.[1] ?? 0);
    assert.ok(seconds > 3 && seconds < 9, `no slow-motion part (${seconds} s)`);
    console.log(`   export: ${((Date.now() - t0) / 1000).toFixed(1)} s wall · ${note}`);
    const again = page.waitForEvent('download', { timeout: 10000 });
    const t1 = Date.now();
    await page.locator('[data-replay-export]').click();
    await again;
    assert.ok(Date.now() - t1 < 3000, 'second download comes from the cache');
    await page.waitForFunction(() => /уже был готов/.test(document.querySelector('[data-export-note]')?.textContent ?? ''));
    await closeReplay(page);
    ok('MP4 export follows the settings; repeating the download is instant');
  }

  // 5. Live match: «only my goals» / «off» auto-replay never freezes the match on a goal it should not replay.
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('khl.settings') ?? '{}'); s.autoReplay = 'off'; localStorage.setItem('khl.settings', JSON.stringify(s)); });
  await page.reload();
  await page.getByRole('button', { name: /^СКА/ }).click();
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).click();
  await page.locator('[data-header-settings]').waitFor();
  await page.locator('[data-header-settings]').click();
  await page.locator('[data-settings]').waitFor();
  assert.equal(await page.locator('[data-setting="autoReplay"] [aria-checked="true"]').innerText(), 'Выкл.');
  await page.getByRole('button', { name: 'Готово' }).click();
  for (let k = 0; k < 10; k++) {
    if (await page.getByRole('button', { name: 'Играть матч', exact: true }).count()) break;
    const b = page.getByRole('button', { name: 'Симулировать до матча', exact: true });
    if (!(await b.count())) break;
    await b.click();
    await page.waitForTimeout(200);
    const go = page.getByRole('button', { name: 'Всё равно продолжить', exact: true });
    if (await go.count()) await go.click();
    const pr = page.locator('[data-press-option]');
    if (await pr.count()) await pr.first().click();
  }
  await page.getByRole('button', { name: 'Играть матч', exact: true }).click();
  await page.locator('[data-match-mode="watch"]').click();
  await page.getByRole('button', { name: 'Начать матч', exact: true }).click();
  // ×4 comes from the settings.
  const x4 = page.locator('button.bg-ice', { hasText: '×4' }).locator('visible=true').first();
  await x4.waitFor({ timeout: 10000 });
  const goalRows = page.getByRole('button', { name: '3D повтор', exact: true });
  let goals = 0;
  for (let i = 0; i < 600 && goals < 1; i++) {
    await page.waitForTimeout(500);
    goals = await goalRows.count();
    assert.equal(await page.getByRole('dialog', { name: '3D-повтор гола' }).count(), 0, 'no auto-replay with the setting off');
  }
  assert.ok(goals > 0, 'a goal was scored');
  await page.waitForTimeout(1500);
  assert.equal(await page.getByRole('dialog', { name: '3D-повтор гола' }).count(), 0, 'no auto-replay with the setting off');
  ok(`auto-replay off: the match runs on through goals without opening replays `);
  await shot(page, 'match');
} catch (e) {
  console.error('FAIL', e.message);
  process.exitCode = 1;
} finally {
  console.log('page errors', errors);
  if (errors.length) process.exitCode = 1;
  await browser.close();
}
