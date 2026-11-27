// The online mode in a browser: two tabs of one browser are two devices (the «two tabs» loop). One creates the
// game, the other finds it and joins; both pick clubs, the host sets the match, both press «Готов» → the match on
// both screens (the guest's picture follows the host's rink, the guest's keys skate his man), pause for both,
// leaving ends it for the other player too.
// Start Vite first. BASE_URL=http://localhost:5173 CHROMIUM_PATH=/path/to/chromium node scripts/online-ui-test.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { serveTestMod } from './testMod.mjs';
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});
serveTestMod(browser);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const errors = [];
async function open(name) {
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  // two tabs stand for two devices, each in front of its player: neither is ever «hidden»
  await page.addInitScript(() => { Object.defineProperty(document, 'hidden', { get: () => false }); Object.defineProperty(document, 'visibilityState', { get: () => 'visible' }); });
  await page.addInitScript(([n]) => { localStorage.setItem('khl.settings', JSON.stringify({ autoReplay: 'off', matchView: '2d' })); localStorage.setItem('khl-online-name', n); }, [name]);
  await page.goto(process.env.BASE_URL ?? 'http://localhost:5173');
  await page.locator('[data-startup-online-card]').click();
  await page.locator('[data-online-screen]').waitFor();
  return page;
}
try {
  const host = await open('Хозяин');
  assert.match(await host.locator('[data-online-browser]').innerText(), /второй вкладке/);
  await host.locator('[data-online-host]').click();
  await host.locator('[data-online-hosting]').waitFor();

  const guest = await open('Гость');
  const room = guest.locator('[data-online-room]').first();
  await room.waitFor({ timeout: 5000 });
  assert.match(await room.innerText(), /Хозяин/);
  await room.click();

  // the lobby on both sides
  await host.locator('[data-online-lobby="host"]').waitFor({ timeout: 5000 });
  await guest.locator('[data-online-lobby="guest"]').waitFor({ timeout: 5000 });
  assert.equal(await host.locator('[data-online-peer]').innerText(), 'Гость');
  assert.equal(await guest.locator('[data-online-peer]').innerText(), 'Хозяин');
  assert.equal(await host.locator('[data-online-ready]').isDisabled(), true, 'no club — no ready');
  await host.locator('[data-online-team]').first().waitFor({ timeout: 15000 });
  await guest.locator('[data-online-team]').first().waitFor({ timeout: 15000 });
  await host.locator('[data-online-team]').nth(0).click();
  await guest.locator('[data-online-team]').nth(1).click();
  // the clubs reached the other side
  await guest.locator('[data-online-club="peer"] [data-online-mod-hint="ok"]').waitFor({ timeout: 5000 });
  await host.locator('[data-online-club="peer"] [data-online-mod-hint]').waitFor({ timeout: 5000 });
  // the host's settings; the guest sees them and cannot change them
  await host.getByRole('button', { name: '3 мин', exact: true }).click();
  await guest.waitForFunction(() => document.querySelector('button[aria-pressed="true"]')?.textContent === '3 мин', null, { timeout: 3000 });
  assert.equal(await guest.getByRole('button', { name: '5 мин', exact: true }).isDisabled(), true);
  await host.screenshot({ path: '/tmp/online-lobby-host.png' });
  await guest.screenshot({ path: '/tmp/online-lobby-guest.png' });

  await host.locator('[data-online-ready]').click();
  await guest.locator('[data-online-ready-chip="on"]').first().waitFor();
  await guest.locator('[data-online-ready]').click();

  // the match
  await host.locator('[data-online-match="host"]').waitFor({ timeout: 8000 });
  await guest.locator('[data-online-match="guest"]').waitFor({ timeout: 8000 });
  await host.locator('[data-online-match][data-phase="playing"]').waitFor({ timeout: 25000 });
  await guest.locator('[data-online-match][data-phase="playing"]').waitFor({ timeout: 10000 });
  // the opening draw, then the clock runs on both
  await guest.keyboard.press('KeyF');
  await host.keyboard.press('KeyF');
  await host.waitForTimeout(4000);
  assert.equal(await host.locator('[data-online-paused]').count(), 0, 'nobody paused');
  const clockH = await host.locator('[data-play-clock]').innerText(), clockG = await guest.locator('[data-play-clock]').innerText();
  console.log(`   clocks: host ${clockH} · guest ${clockG}`);
  assert.match(await host.locator('[data-play-score]').innerText(), /1-й период/, 'the match starts with the 1st period');
  assert.match(await guest.locator('[data-play-score]').innerText(), /1-й период/);
  assert.ok(clockH && clockG, 'both show the clock');
  assert.ok(await guest.locator('[data-rink-player]').count() >= 10, 'the guest sees the players');
  // the guest skates: hold D for a moment (his HUD names his man)
  await guest.keyboard.down('KeyD'); await guest.waitForTimeout(700); await guest.keyboard.up('KeyD');
  await guest.locator('[data-play-ctl]').waitFor({ timeout: 5000 });
  await guest.screenshot({ path: '/tmp/online-match-guest.png' });
  await host.screenshot({ path: '/tmp/online-match-host.png' });
  // the guest's menu: the match goes on (the host plays on, the AI takes the guest's team), the host is told
  await guest.locator('[data-play-pause]').click();
  await guest.locator('[data-online-paused]').waitFor({ timeout: 3000 });
  await host.locator('[data-online-peer-away]').waitFor({ timeout: 3000 });
  assert.equal(await host.locator('[data-online-paused]').count(), 0, 'the host is not stopped');
  const c1 = await host.locator('[data-play-clock]').innerText(); await host.waitForTimeout(2500);
  assert.notEqual(await host.locator('[data-play-clock]').innerText(), c1, 'the clock runs on');
  // a timeout from the guest's menu: both screens show it
  await guest.locator('[data-play-pause-timeout]').click();
  await guest.waitForFunction(() => !document.querySelector('[data-online-paused]'), null, { timeout: 3000 });
  await host.waitForFunction(() => !document.querySelector('[data-online-peer-away]'), null, { timeout: 3000 });
  assert.match(await guest.locator('[data-play-match]').innerText(), /при следующей остановке/, 'in play: it waits for the whistle');
  // both in their menus: the AI plays both teams and soon whistles (the timeout comes then)
  await guest.locator('[data-play-pause]').click(); await host.locator('[data-play-pause]').click();
  await host.locator('[data-play-timeout-on="theirs"]').waitFor({ state: 'attached', timeout: 150000 });
  await guest.locator('[data-play-resume]').click(); await host.locator('[data-play-resume]').click();
  await guest.locator('[data-play-timeout-on="mine"]').waitFor({ timeout: 5000 });
  console.log('   timeout:', (await guest.locator('[data-play-timeout-on]').innerText()).replace(/\s+/g, ' '));
  assert.ok(await guest.locator('[data-play-line]').count() > 0, 'the unit on the ice is named');
  const left = async (p) => Number((await p.locator('[data-play-timeout-left]').innerText()).split(':')[1]);
  const l0 = await left(guest); await guest.waitForTimeout(3000);
  const l1 = await left(guest), lh = await left(host);
  console.log(`   timeout seconds: ${l0} → ${l1} (host ${lh})`);
  assert.ok(l1 <= l0 - 2 && Math.abs(lh - l1) <= 1, 'the seconds count down on both screens');
  await guest.screenshot({ path: '/tmp/online-timeout-guest.png' });
  await guest.locator('[data-play-timeout-skip]').click();
  await host.waitForFunction(() => !document.querySelector('[data-play-timeout-on]'), null, { timeout: 5000 });
  // the guest leaves: the host is told and waits for a new guest
  await guest.locator('[data-play-pause]').click();
  await guest.locator('[data-online-leave]').click();
  await guest.getByRole('button', { name: 'Выйти', exact: true }).last().click();
  await host.locator('[data-online-notice]').waitFor({ timeout: 5000 });
  console.log('   host notice:', await host.locator('[data-online-notice]').innerText());
  await host.locator('[data-online-hosting]').waitFor({ timeout: 3000 });
  await guest.locator('[data-online-notice]').waitFor({ timeout: 3000 });
  assert.deepEqual(errors, []);
  console.log('✓ online in two tabs: lobby, clubs, settings, ready, the match on both screens, the menu that does not stop play, a timeout, leaving');
} finally {
  await browser.close();
}
