import type { Game } from '../types';

export const WEEKDAY_CAP_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'] as const;
export const WEEKDAY_SHORT_RU = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'] as const;
export const WEEKDAY_FULL_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'] as const;
export const MONDAY_FIRST_HEADERS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const;
export const MONTH_NAMES_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'] as const;

export function seasonStartYear(season = '2025/26'): number {
  return Number(season.match(/^\d{4}/)?.[0]) || 2025;
}

export interface ScheduleTeam {
  id: string;
  conference?: string;
  division?: string;
}

function seasonRng(seed: number) {
  let n = seed >>> 0 || 1;
  return () => {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    return n / 4294967296;
  };
}

/** Calendar layout of a regular season: day 0 is September 1; first matchday, last matchday and pauses. */
export function seasonLayout(gamesPerTeam: number, season = '2025/26'): { days: number; start: number; breaks: [number, number][] } {
  const year = seasonStartYear(season);
  if (gamesPerTeam < 40) return { days: Math.max(1, Math.round(gamesPerTeam * 2.6)), start: 0, breaks: [] };
  // KHL opens on the first Saturday from September 3rd (5 Sep 2026) and closes around 20 March.
  let start = 2;
  while (new Date(year, 8, 1 + start).getDay() !== 6) start++;
  const days = start + Math.round(gamesPerTeam * 2.9);
  const at = (f: number) => Math.round(days * f);
  // Pauses for national-team weeks (November, December, February) and the All-Star weekend.
  // The November pause and All-Star day match novemberTradeFreeze / allStarTargetDay.
  const nov = Math.floor(days * 0.39);
  const asg = Math.max(12, Math.min(Math.max(12, days - 8), at(0.62)));
  return { days, start, breaks: [[nov, nov + 5], [at(0.525), at(0.525) + 4], [asg - 1, asg + 1], [at(0.8), at(0.8) + 5]] };
}

/**
 * Pairings for one regular season, KHL style: everyone meets everyone twice (home and away), clubs of the
 * same conference meet twice more, and the remaining games (6 of 68 in the KHL) go to extra opponents
 * picked by the league — division rivals first, then the rest of the conference. Home/away is balanced.
 */
export function buildMatchups(teams: ScheduleTeam[], gamesPerTeam: number, rand: () => number = Math.random): [string, string][] {
  const n = teams.length;
  const ids = teams.map((t) => t.id);
  const need = new Array<number>(n).fill(gamesPerTeam);
  const count: number[][] = ids.map(() => new Array<number>(n).fill(0));
  const add = (a: number, b: number, k: number) => { count[a][b] += k; count[b][a] += k; need[a] -= k; need[b] -= k; };
  const confs = [...new Set(teams.map((t) => t.conference ?? ''))].filter(Boolean);
  const hasConf = confs.length === 2 && teams.every((t) => t.conference) && confs.every((c) => teams.filter((t) => t.conference === c).length >= 2);
  const same = (a: number, b: number) => hasConf && teams[a].conference === teams[b].conference;
  const sameDiv = (a: number, b: number) => same(a, b) && !!teams[a].division && teams[a].division === teams[b].division;
  if (n < 2) return [];
  while (need.every((x) => x >= 2 * (n - 1))) for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) add(a, b, 2);
  if (hasConf) {
    const size = (i: number) => teams.filter((t) => t.conference === teams[i].conference).length;
    while (need.every((x, i) => x >= 2 * (size(i) - 1))) for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (same(a, b)) add(a, b, 2);
  }
  // Extra opponents: Havel–Hakimi (largest remaining need first), ties broken by division → conference → fewest meetings.
  const extra: [number, number][] = [];
  const fill = (pool: number[]) => {
    const used = new Set<string>();
    for (let guard = 0; guard < 10000; guard++) {
      const open = pool.filter((i) => need[i] > 0).sort((x, y) => need[y] - need[x] || x - y);
      if (open.length < 2) return;
      const a = open[0];
      const cands = open.slice(1).filter((b) => !used.has(`${Math.min(a, b)}|${Math.max(a, b)}`));
      const list = (cands.length ? cands : open.slice(1))
        .map((b) => ({ b, k: need[b] * 10 + (sameDiv(a, b) ? 3 : same(a, b) ? 1.5 : 0) - count[a][b] * 0.1 + rand() * 0.2 }))
        .sort((x, y) => y.k - x.k);
      const take = list.slice(0, need[a]);
      if (!take.length) return;
      for (const { b } of take) { add(a, b, 1); extra.push([a, b]); used.add(`${Math.min(a, b)}|${Math.max(a, b)}`); }
    }
  };
  if (hasConf) for (const c of confs) fill(ids.map((_, i) => i).filter((i) => teams[i].conference === c));
  fill(ids.map((_, i) => i));
  // Home/away: pairs met an even number of times split evenly; single extra games are oriented to balance.
  const homes = new Array<number>(n).fill(0), away = new Array<number>(n).fill(0);
  const out: [number, number][] = [];
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const base = count[a][b] - extra.filter(([x, y]) => (x === a && y === b) || (x === b && y === a)).length;
    for (let k = 0; k < base; k++) { const h = k % 2 ? b : a, v = k % 2 ? a : b; out.push([h, v]); homes[h]++; away[v]++; }
  }
  const ext: [number, number][] = extra.map(([a, b]) => (homes[a] - away[a] <= homes[b] - away[b] ? [a, b] : [b, a]));
  for (const [h, v] of ext) { homes[h]++; away[v]++; }
  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    for (const e of ext) {
      const [h, v] = e, dh = homes[h] - away[h], dv = homes[v] - away[v];
      if (dh - dv >= 2 + 1e-9 && dh > 0 && dv < 0 || dh - dv > 2) { e[0] = v; e[1] = h; homes[h]--; away[h]++; homes[v]++; away[v]--; changed = true; }
    }
    if (!changed) break;
  }
  return [...out, ...ext].map(([h, v]) => [ids[h], ids[v]]);
}

