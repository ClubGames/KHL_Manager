// Manager features test: AI bench decisions (timeouts, empty net, late-game shape, three lines),
// intermission hints, scouting uncertainty, inbox + fast-sim stops, press conferences, preseason
// tournament and the trade block.
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import * as G from '../src/game/state';
import { GameSim } from '../src/game/engine';
import { foldEvents } from '../src/game/live';
import { intermissionHints, swapInLineup } from '../src/game/assistant';
import { assignScout, knowledgeOf, scoutedOvr, stepScouting } from '../src/game/scouting';
import { buildInbox } from '../src/game/inbox';
import { preseasonTable } from '../src/game/preseason';
import { clearTradeCache, generateBlockProposal, matchesWants, maybeIncomingOffer, shopTradeBlock } from '../src/game/ai';

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const text = readFileSync('public/rostfdfer.json', 'utf8');
const r = parseRosterText(text);
const st = () => G.store.get()!;

/* ---------- AI bench decisions ---------- */
let aiTimeouts = 0, momentumTO = 0, pullTO = 0, enShown = 0, press = 0, protect = 0, games = 0, line4AfterShort = 0, userTO = 0;
for (let n = 0; n < 300; n++) {
  const h = r.teams[n % r.teams.length], a = r.teams[(n * 5 + 3) % r.teams.length];
  if (h.id === a.id) continue;
  const sim = new GameSim({ id: h.id, lineup: h.lineup, name: h.name }, { id: a.id, lineup: a.lineup, name: a.name }, r.players);
  if (n % 2 === 0) sim.userSide = 0;
  sim.runAll();
  games++;
  for (const e of sim.events) {
    if (e.type !== 'info') continue;
    if (e.text.includes('Тайм-аут')) {
      aiTimeouts++;
      if (sim.userSide === 0 && e.team === h.id) userTO++;
      if (e.text.includes('натиск')) momentumTO++; else pullTO++;
    }
    if (e.text.includes('снимает вратаря')) enShown++;
    if (e.text.includes('бросается в атаку')) press++;
    if (e.text.includes('закрывается')) protect++;
  }
  // after an AI side shortened its bench, its 4th line must not appear on shots/goals any more
  const pe = sim.events.find((e) => e.type === 'info' && e.text.includes('закрывается'));
  if (pe) {
    const ti = pe.team === h.id ? 0 : 1;
    line4AfterShort += sim.events.filter((e) => e.sec > pe.sec + 45 && e.lines && e.period === 3 && e.lines[ti] === 3).length;
  }
}
check('AI coaches call timeouts (momentum and before the six-on-five)', momentumTO > 5 && pullTO > 5, `${aiTimeouts} тайм-аутов в ${games} матчах: ${momentumTO} против натиска, ${pullTO} перед снятием вратаря`);
check('the AI never takes a decision for the manager’s bench', userTO === 0);
check('automatic empty net is announced in the play-by-play', enShown > 10, `${enShown}`);
check('late game: trailing AI presses, leading AI protects the lead', press > 10 && protect > 10, `прессинг ${press}, оборона ${protect}`);
check('a shortened bench rolls only three forward lines', line4AfterShort === 0, `${line4AfterShort} эпизодов 4-го звена`);

// The manager's short bench & a replan keep the AI's decisions consistent.
{
  const h = r.teams[0], a = r.teams[1];
  const sim = new GameSim({ id: h.id, lineup: h.lineup, name: h.name }, { id: a.id, lineup: a.lineup, name: a.name }, r.players);
  sim.userSide = 0;
  sim.simPeriod(); sim.simPeriod();
  const evs = sim.simPeriod();
  const cut = evs.slice(0, Math.max(2, Math.floor(evs.length / 3)));
  const re = sim.replanLivePeriod(cut, cut[cut.length - 1].sec + 5, h.id, () => { sim.setShortBench(0, true); return 'три звена'; });
  const after = (re ?? []).filter((e) => e.sec > cut[cut.length - 1].sec + 45 && e.lines && e.lines[0] === 3).length;
  const tos = (re ?? []).filter((e) => e.type === 'info' && e.text.includes('Тайм-аут') && e.team === a.id).length;
  check('manager can shorten the bench mid-period (replan)', !!re && after === 0 && sim.shortBench[0]);
  check('replan does not duplicate AI timeouts', tos <= 1, `${tos}`);
}

