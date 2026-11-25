// Генератор ПРИМЕРА roster.json. Игроки здесь — плейсхолдеры («Игрок N»), чтобы игра запускалась
// сразу после сборки. Замените их настоящими хоккеистами, сохранив структуру полей.
// Запуск: node scripts/generate-roster.mjs [путь=roster.example.json] (например public/mods/MyLeague/roster.json)
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let seed = 20251001;
function rnd() {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const R = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const N = (mu, sd) => Math.round(mu + (rnd() + rnd() + rnd() - 1.5) * 1.6 * sd);
const c = (v, lo = 40, hi = 99) => Math.max(lo, Math.min(hi, v));

const TEAMS = [
  ['СКА', 'Санкт-Петербург', 'Запад', 'Боброва', '#00468B', '#FFFFFF', 83, 'СКА'],
  ['ЦСКА', 'Москва', 'Запад', 'Боброва', '#CE1126', '#FFFFFF', 83, 'ЦСКА'],
  ['Локомотив', 'Ярославль', 'Запад', 'Боброва', '#B5121B', '#FFFFFF', 82, 'ЛОК'],
  ['Динамо Москва', 'Москва', 'Запад', 'Тарасова', '#004B9B', '#FFFFFF', 81, 'ДМ'],
  ['Спартак', 'Москва', 'Запад', 'Тарасова', '#D50032', '#FFFFFF', 80, 'СПА'],
  ['Северсталь', 'Череповец', 'Запад', 'Тарасова', '#FFD100', '#141414', 77, 'СЕВ'],
  ['Витязь', 'Подольск', 'Запад', 'Боброва', '#D50032', '#FFFFFF', 76, 'ВИТ'],
  ['Торпедо', 'Нижний Новгород', 'Запад', 'Тарасова', '#003882', '#FFFFFF', 77, 'ТОР'],
  ['ХК Сочи', 'Сочи', 'Запад', 'Боброва', '#092C5C', '#FFD100', 74, 'СОЧ'],
  ['Динамо Минск', 'Минск', 'Запад', 'Тарасова', '#141B24', '#00B5E2', 77, 'ДМН'],
  ['Динамо Рига', 'Рига', 'Запад', 'Боброва', '#7A1C24', '#FFFFFF', 73, 'ДРИ'],
  ['ХК Москва', 'Москва', 'Запад', 'Тарасова', '#B5121B', '#1B2A4A', 75, 'МСК'],
  ['Минские Зубры', 'Минск', 'Запад', 'Боброва', '#5B3A1E', '#C9A227', 73, 'МЗБ'],
  ['Металлург Магнитогорск', 'Магнитогорск', 'Восток', 'Харламова', '#003087', '#FFFFFF', 83, 'ММГ'],
  ['Ак Барс', 'Казань', 'Восток', 'Харламова', '#00693E', '#FFFFFF', 82, 'АКБ'],
  ['Авангард', 'Омск', 'Восток', 'Чернышёва', '#C41E24', '#FFE066', 81, 'АВА'],
  ['Салават Юлаев', 'Уфа', 'Восток', 'Чернышёва', '#00873E', '#FFFFFF', 80, 'САЛ'],
  ['Автомобилист', 'Екатеринбург', 'Восток', 'Харламова', '#CE1126', '#FFFFFF', 78, 'АВТ'],
  ['Сибирь', 'Новосибирск', 'Восток', 'Чернышёва', '#0B2D5C', '#FFFFFF', 76, 'СИБ'],
  ['Барыс', 'Астана', 'Восток', 'Чернышёва', '#0055A4', '#FFD100', 76, 'БАР'],
  ['Нефтехимик', 'Нижнекамск', 'Восток', 'Харламова', '#0A2240', '#FFFFFF', 75, 'НЕФ'],
  ['Адмирал', 'Владивосток', 'Восток', 'Харламова', '#0C2340', '#E0B85C', 75, 'АДМ'],
  ['Лада', 'Тольятти', 'Восток', 'Харламова', '#003366', '#FFFFFF', 74, 'ЛАД'],
  ['Амур', 'Хабаровск', 'Восток', 'Чернышёва', '#F37021', '#14181F', 73, 'АМУ'],
  ['Куньлунь Ред Стар', 'Пекин', 'Восток', 'Чернышёва', '#C8102E', '#FFD100', 72, 'КРС'],
];

const fair = (o) => Math.round(Math.pow(Math.max(1, o - 50), 2) * 0.045);

function skater(pos, ovr, age) {
  const t = pos === 'D' ? { shooting: -8, defense: 8, checking: 7, passing: 0 } : pos === 'C' ? { shooting: -1, defense: 3, checking: 1, passing: 4 } : { shooting: 5, defense: -5, checking: -2, passing: -1 };
  return {
    skating: c(N(ovr + (pos === 'D' ? -1 : 1), 4)),
    shooting: c(N(ovr + t.shooting, 4)),
    passing: c(N(ovr + t.passing, 4)),
    puckControl: c(N(ovr + (pos === 'D' ? -5 : 1), 4)),
    checking: c(N(ovr + t.checking, 5)),
    defense: c(N(ovr + t.defense, 4)),
  };
}
function goalie(ovr) {
  return { reflexes: c(N(ovr, 3)), positioning: c(N(ovr, 3)), reboundControl: c(N(ovr, 3)), puckHandling: c(N(ovr - 8, 4)), endurance: c(N(ovr, 3)) };
}

let num = 1;
function player(teamSlug, teamShort, pos, ovr, age, n) {
  const potential = age <= 25 ? Math.min(99, Math.max(ovr, ovr + Math.round((26 - age) * 1.5 * rnd()))) : ovr;
  const years = R(1, 3);
  const salary = Math.round(fair(ovr) * (0.85 + rnd() * 0.3)) * 1_000_000;
  const s = pos === 'G' ? goalie(ovr) : skater(pos, ovr, age);
  const o = { id: `${teamSlug}-${pos.toLowerCase()}${String(n).padStart(2, '0')}`, name: `Игрок ${String(num++).padStart(3, '0')}`, position: pos === 'C' ? 'Ц' : pos === 'LW' ? 'ЛК' : pos === 'RW' ? 'ПК' : pos === 'D' ? 'З' : 'В', age, height: pos === 'G' ? R(184, 196) : pos === 'D' ? R(183, 196) : R(176, 192), weight: pos === 'G' ? R(82, 96) : R(78, 102), number: R(2, 98), country: 'Россия', overall: ovr, potential, skills: s, contract: { salary, years }, morale: R(60, 90) };
  return o;
}

const out = { league: { name: 'ХЛ', season: '2025/26', gamesPerTeam: 68, salaryCap: 900000000 }, teams: [], freeAgents: [] };

for (const [name, city, conf, div, pc, sc, base, short] of TEAMS) {
  const SLUGS = ['ska', 'cska', 'loko', 'dynamo-m', 'spartak', 'severstal', 'vityaz', 'torpedo', 'sochi', 'dynamo-minsk', 'dynamo-riga', 'moscow', 'zubry', 'metallurg', 'ak-bars', 'avangard', 'salavat', 'avtomobilist', 'sibir', 'barys', 'neftekhimik', 'admiral', 'lada', 'amur', 'kunlun'];
  const slug = SLUGS[out.teams.length] || `t${out.teams.length + 1}`;
  const ps = [];
  let n = 1;
  const ages = (lo, hi) => R(lo, hi);
  // 4 centers
  for (let i = 0; i < 4; i++) ps.push(player(slug, short, 'C', c(i < 2 ? N(base + 1, 3) : N(base - 6, 3)), ages(21, 35), n++));
  for (let i = 0; i < 5; i++) ps.push(player(slug, short, 'LW', c(i < 2 ? N(base, 3) : N(base - 7, 3)), ages(20, 36), n++));
  for (let i = 0; i < 4; i++) ps.push(player(slug, short, 'RW', c(i < 2 ? N(base, 3) : N(base - 7, 3)), ages(20, 36), n++));
  for (let i = 0; i < 7; i++) ps.push(player(slug, short, 'D', c(i < 4 ? N(base - 1, 3) : N(base - 8, 3)), ages(21, 36), n++));
  ps.push(player(slug, short, 'G', c(N(base, 2)), ages(22, 34), n++));
  ps.push(player(slug, short, 'G', c(N(base - 7, 3)), ages(20, 33), n++));
  if (rnd() < 0.35) ps.push(player(slug, short, 'G', c(N(base - 12, 3)), ages(19, 24), n++));
  out.teams.push({ id: slug, name, city, conference: conf, division: div, primaryColor: pc, secondaryColor: sc, budget: 1500000000 + R(-300, 400) * 1000000, players: ps });
}
for (let i = 0; i < 16; i++) {
  const pos = ['Ц', 'ЛК', 'ПК', 'З', 'В'][i % 5];
  const ovr = R(62, 76);
  const p = player('fa', 'СА', pos === 'Ц' ? 'C' : pos === 'ЛК' ? 'LW' : pos === 'ПК' ? 'RW' : pos === 'З' ? 'D' : 'G', ovr, R(19, 36), i + 1);
  delete p.contract;
  out.freeAgents.push(p);
}

// Pretty formatter: compact players (one line for skills)
const q = (v) => JSON.stringify(v);
function fmtPlayer(p) {
  const { skills, contract, ...rest } = p;
  return [
    '        {',
    '          ' + Object.entries(rest).map(([k, v]) => `${q(k)}: ${q(v)}`).join(', ') + ',',
    '          "skills": ' + JSON.stringify(skills) + (contract ? ',' : ''),
    ...(contract ? [`          "contract": ${JSON.stringify(contract)}`] : []),
    '        }',
  ].join('\n');
}
function fmtTeam(t) {
  const { players, ...rest } = t;
  return [
    '    {',
    '      ' + Object.entries(rest).map(([k, v]) => `${q(k)}: ${q(v)}`).join(', ') + ',',
    '      "players": [',
    players.map(fmtPlayer).join(',\n'),
    '      ]',
    '    }',
  ].join('\n');
}
const text = [
  '{',
  `  "league": ${JSON.stringify(out.league)},`,
  '  "teams": [',
  out.teams.map(fmtTeam).join(',\n'),
  '  ],',
  '  "freeAgents": [',
  out.freeAgents.map(fmtPlayer).join(',\n'),
  '  ]',
  '}',
  '',
].join('\n');

const outFile = process.argv[2] || 'roster.example.json';
mkdirSync(dirname(outFile) || '.', { recursive: true });
writeFileSync(outFile, text, 'utf8');
// sanity: parse back
const parsed = JSON.parse(text);
const total = parsed.teams.reduce((s, t) => s + t.players.length, 0);
console.log(`OK: ${parsed.teams.length} команд, ${total} игроков, ${parsed.freeAgents.length} свободных агентов, ${(text.length / 1024).toFixed(0)} KB`);
