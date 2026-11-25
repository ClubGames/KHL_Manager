import type { ClubEvent, ClubEventKind, Game, GameResult, GameState, Lineup, Player, PressEffect, PressOption, RoomMemory, RoomPromise, RoomPromiseKind, RoomPromiseSpec, Team } from '../types';
import { clamp, fairSalary, formatMoney, isDefense, isForward, isGoalie, points } from './ratings';
import { isLegionnaire } from './legionnaires';
import { assignTeamRole } from './chemistry';
import { LG } from '../brand';

/**
 * The dressing room: players come with wishes, get into conflicts, agents call, fans and the city want
 * something from the club. Every situation is a decision with consequences for morale, the owners, the
 * stands and the budget — and some answers are promises the dressing room remembers: kept, they build
 * trust; broken, they come back as conflicts and as questions at press conferences.
 */

/* ---------------- memory ---------------- */
export function roomMemory(s: GameState): RoomMemory {
  s.roomMemory ??= { cool: {}, tags: {}, seq: 1 };
  return s.roomMemory;
}
export const remember = (s: GameState, tag: string) => { roomMemory(s).tags[tag] = s.day; };
/** Day the tag was last remembered within `days`, or null. */
export function recalled(s: GameState, tag: string, days = 30): number | null {
  const d = roomMemory(s).tags[tag];
  return d !== undefined && s.day - d <= days ? d : null;
}
/** Remembered tags starting with `prefix` within `days` (e.g. every 'broken:' promise). */
export function recalledAll(s: GameState, prefix: string, days = 30): string[] {
  const t = roomMemory(s).tags;
  return Object.keys(t).filter((k) => k.startsWith(prefix) && s.day - t[k] <= days);
}
const forget = (s: GameState, tag: string) => { delete roomMemory(s).tags[tag]; };

export const lastName = (p: Pick<Player, 'name'> | undefined) => (p?.name ?? 'игрок').split(' ').slice(-1)[0];
export const fx = (e: Partial<PressEffect> = {}): PressEffect => ({ morale: 0, board: 0, fans: 0, ...e });
const opt = (id: string, text: string, effects: PressEffect, hint?: string): PressOption => ({ id, text, effects, ...(hint ? { hint } : {}) });
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

/* ---------------- effects ---------------- */
/** Apply an answer's effects to the user's club. Returns short human-readable parts for the news. */
export function applyEffects(state: GameState, e: PressEffect): string[] {
  const T = state.teams[state.userTeamId];
  const P = state.players;
  const parts: string[] = [];
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  const per: Record<string, number> = { ...(e.players ?? {}) };
  if (e.playerId && e.playerMorale) per[e.playerId] = (per[e.playerId] ?? 0) + e.playerMorale;
  for (const id of T.players) {
    const p = P[id];
    if (!p) continue;
    const d = (e.morale ?? 0) + (per[id] ?? 0);
    if (d) p.morale = clamp(p.morale + d, 25, 99);
    if (e.rest) p.fatigue = Math.max(0, (p.fatigue ?? 0) - e.rest);
  }
  if (e.morale) parts.push(`мораль ${sign(e.morale)}`);
  if (e.board && state.board) { state.board.confidence = clamp(state.board.confidence + e.board, 5, 100); parts.push(`доверие руководства ${sign(e.board)}`); }
  if (e.fans) { state.fans = clamp((state.fans ?? 60) + e.fans, 0, 100); parts.push(`болельщики ${sign(e.fans)}`); }
  for (const id in per) if (per[id] && P[id]) parts.push(`${P[id].name} ${sign(per[id])}`);
  if (e.budget) { T.budget += e.budget; parts.push(`бюджет ${e.budget > 0 ? '+' : ''}${formatMoney(e.budget)}`); }
  const p = e.playerId ? P[e.playerId] : undefined;
  if (p && p.teamId === T.id) {
    if (e.tradeFlag !== undefined) { if (e.tradeFlag) p.tradeFlag = e.tradeFlag; else delete p.tradeFlag; parts.push(e.tradeFlag === 'block' ? `${lastName(p)} выставлен на обмен` : e.tradeFlag === 'keep' ? `${lastName(p)} — «не продаётся»` : `${lastName(p)} снят с обмена`); }
    if (e.role && !isGoalie(p)) { assignTeamRole(T, P, p.id, e.role); parts.push(`${lastName(p)} — ${e.role === 'C' ? 'капитан' : 'ассистент капитана'}`); }
    if (e.trainingXp) p.trainingXp = (p.trainingXp ?? 0) + e.trainingXp;
  }
  if (e.rest) parts.push('нагрузки снижены');
  if (e.promise) { const pr = makePromise(state, e.promise); if (pr) parts.push(`обещание: ${promiseLabel(state, pr)}`); }
  if (e.tag) remember(state, e.tag);
  return parts;
}

/* ---------------- promises ---------------- */
const RULES: Record<RoomPromiseKind, { games: number; days: number; ratio: number }> = {
  role: { games: 6, days: 28, ratio: 0.6 },
  pp: { games: 6, days: 28, ratio: 0.6 },
  starts: { games: 8, days: 35, ratio: 0.4 },
  dress: { games: 6, days: 28, ratio: 0.6 },
  rest: { games: 1, days: 10, ratio: 1 },
  scratch: { games: 1, days: 10, ratio: 1 },
  linemate: { games: 6, days: 28, ratio: 0.6 },
  extend: { games: 0, days: 30, ratio: 1 },
  callup: { games: 0, days: 14, ratio: 1 },
};
const contractScore = (p: Player) => p.contract.years * 10 + (p.contract.next ? 100 + p.contract.next.years * 10 : 0);

export function makePromise(state: GameState, spec: RoomPromiseSpec): RoomPromise | null {
  const p = state.players[spec.playerId];
  if (!p) return null;
  state.roomPromises ??= [];
  // a new promise of the same kind to the same player replaces the old one
  state.roomPromises = state.roomPromises.filter((x) => !(x.playerId === spec.playerId && x.kind === spec.kind));
  const r = RULES[spec.kind];
  const pr: RoomPromise = { ...spec, id: roomMemory(state).seq++, made: state.day, due: state.day + r.days, target: r.games, played: 0, hits: 0, ...(spec.kind === 'extend' ? { base: contractScore(p) } : {}) };
  state.roomPromises.push(pr);
  return pr;
}

