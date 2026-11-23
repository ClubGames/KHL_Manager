// npx tsx scripts/coaching-test.tsx — deterministic staff, crisis, engine and save integration checks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GameState } from '../src/types';
import { parseRosterText } from '../src/game/roster';
import * as G from '../src/game/state';
import { coachingEffects, coachHireCost, changeTeamFocus, ensureCoachingState, ensureTeamManagement, fireCoach, hireCoach, interveneTeam, recentTeamForm, stepTeamManagement, recordCoachingResult } from '../src/game/coaching';
import { REAL_STAFF, defaultStaff } from '../src/game/coachData';
import { beginNewSeason } from '../src/game/offseason';
import { stepYouthTrainingWeek } from '../src/game/training';
import { getCapSummary } from '../src/game/cap';
import { Coaching, StaffSummary } from '../src/components/Coaching';
import { Dashboard } from '../src/components/Dashboard';
import { UIContext } from '../src/components/ui';

const rosterText = readFileSync('roster.json', 'utf8');
const fresh = () => G.createGameState(parseRosterText(rosterText), 'ska');
const copy = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const user = (s: GameState) => s.teams[s.userTeamId];
let checks = 0;
function test(name: string, fn: () => void) { fn(); checks++; console.log(`ok ${name}`); }
const seeded = <T,>(seed: number, fn: () => T): T => {
  const old = Math.random; let n = seed;
  Math.random = () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n / 4294967296; };
  try { return fn(); } finally { Math.random = old; }
};

