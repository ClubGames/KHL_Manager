import type { GameState, Lineup, Player, YouthTrainingPlan } from '../types';
import { clamp, computeOverall, GOALIE_KEYS, isDefense, isGoalie, SKATER_KEYS, SKILL_LABELS } from './ratings';

export const YOUTH_MAX_AGE = 23;

export interface TrainingPlanDef {
  id: YouthTrainingPlan;
  label: string;
  short: string;
  forGoalie: boolean | 'both';
  focus: string[];
  description: string;
  speedMult: number;
  injuryBonus: number;
  weights: Record<string, number>;
}

export const TRAINING_PLANS: Record<YouthTrainingPlan, TrainingPlanDef> = {
  balanced: {
    id: 'balanced',
    label: 'Сбалансированный',
    short: 'База',
    forGoalie: 'both',
    focus: [],
    description: 'Равномерное развитие всех профильных навыков без повышенного риска перегрузок.',
    speedMult: 1.0,
    injuryBonus: 0,
    weights: { skating: 1, shooting: 1, passing: 1, puckControl: 1, checking: 1, defense: 1, reflexes: 1, positioning: 1, reboundControl: 1, puckHandling: 1, endurance: 1 },
  },
  sniper: {
    id: 'sniper',
    label: 'Снайпер (Бросок)',
    short: 'Снайпер',
    forGoalie: false,
    focus: ['shooting', 'puckControl'],
    description: 'Акцент на бросок сходу, кистевой и технику рук в завершении атак.',
    speedMult: 1.12,
    injuryBonus: 0,
    weights: { skating: 1.0, shooting: 2.6, passing: 0.9, puckControl: 1.8, checking: 0.5, defense: 0.5 },
  },
  playmaker: {
    id: 'playmaker',
    label: 'Диспетчер (Пас и катание)',
    short: 'Диспетчер',
    forGoalie: false,
    focus: ['passing', 'skating', 'puckControl'],
    description: 'Развитие первого паса, видения площадки, манёвренности и контроля шайбы.',
    speedMult: 1.12,
    injuryBonus: 0,
    weights: { skating: 2.0, shooting: 0.8, passing: 2.5, puckControl: 1.7, checking: 0.5, defense: 0.7 },
  },
  twoway: {
    id: 'twoway',
    label: 'Двусторонний (Оборона)',
    short: 'Оборона',
    forGoalie: false,
    focus: ['defense', 'checking', 'skating'],
    description: 'Позиционная оборона, силовая борьба у бортов и игра в меньшинстве.',
    speedMult: 1.12,
    injuryBonus: 0.001,
    weights: { skating: 1.4, shooting: 0.6, passing: 1.0, puckControl: 0.8, checking: 2.1, defense: 2.5 },
  },
  intensive: {
    id: 'intensive',
    label: 'Интенсив (Прорыв)',
    short: 'Интенсив',
    forGoalie: 'both',
    focus: ['skating', 'shooting', 'passing', 'reflexes', 'positioning'],
    description: '+40% к скорости прогресса и шанс поднять потолок потенциала, но выше риск микротравм и нужна игровая практика.',
    speedMult: 1.4,
    injuryBonus: 0.004,
    weights: { skating: 1.5, shooting: 1.5, passing: 1.5, puckControl: 1.4, checking: 1.1, defense: 1.2, reflexes: 1.6, positioning: 1.6, reboundControl: 1.4, puckHandling: 1.0, endurance: 1.4 },
  },
  goalie_reflex: {
    id: 'goalie_reflex',
    label: 'Реакция и отскоки',
    short: 'Рефлексы',
    forGoalie: true,
    focus: ['reflexes', 'reboundControl'],
    description: 'Вратарская школа игры на линии ворот, спасений в шпагате и гашения отскоков.',
    speedMult: 1.14,
    injuryBonus: 0,
    weights: { reflexes: 2.6, positioning: 1.1, reboundControl: 2.1, puckHandling: 0.6, endurance: 0.9 },
  },
  goalie_pos: {
    id: 'goalie_pos',
    label: 'Позиция и выносливость',
    short: 'Позиция',
    forGoalie: true,
    focus: ['positioning', 'endurance', 'puckHandling'],
    description: 'Чтение бросков, выбор угла обстрела, функциональная готовность и игра клюшкой.',
    speedMult: 1.14,
    injuryBonus: 0,
    weights: { reflexes: 1.0, positioning: 2.5, reboundControl: 1.1, puckHandling: 1.6, endurance: 2.0 },
  },
};

