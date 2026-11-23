import type { GameState, Lineup } from '../types';
import type { SimTeam } from './engine';
import { coachingEffects } from './coaching';
import { getTeamTactics, teamLeadershipBonus } from './chemistry';

/** Everything the match engine needs to know about a club for one game. */
export function buildSimTeam(state: GameState, tid: string, lineup: Lineup): SimTeam {
  const T = state.teams[tid];
  return {
    id: tid,
    lineup,
    name: T.name,
    tactics: getTeamTactics(T),
    chemGP: T.chemGP,
    leadershipBonus: teamLeadershipBonus(T, state.players),
    coaching: coachingEffects(T, state.players),
    roadStreak: T.roadStreak ?? 0,
  };
}