export function promiseLabel(state: GameState, pr: RoomPromiseSpec): string {
  const p = state.players[pr.playerId], o = pr.otherId ? state.players[pr.otherId] : undefined;
  const n = lastName(p);
  switch (pr.kind) {
    case 'role': return p && isGoalie(p) ? `${n} — основной вратарь` : `${n} — в первых звеньях`;
    case 'pp': return `${n} — в большинстве`;
    case 'starts': return `${n} — больше матчей в воротах`;
    case 'dress': return `${n} — место в составе`;
    case 'rest': return `${n} — матч отдыха`;
    case 'scratch': return `${n} пропускает матч (наказание)`;
    case 'linemate': return `${n} и ${lastName(o)} — в одном звене`;
    case 'extend': return `${n} — продление контракта`;
    case 'callup': return `${n} — вызов из ВХЛ`;
  }
}

/** Was the promise honoured in this game (lineup as dressed)? */
function honoured(pr: RoomPromise, L: Lineup, dressed: Set<string>, goalie: string | null, p: Player): boolean {
  const id = pr.playerId;
  const inF = (k: number[]) => k.some((i) => (L.F[i] ?? []).includes(id));
  const inD = (k: number[]) => k.some((i) => (L.D[i] ?? []).includes(id));
  switch (pr.kind) {
    case 'role': return isGoalie(p) ? goalie === id : isDefense(p) ? inD([0, 1]) : inF([0, 1]);
    case 'pp': return [...(L.pp1 ?? []), ...(L.pp2 ?? [])].includes(id);
    case 'starts': return goalie === id;
    case 'dress': return dressed.has(id);
    case 'rest': case 'scratch': return !dressed.has(id);
    case 'linemate': {
      const o = pr.otherId;
      return !!o && [...L.F, ...L.D].some((u) => u.includes(id) && u.includes(o));
    }
    default: return false;
  }
}

/** After every user game: count the games each promise was (not) honoured in. */
export function trackPromises(state: GameState, g: Game, res: GameResult) {
  const U = state.userTeamId;
  if (g.home !== U && g.away !== U || !state.roomPromises?.length) return;
  const home = g.home === U;
  const dressed = new Set(home ? res.homeDressed : res.awayDressed);
  const goalie = home ? res.homeGoalie : res.awayGoalie;
  const L = state.teams[U].lineup;
  for (const pr of state.roomPromises) {
    const p = state.players[pr.playerId];
    if (!p || pr.target <= 0 || p.teamId !== U || (p.injury && pr.kind !== 'rest' && pr.kind !== 'scratch')) continue;
    pr.played++;
    if (honoured(pr, L, dressed, goalie, p)) pr.hits++;
  }
}

/** Daily: judge the promises that are due. */
function stepPromises(state: GameState, say: Say) {
  const U = state.userTeamId, T = state.teams[U], P = state.players;
  const list = state.roomPromises ?? [];
  const keep: RoomPromise[] = [];
  const leaders = new Set([T.captainId, ...(T.assistantIds ?? [])].filter(Boolean) as string[]);
  const top = T.players.map((id) => P[id]).filter((p) => p && !p.inVhl).sort((a, b) => b.overall - a.overall).slice(0, 6).map((p) => p.id);
  for (const pr of list) {
    const p = P[pr.playerId];
    if (!p || p.teamId !== U) continue; // gone: nobody to keep the word to
    let verdict: boolean | null = null;
    if (pr.target > 0) {
      if (pr.played >= pr.target) verdict = pr.hits / pr.played >= RULES[pr.kind].ratio - 1e-9;
      else if (state.day > pr.due) verdict = pr.played > 0 ? pr.hits / pr.played >= RULES[pr.kind].ratio - 1e-9 : null;
      if (verdict === null && state.day > pr.due) continue; // no games (injury, break): the promise lapses quietly
    } else {
      const met = pr.kind === 'extend' ? contractScore(p) > (pr.base ?? 0) : pr.kind === 'callup' ? !p.inVhl : false;
      if (met) verdict = true;
      else if (state.day > pr.due) verdict = false;
    }
    if (verdict === null) { keep.push(pr); continue; }
    const what = promiseLabel(state, pr);
    if (pr.kind === 'scratch') {
      if (verdict) { applyEffects(state, fx({ morale: 1, board: 1 })); say(`Дисциплина: ${p.name} пропустил матч, как и было решено. Раздевалка восприняла это всерьёз.`); }
      else { applyEffects(state, fx({ morale: -2, board: -2 })); say(`${p.name} вышел на лёд, хотя был наказан. В команде говорят о двойных стандартах.`); remember(state, `double:${p.id}`); }
      continue;
    }
    if (verdict) {
      applyEffects(state, fx({ morale: 1, playerId: p.id, playerMorale: 8 }));
      forget(state, `broken:${p.id}`);
      remember(state, `kept:${p.id}`);
      say(`Слово сдержано (${what}). ${p.name} благодарен, в раздевалке это заметили.`);
    } else {
      const leader = leaders.has(p.id) || top.includes(p.id);
      applyEffects(state, fx({ morale: leader ? -2 : -1, playerId: p.id, playerMorale: -14 }));
      remember(state, `broken:${p.id}`);
      say(`Обещание не выполнено (${what}). ${p.name} разочарован${leader ? ', а он — один из лидеров раздевалки' : ''}.`);
    }
  }
  state.roomPromises = keep;
}

/** News lines go to the caller (state.ts owns the news feed). */
export type Say = (text: string) => void;

/* ---------------- situations ---------------- */
interface Ctx {
  s: GameState;
  T: Team;
  P: Record<string, Player>;
  L: Lineup;
  /** KHL roster (no VHL) and VHL players */
  mine: Player[];
  vhl: Player[];
  healthy: Player[];
  dressed: Set<string>;
  last: { won: boolean; res: GameResult; dressed: Set<string>; opp: Team } | null;
  skRank: Map<string, number>;
  fwdTop: Set<string>;
  dTop: Set<string>;
  pp: Set<string>;
  promised: Set<string>;
}
type Gen = { key: string; kind: ClubEventKind; weight: (c: Ctx) => number; build: (c: Ctx) => Omit<ClubEvent, 'id' | 'day' | 'expires' | 'key' | 'kind'> | null };

