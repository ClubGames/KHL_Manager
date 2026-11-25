import type { GameState, Lineup, NewsItem, Phase, Player, PosCode, Team, TradeBlock, TradeBlockWants, TradeOffer } from '../types';
import { attackRating, clamp, defenseRating, fairSalary, isDefense, isForward, isGoalie, isSkater, payroll, POS_RU } from './ratings';
import { emptyLineup } from './defaults';
import { countRosterLegionnaires, isLegionnaire, teamForeignLimit } from './legionnaires';
import { capSuspendedPlayers } from './cap';
import { ensureCaptains, goalieFreshness } from './chemistry';
import { isU20DefenseLimiter, isU20ForwardLimiter } from './dynasty';
import { activeKhlCount, teamVhlCapRelief } from './khlRules';
import { isUnavailable } from './medical';
import { LG } from '../brand';

export const byOvr = (a: Player, b: Player) => b.overall - a.overall || a.age - b.age;
export const groupOf = (p: Player): 'F' | 'D' | 'G' => (isGoalie(p) ? 'G' : isDefense(p) ? 'D' : 'F');

export interface LineupConstraints {
  foreignLimit?: number | null;
  excluded?: Set<string>;
  phase?: Phase;
}

export function autoLineup(ids: string[], P: Record<string, Player>, opts?: LineupConstraints): Lineup {
  const excluded = opts?.excluded;
  const foreignLimit = opts?.foreignLimit ?? null;
  let avail = ids.map((id) => P[id]).filter((p): p is Player => !!p && !isUnavailable(p, opts?.phase) && !p.inVhl && !excluded?.has(p.id));
  if (foreignLimit !== null) {
    const legs = avail.filter((p) => isLegionnaire(p)).sort(byOvr);
    if (legs.length > foreignLimit) {
      const hasDomGoalie = avail.some((p) => isGoalie(p) && !isLegionnaire(p));
      const allowedLegs = new Set<string>();
      if (!hasDomGoalie) {
        const topLegG = legs.find(isGoalie);
        if (topLegG && foreignLimit > 0) allowedLegs.add(topLegG.id);
      }
      for (const p of legs) {
        if (allowedLegs.size >= foreignLimit) break;
        allowedLegs.add(p.id);
      }
      avail = avail.filter((p) => !isLegionnaire(p) || allowedLegs.has(p.id));
    }
  }
  const F = avail.filter(isForward);
  const D = avail.filter(isDefense).sort(byOvr);
  const G = avail.filter(isGoalie).sort(byOvr);
  const pool = [...F];
  const used = new Set<string>();
  const take = (pref: PosCode): string | null => {
    let best: Player | null = null;
    let bv = -1e9;
    for (const p of pool) {
      if (used.has(p.id)) continue;
      const pen = p.position === pref ? 0 : p.position === 'C' ? 5 : 3;
      const v = p.overall - pen;
      if (v > bv) {
        bv = v;
        best = p;
      }
    }
    if (best) used.add(best.id);
    return best ? best.id : null;
  };
  const L = emptyLineup();
  for (let i = 0; i < 4; i++) L.F[i] = [take('C'), take('LW'), take('RW')];
  for (let i = 0; i < 3; i++) {
    const d0 = D[2 * i]?.id ?? null;
    const d1 = D[2 * i + 1]?.id ?? null;
    if (d0) used.add(d0);
    if (d1) used.add(d1);
    L.D[i] = [d0, d1];
  }
  const dressedF = L.F.flat().filter((x): x is string => !!x);
  const dressedD = L.D.flat().filter((x): x is string => !!x);
  const fAtt = [...dressedF].sort((a, b) => attackRating(P[b]) - attackRating(P[a]));
  const dAtt = [...dressedD].sort((a, b) => attackRating(P[b]) - attackRating(P[a]));
  const fDef = [...dressedF].sort((a, b) => defenseRating(P[b]) - defenseRating(P[a]));
  const dDef = [...dressedD].sort((a, b) => defenseRating(P[b]) - defenseRating(P[a]));
  L.pp1 = [...fAtt.slice(0, 3), ...dAtt.slice(0, 2)];
  L.pp2 = [...fAtt.slice(3, 6), ...dAtt.slice(2, 4)];
  L.pk1 = [...fDef.slice(0, 2), ...dDef.slice(0, 2)];
  L.pk2 = [...fDef.slice(2, 4), ...dDef.slice(2, 4)];
  L.starterG = G[0]?.id ?? null;
  L.backupG = G[1]?.id ?? null;
  // KHL U20 young-player limiters (13th forward & 7th defenseman)
  L.u20F = F.filter((p) => !used.has(p.id) && isU20ForwardLimiter(p)).sort(byOvr)[0]?.id ?? null;
  L.u20D = D.filter((p) => !used.has(p.id) && isU20DefenseLimiter(p)).sort(byOvr)[0]?.id ?? null;
  return L;
}

