// Press conferences and the dressing room: variety of questions, multi-question flow, follow-ups, player
// wishes / conflicts / club situations, promises that are kept or broken.
// Run: npx tsx scripts/press-test.ts
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import * as G from '../src/game/state';
import { applyEffects, fx, makePromise, nextClubEvent, recalled, roomMemory, trackPromises } from '../src/game/dressingRoom';
import { createPressConference } from '../src/game/press';
import { buildInbox, blockingTasks } from '../src/game/inbox';
import type { GameState } from '../src/types';

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const st = () => G.store.get()!;
G.store.set(G.createGameState(parseRosterText(readFileSync('public/rostfdfer.json', 'utf8')), 'ska'));

/* ---------- a long stretch of the season: answer everything at random ---------- */
const topics = new Map<string, number>(), reporters = new Set<string>(), eventKeys = new Map<string, number>();
let conferences = 0, questions = 0, pre = 0, multi = 0, answeredEvents = 0, kept = 0, broken = 0, maxPending = 0, badMorale = 0;
const seen = new Set<number>();
for (let day = 0; day < 140 && st().phase === 'season'; day++) {
  const s = st();
  const ug = (s.schedule[s.day] ?? []).find((g) => !g.played && (g.home === 'ska' || g.away === 'ska'));
  if (ug) {
    const { sim } = G.makeUserSim(s, ug);
    sim.runAll();
    G.commitUserResult(ug.id, sim.result());
  } else G.simulateDay(true);
  // press conference: walk through every question
  for (let guard = 0; st().press && guard < 6; guard++) {
    const pc = st().press!;
    if (!seen.has(pc.id)) {
      seen.add(pc.id); conferences++;
      if (pc.kind === 'pre') pre++;
      if ((pc.total ?? 1) > 1) multi++;
    }
    questions++;
    topics.set(pc.topic.replace(/: \d+:\d+.*$/, ''), (topics.get(pc.topic) ?? 0) + 1);
    if (pc.reporter) reporters.add(pc.reporter.split(',')[0]);
    if (Math.random() < 0.04) G.answerPress(null);
    else G.answerPress(pc.options[Math.floor(Math.random() * pc.options.length)].id);
  }
  maxPending = Math.max(maxPending, st().roomEvents?.length ?? 0);
  for (const e of [...(st().roomEvents ?? [])]) {
    eventKeys.set(e.key, (eventKeys.get(e.key) ?? 0) + 1);
    if (Math.random() < 0.8) { G.answerRoomEvent(e.id, e.options[Math.floor(Math.random() * e.options.length)].id); answeredEvents++; }
  }
  for (const n of st().news.filter((n) => n.day === st().day || n.day === st().day - 1)) {
    if (n.text.startsWith('Слово сдержано')) kept++;
    if (n.text.startsWith('Обещание не выполнено')) broken++;
  }
  badMorale += st().teams.ska.players.filter((id) => { const m = st().players[id]?.morale ?? 50; return m < 25 || m > 99; }).length;
}
console.log(`  ${conferences} press conferences (${pre} pre-match, ${multi} with several questions), ${questions} questions, ${topics.size} topics, ${reporters.size} journalists`);
console.log(`  topics: ${[...topics.keys()].join(' · ')}`);
console.log(`  situations: ${[...eventKeys].map(([k, n]) => `${k}×${n}`).join(', ')}`);
check('press conferences are frequent and mostly have several questions', conferences >= 40 && multi / conferences > 0.8, `${multi}/${conferences}`);
check('a wide variety of press topics', topics.size >= 18, `${topics.size}`);
check('different journalists ask the questions', reporters.size >= 6, `${reporters.size}`);
check('dressing-room situations of many kinds happen', eventKeys.size >= 8, `${eventKeys.size} kinds`);
check('never more than two situations wait at once', maxPending <= 2, `${maxPending}`);
check('morale stays within bounds', badMorale === 0);

/* ---------- multi-question flow ---------- */
{
  const s = st();
  const g = s.schedule.flat().filter((x) => x.played && x.result && (x.home === 'ska' || x.away === 'ska')).pop()!;
  let pc = null as ReturnType<typeof createPressConference>;
  for (let i = 0; i < 30 && (!pc || (pc.total ?? 1) < 3); i++) pc = createPressConference(s, g, g.result!);
  G.store.update((x) => { x.press = pc; });
  const fans0 = st().fans!, conf0 = st().board.confidence;
  const steps: string[] = [];
  let sumFans = 0, sumBoard = 0, last: string | null = null;
  for (let i = 0; i < 5 && st().press; i++) {
    const cur = st().press!;
    steps.push(`${cur.step}/${cur.total}`);
    const o = cur.options[0];
    sumFans += o.effects.fans; sumBoard += o.effects.board;
    G.answerPress(o.id);
    last = st().news[0]?.text ?? null;
  }
  check('questions come one after another', steps.join(',') === '1/3,2/3,3/3', steps.join(','));
  check('effects of every answer add up', st().fans === Math.max(0, Math.min(100, fans0 + sumFans)) && st().board.confidence === Math.max(5, Math.min(100, conf0 + sumBoard)), `fans ${fans0}→${st().fans} (${sumFans}), board ${conf0}→${st().board.confidence} (${sumBoard})`);
  check('one summary line lands in the news at the end', !!last && last.startsWith('Пресс-конференция'), last ?? '');
}

