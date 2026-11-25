import { isApp, saveFile } from '../platform';
import { creditGame, ensureSeasonSplits } from './careerStats';
import { adoptRosterCoachMarket, changeTeamFocus, ensureCoachingState, fireCoach, hireCoach, interveneTeam, recordCoachingResult, stepTeamManagement } from './coaching';
import type { Coach, CoachPitch, PlayerPitch, TeamFocus, TeamIntervention } from '../types';
import { useSyncExternalStore } from 'react';
import type { Award, FacilityKey, Game, GameResult, GameState, Lineup, NewsItem, NewsType, Series, Team, TeamTactics, YouthTrainingPlan } from '../types';
import { buildSchedule, isWeekendDay, regularSeasonLength, seasonDateObj } from './schedule';
import { GameSim } from './engine';
import { buildSimTeam } from './simTeam';
import { assignScout, cancelScout, ensureScouting, scoutGame, stepScouting } from './scouting';
import { answerPressConference, createPrePressConference, createPressConference, fanGateMult } from './press';
import { answerClubEvent, stepDressingRoom, trackPromises } from './dressingRoom';
import { autoFinishPreseason, createPreseason, playPreseasonRound, preseasonTable } from './preseason';
import { blockingTasks, dismissInboxTask } from './inbox';
import { autoLineup, clubSideProblem, ensureTradeBlock, evaluateTrade, formatTradeCash, shopTradeBlock, executeTrade, tradeShapeProblem, groupOf, lineupConstraintsFor, MAX_ROSTER, maybeAiTrade, maybeIncomingOffer, prepareLineup, sanitizeLineup, tradeWindow, userSideProblem } from './ai';
import { buyoutCost, commitments, negotiate, talksKey, talksLeft, type Verdict } from './contracts';
import { bonusKindsFor, bonusText, sanitizeBonuses, settleBonuses } from './bonuses';
import { checkPromises, coachContractFrom, coachTalks, evaluateCoachOffer, pitchCoach, pitchPlayer, type CoachTerms, type CoachVerdict, type OfferExtras } from './negotiation';
import { evaluateBoard, setBoardGoal } from './board';
import { beginNewSeason, letGoUser, qualifyUserRfa, startOffseason, toFreeAgency } from './offseason';
import { clamp, formatMoney, isDefense, isGoalie, isSkater, payroll, points } from './ratings';
import { emptyLineup, emptyRecord } from './defaults';
import type { NormalizedRoster } from './roster';
import { careerMod, loadModRoster } from './mods';
import { GAME_NAME_RU, LG, setCurrentLeague } from '../brand';
import { clearLegacy, deleteSave, getBackend, listMetas, readLegacy, readSave, storageError, writeSave } from './storage';
import type { SaveMeta } from './storage';
import { buyoutDeadCap, CAP_GAMES_PER_POINT_DEDUCTION, CAP_GRACE_DAYS, capExcess, dailyCapFine, effectivePayroll, getCapSummary, recomputePoints } from './cap';
import { countRosterLegionnaires, DEFAULT_FOREIGN_LIMIT, isLegionnaire, teamForeignLimit } from './legionnaires';
import { isYouthPlayer, recommendYouthPlan, stepYouthTrainingWeek } from './training';
import { assignTeamRole, ensureCaptains, getTeamTactics, goalieFreshness, recordLineupChemistryGP } from './chemistry';
import { advanceAiDraftToUser, autoCompleteDraft, currentDraftTeamId, executeSingleDraftPick } from './dynasty';
import { activeKhlCount, aiShouldMatchOfferSheet, canHaveNmc, canSignTwoWay, isOnWaivers, isRfaEligibleAge, isWaiverExempt, MAX_VHL_PLAYERS, offerSheetCompensation, processDailyWaivers, vhlPlayerCapRelief, WAIVER_DAYS } from './khlRules';
import { getDerby, isFarEastClub } from './derbies';
import { upgradeLegacyClubColors } from './clubColors';
import {
  allStarTargetDay,
  canPlaceInLtir,
  canPlayThroughInjury,
  computeHomeGateRevenue,
  ensureFacilities,
  FACILITY_META,
  facilityUpgradeCost,
  formatInjuryDays,
  injuryReturnDate,
  LTIR_MIN_DAYS,
  medicalDurationMult,
  medicalGoalieRestRecovery,
  medicalRiskMult,
  normalizeInjury,
  PLAY_THROUGH_MAX_DAYS,
  rollInjury,
  severityOfDays,
  simulateAllStarWeekend,
} from './medical';

const SAVE_VERSION = 2;
const LEGACY_ID = 'legacy-v1';

export type { SaveMeta };
export interface SaveStatus {
  state: 'idle' | 'saving' | 'saved' | 'error';
  at: number;
  error?: string;
}

class Store {
  private state: GameState | null = null;
  private listeners = new Set<() => void>();
  private statusListeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private status: SaveStatus = { state: 'idle', at: 0 };
  get = (): GameState | null => this.state;
  getStatus = (): SaveStatus => this.status;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  subscribeStatus = (l: () => void) => {
    this.statusListeners.add(l);
    return () => {
      this.statusListeners.delete(l);
    };
  };
  private emit() {
    for (const l of this.listeners) l();
  }
  private setStatus(s: SaveStatus) {
    this.status = s;
    for (const l of this.statusListeners) l();
  }
  update(fn: (s: GameState) => void) {
    if (!this.state) return;
    fn(this.state);
    this.state = { ...this.state };
    setCurrentLeague(this.state.league?.name);
    this.emit();
    this.scheduleSave();
  }
  /** Replace the active career (or close it with null). Call flush() first if the current one must be kept. */
  set(s: GameState | null) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.state = s;
    setCurrentLeague(s?.league?.name);
    this.emit();
    if (s) this.scheduleSave();
    else this.setStatus({ state: 'idle', at: 0 });
  }
  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, 500);
  }
  /** Write the active career to its slot right now. Resolves to false if the write failed. */
  saveNow(): Promise<boolean> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const captured = this.state;
    if (!captured) return this.queue.then(() => true);
    this.setStatus({ state: 'saving', at: Date.now() });
    const job = this.queue.then(async () => {
      // Writes are serialized; take the freshest state of the same career at the moment the write starts.
      const cur = this.state && this.state.saveId === captured.saveId ? this.state : captured;
      try {
        await writeSave(buildMeta(cur), snapshot(cur));
        this.setStatus({ state: 'saved', at: Date.now() });
        return true;
      } catch (e) {
        this.setStatus({ state: 'error', at: Date.now(), error: storageError(e) });
        return false;
      }
    });
    this.queue = job.then(() => undefined);
    return job;
  }
  /** Finish any pending or running write. */
  flush(): Promise<boolean> {
    if (this.saveTimer) return this.saveNow();
    return this.queue.then(() => this.status.state !== 'error');
  }
}

export const store = new Store();
export const useGame = (): GameState | null => useSyncExternalStore(store.subscribe, store.get, store.get);
export const useSaveStatus = (): SaveStatus => useSyncExternalStore(store.subscribeStatus, store.getStatus, store.getStatus);

if (typeof window !== 'undefined') {
  // Best effort: do not lose the last half-second of changes when the tab is hidden or closed.
  window.addEventListener('pagehide', () => void store.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void store.flush();
  });
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Copy of the state that is written to disk: play-by-play and per-skater game lines are dropped (kept only in memory); shotMap is retained only on recent user matches. */
export function snapshot(s: GameState): GameState {
  const U = s.userTeamId;
  const userPlayedIds: number[] = [];
  for (const day of s.schedule) {
    for (const g of day) {
      if (g.played && g.result?.shotMap && (g.home === U || g.away === U)) userPlayedIds.push(g.id);
    }
  }
  const keepShots = new Set(userPlayedIds.slice(-12));
  return {
    ...s,
    schedule: s.schedule.map((day) =>
      day.map((g) => {
        const r = g.result;
        if (!r) return g;
        const lines: GameResult['lines'] = {};
        for (const gid of [r.homeGoalie, r.awayGoalie]) if (gid && r.lines[gid]) lines[gid] = r.lines[gid];
        const shotMap = keepShots.has(g.id) ? r.shotMap : undefined;
        return { ...g, result: { ...r, events: [], homeDressed: [], awayDressed: [], lines, shotMap } };
      })
    ),
  };
}

export function buildMeta(s: GameState): SaveMeta {
  const U = s.teams[s.userTeamId];
  const r = U.record;
  return {
    id: s.saveId,
    name: s.saveName,
    teamId: U.id,
    teamName: U.name,
    teamShort: U.short,
    city: U.city,
    primaryColor: U.primaryColor,
    secondaryColor: U.secondaryColor,
    ...(U.logo ? { logo: U.logo } : {}),
    league: s.league.name,
    ...(s.mod?.name ? { mod: s.mod.name } : {}),
    season: s.league.season,
    seasonNumber: s.seasonNumber,
    phase: s.phase,
    day: s.day,
    totalDays: s.schedule.length,
    gp: r.gp,
    gamesPerTeam: s.league.gamesPerTeam,
    wins: r.w + r.otw + r.sow,
    losses: r.l + r.otl + r.sol,
    points: r.points,
    place: rankConference(s, U.conference).indexOf(U) + 1,
    conference: U.conference,
    trophies: s.trophies.length,
    createdAt: s.createdAt,
    updatedAt: Date.now(),
  };
}

/** Validate a loaded/imported save and bring it up to the current format. Returns null if it is not a save. */
export function migrateState(raw: unknown): GameState | null {
  const s = raw as GameState | null;
  if (!s || typeof s !== 'object' || !s.teams || !s.players || !Array.isArray(s.schedule) || !Array.isArray(s.teamOrder)) return null;
  if (!s.userTeamId || !s.teams[s.userTeamId] || !s.league) return null;
  if (!s.saveId) s.saveId = LEGACY_ID;
  if (!s.saveName) s.saveName = s.teams[s.userTeamId].name;
  if (!s.createdAt) s.createdAt = Date.now();
  s.news ??= [];
  s.offers ??= [];
  s.trophies ??= [];
  s.summaries ??= [];
  s.freeAgents ??= [];
  s.offseason ??= null;
  s.playoffs ??= null;
  s.announcedWindows ??= [];
  s.hallOfFame ??= [];
  s.waivers ??= [];
  s.rfaOffers ??= [];
  s.allStar ??= null;
  s.fans ??= 60;
  s.press ??= null;
  s.roomEvents ??= [];
  s.roomPromises ??= [];
  s.preseason ??= null;
  s.inboxDismissed ??= {};
  ensureScouting(s);
  ensureTradeBlock(s);
  ensureCoachingState(s);
  s.league.foreignLimit ??= DEFAULT_FOREIGN_LIMIT;
  if (s.playoffs && !s.playoffs.awards) s.playoffs.awards = [];
  for (const p of Object.values(s.players)) {
    if (isYouthPlayer(p) && !p.trainingPlan) p.trainingPlan = recommendYouthPlan(p);
    p.fatigue ??= 0;
    p.injury = normalizeInjury(p.injury);
    if (!p.injury && s.phase === 'offseason') p.inLtir = false;
  }
  // Points are derived from the record (minus any salary-cap penalty deductions), so saves made under the old 3-point rule are converted automatically.
  for (const t of Object.values(s.teams)) {
    upgradeLegacyClubColors(t);
    if (t.id === 'shanghai-dragons' && t.short === 'ШАН') t.short = 'ШХД';
    t.deadCap ??= 0;
    t.capViolationDays ??= 0;
    t.capViolationGames ??= 0;
    t.capFinesTotal ??= 0;
    t.tactics = getTeamTactics(t);
    t.chemGP ??= {};
    t.roadStreak ??= 0;
    t.seasonGateRevenue ??= 0;
    ensureFacilities(t);
    ensureCaptains(t, s.players);
    const r = t.record;
    r.capPenaltyPoints ??= 0;
    r.points = recomputePoints(r);
  }
  for (const day of s.schedule)
    for (const g of day)
      if (g.result) {
        g.result.events ??= [];
        g.result.lines ??= {};
        g.result.homeDressed ??= [];
        g.result.awayDressed ??= [];
      }
  ensureSeasonSplits(s);
  if (!s.board) setBoardGoal(s);
  s.deadlinePassed ??= s.phase === 'season' && !tradeWindow(s).open;
  s.version = SAVE_VERSION;
  return s;
}

let newsId = 1;
export function addNews(state: GameState, type: NewsType, text: string, team?: string, game?: number) {
  state.news.unshift({ id: newsId++, day: state.day, type, text, team, game });
  if (state.news.length > 250) state.news.length = 250;
}

export function compareTeams(a: Team, b: Team): number {
  const ra = a.record;
  const rb = b.record;
  // points → regulation wins → wins in regulation and overtime → goal difference → goals scored
  return rb.points - ra.points || rb.w - ra.w || rb.w + rb.otw - (ra.w + ra.otw) || rb.gf - rb.ga - (ra.gf - ra.ga) || rb.gf - ra.gf;
}
export function rankConference(state: GameState, conf: string): Team[] {
  return state.teamOrder.map((id) => state.teams[id]).filter((t) => t.conference === conf).sort(compareTeams);
}
export function rankAll(state: GameState): Team[] {
  return state.teamOrder.map((id) => state.teams[id]).sort(compareTeams);
}
export const roundName = (r: number) => ['1/8 финала', '1/4 финала', 'Финал конференции', 'Финал Кубка Гагарина'][r] ?? 'Плей-офф';