export function sanitizeLineup(L: Lineup, ids: string[], P: Record<string, Player>, opts?: LineupConstraints): Lineup {
  const excluded = opts?.excluded;
  const foreignLimit = opts?.foreignLimit ?? null;
  let legCount = 0;
  const canTakeLeg = (id: string) => foreignLimit === null || !isLegionnaire(P[id]) || legCount < foreignLimit;
  const markUsed = (id: string, set: Set<string>) => {
    set.add(id);
    if (isLegionnaire(P[id])) legCount++;
  };

  const ok = (id: string | null) => !!id && !!P[id] && !isUnavailable(P[id], opts?.phase) && !P[id].inVhl && !excluded?.has(id) && ids.includes(id) && isSkater(P[id]);
  const used = new Set<string>();
  const avail = ids.map((id) => P[id]).filter((p): p is Player => !!p && !isUnavailable(p, opts?.phase) && !p.inVhl && !excluded?.has(p.id));
  const F = avail.filter(isForward).sort(byOvr);
  const D = avail.filter(isDefense).sort(byOvr);
  const G = avail.filter(isGoalie).sort(byOvr);
  const out = emptyLineup();

  const gokBase = (id: string | null) => !!id && !!P[id] && isGoalie(P[id]) && !isUnavailable(P[id], opts?.phase) && !P[id].inVhl && !excluded?.has(id) && ids.includes(id);
  const pickGoalie = (preferred: (string | null)[]): string | null => {
    for (const id of preferred) {
      if (id && gokBase(id) && !used.has(id) && canTakeLeg(id)) {
        markUsed(id, used);
        return id;
      }
    }
    const g = G.find((x) => !used.has(x.id) && canTakeLeg(x.id)) ?? G.find((x) => !used.has(x.id));
    if (g) {
      markUsed(g.id, used);
      return g.id;
    }
    return null;
  };
  out.starterG = pickGoalie([L.starterG, L.backupG]);

  const slot = (id: string | null | undefined, pref: PosCode | 'D'): string | null => {
    if (id && ok(id) && !used.has(id) && canTakeLeg(id)) {
      markUsed(id, used);
      return id;
    }
    const list = pref === 'D' ? D : F;
    let best: Player | null = null;
    let bv = -1e9;
    for (const p of list) {
      if (used.has(p.id) || !canTakeLeg(p.id)) continue;
      const pen = pref === 'D' ? 0 : p.position === pref ? 0 : p.position === 'C' ? 5 : 3;
      const v = p.overall - pen;
      if (v > bv) {
        bv = v;
        best = p;
      }
    }
    if (best) markUsed(best.id, used);
    return best ? best.id : null;
  };
  for (let i = 0; i < 4; i++) out.F[i] = [slot(L.F[i]?.[0], 'C'), slot(L.F[i]?.[1], 'LW'), slot(L.F[i]?.[2], 'RW')];
  for (let i = 0; i < 3; i++) out.D[i] = [slot(L.D[i]?.[0], 'D'), slot(L.D[i]?.[1], 'D')];
  out.backupG = pickGoalie([L.backupG]);

  const dressed = new Set<string>([...out.F.flat(), ...out.D.flat()].filter((x): x is string => !!x));
  const df = [...dressed].filter((id) => isForward(P[id]));
  const dd = [...dressed].filter((id) => isDefense(P[id]));
  const fAtt = [...df].sort((a, b) => attackRating(P[b]) - attackRating(P[a]));
  const dAtt = [...dd].sort((a, b) => attackRating(P[b]) - attackRating(P[a]));
  const fDef = [...dressed].filter((id) => isForward(P[id])).sort((a, b) => defenseRating(P[b]) - defenseRating(P[a]));
  const dDef = [...dressed].filter((id) => isDefense(P[id])).sort((a, b) => defenseRating(P[b]) - defenseRating(P[a]));
  const unit = (u: (string | null)[] | undefined, n: number, fb: string[], reserved = new Set<string>()): string[] => {
    const res: string[] = [];
    for (const id of u ?? []) {
      if (res.length >= n) break;
      if (id && dressed.has(id) && !reserved.has(id) && !res.includes(id)) res.push(id);
    }
    for (const id of fb) {
      if (res.length >= n) break;
      if (!reserved.has(id) && !res.includes(id)) res.push(id);
    }
    return res;
  };
  out.pp1 = unit(L.pp1, 5, [...fAtt, ...dAtt]);
  const ppUsed = new Set(out.pp1.filter((x): x is string => !!x));
  out.pp2 = unit(L.pp2, 5, [...fAtt.slice(3), ...dAtt.slice(2), ...fAtt, ...dAtt], ppUsed);
  out.pk1 = unit(L.pk1, 4, [...fDef, ...dDef]);
  const pkUsed = new Set(out.pk1.filter((x): x is string => !!x));
  out.pk2 = unit(L.pk2, 4, [...fDef.slice(2), ...dDef.slice(2), ...fDef, ...dDef], pkUsed);

  // KHL U20 young-player limiters (13th forward & 7th defenseman)
  if (L.u20F && ok(L.u20F) && !used.has(L.u20F) && isU20ForwardLimiter(P[L.u20F])) {
    out.u20F = L.u20F;
    used.add(L.u20F);
  } else {
    out.u20F = F.find((p) => !used.has(p.id) && isU20ForwardLimiter(p))?.id ?? null;
    if (out.u20F) used.add(out.u20F);
  }
  if (L.u20D && ok(L.u20D) && !used.has(L.u20D) && isU20DefenseLimiter(P[L.u20D])) {
    out.u20D = L.u20D;
    used.add(L.u20D);
  } else {
    out.u20D = D.find((p) => !used.has(p.id) && isU20DefenseLimiter(p))?.id ?? null;
    if (out.u20D) used.add(out.u20D);
  }
  return out;
}

export function lineupConstraintsFor(state: GameState, teamId: string): LineupConstraints {
  const t = state.teams[teamId];
  return {
    foreignLimit: teamForeignLimit(t, state.league.foreignLimit),
    excluded: new Set(capSuspendedPlayers(state, teamId)),
    phase: state.phase,
  };
}

