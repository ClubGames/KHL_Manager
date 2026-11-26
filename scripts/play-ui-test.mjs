// The played match: «Играть матч» opens the choice (Играть / Симуляция / Быстрая симуляция); «Играть» opens the
// playable rink — keyboard and touch controls move the controlled skater, the clock runs, pause works, the rest
// can be simulated and the result goes into the season. «Быстрая симуляция» plays the game at once.
// Start Vite first. Optional deps: npm install --no-save --package-lock=false @playwright/test
// BASE_URL=http://localhost:5173 CHROMIUM_PATH=/path/to/chromium node scripts/play-ui-test.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { serveTestMod } from './testMod.mjs';
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
serveTestMod(browser);
const errors = [];
async function open(options = {}, settings = {}) {
  const page = await browser.newPage(options);
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(s => localStorage.setItem('khl.settings', JSON.stringify(s)), { autoReplay: 'off', matchView: '2d', playPeriod: 3, ...settings });
  await page.goto(process.env.BASE_URL ?? 'http://localhost:5173');
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).waitFor();
  await page.getByRole('button', { name: /^СКА/ }).click();
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).click();
  const toMatch = page.getByRole('button', { name: 'Симулировать до матча', exact: true });
  for (let k = 0; k < 8 && await toMatch.count(); k++) { await toMatch.click(); await page.waitForTimeout(150); const go = page.getByRole('button', { name: 'Всё равно продолжить', exact: true }); if (await go.count()) { await go.click(); await page.waitForTimeout(150); } }
  await page.getByRole('button', { name: 'Играть матч', exact: true }).waitFor();
  return page;
}
const pctX = async (page, id) => Number((await page.locator(`[data-rink-player="${id}"]`).getAttribute('transform')).match(/translate\(([-\d.]+)/)[1]);
try {
  // ---- the choice
  const page = await open({ viewport: { width: 1280, height: 800 } });
  await page.getByRole('button', { name: 'Играть матч', exact: true }).click();
  const modes = page.locator('[data-match-modes]');
  await modes.waitFor();
  assert.deepEqual(await modes.locator('[data-match-mode]').evaluateAll(b => b.map(x => x.getAttribute('data-match-mode'))), ['play', 'watch', 'quick']);
  assert.match(await modes.innerText(), /Играть[\s\S]*Симуляция[\s\S]*Быстрая симуляция/);
  // ---- play
  await page.locator('[data-match-mode="play"]').click();
  await page.locator('[data-play-match][data-phase="intro"]').waitFor();
  assert.match(await page.locator('[data-play-controls]').innerText(), /W A S D/);
  await page.locator('[data-play-start]').click();
  await page.locator('[data-play-match][data-phase="playing"]').waitFor();
  await page.locator('[data-live-rink]').waitFor();
  // the faceoff, then the controlled skater (the ring) skates where the stick points
  await page.locator('[data-rink-ctrl]').waitFor({ timeout: 8000 });
  await page.waitForFunction(() => !document.querySelector('[data-live-rink][data-stopped]'), null, { timeout: 15000 });
  const clock0 = await page.locator('[data-play-clock]').innerText();
  const ctl = await page.locator('[data-rink-ctrl]').evaluate(n => n.closest('[data-rink-player]').getAttribute('data-rink-player'));
  const x0 = await pctX(page, ctl);
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(900);
  await page.keyboard.up('KeyD');
  const ctl1 = await page.locator('[data-rink-ctrl]').evaluate(n => n.closest('[data-rink-player]').getAttribute('data-rink-player'));
  if (ctl1 === ctl) assert.ok(Math.abs((await pctX(page, ctl)) - x0) > 2, 'the controlled skater moves with the keys');
  assert.notEqual(await page.locator('[data-play-clock]').innerText(), clock0, 'the clock runs');
  // a held shot (or a check without the puck) and a switch do not break anything
  await page.keyboard.down('Space'); await page.waitForTimeout(400); await page.keyboard.up('Space');
  await page.keyboard.press('KeyC');
  await page.waitForTimeout(300);
  assert.ok(await page.locator('[data-play-hud]').count(), 'HUD');
  // ---- pause and simulate the rest
  await page.keyboard.press('Escape');
  await page.locator('[data-play-resume]').waitFor();
  const frozen = await page.locator('[data-play-clock]').innerText();
  await page.waitForTimeout(600);
  assert.equal(await page.locator('[data-play-clock]').innerText(), frozen, 'paused: the clock stands');
  await page.locator('[data-play-simrest]').click();
  await page.locator('[data-play-final]').waitFor({ timeout: 30000 });
  const score = await page.locator('[data-play-score]').getAttribute('data-play-score');
  const [h, a] = score.split(':').map(Number);
  assert.notEqual(h, a, `a winner (${score})`);
  assert.ok(await page.locator('[data-play-box]').count(), 'box score');
  await page.locator('[data-play-finish]').click();
  await page.locator('[data-play-match]').waitFor({ state: 'detached' });
  // the result is in the season: the dashboard shows the next game (no «Играть матч» for a played day)
  await page.waitForTimeout(300);
  assert.equal(await page.getByRole('button', { name: 'Играть матч', exact: true }).count(), 0, 'the game is played');
  await page.close();

  // ---- quick simulation from the choice
  const quick = await open({ viewport: { width: 1280, height: 800 } }, { simConfirm: false, simOpenReport: true });
  await quick.getByRole('button', { name: 'Играть матч', exact: true }).click();
  await quick.locator('[data-match-mode="quick"]').click();
  await quick.waitForTimeout(600);
  assert.equal(await quick.getByRole('button', { name: 'Играть матч', exact: true }).count(), 0, 'quick simulation played the game');
  assert.equal(await quick.locator('[data-play-match]').count(), 0);
  await quick.close();

  // ---- a phone held sideways: the touch stick and buttons
  const phone = await open({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true }, { playTouch: 'on' });
  await phone.getByRole('button', { name: 'Играть матч', exact: true }).click();
  await phone.locator('[data-match-mode="play"]').click();
  await phone.locator('[data-play-start]').click();
  await phone.locator('[data-play-touch]').waitFor();
  for (const b of ['shoot', 'pass', 'deke', 'swap', 'sprint']) assert.ok(await phone.locator(`[data-touch="${b}"]`).isVisible(), `touch button ${b}`);
  await phone.locator('[data-rink-ctrl]').waitFor({ timeout: 8000 });
  await phone.waitForFunction(() => !document.querySelector('[data-live-rink][data-stopped]'), null, { timeout: 15000 });
  const pid = await phone.locator('[data-rink-ctrl]').evaluate(n => n.closest('[data-rink-player]').getAttribute('data-rink-player'));
  const px0 = await pctX(phone, pid);
  // drag the stick to the left with a pointer (touch-style pointer events)
  const zone = await phone.locator('[data-play-stick-zone]').boundingBox();
  const sx = zone.x + zone.width * 0.5, sy = zone.y + zone.height * 0.6;
  await phone.locator('[data-play-stick-zone]').dispatchEvent('pointerdown', { pointerId: 7, clientX: sx, clientY: sy, pointerType: 'touch', isPrimary: true, bubbles: true });
  await phone.locator('[data-play-stick-zone]').dispatchEvent('pointermove', { pointerId: 7, clientX: sx - 60, clientY: sy, pointerType: 'touch', isPrimary: true, bubbles: true });
  await phone.waitForTimeout(900);
  const moved = await phone.locator(`[data-rink-player="${pid}"]`).count() ? Math.abs((await pctX(phone, pid)) - px0) : 99;
  await phone.locator('[data-play-stick-zone]').dispatchEvent('pointerup', { pointerId: 7, clientX: sx - 60, clientY: sy, pointerType: 'touch', isPrimary: true, bubbles: true });
  assert.ok(moved > 1.5, `the touch stick moves the skater (${moved.toFixed(1)})`);
  // the shot button holds a charge
  await phone.locator('[data-touch="shoot"]').dispatchEvent('pointerdown', { pointerId: 8, pointerType: 'touch', bubbles: true });
  await phone.waitForTimeout(250);
  await phone.locator('[data-touch="shoot"]').dispatchEvent('pointerup', { pointerId: 8, pointerType: 'touch', bubbles: true });
  // the skill stick: its own zone between the skating stick and the buttons; a pull back and a flick go through
  const skill = phone.locator('[data-play-skill-zone]');
  assert.ok(await skill.isVisible(), 'the skill-stick zone');
  const kz = await skill.boundingBox(), bz = await phone.locator('[data-play-buttons]').boundingBox(), lz = await phone.locator('[data-play-stick-zone]').boundingBox();
  assert.ok(kz.x >= lz.x + lz.width - 1 && kz.x + kz.width <= bz.x + 1 && kz.width > 120, `skill zone between the stick and the buttons (${JSON.stringify(kz)})`);
  const kx = kz.x + kz.width / 2, ky = kz.y + kz.height * 0.6;
  for (const [x, y, t] of [[kx, ky, 'pointerdown'], [kx - 50, ky, 'pointermove'], [kx - 55, ky, 'pointermove'], [kx + 60, ky, 'pointermove'], [kx + 60, ky, 'pointerup']]) {
    await skill.dispatchEvent(t, { pointerId: 9, clientX: x, clientY: y, pointerType: 'touch', isPrimary: false, bubbles: true });
    await phone.waitForTimeout(t === 'pointermove' ? 160 : 40);
  }
  await phone.screenshot({ path: '.arena/shots/play-phone-skill.png' }).catch(() => {});
  await phone.close();

  assert.deepEqual(errors, []);
  console.log('play-ui-test: ok');
} finally {
  await browser.close();
}