export function createGameState(r: NormalizedRoster, userTeamId: string): GameState {
  setCurrentLeague(r.leagueName);
  const teamOrder = r.teams.map((t) => t.id);
  // the mod's schedule.json when it has one; otherwise the built-in generator (same calendar for the same roster)
  const { days, nextId } = r.schedule
    ? { days: r.schedule.days.map((d) => d.map((g) => ({ ...g }))), nextId: r.schedule.nextId }
    : buildSchedule(r.teams, r.gamesPerTeam, 1, r.season);
  const teams: Record<string, Team> = {};
  for (const t of r.teams) teams[t.id] = t;
  newsId = 1;
  const user = teams[userTeamId];
  const news: NewsItem[] = [{ id: newsId++, day: 0, type: 'info', text: `Вы назначены генеральным менеджером ${user.name}. Сезон ${r.season} начинается: ${r.gamesPerTeam} матчей регулярного чемпионата. Проверьте звенья и сыграйте первый матч.` }];
  const state = {
    version: SAVE_VERSION,
    saveId: newId(),
    saveName: user.name,
    createdAt: Date.now(),
    league: { name: r.leagueName, season: r.season, gamesPerTeam: r.gamesPerTeam, salaryCap: r.salaryCap, foreignLimit: r.foreignLimit },
    // careers from a hand-picked file don't follow any roster file afterwards
    mod: r.mod ? { ...r.mod } : { id: '', name: 'Свой файл', base: '.', roster: null },
    seasonNumber: 1,
    teams,
    teamOrder,
    players: r.players,
    freeAgents: r.freeAgents,
    // free coaches come from roster.json; the built-in list is only a fallback for files without `freeCoaches`
    ...(r.freeCoaches ? { coachMarket: r.freeCoaches.map((c) => ({ ...c })), coachMarketVersion: 2, coachMarketSource: 'roster' } : { coachMarketSource: 'builtin' }),
    facesSynced: true,
    splitsSeason: r.season,
    schedule: days,
    day: 0,
    nextGameId: nextId,
    userTeamId,
    phase: 'season',
    news,
    offers: [],
    playoffs: null,
    trophies: [],
    summaries: [],
    offseason: null,
    deadlinePassed: false,
    announcedWindows: ['autumn'],
    hallOfFame: [],
    waivers: [],
    rfaOffers: [],
    allStar: null,
    fans: 60,
    press: null,
    inboxDismissed: {},
  } as unknown as GameState;
  for (const t of Object.values(teams)) {
    ensureFacilities(t);
    t.seasonGateRevenue = 0;
  }
  ensureCoachingState(state);
  ensureScouting(state);
  ensureTradeBlock(state);
  setBoardGoal(state);
  state.preseason = createPreseason(state);
  news[0].text += ` Задача руководства на сезон: ${state.board.text.toLowerCase()}.`;
  const startPay = effectivePayroll(user, r.players, 'season');
  if (startPay > r.salaryCap) {
    addNews(
      state,
      'info',
      `ВНИМАНИЕ ${LG()}: ФОТ «${user.name}» превышает потолок зарплат (${formatMoney(startPay)} при лимите ${formatMoney(r.salaryCap)})! У вас есть ${CAP_GRACE_DAYS} игровых дней на разгрузку ведомости до блокировки контрактов, штрафов и снятия очков.`,
      userTeamId
    );
  }
  const fl = teamForeignLimit(user, r.foreignLimit);
  if (fl !== null) {
    const legs = countRosterLegionnaires(user.players, r.players);
    if (legs > fl) {
      addNews(state, 'info', `Регламент ${LG()}: в составе «${user.name}» ${legs} легионеров при лимите ${fl} на матч — лишние легионеры останутся вне заявки до обмена.`, userTeamId);
    }
  }
  return state;
}

/* ---------------- careers & save slots ---------------- */
/** Replace the built-in free-coach list of an older career with roster.json `freeCoaches` (no-op if the file has none). */
export async function syncCoachMarketFromRoster(saveId: string, url?: string) {
  const cur = store.get();
  if (!cur || cur.saveId !== saveId || cur.coachMarketSource === 'roster') return;
  const mod = careerMod(cur);
  if (!url && !mod.roster) return;
  try {
    const r = await loadModRoster(url ? { base: '.', roster: url } : mod);
    if (!r.freeCoaches) return;
    store.update((s) => {
      if (s.saveId === saveId) adoptRosterCoachMarket(s, r.freeCoaches!);
    });
  } catch {
    /* roster.json unavailable (offline / opened from file): keep the saved market */
  }
}

/** Player fields that follow roster.json in an existing career (matched by player id). */
export const ROSTER_SYNC_FIELDS = ['name', 'number', 'country', 'face', 'hand'] as const;
export type RosterSyncField = (typeof ROSTER_SYNC_FIELDS)[number];

/**
 * Bring a saved career in line with roster.json, player by player **by id**: if the file has a different name,
 * jersey number, nationality or photo for that id, the save takes the file's value (a photo removed from the file is
 * removed from the save). Players the file does not know (draft picks, generated juniors) are left alone.
 * The stick hand follows too, but only from a file that really lists hands (at least one «R»): a file without
 * `hand` reads as all-«L», and that must not flatten the hands a career already has.
 * Coach photos follow the file by coach name (case, extra spaces and ё/е are ignored). Returns how many fields changed.
 */
export function adoptRosterUpdates(s: GameState, r: Pick<NormalizedRoster, 'players' | 'teams' | 'freeCoaches'>): number {
  let n = 0;
  const fileHasHands = Object.values(r.players).some((p) => p.hand === 'R');
  for (const p of Object.values(s.players)) {
    const src = r.players[p.id];
    if (!src) continue;
    if (src.name && src.name !== p.name) { p.name = src.name; n++; }
    if (fileHasHands && (src.hand === 'L' || src.hand === 'R') && src.hand !== p.hand) { p.hand = src.hand; n++; }
    if (Number.isFinite(src.number) && src.number !== p.number) { p.number = src.number; n++; }
    if (src.country && src.country !== p.country) { p.country = src.country; n++; }
    if ((src.face ?? '') !== (p.face ?? '')) {
      if (src.face) p.face = src.face;
      else delete p.face;
      n++;
    }
  }
  const coachKey = (name: string) => name.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
  const coachFaces = new Map<string, string>();
  for (const t of r.teams) for (const c of t.coaches ?? []) coachFaces.set(coachKey(c.name), c.face ?? '');
  for (const c of r.freeCoaches ?? []) coachFaces.set(coachKey(c.name), c.face ?? '');
  const fill = (c: Coach) => {
    const f = coachFaces.get(coachKey(c.name));
    if (f === undefined || f === (c.face ?? '')) return;
    if (f) c.face = f;
    else delete c.face;
    n++;
  };
  for (const t of Object.values(s.teams)) (t.coaches ?? []).forEach(fill);
  (s.coachMarket ?? []).forEach(fill);
  s.facesSynced = true;
  return n;
}
/** @deprecated kept for older callers — same as {@link adoptRosterUpdates}. */
export const adoptRosterFaces = adoptRosterUpdates;

/**
 * Re-read roster.json every time a career is opened, so edits to names, numbers, nationality, photos and hands reach
 * existing saves. The state is only touched (and re-saved) when something actually changed.
 */
export async function syncPlayersFromRoster(saveId: string, url?: string): Promise<number> {
  const cur = store.get();
  if (!cur || cur.saveId !== saveId) return 0;
  // the roster file of the career's mod (careers saved before mods existed follow mods/KHL_2627)
  const mod = careerMod(cur);
  if (!url && !mod.roster) return 0;
  try {
    const r = await loadModRoster(url ? { base: '.', roster: url } : mod);
    const now = store.get();
    if (!now || now.saveId !== saveId) return 0;
    // dry run on copies of the objects that can change
    const probe = {
      players: Object.fromEntries(Object.entries(now.players).map(([k, p]) => [k, { ...p }])),
      teams: Object.fromEntries(Object.entries(now.teams).map(([k, t]) => [k, { ...t, coaches: (t.coaches ?? []).map((c) => ({ ...c })) }])),
      coachMarket: (now.coachMarket ?? []).map((c) => ({ ...c })),
    } as unknown as GameState;
    if (!adoptRosterUpdates(probe, r)) return 0;
    let n = 0;
    store.update((s) => {
      if (s.saveId === saveId) n = adoptRosterUpdates(s, r);
    });
    return n;
  } catch {
    /* roster.json unavailable (offline / opened from file): keep the saved data */
    return 0;
  }
}
/** @deprecated same as {@link syncPlayersFromRoster}. */
export const syncFacesFromRoster = syncPlayersFromRoster;

export async function startNewGame(r: NormalizedRoster, userTeamId: string) {
  await store.flush();
  store.set(createGameState(r, userTeamId));
  void store.saveNow();
}

/** Every saved career, newest first. Also adopts the single save written by the first version of the game. */
export async function listSaves(): Promise<SaveMeta[]> {
  const legacy = readLegacy();
  if (legacy) {
    let st: GameState | null = null;
    try {
      st = migrateState(JSON.parse(legacy));
    } catch {
      st = null;
    }
    try {
      if (st) {
        st.saveId = LEGACY_ID;
        await writeSave(buildMeta(st), snapshot(st));
      }
      clearLegacy();
    } catch {
      /* keep the legacy save in place and retry next time */
    }
  }
  const metas = await listMetas();
  return metas.map((m) => {
    const upgraded = upgradeLegacyClubColors({
      id: m.teamId,
      name: m.teamName,
      short: m.teamShort,
      primaryColor: m.primaryColor,
      secondaryColor: m.secondaryColor,
    });
    return {
      ...m,
      teamShort: m.teamId === 'shanghai-dragons' && m.teamShort === 'ШАН' ? 'ШХД' : m.teamShort,
      primaryColor: upgraded.primaryColor,
      secondaryColor: upgraded.secondaryColor,
    };
  });
}

/** The requested career as plain data: the live one if it is open, otherwise read from its slot. */
async function getCareer(id: string): Promise<GameState | null> {
  const cur = store.get();
  if (cur && cur.saveId === id) return snapshot(cur);
  const st = migrateState(await readSave(id));
  if (st) st.saveId = id;
  return st;
}

/** Open a saved career. Returns an error message, or null on success. */
export async function loadCareer(id: string): Promise<string | null> {
  try {
    await store.flush();
    const st = migrateState(await readSave(id));
    if (!st) return 'Сохранение не найдено или повреждено';
    st.saveId = id;
    newsId = Math.max(0, ...st.news.map((n) => n.id)) + 1;
    store.set(st);
    return null;
  } catch (e) {
    return storageError(e);
  }
}

/** Save and close the active career. */
export async function exitToMenu() {
  await store.flush();
  store.set(null);
}

export const saveNow = () => store.saveNow();

const copyName = (name: string) => {
  const m = /^(.*) \(копия(?: (\d+))?\)$/.exec(name);
  return (m ? `${m[1]} (копия ${m[2] ? parseInt(m[2], 10) + 1 : 2})` : `${name} (копия)`).slice(0, 48);
};

/** Store an independent copy of a career in a new slot (a checkpoint to return to). */
export async function copyCareer(id: string): Promise<string | null> {
  try {
    await store.flush();
    const src = await getCareer(id);
    if (!src) return 'Сохранение не найдено или повреждено';
    const copy: GameState = { ...src, saveId: newId(), saveName: copyName(src.saveName), createdAt: Date.now() };
    await writeSave(buildMeta(copy), snapshot(copy));
    return null;
  } catch (e) {
    return storageError(e);
  }
}

export async function renameCareer(meta: SaveMeta, name: string): Promise<string | null> {
  const clean = name.trim().slice(0, 48);
  if (!clean || clean === meta.name) return null;
  try {
    const cur = store.get();
    if (cur && cur.saveId === meta.id) {
      store.update((s) => {
        s.saveName = clean;
      });
      await store.saveNow();
      return null;
    }
    const st = await getCareer(meta.id);
    if (!st) return 'Сохранение не найдено или повреждено';
    st.saveName = clean;
    await writeSave({ ...buildMeta(st), updatedAt: meta.updatedAt }, st);
    return null;
  } catch (e) {
    return storageError(e);
  }
}

export async function deleteCareer(id: string): Promise<string | null> {
  try {
    if (store.get()?.saveId === id) return 'Нельзя удалить открытую карьеру — сначала выйдите в главное меню';
    await store.flush();
    await deleteSave(id);
    return null;
  } catch (e) {
    return storageError(e);
  }
}

/** Download a career as a JSON file (backup / transfer to another browser). */
export async function exportCareer(id: string): Promise<string | null> {
  try {
    const st = await getCareer(id);
    if (!st) return 'Сохранение не найдено или повреждено';
    const blob = new Blob([JSON.stringify({ format: 'khl-gm-save', version: SAVE_VERSION, exportedAt: new Date().toISOString(), state: st })], { type: 'application/json' });
    const name = `hockey-manager-${st.teams[st.userTeamId].id}-${st.league.season.replace('/', '-')}-day${st.day + 1}.json`;
    if (isApp()) { await saveFile(blob, name, 'save'); return null; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return null;
  } catch (e) {
    return storageError(e);
  }
}

/** Add a career from an exported file as a new slot. */
export async function importCareer(text: string): Promise<string | null> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return 'Файл не является JSON';
  }
  const wrapped = json as { format?: string; state?: unknown } | null;
  const st = migrateState(wrapped && wrapped.format === 'khl-gm-save' ? wrapped.state : json);
  if (!st) return `Это не файл сохранения игры «${GAME_NAME_RU}» (возможно, вы выбрали roster.json — ростеры лежат в папках модов и выбираются в разделе «Новая карьера»)`;
  try {
    st.saveId = newId();
    await writeSave(buildMeta(st), snapshot(st));
    return null;
  } catch (e) {
    return storageError(e);
  }
}

