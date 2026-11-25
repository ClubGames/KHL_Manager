// Player statistics by season and club: splits on a mid-season trade, the history written at the end of the season,
// and the rebuild for older saves (no splits, box scores dropped by the save).  npx tsx scripts/career-test.ts
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import * as G from '../src/game/state';
import { executeTrade } from '../src/game/ai';
import { compactState } from '../src/game/saves';
import { careerClubs, careerRows, STAT_KEYS, sumRows } from '../src/game/careerStats';
import type { GameState, Player } from '../src/types';

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const st = () => G.store.get()!;
G.store.set(G.createGameState(parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8')), 'ska'));

const splitsAddUp = (s: GameState) => Object.values(s.players).every((p) => {
  const sp = p.seasonSplits ?? [];
  return STAT_KEYS.every((k) => sp.reduce((a, x) => a + x[k], 0) === (sp.length ? p.stats[k] : 0) || (!sp.length && !p.stats.gp));
});

G.simulateDays(20, false);
// A top scorer and a goalie of two AI clubs swap clubs mid-season.
const pickTop = (teamId: string, g: boolean) => st().teams[teamId].players.map((id) => st().players[id]).filter((p) => (p.position === 'G') === g && p.stats.gp > 5).sort((a, b) => b.stats.goals + b.stats.assists - (a.stats.goals + a.stats.assists) || b.stats.gp - a.stats.gp)[0];
const [ta, tb] = st().teamOrder.filter((id) => id !== 'ska');
const fwd = pickTop(ta, false), gk = pickTop(tb, true);
const before = { fwd: { ...fwd.stats }, gk: { ...gk.stats } };
G.store.update((s) => executeTrade(s, ta, tb, [fwd.id], [gk.id]));
G.simulateDays(20, false);
const f1 = st().players[fwd.id], g1 = st().players[gk.id];
check('a traded skater has one split per club, in the order he played for them', f1.seasonSplits?.length === 2 && f1.seasonSplits[0].teamId === ta && f1.seasonSplits[1].teamId === tb, JSON.stringify(f1.seasonSplits?.map((x) => [x.teamId, x.gp, x.goals, x.assists])));
check('the first split keeps exactly what he scored before the trade', f1.seasonSplits![0].gp === before.fwd.gp && f1.seasonSplits![0].goals === before.fwd.goals && f1.seasonSplits![0].assists === before.fwd.assists);
check('a traded goalie gets his own split with wins and saves at the new club', g1.seasonSplits?.length === 2 && g1.seasonSplits[1].teamId === ta && g1.seasonSplits[1].saves > 0 && g1.seasonSplits[0].saves === before.gk.saves, JSON.stringify(g1.seasonSplits?.map((x) => [x.teamId, x.gp, x.wins, x.saves])));
check('splits add up to the season totals for every player', splitsAddUp(st()));
const rows = careerRows(st(), f1);
check('the career table shows the season in progress at both clubs', rows.filter((r) => r.current).length === 2 && sumRows(rows).goals === f1.stats.goals);
check('the list of clubs shows both clubs', careerClubs(st(), f1).map((c) => c.teamId).join() === `${ta},${tb}`);

/* ---------- older saves ---------- */
const truth = structuredClone(st().players);
const old = JSON.parse(JSON.stringify(compactState(st()))) as GameState;
delete old.splitsSeason;
for (const p of Object.values(old.players)) delete p.seasonSplits;
const migrated = G.migrateState(old)!;
const skaters = Object.values(truth).filter((p) => p.position !== 'G' && p.stats.gp > 0);
const exact = skaters.filter((p) => {
  const m = migrated.players[p.id];
  return JSON.stringify((m.seasonSplits ?? []).map((x) => [x.teamId, x.kind, x.gp, x.goals, x.assists])) === JSON.stringify((p.seasonSplits ?? []).map((x) => [x.teamId, x.kind, x.gp, x.goals, x.assists]));
});
check('old save: skater splits rebuilt from the schedule (club, games, goals, assists exact)', exact.length === skaters.length, `${exact.length}/${skaters.length}`);
const mg = migrated.players[gk.id];
check('old save: the traded goalie is split between both clubs with exact games and wins', JSON.stringify(mg.seasonSplits?.map((x) => [x.teamId, x.gp, x.wins])) === JSON.stringify(truth[gk.id].seasonSplits?.map((x) => [x.teamId, x.gp, x.wins])), JSON.stringify(mg.seasonSplits?.map((x) => [x.teamId, x.gp, x.wins, x.saves])));
check('old save: rebuilt splits still add up to the season totals', splitsAddUp(migrated));
check('old save: migration runs once (splitsSeason set)', migrated.splitsSeason === migrated.league.season);

/* ---------- end of the season: history rows per club and stage ---------- */
let guard = 0;
while (st().phase !== 'offseason' && guard++ < 400) G.simulateToNextUserGame(false), G.simulateDay(true);
check('the season reached the offseason', st().phase === 'offseason', st().phase);
const season = st().league.season;
const hist = (p: Player) => p.history.filter((h) => h.season === season);
const fh = hist(st().players[fwd.id]);
check('history: one row per club for the traded skater, with the full set of counters', fh.filter((h) => h.kind === 'regular').map((h) => h.teamId).join() === `${ta},${tb}` && fh.every((h) => h.pim !== undefined && h.shots !== undefined && h.plusMinus !== undefined), JSON.stringify(fh.map((h) => [h.teamId, h.kind, h.gp, h.goals])));
const po = Object.values(st().players).find((p) => hist(p).some((h) => h.kind === 'playoff' && h.gp > 0));
check('history: playoff games are kept as separate rows', !!po && hist(po).some((h) => h.kind === 'regular'), po ? JSON.stringify(hist(po).map((h) => [h.teamId, h.kind, h.gp])) : 'none');
const totalsOk = Object.values(st().players).every((p) => { const h = hist(p); return !h.length || (sumRows(h).gp === p.stats.gp && sumRows(h).goals === p.stats.goals); });
check('history rows of the season add up to the season totals', totalsOk);
check('careerRows does not duplicate the recorded season', careerRows(st(), st().players[fwd.id]).filter((r) => r.season === season).length === fh.length);

/* ---------- an old save in the offseason: whole-season row upgraded to per-club rows ---------- */
const old2 = JSON.parse(JSON.stringify(compactState(st()))) as GameState;
delete old2.splitsSeason;
for (const p of Object.values(old2.players)) {
  delete p.seasonSplits;
  const h = p.history.filter((x) => x.season === season);
  if (!h.length) continue;
  const t = sumRows(h);
  p.history = [...p.history.filter((x) => x.season !== season), { season, teamId: p.teamId ?? h[h.length - 1].teamId, overall: h[0].overall, gp: t.gp, goals: t.goals, assists: t.assists, wins: t.wins, shutouts: t.shutouts }];
}
const m2 = G.migrateState(old2)!;
const fh2 = m2.players[fwd.id].history.filter((h) => h.season === season);
check('old offseason save: the single season row is replaced by club/stage rows', JSON.stringify(fh2.map((h) => [h.teamId, h.kind, h.gp, h.goals])) === JSON.stringify(fh.map((h) => [h.teamId, h.kind, h.gp, h.goals])), JSON.stringify(fh2.map((h) => [h.teamId, h.kind, h.gp, h.goals])));

/* ---------- new season ---------- */
G.startNewSeason();
const s3 = st();
check('new season: splits cleared, history kept', s3.league.season !== season && Object.values(s3.players).every((p) => !p.seasonSplits?.length) && s3.splitsSeason === s3.league.season && s3.players[fwd.id].history.some((h) => h.season === season));
G.simulateToNextUserGame(false); G.simulateDay(true);
check('new season: games go to new splits', Object.values(st().players).some((p) => (p.seasonSplits?.length ?? 0) > 0) && splitsAddUp(st()), `${st().phase} day ${st().day}`);

console.log(failed ? `${failed} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