/**
 * Realistic KHL regular-season calendar on consecutive dates from September 1 (day 0):
 * conference-aware pairings (see buildMatchups), opening on the first September Saturday and running to
 * about 20 March with national-team and All-Star pauses. Every club plays roughly every other or third
 * day, never twice on one date and almost never on consecutive days; home stands and road trips last
 * 2–4 games (never more than 5), road trips stay in one region where possible, and the meetings of a
 * pair are spread through the season.
 */
export function buildSchedule(teamsIn: (string | ScheduleTeam)[], gamesPerTeam: number, firstId = 1, season = '2025/26'): { days: Game[][]; nextId: number } {
  const teams: ScheduleTeam[] = teamsIn.map((t) => (typeof t === 'string' ? { id: t } : t));
  const n = teams.length;
  if (n < 2) return { days: [], nextId: firstId };
  const year = seasonStartYear(season);
  const rand = seasonRng(year * 7919 + n * 131 + gamesPerTeam);
  const pool = buildMatchups(teams, gamesPerTeam, rand).map(([home, away]) => ({ home, away, r: rand() }));
  const total = pool.length;
  if (!total) return { days: [], nextId: firstId };
  const conf = new Map(teams.map((t) => [t.id, t.conference ?? '']));
  const div = new Map(teams.map((t) => [t.id, t.division ?? '']));
  const lay = seasonLayout(gamesPerTeam, season);
  const D = Math.max(lay.days, Math.ceil((total / Math.max(1, Math.floor(n / 2))) * 1.6) + lay.start);
  const off = new Array<boolean>(D).fill(false);
  for (const [a, b] of lay.breaks) for (let d = a; d <= b && d < D; d++) if (d >= 0) off[d] = true;
  for (let d = 0; d < lay.start; d++) off[d] = true;
  const playable: number[] = [];
  for (let d = 0; d < D; d++) if (!off[d]) playable.push(d);
  // Per-day slate: busier Tue/Thu/Sat/Sun, lighter Mon/Wed/Fri.
  const maxPerDay = Math.floor(n / 2);
  const w = playable.map((d) => { const wd = new Date(year, 8, 1 + d).getDay(); return wd === 0 || wd === 2 || wd === 4 || wd === 6 ? 1.25 : 0.8; });
  const wSum = w.reduce((a, b) => a + b, 0);
  const quota = new Map<number, number>();
  let acc = 0, given = 0;
  playable.forEach((d, i) => { acc += (total * w[i]) / wSum; const q = Math.min(maxPerDay, Math.round(acc) - given); quota.set(d, Math.max(0, q)); given += Math.max(0, q); });

  interface TS { played: number; last: number; venue: 'H' | 'A' | ''; streak: number; host: string; target: number; remH: number; remA: number }
  const st = new Map<string, TS>(teams.map((t) => [t.id, { played: 0, last: -99, venue: '', streak: 0, host: '', target: 0, remH: 0, remA: 0 }]));
  for (const g of pool) { st.get(g.home)!.target++; st.get(g.away)!.target++; st.get(g.home)!.remH++; st.get(g.away)!.remA++; }
  const pairTotal = new Map<string, number>(), pairMet = new Map<string, number>(), pairLast = new Map<string, number>();
  const pk = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const g of pool) pairTotal.set(pk(g.home, g.away), (pairTotal.get(pk(g.home, g.away)) ?? 0) + 1);
  const first = playable[0] ?? 0, span = Math.max(1, (playable[playable.length - 1] ?? D - 1) - first);

  const scoreSide = (t: TS, venue: 'H' | 'A', d: number) => {
    const progress = (d - first) / span;
    let sc = (t.target * progress - t.played) * 1.6; // keep pace with the season
    // keep the remaining home and away games level, so the run-in is not one long home stand
    const rem = t.remH + t.remA, lean = venue === 'H' ? t.remH - t.remA : t.remA - t.remH;
    sc += lean * (rem < 16 ? 0.6 : 0.25);
    const rest = d - t.last;
    sc += rest >= 5 ? 2 : rest >= 4 ? 1.2 : rest === 3 ? 0.5 : 0;
    if (t.venue === venue) sc += t.streak === 1 ? 0.6 : t.streak === 2 ? 0.1 : t.streak === 3 ? -1.4 : -4;
    else if (t.venue) sc += t.streak >= 4 ? 1.6 : t.streak === 3 ? 0.9 : t.streak === 1 ? -0.25 : 0;
    return sc;
  };
  const days: Game[][] = [];
  let gid = firstId;
  const place = (d: number, g: { home: string; away: string }) => {
    const h = st.get(g.home)!, a = st.get(g.away)!;
    for (const [t, v] of [[h, 'H'], [a, 'A']] as const) { t.streak = t.venue === v ? t.streak + 1 : 1; t.venue = v; t.last = d; t.played++; }
    a.host = g.home; h.host = g.home; h.remH--; a.remA--;
    const k = pk(g.home, g.away);
    pairMet.set(k, (pairMet.get(k) ?? 0) + 1); pairLast.set(k, d);
    while (days.length <= d) days.push([]);
    days[d].push({ id: gid++, day: d, home: g.home, away: g.away, played: false, result: null, kind: 'regular', seriesId: null });
  };
  const runDay = (d: number, want: number, strict: boolean) => {
    const busy = new Set<string>();
    const progress = (d - first) / span;
    const scored: { i: number; sc: number }[] = [];
    for (let i = 0; i < pool.length; i++) {
      const g = pool[i], h = st.get(g.home)!, a = st.get(g.away)!;
      if (h.last >= d - 1 || a.last >= d - 1) { if (strict || h.last === d || a.last === d) continue; }
      if (strict && ((h.venue === 'H' && h.streak >= 5) || (a.venue === 'A' && a.streak >= 5))) continue;
      const k = pk(g.home, g.away);
      let sc = scoreSide(h, 'H', d) + scoreSide(a, 'A', d) + ((g.r * 7.3 + d * 0.618) % 1) * 1.2;
      if (h.last >= d - 1 || a.last >= d - 1) sc -= 6;
      // road trips stay in a region: next stop close to the previous host
      if (a.venue === 'A' && a.host) sc += conf.get(a.host) === conf.get(g.home) ? (div.get(a.host) && div.get(a.host) === div.get(g.home) ? 0.9 : 0.5) : -0.4;
      const met = pairMet.get(k) ?? 0, tot = pairTotal.get(k) ?? 1;
      if ((met + 0.5) / tot > progress + 0.25) sc -= 2.5; // spread a pair's meetings over the season
      else if ((met + 0.5) / tot < progress - 0.2) sc += 1.5 + (progress - 0.2 - (met + 0.5) / tot) * 6; // overdue meeting
      const lastMeet = pairLast.get(k);
      if (lastMeet !== undefined && d - lastMeet < 20) sc -= (20 - (d - lastMeet)) * 0.2;
      scored.push({ i, sc });
    }
    scored.sort((x, y) => y.sc - x.sc);
    const take: number[] = [];
    for (const { i } of scored) {
      if (take.length >= want) break;
      const g = pool[i];
      if (busy.has(g.home) || busy.has(g.away)) continue;
      busy.add(g.home); busy.add(g.away); take.push(i);
    }
    take.sort((x, y) => y - x);
    for (const i of take) { const [g] = pool.splice(i, 1); place(d, g); }
    return take.length;
  };
  const suffix = new Array<number>(playable.length + 1).fill(0);
  for (let i = playable.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + (quota.get(playable[i]) ?? 0);
  playable.forEach((d, idx) => {
    if (!pool.length) return;
    const left = playable.length - idx;
    // follow the planned slate; catch up only when behind it, so the season runs right up to its last day
    const behind = pool.length - suffix[idx];
    const want = Math.min(maxPerDay, (quota.get(d) ?? 0) + Math.max(0, Math.ceil(behind / Math.max(1, Math.min(left, 10)))), pool.length);
    const got = runDay(d, want, true);
    if (got < want) runDay(d, want - got, false);
  });
  // Anything left (very short or unusual leagues) goes onto extra days after the planned end.
  let d = D;
  while (pool.length) { if (!runDay(d, maxPerDay, false)) runDay(d, maxPerDay, false); d++; if (d > D + 400) break; }
  while (days.length < D) days.push([]);
  return { days, nextId: gid };
}