export { getBackend };

/* ---------------- lineups, captains & tactics ---------------- */
export function setUserLineup(L: Lineup) {
  store.update((s) => {
    s.teams[s.userTeamId].lineup = L;
  });
}
export function autoFillLineup() {
  store.update((s) => {
    const t = s.teams[s.userTeamId];
    t.lineup = autoLineup(t.players, s.players, lineupConstraintsFor(s, t.id));
  });
}
export function swapStarterBackup() {
  store.update((s) => {
    const L = s.teams[s.userTeamId].lineup;
    if (!L.backupG) return;
    const prev = L.starterG;
    L.starterG = L.backupG;
    L.backupG = prev;
  });
}
export function setTeamRole(playerId: string, role: 'C' | 'A' | null) {
  store.update((s) => {
    const t = s.teams[s.userTeamId];
    const p = s.players[playerId];
    if (!p || p.teamId !== t.id || isGoalie(p)) return;
    assignTeamRole(t, s.players, playerId, role);
  });
}
export function setUserTactics(patch: Partial<TeamTactics>) {
  store.update((s) => {
    const t = s.teams[s.userTeamId];
    t.tactics = { ...getTeamTactics(t), ...patch };
  });
}

/** Team management actions return a user-facing error without charging on failure. */
function coachingAction(action: (s: GameState) => string | null): string | null {
  if (!store.get()) return 'Сначала загрузите карьеру.';
  let error: string | null = null;
  store.update((s) => {
    error = action(s);
    if (!error) addNews(s, 'info', s.teams[s.userTeamId].management?.lastAction ?? 'Решение штаба принято.', s.userTeamId);
  });
  return error;
}
export const hireUserCoach = (id: string, role?: import('../types').CoachRole) => coachingAction((s) => hireCoach(s, id, role));

/** Try to win a player over before (or between) offers. */
export function pitchToPlayer(id: string, pitch: PlayerPitch): { ok: boolean; text: string } {
  let out = { ok: false, text: 'Игрок не найден' };
  store.update((s) => {
    const p = s.players[id];
    if (!p || (p.teamId && p.teamId !== s.userTeamId)) return;
    if (talksLeft(s, p) <= 0) { out = { ok: false, text: `${p.name} прервал переговоры.` }; return; }
    const r = pitchPlayer(s, p, s.userTeamId, pitch);
    out = { ok: r.ok, text: r.ok ? `${r.text} (${r.delta >= 0 ? '+' : ''}${r.delta} к интересу)` : r.text };
  });
  return out;
}
export function pitchToCoach(id: string, pitch: CoachPitch, years: number): { ok: boolean; text: string } {
  let out = { ok: false, text: 'Тренер уже недоступен' };
  store.update((s) => {
    const c = s.coachMarket?.find((x) => x.id === id);
    if (!c) return;
    if (coachTalks(s, c).left <= 0) { out = { ok: false, text: `${c.name} прервал переговоры.` }; return; }
    const r = pitchCoach(s, c, s.userTeamId, pitch, years);
    out = { ok: r.ok, text: r.ok ? `${r.text} (${r.delta >= 0 ? '+' : ''}${r.delta} к интересу)` : r.text };
  });
  return out;
}
export interface CoachAnswer { ok: boolean; text: string; left: number; tone?: CoachVerdict['tone']; counter?: number }
/** Offer a contract to a free coach for a post; on agreement he is appointed at once. */
export function offerCoachContract(id: string, role: import('../types').CoachRole, terms: CoachTerms): CoachAnswer {
  let out: CoachAnswer = { ok: false, text: 'Тренер уже недоступен', left: 0 };
  store.update((s) => {
    const c = s.coachMarket?.find((x) => x.id === id);
    if (!c) return;
    const clean: CoachTerms = { salary: Math.max(0, Math.round(terms.salary / 100_000) * 100_000), years: Math.round(terms.years), signingBonus: Math.max(0, Math.round(terms.signingBonus / 100_000) * 100_000), bonuses: sanitizeBonuses(terms.bonuses).filter((b) => bonusKindsFor(null).includes(b.kind)) };
    const t = s.teams[s.userTeamId];
    const m = t.management;
    if (m && m.staffCooldown[role] > 0 && t.coaches?.some((x) => x.role === role && !x.acting)) { out = { ok: false, text: `Следующая смена на этой должности через ${Math.ceil(m.staffCooldown[role])} дн.`, left: coachTalks(s, c).left }; return; }
    const guarantee = !!coachTalks(s, c).pitched?.includes('authority');
    const v = evaluateCoachOffer(s, c, role, clean);
    if (!v.accept) { out = { ok: false, text: v.text, left: v.left, tone: v.tone, counter: v.counter }; return; }
    const err = hireCoach(s, id, role, { salary: clean.salary, contract: coachContractFrom(clean, guarantee) });
    if (err) { out = { ok: false, text: err, left: v.left }; return; }
    if (s.coachTalks) delete s.coachTalks[id];
    const extra = [clean.signingBonus ? `подъёмные ${formatMoney(clean.signingBonus)}` : '', clean.bonuses.length ? `бонусы: ${clean.bonuses.map((b) => `${bonusText(b)} — ${formatMoney(b.amount)}`).join(', ')}` : '', guarantee ? 'гарантия полномочий' : ''].filter(Boolean).join('; ');
    const text = `${c.name} — ${role === 'head' ? 'главный тренер' : 'ассистент'} «${t.name}»: ${clean.years} ${clean.years === 1 ? 'год' : 'года'}, ${formatMoney(clean.salary)} за сезон${extra ? ` (${extra})` : ''}.`;
    addNews(s, 'info', text, t.id);
    out = { ok: true, text, left: v.left, tone: 'ok' };
  });
  return out;
}
export const fireUserCoach = (role: import('../types').CoachRole) => coachingAction((s) => fireCoach(s, role));
export const setUserTeamFocus = (focus: TeamFocus) => coachingAction((s) => changeTeamFocus(s, focus));
export const holdTeamMeeting = (action: TeamIntervention) => coachingAction((s) => interveneTeam(s, action));

/* ---------------- youth training ---------------- */
export function setTrainingPlan(playerId: string, plan: YouthTrainingPlan) {
  store.update((s) => {
    const p = s.players[playerId];
    if (!p || p.teamId !== s.userTeamId || !isYouthPlayer(p)) return;
    p.trainingPlan = plan;
  });
}

export function autoAssignYouthPlans() {
  store.update((s) => {
    const t = s.teams[s.userTeamId];
    for (const id of t.players) {
      const p = s.players[id];
      if (p && isYouthPlayer(p)) p.trainingPlan = recommendYouthPlan(p);
    }
  });
}

/* ---------------- simulation ---------------- */
function runGame(state: GameState, g: Game): GameResult {
  const home = prepareLineup(state, g.home);
  const away = prepareLineup(state, g.away);
  const derby = getDerby(state.teams[g.home], state.teams[g.away]);
  const sim = new GameSim(buildSimTeam(state, g.home, home), buildSimTeam(state, g.away, away), state.players, g.kind === 'playoff', derby);
  // Other clubs' simulated games need no play-by-play; the manager's own simulated games keep it, so their goals can
  // be replayed and the shootout read attempt by attempt in the match report.
  const mine = g.home === state.userTeamId || g.away === state.userTeamId;
  sim.quiet = !mine;
  sim.keepShotMap = mine;
  return sim.runAll();
}

export function makeUserSim(state: GameState, g: Game): { sim: GameSim; home: Lineup; away: Lineup } {
  const home = prepareLineup(state, g.home);
  const away = prepareLineup(state, g.away);
  const derby = getDerby(state.teams[g.home], state.teams[g.away]);
  const sim = new GameSim(buildSimTeam(state, g.home, home), buildSimTeam(state, g.away, away), state.players, g.kind === 'playoff', derby);
  sim.userSide = g.home === state.userTeamId ? 0 : g.away === state.userTeamId ? 1 : null;
  return { sim, home, away };
}

function applyRecord(t: Team, gf: number, ga: number, beyond: boolean, so: boolean, win: boolean) {
  const r = t.record;
  r.gp++;
  r.gf += gf;
  r.ga += ga;
  let code: string;
  if (win) {
    // KHL: any win is worth 2 points (regulation, overtime or shootout); an OT/SO loss is worth 1.
    r.points += 2;
    if (!beyond) {
      r.w++;
      code = 'В';
    } else if (so) {
      r.sow++;
      code = 'ВБ';
    } else {
      r.otw++;
      code = 'ВОТ';
    }
    r.streak = r.streakType === 'W' ? r.streak + 1 : 1;
    r.streakType = 'W';
  } else if (beyond) {
    if (so) r.sol++;
    else r.otl++;
    r.points += 1;
    code = so ? 'ПБ' : 'ПОТ';
    r.streak = r.streakType === 'L' ? r.streak + 1 : 1;
    r.streakType = 'L';
  } else {
    r.l++;
    code = 'П';
    r.streak = r.streakType === 'L' ? r.streak + 1 : 1;
    r.streakType = 'L';
  }
  r.last.push(code);
  if (r.last.length > 10) r.last.shift();
}

