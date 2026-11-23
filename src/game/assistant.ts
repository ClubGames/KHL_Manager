import type { AttackStyle, ForecheckStyle, Lineup, Player, TeamTactics } from '../types';
import type { LiveStats } from './live';
import { goalieFreshness } from './chemistry';

/**
 * The assistant coach's notes in the intermission: short, concrete advice built from what has been
 * seen so far (faceoffs, shots, xG, special teams, goalie, fatigue), each with a one-tap action.
 */
export type HintAction =
  | { kind: 'swap'; a: string; b: string }
  | { kind: 'forecheck'; value: ForecheckStyle }
  | { kind: 'style'; value: AttackStyle }
  | { kind: 'goalie' }
  | { kind: 'shortBench'; value: boolean }
  | { kind: 'pp'; a: string; b: string };

export interface CoachHint {
  id: string;
  tone: 'good' | 'warn' | 'bad';
  text: string;
  action?: HintAction;
  actionLabel?: string;
}

export interface HintInput {
  live: LiveStats;
  userIdx: 0 | 1;
  /** faceoffs won [home, away] so far */
  faceoffs: [number, number];
  lineup: Lineup;
  P: Record<string, Player>;
  tactics: TeamTactics;
  /** period that has just ended (1..3) */
  period: number;
  goalieId: string | null;
  shortBench: boolean;
}

const lastName = (p?: Player | null) => (p ? p.name.split(' ').slice(-1)[0] : '—');
/** Faceoff ability is the same "hands" the rink AI uses for the draw. */
export const faceoffSkill = (p: Player) => p.skills.puckControl ?? p.skills.puckHandling ?? p.skills.passing ?? 60;