function context(s: GameState): Ctx {
  const T = s.teams[s.userTeamId], P = s.players, L = T.lineup;
  const all = T.players.map((id) => P[id]).filter(Boolean);
  const mine = all.filter((p) => !p.inVhl), vhl = all.filter((p) => p.inVhl);
  const healthy = mine.filter((p) => !p.injury);
  const dressed = new Set<string>([...L.F.flat(), ...L.D.flat(), L.starterG, L.backupG].filter(Boolean) as string[]);
  let last: Ctx['last'] = null;
  for (let d = s.day - 1; d >= Math.max(0, s.day - 4) && !last; d--) {
    const g = (s.schedule[d] ?? []).find((x) => x.played && x.result && (x.home === T.id || x.away === T.id));
    if (g?.result) {
      const home = g.home === T.id, r = g.result;
      last = { won: home ? r.homeScore > r.awayScore : r.awayScore > r.homeScore, res: r, dressed: new Set(home ? r.homeDressed : r.awayDressed), opp: s.teams[home ? g.away : g.home] };
    }
  }
  const sk = mine.filter((p) => !isGoalie(p)).sort((a, b) => b.overall - a.overall);
  return {
    s, T, P, L, mine, vhl, healthy, dressed, last,
    skRank: new Map(sk.map((p, i) => [p.id, i])),
    fwdTop: new Set((L.F.slice(0, 2).flat().filter(Boolean)) as string[]),
    dTop: new Set((L.D.slice(0, 2).flat().filter(Boolean)) as string[]),
    pp: new Set([...(L.pp1 ?? []), ...(L.pp2 ?? [])].filter(Boolean) as string[]),
    promised: new Set((s.roomPromises ?? []).map((x) => x.playerId)),
  };
}
const fresh = (c: Ctx, p: Player) => { const d = roomMemory(c.s).cool[`p:${p.id}`]; return d === undefined || c.s.day - d > 15; };
const free = (c: Ctx, ps: Player[]) => ps.filter((p) => fresh(c, p) && !c.promised.has(p.id));
const topRole = (c: Ctx, p: Player) => (isDefense(p) ? c.dTop.has(p.id) : c.fwdTop.has(p.id));
const rank = (c: Ctx, p: Player) => c.skRank.get(p.id) ?? 99;
const fine = (p: Player) => clamp(Math.round(p.contract.salary * 0.02 / 100_000) * 100_000, 300_000, 3_000_000);
const lostLast = (c: Ctx) => !!c.last && !c.last.won;
const cand = (c: Ctx, f: (p: Player) => boolean) => free(c, c.healthy).filter(f);