function commitResult(state: GameState, g: Game, res: GameResult) {
  g.played = true;
  g.result = res;
  const P = state.players;
  const H = state.teams[g.home];
  const A = state.teams[g.away];
  const U = state.userTeamId;
  const beyond = res.ot || res.so;
  const hw = res.homeScore > res.awayScore;
  const derby = getDerby(H, A);
  const regLen = regularSeasonLength(state.schedule);

  recordLineupChemistryGP(H, H.lineup);
  recordLineupChemistryGP(A, A.lineup);
  H.roadStreak = 0;
  A.roadStreak = (A.roadStreak ?? 0) + (isFarEastClub(H) ? 2 : 1);
  let homeGate =
    computeHomeGateRevenue(
      H.facilities?.arena ?? 1,
      g.kind === 'playoff',
      isWeekendDay(g.day, regLen, state.league.season),
      A.record.points
    ) + (derby ? derby.gateBonus : 0);
  if (H.id === U) homeGate = Math.round((homeGate * fanGateMult(state.fans)) / 100_000) * 100_000;
  H.budget += homeGate;
  H.seasonGateRevenue = (H.seasonGateRevenue ?? 0) + homeGate;

  if (g.kind === 'regular') {
    applyRecord(H, res.homeScore, res.awayScore, beyond, res.so, hw);
    applyRecord(A, res.awayScore, res.homeScore, beyond, res.so, !hw);
    for (const tid of [g.home, g.away]) {
      const cap = getCapSummary(state, tid);
      if (cap.sanctionsActive) {
        const T = state.teams[tid];
        T.capViolationGames = (T.capViolationGames ?? 0) + 1;
        if (T.capViolationGames % CAP_GAMES_PER_POINT_DEDUCTION === 0) {
          T.record.capPenaltyPoints = (T.record.capPenaltyPoints ?? 0) + 2;
          T.record.points = recomputePoints(T.record);
          addNews(
            state,
            'info',
            `Санкции ${LG()}: с клуба «${T.name}» снято 2 турнирных очка за проведение ${T.capViolationGames} матчей с превышением потолка зарплат!`,
            tid
          );
        }
      }
    }
  }
  recordCoachingResult(H, hw);
  recordCoachingResult(A, !hw);
  const winnerId = hw ? g.home : g.away;
  const moraleMult = derby ? derby.moraleMult : 1;
  for (const id in res.lines) {
    const l = res.lines[id];
    const p = P[id];
    if (!p) continue;
    const ti = res.homeDressed.includes(id) ? g.home : g.away;
    const club = state.teams[ti];
    const won = ti === winnerId;
    if (isGoalie(p) && l.minutes === 0) {
      p.fatigue = Math.max(0, (p.fatigue ?? 0) - 4);
      continue;
    }
    creditGame(p, ti, g.kind === 'playoff' ? 'playoff' : 'regular', { line: l, goalie: isGoalie(p), won, beyond });
    if (isGoalie(p)) {
      const load = 19 + (l.shotsAgainst >= 34 ? 5 : l.shotsAgainst >= 28 ? 2 : 0) + (ti === g.away && isFarEastClub(H) ? 4 : 0);
      p.fatigue = clamp((p.fatigue ?? 0) + load, 0, 96);
    }
    const hasSteadyCap = !!(club?.captainId && P[club.captainId] && !P[club.captainId].injury && P[club.captainId].morale >= 70);
    const rawSwing = won ? 3 : beyond ? -1 : hasSteadyCap ? -2 : -3;
    p.morale = clamp(p.morale + Math.round(rawSwing * moraleMult) + l.goals * 2 + l.assists, 30, 99);
  }
  if (derby && (g.home === U || g.away === U) && state.board) {
    const userWonDerby = winnerId === U;
    state.board.confidence = clamp(state.board.confidence + (userWonDerby ? 3 : beyond ? 0 : -2), 5, 100);
  }
  for (const tid of [g.home, g.away]) {
    const dressed = tid === g.home ? res.homeDressed : res.awayDressed;
    const medLv = state.teams[tid].facilities?.medical ?? 1;
    for (const pid of dressed) {
      const p = P[pid];
      if (!p || p.inLtir) continue;
      if (p.injury && p.playingThroughInjury) {
        if (Math.random() < 0.22) {
          const extra = Math.max(4, Math.round((6 + Math.floor(Math.random() * 8)) * medicalDurationMult(medLv)));
          p.injury.days += extra;
          p.injury.totalDays = Math.max(p.injury.totalDays ?? p.injury.days, p.injury.days);
          p.injury.severity = severityOfDays(p.injury.days);
          p.injury.daySustained = state.day;
          p.playingThroughInjury = false;
          if (tid === U) {
            state.teams[U].lineup = sanitizeLineup(state.teams[U].lineup, state.teams[U].players, P, lineupConstraintsFor(state, U));
            addNews(
              state,
              'injury',
              `Рецидив («на уколах»): ${p.name} усугубил повреждение (+${formatInjuryDays(extra)}, всего ${formatInjuryDays(p.injury.days)}).`,
              tid
            );
          }
        }
        continue;
      }
      if (p.injury) continue;
      const gTired = isGoalie(p) && goalieFreshness(p) < 48;
      const baseCh = isGoalie(p) ? (gTired ? 0.014 : 0.0045) : 0.0095 + (p.age >= 32 ? 0.0035 : 0);
      const ch = baseCh * medicalRiskMult(medLv);
      if (Math.random() < ch) {
        p.injury = rollInjury(isGoalie(p), medLv, state.day);
        p.playingThroughInjury = false;
        if (tid === U) {
          state.teams[U].lineup = sanitizeLineup(state.teams[U].lineup, state.teams[U].players, P, lineupConstraintsFor(state, U));
          const retStr = injuryReturnDate(state.day, p.injury.days, regLen, state.league.season);
          const ltirHint = p.injury.days >= LTIR_MIN_DAYS ? ' • доступен перевод в ДСБТ' : '';
          addNews(
            state,
            'injury',
            `Травма: ${p.name} — ${p.injury.name.toLowerCase()}, срок ~${formatInjuryDays(p.injury.days)} (до ${retStr})${ltirHint}`,
            tid
          );
        }
      }
    }
  }
  if (g.kind === 'playoff' && g.seriesId != null && state.playoffs) {
    const s = state.playoffs.series.find((x) => x.id === g.seriesId);
    if (s) {
      const wi = winnerId === s.high ? 0 : 1;
      s.wins[wi]++;
      if (s.wins[wi] >= 4 && !s.done) {
        s.done = true;
        s.winner = winnerId;
        const loser = state.teams[winnerId === s.high ? s.low : s.high];
        addNews(state, 'playoff', `${state.teams[winnerId].name} выигрывает серию (${roundName(s.round)}) у ${loser.name} — ${s.wins[0]}:${s.wins[1]}`);
      }
    }
  }
  if (g.home === U || g.away === U) {
    const tag = res.so ? ' (Б)' : res.ot ? ' (ОТ)' : '';
    const stars = res.stars.map((id) => P[id]?.name).filter(Boolean).join(', ');
    const hXg = (res.homeStats.xg ?? 0).toFixed(2);
    const aXg = (res.awayStats.xg ?? 0).toFixed(2);
    const derbyPrefix = derby ? `🔥 ${derby.title}: ` : '';
    const gateNote = g.home === U ? ` Касса арены: +${formatMoney(homeGate)}.` : '';
    addNews(
      state,
      'result',
      `${derbyPrefix}${H.short} ${res.homeScore}:${res.awayScore}${tag} ${A.short}. Броски ${res.homeStats.shots}:${res.awayStats.shots} (xG ${hXg}:${aXg}). Звёзды: ${stars || '—'}.${gateNote}`,
      U,
      g.id
    );
    const oppDressed = g.home === U ? res.awayDressed : res.homeDressed;
    scoutGame(state, oppDressed);
    // Fans: wins (especially derbies and playoff games) lift support, losses erode it slowly.
    const userWon = (g.home === U) === hw;
    const swing = (userWon ? 1 : beyond ? -0.5 : -1) * (g.kind === 'playoff' ? 2 : 1) * (derby ? 1.5 : 1);
    state.fans = Math.max(0, Math.min(100, Math.round(((state.fans ?? 60) + swing) * 10) / 10));
    trackPromises(state, g, res);
    state.press = createPressConference(state, g, res);
  }
}

function aiResolveCapExcess(state: GameState, t: Team) {
  const P = state.players;
  state.waivers ??= [];
  let guard = 0;
  while (capExcess(state, t.id) > 0 && t.players.length > 18 && guard++ < 6) {
    const activeIds = t.players.filter((id) => P[id] && !P[id].inVhl && !isOnWaivers(state, id));
    const cnt = {
      F: activeIds.filter((id) => groupOf(P[id]) === 'F').length,
      D: activeIds.filter((id) => groupOf(P[id]) === 'D').length,
      G: activeIds.filter((id) => groupOf(P[id]) === 'G').length,
    };
    const mins: Record<'F' | 'D' | 'G', number> = { F: 12, D: 6, G: 2 };
    const candidates = activeIds
      .map((id) => P[id])
      .filter((p) => p && !p.nmc && p.contract.salary >= 10_000_000 && cnt[groupOf(p)] > mins[groupOf(p)])
      .sort((a, b) => a.overall - a.contract.salary / 8e6 - (b.overall - b.contract.salary / 8e6));
    if (!candidates.length) break;
    const drop = candidates[0];
    const vhlCount = t.players.filter((id) => P[id]?.inVhl).length;
    // First send depth contracts to VHL / 48h Waivers before taking buyout deadCap
    if (vhlCount < MAX_VHL_PLAYERS) {
      if (isWaiverExempt(drop)) {
        drop.inVhl = true;
        continue;
      }
      if ((state.waivers?.length ?? 0) < 6 && Math.random() < 0.7) {
        state.waivers.push({
          playerId: drop.id,
          fromTeamId: t.id,
          postedDay: state.day,
          expiresDay: state.day + WAIVER_DAYS,
        });
        addNews(state, 'trade', `Драфт отказов ${LG()} (48 ч): «${t.name}» выставила ${drop.name} (ОВР ${drop.overall}, ${formatMoney(drop.contract.salary)}).`);
        // If still above cap after grace, also move to VHL or buyout next excess
        drop.inVhl = true;
        continue;
      }
    }
    const dead = Math.round((drop.contract.salary * 0.1) / 100_000) * 100_000;
    t.deadCap = (t.deadCap ?? 0) + dead;
    toFreeAgency(state, drop.id);
  }
}

function postDay(state: GameState) {
  const regLen = regularSeasonLength(state.schedule);
  const calStep =
    state.day > 0
      ? Math.max(
          1,
          Math.round(
            (seasonDateObj(state.day, regLen, state.league.season).getTime() -
              seasonDateObj(state.day - 1, regLen, state.league.season).getTime()) /
              86_400_000
          )
        )
      : 1;

  stepTeamManagement(state, calStep);

  // August is over: whatever is left of the preseason tournament is played with the regular line-up.
  if (state.preseason && !state.preseason.done && state.phase === 'season') {
    autoFinishPreseason(state);
    announcePreseason(state);
  }
  for (const text of stepScouting(state, calStep)) addNews(state, 'info', text, state.userTeamId);
  if (state.press && state.press.day < state.day - 2) state.press = null;
  stepDressingRoom(state, calStep, (t) => addNews(state, 'info', t, state.userTeamId));
  // Before derbies, playoff games and games against the leaders the press wants a word first.
  if (!state.press) {
    const ug = (state.schedule[state.day] ?? []).find((x) => !x.played && (x.home === state.userTeamId || x.away === state.userTeamId));
    if (ug) state.press = createPrePressConference(state, ug);
  }

  // Daily goalie recovery for goalies whose club did not play on the day that just finished
  const playedToday = new Set<string>();
  const justPlayedDay = state.schedule[state.day - 1] ?? [];
  for (const g of justPlayedDay) {
    if (g.result?.homeGoalie) playedToday.add(g.result.homeGoalie);
    if (g.result?.awayGoalie) playedToday.add(g.result.awayGoalie);
  }
  for (const p of Object.values(state.players)) {
    if (p && isGoalie(p) && (p.fatigue ?? 0) > 0 && !playedToday.has(p.id)) {
      const medLv = p.teamId ? (state.teams[p.teamId]?.facilities?.medical ?? 1) : 1;
      p.fatigue = Math.max(0, (p.fatigue ?? 0) - medicalGoalieRestRecovery(medLv));
    }
  }

  // Calendar-day injury recovery across the entire league (including rest days & breaks)
  for (const p of Object.values(state.players)) {
    if (!p?.injury) continue;
    const justSustained = p.injury.daySustained === state.day - 1;
    const tick = justSustained ? Math.max(0, calStep - 1) : calStep;
    if (tick <= 0) continue;
    p.injury.days -= tick;
    if (p.injury.days <= 0) {
      p.injury = null;
      p.playingThroughInjury = false;
      if (p.teamId === state.userTeamId) {
        if (p.inLtir) {
          addNews(
            state,
            'injury',
            `${p.name} полностью восстановился! Выведите игрока из ДСБТ во вкладке «Состав» (нужно место под потолком зарплат).`,
            state.userTeamId
          );
        } else {
          addNews(state, 'injury', `${p.name} восстановился после травмы и готов играть.`, state.userTeamId);
        }
      } else if (p.inLtir) {
        p.inLtir = false;
      }
    }
  }

  // KHL All-Star Weekend (Неделя Звёзд КХЛ: Запад vs Восток + Конкурс мастерства)
  if (state.phase === 'season' && !state.allStar && regLen >= 24 && state.day === allStarTargetDay(regLen)) {
    const asg = simulateAllStarWeekend(state);
    if (asg) {
      state.allStar = asg;
      const starSet = new Set([...asg.westRoster, ...asg.eastRoster]);
      for (const p of Object.values(state.players)) {
        if (!p) continue;
        if (starSet.has(p.id)) {
          p.morale = clamp(p.morale + 8, 30, 99);
        } else if (isGoalie(p) && (p.fatigue ?? 0) > 0) {
          p.fatigue = Math.max(0, (p.fatigue ?? 0) - 18);
        }
      }
      const userBonus = asg.userSelectedIds.length * 15_000_000;
      if (userBonus > 0) {
        const ut = state.teams[state.userTeamId];
        ut.budget += userBonus;
        ut.seasonGateRevenue = (ut.seasonGateRevenue ?? 0) + userBonus;
      }
      const mvpName = state.players[asg.mvpId]?.name ?? '—';
      const fastName = state.players[asg.fastestSkaterId]?.name ?? '—';
      const hardName = state.players[asg.hardestShotId]?.name ?? '—';
      const userNames = asg.userSelectedIds.map((id) => state.players[id]?.name).filter(Boolean);
      const userTail = userNames.length
        ? ` От нашего клуба сыграли: ${userNames.join(', ')} (+8 к морали, медиа-бонус +${formatMoney(userBonus)}).`
        : '';
      addNews(
        state,
        'milestone',
        `★ Неделя Звёзд ${LG()}: Запад — Восток ${asg.westScore}:${asg.eastScore}! MVP — ${mvpName}, круг на скорость — ${fastName}, сила броска — ${hardName}.${userTail}`,
        state.userTeamId
      );
    }
  }

  // Process 48-hour KHL waivers
  if (state.waivers && state.waivers.length > 0) {
    const worstFirst = [...rankAll(state)].reverse();
    processDailyWaivers(
      state,
      worstFirst,
      (t) => effectivePayroll(t, state.players, state.phase),
      (txt, tid) => addNews(state, 'trade', txt, tid)
    );
    for (const t of Object.values(state.teams)) {
      ensureCaptains(t, state.players);
      const opts = lineupConstraintsFor(state, t.id);
      if (t.id === state.userTeamId) t.lineup = sanitizeLineup(t.lineup, t.players, state.players, opts);
    }
  }

  // Occasional AI veteran waiver placement during regular season to keep the KHL waiver wire active
  if (state.phase === 'season' && state.day > 6 && state.day % 9 === 0 && (state.waivers?.length ?? 0) < 3) {
    const aiTeams = state.teamOrder.filter((id) => id !== state.userTeamId && state.teams[id].players.length >= 23);
    if (aiTeams.length) {
      const tid = aiTeams[Math.floor(Math.random() * aiTeams.length)];
      const T = state.teams[tid];
      const P = state.players;
      const dressedSet = new Set([...T.lineup.F.flat(), ...T.lineup.D.flat(), T.lineup.starterG, T.lineup.backupG].filter(Boolean));
      const grpCounts = {
        F: T.players.filter((id) => groupOf(P[id]) === 'F').length,
        D: T.players.filter((id) => groupOf(P[id]) === 'D').length,
        G: T.players.filter((id) => groupOf(P[id]) === 'G').length,
      };
      const surplus = T.players
        .map((id) => P[id])
        .filter((p) => {
          if (!p || p.injury || dressedSet.has(p.id) || p.inVhl || p.nmc || isWaiverExempt(p)) return false;
          const g = groupOf(p);
          const minKeep = g === 'F' ? 13 : g === 'D' ? 7 : 3;
          if (grpCounts[g] < minKeep) return false;
          return p.overall >= 71 && p.overall <= 77 && !isOnWaivers(state, p.id);
        })
        .sort((a, b) => b.contract.salary - a.contract.salary)[0];
      if (surplus) {
        state.waivers ??= [];
        state.waivers.push({ playerId: surplus.id, fromTeamId: tid, postedDay: state.day, expiresDay: state.day + WAIVER_DAYS });
        addNews(state, 'trade', `Драфт отказов ${LG()} (48 ч): «${T.name}» поместила ${surplus.name} (ОВР ${surplus.overall}, ${formatMoney(surplus.contract.salary)}) в список отказов.`);
      }
    }
  }

  state.announcedWindows ??= [];
  if (state.phase === 'season') {
    const w = tradeWindow(state);
    if (w.windowId === 'freeze' && !state.announcedWindows.includes('freeze')) {
      state.announcedWindows.push('freeze');
      addNews(state, 'trade', `Пауза сборных: объявлен временный мораторий ${LG()} на обмены между клубами.`);
    } else if (w.windowId === 'winter' && !state.announcedWindows.includes('winter')) {
      state.announcedWindows.push('winter');
      addNews(state, 'trade', `Открыто зимнее («преддедлайновое») окно обменов ${LG()} — клубы ведут финальную гонку за усилением.`);
    } else if (!state.deadlinePassed && w.windowId === 'closed') {
      state.deadlinePassed = true;
      state.offers = [];
      addNews(state, 'trade', 'Дедлайн обменов прошёл: до межсезонья усиливаться можно только свободными агентами.');
    }
  }

  // Daily salary cap enforcement & harsh consequences
  if (state.phase === 'season' || state.phase === 'playoffs') {
    for (const t of Object.values(state.teams)) {
      if (t.id !== state.userTeamId && capExcess(state, t.id) > 0 && (t.capViolationDays ?? 0) >= 4) {
        aiResolveCapExcess(state, t);
      }
      const excess = capExcess(state, t.id);
      if (excess > 0) {
        t.capViolationDays = (t.capViolationDays ?? 0) + 1;
        if (t.id === state.userTeamId && t.capViolationDays === 1) {
          addNews(
            state,
            'info',
            `Предупреждение ${LG()}: ФОТ превышает потолок зарплат на ${formatMoney(excess)}! Дано ${CAP_GRACE_DAYS} дн. на разгрузку ведомости.`,
            t.id
          );
        }
        if (t.capViolationDays > CAP_GRACE_DAYS) {
          const fine = dailyCapFine(excess);
          t.budget -= fine;
          t.capFinesTotal = (t.capFinesTotal ?? 0) + fine;
          const cap = getCapSummary(state, t.id);
          if (t.id === state.userTeamId) {
            t.lineup = sanitizeLineup(t.lineup, t.players, state.players, lineupConstraintsFor(state, t.id));
            if (t.capViolationDays === CAP_GRACE_DAYS + 1) {
              const suspNames = cap.suspendedIds.map((id) => state.players[id]?.name).filter(Boolean).join(', ');
              addNews(
                state,
                'info',
                `ЖЁСТКИЕ САНКЦИИ ${LG()}: льготный срок истёк! Заблокированы контракты лидеров (${suspNames || '—'}), введён ежедневный штраф ${formatMoney(fine)} и учёт штрафных матчей (−2 очка каждые ${CAP_GAMES_PER_POINT_DEDUCTION} игр).`,
                t.id
              );
            }
          }
          if ((t.capViolationDays - CAP_GRACE_DAYS) % 4 === 1) {
            for (const pid of t.players) {
              const pl = state.players[pid];
              if (pl) pl.morale = clamp(pl.morale - (cap.suspendedIds.includes(pid) ? 4 : 2), 25, 99);
            }
            if (t.id === state.userTeamId && state.board) {
              state.board.confidence = clamp(state.board.confidence - 4, 5, 100);
            }
          }
        }
      } else if ((t.capViolationDays ?? 0) > 0) {
        if (t.id === state.userTeamId && (t.capViolationDays ?? 0) > CAP_GRACE_DAYS) {
          addNews(state, 'info', `Клуб вернулся под потолок зарплат ${LG()}: блокировка лидеров и ежедневные штрафы сняты.`, t.id);
        }
        t.capViolationDays = 0;
      }
    }
  }

  // Weekly U23 training progression
  if (state.phase === 'season' && state.day > 0 && state.day % 7 === 0) {
    stepYouthTrainingWeek(state, (pl, _fromOvr, toOvr, skillLabel, planLabel) => {
      addNews(
        state,
        'info',
        `Прогресс молодёжи: ${pl.name} (${pl.age} л.) прибавил по плану «${planLabel}» — рейтинг ${toOvr} (+1 «${skillLabel}»).`,
        state.userTeamId
      );
    });
  }

  state.offers = state.offers.filter((o) => o.expires >= state.day);
  const off = maybeIncomingOffer(state);
  if (off) {
    state.offers.push(off);
    const P = state.players;
    addNews(state, 'offer', `${state.teams[off.from].name} предлагает обмен: ${off.give.map((id) => P[id].name).join(', ')} за ${off.get.map((id) => P[id].name).join(', ')}.${off.reason ? ' ' + off.reason + '.' : ''}`, state.userTeamId);
  }
  const item = maybeAiTrade(state);
  if (item) {
    item.id = newsId++;
    state.news.unshift(item);
  }
  if (state.phase === 'season' && state.day >= state.schedule.length) startPlayoffs(state);
  else if (state.phase === 'playoffs') ensurePlayoffDay(state);
}

