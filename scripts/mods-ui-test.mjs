// Mods in the browser: the main menu lists mods/ and loads the chosen one (roster, calendar, logos from the mod
// folder), the new name and logo are shown, and a career saved before mods existed opens unchanged.
// Start Vite first: BASE_URL=http://localhost:5173 CHROMIUM_PATH=/path/to/chromium [SHOTS=dir] node scripts/mods-ui-test.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const SHOTS = process.env.SHOTS;
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];
const ok = (m) => console.log('ok', m);
const shot = async (page, name, opts = {}) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, timeout: 15000, ...opts }).catch((e) => console.log('shot failed', name, e.message)); };

const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.addInitScript(() => localStorage.setItem('khl.settings', JSON.stringify({ autoReplay: 'off', replay3d: false, replayPrewarm: false, matchIntro: false })));
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const fetched = [];
page.on('request', (r) => fetched.push(new URL(r.url()).pathname));

// The game ships with its own league «ХЛ» (mods/HL_2627): it is picked by default, its emblems load and a career
// starts from it. With no mod at all (index.json lists none) the start screen explains how to get one and a roster
// file picked by hand starts a career. The checks of the old KHL_2627 mod run when that mod is put into public/mods.
if (!existsSync('public/mods/KHL_2627/roster.json')) {
  try {
    await page.goto(BASE);
    await page.getByRole('button', { name: 'Начать карьеру', exact: true }).waitFor({ timeout: 60000 });
    const card = page.locator('[data-mod="HL_2627"]');
    await card.waitFor();
    assert.ok((await card.innerText()).includes('ХЛ — Хоккейная Лига 2026/27'));
    assert.ok((await card.getAttribute('class')).includes('border-accent'), 'the built-in league is picked by default');
    assert.equal(await card.locator('img').evaluate((i) => i.complete && i.naturalWidth > 0 && i.src.endsWith('/mods/HL_2627/cover.svg')), true, 'league emblem');
    assert.equal(await page.evaluate(() => localStorage.getItem('khl.mod')), 'HL_2627', 'choice remembered');
    await page.waitForFunction(() => [...document.querySelectorAll('img')].filter((i) => i.src.includes('/mods/HL_2627/logos/') && i.complete && i.naturalWidth > 0).length >= 24, null, { timeout: 30000 });
    const logos = await page.evaluate(() => [...document.querySelectorAll('img')].filter((i) => i.src.includes('/mods/HL_2627/logos/')).map((i) => i.complete && i.naturalWidth > 0));
    assert.ok(logos.every(Boolean), `club emblems from the mod folder (${logos.length})`);
    const body = await page.locator('body').innerText();
    assert.ok(!body.includes('КХЛ') && !body.includes('СКА') && !body.includes('ЦСКА'), 'nothing of the real league on the start screen');
    ok(`default league: HL_2627 picked, ${logos.length} emblems loaded`);
    await shot(page, 'menu-hl', { clip: { x: 0, y: 0, width: 1400, height: 900 } });
    await page.locator('[data-mod-picker]').scrollIntoViewIfNeeded();
    await shot(page, 'menu-hl-mods');

    await page.locator('button').filter({ hasText: /^Вьюга/ }).first().click();
    await page.getByRole('button', { name: 'Начать карьеру', exact: true }).click();
    await page.locator('aside').getByText('Hockey Simulator Manager').waitFor({ timeout: 60000 });
    const st = await page.evaluate(async () => {
      const G = await import('/src/game/state.ts');
      const s = G.store.get();
      return { mod: s.mod, league: s.league.name, team: s.userTeamId, coach: s.teams[s.userTeamId].coaches.map((c) => c.fictional), market: s.coachMarketSource, games: s.schedule.flat().length };
    });
    assert.deepEqual(st.mod, { id: 'HL_2627', name: 'ХЛ — Хоккейная Лига 2026/27', base: './mods/HL_2627', roster: './mods/HL_2627/roster.json' });
    assert.equal(st.league, 'ХЛ');
    assert.equal(st.team, 'vyuga');
    assert.deepEqual(st.coach, [true, true]);
    assert.equal(st.market, 'roster');
    assert.equal(st.games, (24 * 68) / 2);
    await page.waitForFunction(() => [...document.querySelectorAll('aside img')].some((i) => i.src.includes('/mods/HL_2627/logos/vyuga.svg') && i.complete && i.naturalWidth > 0), null, { timeout: 20000 });
    ok('career from «ХЛ»: own staff, roster coach market, generated 816-game calendar, club emblem in the sidebar');
    await page.waitForTimeout(800);
    await shot(page, 'career-hl');

    // a build without any mod: the empty state
    const bare = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await bare.route('**/mods/index.json*', (r) => r.fulfill({ json: { mods: [] } }));
    const p2 = await bare.newPage();
    p2.on('pageerror', (e) => errors.push(e.message));
    await p2.goto(BASE);
    const empty = p2.locator('[data-mods-empty]');
    await empty.waitFor({ timeout: 60000 });
    const text = await empty.innerText();
    assert.ok(text.includes('Лиги не найдены') && text.includes('roster.json'), 'the empty state explains what to do');
    assert.equal(await p2.locator('[data-mod-picker] [data-mod]').count(), 1, 'only «Свой файл ростера…» in the picker');
    assert.equal(await p2.getByText('не загрузился').count(), 0, 'no error panel for a missing built-in mod');
    await shot(p2, 'mods-empty');
    const chooser = p2.waitForEvent('filechooser');
    await p2.locator('[data-mods-empty-file]').click();
    await (await chooser).setFiles('scripts/fixtures/test-roster.json');
    await p2.getByRole('button', { name: 'Начать карьеру', exact: true }).waitFor({ timeout: 30000 });
    assert.equal(await p2.locator('[data-mods-empty]').count(), 0);
    ok('no mods: the start screen explains how to install one, a roster file starts a career');
    assert.deepEqual(errors, [], 'no page errors');
    console.log('PASS: mods browser flow with the built-in league (KHL_2627 checks skipped: the mod is not in public/mods)');
    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error('FAIL', e);
    await shot(page, 'mods-empty-fail');
    await browser.close();
    process.exit(1);
  }
}

