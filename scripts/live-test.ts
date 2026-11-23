// Live-statistics test: stats folded from revealed events must (a) start every period empty for that period,
// (b) grow event by event, (c) end exactly at the engine's totals, (d) agree with the engine about power plays.
import { readFileSync } from 'node:fs';
import { parseRosterText, detectConference } from '../src/game/roster';
import { GameSim } from '../src/game/engine';
import { applyEvent, emptyLive, foldEvents, manpower } from '../src/game/live';

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const r = parseRosterText(readFileSync('public/rostfdfer.json', 'utf8'));
const N = 600;
let mismFinal = 0, mismBlock = 0, prefill = 0, nonMono = 0, ppWrong = 0, evWrong = 0, ppGoals = 0, evGoals = 0, ot = 0, so = 0, swaps = 0, goalieMism = 0;
let totGoals = 0, totPPG = 0, totPPC = 0, slugLeak = 0, earlyEnd = 0;
for (let n = 0; n < N; n++) {
  const h = r.teams[n % r.teams.length], a = r.teams[(n * 7 + 3) % r.teams.length];
  if (h.id === a.id) continue;
  const sim = new GameSim({ id: h.id, lineup: h.lineup, name: h.name }, { id: a.id, lineup: a.lineup, name: a.name }, r.players, n % 3 === 0);
  const live = emptyLive();
  let shown = 0;
  let guard = 0;
  while (sim.status !== 'done' && guard++ < 40) {
    const before = JSON.stringify({ s: live.shots, h: live.hits, p: live.pim, g: live.ppGoals, c: live.ppChances, sc: live.score });
    const evs = sim.status === 'ot' ? sim.simOT() : sim.status === 'so' ? sim.simShootout() : sim.simPeriod();
    // (a) the first event of a block is the period start: nothing of the new period may be visible yet
    applyEvent(live, evs[0], h.id);
    const afterStart = JSON.stringify({ s: live.shots, h: live.hits, p: live.pim, g: live.ppGoals, c: live.ppChances, sc: live.score });
    if (evs[0].type !== 'period_start' || before !== afterStart || !eq(live.periods[live.periods.length - 1], [0, 0])) prefill++;
    for (let i = 1; i < evs.length; i++) {
      const e = evs[i];
      const prevShots = live.shots[0] + live.shots[1];
      // (d) what the scoreboard indicator says right before this goal vs. how the engine scored it
      if (e.type === 'goal' && e.period <= 3) {
        const mp = manpower(live, e.sec).state;
        const ti = e.team === h.id ? 0 : 1;
        if (e.pp) { ppGoals++; if (mp !== ti) ppWrong++; }
        else if (e.strength === 'SH') { if (mp !== 1 - ti) ppWrong++; }
        else if (e.strength === '4v4') { if (mp !== 'even') ppWrong++; }
        else if (e.strength === 'EV') { evGoals++; if (mp !== null) evWrong++; } // empty-net goals may come at any manpower
      }
      applyEvent(live, e, h.id);
      if (e.type === 'goal' && e.strength === 'PP' && manpower(live, e.sec).state === null) earlyEnd++;
      if (live.shots[0] + live.shots[1] < prevShots) nonMono++;
      if (e.type === 'penalty' && !e.text.includes(`(${h.name})`) && !e.text.includes(`(${a.name})`)) slugLeak++;
    }
    shown += evs.length;
    // (c) at the end of every block the folded stats equal the engine's
    const ok = eq(live.shots, sim.shots) && eq(live.score, sim.score) && eq(live.periods, sim.periodScores) && [0, 1].every((i) => live.hits[i] === sim.stats[i].hits && live.pim[i] === sim.stats[i].pim && live.ppGoals[i] === sim.stats[i].ppGoals && live.ppChances[i] === sim.stats[i].ppChances);
    if (!ok) { mismBlock++; if (mismBlock <= 3) console.log('   MISMATCH period', sim.period, 'status', sim.status, JSON.stringify({ live: { sh: live.shots, sc: live.score, per: live.periods, hits: live.hits, pim: live.pim, ppg: live.ppGoals, ppc: live.ppChances }, sim: { sh: sim.shots, sc: sim.score, per: sim.periodScores, st: sim.stats } })); }
    for (const [gid, g] of Object.entries(live.goalies)) { const l = sim.lines[gid]; if (!l || l.saves !== g.saves || l.shotsAgainst !== g.shotsAgainst || l.goalsAgainst !== g.goalsAgainst) goalieMism++; }
    // the manager changes the goalie between periods now and then
    if (sim.status === 'playing' && n % 5 === 0 && sim.period === 1 && sim.home.lineup.backupG) {
      const L = { ...sim.home.lineup, starterG: sim.home.lineup.backupG, backupG: sim.home.lineup.starterG };
      sim.setLineup(0, L); sim.setGoalie(0, L.starterG); swaps++;
    }
  }
  const res = sim.result();
  if (!eq(foldEvents(res.events, h.id).shots, [res.homeStats.shots, res.awayStats.shots]) || shown !== res.events.length) mismFinal++;
  if (res.so) so++; else if (res.ot) ot++;
  totGoals += res.homeScore + res.awayScore - (res.so ? 1 : 0); totPPG += res.homeStats.ppGoals + res.awayStats.ppGoals; totPPC += res.homeStats.ppChances + res.awayStats.ppChances;
}
console.log(`${N} matches (incl. ${ot} OT, ${so} shootouts, ${swaps} goalie changes)`);
check('nothing of a period is shown at its start', prefill === 0, `${prefill} violations`);
check('stats only grow as events arrive', nonMono === 0);
check('folded stats = engine totals after every period', mismBlock === 0, `${mismBlock} mismatches`);
check('folded goalie saves = engine goalie lines', goalieMism === 0, `${goalieMism} mismatches`);
check('full fold = final box score', mismFinal === 0);
check(`scoreboard manpower agrees with engine on all ${ppGoals} PP goals (and all short-handed / 4-on-4 goals)`, ppWrong === 0 && ppGoals > 100, `${ppWrong} wrong`);
check(`indicator is off on all ${evGoals} full-strength goals`, evWrong === 0 && evGoals > 1000, `${evWrong} wrong`);
check('a power-play goal can end the penalty early', earlyEnd > 50, `${earlyEnd} times`);
check('penalty lines name the club exactly as in the roster', slugLeak === 0, `${slugLeak} wrong`);
console.log(`     calibration: ${(totGoals / N / 2).toFixed(2)} goals per team per game, power play ${(100 * totPPG / totPPC).toFixed(1)}% (${(totPPC / N / 2).toFixed(2)} chances per team per game)`);

