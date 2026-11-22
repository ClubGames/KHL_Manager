// GM logic test: realistic trades, contract generation / negotiation / termination, finances, board, trade deadline.
import { readFileSync } from 'node:fs';
import { parseRosterText, rosterWithContracts } from '../src/game/roster';
import * as G from '../src/game/state';
import { generateProposal, groupOf, teamContext, tradeDeadline, tradeValue, tradeWindow, clearTradeCache } from '../src/game/ai';
import { askingSalary, buyoutCost, floorSalary, maxYears, talksLeft } from '../src/game/contracts';
import { payroll } from '../src/game/ratings';

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const text = readFileSync('public/roster.json', 'utf8');
const st = () => G.store.get()!;

/* ---------- contracts in the roster ---------- */
const bare = JSON.parse(text);
for (const t of bare.teams) for (const p of t.players) delete p.contract;
bare.teams[0].players[0].contract = { salary: 77_000_000 }; // salary given, term missing
bare.teams[0].players[1].contract = { salary: 33_000_000, years: 2 }; // complete
const bareText = JSON.stringify(bare);
const r1 = parseRosterText(bareText), r2 = parseRosterText(bareText);
const total = bare.teams.reduce((a: number, t: any) => a + t.players.length, 0);
check('players without a contract get one', r1.filled.length === total - 1, `${r1.filled.length} of ${total}`);
check('generated contracts are identical on every launch', JSON.stringify(r1.filled) === JSON.stringify(r2.filled));
const P1 = r1.players;
const first = r1.teams[0].players.map((id) => P1[id]);
check('given parts of a contract are kept, missing parts are filled', first[0].contract.salary === 77_000_000 && first[0].contract.years >= 1 && first[1].contract.salary === 33_000_000 && first[1].contract.years === 2);
const yrs = [0, 0, 0, 0, 0, 0];
for (const f of r1.filled) yrs[f.contract.years]++;
check('contract terms are varied (not everyone expires at once)', yrs[1] > 0 && yrs[2] > 0 && yrs[3] > 0 && yrs[1] < r1.filled.length * 0.5, `1 г.: ${yrs[1]}, 2: ${yrs[2]}, 3: ${yrs[3]}, 4: ${yrs[4]}`);
const overCap = r1.teams.filter((t) => payroll(t.players, P1) > r1.salaryCap).map((t) => t.name);
const pays = r1.teams.map((t) => payroll(t.players, P1) / 1e6);
check('generated payrolls fit under the salary cap', overCap.length === 0, `ФОТ ${Math.min(...pays).toFixed(0)}–${Math.max(...pays).toFixed(0)} млн при потолке ${r1.salaryCap / 1e6}`);
const olds = Object.values(P1).filter((p) => p.teamId && p.age >= 35);
check('veterans get short deals', olds.every((p) => p.contract.years <= maxYears(p.age)));
const saved = rosterWithContracts(r1);
const r3 = parseRosterText(saved);
check('saved roster file contains every contract (nothing left to generate)', r3.filled.length === 0);
check('saved roster reproduces the same contracts', r1.teams.every((t, i) => t.players.every((id, j) => { const a = P1[id].contract, b = r3.players[r3.teams[i].players[j]].contract; return a.salary === b.salary && a.years === b.years; })));
const back = JSON.parse(saved);
for (const t of back.teams) for (const p of t.players) delete p.contract;
const bare2 = JSON.parse(bareText);
for (const t of bare2.teams) for (const p of t.players) delete p.contract;
check('saving contracts changes nothing else in the file', JSON.stringify(back) === JSON.stringify(bare2));
check('roster with full contracts: nothing is generated', parseRosterText(text).filled.length === 0);