export function intermissionHints(h: HintInput): CoachHint[] {
  const { live, userIdx: u, P, lineup: L } = h;
  const o = (1 - u) as 0 | 1;
  const out: CoachHint[] = [];
  const diff = live.score[u] - live.score[o];

  // Faceoffs
  const fo = h.faceoffs[u] + h.faceoffs[o];
  if (fo >= 8) {
    const pct = Math.round((h.faceoffs[o] / fo) * 100);
    if (pct >= 60) {
      const c2 = L.F[1]?.[0] ? P[L.F[1][0]!] : null;
      const top2 = new Set([L.F[0]?.[0], L.F[1]?.[0]].filter(Boolean) as string[]);
      const cand = [...L.F.flat(), L.u20F ?? null]
        .filter((id): id is string => !!id && !!P[id] && !top2.has(id))
        .map((id) => P[id])
        .sort((a, b) => faceoffSkill(b) - faceoffSkill(a))[0];
      if (c2 && cand && faceoffSkill(cand) > faceoffSkill(c2) + 2) {
        out.push({ id: 'fo', tone: 'bad', text: `Соперник выигрывает ${pct}% вбрасываний. Поставьте ${lastName(cand)} (руки ${faceoffSkill(cand)}) центром во 2-е звено вместо ${lastName(c2)} (${faceoffSkill(c2)}).`, action: { kind: 'swap', a: cand.id, b: c2.id }, actionLabel: `${lastName(cand)} → центр 2-го звена` });
      } else {
        out.push({ id: 'fo', tone: 'warn', text: `Соперник выигрывает ${pct}% вбрасываний. Лучше играть от обороны после проигранных вбрасываний в своей зоне.` });
      }
    } else if (pct <= 38) out.push({ id: 'fo', tone: 'good', text: `Мы выигрываем ${100 - pct}% вбрасываний — больше владения, продолжайте в том же духе.` });
  }

  // Shots and quality
  const sh = live.shots[u], so = live.shots[o];
  const xg = live.xg[u], xo = live.xg[o];
  if (so >= sh + 7) {
    if (h.tactics.forecheck !== 'aggressive' && diff <= 0)
      out.push({ id: 'shots', tone: 'bad', text: `Соперник перебросал нас ${so}:${sh}. Нужен агрессивный форчек — давите на защитников в их зоне.`, action: { kind: 'forecheck', value: 'aggressive' }, actionLabel: 'Агрессивный форчек' });
    else if (diff > 0 && h.tactics.forecheck !== 'trap')
      out.push({ id: 'shots', tone: 'warn', text: `Ведём, но броски ${sh}:${so}. Закройте среднюю зону (ловушка), чтобы удержать счёт.`, action: { kind: 'forecheck', value: 'trap' }, actionLabel: 'Ловушка в средней зоне' });
  }
  if (xg + 0.6 < xo && h.tactics.style === 'shoot') {
    out.push({ id: 'xg', tone: 'warn', text: `Бросаем много, но издалека: xG ${xg.toFixed(2)}:${xo.toFixed(2)}. Играйте через позиционную атаку и пятачок.`, action: { kind: 'style', value: 'cycle' }, actionLabel: 'Позиционная атака' });
  } else if (xg > xo + 0.8 && diff <= 0) {
    out.push({ id: 'xg', tone: 'good', text: `По качеству моментов мы лучше (xG ${xg.toFixed(2)}:${xo.toFixed(2)}). Голы придут — не ломайте игру.` });
  } else if (sh <= 5 && h.period >= 1 && h.tactics.style !== 'shoot') {
    out.push({ id: 'xg', tone: 'warn', text: `Всего ${sh} бросков. Больше бросайте с ходу — подставления и добивания решают.`, action: { kind: 'style', value: 'shoot' }, actionLabel: 'Больше бросков' });
  }

  // Special teams
  if (live.ppChances[u] >= 2 && live.ppGoals[u] === 0) {
    const pp1 = L.pp1.filter(Boolean) as string[];
    const pp2 = L.pp2.filter(Boolean) as string[];
    const worst = pp1.map((id) => P[id]).filter(Boolean).sort((a, b) => (a.skills.shooting ?? 60) + (a.skills.passing ?? 60) - ((b.skills.shooting ?? 60) + (b.skills.passing ?? 60)))[0];
    const best = pp2.map((id) => P[id]).filter(Boolean).sort((a, b) => (b.skills.shooting ?? 60) + (b.skills.passing ?? 60) - ((a.skills.shooting ?? 60) + (a.skills.passing ?? 60)))[0];
    if (worst && best && (best.skills.shooting ?? 60) + (best.skills.passing ?? 60) > (worst.skills.shooting ?? 60) + (worst.skills.passing ?? 60)) {
      out.push({ id: 'pp', tone: 'warn', text: `Большинство 0 из ${live.ppChances[u]}. Переведите ${lastName(best)} в первую бригаду вместо ${lastName(worst)}.`, action: { kind: 'pp', a: best.id, b: worst.id }, actionLabel: `${lastName(best)} в 1-е большинство` });
    } else out.push({ id: 'pp', tone: 'warn', text: `Большинство 0 из ${live.ppChances[u]}: больше движения без шайбы и бросков от синей с подставлением.` });
  }
  if (live.pim[u] >= 8 && live.pim[u] >= live.pim[o] + 4) {
    out.push({ id: 'pim', tone: 'warn', text: `${live.pim[u]} минут штрафа. Меньше силовых в чужой зоне — агрессивный форчек провоцирует удаления.`, action: h.tactics.forecheck === 'aggressive' ? { kind: 'forecheck', value: 'balanced' } : undefined, actionLabel: h.tactics.forecheck === 'aggressive' ? 'Сбалансированный форчек' : undefined });
  }

  // Goalie
  if (h.goalieId) {
    const g = live.goalies[h.goalieId];
    if (g && g.shotsAgainst >= 8) {
      const sv = g.saves / g.shotsAgainst;
      const backup = L.backupG ? P[L.backupG] : null;
      if (sv < 0.84 && backup && g.goalsAgainst >= 3) {
        out.push({ id: 'g', tone: 'bad', text: `${lastName(P[h.goalieId])}: ${(sv * 100).toFixed(1)}% отражённых. ${lastName(backup)} готов (свежесть ${goalieFreshness(backup)}%) — замена может встряхнуть команду.`, action: { kind: 'goalie' }, actionLabel: `Выпустить ${lastName(backup)}` });
      } else if (sv >= 0.95 && g.shotsAgainst >= 12) out.push({ id: 'g', tone: 'good', text: `${lastName(P[h.goalieId])} в ударе: ${g.saves} из ${g.shotsAgainst}.` });
    }
  }

  // Late game: bench length
  if (h.period === 2 && diff >= 1 && !h.shortBench) {
    out.push({ id: 'bench', tone: 'warn', text: 'Ведём перед третьим периодом. Можно сократить скамейку до трёх звеньев — лидеры получат больше времени, но быстрее устанут.', action: { kind: 'shortBench', value: true }, actionLabel: 'Играть в 3 звена' });
  } else if (h.period === 2 && diff <= -2 && h.tactics.forecheck !== 'aggressive') {
    out.push({ id: 'bench', tone: 'bad', text: `Проигрываем ${live.score[u]}:${live.score[o]}. В третьем периоде нужен прессинг и раннее снятие вратаря.`, action: { kind: 'forecheck', value: 'aggressive' }, actionLabel: 'Прессинг' });
  }

  if (!out.length) out.push({ id: 'ok', tone: 'good', text: 'Игра идёт по плану — существенных замечаний нет.' });
  return out.slice(0, 4);
}

/** Swap two players anywhere in the line-up (lines, pairs, special teams). */
export function swapInLineup(L: Lineup, a: string, b: string): Lineup {
  const sw = (id: string | null) => (id === a ? b : id === b ? a : id);
  return {
    ...L,
    F: L.F.map((l) => l.map(sw)),
    D: L.D.map((l) => l.map(sw)),
    pp1: L.pp1.map(sw),
    pp2: L.pp2.map(sw),
    pk1: L.pk1.map(sw),
    pk2: L.pk2.map(sw),
    u20F: L.u20F != null ? sw(L.u20F) : L.u20F,
    u20D: L.u20D != null ? sw(L.u20D) : L.u20D,
  };
}

/** Move `a` into the first power-play unit in place of `b` (b drops to the second unit). */
export function promoteToPP1(L: Lineup, a: string, b: string): Lineup {
  const pp1 = L.pp1.map((id) => (id === b ? a : id));
  const pp2 = L.pp2.map((id) => (id === a ? b : id));
  return { ...L, pp1, pp2 };
}
