import type { Game } from '../types';

const BYE = '__bye__';

export const WEEKDAY_CAP_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'] as const;
export const WEEKDAY_SHORT_RU = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'] as const;
export const WEEKDAY_FULL_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'] as const;
export const MONDAY_FIRST_HEADERS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const;
export const MONTH_NAMES_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'] as const;

export function seasonStartYear(season = '2025/26'): number {
  return Number(season.match(/^\d{4}/)?.[0]) || 2025;
}

/**
 * Balanced round-robin calendar mapped onto real consecutive calendar days starting September 1.
 * Prime KHL matchdays (Tue, Thu, Sat, Sun) carry larger slates while Mon, Wed, Fri have lighter slates,
 * no team plays twice on the same date, and back-to-backs are minimized.
 */
export function buildSchedule(teamIds: string[], gamesPerTeam: number, firstId = 1, season = '2025/26'): { days: Game[][]; nextId: number } {
  const n = teamIds.length;
  if (n < 2) return { days: [], nextId: firstId };
  const ids = [...teamIds];
  if (n % 2) ids.push(BYE);
  const m = ids.length;
  const half = m / 2;
  const rot = ids.slice(1);
  const rounds: [string, string][][] = [];
  for (let r = 0; r < m - 1; r++) {
    const pairs: [string, string][] = [];
    const a0 = ids[0];
    const a1 = rot[rot.length - 1];
    pairs.push(r % 2 === 0 ? [a0, a1] : [a1, a0]);
    for (let i = 0; i < half - 1; i++) {
      const a = rot[i];
      const b = rot[rot.length - 2 - i];
      pairs.push((r + i) % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    rot.unshift(rot.pop()!);
  }

  const played: Record<string, number> = Object.fromEntries(teamIds.map((id) => [id, 0]));
  const home: Record<string, number> = Object.fromEntries(teamIds.map((id) => [id, 0]));
  const roundGames: Game[][] = [];
  let gid = firstId;
  let cycle = 0;
  while (!teamIds.every((id) => played[id] >= gamesPerTeam) && cycle < gamesPerTeam + 2) {
    let added = 0;
    for (const pairs of rounds) {
      const games: Game[] = [];
      for (const [h0, a0] of pairs) {
        if (h0 === BYE || a0 === BYE) continue;
        const flip = cycle % 2 === 1;
        const [h, a] = cycle < 2
          ? (flip ? [a0, h0] : [h0, a0])
          : home[h0] > home[a0]
            ? [a0, h0]
            : home[h0] < home[a0]
              ? [h0, a0]
              : flip ? [a0, h0] : [h0, a0];
        if (played[h] >= gamesPerTeam || played[a] >= gamesPerTeam) continue;
        home[h]++;
        games.push({ id: gid++, day: 0, home: h, away: a, played: false, result: null, kind: 'regular', seriesId: null });
        played[h]++;
        played[a]++;
        added++;
      }
      if (games.length) roundGames.push(games);
      if (teamIds.every((id) => played[id] >= gamesPerTeam)) break;
    }
    if (!added) break;
    cycle++;
  }

  const pool: Game[] = roundGames.flat();
  const totalGames = pool.length;
  if (!totalGames) return { days: [], nextId: gid };

  // Full KHL season spans Sep 1 – late Feb (~176 consecutive calendar days).
  const targetDays = totalGames >= 180 ? 176 : Math.min(176, totalGames, roundGames.length * 3);
  const startYear = seasonStartYear(season);
  const maxPerDay = Math.max(1, Math.floor(n / 2));

  // Weekday weights: Tue(2), Thu(4), Sat(6), Sun(0) are prime KHL hockey nights.
  const weights: number[] = [];
  for (let d = 0; d < targetDays; d++) {
    const wd = new Date(startYear, 8, 1 + d).getDay();
    weights.push(wd === 0 || wd === 2 || wd === 4 || wd === 6 ? 1.55 : 0.55);
  }
  const quotas = new Array<number>(targetDays).fill(1);
  let remaining = totalGames - targetDays;
  const wSum = weights.reduce((a, b) => a + b, 0);
  if (remaining > 0) {
    const frac: { d: number; f: number }[] = [];
    let assigned = 0;
    for (let d = 0; d < targetDays; d++) {
      const exact = (remaining * weights[d]) / wSum;
      const add = Math.min(maxPerDay - 1, Math.floor(exact));
      quotas[d] += add;
      assigned += add;
      frac.push({ d, f: exact - add });
    }
    frac.sort((a, b) => b.f - a.f);
    let idx = 0;
    while (assigned < remaining && idx < frac.length * 3) {
      const d = frac[idx % frac.length].d;
      if (quotas[d] < maxPerDay) {
        quotas[d]++;
        assigned++;
      }
      idx++;
    }
  }

  const days: Game[][] = [];
  let prevTeams = new Set<string>();
  const windowScan = Math.max(40, n * 3);

  for (let d = 0; d < targetDays && pool.length > 0; d++) {
    const want = Math.min(quotas[d], pool.length);
    const busy = new Set<string>();
    const chosen: Game[] = [];

    // Pass 1: avoid back-to-backs (teams that played yesterday)
    for (let i = 0; i < pool.length && i < windowScan && chosen.length < want; i++) {
      const g = pool[i];
      if (busy.has(g.home) || busy.has(g.away)) continue;
      if (prevTeams.has(g.home) || prevTeams.has(g.away)) continue;
      busy.add(g.home);
      busy.add(g.away);
      chosen.push(g);
      pool.splice(i, 1);
      i--;
    }

    // Pass 2: if still short of quota (or 0 games), allow any non-conflicting game
    for (let i = 0; i < pool.length && chosen.length < want; i++) {
      const g = pool[i];
      if (busy.has(g.home) || busy.has(g.away)) continue;
      busy.add(g.home);
      busy.add(g.away);
      chosen.push(g);
      pool.splice(i, 1);
      i--;
    }

    if (chosen.length > 0) {
      const dayIdx = days.length;
      days.push(chosen.map((g) => ({ ...g, day: dayIdx })));
      prevTeams = busy;
    } else {
      prevTeams = new Set();
    }
  }

  // Drain any remaining pairings onto subsequent calendar days without same-day conflicts
  while (pool.length > 0) {
    const busy = new Set<string>();
    const chosen: Game[] = [];
    const wd = new Date(startYear, 8, 1 + days.length).getDay();
    const cap = wd === 0 || wd === 2 || wd === 4 || wd === 6 ? Math.min(maxPerDay, 7) : Math.min(maxPerDay, 3);
    for (let i = 0; i < pool.length && chosen.length < cap; i++) {
      const g = pool[i];
      if (busy.has(g.home) || busy.has(g.away)) continue;
      busy.add(g.home);
      busy.add(g.away);
      chosen.push(g);
      pool.splice(i, 1);
      i--;
    }
    const dayIdx = days.length;
    days.push(chosen.map((g) => ({ ...g, day: dayIdx })));
  }

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
 * - Regular season days map 1-to-1 to consecutive calendar days starting Sep 1.
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