try {
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).waitFor({ timeout: 60000 });
  assert.equal(await page.title(), 'Хоккейный Симулятор Менеджера – Hockey Simulator Manager');
  const body = await page.locator('body').innerText();
  assert.ok(body.includes('HOCKEY SIMULATOR MANAGER') || body.includes('Hockey Simulator Manager'), 'english name in the header');
  assert.ok(/Хоккейный симулятор/i.test(body), 'russian name in the header');
  assert.ok(!body.includes('КХЛ ГМ'), 'old name gone');
  const logoOk = await page.locator('[data-game-logo]').evaluate((img) => img.complete && img.naturalWidth > 100);
  assert.ok(logoOk, 'game logo loaded');
  ok('main menu: new name and logo');

  const card = page.locator('[data-mod="KHL_2627"]');
  await card.waitFor();
  assert.ok((await card.innerText()).includes('КХЛ 2026/27'));
  assert.ok((await card.getAttribute('class')).includes('border-accent'), 'the only mod is picked');
  assert.ok(body.includes('календарь из мода'), 'calendar comes from schedule.json');
  assert.ok(['/mods/index.json', '/mods/KHL_2627/mod.json', '/mods/KHL_2627/roster.json', '/mods/KHL_2627/schedule.json'].every((p) => fetched.includes(p)), 'mod files fetched');
  assert.equal(await page.evaluate(() => localStorage.getItem('khl.mod')), 'KHL_2627', 'choice remembered');
  const logos = await page.evaluate(() => [...document.querySelectorAll('img')].filter((i) => i.src.includes('/mods/KHL_2627/logos/')).map((i) => i.complete && i.naturalWidth > 0));
  assert.ok(logos.length >= 22 && logos.every(Boolean), `club logos from the mod folder (${logos.length})`);
  ok(`mod picker: KHL_2627 loaded with its calendar and ${logos.length} logos`);
  // «Предложить свой мод»: the GitHub issue form for a .zip; the mods folder button only in the Windows app
  assert.equal(await page.locator('[data-mod-submit]').getAttribute('href'), 'https://github.com/ClubGames/KHL_Manager/issues/new?template=mod.yml');
  assert.equal(await page.locator('[data-mod-submit]').getAttribute('target'), '_blank');
  assert.equal(await page.locator('[data-mod-folder]').count(), 0, 'no mods folder in the browser');
  assert.equal(await page.locator('[data-mod-install]').count(), 1, '«Установить мод» in the browser too (into the browser storage)');
  ok('mod links: «Предложить свой мод» opens the GitHub form');
  await shot(page, 'menu-top', { clip: { x: 0, y: 0, width: 1400, height: 900 } });
  await page.locator('[data-mod-picker]').scrollIntoViewIfNeeded();
  await shot(page, 'menu-mods');

  // format page documents the mod folder
  await page.getByRole('button', { name: 'Формат JSON' }).first().click();
  await page.locator('[data-mod-format]').waitFor();
  await shot(page, 'format-mods');
  await page.getByRole('button', { name: '← Назад' }).click();

  // new career from the mod
  await page.locator('button').filter({ hasText: /^СКА/ }).first().click();
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).click();
  await page.locator('aside').getByText('Hockey Simulator Manager').waitFor({ timeout: 60000 });
  const st = await page.evaluate(async () => {
    const G = await import('/src/game/state.ts');
    const s = G.store.get();
    return { mod: s.mod, league: s.league.name, games: s.schedule.flat().length, first: s.schedule.flat()[0] };
  });
  assert.deepEqual(st.mod, { id: 'KHL_2627', name: 'КХЛ 2026/27', base: './mods/KHL_2627', roster: './mods/KHL_2627/roster.json' });
  assert.equal(st.league, 'КХЛ');
  assert.equal(st.games, 748);
  const cal = JSON.parse(readFileSync('public/mods/KHL_2627/schedule.json', 'utf8'));
  const g0 = cal.games[0], day0 = Math.round((Date.parse(g0.date) - Date.parse('2026-09-01')) / 864e5);
  assert.deepEqual([st.first.home, st.first.away, st.first.day], [g0.home, g0.away, day0], 'the first game of schedule.json');
  ok('career started from the mod: 748 games of schedule.json, league name from the roster');
  await page.waitForTimeout(800);
  await shot(page, 'career');

  // A career saved before mods existed: no `mod` field. It must open as before and stay without one.
  const saveId = await page.evaluate(async () => {
    const G = await import('/src/game/state.ts');
    G.store.update((s) => { delete s.mod; });
    await G.saveNow();
    return G.store.get().saveId;
  });
  await page.goto(BASE);
  const saveCard = page.locator(`[data-save-card="${saveId}"]`);
  await saveCard.waitFor({ timeout: 60000 });
  assert.equal(await saveCard.locator("[data-save-mod]").count(), 0, 'old save card: no mod line');
  await saveCard.getByRole("button", { name: "Продолжить" }).click();
  await page.locator('aside').getByText('Hockey Simulator Manager').waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500); // roster sync runs after opening
  const old = await page.evaluate(async () => {
    const G = await import('/src/game/state.ts');
    const s = G.store.get();
    return { hasMod: 'mod' in s, league: s.league.name, logos: [...document.querySelectorAll('aside img')].map((i) => [i.src, i.complete && i.naturalWidth > 0]) };
  });
  assert.equal(old.hasMod, false, 'old save is not rewritten with a mod');
  assert.equal(old.league, 'КХЛ');
  assert.ok(old.logos.some(([src, loaded]) => src.includes('/mods/KHL_2627/logos/ska.png') && loaded), 'club logo found in the mod folder');
  ok('old save (no mod) opens, keeps its data, logos come from mods/KHL_2627');

  assert.deepEqual(errors, []);
  console.log('\nALL MOD UI CHECKS PASSED');
} catch (e) {
  console.error('FAIL', e);
  await shot(page, 'fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
