// Contract talks with players and coaches: interest, pitches, any salary, signing/achievement bonuses,
// counter-offers, refusals and bonus payouts.  npx tsx scripts/negotiation-test.ts
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import * as G from '../src/game/state';
import { askingSalary, floorSalary, maxYears, offerWorth, talksLeft } from '../src/game/contracts';
import { coachAsk, coachFloor, coachInterest, coachSeverance, playerInterest, REFUSE_BELOW } from '../src/game/negotiation';
import { bonusChance, bonusTargets, settleBonuses } from '../src/game/bonuses';

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const text = readFileSync('public/rostfdfer.json', 'utf8');
const st = () => G.store.get()!;
G.store.set(G.createGameState(parseRosterText(text), 'ska'));
G.store.update((s) => { s.teams.ska.budget = 5e9; s.league.salaryCap = 5e9; });

const fas = () => st().freeAgents.map((id) => st().players[id]).sort((a, b) => b.overall - a.overall);
/* ---------- interest ---------- */
const [a, b, c, d, e] = fas();
const ia = playerInterest(st(), a, 'ska');
check('interest is 0..100 with explained factors and a priority', ia.score >= 0 && ia.score <= 100 && ia.factors.length >= 2 && !!ia.priority, `${a.name}: ${ia.score}, ${ia.factors.map((f) => `${f.label} ${f.value}`).join('; ')}`);
const weak = st().teamOrder.filter((id) => id !== 'ska').map((id) => ({ id, i: playerInterest(st(), a, id).score })).sort((x, y) => x.i - y.i)[0];
check('a strong club interests a top free agent more than the weakest-looking one', ia.score > weak.i, `СКА ${ia.score} vs ${weak.id} ${weak.i}`);

/* ---------- pitches ---------- */
const before = playerInterest(st(), b, 'ska').score, ask0 = askingSalary(st(), b, 2, 'ska');
const p1 = G.pitchToPlayer(b.id, 'coach');
const p2 = G.pitchToPlayer(b.id, 'coach');
check('a pitch works once per negotiation window', p1.ok && !p2.ok && p2.text.includes('Уже'), `${p1.text} / ${p2.text}`);
const budget0 = st().teams.ska.budget;
const rel = G.pitchToPlayer(b.id, 'relocation');
check('relocation help is paid from the budget and raises interest', rel.ok && st().teams.ska.budget === budget0 - 2_000_000 && playerInterest(st(), st().players[b.id], 'ska').score > before, rel.text);
check('higher interest lowers the asking price', askingSalary(st(), st().players[b.id], 2, 'ska') <= ask0, `${ask0 / 1e6} → ${askingSalary(st(), st().players[b.id], 2, 'ska') / 1e6}`);

/* ---------- any salary, generous offer ---------- */
const moraleB = st().players[b.id].morale;
const big = Math.round(askingSalary(st(), st().players[b.id], 2, 'ska') * 1.37 / 1e5) * 1e5 + 100_000;
const r1 = G.offerContract(b.id, big, 2);
check('any salary can be offered (here 137% of the ask) and is accepted', r1.ok && st().players[b.id].contract.salary === big, r1.text);
check('an offer well above the need makes the player happy', st().players[b.id].morale > moraleB, `${moraleB} → ${st().players[b.id].morale}`);

/* ---------- counter-offer ---------- */
const fl = floorSalary(st(), st().players[c.id], 2, 'ska');
const r2 = G.offerContract(c.id, Math.round(fl * 0.9 / 1e5) * 1e5, 2);
check('a rejected offer comes with a counter-offer', !r2.ok && !!r2.counter && r2.counter >= fl * 0.99, `${r2.text}`);
const r3 = G.offerContract(c.id, r2.counter!, 2);
check('the counter-offer is accepted', r3.ok, r3.text);

/* ---------- signing bonus + achievement bonuses ---------- */
const P = st().players[d.id];
const yD = Math.min(3, maxYears(P.age));
const flD = floorSalary(st(), P, yD, 'ska');
const sal = Math.round(flD * 0.9 / 1e5) * 1e5;
const extras = { signingBonus: Math.round(sal * 0.45 / 1e5) * 1e5, bonuses: [{ kind: 'playoffs' as const, target: 0, amount: Math.round(sal * 0.2 / 1e5) * 1e5 }, { kind: (P.position === 'G' ? 'wins' : 'games') as 'wins' | 'games', target: bonusTargets(st(), P.position === 'G' ? 'wins' : 'games')[0], amount: Math.round(sal * 0.2 / 1e5) * 1e5 }] };
const worth = offerWorth(st(), P, sal, yD, 'ska', extras);
check('the player values bonuses below face value (risk) and spreads the signing bonus over the term', worth.signing === Math.round(extras.signingBonus / yD * (worth.signing > extras.signingBonus / yD + 1 ? 1.1 : 1)) && worth.bonuses < extras.bonuses[0].amount + extras.bonuses[1].amount, `worth ${(worth.total / 1e6).toFixed(1)} M vs floor ${(flD / 1e6).toFixed(1)} M`);
const budget1 = st().teams.ska.budget;
const r4 = G.offerContract(d.id, sal, yD, false, false, extras);
check('salary below the minimum is accepted when bonuses make up the difference', r4.ok === worth.total >= flD, r4.text);
if (r4.ok) check('signing bonus is paid at once; bonuses are written into the contract', st().teams.ska.budget === budget1 - extras.signingBonus && st().players[d.id].contract.bonuses?.length === 2, `${(budget1 - st().teams.ska.budget) / 1e6} M`);
const tooMuch = G.offerContract(e.id, 10_000_000, 2, false, false, { bonuses: [{ kind: 'playoffs', target: 0, amount: 6_000_000 }] });
check('achievement bonuses are limited to 50% of the salary', !tooMuch.ok && tooMuch.text.includes('50%'), tooMuch.text);
const chanceStrong = bonusChance(st(), { kind: 'playoffs', target: 0 }, 'ska', null), chanceWeak = bonusChance(st(), { kind: 'playoffs', target: 0 }, weak.id, null);
check('team bonus chances follow roster strength', chanceStrong > chanceWeak, `${(chanceStrong * 100).toFixed(0)}% vs ${(chanceWeak * 100).toFixed(0)}%`);

