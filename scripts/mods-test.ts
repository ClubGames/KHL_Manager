// Run with: npx tsx scripts/mods-test.ts
// Mods: mods/index.json → mods/<id>/{mod.json, roster.json, schedule.json, logos/}; old saves keep working.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { buildSchedule, parseScheduleFile, scheduleDateToDay, scheduleDayToDate, scheduleFileText, scheduleToFile } from '../src/game/schedule';
import { careerMod, DEFAULT_MOD_ID, listMods, loadMod, modUrl, parseModIndex } from '../src/game/mods';
import { buildMeta, createGameState, store } from '../src/game/state';
import { getClubLogoSources } from '../src/game/clubColors';
import { DEFAULT_LEAGUE_NAME, GAME_NAME, leagueName, LG } from '../src/brand';
import type { GameState } from '../src/types';

let passed = 0;
const ok = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve(fn()).then(() => {
    passed++;
    console.log('PASS', name);
  });

// fetch from public/ (what the static server does), 404 for anything missing
const served: string[] = [];
(globalThis as any).fetch = async (url: string) => {
  const rel = String(url).replace(/^\.\//, '').split('?')[0];
  served.push(rel);
  const file = `public/${decodeURIComponent(rel)}`;
  if (!existsSync(file)) return { ok: false, status: 404, text: async () => 'Not found' };
  return { ok: true, status: 200, text: async () => readFileSync(file, 'utf8') };
};
const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };

const dir = `public/mods/${DEFAULT_MOD_ID}`;
const rosterText = readFileSync(`${dir}/roster.json`, 'utf8');
const scheduleJson = JSON.parse(readFileSync(`${dir}/schedule.json`, 'utf8'));