export function teamGames(state: { schedule: Game[][] }, teamId: string): Game[] {
  const out: Game[] = [];
  for (const day of state.schedule) for (const g of day) if (g.home === teamId || g.away === teamId) out.push(g);
  return out;
}

export function nextUserGame(state: { schedule: Game[][]; day: number }, teamId: string): Game | null {
  for (let d = state.day; d < state.schedule.length; d++) {
    const g = state.schedule[d].find((x) => !x.played && (x.home === teamId || x.away === teamId));
    if (g) return g;
  }
  return null;
}

export function regularSeasonLength(schedule: Game[][]): number {
  const firstPlayoffDay = schedule.findIndex((games) => games.some((g) => g.kind === 'playoff'));
  return firstPlayoffDay < 0 ? schedule.length : firstPlayoffDay;
}

/**
 * Exact calendar Date of a game day:
 * - Regular season days map 1-to-1 to consecutive calendar days starting Sep 1 (first games on the first
 *   September Saturday; pause days have no games).
 * - Playoff game days advance every 2 days (1 rest day between playoff games) in March–April.
 */
export function seasonDateObj(day: number, regularSeasonDays: number, season = '2025/26'): Date {
  const seasonYear = seasonStartYear(season);
  const count = Math.max(1, regularSeasonDays);
  const safeDay = Math.max(0, day);
  if (safeDay < count) {
    return new Date(seasonYear, 8, 1 + safeDay);
  }
  const playoffIdx = safeDay - count;
  return new Date(seasonYear, 8, 1 + count + 1 + playoffIdx * 2);
}

