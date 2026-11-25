// npx tsx scripts/schedule-test.ts — realistic KHL calendar: format, home/away runs, rest, pauses and dates.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { buildSchedule, seasonLayout, seasonDateObj } from '../src/game/schedule';
import { allStarTargetDay } from '../src/game/medical';

const r = parseRosterText(readFileSync('public/mods/KHL_2627/roster.json', 'utf8'));
const verbose = process.argv.includes('-v');
let checks = 0;
function analyse(season: string, teams = r.teams, G = r.gamesPerTeam) {
  const { days } = buildSchedule(teams, G, 1, season);
  const conf = new Map(teams.map((t) => [t.id, t.conference]));
  const rows = teams.map((t) => {
    const seq: { d: number; home: boolean; opp: string }[] = [];
    days.forEach((day, d) => day.forEach((g) => { if (g.home === t.id) seq.push({ d, home: true, opp: g.away }); else if (g.away === t.id) seq.push({ d, home: false, opp: g.home }); }));
    let run = 0, maxHome = 0, maxAway = 0, b2b = 0, maxGap = 0, runSpanDays = 0, start = 0;
    const runs: number[] = [];
    seq.forEach((x, i) => {
      if (i && x.home === seq[i - 1].home) run++; else { if (i) runs.push(run); run = 1; start = x.d; }
      if (x.home) maxHome = Math.max(maxHome, run); else maxAway = Math.max(maxAway, run);
      runSpanDays = Math.max(runSpanDays, x.d - start);
      if (i) { if (x.d - seq[i - 1].d === 1) b2b++; maxGap = Math.max(maxGap, x.d - seq[i - 1].d); }
    });
    runs.push(run);
    const meet = new Map<string, number>();
    seq.forEach((x) => meet.set(x.opp, (meet.get(x.opp) ?? 0) + 1));
    const other = teams.filter((o) => o.id !== t.id && conf.get(o.id) !== t.conference).map((o) => meet.get(o.id) ?? 0);
    const own = teams.filter((o) => o.id !== t.id && conf.get(o.id) === t.conference).map((o) => meet.get(o.id) ?? 0);
    return { id: t.id, gp: seq.length, home: seq.filter((x) => x.home).length, maxHome, maxAway, runSpanDays, b2b, maxGap, other, own, runs, first: seq[0]?.d, last: seq[seq.length - 1]?.d };
  });
  return { days, rows };
}

