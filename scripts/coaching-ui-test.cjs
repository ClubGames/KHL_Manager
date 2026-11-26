// Build first. npm install --no-save --package-lock=false jsdom@26
// Then: node scripts/coaching-ui-test.cjs
const { JSDOM, VirtualConsole } = require('jsdom');
const assert = require('node:assert/strict');
const fs = require('node:fs');
// checks the real data of the KHL_2627 mod, which is not in the repository (the game ships with its own invented league «ХЛ» instead)
if (!fs.existsSync('public/mods/KHL_2627/roster.json')) {
  console.log('SKIP: put the KHL_2627 mod into public/mods to run this test');
  process.exit(0);
}
const html = fs.readFileSync('dist/index.html', 'utf8')
  .replace('<script type="module" crossorigin>', '<script>window.__app=function(){')
  .replace('</script>', '};document.addEventListener("DOMContentLoaded",window.__app);</script>')
  .replace(/import\.meta/g, '({url:"http://localhost/",env:{}})');
const roster = fs.readFileSync('public/mods/KHL_2627/roster.json', 'utf8');
const errors = [];
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
function boot(seed = {}) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.detail?.stack || e.message)));
  vc.on('error', (...args) => errors.push(args.join(' ')));
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'http://localhost/', beforeParse(w) {
    w.fetch = (u) => Promise.resolve({ ok: true, text: () => Promise.resolve(String(u).includes('mods/index.json') ? '{"mods":["KHL_2627"]}' : roster) });
    w.Element.prototype.scrollTo = function () {};
    w.scrollTo = function () {};
    for (const [k, v] of Object.entries(seed)) w.localStorage.setItem(k, v);
  } });
  const d = dom.window.document;
  return { dom, d,
    text: () => d.body.textContent,
    find: (name) => [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === name) || [...d.querySelectorAll('button')].find((b) => b.textContent.includes(name)),
    click: (el) => { assert.ok(el, 'button must exist'); assert.equal(el.disabled, false, el.textContent); el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); },
  };
}
(async () => {
  let app = boot(); await pause(900);
  app.click(app.find('СКА')); await pause(); app.click(app.find('Начать карьеру')); await pause(500);
  app.click(app.find('Управление командой →')); await pause();
  assert.ok(app.d.querySelector('[data-coaching-hub]'));
  assert.ok(app.text().includes('Андрей Разин'));
  app.click(app.find('Подготовка и раздевалка')); await pause();
  let focus = [...app.d.querySelectorAll('[aria-pressed]')].find((b) => b.textContent.startsWith('Оборона'));
  app.click(focus); await pause(); assert.equal(focus.getAttribute('aria-pressed'), 'true');
  console.log('ok navigation and team-focus control');
  app.click(app.find('Провести бесплатно')); await pause(); app.click(app.find('Провести')); await pause();
  assert.ok(app.text().includes('Следующее собрание через 14 дн.'));
  assert.ok([...app.d.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Провести бесплатно').every((b) => b.disabled));
  console.log('ok confirmation and shared meeting cooldown');
  app.click(app.find('Штаб и рынок')); await pause();
  const candidate = app.d.querySelector('[data-coach="free-coach-krikunov"]');
  app.click(candidate.parentElement.querySelector('button')); await pause(); app.click(app.find('Принять условия тренера')); await pause();
  assert.ok(app.d.querySelector('[data-coach-neg-result]').textContent.includes('Владимир Крикунов — главный тренер')); app.click(app.find('Готово')); await pause();
  assert.ok(app.text().includes('Следующая замена на этой должности через 30 дн.'));
  assert.ok(app.d.querySelector('[data-coaching-hub]').textContent.includes('40%'));
  console.log('ok appointment, adaptation penalty and hire cooldown');
  await pause(800);
  const seed = {}; const storage = app.dom.window.localStorage;
  for (let i = 0; i < storage.length; i++) seed[storage.key(i)] = storage.getItem(storage.key(i));
  app.dom.window.close(); app = boot(seed); await pause(900);
  app.click(app.find('Продолжить')); await pause(450); app.click(app.find('Управление командой →')); await pause();
  assert.ok(app.text().includes('Владимир Крикунов'));
  assert.ok(app.text().includes('Следующая замена на этой должности через 30 дн.'));
  app.click(app.find('Подготовка и раздевалка')); await pause();
  assert.ok(app.text().includes('Следующее собрание через 14 дн.'));
  assert.ok([...app.d.querySelectorAll('[aria-pressed="true"]')].some((b) => b.textContent.startsWith('Оборона')));
  console.log('ok persisted staff, focus and cooldowns after closing/reopening browser');
  app.dom.window.close(); assert.deepEqual(errors, []);
  console.log('PASS: coaching UI flow; no runtime errors');
})().catch((e) => { console.error(e); console.error(errors); process.exit(1); });