/* ---------- realistic proposals ---------- */
const mk = () => { G.store.set(G.createGameState(parseRosterText(text), 'ska')); };
mk();
for (let i = 0; i < 30; i++) G.simulateDay(true);
let n = 0, tries = 0, bad: string[] = [];
const ratios: number[] = [], kinds: Record<string, number> = {};
const ids = st().teamOrder;
for (let k = 0; k < 4000 && n < 400; k++) {
  const a = ids[Math.floor(Math.random() * ids.length)], b = ids[Math.floor(Math.random() * ids.length)];
  if (a === b || a === 'ska') continue;
  tries++;
  clearTradeCache();
  const s = st(), P = s.players;
  const pr = generateProposal(s, a, b);
  if (!pr) continue;
  n++;
  const X = P[pr.get[0]], pk = pr.give.map((id) => P[id]);
  const ca = teamContext(s, a), cb = teamContext(s, b);
  const g = groupOf(X);
  const ratio = pk.reduce((x, p) => x + tradeValue(p), 0) / tradeValue(X);
  ratios.push(ratio);
  kinds[`${ca.mode}:${g}`] = (kinds[`${ca.mode}:${g}`] ?? 0) + 1;
  const after = (tid: string, out: string[], inc: string[]) => s.teams[tid].players.filter((id) => !out.includes(id)).concat(inc);
  const cnt = (list: string[], gg: string) => list.filter((id) => groupOf(P[id]) === gg).length;
  const A = after(a, pr.give, pr.get), B = after(b, pr.get, pr.give);
  const minB = b === 'ska' ? { F: 8, D: 4, G: 2 } : { F: 12, D: 6, G: 2 };
  if (ratio < 0.92 || ratio > 1.21) bad.push(`value ${ratio.toFixed(2)}`);
  if (X.overall < ca.worst[g] + 2) bad.push('target is not an upgrade');
  if (pk.some((p) => ca.franchise.has(p.id))) bad.push('club offers its own leader');
  if (cb.franchise.has(X.id) && X.tradeFlag !== 'block') bad.push('asks for a franchise player');
  if (pk.some((p) => groupOf(p) === g)) bad.push('pays with the position it needs');
  if (Math.max(...pk.map((p) => p.overall)) < X.overall - 7) bad.push('junk for a good player');
  if (pk.some((p) => p.injury) || X.injury) bad.push('injured player');
  if (payroll(A, P) > s.league.salaryCap || payroll(B, P) > s.league.salaryCap) bad.push('over the cap');
  if (cnt(A, 'F') < 12 || cnt(A, 'D') < 6 || cnt(A, 'G') < 2 || cnt(B, 'F') < minB.F || cnt(B, 'D') < minB.D || cnt(B, 'G') < minB.G) bad.push('roster too thin');
  if (ca.mode === 'rebuild' && X.age > 27) bad.push('rebuilder buys a veteran');
}
ratios.sort((x, y) => x - y);
check(`${n} generated proposals all pass the realism rules`, n >= 150 && bad.length === 0, bad.length ? `${bad.length} violations: ${[...new Set(bad)].join(', ')}` : `value given/asked: median ${ratios[n >> 1].toFixed(2)}, range ${ratios[0].toFixed(2)}–${ratios[n - 1].toFixed(2)}`);
console.log(`     proposals by club ambition and position wanted: ${Object.entries(kinds).sort().map(([k, v]) => `${k} ${v}`).join(', ')}; ${tries} pairs tried`);

/* ---------- offers to the manager and the deadline ---------- */
mk();
const offers: any[] = [];
let seen = new Set<number>(), tradesAfter = 0, aiTrades = 0, deadline = 0;
while (st().phase === 'season') {
  G.simulateDay(true);
  const s = st();
  deadline = tradeDeadline(s);
  for (const o of s.offers) if (!seen.has(o.id)) { seen.add(o.id); offers.push({ ...o, madeOn: s.day }); }
}
for (const nw of st().news.concat()) if (nw.type === 'trade' && nw.text.startsWith('Обмен:')) { aiTrades++; if (nw.day >= deadline) tradesAfter++; }
check('the manager receives trade offers during the season', offers.length >= 2 && offers.length <= 25, `${offers.length} offers`);
check('every offer explains why the club wants the deal', offers.every((o) => typeof o.reason === 'string' && o.reason.length > 10), offers[0]?.reason);
check('no offers and no league trades after the deadline', offers.every((o) => o.madeOn < deadline && o.expires < deadline) && tradesAfter === 0, `deadline day ${deadline + 1}, league trades ${aiTrades}`);
check('deadline is announced and the window is closed', st().news.some((x) => x.text.startsWith('Дедлайн обменов')) || st().phase !== 'season');
const sAfter = st();
const thin = sAfter.teamOrder.filter((id) => id !== 'ska').filter((id) => { const t = sAfter.teams[id]; const c = (g: string) => t.players.filter((x) => groupOf(sAfter.players[x]) === g).length; return c('F') < 12 || c('D') < 6 || c('G') < 2 || payroll(t.players, sAfter.players) > sAfter.league.salaryCap; });
check('after a season of trading every club still has a legal roster and payroll', thin.length === 0, thin.join(','));
const closed = G.proposeTrade('cska', [sAfter.teams.ska.players[5]], [sAfter.teams.cska.players[5]]);
check('manager cannot trade after the deadline', !closed.ok && /едлайн|откроется/.test(closed.reason), closed.reason);