async function main() {
  await ok('the bundled mod is complete: index, mod.json, roster, schedule, 22 logos', () => {
    assert.deepEqual(parseModIndex(JSON.parse(readFileSync('public/mods/index.json', 'utf8'))), [DEFAULT_MOD_ID]);
    const m = JSON.parse(readFileSync(`${dir}/mod.json`, 'utf8'));
    assert.equal(m.roster, 'roster.json');
    assert.equal(m.schedule, 'schedule.json');
    const r = JSON.parse(rosterText);
    for (const t of r.teams) assert.ok(existsSync(`${dir}/${t.logo}`), `${t.id}: ${t.logo}`);
    assert.equal(r.teams.length, 22);
    assert.ok(!existsSync('roster.json') && !existsSync('public/roster.json') && !existsSync('public/logos'), 'nothing left at the old places');
  });

  await ok('schedule.json is exactly the calendar the game generated before (days, ids, home/away)', () => {
    const r = parseRosterText(rosterText);
    const gen = buildSchedule(r.teams, r.gamesPerTeam, 1, r.season);
    const file = parseScheduleFile(scheduleJson, r.teams.map((t) => t.id), r.season, 1);
    assert.deepEqual(file.days, gen.days);
    assert.equal(file.nextId, gen.nextId);
    assert.equal(file.gamesPerTeam, 68);
    assert.deepEqual(file.warnings, []);
    assert.equal(scheduleFileText(scheduleToFile(gen.days, r.season)), readFileSync(`${dir}/schedule.json`, 'utf8'), 'file is up to date with the generator');
  });

  await ok('dates: day 0 = 1 September, round trip, leap years, bad dates', () => {
    assert.equal(scheduleDayToDate(0, '2026/27'), '2026-09-01');
    assert.equal(scheduleDayToDate(4, '2026/27'), '2026-09-05');
    assert.equal(scheduleDateToDay('2027-03-20', '2026/27'), 200);
    for (let d = 0; d < 300; d += 7) assert.equal(scheduleDateToDay(scheduleDayToDate(d, '2027/28'), '2027/28'), d);
    assert.equal(scheduleDateToDay('2028-02-29', '2027/28') - scheduleDateToDay('2028-02-28', '2027/28'), 1);
    assert.ok(Number.isNaN(scheduleDateToDay('2026-02-30', '2026/27')));
    assert.ok(Number.isNaN(scheduleDateToDay('5 сентября', '2026/27')));
  });

  await ok('broken calendars are refused with a reason', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const g = (date: string, home: string, away: string) => ({ date, home, away });
    assert.throws(() => parseScheduleFile({ games: [] }, ids, '2026/27'), /нет матчей/);
    assert.throws(() => parseScheduleFile({ games: [g('2026-09-05', 'a', 'x')] }, ids, '2026/27'), /неизвестный клуб «x»/);
    assert.throws(() => parseScheduleFile({ games: [g('2026-09-05', 'a', 'a')] }, ids, '2026/27'), /сам с собой/);
    assert.throws(() => parseScheduleFile({ games: [g('2026-09-05', 'a', 'b'), g('2026-09-05', 'c', 'a')] }, ids, '2026/27'), /«a» уже играет/);
    assert.throws(() => parseScheduleFile({ games: [g('2026-08-31', 'a', 'b')] }, ids, '2026/27'), /раньше начала/);
    assert.throws(() => parseScheduleFile({ season: '2025/26', games: [g('2026-09-05', 'a', 'b')] }, ids, '2026/27'), /на сезон 2025\/26/);
    const p = parseScheduleFile({ days: 10, games: [g('2026-09-02', 'a', 'b'), g('2026-09-02', 'c', 'd'), g('2026-09-04', 'b', 'a')] }, ids, '2026/27', 5);
    assert.equal(p.days.length, 10);
    assert.deepEqual(p.days[1].map((x) => [x.id, x.home, x.away]), [[5, 'a', 'b'], [6, 'c', 'd']]);
    assert.equal(p.nextId, 8);
    assert.equal(p.gamesPerTeam, null);
    assert.match(p.warnings.join(' '), /разное число матчей/);
  });

  await ok('mod list and loading: roster + schedule + logos inside the mod folder', async () => {
    const mods = await listMods();
    assert.equal(mods.length, 1, 'no legacy roster.json next to index.html');
    const m = mods[0];
    assert.equal(m.id, DEFAULT_MOD_ID);
    assert.equal(m.name, 'КХЛ 2026/27');
    const r = await loadMod(m);
    assert.equal(r.leagueName, 'КХЛ', 'league name comes from the roster');
    assert.ok(r.schedule, 'schedule from the mod');
    assert.deepEqual(r.mod, { id: DEFAULT_MOD_ID, name: 'КХЛ 2026/27', base: './mods/KHL_2627', roster: './mods/KHL_2627/roster.json' });
    const ska = r.teams.find((t) => t.id === 'ska')!;
    assert.equal(ska.logo, './mods/KHL_2627/logos/ska.png');
    assert.deepEqual(getClubLogoSources(ska)[0], './mods/KHL_2627/logos/ska.png');
    assert.equal(getClubLogoSources(ska).length, 2, 'mod logo, then the CDN copy (no duplicate)');
    assert.ok(served.includes('mods/KHL_2627/schedule.json'));
  });

  await ok('a new career plays the mod calendar and remembers its mod', async () => {
    const [m] = await listMods();
    const r = await loadMod(m);
    const s = createGameState(r, 'ska');
    const plain = parseRosterText(rosterText);
    const before = createGameState(plain, 'ska'); // how careers were created before mods (generator)
    assert.deepEqual(s.schedule, before.schedule, 'same first season as before');
    assert.equal(s.nextGameId, before.nextGameId);
    assert.deepEqual(s.mod, r.mod);
    s.schedule[1].length && (s.schedule.find((d) => d.length)![0].played = true);
    assert.ok(!r.schedule!.days.some((d) => d.some((g) => g.played)), 'career gets its own copy of the calendar');
    assert.equal(buildMeta(s).mod, 'КХЛ 2026/27');
    const fromFile = createGameState(plain, 'ska');
    assert.equal(fromFile.mod?.roster, null, 'hand-picked file: nothing to follow');
  });

  await ok('a calendar that does not fit falls back to the generator with a warning', async () => {
    const real = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string) =>
      String(url).endsWith('schedule.json') ? { ok: true, status: 200, text: async () => JSON.stringify({ games: [{ date: '2026-09-05', home: 'ska', away: 'nobody' }] }) } : real(url);
    try {
      const [m] = await listMods();
      const r = await loadMod(m);
      assert.equal(r.schedule, undefined);
      assert.match(r.warnings.join(' '), /не подошёл.*неизвестный клуб «nobody»/);
    } finally {
      (globalThis as any).fetch = real;
    }
  });

  await ok('old saves: no mod field, follow mods/KHL_2627, meta unchanged', () => {
    const s = createGameState(parseRosterText(rosterText), 'ska') as GameState;
    delete s.mod;
    assert.deepEqual(careerMod(s), { id: DEFAULT_MOD_ID, name: 'КХЛ 2026/27', base: './mods/KHL_2627', roster: './mods/KHL_2627/roster.json' });
    assert.equal('mod' in buildMeta(s), false);
    assert.equal(s.mod, undefined, 'careerMod does not write into the save');
  });

  await ok('league name: roster league.name, otherwise «ХЛ»; game name', () => {
    const noName = parseRosterText(JSON.stringify({ teams: [{ id: 'a', name: 'А', players: [{ name: 'X' }] }, { id: 'b', name: 'Б', players: [{ name: 'Y' }] }] }));
    assert.equal(noName.leagueName, DEFAULT_LEAGUE_NAME);
    assert.equal(DEFAULT_LEAGUE_NAME, 'ХЛ');
    assert.equal(leagueName({ league: { name: '  ' } }), 'ХЛ');
    assert.equal(leagueName({ league: { name: 'НХЛ' } }), 'НХЛ');
    assert.equal(GAME_NAME, 'Хоккейный Симулятор Менеджера – Hockey Simulator Manager');
    const s = createGameState(noName, 'a');
    store.set(s);
    assert.equal(LG(), 'ХЛ');
    store.set({ ...s, league: { ...s.league, name: 'Суперлига' } });
    assert.equal(LG(), 'Суперлига');
    store.set(null);
    assert.equal(LG(), 'ХЛ');
  });

  await ok('paths and index parsing', () => {
    assert.equal(modUrl('./mods/X', 'logos/a.png'), './mods/X/logos/a.png');
    assert.equal(modUrl('./mods/X', './logos/a.png'), './mods/X/logos/a.png');
    assert.equal(modUrl('./mods/X', 'https://e.com/a.png'), 'https://e.com/a.png');
    assert.equal(modUrl('./mods/X', '/abs/a.png'), '/abs/a.png');
    assert.equal(modUrl('.', 'roster.json'), './roster.json');
    assert.deepEqual(parseModIndex(['A', { id: 'B' }, '../evil', 'A', 'x/y', '']), ['A', 'B']);
    assert.deepEqual(parseModIndex({ nope: 1 }), []);
  });

  await ok('no «КХЛ» left in the interface texts', () => {
    const files = ['src/components/Startup.tsx', 'src/App.tsx', 'index.html', 'public/manifest.webmanifest'];
    for (const f of files) assert.ok(!readFileSync(f, 'utf8').includes('КХЛ'), f);
  });

  console.log(`\n${passed} mod checks passed`);
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
