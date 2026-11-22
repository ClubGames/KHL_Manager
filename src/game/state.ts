import { useSyncExternalStore } from 'react';
import type { Award, Game, GameResult, GameState, Lineup, NewsItem, NewsType, Series, Team } from '../types';
import { buildSchedule } from './schedule';
import { GameSim, INJURY_TYPES, pick } from './engine';
import { autoLineup, clubSideProblem, evaluateTrade, executeTrade, MAX_ROSTER, maybeAiTrade, maybeIncomingOffer, prepareLineup, sanitizeLineup, tradeWindow, userSideProblem } from './ai';
import { buyoutCost, commitments, negotiate, talksLeft } from './contracts';
import { evaluateBoard, setBoardGoal } from './board';
import { beginNewSeason, letGoUser, startOffseason, toFreeAgency } from './offseason';
import { clamp, formatMoney, isDefense, isGoalie, isSkater, payroll, points } from './ratings';
import { emptyLineup, emptyRecord } from './defaults';
import type { NormalizedRoster } from './roster';
import { clearLegacy, deleteSave, getBackend, listMetas, readLegacy, readSave, storageError, writeSave } from './storage';
import type { SaveMeta } from './storage';

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
    this.emit();
    this.scheduleSave();
  }
  /** Replace the active career (or close it with null). Call flush() first if the current one must be kept. */
  set(s: GameState | null) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.state = s;
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

