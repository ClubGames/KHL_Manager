import { BY_FIRST, BY_LAST, INTL, JUNIOR_SCHOOL_ABROAD, JUNIOR_SCHOOL_BY, JUNIOR_SCHOOL_KZ, JUNIOR_SCHOOLS, KZ_FIRST, KZ_LAST, RU_FIRST, RU_LAST } from './fictionalNames';
import type { DraftPickRecord, DraftProspectMeta, GameState, HallOfFameEntry, JuniorDraftState, Player, PosCode, Skills, Team } from '../types';
import { clamp, computeOverall, isDefense, isForward, isGoalie } from './ratings';
import { emptyStats } from './defaults';
import { isLegionnaire } from './legionnaires';
import { recommendYouthPlan } from './training';
import { scoutingMaxSpread } from './medical';
import { activeKhlCount, MAX_VHL_PLAYERS, vhlCount } from './khlRules';
import { LG } from '../brand';

/** KHL young-player extra match roster limit ("лимитчик" U20, domestic/EAEU skater). */
export const U20_MAX_AGE = 20;

export function isU20Limiter(p: Player | null | undefined): boolean {
  return !!p && p.age <= U20_MAX_AGE && !isGoalie(p) && !isLegionnaire(p) && !p.inVhl;
}

export function isU20ForwardLimiter(p: Player | null | undefined): boolean {
  return isU20Limiter(p) && isForward(p!);
}

export function isU20DefenseLimiter(p: Player | null | undefined): boolean {
  return isU20Limiter(p) && isDefense(p!);
}

/* ---------------- Veteran Retirements & Hall of Fame ---------------- */

function careerTotals(p: Player, season?: string) {
  // The finished season may already be in the history (retirements happen after it is recorded).
  const live = p.history[p.history.length - 1]?.season === season ? null : p.stats;
  let gp = live?.gp ?? 0;
  let goals = live?.goals ?? 0;
  let assists = live?.assists ?? 0;
  let wins = live?.wins ?? 0;
  let shutouts = live?.shutouts ?? 0;
  let peakOvr = p.overall;
  for (const h of p.history) {
    gp += h.gp;
    goals += h.goals;
    assists += h.assists;
    wins += h.wins;
    shutouts += h.shutouts;
    if (h.overall > peakOvr) peakOvr = h.overall;
  }
  return { gp, goals, assists, wins, shutouts, peakOvr };
}

export function shouldVeteranRetire(p: Player): boolean {
  if (p.age < 35) return false;
  if (p.age >= 42) return true;
  let chance =
    p.age === 35 ? 0.11 :
    p.age === 36 ? 0.22 :
    p.age === 37 ? 0.36 :
    p.age === 38 ? 0.52 :
    p.age === 39 ? 0.68 :
    p.age === 40 ? 0.82 : 0.92;

  if (p.overall >= 82 && p.age <= 37) chance *= 0.4;
  else if (p.overall <= 67) chance += 0.2;
  if (!p.teamId) chance += 0.22;
  return Math.random() < clamp(chance, 0.03, 0.98);
}

export function buildHallOfFameEntry(state: GameState, p: Player, forceJersey = false): HallOfFameEntry {
  const tot = careerTotals(p, state.league.season);
  const lastTeamId = p.teamId ?? ([...p.history].reverse().find((h) => h.teamId)?.teamId ?? null);
  const teamName = lastTeamId && state.teams[lastTeamId] ? state.teams[lastTeamId].name : LG();
  const jerseyRetired =
    forceJersey ||
    tot.peakOvr >= 82 ||
    (lastTeamId === state.userTeamId && tot.peakOvr >= 78) ||
    tot.goals + tot.assists >= 120 ||
    tot.wins >= 60;
  return {
    id: p.id,
    name: p.name,
    position: p.position,
    number: p.number,
    teamId: lastTeamId,
    teamName,
    retiredSeason: state.league.season,
    age: p.age,
    peakOverall: tot.peakOvr,
    gp: tot.gp,
    goals: tot.goals,
    assists: tot.assists,
    wins: tot.wins,
    shutouts: tot.shutouts,
    jerseyRetired,
  };
}

