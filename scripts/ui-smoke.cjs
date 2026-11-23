// UI test: runs the built dist/index.html in jsdom and clicks through the real interface.
// Covers: career start, live match, every section, save slots (copy / exit to menu / continue / delete /
// switch careers in-game) and re-opening the page. Run plain (localStorage) and with IDB=1 (IndexedDB).
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const USE_IDB = !!process.env.IDB;
if (USE_IDB) require('fake-indexeddb/auto');

const html = fs
  .readFileSync('dist/index.html', 'utf8')
  .replace('<script type="module" crossorigin>', '<script>window.__app=function(){')
  .replace('</script>', '};document.addEventListener("DOMContentLoaded",window.__app);</script>')
  .replace(/import\.meta/g, '({url:"http://localhost/",env:{}})');
const roster = fs.readFileSync('public/roster.json', 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let failed = 0;
const check = (name, ok, extra) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

function boot(seed, rosterText) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + String(e.detail?.stack || e.stack || e.message || e).slice(0, 600)));
  vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ').slice(0, 400)));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    url: 'http://localhost/',
    beforeParse(window) {
      window.fetch = (url) => (String(url).includes('roster.json') ? Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(rosterText || roster) }) : Promise.reject(new Error('no ' + url)));
      window.Element.prototype.scrollTo = window.Element.prototype.scrollTo || function () {};
      window.scrollTo = function () {}; // jsdom has no viewport scrolling implementation.
      if (USE_IDB) window.indexedDB = global.indexedDB;
      for (const [k, v] of Object.entries(seed || {})) window.localStorage.setItem(k, v);
    },
  });
  const { window } = dom;
  const { document } = window;
  const text = () => document.body.textContent || '';
  const buttons = (root) => [...(root || document).querySelectorAll('button')];
  const find = (label, root) => buttons(root).find((b) => (b.textContent || '').trim() === label) || buttons(root).find((b) => (b.textContent || '').includes(label));
  const last = (label) => buttons().filter((b) => (b.textContent || '').trim() === label).pop();
  const click = (el) => {
    if (!el) throw new Error('element to click not found');
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  const cards = () => [...document.querySelectorAll('[data-save-card]')];
  const card = (name) => cards().find((c) => c.querySelector('[data-save-name]')?.textContent === name);
  const day = () => (text().match(/День \d+ \/ \d+/) || [''])[0];
  const storage = () => {
    const out = {};
    for (let i = 0; i < window.localStorage.length; i++) out[window.localStorage.key(i)] = window.localStorage.getItem(window.localStorage.key(i));
    return out;
  };
  return { window, document, text, has: (s) => text().includes(s), find, last, click, cards, card, day, storage, close: () => window.close() };
}