export function prepareLineup(state: GameState, teamId: string): Lineup {
  const t = state.teams[teamId];
  const opts = lineupConstraintsFor(state, teamId);
  if (teamId === state.userTeamId) return sanitizeLineup(t.lineup, t.players, state.players, opts);
  const L = autoLineup(t.players, state.players, opts);
  if (L.starterG && L.backupG) {
    const s = state.players[L.starterG];
    const b = state.players[L.backupG];
    const sFresh = goalieFreshness(s);
    const bFresh = goalieFreshness(b);
    if ((sFresh < 64 && bFresh >= sFresh + 12) || (b.overall >= s.overall - 7 && Math.random() < 0.24)) {
      L.starterG = L.backupG;
      L.backupG = s.id;
    }
  }
  t.lineup = L;
  return L;
}

/* ------------------------------------------------------------------ */
/* Trades                                                               */
/* ------------------------------------------------------------------ */
export type Group = 'F' | 'D' | 'G';
const GROUPS: Group[] = ['F', 'D', 'G'];
const GROUP_ACC: Record<Group, string> = { F: 'нападение', D: 'оборону', G: 'вратарскую линию' };
const GROUP_ONE: Record<Group, string> = { F: 'нападающего', D: 'защитника', G: 'вратаря' };
const GROUP_MANY: Record<Group, string> = { F: 'нападающих', D: 'защитников', G: 'вратарей' };
/** players an AI club must keep to dress a full line-up */
const MIN_ROSTER: Record<Group, number> = { F: 12, D: 6, G: 2 };
/** the manager may run a thinner roster if he wants to */
const USER_MIN: Record<Group, number> = { F: 8, D: 4, G: 2 };
const DRESSED: Record<Group, number> = { F: 12, D: 6, G: 1 };
export const MAX_ROSTER = 30;

/** Club-neutral market value of a player. */
export function tradeValue(p: Player): number {
  const v = Math.pow(Math.max(1, p.overall - 50), 2) * 0.02;
  const af = p.age <= 22 ? 1.3 : p.age <= 25 ? 1.2 : p.age <= 29 ? 1.1 : p.age <= 32 ? 0.9 : p.age <= 35 ? 0.7 : 0.5;
  const pf = p.age <= 24 ? 1 + Math.max(0, p.potential - p.overall) * 0.012 : 1;
  const cf = p.contract.years <= 0 ? 0.75 : p.contract.years === 1 ? 0.9 : p.contract.years === 2 ? 1 : 1.05;
  const ratio = p.contract.salary / Math.max(1, fairSalary(p.overall));
  const sf = ratio > 1.3 ? 0.85 : ratio < 0.7 ? 1.1 : 1;
  return v * af * pf * cf * sf;
}

export function regularDays(state: GameState): number {
  const i = state.schedule.findIndex((d) => d.length > 0 && d[0].kind === 'playoff');
  return i < 0 ? state.schedule.length : i;
}
/** First day on which trades are no longer allowed (about two thirds of the regular season, as in the KHL's late-December deadline). */
export function tradeDeadline(state: GameState): number {
  return Math.floor(regularDays(state) * 0.66);
}

/** International pause / trade moratorium in early November (for full-length seasons). */
export function novemberTradeFreeze(state: GameState): [number, number] | null {
  const reg = regularDays(state);
  if (reg < 80) return null;
  const start = Math.floor(reg * 0.39);
  return [start, Math.min(start + 5, tradeDeadline(state) - 10)];
}

export interface TradeWindowPeriod {
  id: 'autumn' | 'freeze' | 'winter' | 'closed' | 'offseason';
  title: string;
  open: boolean;
  startDay: number;
  endDay: number;
  status: 'past' | 'active' | 'upcoming';
  note: string;
}

export function getTradeWindowsSchedule(state: GameState): TradeWindowPeriod[] {
  const reg = regularDays(state);
  const deadline = tradeDeadline(state);
  const freeze = novemberTradeFreeze(state);
  const d = state.day;
  const isOff = state.phase === 'offseason';

  const statusOf = (s: number, e: number): 'past' | 'active' | 'upcoming' => {
    if (isOff) return 'past';
    if (d > e) return 'past';
    if (d < s) return 'upcoming';
    return 'active';
  };

  const out: TradeWindowPeriod[] = [];
  if (freeze && freeze[1] > freeze[0]) {
    out.push({
      id: 'autumn',
      title: 'Осеннее окно обменов',
      open: true,
      startDay: 0,
      endDay: freeze[0] - 1,
      status: statusOf(0, freeze[0] - 1),
      note: 'Старт регулярного чемпионата — открыты обмены между всеми клубами.',
    });
    out.push({
      id: 'freeze',
      title: 'Пауза сборных (мораторий)',
      open: false,
      startDay: freeze[0],
      endDay: freeze[1] - 1,
      status: statusOf(freeze[0], freeze[1] - 1),
      note: 'Временный мораторий на обмены на время международного окна сборных.',
    });
    out.push({
      id: 'winter',
      title: 'Зимнее окно («Преддедлайновое»)',
      open: true,
      startDay: freeze[1],
      endDay: Math.max(freeze[1], deadline - 1),
      status: statusOf(freeze[1], Math.max(freeze[1], deadline - 1)),
      note: 'Горячий рынок перед дедлайном: претенденты активно ищут усиление.',
    });
  } else {
    out.push({
      id: 'autumn',
      title: 'Регулярное окно обменов',
      open: true,
      startDay: 0,
      endDay: Math.max(0, deadline - 1),
      status: statusOf(0, Math.max(0, deadline - 1)),
      note: `Обмены разрешены до наступления дедлайна ${LG()}.`,
    });
  }
  out.push({
    id: 'closed',
    title: 'Запрет после дедлайна и плей-офф',
    open: false,
    startDay: deadline,
    endDay: Math.max(deadline, Math.max(reg, state.schedule.length) - 1),
    status: isOff ? 'past' : d >= deadline || state.phase === 'playoffs' ? 'active' : 'upcoming',
    note: 'Обмены закрыты до конца Кубка Гагарина; доступно только подписание свободных агентов.',
  });
  out.push({
    id: 'offseason',
    title: 'Межсезонное окно обменов',
    open: true,
    startDay: Math.max(reg, state.schedule.length),
    endDay: Math.max(reg, state.schedule.length),
    status: isOff ? 'active' : 'upcoming',
    note: 'После финала Кубка Гагарина все ограничения на переходы снимаются.',
  });
  return out;
}

