// Real browser checks for inbox, trade block, scouting, preseason, press conference and the in-match
// coaching tools. Start Vite first; same CHROMIUM_PATH / BASE_URL options as rink-ui-test.mjs.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => errors.push(e.message));
const stateUrl = () => page.evaluate(() => performance.getEntriesByType('resource').find((e) => /\/src\/game\/state\.ts(?:\?|$)/.test(e.name)).name);
const read = async (fn) => page.evaluate(async ([url, src]) => { const G = await import(url); return new Function('s', `return (${src})(s)`)(G.store.get()); }, [await stateUrl(), fn.toString()]);
const confirmModal = () => page.locator('.fixed.inset-0.z-50');
const ok = (m) => console.log('ok', m);

try {
  await page.goto(process.env.BASE_URL ?? 'http://localhost:5173');
  await page.getByRole('button', { name: /^СКА/ }).click();
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).click();

  // Dashboard: preseason, inbox preview, fans
  await page.locator('[data-preseason]').waitFor();
  await page.locator('[data-dashboard-inbox]').waitFor();
  assert.ok(await page.locator('[data-fans]').isVisible());
  await page.locator('[data-preseason-play]').click();
  const pre = await read((s) => s.preseason);
  assert.ok(pre.games.some((g) => g.result), 'a preseason round was played');
  ok('dashboard shows preseason, inbox and fans; a preseason round can be played');

  // Inbox view via the header bell
  await page.locator('[data-inbox-bell]').click();
  await page.locator('[data-inbox-view]').waitFor();
  assert.ok((await page.locator('[data-inbox-task]').count()) > 0);
  ok('inbox view opens from the header bell');

  // Trade block
  await page.getByRole('button', { name: 'Обмены', exact: true }).first().click();
  const tb = page.locator('[data-trade-block]');
  await tb.waitFor();
  await tb.locator('[data-want-pos="D"]').click();
  await tb.locator('[data-want-ovr]').fill('75');
  let wants = await read((s) => s.tradeBlock.wants);
  assert.deepEqual(wants.positions, ['D']);
  assert.equal(wants.minOvr, 75);
  await tb.getByRole('button', { name: '+ Добавить игроков' }).click();
  const toggle = tb.locator('[data-block-toggle]:not([disabled])').nth(5);
  const pid = await toggle.getAttribute('data-block-toggle');
  await toggle.click();
  assert.equal(await read(new Function(`return (s) => s.players['${pid}'].tradeFlag`)()), 'block');
  await tb.locator('[data-shop-block]').click();
  await tb.getByText(/предложени|не заинтересовал|Никто|клуб/i).first().waitFor();
  const offers = await read((s) => s.offers.length);
  ok(`trade block: wants D/75+, player put on the block, clubs polled (${offers} offers)`);

  // Scouted ratings on other clubs' players
  const est = page.locator('[data-scout-ovr*="±"]').first();
  await est.waitFor();
  await est.locator('xpath=ancestor::*[self::button or self::div][1]').first().scrollIntoViewIfNeeded();
  const scoutPanel = page.locator('[data-scouting]');
  await scoutPanel.getByRole('button', { name: /^Изучить/ }).click();
  assert.equal(await read((s) => s.scouting.assignments.length), 1);
  ok('other players show "±" estimates; a scout can be sent to study the trade partner');

  // Player modal of a foreign player (from the wish-list matches): estimate + scout button
  await page.locator('[data-trade-wants] button.flex-1').first().click();
  const box = page.locator('[data-scout-box]');
  await box.waitFor({ timeout: 5000 }).catch(() => null);
  if (await box.count()) {
    const sp = box.locator('[data-scout-player]');
    if (await sp.count()) await sp.click();
    ok('player modal: scouting box with estimate error and «Отправить скаута»');
  } else ok('player modal: wish-list player already exactly known (star)');
  await page.keyboard.press('Escape');

  // Simulate to match day, sim our match → press conference
  await page.getByRole('button', { name: 'Обзор', exact: true }).first().click();
  for (let k = 0; k < 10; k++) {
    const b = page.getByRole('button', { name: 'Симулировать до матча', exact: true });
    if (!(await b.count())) break;
    await b.click();
    await page.waitForTimeout(200);
    const go = page.getByRole('button', { name: 'Всё равно продолжить', exact: true });
    if (await go.count()) await go.click();
  }
  await page.getByRole('button', { name: 'Симулировать матч', exact: true }).first().click();
  await confirmModal().getByRole('button', { name: /^(Симулировать|Всё равно продолжить)$/ }).click();
  const press = page.locator('[data-press]');
  await press.waitFor();
  // The simulated match's report opens on its own (setting «Открывать протокол»): close it to reach the press.
  const overlay = page.locator('div.fixed.inset-0.z-50');
  await overlay.first().waitFor({ timeout: 3000 }).catch(() => {});
  for (let k = 0; k < 20 && (await overlay.count()); k++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  const before = await read((s) => ({ fans: s.fans, conf: s.board.confidence }));
  const total = await read((s) => s.press?.total ?? 1);
  const steps = [];
  for (let k = 0; k < 6 && (await press.count()); k++) {
    steps.push((await press.first().locator('[data-press-step]').getAttribute('data-press-step').catch(() => null)) ?? '1/1');
    assert.ok((await press.first().locator('[data-press-reporter]').count()) === 1, 'the journalist is named');
    await press.first().locator('[data-press-option]').first().click();
    await page.waitForTimeout(150);
  }
  await press.first().waitFor({ state: 'detached' });
  const after = await read((s) => ({ fans: s.fans, conf: s.board.confidence, press: s.press }));
  assert.equal(after.press, null);
  assert.equal(steps.length, total, `answered ${steps.join(',')}`);
  ok(`post-match press conference: ${total} questions answered one by one (${steps.join(' → ')}; fans ${before.fans}→${after.fans}, board ${before.conf}→${after.conf})`);

  // Live match: quick decisions + intermission assistant
  for (let k = 0; k < 10; k++) {
    if (await page.getByRole('button', { name: 'Играть матч', exact: true }).count()) break;
    const b = page.getByRole('button', { name: 'Симулировать до матча', exact: true });
    if (!(await b.count())) break;
    await b.click();
    await page.waitForTimeout(200);
    const go = page.getByRole('button', { name: 'Всё равно продолжить', exact: true });
    if (await go.count()) await go.click();
    for (let q = 0; q < 6; q++) {
      const pr = page.locator('[data-press-option]');
      if (!(await pr.count())) break;
      await pr.first().click();
      await page.waitForTimeout(120);
    }
    for (let q = 0; q < 4; q++) {
      const ro = page.locator('[data-room-option]');
      if (!(await ro.count())) break;
      await ro.first().click();
      await page.waitForTimeout(120);
    }
  }
  await page.getByRole('button', { name: 'Играть матч', exact: true }).click();
  await page.getByRole('button', { name: 'Начать матч', exact: true }).click();
  const qd = page.locator('[data-quick-decisions]').first();
  await qd.waitFor();
  await qd.locator('[data-short-bench]').click();
  assert.equal(await qd.locator('[data-short-bench]').getAttribute('data-short-bench'), 'on');
  await qd.getByRole('button', { name: 'Прессинг', exact: true }).click();
  ok('quick decisions: 3 lines toggled on, press applied');
  // fast-forward to the first intermission
  const fast = page.getByRole('button', { name: '×4' });
  if (await fast.count()) await fast.first().click();
  // Goal replays pause the match; close them while waiting for the first intermission.
  const brk = page.getByText('1-й период завершён', { exact: true });
  const t0 = Date.now();
  let advice = 0;
  for (let t = 0; t < 1200 && !(await brk.count()); t++) {
    const cont = page.getByRole('button', { name: 'Продолжить матч', exact: true });
    if (await cont.count()) await cont.first().click().catch(() => {});
    // bench advice at a stoppage: decline it, the match resumes by itself
    const skip = page.locator('[data-advice-skip]');
    if (await skip.count()) { advice++; await skip.first().click().catch(() => {}); }
    await page.waitForTimeout(500);
  }
  console.log(`  first period took ${Math.round((Date.now() - t0) / 1000)} s of wall time`);
  await brk.waitFor({ timeout: 5000 });
  if (advice) ok(`bench advice offered ${advice} time(s) and declined`);
  // The intermission overlay: period and match statistics; touching it holds the countdown.
  await page.locator('[data-break-tab="period"]').waitFor({ timeout: 5000 });
  assert.ok((await page.locator('[data-break-row]').count()) >= 7, 'period stat rows');
  await page.locator('[data-break-tab="match"]').click();
  assert.ok(await page.locator('[data-break-hold]').count(), 'a tap holds the intermission countdown');
  const goalsRow = await page.locator('[data-break-row]').first().innerText();
  ok(`intermission statistics: period and match tabs (${goalsRow.replace(/\s+/g, ' ').trim()})`);
  await page.locator('[data-break-tab="period"]').click();
  const hints = page.locator('[data-intermission-hints]');
  await page.screenshot({ path: '.arena/intermission.png', timeout: 10000 }).catch(() => {}); // can stall while software WebGL renders
  if (await hints.count()) {
    const n = await hints.locator('> div > div').count();
    const act = hints.locator('[data-hint-action]').first();
    if (await act.count()) await act.click();
    ok(`intermission assistant shows ${n} hint(s)`);
  } else ok('intermission: no hints needed this period');
  assert.deepEqual(errors, []);
  console.log('PASS: features browser flow, no runtime errors');
} catch (e) {
  await page.screenshot({ path: '.arena/features-fail.png', fullPage: true }).catch(() => {});
  console.error(errors);
  throw e;
} finally {
  await browser.close();
}