const GENS: Gen[] = [
  /* ---- wishes ---- */
  {
    key: 'wish-role', kind: 'wish',
    weight: (c) => (cand(c, (p) => !isGoalie(p) && rank(c, p) < (isDefense(p) ? 7 : 9) && !topRole(c, p)).length ? 3 : 0),
    build: (c) => {
      const p = pick(cand(c, (p) => !isGoalie(p) && rank(c, p) < (isDefense(p) ? 7 : 9) && !topRole(c, p)));
      const n = lastName(p);
      return {
        title: `${p.name} просит большую роль`,
        text: pick([
          `${p.name} зашёл к вам в кабинет: «Я готов играть больше. Дайте мне шанс в первых ${isDefense(p) ? 'парах' : 'звеньях'} — я не подведу».`,
          `${n} после тренировки задержался у тренерской: «Мне тесно в нынешней роли. Я хочу играть в топ-${isDefense(p) ? '4' : '6'}».`,
          `Агент ${p.name} передал: игрок считает, что заслуживает места в первых ${isDefense(p) ? 'парах' : 'звеньях'}, и ждёт разговора.`,
        ]),
        playerIds: [p.id],
        options: [
          opt('promise', `Обещаю: в ближайших матчах сыграешь в ${isDefense(p) ? 'первых парах' : 'первых звеньях'}.`, fx({ playerId: p.id, playerMorale: 6, promise: { kind: 'role', playerId: p.id } }), 'Нужно ставить его в первые звенья ~4 из 6 матчей. Не сдержите слово — будет конфликт.'),
          opt('earn', 'Место в составе надо заработать на льду. Работай — и всё будет.', fx({ playerId: p.id, playerMorale: -5, morale: 1 })),
          opt('vague', 'Мы с тренерами это обсудим. Будь готов.', fx({ playerId: p.id, playerMorale: 2, tag: `vague:${p.id}` }), 'Если он придёт снова — пустые слова не сработают.'),
        ],
        fallback: 'earn',
      };
    },
  },
  {
    key: 'wish-pp', kind: 'wish',
    weight: (c) => (cand(c, (p) => !isGoalie(p) && rank(c, p) < 10 && !c.pp.has(p.id) && (p.skills.shooting ?? 0) + (p.skills.passing ?? 0) > 140).length ? 2 : 0),
    build: (c) => {
      const p = pick(cand(c, (p) => !isGoalie(p) && rank(c, p) < 10 && !c.pp.has(p.id) && (p.skills.shooting ?? 0) + (p.skills.passing ?? 0) > 140));
      return {
        title: `${p.name} хочет играть в большинстве`,
        text: pick([
          `${p.name}: «У меня бросок и пас для большинства. Почему я сижу на скамейке, когда мы играем 5 на 4?»`,
          `${lastName(p)} спросил напрямую, что ему нужно сделать, чтобы попасть в бригаду большинства.`,
        ]),
        playerIds: [p.id],
        options: [
          opt('promise', 'Договорились: ты в бригаде большинства.', fx({ playerId: p.id, playerMorale: 5, promise: { kind: 'pp', playerId: p.id } }), 'Поставьте его в ПП1 или ПП2 хотя бы на 4 из 6 матчей.'),
          opt('even', 'Сначала покажи себя в равных составах.', fx({ playerId: p.id, playerMorale: -3 })),
          opt('staff', 'Решение за тренером по спецбригадам — поговори с ним.', fx({ playerId: p.id, playerMorale: -1, morale: 1 })),
        ],
        fallback: 'even',
      };
    },
  },
  {
    key: 'wish-starts', kind: 'wish',
    weight: (c) => {
      const b = c.L.backupG ? c.P[c.L.backupG] : null, st = c.L.starterG ? c.P[c.L.starterG] : null;
      return b && st && !b.injury && fresh(c, b) && !c.promised.has(b.id) && b.overall >= st.overall - 4 ? 2.5 : 0;
    },
    build: (c) => {
      const b = c.P[c.L.backupG!], st = c.P[c.L.starterG!];
      return {
        title: `${b.name} хочет больше играть`,
        text: pick([
          `Вратарь ${b.name}: «Я в хорошей форме и готов доказать, что могу быть первым номером. Мне нужны матчи».`,
          `${lastName(b)} недоволен ролью сменщика ${lastName(st)} и просит регулярную игровую практику.`,
        ]),
        playerIds: [b.id, st.id],
        options: [
          opt('promise', 'Получишь больше матчей — будем ротировать.', fx({ playerId: b.id, playerMorale: 6, players: { [st.id]: -3 }, promise: { kind: 'starts', playerId: b.id } }), `Выпускайте ${lastName(b)} основным хотя бы в 4 из 8 матчей.`),
          opt('two', `Первый номер — ${lastName(st)}. Твоё время придёт.`, fx({ playerId: b.id, playerMorale: -6, players: { [st.id]: 3 } })),
          opt('compete', 'Конкуренция открыта: сыграет тот, кто лучше готов.', fx({ playerId: b.id, playerMorale: 1, players: { [st.id]: -1 }, board: 1 })),
        ],
        fallback: 'two',
      };
    },
  },
  {
    key: 'wish-callup', kind: 'wish',
    weight: (c) => {
      const need = (pos: (p: Player) => boolean, n: number) => c.mine.filter(pos).sort((a, b) => b.overall - a.overall)[n - 1]?.overall ?? 0;
      return free(c, c.vhl).some((p) => !p.injury && !isGoalie(p) && p.overall >= (isDefense(p) ? need(isDefense, 6) : need(isForward, 12)) - 1) ? 2 : 0;
    },
    build: (c) => {
      const need = (pos: (p: Player) => boolean, n: number) => c.mine.filter(pos).sort((a, b) => b.overall - a.overall)[n - 1]?.overall ?? 0;
      const p = pick(free(c, c.vhl).filter((p) => !p.injury && !isGoalie(p) && p.overall >= (isDefense(p) ? need(isDefense, 6) : need(isForward, 12)) - 1));
      return {
        title: `${p.name} просится в основу`,
        text: pick([
          `${p.name} набирает очки в ВХЛ и звонит сам: «Я готов к ${LG()}. Сколько ещё ждать?»`,
          `Тренер фарм-клуба считает, что ${lastName(p)} перерос ВХЛ. Игрок ждёт вызова.`,
        ]),
        playerIds: [p.id],
        options: [
          opt('promise', 'Вызовем в ближайшие две недели.', fx({ playerId: p.id, playerMorale: 7, promise: { kind: 'callup', playerId: p.id } }), 'Верните игрока из ВХЛ в течение 14 дней (Состав → вызвать).'),
          opt('month', 'Ещё месяц в ВХЛ — там ты играешь по 20 минут.', fx({ playerId: p.id, playerMorale: -2 })),
          opt('no', 'Пока мест нет.', fx({ playerId: p.id, playerMorale: -6 })),
        ],
        fallback: 'no',
      };
    },
  },
  {
    key: 'wish-dress', kind: 'wish',
    weight: (c) => (cand(c, (p) => !isGoalie(p) && p.age <= 23 && !c.dressed.has(p.id)).length ? 1.5 : 0),
    build: (c) => {
      const p = pick(cand(c, (p) => !isGoalie(p) && p.age <= 23 && !c.dressed.has(p.id)));
      return {
        title: `${p.name} устал сидеть на трибуне`,
        text: `Молодой ${p.name} (${p.age} лет) не попадает в заявку: «Мне нужна игровая практика — хоть в четвёртом звене».`,
        playerIds: [p.id],
        options: [
          opt('promise', 'Будешь играть: место в составе твоё.', fx({ playerId: p.id, playerMorale: 6, promise: { kind: 'dress', playerId: p.id } }), 'Включайте его в состав 4 из 6 ближайших матчей.'),
          opt('wait', 'Терпение. Тренируйся — шанс будет.', fx({ playerId: p.id, playerMorale: -4 })),
          opt('mentor', 'Пока учись у старших: прикреплю к тебе опытного наставника.', fx({ playerId: p.id, playerMorale: 1, trainingXp: 8 })),
        ],
        fallback: 'wait',
      };
    },
  },
  {
    key: 'wish-rest', kind: 'wish',
    weight: (c) => (cand(c, (p) => (p.age >= 32 && !isGoalie(p) && c.dressed.has(p.id)) || (isGoalie(p) && (p.fatigue ?? 0) > 55)).length ? 1.5 : 0),
    build: (c) => {
      const p = pick(cand(c, (p) => (p.age >= 32 && !isGoalie(p) && c.dressed.has(p.id)) || (isGoalie(p) && (p.fatigue ?? 0) > 55)));
      return {
        title: `${p.name} просит отдых`,
        text: isGoalie(p)
          ? `${p.name}: «Чувствую усталость — ноги не те. Дайте мне один матч передохнуть».`
          : `Ветеран ${p.name} (${p.age}) после тренировки: «Спина ноет. Один матч отдыха — и я снова в строю».`,
        playerIds: [p.id],
        options: [
          opt('promise', 'Отдохнёшь в ближайшем матче.', fx({ playerId: p.id, playerMorale: 4, promise: { kind: 'rest', playerId: p.id } }), 'Не включайте его в состав на следующий матч.'),
          opt('need', 'Ты нужен команде сейчас. Потерпи.', fx({ playerId: p.id, playerMorale: -4, board: 1 })),
          opt('minutes', 'Сыграешь, но меньше — врачи займутся спиной.', fx({ playerId: p.id, playerMorale: 1, budget: -300_000 })),
        ],
        fallback: 'need',
      };
    },
  },
  {
    key: 'wish-linemate', kind: 'wish',
    weight: (c) => (linematePair(c) ? 1.5 : 0),
    build: (c) => {
      const pr = linematePair(c);
      if (!pr) return null;
      const [a, b] = pr;
      const same = a.country === b.country;
      return {
        title: `${a.name} хочет играть с ${lastName(b)}`,
        text: same && isLegionnaire(a)
          ? `${a.name} и ${b.name} — земляки, вне льда не расстаются. ${lastName(a)} уверен, что в одном звене они заиграют.`
          : `${a.name}: «С ${lastName(b)} мы понимаем друг друга без слов. Поставьте нас вместе».`,
        playerIds: [a.id, b.id],
        options: [
          opt('promise', 'Попробуем вас в одном звене.', fx({ playerId: a.id, playerMorale: 5, players: { [b.id]: 3 }, promise: { kind: 'linemate', playerId: a.id, otherId: b.id } }), 'Поставьте их в одно звено хотя бы в 4 из 6 матчей.'),
          opt('no', 'Звенья собирает тренерский штаб.', fx({ playerId: a.id, playerMorale: -3 })),
          opt('practice', 'Сначала покажите это на тренировках.', fx({ playerId: a.id, playerMorale: 0, players: { [b.id]: 1 } })),
        ],
        fallback: 'no',
      };
    },
  },
  {
    key: 'wish-captain', kind: 'wish',
    weight: (c) => (captainCandidate(c) ? 1 : 0),
    build: (c) => {
      const p = captainCandidate(c);
      if (!p) return null;
      const cap = c.T.captainId ? c.P[c.T.captainId] : undefined;
      return {
        title: `${p.name} хочет нашивку`,
        text: `${p.name} (${p.age}, в клубе один из лидеров) намекнул, что готов взять на себя больше ответственности — и хотел бы букву на свитере.`,
        playerIds: [p.id, ...(cap ? [cap.id] : [])],
        options: [
          opt('captain', `Будешь капитаном.${cap ? ` ${lastName(cap)} станет ассистентом.` : ''}`, fx({ playerId: p.id, playerMorale: 8, role: 'C', players: cap ? { [cap.id]: -8 } : undefined, morale: cap ? -1 : 1 })),
          opt('assistant', 'Будешь ассистентом капитана.', fx({ playerId: p.id, playerMorale: 4, role: 'A' })),
          opt('no', 'Лидером можно быть и без буквы.', fx({ playerId: p.id, playerMorale: -5 })),
        ],
        fallback: 'no',
      };
    },
  },
  {
    key: 'wish-extend', kind: 'wish',
    weight: (c) => (c.s.phase === 'season' && cand(c, (p) => p.contract.years <= 1 && !p.contract.next && p.overall >= 70).length ? 2 : 0),
    build: (c) => {
      const p = pick(cand(c, (p) => p.contract.years <= 1 && !p.contract.next && p.overall >= 70));
      return {
        title: `${p.name}: «Что с моим контрактом?»`,
        text: pick([
          `У ${p.name} истекает контракт. Он хочет остаться, но ждёт определённости: «Мне важно понимать, что клуб на меня рассчитывает».`,
          `Агент ${p.name} спрашивает, планирует ли клуб продлевать соглашение — у игрока есть интерес других команд.`,
        ]),
        playerIds: [p.id],
        options: [
          opt('promise', 'Продлим — начнём переговоры в ближайший месяц.', fx({ playerId: p.id, playerMorale: 6, promise: { kind: 'extend', playerId: p.id } }), 'Подпишите продление в течение 30 дней (Контракты).'),
          opt('later', 'Вернёмся к этому после сезона.', fx({ playerId: p.id, playerMorale: -4 })),
          opt('no', 'Мы не планируем продлевать контракт.', fx({ playerId: p.id, playerMorale: -12, morale: -1, board: 1, tradeFlag: 'block' }), 'Игрок будет выставлен на обмен.'),
        ],
        fallback: 'later',
      };
    },
  },
  /* ---- agents ---- */
  {
    key: 'agent-raise', kind: 'agent',
    weight: (c) => (cand(c, underpaid).length ? 2 : 0),
    build: (c) => {
      const p = pick(cand(c, underpaid));
      const pts = points(p);
      return {
        title: `Агент ${p.name} требует повышения`,
        text: `${p.name}: ${pts} очков в ${p.stats.gp} матчах при зарплате ${formatMoney(p.contract.salary)}. Агент считает, что клиент недооценён, и угрожает «рассмотреть варианты».`,
        playerIds: [p.id],
        options: [
          opt('promise', 'Готовы обсудить новый контракт в течение месяца.', fx({ playerId: p.id, playerMorale: 5, promise: { kind: 'extend', playerId: p.id } }), 'Подпишите продление в течение 30 дней.'),
          opt('contract', 'Контракт есть контракт. Пусть играет.', fx({ playerId: p.id, playerMorale: -9, board: 2 })),
          opt('block', 'Если он недоволен — выставим на обмен.', fx({ playerId: p.id, playerMorale: -14, morale: -1, tradeFlag: 'block' })),
        ],
        fallback: 'contract',
      };
    },
  },
  /* ---- conflicts ---- */
  {
    key: 'conflict-critic', kind: 'conflict',
    weight: (c) => (cand(c, (p) => !isGoalie(p) && rank(c, p) < 5 && p.morale < 66 && !topRole(c, p)).length ? 3 : 0),
    build: (c) => {
      const p = pick(cand(c, (p) => !isGoalie(p) && rank(c, p) < 5 && p.morale < 66 && !topRole(c, p)));
      const f = fine(p);
      return {
        title: `${p.name} публично критикует тренера`,
        text: pick([
          `В интервью после тренировки ${p.name} заявил: «Я не понимаю, почему играю в ${isDefense(p) ? 'третьей паре' : 'третьем звене'}. Вопросы не ко мне».`,
          `${lastName(p)} в соцсетях выложил загадочный пост про «тех, кто не видит очевидного». Журналисты уверены — это про вас.`,
        ]),
        playerIds: [p.id],
        options: [
          opt('talk', 'Поговорить с глазу на глаз и выслушать.', fx({ playerId: p.id, playerMorale: 6 })),
          opt('fine', `Оштрафовать (${formatMoney(f)}) — сор из избы не выносят.`, fx({ playerId: p.id, playerMorale: -10, morale: 2, board: 1, budget: f })),
          opt('promise', `Пообещать место в первых ${isDefense(p) ? 'парах' : 'звеньях'}.`, fx({ playerId: p.id, playerMorale: 8, morale: -2, promise: { kind: 'role', playerId: p.id } }), 'Остальные увидят, что громкие слова работают.'),
        ],
        fallback: 'talk',
      };
    },
  },
  {
    key: 'conflict-fight', kind: 'conflict',
    weight: (c) => (fightPair(c) ? (lostLast(c) ? 3 : 1.5) : 0),
    build: (c) => {
      const pr = fightPair(c);
      if (!pr) return null;
      const [v, y] = pr;
      const vLeader = c.T.captainId === v.id || (c.T.assistantIds ?? []).includes(v.id);
      return {
        title: `Драка на тренировке: ${lastName(v)} — ${lastName(y)}`,
        text: pick([
          `На тренировке ${v.name} (${v.age}) и ${y.name} (${y.age}) сцепились после силового приёма — партнёрам пришлось разнимать.`,
          `${lastName(y)} слишком жёстко сыграл против ${lastName(v)} в двусторонке. Слово за слово — и перчатки полетели на лёд.`,
        ]),
        playerIds: [v.id, y.id],
        options: [
          opt('both', `Оштрафовать обоих (${formatMoney(fine(v) + fine(y))}).`, fx({ morale: 1, players: { [v.id]: -6, [y.id]: -6 }, budget: fine(v) + fine(y), board: 1 })),
          opt('vet', `Встать на сторону ${lastName(v)}: молодым — уважение к старшим.`, fx({ players: { [v.id]: 6, [y.id]: -10 }, morale: 1 })),
          opt('young', `Встать на сторону ${lastName(y)}: на тренировке все равны.`, fx({ players: { [v.id]: vLeader ? -10 : -7, [y.id]: 6 }, morale: vLeader ? -3 : -1 })),
          opt('dinner', 'Собрать команду: разговор и ужин за счёт клуба.', fx({ morale: 2, players: { [v.id]: -1, [y.id]: -1 }, budget: -1_500_000 })),
        ],
        fallback: 'both',
      };
    },
  },
  {
    key: 'conflict-curfew', kind: 'conflict',
    weight: (c) => (lostLast(c) && cand(c, (p) => p.age <= 27 || p.morale < 55).length ? 2.5 : 0),
    build: (c) => {
      const p = pick(cand(c, (p) => p.age <= 27 || p.morale < 55));
      const f = fine(p) * 2;
      return {
        title: `${p.name} нарушил режим`,
        text: pick([
          `После поражения от «${c.last?.opp.short ?? 'соперника'}» ${p.name} был замечен в ночном клубе в три часа ночи. Фото уже гуляют по сети.`,
          `${p.name} опоздал на утреннюю тренировку на час и не смог внятно объяснить причину.`,
        ]),
        playerIds: [p.id],
        options: [
          opt('fine', `Штраф ${formatMoney(f)}.`, fx({ playerId: p.id, playerMorale: -6, board: 2, fans: 1, budget: f })),
          opt('scratch', 'Отстранить от следующего матча.', fx({ playerId: p.id, playerMorale: -8, morale: 1, board: 1, promise: { kind: 'scratch', playerId: p.id } }), 'Не ставьте его в состав на ближайший матч — иначе команда решит, что правила не для всех.'),
          opt('hide', 'Замять историю, разобраться внутри.', fx({ playerId: p.id, playerMorale: 3, board: -2, tag: `coverup:${p.id}` }), 'Если правда всплывёт — будет скандал.'),
          opt('public', 'Публично осудить: такое поведение недопустимо.', fx({ playerId: p.id, playerMorale: -12, morale: -1, fans: 2, board: 1 })),
        ],
        fallback: 'fine',
      };
    },
  },
  {
    key: 'conflict-homesick', kind: 'conflict',
    weight: (c) => (cand(c, (p) => isLegionnaire(p) && p.morale < 62).length ? 2 : 0),
    build: (c) => {
      const p = pick(cand(c, (p) => isLegionnaire(p) && p.morale < 62));
      return {
        title: `${p.name} скучает по дому`,
        text: `${p.name} (${p.country}) тяжело переносит сезон вдали от семьи: в игре это уже заметно. Он просит пару дней, чтобы слетать домой.`,
        playerIds: [p.id],
        options: [
          opt('family', 'Клуб оплатит перелёт семьи к нему.', fx({ playerId: p.id, playerMorale: 12, budget: -2_000_000 })),
          opt('days', 'Отпустить на пару дней.', fx({ playerId: p.id, playerMorale: 9, morale: -1 }), 'Остальные могут попросить того же.'),
          opt('psych', 'Работа с клубным психологом.', fx({ playerId: p.id, playerMorale: 5, budget: -500_000 })),
          opt('no', 'Сезон в разгаре — никаких отлучек.', fx({ playerId: p.id, playerMorale: -8, board: 1 })),
        ],
        fallback: 'no',
      };
    },
  },
  {
    key: 'conflict-captain', kind: 'conflict',
    weight: (c) => {
      const cap = c.T.captainId ? c.P[c.T.captainId] : null;
      const avg = c.mine.reduce((a, p) => a + p.morale, 0) / Math.max(1, c.mine.length);
      return cap && !cap.injury && fresh(c, cap) && (avg < 58 || (c.T.record.streakType === 'L' && c.T.record.streak >= 3)) ? 2.5 : 0;
    },
    build: (c) => {
      const cap = c.P[c.T.captainId!];
      return {
        title: `Капитан ${lastName(cap)} говорит от имени команды`,
        text: pick([
          `${cap.name} пришёл от имени раздевалки: ребята выжаты, тренировки слишком тяжёлые, и это видно в концовках матчей.`,
          `Капитан ${cap.name}: «Команда не понимает, чего от неё хотят. Нам нужен разговор — честный, без крика».`,
        ]),
        playerIds: [cap.id],
        options: [
          opt('ease', 'Снизить нагрузки на неделю.', fx({ morale: 3, board: -1, rest: 15 })),
          opt('keep', 'Нагрузки останутся — мы готовимся к весне.', fx({ morale: -2, playerId: cap.id, playerMorale: -5, board: 1 })),
          opt('meeting', 'Пусть капитан сам проведёт собрание игроков.', fx({ morale: 2, playerId: cap.id, playerMorale: 4 })),
        ],
        fallback: 'keep',
      };
    },
  },
  {
    key: 'conflict-broken', kind: 'conflict',
    weight: (c) => (brokenPlayer(c) ? 4 : 0),
    build: (c) => {
      const p = brokenPlayer(c);
      if (!p) return null;
      return {
        title: `${p.name} напоминает о вашем обещании`,
        text: `${p.name} в интервью: «Тренер обещал мне одно, а сделал другое. Я так работать не привык». Раздевалка ждёт вашей реакции.`,
        playerIds: [p.id],
        options: [
          opt('sorry', 'Признать ошибку и извиниться перед игроком.', fx({ playerId: p.id, playerMorale: 7, board: -1, morale: 1 })),
          opt('internal', 'Это внутреннее дело команды. Без комментариев.', fx({ playerId: p.id, playerMorale: -4, morale: -1 })),
          opt('block', 'Выставить на обмен — так с тренером не разговаривают.', fx({ playerId: p.id, playerMorale: -12, board: 1, tradeFlag: 'block', morale: -1 })),
        ],
        fallback: 'internal',
      };
    },
  },
  /* ---- media ---- */
  {
    key: 'media-leak', kind: 'media',
    weight: (c) => (recalledAll(c.s, 'coverup:', 60).some((t) => c.s.day - roomMemory(c.s).tags[t] >= 4) ? 3 : 0),
    build: (c) => {
      const tag = recalledAll(c.s, 'coverup:', 60).find((t) => c.s.day - roomMemory(c.s).tags[t] >= 4)!;
      forget(c.s, tag);
      const p = c.P[tag.slice(8)];
      if (!p || Math.random() < 0.4) return null; // this time the story stayed inside
      return {
        title: 'Утечка в прессу',
        text: `Журналисты раскопали историю с нарушением режима ${p.name}, которую клуб пытался замять. Вас спрашивают, почему игрок не был наказан.`,
        playerIds: [p.id],
        options: [
          opt('admit', 'Признать: решили разобраться внутри, это была ошибка.', fx({ fans: 1, board: -1, playerId: p.id, playerMorale: -5 })),
          opt('deny', 'Опровергнуть: ничего не было.', fx({ fans: -3, board: -2, tag: 'liar' })),
          opt('fine', `Оштрафовать игрока задним числом (${formatMoney(fine(p))}).`, fx({ fans: 2, board: 1, playerId: p.id, playerMorale: -9, budget: fine(p), morale: -1 })),
        ],
        fallback: 'deny',
      };
    },
  },
  {
    key: 'media-rumor', kind: 'media',
    weight: (c) => (cand(c, (p) => rank(c, p) < 6 && p.tradeFlag !== 'keep').length && c.s.phase === 'season' ? 1.5 : 0),
    build: (c) => {
      const p = pick(cand(c, (p) => rank(c, p) < 6 && p.tradeFlag !== 'keep'));
      const others = Object.values(c.s.teams).filter((t) => t.id !== c.T.id);
      const rival = pick(others);
      return {
        title: `Слухи: «${rival.short}» интересуется ${lastName(p)}`,
        text: `СМИ пишут, что «${rival.name}» готов предложить за ${p.name} хороший пакет. Игрок нервничает и ждёт, что скажет клуб.`,
        playerIds: [p.id],
        options: [
          opt('keep', 'Публично: игрок не продаётся.', fx({ playerId: p.id, playerMorale: 8, tradeFlag: 'keep', fans: 1 })),
          opt('open', 'Мы выслушаем любые предложения.', fx({ playerId: p.id, playerMorale: -8, board: 1 })),
          opt('silent', 'Не комментировать слухи.', fx({ playerId: p.id, playerMorale: -2 })),
        ],
        fallback: 'silent',
      };
    },
  },
  {
    key: 'media-tv', kind: 'media',
    weight: (c) => (cand(c, (p) => rank(c, p) < 4 || (isGoalie(p) && p.id === c.L.starterG)).length ? 1 : 0),
    build: (c) => {
      const p = pick(cand(c, (p) => rank(c, p) < 4 || (isGoalie(p) && p.id === c.L.starterG)));
      return {
        title: `«Матч ТВ» хочет снять фильм про ${lastName(p)}`,
        text: `Телеканал просит неделю съёмок с ${p.name}: тренировки, дом, раздевалка. Это реклама клубу, но и лишний шум вокруг команды.`,
        playerIds: [p.id],
        options: [
          opt('yes', 'Согласиться — пусть страна знает наших героев.', fx({ playerId: p.id, playerMorale: 4, fans: 4, morale: -1 })),
          opt('limited', 'Только без раздевалки и не в дни матчей.', fx({ playerId: p.id, playerMorale: 2, fans: 2 })),
          opt('no', 'Отказать: сейчас не до съёмок.', fx({ playerId: p.id, playerMorale: -2, morale: 1 })),
        ],
        fallback: 'limited',
      };
    },
  },
  /* ---- team & city ---- */
  {
    key: 'team-dinner', kind: 'team',
    weight: (c) => (c.T.captainId && c.P[c.T.captainId] ? 1 : 0),
    build: (c) => {
      const cap = c.P[c.T.captainId!];
      return {
        title: 'Командный выезд',
        text: `${cap.name} предлагает в свободный день устроить командный выезд: баня, ужин, без телефонов. Просит клуб оплатить.`,
        playerIds: [cap.id],
        options: [
          opt('full', `Оплатить полностью (${formatMoney(3_000_000)}).`, fx({ morale: 4, budget: -3_000_000, playerId: cap.id, playerMorale: 2 })),
          opt('dinner', `Только ужин (${formatMoney(800_000)}).`, fx({ morale: 2, budget: -800_000 })),
          opt('no', 'Свободный день — для восстановления.', fx({ morale: -1, rest: 5, playerId: cap.id, playerMorale: -2 })),
        ],
        fallback: 'no',
      };
    },
  },
  {
    key: 'team-mentor', kind: 'team',
    weight: (c) => (mentorPair(c) ? 1.2 : 0),
    build: (c) => {
      const pr = mentorPair(c);
      if (!pr) return null;
      const [v, y] = pr;
      return {
        title: `${lastName(v)} готов взять шефство над ${lastName(y)}`,
        text: `Ветеран ${v.name} (${v.age}) предлагает индивидуально заниматься с молодым ${y.name} (${y.age}) после тренировок.`,
        playerIds: [v.id, y.id],
        options: [
          opt('yes', 'Отличная идея — оплатим дополнительный лёд.', fx({ players: { [v.id]: 4, [y.id]: 4 }, budget: -400_000, playerId: y.id, trainingXp: 18 }), 'Молодой игрок быстрее прогрессирует.'),
          opt('no', 'У молодого и так плотный график.', fx({ players: { [v.id]: -2 } })),
        ],
        fallback: 'no',
      };
    },
  },
  {
    key: 'fans-meeting', kind: 'fans',
    weight: (c) => ((c.T.record.streakType === 'L' && c.T.record.streak >= 4) || (c.s.fans ?? 60) < 42 ? 3 : 0),
    build: (c) => ({
      title: 'Фанаты требуют встречи',
      text: pick([
        `Фан-движение «${c.T.short}» вывесило баннер «Где игра?» и требует встречи с тренером и игроками.`,
        `После серии неудач болельщики собрались у тренировочного катка и хотят услышать объяснения.`,
      ]),
      playerIds: [],
      options: [
        opt('meet', 'Выйти к болельщикам вместе с капитаном.', fx({ fans: 6, morale: -1 })),
        opt('practice', 'Открытая тренировка и автограф-сессия.', fx({ fans: 3, morale: 1, budget: -300_000 })),
        opt('ignore', 'Ответим на льду, а не словами.', fx({ fans: -5, morale: 1 })),
      ],
      fallback: 'ignore',
    }),
  },
  {
    key: 'city-charity', kind: 'fans',
    weight: () => 0.8,
    build: (c) => {
      const stars = c.mine.filter((p) => !p.injury).sort((a, b) => b.overall - a.overall).slice(0, 3);
      return {
        title: 'Благотворительная акция',
        text: pick([
          `Мэрия ${c.T.city} приглашает игроков на хоккейный праздник для детских домов.`,
          `Детская хоккейная школа ${c.T.city} просит клуб помочь с формой и провести мастер-класс.`,
        ]),
        playerIds: stars.map((p) => p.id),
        options: [
          opt('stars', `Отправить звёзд (${stars.map(lastName).join(', ')}).`, fx({ fans: 4, morale: 1, players: Object.fromEntries(stars.map((p) => [p.id, -1])) })),
          opt('money', `Перечислить ${formatMoney(5_000_000)}.`, fx({ fans: 3, board: 2, budget: -5_000_000 })),
          opt('no', 'Отказаться — плотный календарь.', fx({ fans: -2 })),
        ],
        fallback: 'no',
      };
    },
  },
];