test('22 real starting staffs and editable roster entries; real available market is separate', () => {
  const s = fresh(); assert.equal(Object.keys(REAL_STAFF).length, 22);
  const raw = JSON.parse(rosterText);
  for (const id of s.teamOrder) {
    assert.equal(s.teams[id].coaches?.length, 2);
    const entries = raw.teams.find((t: { id: string }) => t.id === id).coaches;
    assert.deepEqual(entries, defaultStaff(id).map((c, i) => ({ ...entries[i], ...c })));
    assert.deepEqual(s.teams[id].coaches!.map((c) => c.name), REAL_STAFF[id].slice(0, 2));
    assert.ok(s.teams[id].coaches!.every((c) => c.source && !c.fictional && c.snapshot === '2026/27 · 23.11.2026'));
  }
  assert.equal(s.coachMarket?.length, 6); assert.ok(s.coachMarket!.every((c) => !c.fictional && c.source));
});
test('autumn appointments, interim status and existing historical saves', () => {
  const s = fresh();
  assert.equal(s.teams.ska.coaches![0].name, 'Андрей Разин');
  assert.equal(s.teams['metallurg-mg'].coaches![0].name, 'Константин Шафранов');
  assert.equal(s.teams.lada.coaches![0].name, 'Игорь Горбенко');
  assert.equal(s.teams['dinamo-msk'].coaches![0].acting, true);
  assert.ok(!s.teams['dinamo-msk'].coaches![1].acting);
  Object.assign(user(s).coaches![0], { name: 'Игорь Ларионов', snapshot: '2025/26' });
  const before = copy(user(s).coaches);
  G.migrateState(s); G.migrateState(s);
  assert.deepEqual(user(s).coaches, before);
});
test('custom staff overrides and defensive normalisation', () => {
  const r = JSON.parse(rosterText);
  r.teams[0].coaches = [{ role: 'head', name: 'Мой тренер', profile: 'defense', attack: 200, salary: -10 }];
  const team = parseRosterText(JSON.stringify(r)).teams[0];
  assert.equal(team.coaches![0].name, 'Мой тренер'); assert.equal(team.coaches![0].attack, 95);
  assert.equal(team.coaches![0].salary, 0); assert.equal(team.coaches![0].fictional, true);
  assert.equal(team.coaches![1].role, 'assistant');
  team.coaches = null as never; team.management = { load: NaN, focus: '__proto__' } as never;
  ensureTeamManagement(team); assert.equal(team.management.focus, 'balanced'); assert.equal(team.management.load, 20);
});
test('legacy migration is idempotent and preserves hired staff, market and decisions', () => {
  const s = fresh(); for (const t of Object.values(s.teams)) { delete t.coaches; delete t.management; } delete s.coachMarket;
  assert.ok(G.migrateState(s)); assert.equal(user(s).coaches?.[0].name, 'Андрей Разин');
  const candidate = s.coachMarket![0];
  assert.equal(hireCoach(s, candidate.id, 'assistant'), null); changeTeamFocus(s, 'recovery'); interveneTeam(s, 'bonding');
  const saved = JSON.stringify({ staff: user(s).coaches, m: user(s).management, market: s.coachMarket });
  G.migrateState(s); G.migrateState(s);
  assert.equal(JSON.stringify({ staff: user(s).coaches, m: user(s).management, market: s.coachMarket }), saved);
  const snapshot = G.migrateState(copy(G.snapshot(s)))!;
  assert.deepEqual(snapshot.teams.ska.management, user(s).management);
  assert.deepEqual(snapshot.coachMarket, s.coachMarket);
});
test('atomic hire, compensation, correct role, no cap charge or magical morale boost', () => {
  const s = fresh(); const t = user(s); const before = t.budget; const cap = getCapSummary(s, t.id).totalPayroll;
  const morale = t.players.map((id) => s.players[id].morale); const old = t.coaches![0];
  const c = s.coachMarket!.find((c) => c.role === 'head' && c.profile === 'attack')!;
  const cost = coachHireCost(t, c);
  assert.equal(hireCoach(s, c.id), null); assert.equal(t.budget, before - cost);
  assert.equal(t.coaches![0].id, c.id); assert.equal(t.management!.familiarity, 40);
  assert.ok(s.coachMarket!.some((c) => c.id === old.id)); assert.ok(!s.coachMarket!.some((item) => item.id === c.id));
  assert.deepEqual(t.players.map((id) => s.players[id].morale), morale);
  assert.equal(getCapSummary(s, t.id).totalPayroll, cap);
  assert.ok(hireCoach(s, old.id)); assert.equal(t.budget, before - cost);
  ensureCoachingState(s); assert.equal(t.coaches![0].fictional, false); assert.ok(t.coaches![0].source);
  const assistant = s.coachMarket![0];
  assert.equal(hireCoach(s, assistant.id, 'assistant'), null); assert.equal(t.coaches![0].id, c.id); assert.equal(t.coaches![1].id, assistant.id);
  t.budget = 0; t.management!.staffCooldown.head = 0; const unchanged = copy(t.coaches);
  assert.ok(hireCoach(s, old.id)); assert.deepEqual(t.coaches, unchanged);
  assert.ok(hireCoach(s, 'missing'));
});
test('focus ramps up, changing focus resets preparation and does not advance time', () => {
  const s = fresh(); const t = user(s); const base = coachingEffects(t, s.players);
  assert.equal(changeTeamFocus(s, 'attack'), null); assert.equal(t.management!.focusDays, 0);
  assert.equal(coachingEffects(t, s.players).attack, base.attack);
  stepTeamManagement(s, 3); const attack = coachingEffects(t, s.players);
  assert.ok(attack.attack > base.attack + 2.9); assert.ok(attack.defense < base.defense - 0.9);
  changeTeamFocus(s, 'defense'); assert.equal(t.management!.focusDays, 0);
  stepTeamManagement(s, 3); assert.ok(coachingEffects(t, s.players).defense > base.defense + 2.9);
  const days = t.management!.focusDays; changeTeamFocus(s, 'defense'); assert.equal(t.management!.focusDays, days);
  assert.equal(s.day, 0);
});
test('rest reduces load, extra goalie fatigue, and daily staff pay uses actual calendar days', () => {
  const s = fresh(); const t = user(s); t.management!.load = 80; changeTeamFocus(s, 'recovery');
  const goalie = s.players[t.lineup.starterG!]; goalie.fatigue = 50;
  const budget = t.budget; const salary = t.coaches!.reduce((sum, c) => sum + c.salary, 0);
  stepTeamManagement(s, 3); assert.equal(t.management!.load, 53); assert.equal(goalie.fatigue, 44);
  assert.equal(t.budget, budget - Math.round(salary / 365 * 3));
  const before = coachingEffects(t, s.players); t.management!.load = 100;
  assert.ok(coachingEffects(t, s.players).attack < before.attack);
  const load = t.management!.load; coachingEffects(t, s.players); coachingEffects(t, s.players); assert.equal(t.management!.load, load);
});
test('meetings have shared persistent cooldown, costs, tradeoffs and trust gate', () => {
  const s = fresh(); const t = user(s); const pid = t.players[0]; s.players[pid].morale = 50;
  assert.equal(interveneTeam(s, 'support'), null); assert.equal(s.players[pid].morale, 55);
  assert.equal(t.management!.meetingCooldown, 14); const budget = t.budget;
  assert.ok(interveneTeam(s, 'bonding')); assert.equal(t.budget, budget);
  stepTeamManagement(s, 14); t.management!.trust = 44; assert.ok(interveneTeam(s, 'demand'));
  assert.equal(t.management!.meetingCooldown, 0); t.management!.trust = 65;
  assert.equal(interveneTeam(s, 'demand'), null); assert.equal(s.players[pid].morale, 51); assert.equal(t.management!.disciplineDays, 7);
  stepTeamManagement(s, 7); assert.equal(t.management!.disciplineDays, 0);
  stepTeamManagement(s, 7); const before = t.budget; const cohesion = t.management!.cohesion;
  assert.equal(interveneTeam(s, 'bonding'), null); assert.equal(t.budget, before - 3_000_000); assert.equal(t.management!.cohesion, cohesion + 6);
  t.management!.meetingCooldown = 0; s.phase = 'offseason'; assert.ok(interveneTeam(s, 'support'));
});
test('results alter trust and load; diagnosis uses last 8 real games, including OT losses', () => {
  const s = fresh(); const t = user(s); const trust = t.management!.trust;
  for (let i = 0; i < 7; i++) recordCoachingResult(t, false);
  assert.ok(t.management!.trust < trust); assert.ok(t.management!.load > 50);
  const games = s.schedule.flat().filter((g) => g.home === t.id || g.away === t.id).slice(0, 8);
  for (const [i, g] of games.entries()) {
    const win = i === 0; g.played = true;
    g.result = { homeScore: g.home === t.id ? (win ? 3 : 1) : (win ? 1 : 2), awayScore: g.home === t.id ? (win ? 1 : 2) : (win ? 3 : 1), ot: true } as never;
  }
  const form = recentTeamForm(s, t.id); assert.equal(form.wins, 1); assert.equal(form.losses, 7); assert.equal(form.crisis, true);
});
test('live match gets exact displayed modifiers; engine and quick simulation use them', () => {
  const s = fresh(); const t = user(s); const g = s.schedule.flat().find((g) => g.home === t.id || g.away === t.id)!;
  changeTeamFocus(s, 'attack'); stepTeamManagement(s, 3);
  const { sim } = G.makeUserSim(s, g); const side = g.home === t.id ? sim.home : sim.away;
  assert.deepEqual(side.coaching, coachingEffects(t, s.players));
  const neutral = { ...sim.home, coaching: { attack: 0, defense: 0, special: 0, development: 1, goalie: 0 } };
  const run = (bonus: number) => seeded(773, () => {
    const Engine = sim.constructor as typeof import('../src/game/engine').GameSim;
    const e = new Engine({ ...neutral, coaching: { ...neutral.coaching, attack: bonus, defense: bonus } }, sim.away, s.players);
    e.quiet = true; return e.runAll();
  });
  assert.notDeepEqual(run(8), run(-8));
  G.store.set(s); while (G.store.get()!.day < g.day) G.simulateDay(true);
  G.simulateDay(true); assert.ok(G.store.get()!.schedule[g.day].find((item) => item.id === g.id)?.played);
});
test('staff development changes actual weekly U23 XP', () => {
  const a = fresh(); const t = user(a); const p = a.players[t.players.find((id) => a.players[id].position !== 'G')!];
  p.age = 19; p.injury = null; p.trainingXp = 0; p.potential = p.overall + 4;
  t.coaches = t.coaches!.map((c) => ({ ...c, development: 40 })); const b = copy(a);
  user(b).coaches = user(b).coaches!.map((c) => ({ ...c, development: 95 }));
  seeded(100, () => stepYouthTrainingWeek(a)); seeded(100, () => stepYouthTrainingWeek(b));
  assert.ok((b.players[p.id].trainingXp ?? 0) > (a.players[p.id].trainingXp ?? 0));
});
test('new season retains staff and market, while summer clears load and cooldowns', () => {
  const s = fresh(); const id = s.coachMarket![0].id; hireCoach(s, id); const staff = copy(user(s).coaches); const market = copy(s.coachMarket);
  beginNewSeason(s); assert.deepEqual(user(s).coaches, staff); assert.deepEqual(s.coachMarket, market);
  assert.equal(user(s).management!.load, 10); assert.equal(user(s).management!.staffCooldown.head, 0);
});
test('SSR staff, market, focus controls and dashboard navigation render for old saves too', () => {
  const s = fresh(); G.store.set(s);
  const context = { openPlayer() {}, openGame() {}, confirm() {}, nav() {}, tradeWith() {}, negotiate() {} };
  const render = (component: React.ReactNode) => renderToStaticMarkup(<UIContext.Provider value={context}>{component}</UIContext.Provider>);
  const html = render(<Coaching />); assert.ok(html.includes('Андрей Разин')); assert.ok(html.includes('Подготовка и раздевалка')); assert.ok(html.includes('Рынок тренеров'));
  assert.ok(html.includes('Илья Воробьёв')); assert.ok(!html.includes('Имена — справочный срез')); assert.ok(html.includes('Должность при подписании'));
  assert.ok(render(<StaffSummary team={s.teams.avangard} />).includes('Ги Буше'));
  assert.ok(render(<StaffSummary team={s.teams['dinamo-msk']} />).includes('И. о. главного тренера'));
  assert.ok(render(<Dashboard onPlay={() => {}} />).includes('Управление командой'));
});