// conference detection
const cases: [unknown, unknown, string | null][] = [
  ['Восток', '', 'Восток'], ['Восточная конференция', '', 'Восток'], ['восточная', '', 'Восток'], ['East', '', 'Восток'], ['EASTERN', '', 'Восток'], ['В', '', 'Восток'],
  ['Запад', '', 'Запад'], ['Западная конференция', '', 'Запад'], ['west', '', 'Запад'], ['W', '', 'Запад'],
  [undefined, 'Харламова', 'Восток'], [undefined, 'Дивизион Чернышева', 'Восток'], ['', 'Боброва', 'Запад'], [undefined, 'Тарасова', 'Запад'], [undefined, undefined, null], ['???', '', null],
];
const bad = cases.filter(([c, d, exp]) => detectConference(c, d) !== exp);
check('conference names are recognized (incl. «Восточная конференция», East, by division)', bad.length === 0, bad.map((b) => JSON.stringify(b)).join(' '));
const mini = (conf: unknown[]) => parseRosterText(JSON.stringify({ teams: conf.map((c, i) => ({ id: 't' + i, name: 'T' + i, conference: c, players: [] })) }));
const m1 = mini(['Восточная конференция', 'Восточная конференция', 'Западная конференция', 'Западная конференция']);
check('«Восточная конференция» listed first in the file stays in the East', eq(m1.teams.map((t) => t.conference), ['Восток', 'Восток', 'Запад', 'Запад']));
const m2 = mini(['Восток', 'Восток', undefined, 'xyz']);
check('unknown conference: balanced fallback + warning', eq(m2.teams.map((t) => t.conference), ['Восток', 'Восток', 'Запад', 'Запад']) && m2.warnings.filter((w) => w.includes('онференция')).length === 2, m2.teams.map((t) => t.conference).join(','));
check('example roster: 13 West / 12 East, no conference warnings', r.teams.filter((t) => t.conference === 'Запад').length === 13 && r.teams.filter((t) => t.conference === 'Восток').length === 12 && !r.warnings.some((w) => w.includes('онференция')));
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