(async () => {
  console.log(`storage mode: ${USE_IDB ? 'IndexedDB' : 'localStorage'}`);
  /* ---------- session 1 ---------- */
  let a = boot();
  await sleep(900);
  check('menu: saves block and new-career block are both shown', a.has('Продолжить карьеру') && a.has('Новая карьера') && a.has('Начать карьеру'));
  check('menu: empty state when there are no saves', a.has('Сохранённых карьер пока нет') && a.cards().length === 0);
  a.click(a.find('СКА'));
  await sleep(150);
  a.click(a.find('Начать карьеру'));
  await sleep(600);
  check('career started → dashboard', a.has('Лента новостей') && a.has('Следующий матч'));
  check('BOARD: the season objective is shown on the dashboard', !!a.document.querySelector('[data-board-goal]') && a.has('Задача руководства'), a.document.querySelector('[data-board-goal]')?.textContent);
  if (a.find('Симулировать до матча')) {
    a.click(a.find('Симулировать до матча'));
    await sleep(500);
  }
  a.click(a.find('Играть матч'));
  await sleep(300);
  a.click(a.find('Начать матч'));
  await sleep(250);
  const live = () => {
    const t = a.document.querySelector('[data-live-stats]');
    const [h, w] = t.getAttribute('data-shots').split(':').map(Number);
    const feed = a.document.querySelector('[data-feed]').textContent || '';
    return { shots: h + w, periods: t.getAttribute('data-periods'), feedShots: (feed.match(/Бросок |ГОЛ!/g) || []).length, clock: a.document.querySelector('[data-clock]').textContent };
  };
  const s0 = live();
  check('MATCH: initial stats contain only revealed events (an early goal is allowed)', s0.shots <= 3 && s0.periods.split(' ').length === 1 && s0.shots === s0.feedShots, JSON.stringify(s0));
  a.click(a.find('×4'));
  // Replays deliberately stop the game clock. Dismiss them like a spectator would.
  for (let elapsed = 0; elapsed < 2500; elapsed += 100) {
    const close = a.document.querySelector('[aria-label="Закрыть повтор"]');
    if (close) a.click(close);
    await sleep(100);
  }
  const s1 = live();
  check('MATCH: stats grow with the feed — shots on the panel = shots shown in the feed', s1.shots > s0.shots && s1.shots < 25 && s1.shots === s1.feedShots, JSON.stringify(s1));
  a.click(a.find('Пауза'));
  await sleep(150);
  const p1 = live();
  await sleep(700);
  const p2 = live();
  check('MATCH: pause freezes clock, feed and stats', p1.clock === p2.clock && p1.shots === p2.shots && p1.feedShots === p2.feedShots && a.has('Возобновить'), `${p1.clock} / ${p2.clock}`);
  a.click(a.find('Возобновить'));
  // A goal may have opened a replay before the pause; the clock correctly waits for its dismissal.
  const replayClose = a.document.querySelector('[aria-label="Закрыть повтор"]');
  if (replayClose) a.click(replayClose);
  await sleep(900);
  const p3 = live();
  check('MATCH: resume continues from the same moment', p3.clock !== p2.clock && p3.shots >= p2.shots && p3.shots === p3.feedShots, `${p2.clock} → ${p3.clock}`);
  a.click(a.find('Завершить мгновенно'));
  await sleep(300);
  const s9 = live();
  check('MATCH: final stats after instant finish are complete', s9.shots >= 35 && s9.shots === s9.feedShots && s9.periods.split(' ').length >= 3, JSON.stringify({ shots: s9.shots, periods: s9.periods }));
  a.click(a.find('Продолжить сезон'));
  await sleep(500);
  for (const v of ['Состав', 'Звенья', 'Календарь', 'Таблица', 'Статистика', 'Обмены', 'Рынок', 'Контракты', 'Формат JSON', 'Обзор']) {
    a.click(a.find(v));
    await sleep(150);
  }
  a.click(a.find('Таблица'));
  await sleep(150);
  check('standings explain the 2-point rule', a.has('любая победа') && a.has('— 2') && !a.has('в основное время — 3'));
  a.click(a.find('Статистика'));
  await sleep(200);
  const skRows = a.document.querySelectorAll('[data-leaders="skaters"] tbody tr').length;
  check('LEADERS: league scoring table and leader cards', skRows >= 20 && a.has('Лучший бомбардир') && a.has('Лучший вратарь'), `rows=${skRows}`);
  a.click(a.find('Вратари'));
  await sleep(200);
  const gRows = a.document.querySelectorAll('[data-leaders="goalies"] tbody tr').length;
  check('LEADERS: goalie table', gRows >= 10 && a.has('%ОБ'), `rows=${gRows}`);
  a.click(a.find('Обмены'));
  await sleep(200);
  check('TRADES: the trade window with the deadline is shown', (a.document.querySelector('[data-trade-window]')?.textContent || '').includes('До дедлайна обменов'), a.document.querySelector('[data-trade-window]')?.textContent);
  a.click(a.find('Контракты'));
  await sleep(200);
  const cRows = a.document.querySelectorAll('[data-contracts] tbody tr').length;
  check('CONTRACTS: the page lists every player and future commitments', cRows >= 20 && a.has('Обязательства по сезонам'), `rows=${cRows}`);
  a.click(a.find('Продлить'));
  await sleep(250);
  check('CONTRACTS: extension talks open with the player\'s asking price', a.has('Продление контракта') && a.has('Запрос игрока') && a.has('Терпение игрока'));
  a.click(a.find('Принять запрос игрока'));
  await sleep(300);
  const negText = a.document.querySelector('[data-neg-result]')?.textContent || '';
  check('CONTRACTS: the player signs the extension at his asking price', negText.includes('продлил контракт') && negText.includes('со следующего сезона'), negText);
  a.click(a.find('Готово'));
  await sleep(200);
  check('CONTRACTS: the extension appears in the table', (a.document.querySelector('[data-contracts]')?.textContent || '').includes('→'));
  a.click(a.find('Рынок'));
  await sleep(200);
  a.click(a.find('Переговоры'));
  await sleep(250);
  check('MARKET: talks with a free agent open', a.has('Переговоры со свободным агентом') && a.has('Сделать предложение'));
  a.click(a.find('Закрыть'));
  await sleep(150);
  a.click(a.find('Ещё'));
  await sleep(200);
  check('MOBILE: "Ещё" opens the list of all sections', a.has('Все разделы'));
  a.click(a.last('Рынок'));
  await sleep(200);
  check('MOBILE: a section opened from "Ещё"', a.has('Рынок свободных агентов') && !a.has('Все разделы'));
  a.click(a.find('Обзор'));
  await sleep(900);
  check('header shows that the career is saved', (a.document.querySelector('[data-save-status]')?.textContent || '').includes('Сохранено'), a.document.querySelector('[data-save-status]')?.textContent);
  const dayA = a.day();

  a.click(a.find('Сохранения'));
  await sleep(500);
  check('saves window lists the open career', a.cards().length === 1 && a.has('открыта сейчас'));
  a.click(a.find('Сделать копию'));
  await sleep(800);
  check('"Сделать копию" adds a second save', a.cards().length === 2 && !!a.card('СКА (копия)'));
  a.click(a.find('Сохранить и выйти в главное меню'));
  await sleep(800);
  check('MAIN MENU after exit: both saves are visible next to team selection', a.cards().length === 2 && a.has('сохранений: 2') && a.has('Начать карьеру'), `cards=${a.cards().length}`);
  a.click(a.find('Продолжить', a.card('СКА')));
  await sleep(700);
  check('"Продолжить" reopens the career at the same day', a.has('Лента новостей') && a.day() === dayA, `${dayA} → ${a.day()}`);

  a.click(a.find('В главное меню'));
  await sleep(700);
  a.click(a.find('ЦСКА'));
  await sleep(150);
  a.click(a.find('Начать карьеру'));
  await sleep(700);
  check('second career started with another club', a.has('Лента новостей') && a.has('генеральным менеджером ЦСКА'));
  a.click(a.find('В главное меню'));
  await sleep(800);
  check('menu lists three saves', a.cards().length === 3 && !!a.card('ЦСКА') && !!a.card('СКА') && !!a.card('СКА (копия)'), `cards=${a.cards().length}`);
  a.click(a.find('Удалить', a.card('СКА (копия)')));
  await sleep(200);
  check('delete asks for confirmation', a.has('Удалить сохранение?'));
  a.click(a.last('Удалить'));
  await sleep(700);
  check('deleted save disappears, others stay', a.cards().length === 2 && !a.card('СКА (копия)') && !!a.card('СКА') && !!a.card('ЦСКА'));

  a.click(a.find('Продолжить', a.card('ЦСКА')));
  await sleep(700);
  a.click(a.find('Сохранения'));
  await sleep(500);
  check('in-game saves window shows both careers', a.cards().length === 2);
  a.click(a.find('Продолжить', a.card('СКА')));
  await sleep(800);
  check('switching careers in-game works', a.has('Лента новостей') && a.day() === dayA && a.has('генеральным менеджером СКА') && a.cards().length === 0, a.day());
  a.click(a.find('Симулировать день') || a.find('Симулировать до матча'));
  await sleep(1000);
  const dayB = a.day();
  const seed = a.storage();
  a.close();

  /* ---------- session 2: the page is opened again ---------- */
  a = boot(seed);
  await sleep(1000);
  check('REOPENED PAGE: saves are listed on the menu', a.cards().length === 2 && !!a.card('СКА') && !!a.card('ЦСКА'), `cards=${a.cards().length}`);
  a.click(a.find('Продолжить', a.card('СКА')));
  await sleep(800);
  check('REOPENED PAGE: career continues where it stopped', a.has('Лента новостей') && a.day() === dayB && dayB !== dayA, `${dayA} → ${dayB} → ${a.day()}`);
  a.close();

  /* ---------- session 3: a browser that still holds the old single save ---------- */
  if (fs.existsSync('/tmp/legacy.json')) {
    a = boot({ 'khl-gm-save-v1': fs.readFileSync('/tmp/legacy.json', 'utf8') });
    await sleep(1200);
    const n = a.cards().length;
    const c = a.card('СКА');
    check('OLD SAVE from the previous version shows up in the list', !!c && n === (USE_IDB ? 3 : 1), `cards=${n}`);
    const legacyCard = a.cards().find((x) => x.getAttribute('data-save-card') === 'legacy-v1');
    a.click(a.find('Продолжить', legacyCard));
    await sleep(900);
    check('OLD SAVE opens (day 21 of the season)', a.has('Лента новостей') && a.day().startsWith('День 21 '), a.day());
    a.close();
  }

  /* ---------- session 4: a club from the Eastern conference ---------- */
  a = boot();
  await sleep(1000);
  a.click(a.find('Ак Барс'));
  await sleep(150);
  a.click(a.find('Начать карьеру'));
  await sleep(700);
  const mini = [...a.document.querySelectorAll('section')].find((x) => (x.querySelector('h3')?.textContent || '').includes('топ-8'));
  const miniText = mini ? mini.textContent : '';
  check('EAST CLUB: dashboard table is titled «Восток»', a.has('генеральным менеджером Ак Барс') && miniText.includes('Восток · топ-8') && !a.has('Запад · топ-8'), (mini?.querySelector('h3')?.textContent || 'no panel'));
  check('EAST CLUB: the table lists Eastern teams only', ['АКБ', 'ММГ', 'АВА', 'САЛ'].every((x) => miniText.includes(x)) && !['СКА', 'ЛОК', 'СПА'].some((x) => miniText.includes(x)), miniText.slice(0, 120));
  a.close();

  /* ---------- session 5: a roster file without contracts ---------- */
  const bare = JSON.parse(roster);
  let stripped = 0;
  for (const t of bare.teams) for (const pl of t.players) { delete pl.contract; stripped++; }
  a = boot(null, JSON.stringify(bare));
  await sleep(1100);
  const notice = a.document.querySelector('[data-contracts-notice]')?.textContent || '';
  check('NO CONTRACTS IN ROSTER: the menu says contracts were assigned and offers to save the file', notice.includes(`у ${stripped} игроков`) && !!a.find('Сохранить roster.json с контрактами'), notice.slice(0, 70));
  a.click(a.find('Спартак'));
  await sleep(150);
  a.click(a.find('Начать карьеру'));
  await sleep(700);
  a.click(a.find('Контракты'));
  await sleep(250);
  const ct = a.document.querySelector('[data-contracts]')?.textContent || '';
  check('NO CONTRACTS IN ROSTER: players have salaries and varied terms', ct.includes('последний год') && (ct.includes('ещё 2') || ct.includes('ещё 3')) && ct.includes('млн'), ct.slice(0, 90));
  a.close();

  console.log(`runtime errors: ${errors.length}`);
  if (errors.length) console.log(errors.slice(0, 8).join('\n'));
  console.log(failed || errors.length ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed || errors.length ? 1 : 0);
})().catch((e) => {
  console.log('TEST CRASH: ' + e.stack);
  if (errors.length) console.log(errors.slice(0, 8).join('\n'));
  process.exit(2);
});