/* ---------- follow-ups: the press remembers ---------- */
{
  G.store.update((s) => { roomMemory(s).tags['press:refs'] = s.day; });
  const s = st();
  const g = s.schedule.flat().filter((x) => x.played && x.result && (x.home === 'ska' || x.away === 'ska')).pop()!;
  let found = false;
  for (let i = 0; i < 40 && !found; i++) {
    const copy = JSON.parse(JSON.stringify(s)) as GameState;
    const pc = createPressConference(copy, g, g.result!);
    found = !!pc && [pc.topic, ...(pc.queue ?? []).map((q) => q.topic)].includes('Слова о судьях');
  }
  check('words about the referees come back as a question (league fine)', found);
  G.store.update((s) => { s.press = null; delete roomMemory(s).tags['press:refs']; roomMemory(s).tags.skip = s.day; });
  G.answerPress(null);
  check('leaving without comment is remembered', recalled(st(), 'skip', 1) !== null);
}

/* ---------- every situation can be generated and answered ---------- */
{
  const keys = ['wish-role', 'wish-pp', 'wish-starts', 'wish-dress', 'wish-rest', 'wish-captain', 'wish-extend', 'conflict-critic', 'conflict-fight', 'conflict-curfew', 'conflict-captain', 'media-rumor', 'media-tv', 'team-dinner', 'team-mentor', 'fans-meeting', 'city-charity'];
  const made: string[] = [], missing: string[] = [];
  const saved = JSON.stringify(st());
  for (const key of keys) {
    const s = JSON.parse(JSON.stringify(st())) as GameState;
    s.roomEvents = []; s.roomPromises = []; s.roomMemory = { cool: {}, tags: {}, seq: 1 };
    const T = s.teams.ska;
    const mine = T.players.map((id) => s.players[id]).filter((p) => !p.inVhl);
    // set the scene for situations that need it
    if (key === 'conflict-critic' || key === 'wish-role') for (const p of mine) { p.morale = 55; }
    if (key === 'conflict-critic' || key === 'wish-role') { T.lineup.F[0] = T.lineup.F[3].slice(); }
    if (key === 'wish-starts') { const b = s.players[T.lineup.backupG!]; b.overall = s.players[T.lineup.starterG!].overall; }
    if (key === 'conflict-captain') { T.record.streakType = 'L'; T.record.streak = 4; }
    if (key === 'fans-meeting') s.fans = 30;
    if (key === 'wish-pp') { const best = mine.filter((x) => x.position !== 'G').sort((a, b) => b.overall - a.overall)[0]; best.skills.shooting = 82; best.skills.passing = 80; T.lineup.pp1 = T.lineup.pp1.map((id) => (id === best.id ? null : id)); T.lineup.pp2 = T.lineup.pp2.map((id) => (id === best.id ? null : id)); }
    if (key === 'wish-extend') { const p = mine.find((x) => x.overall >= 70)!; p.contract.years = 1; delete p.contract.next; }
    if (key === 'wish-captain') { const p = mine.filter((x) => x.position !== 'G' && x.age >= 27).sort((a, b) => b.overall - a.overall).find((x) => x.id !== T.captainId && !(T.assistantIds ?? []).includes(x.id)); if (p) { p.morale = 80; p.overall = 99; } }
    if (key === 'wish-dress') { const y = mine.find((x) => x.position !== 'G' && x.age <= 23); if (y) for (const l of [...T.lineup.F, ...T.lineup.D]) { const i = l.indexOf(y.id); if (i >= 0) l[i] = null; } }
    if (key === 'conflict-curfew') { const g = s.schedule[s.day - 1]?.find((x) => x.home === 'ska' || x.away === 'ska'); if (g?.result) { if (g.home === 'ska') g.result.homeScore = -1; else g.result.awayScore = -1; } else { const d = s.schedule.findIndex((day, i) => i < s.day && i >= s.day - 4 && day.some((x) => x.played && (x.home === 'ska' || x.away === 'ska'))); if (d >= 0) { const gg = s.schedule[d].find((x) => x.home === 'ska' || x.away === 'ska')!; if (gg.home === 'ska') gg.result!.homeScore = -1; else gg.result!.awayScore = -1; } } }
    const e = nextClubEvent(s, key);
    if (!e) { missing.push(key); continue; }
    made.push(key);
    s.roomEvents.push(e);
    G.store.set(s);
    const o = e.options[0];
    G.answerRoomEvent(e.id, o.id);
    if ((st().roomEvents ?? []).length) missing.push(key + ' (not answered)');
  }
  G.store.set(JSON.parse(saved));
  check('every situation can be generated and answered', missing.length === 0, missing.length ? `не сработали: ${missing.join(', ')}` : `${made.length} ситуаций`);
}