const SEASONS = ['2026/27', '2027/28', '2028/29', '2029/30', '2030/31', '2025/26'];
for (const season of SEASONS) {
  const { days, rows } = analyse(season);
  const reg = days.length, lay = seasonLayout(r.gamesPerTeam, season);
  if (verbose) {
    console.log(season, 'days', reg, 'game days', days.filter((d) => d.length).length, 'games', days.flat().length, 'end', seasonDateObj(reg - 1, reg, season).toDateString());
    for (const x of rows) console.log(x.id.padEnd(17), x.gp, `H${x.home}`, `maxH${x.maxHome} maxA${x.maxAway} span${x.runSpanDays}d b2b${x.b2b} gap${x.maxGap}`, 'own', [...new Set(x.own)].join('/'), 'other', [...new Set(x.other)].join('/'), 'runs', x.runs.join(''));
  }
  checks++;
  // Format: 68 games, 34 home; 2 vs every club of the other conference, 4–5 vs own conference (6 extra games).
  for (const x of rows) {
    assert.equal(x.gp, 68, `${x.id} games`);
    assert.ok(Math.abs(x.home - 34) <= 1, `${x.id} home ${x.home}`);
    assert.ok(x.other.every((k) => k === 2), `${x.id} plays the other conference twice: ${x.other}`);
    assert.ok(x.own.every((k) => k === 4 || k === 5), `${x.id} own conference 4–5: ${x.own}`);
    assert.equal(x.own.reduce((a, b) => a + b, 0), 46, `${x.id} 40 + 6 extra`);
  }
  // No month-long home stands or road trips.
  for (const x of rows) {
    assert.ok(x.maxHome <= 5 && x.maxAway <= 5, `${x.id} runs H${x.maxHome} A${x.maxAway}`);
    assert.ok(x.runSpanDays <= 16, `${x.id} a home stand / road trip lasts ${x.runSpanDays} days`);
    assert.ok(x.b2b <= 2, `${x.id} back-to-backs ${x.b2b}`);
    assert.ok(x.maxGap <= 12, `${x.id} longest gap ${x.maxGap}`);
  }
  const avgRun = rows.flatMap((x) => x.runs).reduce((a, b) => a + b, 0) / rows.flatMap((x) => x.runs).length;
  assert.ok(avgRun >= 1.4 && avgRun <= 2.6, `average home/away run ${avgRun}`);
  // Dates: first Saturday of September to about 20 March, pauses without games, a club never plays twice a day.
  assert.equal(days.findIndex((d) => d.length > 0), lay.start);
  assert.equal(seasonDateObj(lay.start, reg, season).getDay(), 6);
  const end = seasonDateObj(reg - 1, reg, season);
  assert.ok(end.getMonth() === 2 && end.getDate() >= 12 && end.getDate() <= 25, `ends ${end.toDateString()}`);
  for (const [a, b] of lay.breaks) for (let d = a; d <= b; d++) assert.equal(days[d].length, 0, `pause day ${d}`);
  assert.equal(allStarTargetDay(reg), lay.breaks[2][0] + 1);
  for (const day of days) { const seen = new Set<string>(); for (const g of day) { assert.ok(!seen.has(g.home) && !seen.has(g.away)); seen.add(g.home); seen.add(g.away); } }
  // Meetings of a pair are spread out.
  const pairDays = new Map<string, number[]>();
  days.forEach((day, d) => day.forEach((g) => { const k = [g.home, g.away].sort().join('|'); pairDays.set(k, [...(pairDays.get(k) ?? []), d]); }));
  for (const [k, ds] of pairDays) if (ds.length >= 4) assert.ok(ds[ds.length - 1] - ds[0] >= 60, `${k} meetings ${ds}`);
  console.log(`ok ${season}: ${reg} days, ${days.filter((d) => d.length).length} matchdays, avg home/away run ${avgRun.toFixed(2)}, max run ${Math.max(...rows.map((x) => Math.max(x.maxHome, x.maxAway)))}`);
}
// Deterministic per season, different between seasons.
checks++;
assert.deepEqual(buildSchedule(r.teams, 68, 1, '2026/27').days.map((d) => d.map((g) => g.home + g.away)), buildSchedule(r.teams, 68, 1, '2026/27').days.map((d) => d.map((g) => g.home + g.away)));
assert.notDeepEqual(buildSchedule(r.teams, 68, 1, '2026/27').days.map((d) => d.map((g) => g.home + g.away)), buildSchedule(r.teams, 68, 1, '2027/28').days.map((d) => d.map((g) => g.home + g.away)));
// Custom leagues: no conferences, odd team count, short season — every club still gets its games.
checks++;
for (const [k, G] of [[9, 24], [12, 40], [16, 56], [22, 68]] as const) {
  const teams = Array.from({ length: k }, (_, i) => ({ id: `t${i}` }));
  const { days } = buildSchedule(teams, G, 1, '2026/27');
  const gp = new Map<string, number>(); days.flat().forEach((g) => { gp.set(g.home, (gp.get(g.home) ?? 0) + 1); gp.set(g.away, (gp.get(g.away) ?? 0) + 1); });
  const vals = teams.map((t) => gp.get(t.id) ?? 0);
  assert.ok(Math.min(...vals) >= G - 1 && Math.max(...vals) <= G, `${k} teams × ${G}: ${vals}`);
}
console.log('ok custom leagues');
console.log(`PASS: ${checks} schedule checks`);
