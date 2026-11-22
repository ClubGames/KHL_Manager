import type { GameState, OffseasonPlan, YouthTrainingPlan } from '../types';
import { buildSchedule } from './schedule';
import { formatMoney, isDefense, isGoalie, payroll, salaryDemand } from './ratings';
import { autoLineup, byOvr, clearTradeCache, groupOf, lineupConstraintsFor, sanitizeLineup } from './ai';
import { defaultTactics, emptyRecord, emptyStats } from './defaults';
import { addNews, compareTeams } from './state';
import { maxYears } from './contracts';
import { setBoardGoal } from './board';
import { countRosterLegionnaires, isLegionnaire, teamForeignLimit } from './legionnaires';
import { getPlayerPlan, isYouthPlayer, progressPlayerWithTraining, recommendYouthPlan } from './training';
import { ensureCaptains } from './chemistry';
import { autoCompleteDraft, createJuniorDraft, processVeteranRetirements } from './dynasty';
import { activeKhlCount, isRfaEligibleAge, maybeGenerateAiRfaOffer } from './khlRules';

export function toFreeAgency(state: GameState, id: string, keepRightsTeamId?: string | null) {
  const p = state.players[id];
  if (!p) return;
  if (p.teamId) {
    const t = state.teams[p.teamId];
    t.players = t.players.filter((x) => x !== id);
    ensureCaptains(t, state.players);
    const opts = lineupConstraintsFor(state, t.id);
    t.lineup = t.id === state.userTeamId ? sanitizeLineup(t.lineup, t.players, state.players, opts) : autoLineup(t.players, state.players, opts);
  }
  p.teamId = null;
  p.inVhl = false;
  p.inLtir = false;
  p.playingThroughInjury = false;
  p.nmc = false;
  p.rightsTeamId = keepRightsTeamId && isRfaEligibleAge(p.age) ? keepRightsTeamId : null;
  p.contract = { salary: 0, years: 0 };
  delete p.tradeFlag;
  delete p.talks;
  if (!state.freeAgents.includes(id)) state.freeAgents.push(id);
  clearTradeCache();
}

const aiYears = (age: number) => 1 + Math.floor(Math.random() * Math.min(3, maxYears(age)));

function recordSeasonHistoryOnce(state: GameState) {
  const P = state.players;
  const curSeason = state.league.season;
  for (const id in P) {
    const p = P[id];
    if (!p) continue;
    const last = p.history[p.history.length - 1];
    if ((p.stats.gp || p.history.length) && last?.season !== curSeason) {
      p.history.push({
        season: curSeason,
        teamId: p.teamId,
        overall: p.overall,
        gp: p.stats.gp,
        goals: p.stats.goals,
        assists: p.stats.assists,
        wins: p.stats.wins,
        shutouts: p.stats.shutouts,
      });
    }
  }
}

export function startOffseason(state: GameState): OffseasonPlan {
  recordSeasonHistoryOnce(state);
  state.waivers = [];
  state.rfaOffers = [];

  // 1. Veteran retirements & Hall of Fame inductions
  const retired = processVeteranRetirements(state, (txt, tid) => addNews(state, 'milestone', txt, tid));

  // 2. Age & develop all active players
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
    p.fatigue = 0;
    if (p.teamId !== state.userTeamId && p.inVhl) {
      const club = p.teamId ? state.teams[p.teamId] : null;
      if (club && activeKhlCount(club.players, P) < 30) p.inVhl = false;
    }
    const c = p.contract;
    c.years = Math.max(0, c.years - 1);
    if (c.years === 0 && c.next) {
      p.contract = { salary: c.next.salary, years: c.next.years, ...(c.next.twoWay !== undefined ? { twoWay: c.next.twoWay } : {}) };
    }
    delete p.talks;
  }

  // 3. Expiring contracts & RFA rights
  const cap = state.league.salaryCap;
  const expiring: string[] = [];
  for (const t of Object.values(state.teams)) {
    t.deadCap = 0;
    t.capViolationDays = 0;
    t.capViolationGames = 0;
    t.capFinesTotal = 0;
    t.roadStreak = 0;
    if (t.id === state.userTeamId) {
      for (const id of t.players) {
        if (P[id] && P[id].contract.years === 0) {
          if (isRfaEligibleAge(P[id].age)) P[id].rightsTeamId = t.id;
          expiring.push(id);
        }
      }
      ensureCaptains(t, P);
      continue;
    }
    const fl = teamForeignLimit(t, state.league.foreignLimit);
    for (const id of [...t.players]) {
      const p = P[id];
      if (!p || p.contract.years !== 0) continue;
      const salary = salaryDemand(p.overall, p.age, p.potential);
      const legAfter = countRosterLegionnaires(t.players, P);
      const overLeg = fl !== null && isLegionnaire(p) && legAfter > fl;
      if (!overLeg && Math.random() < 0.78 && payroll(t.players, P) + salary <= cap) {
        p.contract = { salary, years: aiYears(p.age) };
        if (p.age >= 29 && p.overall >= 85 && p.contract.years >= 2) p.nmc = true;
      } else {
        const keepRfa = isRfaEligibleAge(p.age) && p.overall >= 70 ? t.id : null;
        toFreeAgency(state, id, keepRfa);
      }
    }
    ensureCaptains(t, P);
  }

  // 4. Reverse-standings KHL Junior Draft & MHL Academy Graduation
  const orderWorstFirst = [...state.teamOrder].sort((a, b) => compareTeams(state.teams[b], state.teams[a]));
  const draft = createJuniorDraft(state, orderWorstFirst);
  addNews(
    state,
    'info',
    `Открыта Ярмарка юниоров КХЛ и выпуск академий МХЛ (${draft.rounds} раунда): выберите молодых игроков 17–19 лет в разделе «Межсезонье».`,
    state.userTeamId
  );

  clearTradeCache();
  return { expiring, progressions, revenue: 0, retired, draft };
}

