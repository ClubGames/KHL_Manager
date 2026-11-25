// Save-slot test. Run twice: plain (localStorage fallback, 5M-char quota like a real browser) and IDB=1 (IndexedDB).
import { readFileSync, writeFileSync } from 'node:fs';
const USE_IDB = !!process.env.IDB;
const QUOTA = 5_000_000;
const mem = new Map<string, string>();
const used = () => [...mem.entries()].reduce((a, [k, v]) => a + k.length + v.length, 0);
const fakeLS = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => {
    const next = used() - (mem.get(k)?.length ?? 0) + String(v).length;
    if (next > QUOTA) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
    mem.set(k, String(v));
  },
  removeItem: (k: string) => void mem.delete(k),
};
// `window` must be the real global object so that fake-indexeddb/auto installs indexedDB where the game looks for it.
(globalThis as any).localStorage = fakeLS;
(globalThis as any).addEventListener = () => {};
(globalThis as any).window = globalThis;
(globalThis as any).document = { addEventListener() {}, visibilityState: 'visible' };

import { parseRosterText } from '../src/game/roster';
import * as G from '../src/game/state';

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};
const pointsOk = (s: any) => Object.values<any>(s.teams).every((t) => t.record.points === 2 * (t.record.w + t.record.otw + t.record.sow) + t.record.otl + t.record.sol);
const sim = (n: number) => { for (let i = 0; i < n; i++) G.simulateDay(true); };