export function simulateDay(includeUser: boolean): boolean {
  let userSimmed = false;
  store.update((state) => {
    const U = state.userTeamId;
    const today = state.schedule[state.day] ?? [];
    const pending = today.filter((g) => !g.played);
    const hasUser = pending.some((g) => g.home === U || g.away === U);
    if (hasUser && !includeUser) return;
    for (const g of pending) {
      const res = runGame(state, g);
      const u = g.home === U || g.away === U;
      commitResult(state, g, res);
      if (u) userSimmed = true;
    }
    state.day += 1;
    postDay(state);
  });
  return userSimmed;
}

/** Ids of the inbox tasks that must stop fast simulation. */
const blockingIds = (state: GameState) => new Set(blockingTasks(state).map((t) => t.id));
const newBlocking = (state: GameState, before: Set<string>) => blockingTasks(state).filter((t) => !before.has(t.id));

export type SimStop = 'done' | 'inbox';

/** Simulate up to `n` days; stops early when something new lands in the inbox that needs a decision. */
export function simulateDays(n: number, stopOnInbox = true): { days: number; stop: SimStop } {
  let days = 0;
  let stop: SimStop = 'done';
  for (let i = 0; i < n; i++) {
    const cur = store.get();
    if (!cur || cur.phase === 'offseason') break;
    const before = blockingIds(cur);
    simulateDay(true);
    days++;
    const after = store.get();
    if (stopOnInbox && after && i < n - 1 && newBlocking(after, before).length) {
      stop = 'inbox';
      break;
    }
  }
  return { days, stop };
}

export function simulateToNextUserGame(stopOnInbox = false): 'userGame' | 'offseason' | 'stalled' | 'inbox' {
  let result: 'userGame' | 'offseason' | 'stalled' | 'inbox' = 'stalled';
  store.update((state) => {
    const U = state.userTeamId;
    let before = stopOnInbox ? blockingIds(state) : null;
    for (let i = 0; i < 1500; i++) {
      if (state.phase === 'offseason') {
        result = 'offseason';
        return;
      }
      const today = state.schedule[state.day] ?? [];
      const ug = today.find((g) => !g.played && (g.home === U || g.away === U));
      if (ug) {
        result = 'userGame';
        return;
      }
      for (const g of today) {
        if (g.played) continue;
        commitResult(state, g, runGame(state, g));
      }
      state.day += 1;
      postDay(state);
      if (before) {
        if (newBlocking(state, before).length) {
          result = 'inbox';
          return;
        }
        before = blockingIds(state);
      }
    }
  });
  return result;
}

export function commitUserResult(gameId: number, result: GameResult) {
  store.update((state) => {
    const g = (state.schedule[state.day] ?? []).find((x) => x.id === gameId);
    if (!g || g.played) return;
    commitResult(state, g, result);
    for (const o of state.schedule[state.day]) if (!o.played) commitResult(state, o, runGame(state, o));
    state.day += 1;
    postDay(state);
  });
}

/* ---------------- playoffs ---------------- */
function computeAwards(state: GameState): Award[] {
  const P = state.players;
  const all = Object.values(P).filter((p) => p.teamId && p.stats.gp > 0);
  const top = (arr: typeof all, f: (p: (typeof all)[number]) => number) => [...arr].sort((a, b) => f(b) - f(a))[0];
  const mk = (title: string, p: (typeof all)[number] | undefined, value: string): Award[] => (p ? [{ title, player: p.id, team: p.teamId!, value }] : []);
  const sk = all.filter(isSkater);
  return [
    ...mk('Лучший бомбардир', top(sk, points), 'очков'),
    ...mk('Лучший снайпер', top(sk, (p) => p.stats.goals), 'шайб'),
    ...mk('Лучший ассистент', top(sk, (p) => p.stats.assists), 'передач'),
    ...mk('Лучший защитник', top(sk.filter(isDefense), points), 'очков'),
    ...mk('Лучший вратарь', top(all.filter(isGoalie).filter((p) => p.stats.gp >= 15 && p.stats.shotsAgainst > 20), (p) => p.stats.saves / Math.max(1, p.stats.shotsAgainst)), '% ОБ'),
  ].map((a) => {
    const p = P[a.player];
    const value = a.title === 'Лучший вратарь' ? `${((p.stats.saves / Math.max(1, p.stats.shotsAgainst)) * 100).toFixed(1)}% ОБ` : `${a.title.includes('Снайпер') || a.title.includes('снайпер') ? p.stats.goals : a.title.includes('ассистент') ? p.stats.assists : p.stats.goals + p.stats.assists} ${a.value}`;
    return { ...a, value };
  });
}

export function startPlayoffs(state: GameState) {
  state.phase = 'playoffs';
  const series: Series[] = [];
  let sid = 1;
  for (const conf of ['Запад', 'Восток'] as const) {
    const ranked = rankConference(state, conf);
    ranked.forEach((t, i) => {
      t.seed = i + 1;
    });
    const k = Math.min(8, ranked.length - (ranked.length % 2));
    for (let i = 0; i < k / 2; i++) series.push({ id: sid++, round: 0, conf, high: ranked[i].id, low: ranked[k - 1 - i].id, wins: [0, 0], games: [], done: false, winner: null });
  }
  const awards = computeAwards(state);
  state.playoffs = { round: 0, series, champion: null, mvp: null, awards };
  const U = state.teams[state.userTeamId];
  const regularBonuses = settleBonuses(state, 'regular');
  if (regularBonuses.total > 0) addNews(state, 'info', `Бонусы по итогам регулярного чемпионата: ${formatMoney(regularBonuses.total)} — ${regularBonuses.lines.join('; ')}.`, U.id);
  const promises = checkPromises(state);
  if (promises.length) addNews(state, 'info', `Обещания игрокам: ${promises.join('; ')}.`, U.id);
  addNews(state, 'playoff', `Регулярный чемпионат завершён. Обладатель Кубка Контина — ${rankAll(state)[0].name}. Стартует плей-офф Кубка Гагарина!`);
  addNews(state, 'playoff', U.seed && U.seed <= 8 ? `${U.name} выходит в плей-офф с ${U.seed}-го места в конференции «${U.conference}»` : `${U.name} не пробилась в плей-офф`, U.id);
  ensurePlayoffDay(state);
}

function buildNextRound(state: GameState) {
  const po = state.playoffs!;
  const prev = po.series.filter((s) => s.round === po.round);
  const next: Series[] = [];
  let sid = Math.max(...po.series.map((s) => s.id)) + 1;
  if (po.round < 2) {
    for (const conf of ['Запад', 'Восток'] as const) {
      let winners = prev.filter((s) => s.conf === conf && s.winner).map((s) => state.teams[s.winner!]);
      if (!winners.length) winners = [rankConference(state, conf)[0]];
      winners.sort((a, b) => (a.seed ?? 99) - (b.seed ?? 99));
      while (winners.length > 2) {
        const hi = winners.shift()!;
        const lo = winners.pop()!;
        next.push({ id: sid++, round: po.round + 1, conf, high: hi.id, low: lo.id, wins: [0, 0], games: [], done: false, winner: null });
      }
      if (winners.length === 2) {
        next.push({ id: sid++, round: po.round + 1, conf, high: winners[0].id, low: winners[1].id, wins: [0, 0], games: [], done: false, winner: null });
      } else if (winners.length === 1) {
        const hi = winners[0];
        next.push({ id: sid++, round: po.round + 1, conf, high: hi.id, low: hi.id, wins: [4, 0], games: [], done: true, winner: hi.id });
      }
    }
  } else {
    const wc = prev.find((s) => s.conf === 'Запад')?.winner;
    const ec = prev.find((s) => s.conf === 'Восток')?.winner;
    const west = wc ? state.teams[wc] : rankConference(state, 'Запад')[0];
    const east = ec ? state.teams[ec] : rankConference(state, 'Восток')[0];
    const [hi, lo] = compareTeams(west, east) <= 0 ? [west, east] : [east, west];
    next.push({ id: sid++, round: 3, conf: 'Финал', high: hi.id, low: lo.id, wins: [0, 0], games: [], done: false, winner: null });
    addNews(state, 'playoff', `Финал Кубка Гагарина: ${hi.name} против ${lo.name}. Преимущество площадки у ${hi.name}.`);
  }
  po.series.push(...next);
  po.round += 1;
}