export function seasonWeekdayCap(day: number, regularSeasonDays: number, season = '2025/26'): string {
  return WEEKDAY_CAP_RU[seasonDateObj(day, regularSeasonDays, season).getDay()];
}

export function seasonWeekdayFull(day: number, regularSeasonDays: number, season = '2025/26'): string {
  return WEEKDAY_FULL_RU[seasonDateObj(day, regularSeasonDays, season).getDay()];
}

export function isWeekendDay(day: number, regularSeasonDays: number, season = '2025/26'): boolean {
  const wd = seasonDateObj(day, regularSeasonDays, season).getDay();
  return wd === 0 || wd === 6;
}

export function seasonDate(day: number, regularSeasonDays: number, season = '2025/26'): string {
  const d = seasonDateObj(day, regularSeasonDays, season);
  const datePart = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const wd = WEEKDAY_SHORT_RU[d.getDay()];
  return `${datePart}, ${wd}`;
}

export function seasonDateOnly(day: number, regularSeasonDays: number, season = '2025/26'): string {
  const d = seasonDateObj(day, regularSeasonDays, season);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

/* ---------------- league calendar file (mods/<id>/schedule.json) ---------------- */

/** One game of the calendar file: date `YYYY-MM-DD`, home club id, away club id. */
export interface ScheduleFileGame {
  date: string;
  home: string;
  away: string;
}
/**
 * `schedule.json`: one shared regular-season calendar for the whole league (every club's games).
 * Day 0 of the season is September 1 of the first year of `season`. Playoffs and later seasons are built by
 * the game.
 */
export interface ScheduleFile {
  season?: string;
  /** Length of the regular season in calendar days counted from September 1 (pause days included). */
  days?: number;
  games: ScheduleFileGame[];
}

const DAY_MS = 86400000;
const pad2 = (n: number) => (n < 10 ? '0' : '') + n;
/** `YYYY-MM-DD` of a regular-season day (day 0 = September 1). */
export function scheduleDayToDate(day: number, season = '2025/26'): string {
  const d = new Date(Date.UTC(seasonStartYear(season), 8, 1) + day * DAY_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
/** Regular-season day of a `YYYY-MM-DD` date (day 0 = September 1), or NaN for a malformed date. */
export function scheduleDateToDay(date: string, season = '2025/26'): number {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(date ?? '').trim());
  if (!m) return NaN;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return NaN;
  return Math.round((t - Date.UTC(seasonStartYear(season), 8, 1)) / DAY_MS);
}

/** A generated (or played) regular season written out as a calendar file. */
export function scheduleToFile(days: Game[][], season: string): ScheduleFile {
  const games: ScheduleFileGame[] = [];
  const reg = regularSeasonLength(days);
  for (let d = 0; d < reg; d++) for (const g of days[d] ?? []) if (g.kind === 'regular') games.push({ date: scheduleDayToDate(d, season), home: g.home, away: g.away });
  return { season, days: reg, games };
}

/** Compact, diff-friendly text of a calendar file: one game per line. */
export function scheduleFileText(f: ScheduleFile): string {
  const head = [f.season !== undefined ? `  "season": ${JSON.stringify(f.season)},` : '', f.days !== undefined ? `  "days": ${f.days},` : ''].filter(Boolean);
  const rows = f.games.map((g) => `    ${JSON.stringify({ date: g.date, home: g.home, away: g.away })}`);
  return `{\n${head.join('\n')}${head.length ? '\n' : ''}  "games": [\n${rows.join(',\n')}\n  ]\n}\n`;
}

export interface ParsedSchedule {
  days: Game[][];
  nextId: number;
  /** games per club when every club has the same number, otherwise null */
  gamesPerTeam: number | null;
  warnings: string[];
}

/**
 * Turns a calendar file into the season schedule. Throws (with a message for the player) when the file can't be
 * used: unknown clubs, a club playing twice on one day, a date before September 1, an empty list.
 */
export function parseScheduleFile(json: unknown, teamIds: string[], season: string, firstId = 1): ParsedSchedule {
  const root = json as Partial<ScheduleFile> | null;
  const list: unknown = Array.isArray(json) ? json : root?.games;
  if (!Array.isArray(list) || !list.length) throw new Error('в календаре нет матчей (ожидается массив games)');
  const warnings: string[] = [];
  const fileSeason = !Array.isArray(json) && typeof root?.season === 'string' ? root.season.trim() : '';
  if (fileSeason && seasonStartYear(fileSeason) !== seasonStartYear(season)) throw new Error(`календарь составлен на сезон ${fileSeason}, а ростер — на ${season}`);
  const known = new Set(teamIds);
  const byDay = new Map<number, { home: string; away: string }[]>();
  const count = new Map<string, number>(teamIds.map((id) => [id, 0]));
  list.forEach((g: any, i: number) => {
    const where = `матч №${i + 1}`;
    const home = String(g?.home ?? '').trim(), away = String(g?.away ?? '').trim();
    if (!known.has(home)) throw new Error(`${where}: неизвестный клуб «${home}»`);
    if (!known.has(away)) throw new Error(`${where}: неизвестный клуб «${away}»`);
    if (home === away) throw new Error(`${where}: клуб «${home}» не может играть сам с собой`);
    const day = scheduleDateToDay(g?.date, season);
    if (!Number.isFinite(day)) throw new Error(`${where}: дата «${g?.date}» не в формате ГГГГ-ММ-ДД`);
    if (day < 0) throw new Error(`${where}: дата ${g.date} раньше начала сезона (1 сентября)`);
    if (day > 400) throw new Error(`${where}: дата ${g.date} слишком далеко от начала сезона`);
    const slate = byDay.get(day) ?? [];
    for (const o of slate) for (const t of [home, away]) if (o.home === t || o.away === t) throw new Error(`${where}: клуб «${t}» уже играет ${g.date}`);
    slate.push({ home, away });
    byDay.set(day, slate);
    count.set(home, count.get(home)! + 1);
    count.set(away, count.get(away)! + 1);
  });
  const last = Math.max(...byDay.keys());
  const declared = Number(root && !Array.isArray(json) ? root.days : NaN);
  const D = Math.max(last + 1, Number.isFinite(declared) ? Math.min(400, Math.round(declared)) : 0);
  const days: Game[][] = [];
  let id = firstId;
  for (let d = 0; d < D; d++) days.push((byDay.get(d) ?? []).map((g) => ({ id: id++, day: d, home: g.home, away: g.away, played: false, result: null, kind: 'regular', seriesId: null })));
  const idle = teamIds.filter((t) => !count.get(t));
  if (idle.length) warnings.push(`Календарь: нет матчей у клубов ${idle.join(', ')}`);
  const counts = new Set(count.values());
  const gamesPerTeam = counts.size === 1 ? [...counts][0] : null;
  if (gamesPerTeam === null) warnings.push(`Календарь: у клубов разное число матчей (от ${Math.min(...counts)} до ${Math.max(...counts)})`);
  return { days, nextId: id, gamesPerTeam, warnings };
}