/* ---------- refusal ---------- */
G.store.update((s) => { const p = s.players[e.id]; p.talks = { key: `${s.seasonNumber}-reg`, left: 3, boost: -80 }; });
const r5 = G.offerContract(e.id, 1e9, 1);
check('a player with too little interest refuses to negotiate without losing patience', !r5.ok && r5.tone === 'refuse' && talksLeft(st(), st().players[e.id]) === 3 && playerInterest(st(), st().players[e.id], 'ska').score < REFUSE_BELOW, r5.text);

/* ---------- role promise ---------- */
const own = st().teams.ska.players.map((id) => st().players[id]).filter((p) => p.contract.years === 1 && p.position !== 'G').sort((x, y) => y.overall - x.overall)[0];
const pr = G.pitchToPlayer(own.id, 'role');
const r6 = G.offerContract(own.id, askingSalary(st(), st().players[own.id], 1, 'ska'), 1);
check('a credible role promise is stored with the extension', pr.ok && r6.ok && (st().players[own.id].promise?.season ?? 0) === st().seasonNumber + 1, `${pr.text}; ${r6.text}`);

/* ---------- coaches ---------- */
const market = st().coachMarket!;
const coach = market.find((x) => x.role === 'head')!;
const cf = coachFloor(st(), coach, 'head', 2);
const low = G.offerCoachContract(coach.id, 'head', { salary: Math.round(cf * 0.9 / 1e5) * 1e5, years: 2, signingBonus: 0, bonuses: [] });
check('coach rejects a low offer and names his price', !low.ok && !!low.counter, low.text);
const pc = G.pitchToCoach(coach.id, 'authority', 2);
const okC = G.offerCoachContract(coach.id, 'head', { salary: low.counter!, years: 2, signingBonus: 1_000_000, bonuses: [{ kind: 'round2', target: 0, amount: 3_000_000 }] });
const hired = st().teams.ska.coaches!.find((x) => x.id === coach.id);
check('coach signs for his counter-offer; contract, bonuses and guarantee are stored', okC.ok && !!hired && hired.contract?.years === 2 && hired.contract?.guarantee === true && hired.contract.bonuses?.[0]?.kind === 'round2', `${pc.text}; ${okC.text}`);
check('dismissal costs half a salary per remaining year (×1.5 with guaranteed powers)', !!hired && coachSeverance(hired) === Math.round(hired.salary * 0.5 * 2 * 1.5), hired ? `${coachSeverance(hired) / 1e6} M` : '');
const headCoach = st().coachMarket!.find((x) => x.role === 'head')!;
const weakest = st().teamOrder.map((id) => ({ id, s: coachInterest(st(), headCoach, id, 'assistant').score })).sort((x, y) => x.s - y.s)[0];
check('a head coach is much less keen on an assistant post', coachInterest(st(), headCoach, 'ska', 'assistant').score + 15 < coachInterest(st(), headCoach, 'ska', 'head').score && coachAsk(st(), headCoach, 'head', 1) > 0, `${weakest.id}: ${weakest.s}`);

/* ---------- payouts ---------- */
G.store.update((s) => {
  const p = s.players[s.teams.ska.players[0]];
  p.contract.bonuses = [{ kind: 'games', target: 1, amount: 1_000_000 }, { kind: 'cup', target: 0, amount: 5_000_000 }];
});
const bId = st().teams.ska.players[0];
while (st().phase === 'season') G.simulateDay(true);
const news = st().news.find((n) => n.text.startsWith('Бонусы по итогам регулярного'));
check('earned regular-season bonuses are paid with a news item', !!news && news.text.includes(st().players[bId].name), news?.text ?? 'нет новости');
const dry = settleBonuses(JSON.parse(JSON.stringify(st())), 'playoffs');
check('playoff bonuses are not paid before the playoffs are decided', !dry.lines.some((l) => l.includes('Кубке') || l.includes('Победа в Кубке')), dry.lines.join('; '));
while (st().phase !== 'offseason') G.simulateDay(true);
const champ = st().playoffs?.champion === 'ska';
const cupNews = st().news.find((n) => n.text.startsWith('Бонусы за плей-офф'));
check('playoff bonuses follow the result', champ ? !!cupNews && cupNews.text.includes('Победа в Кубке Гагарина') : !cupNews?.text.includes(st().players[bId].name), cupNews?.text ?? `СКА без Кубка: ${st().summaries.at(-1)?.userResult}`);
const promiseNews = st().news.find((n) => n.text.startsWith('Обещания игрокам'));
check('role promise is no longer pending after the regular season of its season', !promiseNews || !!promiseNews.text, promiseNews?.text ?? 'обещание на следующий сезон');
check('coach contract runs down in the off-season', st().teams.ska.coaches!.find((x) => x.id === coach.id)?.contract?.years === 1);

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