test('dismissal promotes assistant once, survives save and permits immediate permanent appointment', () => {
  const s = fresh(), t = user(s), assistant = t.coaches!.find(c => c.role === 'assistant')!, head = t.coaches![0];
  const budget = t.budget;
  assert.equal(fireCoach(s, 'head'), null);
  assert.equal(t.budget, budget - head.salary * .5);
  assert.equal(t.coaches!.length, 1); assert.equal(t.coaches![0].id, assistant.id);
  assert.equal(t.coaches![0].acting, true); assert.equal(t.coaches![0].actingFromAssistant, true);
  assert.ok(s.coachMarket!.some(c => c.id === head.id));
  ensureCoachingState(s); ensureCoachingState(s);
  assert.equal(t.coaches!.length, 1);
  const saved = G.migrateState(copy(G.snapshot(s)))!;
  assert.equal(saved.teams.ska.coaches!.length, 1); assert.equal(saved.teams.ska.coaches![0].acting, true);
  assert.ok(fireCoach(s, 'head')); // Cannot dismiss the only acting head without a replacement.
  const candidate = s.coachMarket![0]; const cost = candidate.salary * .25;
  const before = t.budget;
  assert.equal(hireCoach(s, candidate.id, 'head'), null);
  assert.equal(t.budget, before - cost); assert.ok(!t.coaches![0].acting);
  assert.equal(t.coaches!.find(c => c.role === 'assistant')!.id, assistant.id);
  assert.ok(!s.coachMarket!.some(c => c.id === assistant.id));
});
test('either appointment role, assistant vacancy and new assistant during interim are persistent', () => {
  const s = fresh(), t = user(s), oldAssistant = t.coaches![1];
  assert.equal(fireCoach(s, 'assistant'), null); ensureCoachingState(s);
  assert.equal(t.coaches!.length, 1); assert.ok(fireCoach(s, 'head'));
  assert.equal(hireCoach(s, oldAssistant.id, 'assistant'), null);
  assert.equal(fireCoach(s, 'head'), null);
  const nextAssistant = s.coachMarket![0];
  assert.equal(hireCoach(s, nextAssistant.id, 'assistant'), null);
  const nextHead = s.coachMarket!.find(c => c.id !== oldAssistant.id)!;
  assert.equal(hireCoach(s, nextHead.id, 'head'), null);
  assert.equal(t.coaches!.find(c => c.role === 'assistant')!.id, nextAssistant.id);
  assert.ok(s.coachMarket!.some(c => c.id === oldAssistant.id));
  const before = copy(t.coaches); ensureCoachingState(s); assert.deepEqual(t.coaches, before);
});
test('market migration removes legacy fictional offers, preserves old hires and excludes duplicate real names', () => {
  const s = fresh(), t = user(s);
  delete s.coachMarketVersion;
  t.coaches![0] = { ...t.coaches![0], id: 'generated-head-attack', name: 'Старый нанятый тренер', fictional: true };
  s.coachMarket = [{ ...s.coachMarket![0], id: 'generated-assistant-defense', name: 'Вымышленный свободный' }, { ...s.coachMarket![1], id: 'duplicate-id', name: t.coaches![1].name }];
  ensureCoachingState(s);
  assert.equal(t.coaches![0].name, 'Старый нанятый тренер');
  assert.ok(!s.coachMarket!.some(c => c.id.startsWith('generated-') || c.name === t.coaches![1].name));
  const before = copy(s.coachMarket); ensureCoachingState(s); assert.deepEqual(s.coachMarket, before);
});

G.store.set(null);
console.log(`PASS: ${checks} coaching checks`);