export function tradeWindow(state: GameState): { open: boolean; daysLeft: number; windowId: string; windowTitle: string; text: string } {
  if (state.phase === 'offseason') {
    return { open: true, daysLeft: Infinity, windowId: 'offseason', windowTitle: 'Межсезонное окно', text: 'Межсезонье: окно обменов открыто без ограничений.' };
  }
  if (state.phase === 'season') {
    const deadline = tradeDeadline(state);
    const freeze = novemberTradeFreeze(state);
    if (freeze && state.day >= freeze[0] && state.day < freeze[1]) {
      const freezeLeft = freeze[1] - state.day;
      return {
        open: false,
        daysLeft: Math.max(0, deadline - state.day),
        windowId: 'freeze',
        windowTitle: 'Пауза сборных (мораторий)',
        text: `Мораторий на обмены на время паузы сборных (ещё ${freezeLeft} дн.). До дедлайна обменов: ${deadline - state.day} дн.`,
      };
    }
    const left = deadline - state.day;
    if (left > 0) {
      const isWinter = freeze ? state.day >= freeze[1] : state.day >= Math.floor(deadline * 0.6);
      const title = isWinter ? 'Зимнее окно обменов' : 'Осеннее окно обменов';
      return {
        open: true,
        daysLeft: left,
        windowId: isWinter ? 'winter' : 'autumn',
        windowTitle: title,
        text: `${title} · До дедлайна обменов: ${left} игровых дн.`,
      };
    }
  }
  return { open: false, daysLeft: 0, windowId: 'closed', windowTitle: 'Окно закрыто', text: 'Дедлайн обменов прошёл. Окно откроется в межсезонье; свободных агентов подписывать можно.' };
}

export interface TeamCtx {
  mode: 'contend' | 'middle' | 'rebuild';
  /** league average of dressed players minus this club's, per group: positive = the club is weak there */
  need: Record<Group, number>;
  counts: Record<Group, number>;
  /** rating of the weakest dressed player per group */
  worst: Record<Group, number>;
  /** players the club builds around */
  franchise: Set<string>;
}

interface LeagueCtx {
  key: string;
  avg: Record<Group, number>;
  strengthRank: Record<string, number>;
  teams: Record<string, TeamCtx>;
}
let leagueCache: LeagueCtx | null = null;
export function clearTradeCache() {
  leagueCache = null;
}

function dressedOvr(state: GameState, teamId: string, g: Group): number[] {
  const list = state.teams[teamId].players.map((id) => state.players[id]).filter((p) => p && groupOf(p) === g).map((p) => p.overall).sort((a, b) => b - a).slice(0, DRESSED[g]);
  while (list.length < DRESSED[g]) list.push(55);
  return list;
}
const avgOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

function league(state: GameState): LeagueCtx {
  const key = `${state.saveId}|${state.seasonNumber}|${state.phase}|${state.day}`;
  if (leagueCache && leagueCache.key === key) return leagueCache;
  const avg: Record<Group, number> = { F: 0, D: 0, G: 0 };
  const str: [string, number][] = [];
  for (const id of state.teamOrder) {
    const a = { F: avgOf(dressedOvr(state, id, 'F')), D: avgOf(dressedOvr(state, id, 'D')), G: avgOf(dressedOvr(state, id, 'G')) };
    for (const g of GROUPS) avg[g] += a[g] / state.teamOrder.length;
    str.push([id, a.F * 0.5 + a.D * 0.3 + a.G * 0.2]);
  }
  str.sort((a, b) => b[1] - a[1]);
  const strengthRank: Record<string, number> = {};
  str.forEach(([id], i) => (strengthRank[id] = i + 1));
  leagueCache = { key, avg, strengthRank, teams: {} };
  return leagueCache;
}

export function teamContext(state: GameState, teamId: string): TeamCtx {
  const L = league(state);
  if (L.teams[teamId]) return L.teams[teamId];
  const t = state.teams[teamId];
  const P = state.players;
  const need = {} as Record<Group, number>;
  const counts = {} as Record<Group, number>;
  const worst = {} as Record<Group, number>;
  for (const g of GROUPS) {
    const d = dressedOvr(state, teamId, g);
    need[g] = L.avg[g] - avgOf(d);
    worst[g] = d[d.length - 1];
    counts[g] = t.players.filter((id) => groupOf(P[id]) === g).length;
  }
  const sk = t.players.map((id) => P[id]).filter(isSkater).sort(byOvr);
  const go = t.players.map((id) => P[id]).filter(isGoalie).sort(byOvr);
  const franchise = new Set<string>([...sk.slice(0, 2).map((p) => p.id), ...go.slice(0, 1).map((p) => p.id)]);
  const n = state.teamOrder.length;
  const progress = state.phase === 'season' ? state.day / Math.max(1, regularDays(state)) : 0;
  let mode: TeamCtx['mode'];
  if (state.phase !== 'season' || progress < 0.15) {
    const r = L.strengthRank[teamId] / n;
    mode = r <= 0.34 ? 'contend' : r >= 0.7 ? 'rebuild' : 'middle';
  } else {
    const conf = state.teamOrder.filter((id) => state.teams[id].conference === t.conference);
    const place = 1 + conf.filter((id) => id !== teamId && state.teams[id].record.points > t.record.points).length;
    mode = place <= 5 ? 'contend' : place >= Math.min(10, conf.length - 2) ? 'rebuild' : 'middle';
  }
  return (L.teams[teamId] = { mode, need, counts, worst, franchise });
}