/* ---------- intermission hints ---------- */
{
  const t = r.teams[2];
  const L = t.lineup;
  const sim = new GameSim({ id: t.id, lineup: L, name: t.name }, { id: r.teams[3].id, lineup: r.teams[3].lineup, name: r.teams[3].name }, r.players);
  sim.simPeriod();
  const live = foldEvents(sim.events, t.id);
  const hints = intermissionHints({ live, userIdx: 0, faceoffs: [3, 9], lineup: L, P: r.players, tactics: sim.tactics[0], period: 1, goalieId: sim.goalies[0], shortBench: false });
  const fo = hints.find((x) => x.id === 'fo');
  check('assistant flags lost faceoffs', !!fo && fo.text.includes('75%'), fo?.text ?? '—');
  if (fo?.action?.kind === 'swap') {
    const L2 = swapInLineup(L, fo.action.a, fo.action.b);
    check('faceoff hint action puts the suggested player at centre of line 2', L2.F[1][0] === fo.action.a);
  }
  const lead = { ...live, score: [3, 1] as [number, number] };
  check('assistant suggests three lines when leading after two periods', intermissionHints({ live: lead, userIdx: 0, faceoffs: [5, 5], lineup: L, P: r.players, tactics: sim.tactics[0], period: 2, goalieId: sim.goalies[0], shortBench: false }).some((x) => x.action?.kind === 'shortBench'));
}

/* ---------- career features ---------- */
G.store.set(G.createGameState(parseRosterText(text), 'ska'));
const s0 = st();
check('new career gets fans, scouting, trade block and a preseason tournament', s0.fans === 60 && !!s0.scouting && !!s0.tradeBlock && !!s0.preseason && s0.preseason.teams.includes('ska') && s0.preseason.games.length === 6, s0.preseason?.name);
check('the preseason is in the inbox', buildInbox(s0).some((t) => t.kind === 'preseason'));

// scouting
{
  const s = st();
  const other = s.teams.cska.players.map((id) => s.players[id]).sort((a, b) => a.overall - b.overall)[3];
  const own = s.players[s.teams.ska.players[0]];
  const v = scoutedOvr(s, other);
  check('own players are known exactly, others with an error margin', scoutedOvr(s, own).exact && !v.exact && v.err >= 3 && Math.abs(v.value - other.overall) <= v.err, `${other.name}: ${v.value}±${v.err} (на деле ${other.overall})`);
  const err0 = v.err;
  check('scout assignment accepted', assignScout(s, 'player', other.id) === null);
  check('two assignments of the same player are refused', assignScout(s, 'player', other.id) !== null);
  const reports: string[] = [];
  for (let d = 0; d < 10 && s.scouting!.assignments.length; d++) reports.push(...stepScouting(s, 1));
  const v2 = scoutedOvr(s, other);
  check('about a week of scouting make the rating exact and produce a report', v2.exact && v2.value === other.overall && reports.length === 1 && s.scouting!.assignments.length === 0, `${err0} → ${v2.err}; ${reports[0] ?? ''}`);
  const stars = Object.values(s.players).filter((p) => p.teamId && p.teamId !== 'ska' && p.overall >= 84);
  check('stars are better known than depth players', stars.every((p) => knowledgeOf(s, p) >= 70));
}

// preseason
{
  const before = JSON.stringify(st().teams.ska.record);
  const t1 = G.playPreseason('youth');
  check('preseason game played', !!t1, t1 ?? '');
  G.playPreseason('main');
  G.playPreseason('main');
  const ps = st().preseason!;
  check('preseason finishes after three rounds with a champion', ps.done && !!ps.champion && ps.games.every((g) => !!g.result), `${ps.name}: ${preseasonTable(ps).map((x) => `${st().teams[x.id].short} ${x.pts}`).join(', ')}`);
  check('preseason does not touch the standings', JSON.stringify(st().teams.ska.record) === before && st().day === 0);
  check('players were tried out', ps.tested.length >= 18);
}