export function isYouthPlayer(p: Pick<Player, 'age'> | null | undefined): boolean {
  return !!p && p.age <= YOUTH_MAX_AGE;
}

export function plansForPlayer(p: Player): TrainingPlanDef[] {
  const g = isGoalie(p);
  return Object.values(TRAINING_PLANS).filter((pl) => pl.forGoalie === 'both' || pl.forGoalie === g);
}

export function getPlayerPlan(p: Player): TrainingPlanDef {
  const id = p.trainingPlan ?? 'balanced';
  const def = TRAINING_PLANS[id];
  if (!def) return TRAINING_PLANS.balanced;
  if (def.forGoalie !== 'both' && def.forGoalie !== isGoalie(p)) return TRAINING_PLANS.balanced;
  return def;
}

export function recommendYouthPlan(p: Player): YouthTrainingPlan {
  if (p.potential - p.overall >= 8 && p.age <= 20) return 'intensive';
  if (isGoalie(p)) {
    return (p.skills.reflexes ?? 65) <= (p.skills.positioning ?? 65) ? 'goalie_reflex' : 'goalie_pos';
  }
  if (isDefense(p)) return 'twoway';
  if (p.position === 'C') return 'playmaker';
  return (p.skills.shooting ?? 65) >= (p.skills.passing ?? 65) ? 'sniper' : 'playmaker';
}

export type IceRole = 'top' | 'depth' | 'bench';

export function playerIceRole(L: Lineup, id: string): IceRole {
  if (L.starterG === id) return 'top';
  if ((L.F[0] ?? []).includes(id) || (L.F[1] ?? []).includes(id) || (L.D[0] ?? []).includes(id) || (L.D[1] ?? []).includes(id) || L.pp1.includes(id)) {
    return 'top';
  }
  if ((L.F[2] ?? []).includes(id) || (L.F[3] ?? []).includes(id) || (L.D[2] ?? []).includes(id) || L.backupG === id) {
    return 'depth';
  }
  return 'bench';
}

function pickWeightedSkill(p: Player, weights: Record<string, number>): string {
  const keys = isGoalie(p) ? GOALIE_KEYS : SKATER_KEYS;
  const items = keys.map((k) => {
    const cur = p.skills[k] ?? 65;
    const room = Math.max(0.15, (95 - cur) / 30);
    return { k, w: (weights[k] ?? 1) * room };
  });
  const total = items.reduce((a, x) => a + x.w, 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= it.w;
    if (r <= 0) return it.k;
  }
  return items[0].k;
}

/**
 * Weekly youth development step during the regular season and playoffs.
 * Young players (<= 23) earn training XP according to their plan, potential gap and game practice.
 */
