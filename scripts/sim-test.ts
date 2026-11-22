import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { createGameState, store, simulateDay, startNewSeason, simulateToNextUserGame, proposeTrade, offerContract, rankAll } from '../src/game/state';
import { GameSim } from '../src/game/engine';
import { payroll } from '../src/game/ratings';

const r = parseRosterText(readFileSync('public/roster.json', 'utf8'));
console.log('teams', r.teams.length, 'warnings', r.warnings.slice(0, 5));
for (const t of r.teams.slice(0, 3)) {
  const L = t.lineup;
  console.log(t.id, t.name, t.conference, 'F', L.F.map((l) => l.filter(Boolean).length).join(','), 'D', L.D.map((l) => l.filter(Boolean).length).join(','), 'G', L.starterG, L.backupG, 'pp1', L.pp1.length, 'pk1', L.pk1.length, 'payroll', payroll(t.players, r.players) / 1e6);
}
console.log('over cap:', r.teams.filter((t) => payroll(t.players, r.players) > r.salaryCap).map((t) => t.name));
{
  let gf = 0, ga = 0, sf = 0, sa = 0, ot = 0, so = 0, homeW = 0, n = 400, pim = 0, ppc = 0;
  const h = r.teams[0], a = r.teams[1];
  for (let i = 0; i < n; i++) {
    const res = new GameSim({ id: h.id, lineup: h.lineup }, { id: a.id, lineup: a.lineup }, r.players).runAll();
    gf += res.homeScore; ga += res.awayScore; sf += res.homeStats.shots; sa += res.awayStats.shots; if (res.ot) ot++; if (res.so) so++; if (res.homeScore > res.awayScore) homeW++;
    pim += res.homeStats.pim + res.awayStats.pim; ppc += res.homeStats.ppChances + res.awayStats.ppChances;
  }
  console.log('EQUAL TEAMS avg goals', (gf / n).toFixed(2), (ga / n).toFixed(2), 'shots', (sf / n).toFixed(1), (sa / n).toFixed(1), 'ot%', (ot / n * 100).toFixed(1), 'so%', (so / n * 100).toFixed(1), 'homeWin%', (homeW / n * 100).toFixed(1), 'pim/game', (pim / n).toFixed(1), 'pp/game', (ppc / n).toFixed(1));
  let w = 0; n = 400;
  const s1 = r.teams.find((t) => t.id === 'metallurg')!, s2 = r.teams.find((t) => t.id === 'kunlun')!;
  for (let i = 0; i < n; i++) { const res = new GameSim({ id: s1.id, lineup: s1.lineup }, { id: s2.id, lineup: s2.lineup }, r.players).runAll(); if (res.homeScore > res.awayScore) w++; }
  console.log('STRONG vs WEAK strong win%', (w / n * 100).toFixed(1));
  const res = new GameSim({ id: h.id, lineup: h.lineup }, { id: a.id, lineup: a.lineup }, r.players).runAll();
  console.log('sample events', res.events.length, 'scorers', res.scorers.length, 'stars', res.stars.length, 'lines', Object.keys(res.lines).length, 'periods', res.periodScores.map((p) => p.join('-')).join(' '));
  console.log(res.events.slice(0, 5).map((e) => `${e.period} ${e.time} ${e.type} ${e.text}`).join('\n'));
  console.log(res.events.filter((e) => e.type === 'goal').slice(0, 3).map((e) => `${e.period} ${e.time} ${e.text}`).join('\n'));
  console.log('bad lines', Object.values(res.lines).filter((l) => l.shotsAgainst > 0 && l.saves + l.goalsAgainst !== l.shotsAgainst).length);
}
{
  store.set(createGameState(r, 'ska'));
  const s0 = store.get()!;
  console.log('schedule days', s0.schedule.length, 'games', s0.schedule.reduce((a, d) => a + d.length, 0), 'user games', s0.schedule.flat().filter((g) => g.home === 'ska' || g.away === 'ska').length);
  const perTeam = new Map<string, number>(); let homeCount = new Map<string, number>();
  for (const d of s0.schedule) for (const g of d) { perTeam.set(g.home, (perTeam.get(g.home) ?? 0) + 1); perTeam.set(g.away, (perTeam.get(g.away) ?? 0) + 1); homeCount.set(g.home, (homeCount.get(g.home) ?? 0) + 1); }
  const pc = [...perTeam.values()]; const hc = [...homeCount.values()];
  console.log('games per team min/max', Math.min(...pc), Math.max(...pc), 'home min/max', Math.min(...hc), Math.max(...hc), 'days with 0 games', s0.schedule.filter((d) => !d.length).length);
  const t0 = Date.now();
  let days = 0;
  while (store.get()!.phase !== 'offseason' && days < 2000) { simulateDay(true); days++; }
  const s = store.get()!;
  console.log('simulated days', days, 'in', Date.now() - t0, 'ms; phase', s.phase);
  const all = rankAll(s);
  console.log(all.slice(0, 5).map((t) => `${t.name} ${t.record.points} (${t.record.w}-${t.record.otw}-${t.record.sow}-${t.record.otl}-${t.record.sol}-${t.record.l} ${t.record.gf}:${t.record.ga})`).join('\n'));
  console.log('last', all.slice(-3).map((t) => `${t.name} ${t.record.points}`).join(', '));
  const totG = all.reduce((a, t) => a + t.record.gf, 0); const totGP = all.reduce((a, t) => a + t.record.gp, 0);
  console.log('league avg goals/team/game', (totG / totGP).toFixed(2), 'gp each', all[0].record.gp);
  const sk = Object.values(s.players).filter((p) => p.teamId && p.position !== 'G').sort((a, b) => b.stats.goals + b.stats.assists - (a.stats.goals + a.stats.assists));
  console.log('top scorers', sk.slice(0, 3).map((p) => `${p.name} ${p.stats.gp}gp ${p.stats.goals}+${p.stats.assists}`).join(' | '));
  const gl = Object.values(s.players).filter((p) => p.position === 'G' && p.stats.gp > 20).sort((a, b) => b.stats.saves / b.stats.shotsAgainst - a.stats.saves / a.stats.shotsAgainst);
  console.log('goalies best', `${gl[0].name} ${(gl[0].stats.saves / gl[0].stats.shotsAgainst * 100).toFixed(3)} gp${gl[0].stats.gp}`, 'worst', `${gl[gl.length - 1].name} ${(gl[gl.length - 1].stats.saves / gl[gl.length - 1].stats.shotsAgainst * 100).toFixed(3)}`);
  console.log('summary', JSON.stringify(s.summaries[0]).slice(0, 600));
  console.log('champion', s.teams[s.playoffs!.champion!].name, 'series', s.playoffs?.series.map((x) => `${x.round}:${x.wins.join('-')}${x.done ? '' : '!'}`).join(' '));
  console.log('offseason expiring', s.offseason?.expiring.length, 'progressions', s.offseason?.progressions.length, 'FA', s.freeAgents.length, 'news', s.news.length, 'offers pending', s.offers.length);
  console.log('news sample', s.news.slice(0, 4).map((n) => `[${n.type}] ${n.text}`).join('\n'));
  console.log('trade news', s.news.filter((n) => n.type === 'trade').slice(0, 2).map((n) => n.text).join(' | '));
  const U = s.teams.ska;
  console.log('user budget', U.budget / 1e6, 'payroll', payroll(U.players, s.players) / 1e6, 'roster', U.players.length);
  startNewSeason();
  const s2 = store.get()!;
  console.log('new season', s2.league.season, 'phase', s2.phase, 'day', s2.day, 'days', s2.schedule.length, 'rosters min/max', Math.min(...Object.values(s2.teams).map((t) => t.players.length)), Math.max(...Object.values(s2.teams).map((t) => t.players.length)));
  console.log('trade', proposeTrade('cska', [U.players[3]], [s2.teams.cska.players[4]]));
  console.log('sign', s2.freeAgents[0], offerContract(s2.freeAgents[0], 10_000_000, 2).text);
  const res = simulateToNextUserGame();
  console.log('sim-to-next', res, 'day', store.get()!.day, 'user gp', store.get()!.teams.ska.record.gp);
}