// press conferences + inbox stop
{
  G.simulateToNextUserGame();
  const s = st();
  const g = (s.schedule[s.day] ?? []).find((x) => !x.played && (x.home === 'ska' || x.away === 'ska'))!;
  const { sim } = G.makeUserSim(s, g);
  sim.runAll();
  G.commitUserResult(g.id, sim.result());
  const pc = st().press;
  check('a press conference follows the user’s game', !!pc && pc.options.length >= 2 && (pc.total ?? 1) >= 2, pc ? `${pc.topic}: ${pc.question}` : '');
  check('the press conference is in the inbox', buildInbox(st()).some((t) => t.kind === 'press'));
  const fans0 = st().fans!, conf0 = st().board.confidence;
  let df = 0, db = 0, n = 0;
  while (st().press && n < 6) {
    const o = st().press!.options[0];
    df += o.effects.fans; db += o.effects.board; n++;
    G.answerPress(o.id);
  }
  check('answers apply their effects', st().press === null && n === (pc!.total ?? 1) && st().fans === Math.max(0, Math.min(100, fans0 + df)) && st().board.confidence === Math.max(5, Math.min(100, conf0 + db)), `${n} вопроса`);
}

// trade block
{
  G.store.update((s) => {
    const own = s.teams.ska.players.map((id) => s.players[id]).filter((p) => p.position !== 'G' && !p.nmc).sort((a, b) => b.overall - a.overall);
    own[6].tradeFlag = 'block';
    own[8].tradeFlag = 'block';
  });
  G.setTradeBlockWants({ positions: ['D'], minOvr: 68, maxAge: 31 });
  const s = st();
  let offers = 0, matching = 0, aimed = 0;
  for (let k = 0; k < 60; k++) {
    clearTradeCache();
    for (const id of s.teamOrder) {
      if (id === 'ska') continue;
      const p = generateBlockProposal(s, id);
      if (!p) continue;
      offers++;
      if (p.give.some((x) => matchesWants(s.tradeBlock!.wants, s.players[x]))) matching++;
      if (p.get.every((x) => s.players[x].tradeFlag === 'block')) aimed++;
    }
  }
  check('clubs build offers around the trade block', offers > 20, `${offers}`);
  check('offered players match the wish list (position, rating, age)', matching === offers, `${matching}/${offers}`);
  check('clubs ask only for players on the block', aimed === offers, `${aimed}/${offers}`);
  const shop = shopTradeBlock(s);
  check('"ask the league" returns up to three offers', shop.offers.length > 0 && shop.offers.length <= 3, shop.error ?? `${shop.offers.length}`);
  check('the second request is on cooldown', shopTradeBlock(s).error !== null);
  let incoming = 0, aimedIn = 0;
  for (let k = 0; k < 400; k++) {
    const o = maybeIncomingOffer(s);
    if (!o) continue;
    incoming++;
    if (o.get.every((x) => s.players[x].tradeFlag === 'block')) aimedIn++;
  }
  check('regular incoming offers favour the trade block', incoming > 0 && aimedIn / incoming > 0.4, `${aimedIn}/${incoming}`);
}

// fast sim stops when something new needs a decision
{
  G.store.update((s) => { s.offers = []; s.inboxDismissed = {}; });
  let stopped = 0, total = 0;
  for (let k = 0; k < 6; k++) {
    const res = G.simulateDays(10);
    total += res.days;
    if (res.stop === 'inbox') {
      stopped++;
      G.store.update((s) => { s.offers = []; for (const t of buildInbox(s)) G.store.get() && ((s.inboxDismissed ??= {})[t.id] = s.day); });
    }
  }
  check('5-day/10-day simulation stops for new inbox tasks', stopped > 0, `${stopped} остановок за ${total} дней`);
  const r2 = G.simulateToNextUserGame(true);
  check('sim-to-next-game reports why it stopped', r2 === 'userGame' || r2 === 'inbox', r2);
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