/** What a player is worth to a particular club: its ambitions and holes in the line-up change the price. */
export function valueFor(ctx: TeamCtx, p: Player): number {
  let v = tradeValue(p);
  if (ctx.mode === 'contend') {
    if (p.age >= 30) v *= 1.2;
    else if (p.age <= 22 && p.overall < 72) v *= 0.85;
  } else if (ctx.mode === 'rebuild') {
    if (p.age >= 30) v *= 0.65;
    else if (p.age <= 24) v *= 1.15;
  }
  v *= 1 + 0.12 * clamp(ctx.need[groupOf(p)] / 4, -1, 1);
  if (p.injury && p.injury.days > 12) v *= 0.8;
  return v;
}

function sideProblem(state: GameState, teamId: string, gives: string[], gets: string[], min: Record<Group, number>): string | null {
  const P = state.players;
  const t = state.teams[teamId];
  for (const id of gives) {
    const p = P[id];
    if (p?.nmc && p.morale >= 52) {
      return `у игрока ${p.name} («${t.name}») действует запрет на обмен (ЗНО)`;
    }
  }
  const after = t.players.filter((id) => !gives.includes(id)).concat(gets);
  for (const g of GROUPS) {
    const n = after.filter((id) => groupOf(P[id]) === g).length;
    if (n < min[g]) return `у клуба «${t.name}» останется слишком мало ${GROUP_MANY[g]} (${n}, нужно минимум ${min[g]})`;
  }
  if (activeKhlCount(after, P) > MAX_ROSTER) return `в основном составе ${LG()} «${t.name}» окажется больше ${MAX_ROSTER} игроков`;
  const fl = teamForeignLimit(t, state.league.foreignLimit);
  if (fl !== null) {
    const beforeLeg = countRosterLegionnaires(t.players, P);
    const afterLeg = countRosterLegionnaires(after, P);
    if (afterLeg > fl && (afterLeg > beforeLeg || gets.some((id) => isLegionnaire(P[id])))) {
      return `«${t.name}» превышает лимит легионеров (${afterLeg} из ${fl})`;
    }
  }
  const dead = state.phase === 'offseason' ? 0 : (t.deadCap ?? 0);
  const beforeRelief = state.phase === 'offseason' ? 0 : teamVhlCapRelief(t.players, P);
  const afterRelief = state.phase === 'offseason' ? 0 : teamVhlCapRelief(after, P);
  const beforePay = Math.max(0, payroll(t.players, P) - beforeRelief + dead);
  const afterPay = Math.max(0, payroll(after, P) - afterRelief + dead);
  const cap = state.league.salaryCap;
  if (afterPay > cap) {
    const isUserDump = teamId === state.userTeamId && beforePay > cap && afterPay <= beforePay - 5_000_000;
    if (!isUserDump) return `«${t.name}» не укладывается в потолок зарплат`;
  }
  return null;
}
/** Roster and salary-cap check for the manager's club. */
export const userSideProblem = (state: GameState, gives: string[], gets: string[]) => sideProblem(state, state.userTeamId, gives, gets, USER_MIN);

/** Roster and salary-cap check for an AI club. */
export const clubSideProblem = (state: GameState, teamId: string, gives: string[], gets: string[]) => sideProblem(state, teamId, gives, gets, MIN_ROSTER);

/** Would this AI club agree to give `out` for `inc`? */
function clubAccepts(state: GameState, teamId: string, out: string[], inc: string[], margin: number): { ok: boolean; ratio: number; franchise: boolean; problem: string | null } {
  const P = state.players;
  const ctx = teamContext(state, teamId);
  const problem = sideProblem(state, teamId, out, inc, MIN_ROSTER);
  let franchise = false;
  let vOut = 0;
  for (const id of out) {
    const f = ctx.franchise.has(id);
    franchise = franchise || f;
    vOut += valueFor(ctx, P[id]) * (f ? 1.3 : 1);
  }
  const vInc = inc.reduce((a, id) => a + valueFor(ctx, P[id]), 0);
  const ratio = vInc / Math.max(0.01, vOut);
  return { ok: !problem && ratio >= margin, ratio, franchise, problem };
}

/** The manager offers `give` for the partner's `get`. */
export function evaluateTrade(state: GameState, partnerId: string, give: string[], get: string[]): { ok: boolean; reason: string; ratio: number } {
  const partner = state.teams[partnerId];
  if (!give.length || !get.length) return { ok: false, reason: 'Добавьте игроков с обеих сторон', ratio: 0 };
  const r = clubAccepts(state, partnerId, get, give, 1.03);
  if (r.ok) return { ok: true, reason: `${partner.name} принимает предложение`, ratio: r.ratio };
  if (r.problem) return { ok: false, reason: `${partner.name} отклоняет: ${r.problem}`, ratio: r.ratio };
  const ctx = teamContext(state, partnerId);
  const P = state.players;
  const gap = Math.round((1.03 / Math.max(0.01, r.ratio) - 1) * 100);
  const notes: string[] = [];
  if (r.franchise) notes.push('лидеров команды отдают только с серьёзной доплатой');
  if (ctx.mode === 'rebuild' && give.some((id) => P[id].age >= 30)) notes.push('клуб перестраивается и не ценит возрастных игроков');
  if (ctx.mode === 'contend' && give.some((id) => P[id].age <= 22 && P[id].overall < 72)) notes.push('клуб борется за кубок, проспекты ему сейчас не нужны');
  const unwanted = give.map((id) => groupOf(P[id])).find((g) => ctx.need[g] < -1.5);
  if (unwanted) notes.push(`у них и так сильная линия: ${GROUP_MANY[unwanted]} им не нужны`);
  return { ok: false, reason: `${partner.name} отклоняет: по их оценке не хватает ~${gap}% ценности${notes.length ? ' (' + notes.join('; ') + ')' : ''}`, ratio: r.ratio };
}