(async () => {
  if (USE_IDB) await import('fake-indexeddb/auto');
  const roster = () => parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
  console.log('backend:', await G.getBackend());
  check('backend as expected', (await G.getBackend()) === (USE_IDB ? 'indexeddb' : 'localStorage'));

  // A save that an earlier session left in localStorage must always be listed (and moved to IndexedDB if present).
  const seeded = G.createGameState(roster(), 'loko');
  mem.set('khl-gm:save:' + seeded.saveId, JSON.stringify(G.snapshot(seeded)));
  mem.set('khl-gm:index', JSON.stringify([G.buildMeta(seeded)]));
  let list = await G.listSaves();
  check('save left in localStorage is listed', list.length === 1 && list[0].teamName === 'Локомотив');
  if (USE_IDB) check('…and moved out of localStorage into IndexedDB', ![...mem.keys()].some((k) => k.startsWith('khl-gm:')), [...mem.keys()].join(','));
  check('…and loads', (await G.loadCareer(seeded.saveId)) === null && G.store.get()?.userTeamId === 'loko');
  await G.exitToMenu();
  const n0 = 1;

  await G.startNewGame(roster(), 'ska');
  await G.saveNow();
  const idA = G.store.get()!.saveId;
  list = await G.listSaves();
  check('new career gets its own slot', list.length === n0 + 1 && list[0].id === idA && list[0].teamName === 'СКА' && list[0].day === 0);

  sim(10);
  await G.store.flush();
  list = await G.listSaves();
  const mA = list.find((m) => m.id === idA)!;
  check('autosave tracks progress', mA.day === 10, `day ${mA.day}`);
  const st = G.store.get()!;
  const anyRegWin = Object.values(st.teams).some((t) => t.record.w > 0);
  check('points: every win = 2, OT/SO loss = 1', pointsOk(st) && anyRegWin);
  const sample = Object.values(st.teams).find((t) => t.record.w > 0 && t.record.otl + t.record.sol > 0) ?? Object.values(st.teams)[0];
  console.log(`     e.g. ${sample.name}: В ${sample.record.w} ВОТ ${sample.record.otw} ВБ ${sample.record.sow} ПОТ ${sample.record.otl} ПБ ${sample.record.sol} П ${sample.record.l} → ${sample.record.points} очк.`);

  check('copy ok', (await G.copyCareer(idA)) === null);
  list = await G.listSaves();
  const mCopy = list.find((m) => m.name === 'СКА (копия)');
  check('copy is a separate slot', list.length === n0 + 2 && !!mCopy && mCopy!.id !== idA && mCopy!.day === 10);
  const idB = mCopy!.id;

  sim(10);
  await G.exitToMenu();
  check('exit to menu closes the career', G.store.get() === null);
  list = await G.listSaves();
  check('after exit: original at day 20, copy still at day 10', list.find((m) => m.id === idA)!.day === 20 && list.find((m) => m.id === idB)!.day === 10);

  check('load copy', (await G.loadCareer(idB)) === null);
  check('loaded copy state', G.store.get()!.day === 10 && G.store.get()!.saveId === idB && G.store.get()!.teams.ska.record.gp === list.find((m) => m.id === idB)!.gp);
  sim(3);
  await G.exitToMenu();
  list = await G.listSaves();
  check('careers are independent', list.find((m) => m.id === idA)!.day === 20 && list.find((m) => m.id === idB)!.day === 13);

  await G.startNewGame(roster(), 'cska');
  const idC = G.store.get()!.saveId;
  await G.exitToMenu();
  list = await G.listSaves();
  check('second career with another club', list.length === n0 + 3 && list.some((m) => m.id === idC && m.teamName === 'ЦСКА'));

  const before = list.find((m) => m.id === idA)!;
  check('rename closed save', (await G.renameCareer(before, 'Моя карьера')) === null);
  list = await G.listSaves();
  check('rename keeps timestamp and data', list.find((m) => m.id === idA)!.name === 'Моя карьера' && list.find((m) => m.id === idA)!.updatedAt === before.updatedAt);
  await G.loadCareer(idA);
  check('renamed career loads with new name', G.store.get()!.saveName === 'Моя карьера' && G.store.get()!.day === 20);
  check('cannot delete the open career', typeof (await G.deleteCareer(idA)) === 'string');
  const exported = JSON.stringify({ format: 'khl-gm-save', state: G.snapshot(G.store.get()!) });

  // legacy single-slot save from the first version (3 points for a regulation win)
  const legacy = JSON.parse(JSON.stringify(G.snapshot(G.store.get()!)));
  delete legacy.saveId; delete legacy.saveName; delete legacy.createdAt; legacy.version = 1;
  for (const t of Object.values<any>(legacy.teams)) t.record.points = 3 * t.record.w + 2 * (t.record.otw + t.record.sow) + t.record.otl + t.record.sol;
  const oldPts = legacy.teams.ska.record.points;
  writeFileSync('/tmp/legacy.json', JSON.stringify(legacy));
  await G.exitToMenu();

  check('delete copy', (await G.deleteCareer(idB)) === null);
  list = await G.listSaves();
  check('deleted slot is gone', list.length === n0 + 2 && !list.some((m) => m.id === idB));

  check('import from file', (await G.importCareer(exported)) === null);
  check('import rejects roster.json', typeof (await G.importCareer(readFileSync('scripts/fixtures/test-roster.json', 'utf8'))) === 'string');
  check('import rejects garbage', typeof (await G.importCareer('nope')) === 'string');
  list = await G.listSaves();
  check('imported save is a new slot', list.length === n0 + 3 && list.filter((m) => m.name === 'Моя карьера').length === 2);
  const idImp = list.find((m) => m.name === 'Моя карьера' && m.id !== idA)!.id;
  await G.deleteCareer(idImp);

  try { fakeLS.setItem('khl-gm-save-v1', JSON.stringify(legacy)); } catch { console.log('     (legacy seed did not fit into quota; shrinking)'); }
  if (mem.has('khl-gm-save-v1')) {
    list = await G.listSaves();
    const mL = list.find((m) => m.id === 'legacy-v1');
    check('old single save is adopted as a slot', !!mL && !mem.has('khl-gm-save-v1'));
    check('old save converted to 2-point wins', !!mL && mL.points < oldPts && mL.points === 2 * mL.wins + (legacy.teams.ska.record.otl + legacy.teams.ska.record.sol), `${oldPts} → ${mL?.points}`);
    check('old save loads', (await G.loadCareer('legacy-v1')) === null && G.store.get()!.day === 20 && pointsOk(G.store.get()!));
    await G.exitToMenu();
    await G.deleteCareer('legacy-v1');
  } else check('legacy seed', false, 'could not seed');

  // full season in one slot: must keep saving until the end
  await G.loadCareer(idA);
  let guard = 0;
  while (G.store.get()!.phase !== 'offseason' && guard++ < 400) G.simulateDay(true);
  const okSave = await G.saveNow();
  const size = JSON.stringify(G.snapshot(G.store.get()!)).length;
  check('season finished and still saving', G.store.get()!.phase === 'offseason' && okSave && G.store.getStatus().state === 'saved', `status ${G.store.getStatus().state} ${G.store.getStatus().error ?? ''}`);
  console.log(`     end-of-season save size: ${(size / 1e6).toFixed(2)}M chars (old format was 6.7M); localStorage in use: ${(used() / 1e6).toFixed(2)}M of ${QUOTA / 1e6}M`);
  check('points rule holds for final table', pointsOk(G.store.get()!));
  const top = G.rankAll(G.store.get()!)[0];
  console.log(`     leader: ${top.name} ${top.record.points} очк. за ${top.record.gp} игр (В ${top.record.w}, ВОТ ${top.record.otw}, ВБ ${top.record.sow}, ПОТ ${top.record.otl}, ПБ ${top.record.sol}, П ${top.record.l})`);
  G.startNewSeason();
  await G.exitToMenu();
  list = await G.listSaves();
  const fin = list.find((m) => m.id === idA)!;
  check('next season saved', fin.seasonNumber === 2 && fin.phase === 'season' && fin.day === 0 && fin.points === 0);
  await G.loadCareer(idA);
  check('reloaded next season', G.store.get()!.league.season === '2026/27' && G.store.get()!.summaries.length === 1);
  await G.exitToMenu();
  console.log(`saves at the end: ${list.map((m) => `${m.name} [${m.teamShort}, ${m.season}, день ${m.day + 1}]`).join(' | ')}`);
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('CRASH', e); process.exit(2); });