/* ---------- negotiation, extension, termination, finances, board ---------- */
mk();
for (let i = 0; i < 12; i++) G.simulateDay(true);
let s = st();
const U = s.teams.ska;
const fa = s.freeAgents.map((id) => s.players[id]).sort((a, b) => b.overall - a.overall)[0];
const ask = askingSalary(s, fa, 2, 'ska'), floor = floorSalary(s, fa, 2, 'ska');
check('hidden minimum is 87–97% of the asking price', floor >= ask * 0.87 - 1 && floor <= ask * 0.97 + 1, `ask ${ask / 1e6}, floor ${(floor / 1e6).toFixed(1)}`);
const low = G.offerContract(fa.id, Math.round(ask * 0.6), 2);
check('insulting offer is rejected and costs two attempts', !low.ok && low.left === 1, low.text);
const tooLong = G.offerContract(fa.id, ask, 9);
check('player refuses an over-long term without losing patience', !tooLong.ok && tooLong.left === 1 && tooLong.text.includes('не подпишет'), tooLong.text);
const mid = G.offerContract(fa.id, Math.round(floor * 0.9), 2);
check('second failed offer ends the talks', !mid.ok && mid.left === 0, mid.text);
const shut = G.offerContract(fa.id, ask, 2);
check('after the talks are over even his own asking price is refused', !shut.ok && shut.text.includes('прервал') && st().players[fa.id].teamId === null, shut.text);
s = st();
const fa2 = s.freeAgents.map((id) => s.players[id]).filter((p) => p.id !== fa.id).sort((a, b) => b.overall - a.overall)[0];
const b0 = st().teams.ska.budget;
const okSign = G.offerContract(fa2.id, floorSalary(st(), fa2, 1, 'ska'), 1);
check('offer at the hidden minimum is accepted; signing is not prepaid', okSign.ok && st().players[fa2.id].teamId === 'ska' && st().teams.ska.budget === b0, okSign.text);
s = st();
const lastYear = s.teams.ska.players.map((id) => s.players[id]).filter((p) => p.contract.years === 1).sort((a, b) => a.contract.salary - b.contract.salary)[0];
const longTerm = s.teams.ska.players.map((id) => s.players[id]).find((p) => p.contract.years >= 2)!;
check('contract with years to run cannot be extended yet', !G.offerContract(longTerm.id, 1e9, 1).ok);
const ext = G.offerContract(lastYear.id, askingSalary(s, lastYear, 2, 'ska'), Math.min(2, maxYears(lastYear.age)));
const oldSalary = lastYear.contract.salary;
check('extension is stored for next season; this season is unchanged', ext.ok && st().players[lastYear.id].contract.salary === oldSalary && !!st().players[lastYear.id].contract.next, ext.text);
s = st();
const victim = s.teams.ska.players.map((id) => s.players[id]).filter((p) => p.contract.years >= 2 && p.id !== longTerm.id).sort((a, b) => a.overall - b.overall)[0];
const cost = buyoutCost(s, victim), b1 = s.teams.ska.budget;
const expect = Math.round((victim.contract.salary * (victim.contract.years - 1 + (1 - s.day / 142))) / 3 / 1e5) * 1e5;
const rel = G.releasePlayer(victim.id);
check('termination costs a third of the money still owed', rel === null && cost === expect && cost > 0 && st().teams.ska.budget === b1 - cost && st().players[victim.id].teamId === null, `${(cost / 1e6).toFixed(1)} млн`);
check('board sets a season objective', !!st().board.text && st().board.confidence === 60, `${st().board.text} (состав №${st().board.rank} по силе)`);
while (st().phase !== 'offseason') G.simulateDay(true);
s = st();
const sum = s.summaries[s.summaries.length - 1];
check('season finances: salaries are paid from the income', (sum.revenue ?? 0) > 5e8 && (sum.payroll ?? 0) > 3e8 && typeof sum.board === 'string', `доходы ${(sum.revenue! / 1e6).toFixed(0)} млн, зарплаты ${(sum.payroll! / 1e6).toFixed(0)} млн; ${sum.board}`);
const pe = s.players[lastYear.id];
check('extension takes over when the old deal runs out', pe.teamId === 'ska' && !pe.contract.next && pe.contract.years >= 1 && !s.offseason!.expiring.includes(pe.id), `${pe.contract.salary / 1e6} млн × ${pe.contract.years}`);
const exp = s.offseason!.expiring.map((id) => s.players[id]);
check('other final-year contracts expire in the off-season', exp.length > 0 && exp.every((p) => p.contract.years === 0), `${exp.length} expiring`);
const e0 = exp[0];
const re = G.offerContract(e0.id, askingSalary(s, e0, 1, 'ska'), 1);
check('expired contract can be renewed at the asking price', re.ok && st().players[e0.id].contract.years === 1 && !st().offseason!.expiring.includes(e0.id), re.text);
check('trade window is open again in the off-season', tradeWindow(st()).open);
check('patience is per negotiation window', talksLeft(st(), st().players[fa.id]) === 3);
G.startNewSeason();
check('new season: new objective, deadline reset', st().phase === 'season' && !st().deadlinePassed && !!st().board.text && tradeWindow(st()).open);
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