function underpaid(p: Player) {
  return !isGoalie(p) && p.stats.gp >= 15 && points(p) >= p.stats.gp * 0.75 && p.contract.salary < fairSalary(p.overall) * 0.7;
}
function linematePair(c: Ctx): [Player, Player] | null {
  const fw = free(c, c.healthy).filter((p) => isForward(p) && c.dressed.has(p.id));
  const lineOf = (id: string) => c.L.F.findIndex((l) => l.includes(id));
  for (const a of fw) for (const b of c.healthy) {
    if (a === b || !isForward(b) || !c.dressed.has(b.id) || lineOf(a.id) === lineOf(b.id)) continue;
    if (a.country === b.country && (isLegionnaire(a) || Math.random() < 0.15)) return [a, b];
  }
  return null;
}
function captainCandidate(c: Ctx): Player | null {
  const leaders = new Set([c.T.captainId, ...(c.T.assistantIds ?? [])]);
  const cap = c.T.captainId ? c.P[c.T.captainId] : null;
  return free(c, c.healthy).filter((p) => !isGoalie(p) && !leaders.has(p.id) && p.age >= 27 && rank(c, p) < 5 && p.morale >= 60 && (!cap || cap.injury || p.overall > cap.overall + 2))[0] ?? null;
}
function fightPair(c: Ctx): [Player, Player] | null {
  const ps = free(c, c.healthy).filter((p) => !isGoalie(p));
  const vets = ps.filter((p) => p.age >= 29), young = ps.filter((p) => p.age <= 24);
  for (const v of vets) for (const y of young) if (isDefense(v) === isDefense(y)) return Math.random() < 0.5 ? [v, y] : [pick(vets), pick(young)];
  return null;
}
function mentorPair(c: Ctx): [Player, Player] | null {
  const ps = free(c, c.healthy);
  const young = ps.filter((p) => p.age <= 21 && !isGoalie(p)), vets = ps.filter((p) => p.age >= 30 && p.overall >= 70 && !isGoalie(p));
  for (const y of young) { const v = vets.find((v) => isDefense(v) === isDefense(y)); if (v) return [v, y]; }
  return null;
}
function brokenPlayer(c: Ctx): Player | null {
  for (const t of recalledAll(c.s, 'broken:', 25)) {
    const p = c.P[t.slice(7)];
    if (p && p.teamId === c.T.id && !recalled(c.s, `aired:${p.id}`, 60)) return p;
  }
  return null;
}