export function stepYouthTrainingWeek(
  state: GameState,
  onUserBreakthrough?: (p: Player, fromOvr: number, toOvr: number, skillLabel: string, planLabel: string) => void
) {
  const P = state.players;
  for (const tid of state.teamOrder) {
    const team = state.teams[tid];
    for (const pid of team.players) {
      const p = P[pid];
      if (!p || !isYouthPlayer(p) || p.injury) continue;
      const plan = getPlayerPlan(p);
      const role = playerIceRole(team.lineup, pid);
      const gap = Math.max(1, p.potential - p.overall);
      const roleMult = role === 'top' ? 1.45 : role === 'depth' ? 1.15 : 0.65;
      const ageMult = p.age <= 20 ? 1.25 : p.age <= 22 ? 1.08 : 0.92;
      const moraleMult = p.morale >= 75 ? 1.1 : p.morale < 50 ? 0.82 : 1.0;

      if (plan.id === 'intensive' && role === 'bench') {
        p.morale = clamp(p.morale - 2, 30, 99);
      }

      const gain = (4.2 + gap * 1.45) * roleMult * ageMult * moraleMult * plan.speedMult;
      p.trainingXp = (p.trainingXp ?? 0) + gain;

      if (p.trainingXp >= 100) {
        p.trainingXp -= 100;
        const fromOvr = p.overall;
        const sk = p.skills as Record<string, number | undefined>;
        const k1 = pickWeightedSkill(p, plan.weights);
        const capSkill = Math.min(99, Math.max(p.potential + 3, (sk[k1] ?? 65) + 1));
        sk[k1] = clamp((sk[k1] ?? 65) + 1, 30, capSkill);
        p.seasonGrowth ??= {};
        p.seasonGrowth[k1] = (p.seasonGrowth[k1] ?? 0) + 1;

        // Second focused skill point on strong development or intensive plan
        if (gap >= 4 || plan.id === 'intensive') {
          const k2 = pickWeightedSkill(p, plan.weights);
          sk[k2] = clamp((sk[k2] ?? 65) + 1, 30, Math.min(99, p.potential + 4));
          p.seasonGrowth[k2] = (p.seasonGrowth[k2] ?? 0) + 1;
        }
        if (plan.id === 'intensive' && role !== 'bench' && p.potential < 94 && Math.random() < 0.22) {
          p.potential += 1;
        }
        p.overall = computeOverall(p);
        if (p.age <= 24) p.potential = Math.max(p.potential, p.overall);
        if (tid === state.userTeamId && p.overall > fromOvr) {
          onUserBreakthrough?.(p, fromOvr, p.overall, SKILL_LABELS[k1] ?? k1, plan.label);
        }
      }
    }
  }
}

/** Off-season progression that honors youth training plans for young players. */
export function progressPlayerWithTraining(p: Player) {
  const wasYouth = p.age <= YOUTH_MAX_AGE;
  const plan = getPlayerPlan(p);
  p.age += 1;
  let d = 0;
  if (p.age <= 23) {
    d = Math.max(0, p.potential - p.overall) * (0.25 + Math.random() * 0.35) * plan.speedMult - (Math.random() < 0.12 ? 1 : 0);
  } else if (p.age <= 25) {
    d = Math.max(0, p.potential - p.overall) * (0.15 + Math.random() * 0.3) * (wasYouth ? plan.speedMult : 1) + Math.random() * 1.5 - 0.5;
  } else if (p.age <= 29) {
    d = Math.random() * 3 - 1;
  } else if (p.age <= 32) {
    d = -(Math.random() * 2.5);
  } else {
    d = -(1 + Math.random() * 3.5);
  }

  const sk = p.skills as Record<string, number | undefined>;
  const keys = isGoalie(p) ? GOALIE_KEYS : SKATER_KEYS;
  const avgWeight = keys.reduce((s, k) => s + (plan.weights[k] ?? 1), 0) / keys.length;

  for (const k of keys) {
    const v = sk[k];
    if (v === undefined) continue;
    const wRatio = wasYouth && d > 0 ? (plan.weights[k] ?? 1) / Math.max(0.1, avgWeight) : 1;
    const delta = Math.round(d * wRatio + (Math.random() * 2 - 1));
    sk[k] = clamp(v + delta, 30, 99);
  }
  if (wasYouth && plan.id === 'intensive' && p.stats.gp >= 20 && p.potential < 95 && Math.random() < 0.28) {
    p.potential += 1;
  }
  p.overall = computeOverall(p);
  if (p.age > 28) p.potential = Math.max(p.overall, p.potential - 1);
  if (p.age <= 27) p.potential = Math.max(p.potential, p.overall);
  p.trainingXp = 0;
  delete p.seasonGrowth;
  if (p.age > YOUTH_MAX_AGE) delete p.trainingPlan;
}