/**
 * Process veteran retirements at the start of the offseason.
 * Inducts club/league legends into `state.hallOfFame` and prunes retired players from active maps to keep saves small.
 */
export function processVeteranRetirements(
  state: GameState,
  onNews: (text: string, teamId?: string) => void
): HallOfFameEntry[] {
  state.hallOfFame ??= [];
  const retiredThisYear: HallOfFameEntry[] = [];
  const P = state.players;

  for (const id of Object.keys(P)) {
    const p = P[id];
    if (!p) continue;
    // Also prune low-overall unsigned 33+ free agents so the FA pool never bloats over 10+ seasons
    if (!p.teamId && p.age >= 33 && p.overall <= 66 && Math.random() < 0.65) {
      state.freeAgents = state.freeAgents.filter((x) => x !== id);
      delete P[id];
      continue;
    }
    if (!shouldVeteranRetire(p)) continue;

    const tot = careerTotals(p, state.league.season);
    const isUserPlayer = p.teamId === state.userTeamId;
    const notable = isUserPlayer || tot.peakOvr >= 77 || tot.gp >= 90 || tot.goals + tot.assists >= 65 || tot.wins >= 35;
    const entry = buildHallOfFameEntry(state, p);

    if (notable) {
      state.hallOfFame.unshift(entry);
      retiredThisYear.push(entry);
      if (isUserPlayer || tot.peakOvr >= 81) {
        const banner = entry.jerseyRetired ? ` Свитер №${p.number} поднят под своды арены!` : '';
        onNews(
          `Завершение карьеры: ${p.name} (${p.age} л., «${entry.teamName}») повесил коньки на гвоздь.${banner}`,
          isUserPlayer ? state.userTeamId : (entry.teamId ?? undefined)
        );
      }
    }

    if (p.teamId && state.teams[p.teamId]) {
      const t = state.teams[p.teamId];
      t.players = t.players.filter((x) => x !== id);
      if (t.captainId === id) t.captainId = null;
      if (t.assistantIds) t.assistantIds = t.assistantIds.filter((x) => x !== id);
    }
    state.freeAgents = state.freeAgents.filter((x) => x !== id);
    delete P[id];
  }

  if (state.hallOfFame.length > 80) state.hallOfFame.length = 80;
  return retiredThisYear;
}

/* ---------------- MHL Graduation & KHL Junior Draft ---------------- */

// invented names and junior clubs only (src/game/fictionalNames.ts)
const INT_NAMES = Object.entries(INTL);