/** Weighted pick of the next situation (exported for tests). */
export function nextClubEvent(state: GameState, onlyKey?: string): ClubEvent | null {
  const c = context(state);
  const mem = roomMemory(state);
  const pool = GENS.filter((g) => (!onlyKey || g.key === onlyKey) && (onlyKey || mem.cool[g.key] === undefined || state.day - mem.cool[g.key] > 35) && !(state.roomEvents ?? []).some((e) => e.key === g.key))
    .map((g) => ({ g, w: g.weight(c) })).filter((x) => x.w > 0);
  for (let tries = 0; tries < 4 && pool.length; tries++) {
    const sum = pool.reduce((a, x) => a + x.w, 0);
    let r = Math.random() * sum, i = 0;
    while (i < pool.length - 1 && (r -= pool[i].w) > 0) i++;
    const { g } = pool.splice(i, 1)[0];
    const body = g.build(c);
    if (!body) continue;
    mem.cool[g.key] = state.day;
    for (const id of body.playerIds) mem.cool[`p:${id}`] = state.day;
    if (g.key === 'conflict-broken') remember(state, `aired:${body.playerIds[0]}`);
    return { ...body, id: mem.seq++, key: g.key, kind: g.kind, day: state.day, expires: state.day + 3 };
  }
  return null;
}