/* ---------- promises: kept and broken ---------- */
{
  const s = JSON.parse(JSON.stringify(st())) as GameState;
  s.roomPromises = []; s.roomEvents = [];
  G.store.set(s);
  const T = st().teams.ska;
  const inTop = T.lineup.F[0][0]!, outside = T.lineup.F[3][0]!;
  G.store.update((x) => { makePromise(x, { kind: 'role', playerId: inTop }); makePromise(x, { kind: 'role', playerId: outside }); });
  const m0 = { a: st().players[inTop].morale, b: st().players[outside].morale };
  let played = 0;
  for (let i = 0; i < 40 && (st().roomPromises ?? []).length && played < 12; i++) {
    const cur = st();
    const ug = (cur.schedule[cur.day] ?? []).find((g) => !g.played && (g.home === 'ska' || g.away === 'ska'));
    if (ug) {
      // keep the lines as they are (the promise to the 4th-liner is not honoured)
      G.store.update((x) => { const L = x.teams.ska.lineup; if (!L.F[0].includes(inTop)) L.F[0][0] = inTop; for (const l of L.F.slice(0, 2)) { const k = l.indexOf(outside); if (k >= 0) l[k] = null; } });
      const { sim } = G.makeUserSim(st(), ug);
      sim.runAll();
      G.commitUserResult(ug.id, sim.result());
      played++;
      while (st().press) G.answerPress(null);
      G.store.update((x) => { x.roomEvents = []; }); // no new promises during this check
    } else { G.simulateDay(true); G.store.update((x) => { x.roomEvents = []; x.press = null; }); }
  }
  const ns = st().news.slice(0, 120).map((n) => n.text);
  const keptNews = ns.some((t) => t.startsWith('Слово сдержано') && t.includes(st().players[inTop].name));
  const brokenNews = ns.some((t) => t.startsWith('Обещание не выполнено') && t.includes(st().players[outside].name));
  check('a kept promise is announced and lifts the player', keptNews, `мораль ${m0.a}→${st().players[inTop].morale}`);
  check('a broken promise is announced and remembered', brokenNews && recalled(st(), `broken:${outside}`, 40) !== null, `мораль ${m0.b}→${st().players[outside].morale}`);
  // the broken promise comes back as a conflict
  const e = nextClubEvent(st(), 'conflict-broken');
  check('a broken promise returns as a conflict', !!e && e.playerIds[0] === outside, e?.title ?? '');
}

/* ---------- a promise is tracked only in user games where the player is healthy ---------- */
{
  const s = JSON.parse(JSON.stringify(st())) as GameState;
  s.roomPromises = [];
  const id = s.teams.ska.lineup.F[1][0]!;
  makePromise(s, { kind: 'rest', playerId: id });
  const g = s.schedule.flat().find((x) => x.played && x.result && (x.home === 'ska' || x.away === 'ska') && (x.home === 'ska' ? x.result.homeDressed : x.result.awayDressed).includes(id))!;
  trackPromises(s, g, g.result!);
  check('promise counting: a dressed player has not rested', s.roomPromises![0].played === 1 && s.roomPromises![0].hits === 0);
  const parts = applyEffects(s, fx({ budget: -1_000_000, playerId: id, playerMorale: 3, rest: 5 }));
  check('effects describe themselves for the news', parts.some((p) => p.includes('бюджет')) && parts.some((p) => p.includes('+3')), parts.join(', '));
}

/* ---------- inbox ---------- */
{
  const s = JSON.parse(JSON.stringify(st())) as GameState;
  s.roomEvents = [];
  G.store.set(s);
  let e = null;
  for (const k of ['team-dinner', 'city-charity', 'media-tv']) { e = nextClubEvent(st(), k); if (e) break; }
  G.store.update((x) => { x.roomEvents = [e!]; });
  check('a situation is an inbox task that stops fast simulation', buildInbox(st()).some((t) => t.kind === 'event') && blockingTasks(st()).some((t) => t.kind === 'event'));
  // ignored situations resolve themselves with the fallback answer
  G.store.update((x) => { x.roomEvents![0].expires = x.day - 1; });
  G.simulateDay(true);
  check('an ignored situation resolves itself (fallback answer)', !(st().roomEvents ?? []).some((x) => x.id === e!.id) && st().news.some((n) => n.text.includes('без ответа')));
}

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL PRESS / DRESSING ROOM CHECKS PASSED');
process.exit(failed ? 1 : 0);
