import type { GameState, OffseasonPlan, YouthTrainingPlan } from '../types';
import { buildSchedule } from './schedule';
import { formatMoney, isDefense, isGoalie, payroll, salaryDemand } from './ratings';
import { autoLineup, byOvr, clearTradeCache, groupOf, lineupConstraintsFor, sanitizeLineup } from './ai';
import { emptyRecord, emptyStats } from './defaults';
import { addNews } from './state';
import { maxYears } from './contracts';
import { setBoardGoal } from './board';
import { countRosterLegionnaires, isLegionnaire, teamForeignLimit } from './legionnaires';
import { getPlayerPlan, isYouthPlayer, progressPlayerWithTraining, recommendYouthPlan } from './training';

export function toFreeAgency(state: GameState, id: string) {
  const p = state.players[id];
  if (!p) return;
  if (p.teamId) {
    const t = state.teams[p.teamId];
    t.players = t.players.filter((x) => x !== id);
    const opts = lineupConstraintsFor(state, t.id);
    t.lineup = t.id === state.userTeamId ? sanitizeLineup(t.lineup, t.players, state.players, opts) : autoLineup(t.players, state.players, opts);
  }
  p.teamId = null;
  p.contract = { salary: 0, years: 0 };
  delete p.tradeFlag;
  delete p.talks;
  if (!state.freeAgents.includes(id)) state.freeAgents.push(id);
  clearTradeCache();
}

const aiYears = (age: number) => 1 + Math.floor(Math.random() * Math.min(3, maxYears(age)));

export function startOffseason(state: GameState): OffseasonPlan {
  const P = state.players;
  const progressions: { id: string; from: number; to: number; plan?: YouthTrainingPlan }[] = [];
  for (const id in P) {
    const p = P[id];
    const wasYouth = isYouthPlayer(p);
    const planUsed = wasYouth ? getPlayerPlan(p).id : undefined;
    const from = p.overall;
    progressPlayerWithTraining(p);
    if (isYouthPlayer(p) && !p.trainingPlan) p.trainingPlan = recommendYouthPlan(p);
    if (p.teamId && p.overall !== from) {
      progressions.push({ id, from, to: p.overall, plan: planUsed });
    }
    const c = p.contract;
    c.years = Math.max(0, c.years - 1);
    // an extension signed during the season takes over when the old deal runs out
    if (c.years === 0 && c.next) p.contract = { salary: c.next.salary, years: c.next.years };
    delete p.talks;
  }
  const cap = state.league.salaryCap;
  const expiring: string[] = [];
  for (const t of Object.values(state.teams)) {
    t.deadCap = 0;
    t.capViolationDays = 0;
    t.capViolationGames = 0;
    t.capFinesTotal = 0;
    if (t.id === state.userTeamId) {
      for (const id of t.players) if (P[id].contract.years === 0) expiring.push(id);
      continue;
    }
    const fl = teamForeignLimit(t, state.league.foreignLimit);
    for (const id of [...t.players]) {
      const p = P[id];
      if (p.contract.years !== 0) continue;
      const salary = salaryDemand(p.overall, p.age, p.potential);
      const legAfter = countRosterLegionnaires(t.players, P);
      const overLeg = fl !== null && isLegionnaire(p) && legAfter > fl;
      if (!overLeg && Math.random() < 0.78 && payroll(t.players, P) + salary <= cap) {
        p.contract = { salary, years: aiYears(p.age) };
      } else {
        toFreeAgency(state, id);
      }
    }
  }
  clearTradeCache();
  return { expiring, progressions, revenue: 0 };
}

export function letGoUser(state: GameState, id: string) {
  const p = state.players[id];
  toFreeAgency(state, id);
  if (state.offseason) state.offseason.expiring = state.offseason.expiring.filter((x) => x !== id);
  if (p) addNews(state, 'trade', `${p.name} покидает ${state.teams[state.userTeamId].name} как свободный агент`, state.userTeamId);
}

function fillRoster(state: GameState, t: GameState['teams'][string]) {
  const P = state.players;
  const cap = state.league.salaryCap;
  const fl = teamForeignLimit(t, state.league.foreignLimit);
  const need = (g: string, min: number) => {
    let n = t.players.filter((id) => groupOf(P[id]) === g).length;
    while (n < min) {
      const curLeg = countRosterLegionnaires(t.players, P);
      const best = state.freeAgents
        .map((id) => P[id])
        .filter((p) => p && groupOf(p) === g && (fl === null || !isLegionnaire(p) || curLeg < fl))
        .sort(byOvr)[0];
      if (!best) break;
      const salary = salaryDemand(best.overall, best.age, best.potential);
      if (t.players.length >= 18 && payroll(t.players, P) + salary > cap) break;
      best.contract = { salary, years: aiYears(best.age) };
      best.teamId = t.id;
      t.players.push(best.id);
      state.freeAgents = state.freeAgents.filter((x) => x !== best.id);
      n++;
    }
  };
  need('F', 12);
  need('D', 6);
  need('G', 2);
}

function nextSeasonLabel(s: string): string {
  const m = /^(\d{4})\/(\d{2})$/.exec(s);
  if (!m) return s + ' • 2';
  const y = parseInt(m[1], 10) + 1;
  return `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
}

export function beginNewSeason(state: GameState) {
  const plan = state.offseason;
  if (plan) for (const id of [...plan.expiring]) toFreeAgency(state, id);
  const user = state.teams[state.userTeamId];
  for (const t of Object.values(state.teams)) if (t.id !== user.id) fillRoster(state, t);
  const P = state.players;
  for (const id in P) {
    const p = P[id];
    if (p.stats.gp || p.history.length) p.history.push({ season: state.league.season, teamId: p.teamId, overall: p.overall, gp: p.stats.gp, goals: p.stats.goals, assists: p.stats.assists, wins: p.stats.wins, shutouts: p.stats.shutouts });
    p.stats = emptyStats();
    p.injury = null;
    delete p.seasonGrowth;
    p.morale = 70 + Math.round(Math.random() * 10);
    delete p.talks;
  }
  state.seasonNumber += 1;
  state.league.season = nextSeasonLabel(state.league.season);
  for (const t of Object.values(state.teams)) {
    t.record = emptyRecord();
    t.seed = null;
    t.deadCap = 0;
    t.capViolationDays = 0;
    t.capViolationGames = 0;
    t.capFinesTotal = 0;
    const opts = lineupConstraintsFor(state, t.id);
    t.lineup = t.id === user.id ? sanitizeLineup(t.lineup, t.players, P, opts) : autoLineup(t.players, P, opts);
  }
  const { days, nextId } = buildSchedule(state.teamOrder, state.league.gamesPerTeam, 1, state.league.season);
  state.schedule = days;
  state.day = 0;
  state.nextGameId = nextId;
  state.phase = 'season';
  state.playoffs = null;
  state.offseason = null;
  state.offers = [];
  state.deadlinePassed = false;
  state.announcedWindows = [];
  clearTradeCache();
  setBoardGoal(state);
  const fs = user.players.filter((id) => groupOf(P[id]) === 'F').length;
  const ds = user.players.filter((id) => isDefense(P[id])).length;
  const gs = user.players.filter((id) => isGoalie(P[id])).length;
  addNews(state, 'info', `Стартует сезон ${state.league.season}. Состав ${user.name}: ${fs} нападающих, ${ds} защитников, ${gs} вратаря. ФОТ: ${formatMoney(payroll(user.players, P))}. Задача руководства: ${state.board.text.toLowerCase()}.`, user.id);
}
