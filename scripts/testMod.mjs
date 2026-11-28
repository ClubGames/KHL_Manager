// Browser tests run on a small synthetic league instead of the built-in «ХЛ» (mods/HL_2627). They call
// serveTestMod(browser): unless a real mods/KHL_2627 lies in public/mods, every page of the browser is served a mod
// «KHL_2627» made of the synthetic roster scripts/fixtures/test-roster.json (same club ids: ska, avangard, …).
import { existsSync, readFileSync } from 'node:fs';

export const HAS_REAL_MOD = existsSync('public/mods/KHL_2627/roster.json');

/**
 * The tests open the game on the career screen (saves, a new career), as it was before the main menu came: an init
 * script for a page or a context. A test of the menu itself sets sessionStorage «khl.start» to 'menu' and reloads.
 */
export const START_IN_CAREER = "try { if (sessionStorage.getItem('khl.start') === null) sessionStorage.setItem('khl.start', 'career'); } catch {}";

export function serveTestMod(browser) {
  const roster = HAS_REAL_MOD ? '' : readFileSync('scripts/fixtures/test-roster.json', 'utf8');
  const route = async (target) => {
    await target.addInitScript(START_IN_CAREER);
    if (HAS_REAL_MOD) return;
    await target.route('**/mods/index.json*', (r) => r.fulfill({ json: { mods: ['KHL_2627'] } }));
    await target.route('**/mods/KHL_2627/mod.json*', (r) => r.fulfill({ json: { name: 'Тестовая лига', schedule: null } }));
    await target.route('**/mods/KHL_2627/roster.json*', (r) => r.fulfill({ body: roster, contentType: 'application/json; charset=utf-8' }));
  };
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const ctx = await newContext(options);
    await route(ctx);
    return ctx;
  };
  browser.newPage = async (options) => {
    const ctx = await browser.newContext(options);
    const page = await ctx.newPage();
    page.on('close', () => void ctx.close().catch(() => {}));
    return page;
  };
  return browser;
}
