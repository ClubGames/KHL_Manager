import type { Board, BoardGoal, GameState, Team } from '../types';

export const GOAL_TEXT: Record<BoardGoal, string> = {
  semis: 'Дойти до финала конференции',
  round2: 'Пройти первый раунд плей-офф',
  playoffs: 'Выйти в плей-офф',
  top10: 'Занять место не ниже 10-го в конференции',
};
const GOAL_LEVEL: Record<BoardGoal, number> = { top10: 1, playoffs: 2, round2: 3, semis: 4 };

function strength(state: GameState, t: Team): number {
  const ps = t.players.map((id) => state.players[id]).filter(Boolean);
  const sk = ps.filter((p) => p.position !== 'G').map((p) => p.overall).sort((a, b) => b - a).slice(0, 18);
  const g = Math.max(50, ...ps.filter((p) => p.position === 'G').map((p) => p.overall));
  return sk.length ? (sk.reduce((a, b) => a + b, 0) / sk.length) * 0.85 + g * 0.15 : 0;
}

/** The owners set the season objective from how strong the roster looks compared with the league. */
export function setBoardGoal(state: GameState) {
  const mine = strength(state, state.teams[state.userTeamId]);
  const rank = 1 + state.teamOrder.filter((id) => id !== state.userTeamId && strength(state, state.teams[id]) > mine).length;
  const frac = rank / Math.max(1, state.teamOrder.length);
  const goal: BoardGoal = frac <= 0.16 ? 'semis' : frac <= 0.36 ? 'round2' : frac <= 0.68 ? 'playoffs' : 'top10';
  const prev: Board | undefined = state.board;
  state.board = { goal, text: GOAL_TEXT[goal], rank, confidence: prev?.confidence ?? 60, last: prev?.last };
}

export function confPlaceByPoints(state: GameState): number {
  const U = state.teams[state.userTeamId];
  return 1 + state.teamOrder.filter((id) => id !== U.id && state.teams[id].conference === U.conference && state.teams[id].record.points > U.record.points).length;
}

/** Is the club on course for the objective right now? null = too early to tell. */
export function boardOnTrack(state: GameState): boolean | null {
  const U = state.teams[state.userTeamId];
  if (state.phase === 'season') {
    if (U.record.gp < 8) return null;
    return confPlaceByPoints(state) <= (state.board.goal === 'top10' ? 10 : 8);
  }
  if (state.phase === 'playoffs' && state.playoffs) {
    const mine = state.playoffs.series.filter((s) => s.high === U.id || s.low === U.id);
    const won = mine.filter((s) => s.winner === U.id).length;
    const alive = mine.some((s) => !s.done);
    const level = !mine.length ? ((U.seed ?? 99) <= 10 ? 1 : 0) : 2 + won;
    return level >= GOAL_LEVEL[state.board.goal] || alive;
  }
  return null;
}

export interface BoardResult {
  verdict: 'exceeded' | 'met' | 'failed';
  text: string;
  bonus: number;
}

export function evaluateBoard(state: GameState, r: { place: number; madePlayoffs: boolean; roundsWon: number }): BoardResult {
  const b = state.board;
  const level = r.madePlayoffs ? 2 + r.roundsWon : r.place <= 10 ? 1 : 0;
  const need = GOAL_LEVEL[b.goal];
  const verdict: BoardResult['verdict'] = level > need ? 'exceeded' : level === need ? 'met' : 'failed';
  b.confidence = Math.max(0, Math.min(100, b.confidence + (verdict === 'exceeded' ? 15 : verdict === 'met' ? 8 : -20)));
  let bonus = verdict === 'exceeded' ? 120_000_000 : verdict === 'met' ? 60_000_000 : 0;
  let text = verdict === 'exceeded' ? `Руководство в восторге: задача «${b.text}» перевыполнена.` : verdict === 'met' ? `Руководство довольно: задача «${b.text}» выполнена.` : `Руководство недовольно: задача «${b.text}» не выполнена.`;
  if (b.confidence < 25) {
    bonus = -100_000_000;
    text += ' Доверие к менеджеру на минимуме — бюджет урезан.';
  }
  b.last = { season: state.league.season, verdict, text, bonus };
  return { verdict, text, bonus };
}