function finishSeason(state: GameState) {
  const po = state.playoffs!;
  const champId = po.series.find((s) => s.round === 3)?.winner;
  if (!champId) return;
  po.champion = champId;
  const P = state.players;
  const champ = state.teams[champId];
  const regular = rankAll(state)[0];
  const U = state.teams[state.userTeamId];
  const userSeries = po.series.filter((s) => s.high === U.id || s.low === U.id);
  let userResult = 'Не вышла в плей-офф';
  if (champId === U.id) userResult = 'Обладатель Кубка Гагарина';
  else if (userSeries.length) {
    const lost = userSeries.find((s) => s.winner && s.winner !== U.id);
    userResult = lost ? `Плей-офф: вылет в стадии «${roundName(lost.round)}»` : 'Участник плей-офф';
  }
  const mvp = champ.players.map((id) => P[id]).filter(isSkater).sort((a, b) => points(b) - points(a))[0];
  po.mvp = mvp?.id ?? null;
  const playoffBonuses = settleBonuses(state, 'playoffs');
  if (playoffBonuses.total > 0) addNews(state, 'info', `Бонусы за плей-офф: ${formatMoney(playoffBonuses.total)} — ${playoffBonuses.lines.join('; ')}.`, U.id);
  let userRev = 0;
  let userPay = 0;
  for (const t of Object.values(state.teams)) {
    const arenaLv = t.facilities?.arena ?? 1;
    let settlement = 260_000_000 + (arenaLv - 1) * 25_000_000 + t.record.points * 8_500_000;
    settlement += po.series.filter((s) => s.high === t.id || s.low === t.id).length * 40_000_000;
    if (t.id === champId) settlement += 100_000_000;
    if (regular.id === t.id) settlement += 50_000_000;
    const pay = payroll(t.players, P);
    t.budget += settlement - pay;
    if (t.id === state.userTeamId) {
      userRev = settlement + (t.seasonGateRevenue ?? 0);
      userPay = pay;
    }
  }
  if (champId === U.id) state.trophies.push({ season: state.league.season, title: 'Кубок Гагарина' });
  if (regular.id === U.id) state.trophies.push({ season: state.league.season, title: 'Кубок Контина' });
  const finalSeries = po.series.find((s) => s.round === 3)!;
  const loser = state.teams[champId === finalSeries.high ? finalSeries.low : finalSeries.high];
  const place = rankConference(state, U.conference).indexOf(U) + 1;
  const verdict = evaluateBoard(state, { place, madePlayoffs: userSeries.length > 0, roundsWon: userSeries.filter((x) => x.winner === U.id).length });
  const penPts = U.record.capPenaltyPoints ?? 0;
  const finalBonus = penPts > 0 ? Math.round(verdict.bonus * 0.5) : verdict.bonus;
  U.budget += finalBonus;
  const fineNote = (U.capFinesTotal ?? 0) > 0 ? `, штрафы потолка ${formatMoney(U.capFinesTotal!)}` : '';
  state.summaries.push({ season: state.league.season, champion: champId, regularWinner: regular.id, userResult, userPoints: U.record.points, userPlace: place, awards: po.awards, revenue: userRev, payroll: userPay, board: verdict.text, boardBonus: finalBonus });
  addNews(state, 'info', `${verdict.text}${finalBonus > 0 ? ` Премиальные клубу: ${formatMoney(finalBonus)}.` : ''} Финансы сезона: доходы ${formatMoney(userRev)}, зарплаты ${formatMoney(userPay)}${fineNote}.`, U.id);
  addNews(state, 'playoff', `${champ.name} — обладатель Кубка Гагарина! Финал против ${loser.name} — ${finalSeries.wins[0]}:${finalSeries.wins[1]}. Самый ценный игрок плей-офф: ${mvp?.name ?? '—'}.`);
  state.phase = 'offseason';
  state.offseason = startOffseason(state);
  addNews(state, 'info', 'Межсезонье: продлите истекающие контракты и подпишите свободных агентов, затем начните новый сезон.', U.id);
}

export function ensurePlayoffDay(state: GameState) {
  if (state.day < state.schedule.length) return;
  const po = state.playoffs;
  if (!po || po.champion) return;
  for (let guard = 0; guard < 10; guard++) {
    const round = po.series.filter((s) => s.round === po.round);
    const active = round.filter((s) => !s.done);
    if (!active.length) {
      if (po.round === 3) {
        finishSeason(state);
        return;
      }
      buildNextRound(state);
      continue;
    }
    const day = state.schedule.length;
    const games: Game[] = [];
    for (const s of active) {
      const k = s.games.length;
      const home = [0, 1, 4, 6].includes(k) ? s.high : s.low;
      const away = home === s.high ? s.low : s.high;
      const g: Game = { id: state.nextGameId++, day, home, away, played: false, result: null, kind: 'playoff', seriesId: s.id };
      s.games.push(g.id);
      games.push(g);
    }
    state.schedule.push(games);
    return;
  }
}

/* ---------------- trades ---------------- */
const names = (state: GameState, ids: string[]) => ids.map((id) => state.players[id]?.name).join(', ');

/** `cash` — rubles the manager adds to the offer (negative: he asks the partner to pay). */
export function proposeTrade(partnerId: string, give: string[], get: string[], cash = 0): { ok: boolean; reason: string } {
  let out: { ok: boolean; reason: string } = { ok: false, reason: '' };
  store.update((state) => {
    const U = state.userTeamId;
    const user = state.teams[U];
    const w = tradeWindow(state);
    if (!w.open) {
      out = { ok: false, reason: w.text };
      return;
    }
    const shape = tradeShapeProblem(give, get, cash);
    if (shape) {
      out = { ok: false, reason: shape };
      return;
    }
    if (cash > 0 && user.budget < cash) {
      out = { ok: false, reason: `В бюджете клуба нет ${formatTradeCash(cash)} на доплату` };
      return;
    }
    if (give.some((id) => get.includes(id))) {
      out = { ok: false, reason: 'Игрок не может быть с обеих сторон' };
      return;
    }
    const problem = userSideProblem(state, give, get);
    if (problem) {
      out = { ok: false, reason: `Обмен невозможен: ${problem}` };
      return;
    }
    const ev = evaluateTrade(state, partnerId, give, get, cash);
    if (!ev.ok) {
      out = ev;
      return;
    }
    executeTrade(state, U, partnerId, give, get, cash);
    const money = formatTradeCash(cash);
    const toUser = [get.length ? names(state, get) : '', cash < 0 ? money : ''].filter(Boolean).join(' и ');
    const toPartner = [give.length ? names(state, give) : '', cash > 0 ? money : ''].filter(Boolean).join(' и ');
    addNews(state, 'trade', `${give.length && get.length ? 'Обмен' : 'Сделка'} с ${state.teams[partnerId].name}: в ${user.name} — ${toUser}, в ${state.teams[partnerId].short} — ${toPartner}`, U);
    out = ev;
  });
  return out;
}

export function respondOffer(offerId: number, accept: boolean): string | null {
  let err: string | null = null;
  store.update((state) => {
    const o = state.offers.find((x) => x.id === offerId);
    if (!o) return;
    const U = state.userTeamId;
    const P = state.players;
    const user = state.teams[U];
    if (!accept) {
      state.offers = state.offers.filter((x) => x.id !== offerId);
      addNews(state, 'offer', `Вы отклонили предложение ${state.teams[o.from].name}`, U);
      return;
    }
    const w = tradeWindow(state);
    const stale = o.get.some((id) => P[id].teamId !== U) || o.give.some((id) => P[id].teamId !== o.from);
    const problem = !w.open ? w.text : stale ? 'Предложение устарело: составы изменились' : userSideProblem(state, o.get, o.give) ?? clubSideProblem(state, o.from, o.give, o.get);
    if (problem) {
      err = problem.charAt(0).toUpperCase() + problem.slice(1);
      if (stale || !w.open) state.offers = state.offers.filter((x) => x.id !== offerId);
      return;
    }
    state.offers = state.offers.filter((x) => x.id !== offerId);
    executeTrade(state, U, o.from, o.get, o.give);
    addNews(state, 'trade', `Обмен с ${state.teams[o.from].name}: в ${user.name} — ${names(state, o.give)}, в ${state.teams[o.from].short} — ${names(state, o.get)}`, U);
  });
  return err;
}

/** Manager's note for the trade market: 'block' invites offers for the player, 'keep' forbids them. */
/* ---------------- trade block, scouting, press, preseason, inbox ---------------- */
export function setTradeBlockWants(patch: Partial<import('../types').TradeBlockWants>) {
  store.update((state) => {
    const tb = ensureTradeBlock(state);
    tb.wants = { ...tb.wants, ...patch };
  });
}

/** Ask every club about the trade block now; returns a message for the UI. */
export function shopTradeBlockNow(): { ok: boolean; text: string } {
  let out = { ok: false, text: '' };
  store.update((state) => {
    const r = shopTradeBlock(state);
    if (r.error && !r.offers.length) {
      out = { ok: false, text: r.error };
      return;
    }
    const P = state.players;
    for (const o of r.offers) {
      state.offers.push(o);
      addNews(state, 'offer', `${state.teams[o.from].name} отвечает на блок обменов: ${o.give.map((id) => P[id].name).join(', ')} за ${o.get.map((id) => P[id].name).join(', ')}.`, state.userTeamId);
    }
    out = { ok: true, text: `Получено предложений: ${r.offers.length}. Они появились в списке входящих предложений.` };
  });
  return out;
}

export function assignUserScout(kind: 'player' | 'team', target: string): string | null {
  let err: string | null = null;
  store.update((state) => {
    err = assignScout(state, kind, target);
  });
  return err;
}

export function cancelUserScout(kind: 'player' | 'team', target: string) {
  store.update((state) => cancelScout(state, kind, target));
}

export function answerRoomEvent(eventId: number, optionId: string) {
  store.update((state) => {
    const text = answerClubEvent(state, eventId, optionId);
    if (text) addNews(state, 'info', text, state.userTeamId);
  });
}

export function answerPress(optionId: string | null) {
  store.update((state) => {
    const text = answerPressConference(state, optionId);
    if (text) addNews(state, 'info', text, state.userTeamId);
  });
}

function announcePreseason(state: GameState) {
  const ps = state.preseason;
  if (!ps || !ps.done || ps.champion === undefined) return;
  const key = `preseason-${ps.season}`;
  state.announcedWindows ??= [];
  if (state.announcedWindows.includes(key)) return;
  state.announcedWindows.push(key);
  const table = preseasonTable(ps);
  const place = table.findIndex((r) => r.id === state.userTeamId) + 1;
  const champ = state.teams[ps.champion!];
  addNews(
    state,
    place === 1 ? 'milestone' : 'info',
    place === 1
      ? `🏆 «${state.teams[state.userTeamId].name}» выигрывает предсезонный турнир «${ps.name}»! Болельщики и руководство довольны.`
      : `Предсезонный турнир «${ps.name}» (${ps.city}): победитель — «${champ.name}», у нас ${place}-е место.`,
    state.userTeamId
  );
}

/** Play the next round of the August tournament. */
export function playPreseason(mode: 'main' | 'youth'): string | null {
  let text: string | null = null;
  store.update((state) => {
    if (state.phase !== 'season' || state.day !== 0) return;
    const r = playPreseasonRound(state, mode);
    if (!r) return;
    text = r.text;
    if (r.finished) announcePreseason(state);
  });
  return text;
}

export function dismissInbox(id: string) {
  store.update((state) => dismissInboxTask(state, id));
}

export function setTradeFlag(id: string, flag: 'block' | 'keep' | null) {
  store.update((state) => {
    const p = state.players[id];
    if (!p || p.teamId !== state.userTeamId) return;
    if (flag) p.tradeFlag = flag;
    else delete p.tradeFlag;
  });
}

/* ---------------- contracts, RFA offer sheets, waivers & VHL ---------------- */
/** Salaries the club is committed to: in the off-season expired deals no longer count; during the season deadCap and VHL relief apply. */
function committedPayroll(state: GameState, t: Team): number {
  return effectivePayroll(t, state.players, state.phase);
}

export interface ContractAnswer {
  ok: boolean;
  text: string;
  /** negotiation attempts left with this player */
  left: number;
  matchedByClub?: boolean;
  /** salary the player would accept with the same other terms */
  counter?: number;
  tone?: Verdict['tone'];
}

/**
 * Offer a contract: to a free agent (UFA or RFA via offer sheet), to an own player whose deal has expired (off-season)
 * or to an own player in the last year of his deal (the extension starts next season).
 */
