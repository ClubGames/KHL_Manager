import type { Player, Team } from '../types';
import { effectivePayroll } from './cap';
import { isLegionnaire } from './legionnaires';
import { isDefense, isForward, isGoalie, isSkater } from './ratings';

/** Club strength as shown on the club selection screen: best 12 skaters + best goalie. */
export function clubStrength(P: Record<string, Player>, team: Pick<Team, 'players'>): number {
  const ps = team.players.map((id) => P[id]).filter((p) => p && !p.inVhl);
  const sk = ps.filter(isSkater).sort((a, b) => b.overall - a.overall).slice(0, 12);
  const g = ps.filter(isGoalie).sort((a, b) => b.overall - a.overall)[0];
  const all = g ? [...sk, g] : sk;
  return all.length ? Math.round(all.reduce((s, p) => s + p.overall, 0) / all.length) : 0;
}

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

export interface ClubProfile {
  strength: number;
  /** 1 = strongest club in the league */
  rank: number;
  attack: number;
  defense: number;
  goalie: number;
  avgAge: number;
  legionnaires: number;
  u23: number;
  khl: number;
  vhl: number;
  payroll: number;
  /** best players of the main roster, strongest first */
  stars: Player[];
}

export function clubProfile(P: Record<string, Player>, team: Team, all: Team[]): ClubProfile {
  const ps = team.players.map((id) => P[id]).filter(Boolean);
  const main = ps.filter((p) => !p.inVhl);
  const by = (f: (p: Player) => boolean, n: number) =>
    main
      .filter(f)
      .map((p) => p.overall)
      .sort((a, b) => b - a)
      .slice(0, n);
  const strength = clubStrength(P, team);
  return {
    strength,
    rank: 1 + all.filter((t) => t.id !== team.id && clubStrength(P, t) > strength).length,
    attack: avg(by(isForward, 9)),
    defense: avg(by(isDefense, 6)),
    goalie: by(isGoalie, 1)[0] ?? 0,
    avgAge: main.length ? Math.round((main.reduce((a, p) => a + p.age, 0) / main.length) * 10) / 10 : 0,
    legionnaires: main.filter(isLegionnaire).length,
    u23: main.filter((p) => p.age <= 23).length,
    khl: main.length,
    vhl: ps.length - main.length,
    payroll: effectivePayroll(team, P, 'season'),
    stars: [...main].sort((a, b) => b.overall - a.overall).slice(0, 5),
  };
}

/** Season leaders of a club: points among skaters, best save percentage among goalies (min. 3 games). */
export function clubLeaders(P: Record<string, Player>, team: Pick<Team, 'players'>) {
  const ps = team.players.map((id) => P[id]).filter(Boolean);
  const scorers = ps
    .filter((p) => isSkater(p) && p.stats.gp > 0)
    .sort((a, b) => b.stats.goals + b.stats.assists - (a.stats.goals + a.stats.assists) || b.stats.goals - a.stats.goals)
    .slice(0, 5);
  const goalies = ps
    .filter((p) => isGoalie(p) && p.stats.gp > 0 && p.stats.shotsAgainst > 0)
    .sort((a, b) => b.stats.gp - a.stats.gp)
    .slice(0, 2);
  return { scorers, goalies };
}