export function executeTrade(state: GameState, aId: string, bId: string, aGives: string[], bGives: string[]) {
  const P = state.players;
  const A = state.teams[aId];
  const B = state.teams[bId];
  const move = (id: string, from: Team, to: Team) => {
    const p = P[id];
    if (!p || p.teamId !== from.id) return;
    p.teamId = to.id;
    p.inVhl = false;
    if (p.age < 28) p.rightsTeamId = to.id;
    delete p.tradeFlag;
    delete p.talks;
    from.players = from.players.filter((x) => x !== id);
    to.players.push(id);
  };
  for (const id of aGives) move(id, A, B);
  for (const id of bGives) move(id, B, A);
  state.offers = state.offers.filter((o) => ![...o.give, ...o.get].some((id) => aGives.includes(id) || bGives.includes(id)));
  for (const t of [A, B]) {
    ensureCaptains(t, P);
    const opts = lineupConstraintsFor(state, t.id);
    if (t.id === state.userTeamId) t.lineup = sanitizeLineup(t.lineup, t.players, P, opts);
    else t.lineup = autoLineup(t.players, P, opts);
  }
  clearTradeCache();
}

function weightedPick<T>(items: T[], w: (t: T) => number): T | null {
  let total = 0;
  const ws = items.map((it) => {
    const x = Math.max(0, w(it));
    total += x;
    return x;
  });
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= ws[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

export interface Proposal {
  /** players the proposing club gives */
  give: string[];
  /** players it wants in return */
  get: string[];
  reason: string;
}

/**
 * A trade the club `fromId` would realistically propose to `toId`: it looks for a real upgrade at its
 * weakest position, pays with players it can spare (never its leaders), offers fair value and makes
 * sure both rosters and both payrolls stay legal.
 */
export function generateProposal(state: GameState, fromId: string, toId: string): Proposal | null {
  const P = state.players;
  const F = state.teams[fromId];
  const T = state.teams[toId];
  const cf = teamContext(state, fromId);
  const ct = teamContext(state, toId);
  const toUser = toId === state.userTeamId;

  // 1. Which position does the club want to fix?
  const wanted = GROUPS.filter((g) => cf.need[g] > 0.4 || cf.counts[g] < MIN_ROSTER[g] + (g === 'G' ? 0 : 1)).sort((a, b) => cf.need[b] - cf.need[a]);
  if (!wanted.length) {
    if (Math.random() < 0.6) return null;
    wanted.push(cf.need.F >= cf.need.D ? 'F' : 'D');
  }
  const g = wanted[0];

  // 2. Who on the other roster is a real upgrade there (and realistically obtainable)?
  const targets = T.players.map((id) => P[id]).filter((p) => {
    if (groupOf(p) !== g || p.injury || p.contract.years <= 0 || p.tradeFlag === 'keep' || (p.nmc && p.morale >= 52)) return false;
    if (ct.franchise.has(p.id) && p.tradeFlag !== 'block') return false;
    if (p.overall < cf.worst[g] + 2) return false;
    if (cf.mode === 'rebuild' && p.age > 27) return false;
    if (cf.mode === 'contend' && p.age <= 21 && p.overall < cf.worst[g] + 4) return false;
    return true;
  });
  const X = weightedPick(targets, (p) => (p.tradeFlag === 'block' ? 5 : 1) * (1 + (p.overall - cf.worst[g]) / 8));
  if (!X) return null;
  const vx = tradeValue(X);

  // 3. What can the club pay with? Not its leaders, not the position it is trying to fix.
  const spare = F.players.map((id) => P[id]).filter((p) => !p.injury && !(p.nmc && p.morale >= 52) && p.contract.years > 0 && !cf.franchise.has(p.id) && groupOf(p) !== g && cf.counts[groupOf(p)] > MIN_ROSTER[groupOf(p)]);
  const fit = (p: Player) => {
    let s = clamp(ct.need[groupOf(p)] / 4, -1, 1) * 0.06; // helps the partner where it is weak
    s += Math.min(3, cf.counts[groupOf(p)] - MIN_ROSTER[groupOf(p)]) * 0.01; // comes from depth
    if (cf.mode === 'contend') s += p.age <= 24 ? 0.04 : 0; // contenders pay with youth
    if (cf.mode === 'rebuild') s += p.age >= 29 ? 0.05 : -0.03; // rebuilders sell veterans
    return s;
  };
  type Opt = { ids: Player[]; score: number };
  const opts: Opt[] = [];
  for (const p of spare) {
    const r = tradeValue(p) / vx;
    if (r >= 0.93 && r <= 1.15 && p.overall >= X.overall - 7) opts.push({ ids: [p], score: Math.abs(r - 1.04) - fit(p) });
  }
  if (!opts.length) {
    const pool = spare.filter((p) => tradeValue(p) < vx * 0.9 && p.overall >= 64).sort((a, b) => tradeValue(b) - tradeValue(a)).slice(0, 14);
    for (let i = 0; i < pool.length; i++)
      for (let j = i + 1; j < pool.length; j++) {
        const r = (tradeValue(pool[i]) + tradeValue(pool[j])) / vx;
        if (r >= 0.97 && r <= 1.2 && Math.max(pool[i].overall, pool[j].overall) >= X.overall - 6) opts.push({ ids: [pool[i], pool[j]], score: Math.abs(r - 1.08) - fit(pool[i]) - fit(pool[j]) + 0.02 });
      }
  }
  opts.sort((a, b) => a.score - b.score);

  // 4. The first package that the proposing club itself is happy with and that keeps everything legal.
  for (const o of opts.slice(0, 8)) {
    const give = o.ids.map((p) => p.id);
    const own = clubAccepts(state, fromId, give, [X.id], 0.97);
    if (!own.ok) continue;
    if (toUser ? userSideProblem(state, [X.id], give) : sideProblem(state, toId, [X.id], give, MIN_ROSTER)) continue;
    let reason = cf.mode === 'contend' ? `${F.name} борется за высокие места и хочет усилить ${GROUP_ACC[g]}` : cf.mode === 'rebuild' ? `${F.name} перестраивает состав и ищет молодого ${GROUP_ONE[g]}` : `${F.name} не хватает глубины: клуб ищет ${GROUP_ONE[g]}`;
    if (X.tradeFlag === 'block') reason += ' — игрок выставлен на обмен';
    return { give, get: [X.id], reason };
  }
  return null;
}

const shuffled = <T,>(xs: T[]): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
/** Trade talk gets busier in the winter window and peaks right before the deadline. */
const deadlineHeat = (state: GameState) => {
  const w = tradeWindow(state);
  if (!w.open) return 0;
  if (w.daysLeft <= 8) return 2.2;
  return w.windowId === 'winter' ? 1.15 : 0.9;
};

/* ---------------- trade block ---------------- */

const POS_LONG: Record<PosCode, string> = { C: 'центральный', LW: 'левый нападающий', RW: 'правый нападающий', D: 'защитник', G: 'вратарь' };

export const defaultTradeBlock = (): TradeBlock => ({ wants: { positions: [], minOvr: 0, maxAge: 40, maxSalary: 0 } });

export function ensureTradeBlock(state: GameState): TradeBlock {
  state.tradeBlock ??= defaultTradeBlock();
  const w = state.tradeBlock.wants;
  w.positions ??= [];
  w.minOvr ??= 0;
  w.maxAge ??= 40;
  w.maxSalary ??= 0;
  return state.tradeBlock;
}

/** The manager has said what he is looking for. */
export const hasWants = (w: TradeBlockWants | undefined) => !!w && (w.positions.length > 0 || w.minOvr > 0 || w.maxAge < 40 || w.maxSalary > 0);

/** Does a player fit what the manager is looking for? Ratings are judged by the AI club's honest view. */
export function matchesWants(w: TradeBlockWants, p: Player): boolean {
  if (w.positions.length && !w.positions.includes(p.position)) return false;
  if (w.minOvr && p.overall < w.minOvr) return false;
  if (w.maxAge < 40 && p.age > w.maxAge) return false;
  if (w.maxSalary && p.contract.salary > w.maxSalary) return false;
  return true;
}

/** Players the manager has put on the block. */
export const userBlockPlayers = (state: GameState): Player[] =>
  state.teams[state.userTeamId].players.map((id) => state.players[id]).filter((p) => p && p.tradeFlag === 'block');

/**
 * An offer aimed at the manager's trade block: the club takes one of the players he wants to move
 * (or, with an empty block, a player it needs) and pays with players that match his wish list.
 */
export function generateBlockProposal(state: GameState, fromId: string): Proposal | null {
  const P = state.players;
  const F = state.teams[fromId];
  const U = state.teams[state.userTeamId];
  const cf = teamContext(state, fromId);
  const cu = teamContext(state, U.id);
  const wants = ensureTradeBlock(state).wants;
  const available = (p: Player) => !p.injury && !(p.nmc && p.morale >= 52) && p.contract.years > 0;

  // 1. What do they take from us?
  const block = userBlockPlayers(state).filter(available);
  let targets: Player[];
  if (block.length) targets = block.filter((p) => cf.need[groupOf(p)] > -2.5 || p.overall >= cf.worst[groupOf(p)] + 2);
  else {
    if (!hasWants(wants)) return null;
    targets = U.players
      .map((id) => P[id])
      .filter((p) => p && available(p) && p.tradeFlag !== 'keep' && !cu.franchise.has(p.id) && cf.need[groupOf(p)] > 0.3 && p.overall >= cf.worst[groupOf(p)] + 2);
  }
  const X = weightedPick(targets, (p) => valueFor(cf, p) * (1 + Math.max(0, cf.need[groupOf(p)]) / 3));
  if (!X) return null;
  const vx = valueFor(cf, X);

  // 2. What can they pay with that we actually want?
  const spare = F.players
    .map((id) => P[id])
    .filter((p) => p && available(p) && !cf.franchise.has(p.id) && cf.counts[groupOf(p)] - (groupOf(p) === groupOf(X) ? 0 : 1) >= MIN_ROSTER[groupOf(p)]);
  const fit = hasWants(wants) ? spare.filter((p) => matchesWants(wants, p)) : spare.filter((p) => groupOf(p) !== groupOf(X) || cu.need[groupOf(p)] > 0);
  if (!fit.length) return null;
  type Opt = { ids: Player[]; score: number };
  const opts: Opt[] = [];
  const sorted = [...fit].sort((a, b) => b.overall - a.overall).slice(0, 12);
  for (const p of sorted) {
    const r = valueFor(cf, p) / vx;
    if (r >= 0.8 && r <= 1.05) opts.push({ ids: [p], score: Math.abs(r - 0.97) - p.overall / 400 });
  }
  // add a depth player from anywhere on their roster to balance the value
  const filler = spare.filter((p) => p.overall >= 62).sort((a, b) => tradeValue(a) - tradeValue(b)).slice(0, 8);
  for (const p of sorted)
    for (const q of filler) {
      if (q.id === p.id) continue;
      const r = (valueFor(cf, p) + valueFor(cf, q)) / vx;
      if (r >= 0.85 && r <= 1.05) opts.push({ ids: [p, q], score: Math.abs(r - 0.97) + 0.05 - p.overall / 400 });
    }
  opts.sort((a, b) => a.score - b.score);
  for (const o of opts.slice(0, 10)) {
    const give = o.ids.map((p) => p.id);
    if (!clubAccepts(state, fromId, give, [X.id], 0.95).ok) continue;
    if (userSideProblem(state, [X.id], give)) continue;
    const main = o.ids[0];
    const why = block.length ? `${F.name} откликается на ваш блок обменов: интересен ${X.name}` : `${F.name} видит ваш запрос и ищет ${GROUP_ONE[groupOf(X)]}`;
    return { give, get: [X.id], reason: `${why}; взамен — ${POS_LONG[main.position]} ${main.name} (${main.age} л.)${hasWants(wants) ? ', как вы и просили' : ''}` };
  }
  return null;
}

/** "Ask around the league": every club looks at the trade block once; up to three offers come back. */
export function shopTradeBlock(state: GameState): { offers: TradeOffer[]; error: string | null } {
  const w = tradeWindow(state);
  if (!w.open) return { offers: [], error: 'Окно обменов закрыто' };
  const tb = ensureTradeBlock(state);
  if (!userBlockPlayers(state).length && !hasWants(tb.wants)) return { offers: [], error: 'Выставьте игроков на обмен или укажите, кого вы ищете' };
  if (tb.lastShopDay != null && state.day - tb.lastShopDay < 7 && state.phase !== 'offseason') return { offers: [], error: `Клубы уже изучили ваш блок. Повторный запрос — через ${7 - (state.day - tb.lastShopDay)} дн.` };
  tb.lastShopDay = state.day;
  const freeze = novemberTradeFreeze(state);
  const maxDay = state.phase !== 'season' ? state.day + 5 : freeze && state.day < freeze[0] ? freeze[0] - 1 : tradeDeadline(state) - 1;
  const out: TradeOffer[] = [];
  for (const id of shuffled(state.teamOrder.filter((x) => x !== state.userTeamId))) {
    if (out.length >= 3 || state.offers.length + out.length >= 6) break;
    const p = generateBlockProposal(state, id);
    if (!p) continue;
    const clash = [...state.offers, ...out].some((o) => o.get.some((x) => p.get.includes(x)) || o.give.some((x) => p.give.includes(x)));
    if (clash) continue;
    out.push({ id: Date.now() + Math.floor(Math.random() * 100000), from: id, give: p.give, get: p.get, expires: Math.max(state.day, Math.min(state.day + 5, maxDay)), day: state.day, reason: p.reason });
  }
  return { offers: out, error: out.length ? null : 'Ни один клуб пока не готов к сделке на ваших условиях. Ослабьте требования или добавьте игроков в блок.' };
}

export function maybeIncomingOffer(state: GameState): TradeOffer | null {
  const w = tradeWindow(state);
  if (state.phase !== 'season' || !w.open || state.offers.length >= 3) return null;
  const user = state.teams[state.userTeamId];
  const onBlock = user.players.some((id) => state.players[id].tradeFlag === 'block');
  const wants = hasWants(state.tradeBlock?.wants);
  if (Math.random() > 0.09 * deadlineHeat(state) * (onBlock ? 1.6 : 1) * (wants ? 1.25 : 1)) return null;
  const freeze = novemberTradeFreeze(state);
  const maxDay = freeze && state.day < freeze[0] ? freeze[0] - 1 : tradeDeadline(state) - 1;
  if (maxDay < state.day) return null;
  for (const id of shuffled(state.teamOrder.filter((x) => x !== user.id)).slice(0, 6)) {
    // Clubs that know what we want try to build the offer around our trade block first.
    const p = (onBlock || wants) && Math.random() < 0.65 ? generateBlockProposal(state, id) ?? generateProposal(state, id, user.id) : generateProposal(state, id, user.id);
    if (!p) continue;
    if (state.offers.some((o) => o.get.some((x) => p.get.includes(x)) || o.give.some((x) => p.give.includes(x)))) continue;
    return { id: Date.now() + Math.floor(Math.random() * 1000), from: id, give: p.give, get: p.get, expires: Math.min(state.day + 5, maxDay), day: state.day, reason: p.reason };
  }
  return null;
}

const describe = (p: Player) => `${p.name} (${POS_RU[p.position]}, ${p.age} л., ${p.overall})`;

/** A trade between two AI clubs, built with the same logic as the offers the manager receives. */
export function maybeAiTrade(state: GameState): NewsItem | null {
  if (state.phase !== 'season' || !tradeWindow(state).open || Math.random() > 0.2 * deadlineHeat(state)) return null;
  const others = shuffled(state.teamOrder.filter((id) => id !== state.userTeamId));
  if (others.length < 2) return null;
  const aId = others[0];
  for (const bId of others.slice(1, 5)) {
    const p = generateProposal(state, aId, bId);
    if (!p) continue;
    if (!clubAccepts(state, bId, p.get, p.give, 1.0).ok) continue;
    const P = state.players;
    const text = `Обмен: ${state.teams[aId].name} получает ${p.get.map((id) => describe(P[id])).join(', ')} из клуба ${state.teams[bId].name} за ${p.give.map((id) => describe(P[id])).join(' и ')}. ${p.reason}.`;
    executeTrade(state, aId, bId, p.give, p.get);
    return { id: 0, day: state.day, type: 'trade', text };
  }
  return null;
}