export function letGoUser(state: GameState, id: string) {
  const p = state.players[id];
  toFreeAgency(state, id, null);
  if (state.offseason) state.offseason.expiring = state.offseason.expiring.filter((x) => x !== id);
  if (p) addNews(state, 'trade', `${p.name} покидает ${state.teams[state.userTeamId].name} как неограниченно свободный агент`, state.userTeamId);
}

export function qualifyUserRfa(state: GameState, id: string): string | null {
  const p = state.players[id];
  const U = state.userTeamId;
  if (!p || p.teamId !== U) return 'Игрок не найден';
  if (!isRfaEligibleAge(p.age)) return `${p.name} достиг 28 лет и имеет статус НСА`;
  toFreeAgency(state, id, U);
  if (state.offseason) state.offseason.expiring = state.offseason.expiring.filter((x) => x !== id);
  addNews(
    state,
    'trade',
    `«${state.teams[U].name}» сделала квалификационное предложение ${p.name} (ОСА) и закрепила спортивные права в КХЛ.`,
    U
  );
  // Chance of an incoming AI offer sheet on qualified RFAs
  if (Math.random() < 0.45) {
    const nextId = (state.rfaOffers?.length ?? 0) + Date.now();
    const sheet = maybeGenerateAiRfaOffer(state, nextId);
    if (sheet) {
      state.rfaOffers ??= [];
      state.rfaOffers.push(sheet);
      const from = state.teams[sheet.fromTeamId];
      addNews(
        state,
        'offer',
        `ОФФЕРШИТ КХЛ: «${from.name}» предложил вашему ОСА ${state.players[sheet.playerId].name} контракт ${formatMoney(sheet.salary)} × ${sheet.years} г. Повторите предложение или получите компенсацию ${formatMoney(sheet.compensation)}!`,
        U
      );
    }
  }
  return null;
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
        .filter(
          (p) =>
            p &&
            groupOf(p) === g &&
            (!p.rightsTeamId || p.rightsTeamId === t.id || p.rightsTeamId !== state.userTeamId) &&
            (fl === null || !isLegionnaire(p) || curLeg < fl)
        )
        .sort(byOvr)[0];
      if (!best) break;
      const salary = salaryDemand(best.overall, best.age, best.potential);
      if (t.players.length >= 18 && payroll(t.players, P) + salary > cap) break;
      best.contract = { salary, years: aiYears(best.age) };
      best.teamId = t.id;
      best.rightsTeamId = isRfaEligibleAge(best.age) ? t.id : null;
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
  if (plan?.draft && !plan.draft.completed) {
    autoCompleteDraft(state, plan.draft);
  }
  if (plan) {
    for (const id of [...plan.expiring]) {
      const p = state.players[id];
      const keepRights = p && isRfaEligibleAge(p.age) ? state.userTeamId : null;
      toFreeAgency(state, id, keepRights);
    }
  }
  recordSeasonHistoryOnce(state);

  const user = state.teams[state.userTeamId];
  for (const t of Object.values(state.teams)) if (t.id !== user.id) fillRoster(state, t);
  const P = state.players;
  for (const id in P) {
    const p = P[id];
    p.stats = emptyStats();
    p.injury = null;
    p.inLtir = false;
    p.playingThroughInjury = false;
    p.fatigue = 0;
    delete p.seasonGrowth;
    p.morale = 70 + Math.round(Math.random() * 10);
    delete p.talks;
  }
  state.seasonNumber += 1;
  state.league.season = nextSeasonLabel(state.league.season);
  state.waivers = [];
  state.rfaOffers = [];
  state.allStar = null;

  for (const t of Object.values(state.teams)) {
    t.record = emptyRecord();
    t.seed = null;
    t.deadCap = 0;
    t.capViolationDays = 0;
    t.capViolationGames = 0;
    t.capFinesTotal = 0;
    t.roadStreak = 0;
    t.seasonGateRevenue = 0;
    t.tactics ??= defaultTactics();
    ensureCaptains(t, P);
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
  addNews(
    state,
    'info',
    `Стартует сезон ${state.league.season}. Состав ${user.name}: ${fs} нападающих, ${ds} защитников, ${gs} вратаря. ФОТ: ${formatMoney(payroll(user.players, P))}. Задача руководства: ${state.board.text.toLowerCase()}.`,
    user.id
  );
}