/** Daily step: unanswered situations resolve themselves, promises are judged, new situations arise. */
export function stepDressingRoom(state: GameState, days: number, say: Say) {
  if (state.phase !== 'season' && state.phase !== 'playoffs') {
    // the season is over: open situations and promises go with it
    state.roomEvents = [];
    state.roomPromises = [];
    return;
  }
  state.roomEvents ??= [];
  for (const e of [...state.roomEvents]) if (state.day > e.expires) { const t = answerClubEvent(state, e.id, null); if (t) say(t); }
  stepPromises(state, say);
  const pending = state.roomEvents.length;
  if (pending >= 2) return;
  const c = context(state);
  const p = (pending ? 0.05 : 0.12) * (lostLast(c) ? 1.4 : 1) * Math.min(3, days);
  if (Math.random() < p) {
    const e = nextClubEvent(state);
    if (e) state.roomEvents.push(e);
  }
}

/** The manager's answer (null = ignored: the fallback answer applies). Returns a line for the news. */
export function answerClubEvent(state: GameState, eventId: number, optionId: string | null): string | null {
  const list = state.roomEvents ?? [];
  const e = list.find((x) => x.id === eventId);
  if (!e) return null;
  state.roomEvents = list.filter((x) => x !== e);
  const o = e.options.find((x) => x.id === (optionId ?? e.fallback)) ?? e.options[e.options.length - 1];
  const parts = applyEffects(state, o.effects);
  return `${e.title}: ${optionId ? `«${o.text}»` : `без ответа — «${o.text}»`}${parts.length ? ' — ' + parts.join(', ') : ''}`;
}

/** Progress of a promise for the UI: "3/6 матчей · выполнено 2". */
export function promiseProgress(state: GameState, pr: RoomPromise): { text: string; risk: boolean } {
  const left = Math.max(0, pr.due - state.day);
  if (pr.target > 0) {
    const need = Math.ceil(pr.target * RULES[pr.kind].ratio - 1e-9);
    const missed = pr.played - pr.hits, allowed = pr.target - need;
    return { text: `${pr.hits} из ${need} нужных · матчей ${pr.played}/${pr.target} · до ${left} дн.`, risk: missed > allowed - 1 && pr.played < pr.target };
  }
  return { text: `осталось ${left} дн.`, risk: left <= 5 };
}