function randInt(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
function pickArr<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function makeYouthSkills(pos: PosCode, baseOvr: number, archetypeRoll: number): Skills {
  const j = () => randInt(-4, 4);
  if (pos === 'G') {
    return {
      reflexes: clamp(baseOvr + j() + (archetypeRoll < 0.5 ? 3 : 0), 48, 88),
      positioning: clamp(baseOvr + j() + (archetypeRoll >= 0.5 ? 3 : 0), 48, 88),
      reboundControl: clamp(baseOvr + j(), 48, 86),
      puckHandling: clamp(baseOvr - 5 + j(), 42, 82),
      endurance: clamp(baseOvr - 2 + j(), 48, 85),
    };
  }
  if (pos === 'D') {
    const offD = archetypeRoll < 0.38;
    return {
      skating: clamp(baseOvr + j() + (offD ? 4 : 0), 50, 88),
      shooting: clamp(baseOvr - 5 + j() + (offD ? 5 : -3), 45, 85),
      passing: clamp(baseOvr + j() + (offD ? 4 : -2), 48, 88),
      puckControl: clamp(baseOvr + j() + (offD ? 4 : -3), 48, 88),
      checking: clamp(baseOvr + j() + (offD ? -2 : 5), 48, 88),
      defense: clamp(baseOvr + 2 + j() + (offD ? -2 : 5), 50, 90),
    };
  }
  const sniper = archetypeRoll < 0.34;
  const playmaker = !sniper && archetypeRoll < 0.68;
  return {
    skating: clamp(baseOvr + 2 + j(), 52, 90),
    shooting: clamp(baseOvr + j() + (sniper ? 6 : playmaker ? -2 : 0), 48, 90),
    passing: clamp(baseOvr + j() + (playmaker ? 6 : sniper ? -1 : 1), 48, 90),
    puckControl: clamp(baseOvr + j() + (sniper || playmaker ? 4 : 0), 48, 90),
    checking: clamp(baseOvr - 3 + j() + (!sniper && !playmaker ? 5 : 0), 44, 86),
    defense: clamp(baseOvr - 3 + j() + (!sniper && !playmaker ? 6 : -2), 44, 86),
  };
}

function rookieSalary(ovr: number, pot: number): number {
  const raw = ovr >= 70 ? 12_000_000 : ovr >= 66 ? 7_500_000 : pot >= 85 ? 6_000_000 : 3_500_000;
  return Math.round(raw / 500_000) * 500_000;
}

/**
 * Generate a 52-player KHL Junior Draft / MHL Academy class and reverse-standings 2-round draft state.
 */
export function createJuniorDraft(state: GameState, orderWorstFirst: string[]): JuniorDraftState {
  const count = Math.max(48, orderWorstFirst.length * 2 + 8);
  const usedNames = new Set(Object.values(state.players).map((p) => p.name));
  const prospects: DraftProspectMeta[] = [];
  const positions: PosCode[] = ['C', 'LW', 'RW', 'D', 'D', 'C', 'LW', 'RW', 'D', 'G'];
  const userClub = state.teams[state.userTeamId];
  const userScouting = userClub?.facilities?.scouting ?? 1;
  const userAcademy = userClub?.facilities?.academy ?? 1;
  const maxSpread = scoutingMaxSpread(userScouting);

  for (let i = 0; i < count; i++) {
    const pos = positions[i % positions.length];
    let country = 'Россия';
    let school = pickArr(JUNIOR_SCHOOLS);
    let first = RU_FIRST, last = RU_LAST;
    const natRoll = Math.random();
    if (natRoll < 0.86 && natRoll >= 0.77) {
      country = 'Беларусь';
      school = JUNIOR_SCHOOL_BY;
      [first, last] = [BY_FIRST, BY_LAST];
    } else if (natRoll >= 0.86 && natRoll < 0.94) {
      country = 'Казахстан';
      school = JUNIOR_SCHOOL_KZ;
      [first, last] = [KZ_FIRST, KZ_LAST];
    } else if (natRoll >= 0.94) {
      const [land, pool] = pickArr(INT_NAMES);
      country = land;
      [first, last] = [pool.first, pool.last];
      school = JUNIOR_SCHOOL_ABROAD;
    }
    let name = `${pickArr(first)} ${pickArr(last)}`;
    for (let t = 0; usedNames.has(name) && t < 30; t++) name = `${pickArr(first)} ${pickArr(last)}`;
    if (usedNames.has(name)) name = `${name} мл.`;
    usedNames.add(name);

    const age = i < 10 ? randInt(17, 18) : randInt(17, 19);
    // Top of the class has franchise blue-chips; middle has solid KHL regulars & sleepers
    let baseOvr: number;
    let pot: number;
    let tag: DraftProspectMeta['tag'];
    if (i < 5) {
      baseOvr = randInt(67, 73);
      pot = randInt(85, 92);
      tag = 'Топ-проспект';
    } else if (i < 16) {
      baseOvr = randInt(64, 70);
      pot = randInt(80, 87);
      tag = baseOvr >= 68 ? 'Готов к КХЛ' : 'Топ-проспект';
    } else if (i % 7 === 0) {
      baseOvr = randInt(59, 64);
      pot = randInt(81, 88);
      tag = 'Тёмная лошадка';
    } else {
      baseOvr = randInt(60, 67);
      pot = randInt(74, 83);
      tag = baseOvr >= 66 ? 'Готов к КХЛ' : 'Выпускник МХЛ';
    }
    pot = Math.max(pot, baseOvr + 4);

    const skills = makeYouthSkills(pos, baseOvr, Math.random());
    const id = `jr-s${state.seasonNumber + 1}-${i + 1}-${Math.random().toString(36).slice(2, 6)}`;
    const player: Player = {
      id,
      name,
      position: pos,
      age,
      height: pos === 'D' ? randInt(183, 196) : pos === 'G' ? randInt(184, 195) : randInt(176, 192),
      weight: pos === 'D' ? randInt(82, 96) : randInt(75, 91),
      number: randInt(11, 97),
      country,
      hand: Math.random() < 0.68 ? 'L' : 'R',
      overall: 60,
      potential: pot,
      skills,
      contract: { salary: 0, years: 0 },
      injury: null,
      morale: randInt(74, 86),
      teamId: null,
      stats: emptyStats(),
      history: [],
    };
    if (userClub && userAcademy >= 2 && (i === 6 || i === 18)) {
      school = `Академия «${userClub.name}»`;
      pot = clamp(pot + (userAcademy - 1), 72, 94);
    }
    player.overall = computeOverall(player);
    player.potential = Math.max(pot, player.overall + 3);
    player.trainingPlan = recommendYouthPlan(player);
    state.players[id] = player;

    const loDelta = randInt(Math.min(1, maxSpread), maxSpread);
    const hiDelta = randInt(Math.min(1, maxSpread), maxSpread);
    const fuzzLo = clamp(player.potential - loDelta, player.overall, 95);
    const fuzzHi = clamp(player.potential + hiDelta, fuzzLo + Math.min(2, maxSpread), 96);
    const score = player.overall * 0.55 + player.potential * 0.45;
    const grade = score >= 78 ? 'A+' : score >= 74 ? 'A' : score >= 70 ? 'B+' : score >= 67 ? 'B' : 'C+';

    prospects.push({
      id,
      tag,
      grade,
      potRange: [fuzzLo, fuzzHi],
      school,
    });
  }

  // Sort prospects roughly by scouted value with slight realistic variance
  prospects.sort((a, b) => {
    const pa = state.players[a.id];
    const pb = state.players[b.id];
    const va = pa.overall * 0.52 + pa.potential * 0.48;
    const vb = pb.overall * 0.52 + pb.potential * 0.48;
    return vb - va;
  });

  const draft: JuniorDraftState = {
    rounds: 2,
    pickIndex: 0,
    order: orderWorstFirst,
    prospects,
    picks: [],
    completed: false,
  };
  advanceAiDraftToUser(state, draft);
  return draft;
}

export function currentDraftTeamId(draft: JuniorDraftState): string | null {
  const totalPicks = draft.rounds * draft.order.length;
  if (draft.completed || draft.pickIndex >= totalPicks || draft.prospects.length === 0) return null;
  return draft.order[draft.pickIndex % draft.order.length];
}

function chooseProspectForClub(state: GameState, team: Team, draft: JuniorDraftState): DraftProspectMeta | null {
  if (!draft.prospects.length) return null;
  const P = state.players;
  const gCount = team.players.filter((id) => P[id] && isGoalie(P[id])).length;
  const dCount = team.players.filter((id) => P[id] && isDefense(P[id])).length;
  const needG = gCount < 2;
  const needD = dCount < 6;
  const russianClub = !['barys', 'dinamo-mn', 'shanghai-dragons', 'kunlun', 'dynamo-riga'].includes(team.id);

  let best = draft.prospects[0];
  let bestScore = -1e9;
  for (let i = 0; i < Math.min(12, draft.prospects.length); i++) {
    const pr = draft.prospects[i];
    const p = P[pr.id];
    if (!p) continue;
    let sc = p.overall * 0.55 + p.potential * 0.48;
    if (isGoalie(p) && !needG && gCount >= 3) sc -= 8;
    if (isGoalie(p) && needG) sc += 5;
    if (isDefense(p) && needD) sc += 3;
    if (russianClub && isLegionnaire(p)) sc -= 4;
    if (sc > bestScore) {
      bestScore = sc;
      best = pr;
    }
  }
  return best;
}

export function executeSingleDraftPick(state: GameState, draft: JuniorDraftState, prospectId?: string): DraftPickRecord | null {
  const teamId = currentDraftTeamId(draft);
  if (!teamId) {
    draft.completed = true;
    return null;
  }
  const team = state.teams[teamId];
  const meta =
    (prospectId ? draft.prospects.find((x) => x.id === prospectId) : null) ??
    chooseProspectForClub(state, team, draft);
  if (!meta) {
    draft.completed = true;
    return null;
  }
  const p = state.players[meta.id];
  const round = Math.floor(draft.pickIndex / draft.order.length) + 1;
  const overallPick = draft.pickIndex + 1;

  draft.prospects = draft.prospects.filter((x) => x.id !== meta.id);
  draft.pickIndex += 1;

  if (p && team) {
    const sal = rookieSalary(p.overall, p.potential);
    p.contract = { salary: sal, years: 3, twoWay: true };
    p.rightsTeamId = team.id;
    const curKhl = activeKhlCount(team.players, state.players);
    const curVhl = vhlCount(team.players, state.players);
    if (curKhl < 30) {
      p.teamId = team.id;
      p.inVhl = curKhl >= 23 && p.overall < 67 && curVhl < MAX_VHL_PLAYERS;
      team.players.push(p.id);
    } else if (curVhl < MAX_VHL_PLAYERS) {
      p.teamId = team.id;
      p.inVhl = true;
      team.players.push(p.id);
    } else {
      // Both KHL (30) and VHL (10) rosters are full: club retains RFA sports rights
      p.teamId = null;
      if (!state.freeAgents.includes(p.id)) state.freeAgents.push(p.id);
    }
  }

  const rec: DraftPickRecord = { overallPick, round, teamId, playerId: meta.id };
  draft.picks.push(rec);

  if (draft.pickIndex >= draft.rounds * draft.order.length || draft.prospects.length === 0) {
    finalizeRemainingDraftProspects(state, draft);
  }
  return rec;
}

export function advanceAiDraftToUser(state: GameState, draft: JuniorDraftState) {
  let guard = 0;
  while (!draft.completed && guard++ < 200) {
    const tid = currentDraftTeamId(draft);
    if (!tid || tid === state.userTeamId) break;
    executeSingleDraftPick(state, draft);
  }
}

export function finalizeRemainingDraftProspects(state: GameState, draft: JuniorDraftState) {
  draft.completed = true;
  // Top few undrafted prospects enter FA pool; discard surplus low-tier generated entries to keep save lean
  const rest = draft.prospects.splice(0, draft.prospects.length);
  for (let i = 0; i < rest.length; i++) {
    const id = rest[i].id;
    const p = state.players[id];
    if (!p) continue;
    if (i < 6) {
      if (!state.freeAgents.includes(id)) state.freeAgents.push(id);
    } else if (!p.teamId) {
      delete state.players[id];
    }
  }
}

export function autoCompleteDraft(state: GameState, draft: JuniorDraftState | undefined) {
  if (!draft || draft.completed) return;
  let guard = 0;
  while (!draft.completed && guard++ < 200) {
    executeSingleDraftPick(state, draft);
  }
  if (!draft.completed) finalizeRemainingDraftProspects(state, draft);
}
