// Performance probe for the built game: bundle size and how much DOM work the live match screen does.
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const raw = fs.readFileSync('dist/index.html', 'utf8');
const html = raw.replace('<script type="module" crossorigin>', '<script>window.__app=function(){').replace('</script>', '};document.addEventListener("DOMContentLoaded",window.__app);</script>').replace(/import\.meta/g, '({url:"http://localhost/",env:{}})');
const roster = fs.readFileSync('scripts/fixtures/test-roster.json', 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const kb = (n) => (n / 1024).toFixed(0) + ' KB';
  const fonts = (raw.match(/data:font\/[^)"']+/g) || []).reduce((a, x) => a + x.length, 0);
  const imgs = (raw.match(/data:image\/(jpeg|png)[^)"']+/g) || []).reduce((a, x) => a + x.length, 0);
  console.log(`bundle: index.html ${kb(raw.length)} (inlined fonts ${kb(fonts)}, inlined images ${kb(imgs)}, code+css ${kb(raw.length - fonts - imgs)})`);
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: new VirtualConsole(), url: 'http://localhost/', beforeParse(w) { w.fetch = (u) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(roster) }); w.Element.prototype.scrollTo = function () {}; } });
  const { window } = dom; const { document } = window;
  const find = (l) => [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === l) || [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes(l));
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(900); click(find('СКА')); await sleep(100); click(find('Начать карьеру')); await sleep(500);
  if (find('Симулировать до матча')) { click(find('Симулировать до матча')); await sleep(400); }
  click(find('Играть матч')); await sleep(200); click(document.querySelector('[data-match-mode="watch"]')); await sleep(200); click(find('Начать матч')); await sleep(100); click(find('×4'));
  let records = 0, added = 0, removed = 0;
  const mo = new window.MutationObserver((list) => { for (const m of list) { records++; added += m.addedNodes.length; removed += m.removedNodes.length; } });
  mo.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  const t0 = Date.now(); const cpu0 = process.cpuUsage(); await sleep(10000); const cpu = process.cpuUsage(cpu0); mo.disconnect();
  const ev = document.querySelectorAll('[data-feed] > div').length;
  console.log(`live match, ${((Date.now() - t0) / 1000).toFixed(1)} s at x4: ${ev} feed rows on screen; DOM mutations ${records}, nodes created ${added}, nodes removed ${removed}; CPU ${((cpu.user + cpu.system) / 1000).toFixed(0)} ms`);
  process.exit(0);
})();
