import type { Game } from '../types';

const BYE = '__bye__';

/**
 * Balanced round-robin calendar. Pairings are generated in complete rounds,
 * then spread over every available date in the regular season. This gives each
 * club at most one game per date, keeps the daily league slate non-empty, and
 * limits rest gaps to six days for the standard KHL season setup.
 */
export function buildSchedule(teamIds: string[], gamesPerTeam: number, firstId = 1): { days: Game[][]; nextId: number } {
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

  const totalGames = roundGames.reduce((sum, round) => sum + round.length, 0);
  // KHL regular season runs Sep 1–Feb 26 (179 dates inclusive). Smaller test
  // leagues use fewer dates when they do not have enough games to fill them.
  const targetDays = Math.min(179, totalGames, roundGames.length * 3);
  const baseDaysPerRound = Math.floor(targetDays / Math.max(1, roundGames.length));
  const extraDays = targetDays % Math.max(1, roundGames.length);
  const days: Game[][] = [];
  let dayAccumulator = 0;

  for (const games of roundGames) {
    dayAccumulator += extraDays;
    let daysInRound = baseDaysPerRound;
    if (dayAccumulator >= roundGames.length) {
      daysInRound++;
      dayAccumulator -= roundGames.length;
    }
    daysInRound = Math.max(1, Math.min(daysInRound, games.length));
    let offset = 0;
    for (let part = 0; part < daysInRound; part++) {
      const remainingDays = daysInRound - part;
      const take = Math.ceil((games.length - offset) / remainingDays);
      const day = days.length;
      days.push(games.slice(offset, offset + take).map((g) => ({ ...g, day })));
      offset += take;
    }
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

export function seasonDate(day: number, regularSeasonDays: number, season = '2025/26'): string {
  // Map regular-season matchdays uniquely across Sep 1 – Feb 26. Playoff days
  // continue chronologically instead of stretching the already-fixed regular season.
  const seasonYear = Number(season.match(/^\d{4}/)?.[0]) || 2025;
  const start = new Date(seasonYear, 8, 1);
  const end = new Date(seasonYear + 1, 1, 26);
  const span = Math.round((end.getTime() - start.getTime()) / 86400000);
  const count = Math.max(1, regularSeasonDays);
  const safeDay = Math.max(0, day);
  const offset = safeDay < count
    ? (count === 1 ? 0 : Math.round((safeDay / (count - 1)) * span))
    : span + (safeDay - (count - 1));
  const d = new Date(start.getTime() + offset * 86400000);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}
