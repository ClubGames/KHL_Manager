// The menu's own games (QuickPlay.tsx): «Играть» → «Буллиты» — two clubs, the shooters, the series on the ice (the
// manager shoots, the strip counts the attempts, no bench calls), «Досимулировать серию», the board, «Ещё серия»,
// back to the menu; «Товарищеский матч» — two clubs, a whole match, «Ещё матч» / «В меню».
// Run: BASE_URL=http://localhost:5173 node scripts/shootout-ui-test.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { serveTestMod } from './testMod.mjs';

const browser = serveTestMod(await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] }));
const B = process.env.BASE_URL ?? 'http://localhost:5173';
const errors = [];
const ok = (m) => console.log('ok', m);

async function menuPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('khl.settings', JSON.stringify({ autoReplay: 'off', matchView: '2d', playPeriod: 3 })));
  await page.goto(B);
  await page.evaluate(() => sessionStorage.setItem('khl.start', 'menu'));
  await page.reload();
  await page.locator('[data-main-menu="main"]').waitFor();
  return page;
}
async function pickClubs(p) {
  await p.locator('[data-online-team]').first().waitFor({ timeout: 15000 });
  await p.locator('[data-online-team]').nth(2).click();
  await p.locator('[data-quick-picker="theirs"]').waitFor();
  await p.locator('[data-online-team]').nth(5).click();
  await p.locator('[data-quick-start]:not([disabled])').waitFor();
}

try {
  const p = await menuPage();
  await p.locator('[data-menu-item="play"]').click();
  assert.deepEqual(await p.locator('[data-main-menu="play"] [data-menu-item]').evaluateAll((b) => b.map((x) => x.dataset.menuItem)), ['career', 'shootout', 'friendly']);
  ok('«Играть»: Карьера, Буллиты, Товарищеский матч');

  await p.locator('[data-menu-item="shootout"]').click();
  await p.locator('[data-quick-play="so"]').waitFor();
  assert.equal(await p.locator('[data-quick-start]').isDisabled(), true, 'no clubs yet');
  await pickClubs(p);
  await p.locator('[data-shooter-picker]').waitFor();
  const first = p.getByLabel('1-й буллит'), opts = await first.locator('option').evaluateAll((o) => o.map((x) => x.value));
  await first.selectOption(opts[3]);
  ok('two clubs picked, the three shooters can be changed');

  await p.locator('[data-quick-start]').click();
  await p.locator('[data-play-so-intro]').waitFor();
  assert.equal(await p.locator('#playPeriod').count(), 0, 'no period length for a shootout');
  await p.locator('[data-play-start]').click();
  const strip = p.locator('[data-shootout-strip]');
  await strip.waitFor({ timeout: 20000 });
  await p.locator('[data-play-so]').waitFor();
  assert.equal(await p.locator('[data-play-change], [data-play-pull], [data-play-timeout], [data-play-strip]').count(), 0, 'no bench calls in a shootout');
  // his first attempt: the shooter he picked, skating at the net, a shot
  await p.waitForFunction(() => document.querySelector('[data-shootout-strip]')?.getAttribute('data-shootout-next') === 'mine' && document.querySelector('[data-play-ctl]'), null, { timeout: 20000 });
  await p.keyboard.down('KeyD'); await p.waitForTimeout(2300);
  await p.keyboard.down('Space'); await p.waitForTimeout(90); await p.keyboard.up('Space'); await p.keyboard.up('KeyD');
  await p.waitForFunction(() => document.querySelector('[data-shootout-strip]')?.getAttribute('data-shootout-next') === 'theirs', null, { timeout: 20000 });
  ok('the series on the ice: the strip, his attempt taken, then the other side\'s');

  await p.locator('[data-play-pause]').click();
  await p.locator('[data-play-simrest]').click();
  const res = p.locator('[data-play-so-result]');
  await res.waitFor({ timeout: 20000 });
  assert.ok(['win', 'loss'].includes(await res.getAttribute('data-play-so-result')));
  const n = Number(await p.locator('[data-shootout-attempts]').getAttribute('data-shootout-attempts'));
  assert.ok(n >= 4, `the board has the series (${n} attempts)`);
  ok(`«Досимулировать серию»: the board, ${await res.getAttribute('data-play-so-result')}`);

  await p.locator('[data-play-so-again]').click();
  await p.locator('[data-play-so-intro]').waitFor();
  await p.locator('[data-play-quit]').click();
  await p.locator('[data-quick-play="so"]').waitFor();
  await p.locator('[data-quick-back]').click();
  await p.locator('[data-main-menu]').waitFor();
  ok('«Ещё серия» starts a new one, «Назад» / «← Меню» lead back');

  await p.locator('[data-menu-item="play"]').click();
  await p.locator('[data-menu-item="friendly"]').click();
  await p.locator('[data-quick-play="match"]').waitFor();
  assert.equal(await p.locator('[data-shooter-picker]').count(), 0);
  await pickClubs(p);
  await p.locator('[data-quick-side="1"]').click();
  await p.locator('[data-quick-start]').click();
  await p.locator('[data-play-start]').waitFor();
  assert.match(await p.locator('[data-play-match]').innerText(), /Товарищеский матч/);
  await p.getByRole('button', { name: 'Досимулировать', exact: true }).click();
  await p.locator('[data-play-final]').waitFor({ timeout: 30000 });
  assert.equal(await p.locator('[data-play-finish]').count(), 0, 'no «Продолжить сезон»');
  await p.locator('[data-play-again]').waitFor();
  await p.locator('[data-play-quit]').click();
  await p.locator('[data-quick-play="match"]').waitFor();
  await p.keyboard.press('Escape');
  await p.locator('[data-main-menu]').waitFor();
  ok('«Товарищеский матч»: a whole match, «Ещё матч» / «В меню», Esc back to the menu');

  assert.deepEqual(errors, []);
  console.log('shootout-ui-test: all passed');
} catch (e) {
  console.error(e);
  console.error('page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