export function offerContract(id: string, salary: number, years: number, withNmc = false, twoWay = false, extras?: OfferExtras): ContractAnswer {
  let out: ContractAnswer = { ok: false, text: 'Игрок не найден', left: 0 };
  store.update((state) => {
    const P = state.players;
    const p = P[id];
    const t = state.teams[state.userTeamId];
    if (!p) return;
    const fail = (text: string) => {
      out = { ok: false, text, left: talksLeft(state, p) };
    };
    const free = !p.teamId;
    const own = p.teamId === t.id;
    salary = Math.round(salary / 100_000) * 100_000;
    years = Math.round(years);
    const applyNmc = withNmc && canHaveNmc(p) && years >= 2 && !twoWay;
    if (twoWay && !canSignTwoWay(p)) return fail('Игрок не согласен на двусторонний контракт. Выберите односторонний.');
    const applyTwoWay = twoWay && !applyNmc;
    if (!free && !own) return fail('Игрок принадлежит другому клубу — его можно получить только обменом');
    if (!(salary > 0) || years < 1) return fail('Укажите оклад и срок контракта');
    const capState = getCapSummary(state, t.id);
    if (capState.sanctionsActive) return fail(`${LG()} заблокировала регистрацию новых контрактов из-за превышения потолка зарплат!`);
    const expired = own && p.contract.years === 0;
    const extension = own && p.contract.years === 1;
    if (own && !expired && !extension) return fail(`Контракт действует ещё ${p.contract.years} сезона — продлевать его можно в последний год`);
    if (own && p.contract.next) return fail('Контракт этого игрока уже продлён');
    const cap = state.league.salaryCap;
    if (free && activeKhlCount(t.players, P) >= MAX_ROSTER) {
      return fail(
        `В основном составе ${LG()} уже ${MAX_ROSTER} игроков — отправьте игрока в фарм-клуб ВХЛ, переведите травмированного в ДСБТ или освободите место`
      );
    }
    if (free && isLegionnaire(p)) {
      const fl = teamForeignLimit(t, state.league.foreignLimit);
      if (fl !== null) {
        const curLeg = countRosterLegionnaires(t.players, P);
        if (curLeg >= fl) return fail(`Достигнут лимит легионеров ${LG()} (${curLeg} из ${fl}) — сначала освободите легионерскую вакансию`);
      }
    }

    const rfaOwnerId = free && p.rightsTeamId && p.rightsTeamId !== t.id && state.teams[p.rightsTeamId] ? p.rightsTeamId : null;
    const rfaComp = rfaOwnerId ? offerSheetCompensation(salary, p.overall) : 0;

    if (extension) {
      const next = commitments(t.players, P, 2)[1] + salary;
      if (next > cap) return fail(`Со следующего сезона ФОТ составит ${formatMoney(next)} — это выше потолка зарплат (${formatMoney(cap)})`);
    } else {
      const now = committedPayroll(state, t) + salary;
      if (now > cap) return fail(`С этим окладом ФОТ составит ${formatMoney(now)} — это выше потолка зарплат (${formatMoney(cap)})`);
    }
    const signing = Math.max(0, Math.round((extras?.signingBonus ?? 0) / 100_000) * 100_000);
    const bonuses = sanitizeBonuses(extras?.bonuses).filter((b) => bonusKindsFor(p).includes(b.kind));
    if (t.budget < salary + rfaComp + signing) {
      return fail(
        rfaComp > 0
          ? `Для оффершита ОСА нужен бюджет на оклад + компенсацию${signing ? ' + подъёмные' : ''} (${formatMoney(salary + rfaComp + signing)}), сейчас — ${formatMoney(t.budget)}`
          : `В бюджете клуба должно быть не меньше годового оклада игрока${signing ? ' и подъёмных' : ''} (${formatMoney(salary + signing)}), сейчас — ${formatMoney(t.budget)}`
      );
    }

    const promised = !!(p.talks && p.talks.key === talksKey(state) && p.talks.promise);
    const v = negotiate(state, p, salary, years, t.id, applyNmc, applyTwoWay, { signingBonus: signing, bonuses });
    if (!v.accept) {
      out = { ok: false, text: v.text, left: v.left, counter: v.counter, tone: v.tone };
      return;
    }
    delete p.talks;
    const nmcTag = applyNmc ? ' (с пунктом ЗНО)' : applyTwoWay ? ` (двусторонний ${LG()}/ВХЛ)` : '';
    const extraTag = [signing ? `подъёмные ${formatMoney(signing)}` : '', bonuses.length ? `бонусы: ${bonuses.map((b) => `${bonusText(b)} — ${formatMoney(b.amount)}`).join(', ')}` : ''].filter(Boolean).join('; ');
    const term = `${years} ${years === 1 ? 'год' : years < 5 ? 'года' : 'лет'}, ${formatMoney(salary)} за сезон${nmcTag}${extraTag ? ` (${extraTag})` : ''}`;
    const cFlags = { twoWay: applyTwoWay, ...(bonuses.length ? { bonuses } : {}) };
    const signedHappy = () => {
      if (signing) t.budget -= signing;
      if (v.generous) p.morale = clamp(p.morale + 6, 30, 99);
      if (promised) p.promise = { season: state.seasonNumber + (extension || state.phase === 'offseason' ? 1 : 0) };
    };

    if (free) {
      if (rfaOwnerId) {
        const rightsClub = state.teams[rfaOwnerId];
        const clubPay = committedPayroll(state, rightsClub);
        if (aiShouldMatchOfferSheet(state, rightsClub, p, salary, clubPay)) {
          p.contract = { salary, years, ...cFlags };
          p.teamId = rightsClub.id;
          p.rightsTeamId = rightsClub.id;
          rightsClub.players.push(id);
          state.freeAgents = state.freeAgents.filter((x) => x !== id);
          rightsClub.lineup = autoLineup(rightsClub.players, P, lineupConstraintsFor(state, rightsClub.id));
          addNews(
            state,
            'trade',
            `Оффершит повторён! «${rightsClub.name}» повторила предложение «${t.name}» по ОСА ${p.name} (${term}) и сохранила игрока.`,
            t.id
          );
          out = {
            ok: false,
            matchedByClub: true,
            left: 0,
            text: `«${rightsClub.name}» воспользовалась правом ОСА и повторила ваш оффершит (${term}) — игрок остаётся в своём клубе!`,
          };
          return;
        }
        t.budget -= rfaComp;
        rightsClub.budget += rfaComp;
      }

      p.contract = { salary, years, ...cFlags };
      signedHappy();
      p.teamId = t.id;
      p.inVhl = false;
      p.nmc = applyNmc;
      p.rightsTeamId = isRfaEligibleAge(p.age) ? t.id : null;
      if (isYouthPlayer(p) && !p.trainingPlan) p.trainingPlan = recommendYouthPlan(p);
      t.players.push(id);
      state.freeAgents = state.freeAgents.filter((x) => x !== id);
      ensureCaptains(t, P);
      t.lineup = sanitizeLineup(t.lineup, t.players, P, lineupConstraintsFor(state, t.id));
      const compNote = rfaOwnerId ? ` (оффершит ОСА · компенсация «${state.teams[rfaOwnerId].short}» ${formatMoney(rfaComp)})` : '';
      addNews(state, 'trade', `${t.name} подписывает ${rfaOwnerId ? 'ОСА' : 'свободного агента'} ${p.name}: ${term}${compNote}`, t.id);
      out = { ok: true, text: `${p.name} подписал контракт: ${term}${compNote}.`, left: v.left };
    } else if (expired) {
      p.contract = { salary, years, ...cFlags };
      signedHappy();
      p.nmc = applyNmc;
      p.rightsTeamId = isRfaEligibleAge(p.age) ? t.id : null;
      if (state.offseason) state.offseason.expiring = state.offseason.expiring.filter((x) => x !== id);
      addNews(state, 'trade', `${p.name} остаётся в ${t.name}: новый контракт на ${term}`, t.id);
      out = { ok: true, text: `${p.name} подписал новый контракт: ${term}.`, left: v.left };
    } else {
      p.contract.next = { salary, years, ...cFlags };
      signedHappy();
      if (applyNmc) p.nmc = true;
      p.morale = clamp(p.morale + 5, 30, 99);
      addNews(state, 'trade', `${p.name} продлил контракт с ${t.name}: со следующего сезона — ${term}`, t.id);
      out = { ok: true, text: `${p.name} продлил контракт: со следующего сезона — ${term}.`, left: v.left };
    }
  });
  return out;
}

/** Send a player to the VHL farm club (directly if <= 22 or offseason; via 48h KHL waivers if 23+ in season). */
export function sendToVhlOrWaivers(playerId: string): string | null {
  let err: string | null = null;
  store.update((state) => {
    const P = state.players;
    const p = P[playerId];
    const U = state.userTeamId;
    const t = state.teams[U];
    if (!p || p.teamId !== U) {
      err = 'Игрок не в вашем клубе';
      return;
    }
    if (p.inVhl) {
      err = 'Игрок уже находится в фарм-клубе ВХЛ';
      return;
    }
    if (isOnWaivers(state, playerId)) {
      err = `Игрок уже выставлен на драфт отказов ${LG()} (48 ч)`;
      return;
    }
    if (p.nmc) {
      err = `У ${p.name} действует пункт ЗНО (запрет на обмен и отправку в ВХЛ / список отказов)`;
      return;
    }
    const curVhl = t.players.filter((id) => P[id]?.inVhl).length;
    if (curVhl >= MAX_VHL_PLAYERS) {
      err = `В фарм-клубе ВХЛ уже максимум командированных игроков (${MAX_VHL_PLAYERS})`;
      return;
    }
    const activeAfter = t.players.filter((id) => id !== playerId && P[id] && !P[id].inVhl);
    const gGroup = groupOf(p);
    const minReq = gGroup === 'G' ? 2 : gGroup === 'D' ? 4 : 8;
    const remGroup = activeAfter.filter((id) => groupOf(P[id]) === gGroup).length;
    if (remGroup < minReq) {
      err = `В основе ${LG()} должно остаться минимум ${minReq} игроков этой линии`;
      return;
    }

    if (isWaiverExempt(p) || state.phase === 'offseason') {
      p.inVhl = true;
      ensureCaptains(t, P);
      t.lineup = sanitizeLineup(t.lineup, t.players, P, lineupConstraintsFor(state, U));
      addNews(
        state,
        'info',
        `${p.name} командирован в фарм-клуб ВХЛ по двустороннему контракту (разгрузка потолка: ${formatMoney(vhlPlayerCapRelief(p))}).`,
        U
      );
    } else {
      state.waivers ??= [];
      state.waivers.push({
        playerId,
        fromTeamId: U,
        postedDay: state.day,
        expiresDay: state.day + WAIVER_DAYS,
      });
      // Remove from active lineup while on 48h waivers
      const opts = lineupConstraintsFor(state, U);
      opts.excluded?.add(playerId);
      t.lineup = sanitizeLineup(t.lineup, t.players, P, opts);
      addNews(
        state,
        'trade',
        `«${t.name}» поместила ${p.name} в список отказов ${LG()} на 48 часов (2 дня). Если никто не заберёт контракт — игрок отправится в ВХЛ.`,
        U
      );
    }
  });
  return err;
}

export function recallFromVhl(playerId: string): string | null {
  let err: string | null = null;
  store.update((state) => {
    const P = state.players;
    const p = P[playerId];
    const U = state.userTeamId;
    const t = state.teams[U];
    if (!p || p.teamId !== U || !p.inVhl) return;
    if (activeKhlCount(t.players, P) >= MAX_ROSTER) {
      err = `В основном составе ${LG()} уже максимум игроков (${MAX_ROSTER}/30) — сначала отправьте другого игрока в ВХЛ или освободите место`;
      return;
    }
    const fl = teamForeignLimit(t, state.league.foreignLimit);
    if (fl !== null && isLegionnaire(p) && countRosterLegionnaires(t.players, P) >= fl) {
      err = `Нельзя вызвать легионера из ВХЛ: в основе ${LG()} уже ${fl} из ${fl} иностранцев`;
      return;
    }
    const reliefLost = state.phase === 'offseason' ? 0 : vhlPlayerCapRelief(p);
    const afterPay = effectivePayroll(t, P, state.phase) + reliefLost;
    if (state.phase !== 'offseason' && afterPay > state.league.salaryCap) {
      err = `Вызов из ВХЛ поднимет ФОТ ${LG()} до ${formatMoney(afterPay)} (выше потолка ${formatMoney(state.league.salaryCap)})`;
      return;
    }
    p.inVhl = false;
    ensureCaptains(t, P);
    t.lineup = sanitizeLineup(t.lineup, t.players, P, lineupConstraintsFor(state, U));
    addNews(state, 'info', `${p.name} вызван из фарм-клуба ВХЛ в основной состав «${t.name}».`, U);
  });
  return err;
}

export function claimFromWaivers(playerId: string): string | null {
  let err: string | null = null;
  store.update((state) => {
    const w = (state.waivers ?? []).find((x) => x.playerId === playerId);
    if (!w) {
      err = 'Игрок уже покинул список отказов';
      return;
    }
    const U = state.userTeamId;
    if (w.fromTeamId === U) {
      err = 'Это игрок вашего клуба';
      return;
    }
    const P = state.players;
    const p = P[playerId];
    const t = state.teams[U];
    const fromTeam = state.teams[w.fromTeamId];
    if (!p || !fromTeam) return;
    if (activeKhlCount(t.players, P) >= MAX_ROSTER) {
      err = `В основном составе ${LG()} уже ${MAX_ROSTER} игроков — сначала освободите место в основе`;
      return;
    }
    const fl = teamForeignLimit(t, state.league.foreignLimit);
    if (fl !== null && isLegionnaire(p) && countRosterLegionnaires(t.players, P) >= fl) {
      err = `Превышен лимит легионеров (${fl})`;
      return;
    }
    const afterPay = effectivePayroll(t, P, state.phase) + p.contract.salary;
    if (afterPay > state.league.salaryCap) {
      err = `Контракт ${formatMoney(p.contract.salary)} не помещается под потолок зарплат (${formatMoney(afterPay)} / ${formatMoney(state.league.salaryCap)})`;
      return;
    }
    state.waivers = (state.waivers ?? []).filter((x) => x.playerId !== playerId);
    fromTeam.players = fromTeam.players.filter((id) => id !== playerId);
    p.teamId = U;
    p.inVhl = false;
    if (isRfaEligibleAge(p.age)) p.rightsTeamId = U;
    t.players.push(playerId);
    ensureCaptains(fromTeam, P);
    ensureCaptains(t, P);
    fromTeam.lineup = autoLineup(fromTeam.players, P, lineupConstraintsFor(state, fromTeam.id));
    t.lineup = sanitizeLineup(t.lineup, t.players, P, lineupConstraintsFor(state, U));
    addNews(
      state,
      'trade',
      `Драфт отказов ${LG()}: «${t.name}» бесплатно забрала ${p.name} (${formatMoney(p.contract.salary)}) из «${fromTeam.name}»!`,
      U
    );
  });
  return err;
}