/** Copy of the state that is written to disk: play-by-play and per-skater game lines are dropped (kept only in memory). */
export function snapshot(s: GameState): GameState {
  return {
    ...s,
    schedule: s.schedule.map((day) =>
      day.map((g) => {
        const r = g.result;
        if (!r) return g;
        const lines: GameResult['lines'] = {};
        for (const gid of [r.homeGoalie, r.awayGoalie]) if (gid && r.lines[gid]) lines[gid] = r.lines[gid];
        return { ...g, result: { ...r, events: [], homeDressed: [], awayDressed: [], lines } };
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
    league: s.league.name,
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
  if (s.playoffs && !s.playoffs.awards) s.playoffs.awards = [];
  // Points are derived from the record, so saves made under the old 3-point rule are converted automatically.
  for (const t of Object.values(s.teams)) {
    const r = t.record;
    r.points = 2 * (r.w + r.otw + r.sow) + r.otl + r.sol;
  }
  for (const day of s.schedule)
    for (const g of day)
      if (g.result) {
        g.result.events ??= [];
        g.result.lines ??= {};
        g.result.homeDressed ??= [];
        g.result.awayDressed ??= [];
      }
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
  const teamOrder = r.teams.map((t) => t.id);
  const { days, nextId } = buildSchedule(teamOrder, r.gamesPerTeam, 1);
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
    league: { name: r.leagueName, season: r.season, gamesPerTeam: r.gamesPerTeam, salaryCap: r.salaryCap },
    seasonNumber: 1,
    teams,
    teamOrder,
    players: r.players,
    freeAgents: r.freeAgents,
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
  } as unknown as GameState;
  setBoardGoal(state);
  news[0].text += ` Задача руководства на сезон: ${state.board.text.toLowerCase()}.`;
  return state;
}

/* ---------------- careers & save slots ---------------- */
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
  return listMetas();
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
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `khl-gm-${st.teams[st.userTeamId].id}-${st.league.season.replace('/', '-')}-day${st.day + 1}.json`;
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
  if (!st) return 'Это не файл сохранения КХЛ ГМ (возможно, вы выбрали roster.json — он загружается в разделе «Новая карьера»)';
  try {
    st.saveId = newId();
    await writeSave(buildMeta(st), snapshot(st));
    return null;
  } catch (e) {
    return storageError(e);
  }
}

export { getBackend };

/* ---------------- lineups ---------------- */
export function setUserLineup(L: Lineup) {
  store.update((s) => {
    s.teams[s.userTeamId].lineup = L;
  });
}
export function autoFillLineup() {
  store.update((s) => {
    const t = s.teams[s.userTeamId];
    t.lineup = autoLineup(t.players, s.players);
  });
}

/* ---------------- simulation ---------------- */
function runGame(state: GameState, g: Game): GameResult {
  const home = prepareLineup(state, g.home);
  const away = prepareLineup(state, g.away);
  const sim = new GameSim({ id: g.home, lineup: home, name: state.teams[g.home].name }, { id: g.away, lineup: away, name: state.teams[g.away].name }, state.players, g.kind === 'playoff');
  // simulated games are never replayed, so no play-by-play is generated for them
  sim.quiet = true;
  return sim.runAll();
}

export function makeUserSim(state: GameState, g: Game): { sim: GameSim; home: Lineup; away: Lineup } {
  const home = prepareLineup(state, g.home);
  const away = prepareLineup(state, g.away);
  const sim = new GameSim({ id: g.home, lineup: home, name: state.teams[g.home].name }, { id: g.away, lineup: away, name: state.teams[g.away].name }, state.players, g.kind === 'playoff');
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
  if (g.kind === 'regular') {
    applyRecord(H, res.homeScore, res.awayScore, beyond, res.so, hw);
    applyRecord(A, res.awayScore, res.homeScore, beyond, res.so, !hw);
  }
  const winnerId = hw ? g.home : g.away;
  for (const id in res.lines) {
    const l = res.lines[id];
    const p = P[id];
    if (!p) continue;
    const ti = res.homeDressed.includes(id) ? g.home : g.away;
    const won = ti === winnerId;
    if (isGoalie(p) && l.minutes === 0) continue;
    p.stats.gp++;
    p.stats.goals += l.goals;
    p.stats.assists += l.assists;
    p.stats.plusMinus += l.plusMinus;
    p.stats.pim += l.pim;
    p.stats.shots += l.shots;
    if (isGoalie(p)) {
      p.stats.minutes += l.minutes;
      p.stats.saves += l.saves;
      p.stats.shotsAgainst += l.shotsAgainst;
      if (won) p.stats.wins++;
      else if (beyond) p.stats.otl++;
      else p.stats.losses++;
      if (won && l.goalsAgainst === 0 && l.minutes >= 55) p.stats.shutouts++;
    }
    p.morale = clamp(p.morale + (won ? 3 : beyond ? -1 : -3) + l.goals * 2 + l.assists, 30, 99);
  }
  for (const tid of [g.home, g.away]) {
    const dressed = tid === g.home ? res.homeDressed : res.awayDressed;
    for (const pid of dressed) {
      const p = P[pid];
      if (!p || p.injury) continue;
      const ch = isGoalie(p) ? 0.005 : 0.011 + (p.age >= 32 ? 0.004 : 0);
      if (Math.random() < ch) {
        p.injury = { name: pick(INJURY_TYPES), games: 2 + Math.floor(Math.random() * 9) };
        if (tid === U) addNews(state, 'injury', `Травма: ${p.name} — ${p.injury.name}, ориентировочно ${p.injury.games} матчей`, tid);
      }
    }
    for (const pid of state.teams[tid].players) {
      const p = P[pid];
      if (p?.injury) {
        p.injury.games -= 1;
        if (p.injury.games <= 0) {
          p.injury = null;
          if (tid === U) addNews(state, 'injury', `${p.name} восстановился и готов играть`, tid);
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
    addNews(state, 'result', `${H.short} ${res.homeScore}:${res.awayScore}${tag} ${A.short}. Броски ${res.homeStats.shots}:${res.awayStats.shots}. Звёзды: ${stars || '—'}`, U, g.id);
  }
}

function postDay(state: GameState) {
  if (state.phase === 'season' && !state.deadlinePassed && !tradeWindow(state).open) {
    state.deadlinePassed = true;
    state.offers = [];
    addNews(state, 'trade', 'Дедлайн обменов прошёл: до межсезонья усиливаться можно только свободными агентами.');
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

export function simulateDays(n: number) {
  for (let i = 0; i < n; i++) {
    if (!store.get()) return;
    simulateDay(true);
  }
}

export function simulateToNextUserGame(): 'userGame' | 'offseason' {
  let result: 'userGame' | 'offseason' = 'offseason';
  store.update((state) => {
    const U = state.userTeamId;
    for (let i = 0; i < 600; i++) {
      if (state.phase === 'offseason') return;
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
  let userRev = 0;
  let userPay = 0;
  for (const t of Object.values(state.teams)) {
    let rev = 400_000_000 + t.record.points * 8_500_000;
    rev += po.series.filter((s) => s.high === t.id || s.low === t.id).length * 40_000_000;
    if (t.id === champId) rev += 100_000_000;
    if (regular.id === t.id) rev += 50_000_000;
    const pay = payroll(t.players, P);
    t.budget += rev - pay;
    if (t.id === state.userTeamId) {
      userRev = rev;
      userPay = pay;
    }
  }
  if (champId === U.id) state.trophies.push({ season: state.league.season, title: 'Кубок Гагарина' });
  if (regular.id === U.id) state.trophies.push({ season: state.league.season, title: 'Кубок Контина' });
  const finalSeries = po.series.find((s) => s.round === 3)!;
  const loser = state.teams[champId === finalSeries.high ? finalSeries.low : finalSeries.high];
  const place = rankConference(state, U.conference).indexOf(U) + 1;
  const verdict = evaluateBoard(state, { place, madePlayoffs: userSeries.length > 0, roundsWon: userSeries.filter((x) => x.winner === U.id).length });
  U.budget += verdict.bonus;
  state.summaries.push({ season: state.league.season, champion: champId, regularWinner: regular.id, userResult, userPoints: U.record.points, userPlace: place, awards: po.awards, revenue: userRev, payroll: userPay, board: verdict.text, boardBonus: verdict.bonus });
  addNews(state, 'info', `${verdict.text}${verdict.bonus > 0 ? ` Премиальные клубу: ${formatMoney(verdict.bonus)}.` : ''} Финансы сезона: доходы ${formatMoney(userRev)}, зарплаты ${formatMoney(userPay)}.`, U.id);
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

export function proposeTrade(partnerId: string, give: string[], get: string[]): { ok: boolean; reason: string } {
  let out: { ok: boolean; reason: string } = { ok: false, reason: '' };
  store.update((state) => {
    const U = state.userTeamId;
    const user = state.teams[U];
    const w = tradeWindow(state);
    if (!w.open) {
      out = { ok: false, reason: w.text };
      return;
    }
    if (!give.length || !get.length) {
      out = { ok: false, reason: 'Добавьте игроков с обеих сторон' };
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
    const ev = evaluateTrade(state, partnerId, give, get);
    if (!ev.ok) {
      out = ev;
      return;
    }
    executeTrade(state, U, partnerId, give, get);
    addNews(state, 'trade', `Обмен с ${state.teams[partnerId].name}: в ${user.name} — ${names(state, get)}, в ${state.teams[partnerId].short} — ${names(state, give)}`, U);
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
export function setTradeFlag(id: string, flag: 'block' | 'keep' | null) {
  store.update((state) => {
    const p = state.players[id];
    if (!p || p.teamId !== state.userTeamId) return;
    if (flag) p.tradeFlag = flag;
    else delete p.tradeFlag;
  });
}

/* ---------------- contracts ---------------- */
/** Salaries the club is committed to: in the off-season expired deals no longer count. */
function committedPayroll(state: GameState, ids: string[]): number {
  const P = state.players;
  return state.phase === 'offseason' ? ids.reduce((a, id) => a + (P[id].contract.years > 0 ? P[id].contract.salary : 0), 0) : payroll(ids, P);
}

export interface ContractAnswer {
  ok: boolean;
  text: string;
  /** negotiation attempts left with this player */
  left: number;
}

/**
 * Offer a contract: to a free agent, to an own player whose deal has expired (off-season) or to an own
 * player in the last year of his deal (the extension starts next season).
 */
export function offerContract(id: string, salary: number, years: number): ContractAnswer {
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
    if (!free && !own) return fail('Игрок принадлежит другому клубу — его можно получить только обменом');
    if (!(salary > 0) || years < 1) return fail('Укажите оклад и срок контракта');
    const expired = own && p.contract.years === 0;
    const extension = own && p.contract.years === 1;
    if (own && !expired && !extension) return fail(`Контракт действует ещё ${p.contract.years} сезона — продлевать его можно в последний год`);
    if (own && p.contract.next) return fail('Контракт этого игрока уже продлён');
    const cap = state.league.salaryCap;
    if (free && t.players.length >= MAX_ROSTER) return fail(`В составе уже ${MAX_ROSTER} игроков — больше заявить нельзя`);
    if (extension) {
      const next = commitments(t.players, P, 2)[1] + salary;
      if (next > cap) return fail(`Со следующего сезона ФОТ составит ${formatMoney(next)} — это выше потолка зарплат (${formatMoney(cap)})`);
    } else {
      const now = committedPayroll(state, t.players) + salary;
      if (now > cap) return fail(`С этим окладом ФОТ составит ${formatMoney(now)} — это выше потолка зарплат (${formatMoney(cap)})`);
    }
    if (t.budget < salary) return fail(`В бюджете клуба должно быть не меньше годового оклада игрока (${formatMoney(salary)}), сейчас — ${formatMoney(t.budget)}`);
    const v = negotiate(state, p, salary, years, t.id);
    if (!v.accept) {
      out = { ok: false, text: v.text, left: v.left };
      return;
    }
    delete p.talks;
    const term = `${years} ${years === 1 ? 'год' : years < 5 ? 'года' : 'лет'}, ${formatMoney(salary)} за сезон`;
    if (free) {
      p.contract = { salary, years };
      p.teamId = t.id;
      t.players.push(id);
      state.freeAgents = state.freeAgents.filter((x) => x !== id);
      t.lineup = sanitizeLineup(t.lineup, t.players, P);
      addNews(state, 'trade', `${t.name} подписывает свободного агента ${p.name}: ${term}`, t.id);
      out = { ok: true, text: `${p.name} подписал контракт: ${term}.`, left: v.left };
    } else if (expired) {
      p.contract = { salary, years };
      if (state.offseason) state.offseason.expiring = state.offseason.expiring.filter((x) => x !== id);
      addNews(state, 'trade', `${p.name} остаётся в ${t.name}: новый контракт на ${term}`, t.id);
      out = { ok: true, text: `${p.name} подписал новый контракт: ${term}.`, left: v.left };
    } else {
      p.contract.next = { salary, years };
      p.morale = clamp(p.morale + 5, 30, 99);
      addNews(state, 'trade', `${p.name} продлил контракт с ${t.name}: со следующего сезона — ${term}`, t.id);
      out = { ok: true, text: `${p.name} продлил контракт: со следующего сезона — ${term}.`, left: v.left };
    }
  });
  return out;
}

/** Terminate a contract. The club pays severance (see buyoutCost). Returns an error text or null. */
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
    t.budget -= cost;
    toFreeAgency(state, id);
    if (state.offseason) state.offseason.expiring = state.offseason.expiring.filter((x) => x !== id);
    addNews(state, 'trade', `${t.name} расторгает контракт с ${p.name}${cost > 0 ? `; компенсация игроку — ${formatMoney(cost)}` : ''}`, U);
  });
  return err;
}

export function letGo(id: string) {
  store.update((state) => letGoUser(state, id));
}
export function startNewSeason() {
  store.update((state) => beginNewSeason(state));
}

export { emptyLineup, emptyRecord, sanitizeLineup, autoLineup, prepareLineup };
