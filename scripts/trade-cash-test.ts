// Money in trades: the manager may add cash to an offer, ask for cash, buy a player for money or sell one for money.
// Run: npx tsx scripts/trade-cash-test.ts
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import * as G from '../src/game/state';
import { CASH_PER_VALUE, MAX_TRADE_CASH, evaluateTrade, tradeValue, tradeWindow } from '../src/game/ai';

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const text = readFileSync('scripts/fixtures/test-roster.json', 'utf8');
const st = () => G.store.get()!;
G.store.set(G.createGameState(parseRosterText(text), 'ska'));
check('the trade window is open at the start', tradeWindow(st()).open);

const s0 = st();
const partner = 'cska';
const P = s0.players;
const theirs = s0.teams[partner].players.map((id) => P[id]).filter((p) => p.position !== 'G').sort((a, b) => tradeValue(a) - tradeValue(b));
const target = theirs[Math.floor(theirs.length * 0.4)]; // a depth player, not a franchise star
const mine = s0.teams.ska.players.map((id) => P[id]).filter((p) => p.position !== 'G').sort((a, b) => tradeValue(a) - tradeValue(b));

check('nothing for something is not a deal', !evaluateTrade(s0, partner, [], [target.id], 0).ok);
const ratios = [0, 20, 60, 120].map((m) => evaluateTrade(s0, partner, [], [target.id], m * 1_000_000).ratio);
check('more money makes the offer better for the partner', ratios.every((r, i) => i === 0 || r > ratios[i - 1]), ratios.map((r) => r.toFixed(2)).join(' < '));

// the smallest fee that buys him (5 M steps)
let fee = 0;
for (let m = 5; m <= MAX_TRADE_CASH / 1e6; m += 5) if (evaluateTrade(s0, partner, [], [target.id], m * 1e6).ok) { fee = m * 1e6; break; }
check('a depth player can be bought for money alone', fee > 0, `${target.name} (${target.overall}) — ${fee / 1e6} млн ₽`);
check('the fee is in line with his value', fee >= tradeValue(target) * CASH_PER_VALUE * 0.7 && fee <= tradeValue(target) * CASH_PER_VALUE * 1.8, `value ${tradeValue(target).toFixed(1)}`);
const short = evaluateTrade(s0, partner, [], [target.id], fee - 5e6);
check('a lower fee is turned down with a money hint', !short.ok && /доплата ≈ \d+ млн ₽/.test(short.reason), short.reason);

const budgetU = s0.teams.ska.budget, budgetP = s0.teams[partner].budget;
const r = G.proposeTrade(partner, [], [target.id], fee);
const s1 = st();
check('buying for money: the player moves', r.ok && s1.players[target.id].teamId === 'ska', r.reason);
check('buying for money: the budgets move by the fee', s1.teams.ska.budget === budgetU - fee && s1.teams[partner].budget === budgetP + fee);
check('the news names the money', s1.news.some((n) => n.text.includes(`${fee / 1e6} млн ₽`)));

// sell a player for money: a cheap one for a modest fee is accepted, a huge fee is not
const seller = mine.find((p) => p.id !== target.id && tradeValue(p) > 1)!;
const fair = Math.max(5e6, Math.floor((tradeValue(seller) * CASH_PER_VALUE * 0.5) / 5e6) * 5e6);
const greedy = evaluateTrade(s1, partner, [seller.id], [], -MAX_TRADE_CASH);
check('asking far too much for a player is refused', !greedy.ok, greedy.reason);
const b2u = s1.teams.ska.budget, b2p = s1.teams[partner].budget;
const sell = G.proposeTrade(partner, [seller.id], [], -fair);
const s2 = st();
check('selling for money: accepted at a fair price, budgets move the other way', sell.ok && s2.players[seller.id].teamId === partner && s2.teams.ska.budget === b2u + fair && s2.teams[partner].budget === b2p - fair, `${seller.name} за ${fair / 1e6} млн ₽: ${sell.reason}`);

// a player plus money for a better player
const pool = s2.teams[partner].players.map((id) => s2.players[id]).filter((p) => p.position !== 'G' && !p.nmc).sort((a, b) => tradeValue(a) - tradeValue(b));
const better = pool[Math.floor(pool.length * 0.55)];
const swap = s2.teams.ska.players.map((id) => s2.players[id]).filter((p) => p.position === better.position && tradeValue(p) < tradeValue(better) * 0.75 && tradeValue(p) > tradeValue(better) * 0.4)[0]
  ?? s2.teams.ska.players.map((id) => s2.players[id]).filter((p) => p.position !== 'G' && tradeValue(p) < tradeValue(better) * 0.75).sort((a, b) => tradeValue(b) - tradeValue(a))[0];
const plain = evaluateTrade(s2, partner, [swap.id], [better.id], 0);
let topUp = 0;
for (let m = 5; m <= MAX_TRADE_CASH / 1e6; m += 5) if (evaluateTrade(s2, partner, [swap.id], [better.id], m * 1e6).ok) { topUp = m * 1e6; break; }
check('a player plus a top-up can land a better player', !plain.ok && (topUp > 0 || /доплата|ЗНО|лидер/.test(plain.reason)), `${swap.name} → ${better.name}: ${topUp ? topUp / 1e6 + ' млн ₽' : plain.reason}`);

// limits
check('no more than the cash limit', !evaluateTrade(s2, partner, [], [target.id], MAX_TRADE_CASH + 5e6).ok);
G.store.update((s) => { s.teams.ska.budget = 10_000_000; });
const poor = G.proposeTrade(partner, [], [theirs[2].id], 50e6);
check("the manager cannot pay more than the club's budget", !poor.ok && /бюджете/.test(poor.reason), poor.reason);
G.store.update((s) => { s.teams.ska.budget = 1_500_000_000; s.teams[partner].budget = 120_000_000; });
const broke = evaluateTrade(st(), partner, [mine[0].id], [], -50e6);
check('a club without money cannot pay', !broke.ok && /нет таких денег/.test(broke.reason), broke.reason);

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