export function tenderQualifyingOffer(playerId: string): string | null {
  let err: string | null = null;
  store.update((state) => {
    err = qualifyUserRfa(state, playerId);
  });
  return err;
}

export function acquireRfaRights(playerId: string, price: number): { ok: boolean; reason: string } {
  let out: { ok: boolean; reason: string } = { ok: false, reason: '' };
  store.update((state) => {
    const p = state.players[playerId];
    const U = state.userTeamId;
    const t = state.teams[U];
    if (!p || !p.rightsTeamId || p.rightsTeamId === U || p.teamId) {
      out = { ok: false, reason: 'Спортивные права этого игрока недоступны для выкупа' };
      return;
    }
    if (t.budget < price) {
      out = { ok: false, reason: 'Недостаточно средств в бюджете клуба' };
      return;
    }
    const holder = state.teams[p.rightsTeamId];
    t.budget -= price;
    if (holder) holder.budget += price;
    p.rightsTeamId = U;
    addNews(
      state,
      'trade',
      `«${t.name}» выкупила у «${holder?.name ?? LG()}» спортивные права ОСА на ${p.name} за ${formatMoney(price)}!`,
      U
    );
    out = { ok: true, reason: `Спортивные права ОСА на ${p.name} перешли в «${t.name}»!` };
  });
  return out;
}

export function respondRfaOfferSheet(offerId: number, matchOffer: boolean): string | null {
  let err: string | null = null;
  store.update((state) => {
    const sheet = (state.rfaOffers ?? []).find((o) => o.id === offerId);
    if (!sheet) return;
    const U = state.userTeamId;
    const t = state.teams[U];
    const from = state.teams[sheet.fromTeamId];
    const p = state.players[sheet.playerId];
    if (!p || !from) {
      state.rfaOffers = (state.rfaOffers ?? []).filter((o) => o.id !== offerId);
      return;
    }
    if (matchOffer) {
      if (activeKhlCount(t.players, state.players) >= MAX_ROSTER) {
        err = `В основном составе ${LG()} уже ${MAX_ROSTER} игроков`;
        return;
      }
      const afterPay = committedPayroll(state, t) + sheet.salary;
      if (afterPay > state.league.salaryCap) {
        err = `ФОТ с этим контрактом (${formatMoney(afterPay)}) превысит потолок зарплат`;
        return;
      }
      if (t.budget < sheet.salary) {
        err = `Недостаточно средств в бюджете (${formatMoney(t.budget)})`;
        return;
      }
      p.contract = { salary: sheet.salary, years: sheet.years };
      p.teamId = U;
      p.rightsTeamId = U;
      t.players.push(p.id);
      state.freeAgents = state.freeAgents.filter((id) => id !== p.id);
      state.rfaOffers = (state.rfaOffers ?? []).filter((o) => o.id !== offerId);
      t.lineup = sanitizeLineup(t.lineup, t.players, state.players, lineupConstraintsFor(state, U));
      addNews(
        state,
        'trade',
        `«${t.name}» повторила оффершит «${from.name}» и сохранила ОСА ${p.name} (${formatMoney(sheet.salary)} × ${sheet.years} г.)!`,
        U
      );
    } else {
      p.contract = { salary: sheet.salary, years: sheet.years };
      p.teamId = from.id;
      p.rightsTeamId = from.id;
      from.players.push(p.id);
      from.budget = Math.max(0, from.budget - sheet.compensation);
      t.budget += sheet.compensation;
      state.freeAgents = state.freeAgents.filter((id) => id !== p.id);
      state.rfaOffers = (state.rfaOffers ?? []).filter((o) => o.id !== offerId);
      from.lineup = autoLineup(from.players, state.players, lineupConstraintsFor(state, from.id));
      addNews(
        state,
        'trade',
        `ОСА ${p.name} переходит в «${from.name}» по оффершиту; «${t.name}» получает денежную компенсацию ${formatMoney(sheet.compensation)}!`,
        U
      );
    }
  });
  return err;
}

/* ---------------- junior draft & hall of fame ---------------- */
export function pickJuniorProspect(prospectId?: string): string | null {
  let pickedName: string | null = null;
  store.update((state) => {
    const draft = state.offseason?.draft;
    if (!draft || draft.completed) return;
    if (currentDraftTeamId(draft) !== state.userTeamId) {
      advanceAiDraftToUser(state, draft);
    }
    if (currentDraftTeamId(draft) !== state.userTeamId) return;
    const rec = executeSingleDraftPick(state, draft, prospectId);
    if (rec) {
      const p = state.players[rec.playerId];
      pickedName = p?.name ?? null;
      if (p) {
        addNews(
          state,
          'milestone',
          `Ярмарка юниоров ${LG()} (раунд ${rec.round}, пик #${rec.overallPick}): «${state.teams[state.userTeamId].name}» выбирает ${p.name} (${p.age} л., ОВР ${p.overall}, пот. ${p.potential})!`,
          state.userTeamId
        );
      }
    }
    advanceAiDraftToUser(state, draft);
  });
  return pickedName;
}

export function finishJuniorDraftAuto() {
  store.update((state) => {
    const draft = state.offseason?.draft;
    if (!draft || draft.completed) return;
    const beforeLen = draft.picks.length;
    autoCompleteDraft(state, draft);
    const userNew = draft.picks.slice(beforeLen).filter((pk) => pk.teamId === state.userTeamId);
    if (userNew.length) {
      const namesList = userNew.map((pk) => state.players[pk.playerId]?.name).filter(Boolean).join(', ');
      addNews(state, 'milestone', `Автовыбор Ярмарки юниоров ${LG()}: в систему клуба зачислены ${namesList}.`, state.userTeamId);
    }
  });
}

export function toggleHallOfFameJersey(entryId: string) {
  store.update((state) => {
    const item = (state.hallOfFame ?? []).find((h) => h.id === entryId);
    if (item && item.teamId === state.userTeamId) {
      item.jerseyRetired = !item.jerseyRetired;
    }
  });
}

/** Terminate a contract. The club pays severance (see buyoutCost) and absorbs 20% dead cap for the rest of the season. Returns an error text or null. */
export function releasePlayer(id: string): string | null {
  let err: string | null = null;
  store.update((state) => {
    const p = state.players[id];
    const U = state.userTeamId;
    if (!p || p.teamId !== U) return;
    const t = state.teams[U];
    const cost = buyoutCost(state, p);
    if (t.budget < cost) {
      err = `На компенсацию нужно ${formatMoney(cost)}, а в бюджете ${formatMoney(t.budget)}`;
      return;
    }
    const dead = state.phase !== 'offseason' && p.contract.years > 0 ? buyoutDeadCap(p.contract.salary) : 0;
    t.budget -= cost;
    if (dead > 0) t.deadCap = (t.deadCap ?? 0) + dead;
    toFreeAgency(state, id);
    if (state.offseason) state.offseason.expiring = state.offseason.expiring.filter((x) => x !== id);
    const deadNote = dead > 0 ? ` («мёртвые деньги» под потолком: ${formatMoney(dead)})` : '';
    addNews(state, 'trade', `${t.name} расторгает контракт с ${p.name}${cost > 0 ? `; компенсация игроку — ${formatMoney(cost)}${deadNote}` : ''}`, U);
  });
  return err;
}

export function letGo(id: string) {
  store.update((state) => letGoUser(state, id));
}
export function startNewSeason() {
  store.update((state) => beginNewSeason(state));
}

/* ---------------- KHL LTIR (ДСБТ), Playoff «На уколах» & Club Facilities ---------------- */

export function placePlayerInLtir(playerId: string): string | null {
  let err: string | null = null;
  store.update((state) => {
    const U = state.userTeamId;
    const p = state.players[playerId];
    const t = state.teams[U];
    if (!p || p.teamId !== U) {
      err = 'Игрок не принадлежит вашему клубу';
      return;
    }
    if (state.phase === 'offseason') {
      err = 'В межсезонье список травмированных не действует';
      return;
    }
    if (!canPlaceInLtir(p)) {
      err = `В ДСБТ ${LG()} можно перевести только игрока с травмой от ${LTIR_MIN_DAYS} дней`;
      return;
    }
    p.inLtir = true;
    p.playingThroughInjury = false;
    t.lineup = sanitizeLineup(t.lineup, t.players, state.players, lineupConstraintsFor(state, U));
    addNews(
      state,
      'injury',
      `${p.name} переведён в ДСБТ ${LG()}: его зарплата (${formatMoney(p.contract.salary)}) временно выведена из-под потолка зарплат.`,
      U
    );
  });
  return err;
}

export function activatePlayerFromLtir(playerId: string): string | null {
  let err: string | null = null;
  store.update((state) => {
    const U = state.userTeamId;
    const p = state.players[playerId];
    const t = state.teams[U];
    if (!p || p.teamId !== U || !p.inLtir) return;
    if (p.injury && p.injury.days > 0) {
      err = `${p.name} ещё восстанавливается (${formatInjuryDays(p.injury.days)}) — вывести из ДСБТ можно после выздоровления`;
      return;
    }
    if (activeKhlCount(t.players, state.players) >= MAX_ROSTER) {
      err = `В основном составе ${LG()} уже ${MAX_ROSTER} игроков — сначала отправьте кого-нибудь в ВХЛ или освободите место`;
      return;
    }
    const fl = teamForeignLimit(t, state.league.foreignLimit);
    if (fl !== null && isLegionnaire(p) && countRosterLegionnaires(t.players, state.players) >= fl) {
      err = `Нельзя вывести легионера из ДСБТ: в основе ${LG()} уже ${fl} из ${fl} иностранцев`;
      return;
    }
    p.inLtir = false;
    const excess = capExcess(state, U);
    if (excess > 0) {
      p.inLtir = true;
      err = `Нельзя вывести ${p.name} из ДСБТ: ФОТ превысит потолок ${LG()} на ${formatMoney(excess)}. Сначала освободите место (перевод в ВХЛ, обмен или выкуп).`;
      return;
    }
    t.lineup = sanitizeLineup(t.lineup, t.players, state.players, lineupConstraintsFor(state, U));
    addNews(state, 'injury', `${p.name} выведен из ДСБТ ${LG()} и снова доступен для заявки на матчи.`, U);
  });
  return err;
}

export function togglePlayThroughInjury(playerId: string): string | null {
  let err: string | null = null;
  store.update((state) => {
    const U = state.userTeamId;
    const p = state.players[playerId];
    const t = state.teams[U];
    if (!p || p.teamId !== U) return;
    if (p.playingThroughInjury) {
      p.playingThroughInjury = false;
      t.lineup = sanitizeLineup(t.lineup, t.players, state.players, lineupConstraintsFor(state, U));
      return;
    }
    if (!canPlayThroughInjury(p, state.phase)) {
      err = `Выход «на уколах» доступен только в плей-офф Кубка Гагарина при лёгкой травме (до ${PLAY_THROUGH_MAX_DAYS} дн.)`;
      return;
    }
    p.playingThroughInjury = true;
    t.lineup = sanitizeLineup(t.lineup, t.players, state.players, lineupConstraintsFor(state, U));
    addNews(
      state,
      'injury',
      `Кубок Гагарина: врачи допустили ${p.name} к игре «на уколах» (штраф −3 к навыкам, повышенный риск рецидива).`,
      U
    );
  });
  return err;
}

export function upgradeClubFacility(key: FacilityKey): string | null {
  let err: string | null = null;
  store.update((state) => {
    const U = state.userTeamId;
    const t = state.teams[U];
    const fac = ensureFacilities(t);
    const cur = fac[key];
    const cost = facilityUpgradeCost(cur);
    if (cost === null) {
      err = 'Этот отдел уже модернизирован до максимального 5-го уровня';
      return;
    }
    if (t.budget < cost) {
      err = `Недостаточно средств в бюджете клуба: нужно ${formatMoney(cost)}, доступно ${formatMoney(t.budget)}`;
      return;
    }
    t.budget -= cost;
    fac[key] = cur + 1;
    if (state.board) {
      state.board.confidence = clamp(state.board.confidence + 2, 5, 100);
    }
    const meta = FACILITY_META.find((m) => m.key === key);
    addNews(
      state,
      'milestone',
      `Модернизация клуба: «${meta?.title ?? key}» повышен до Ур. ${fac[key]} (−${formatMoney(cost)}). ${meta ? meta.effectLabel(fac[key]) : ''}`,
      U
    );
  });
  return err;
}

export { emptyLineup, emptyRecord, sanitizeLineup, autoLineup, prepareLineup };
