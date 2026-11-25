import type { AttackStyle, ForecheckStyle, Lineup, Player, PullGoaliePolicy, Team, TeamTactics } from '../types';
import { clamp, isDefense, isForward, isGoalie } from './ratings';
import { defaultTactics } from './defaults';

export type ArchetypeId =
  | 'sniper'
  | 'playmaker'
  | 'twoway'
  | 'power'
  | 'universal'
  | 'offensive_d'
  | 'stayhome_d'
  | 'twoway_d'
  | 'butterfly_g'
  | 'positional_g';

export interface ArchetypeInfo {
  id: ArchetypeId;
  short: string;
  label: string;
  color: string;
}

export const ARCHETYPES: Record<ArchetypeId, ArchetypeInfo> = {
  sniper: { id: 'sniper', short: 'СНП', label: 'Снайпер', color: '#E5323E' },
  playmaker: { id: 'playmaker', short: 'ДИС', label: 'Диспетчер', color: '#8FD8F0' },
  twoway: { id: 'twoway', short: 'ДВУ', label: 'Двусторонний', color: '#3FCF8E' },
  power: { id: 'power', short: 'СИЛ', label: 'Силовик', color: '#F2B544' },
  universal: { id: 'universal', short: 'УНИ', label: 'Универсал', color: '#B9C7DA' },
  offensive_d: { id: 'offensive_d', short: 'АТЗ', label: 'Атакующий защ.', color: '#8FD8F0' },
  stayhome_d: { id: 'stayhome_d', short: 'ДОМ', label: 'Домосед', color: '#F2B544' },
  twoway_d: { id: 'twoway_d', short: 'ДВЗ', label: 'Двусторонний защ.', color: '#3FCF8E' },
  butterfly_g: { id: 'butterfly_g', short: 'РФЛ', label: 'Вратарь-реакция', color: '#8FD8F0' },
  positional_g: { id: 'positional_g', short: 'ПОЗ', label: 'Позиционный ВР', color: '#3FCF8E' },
};

export function getArchetype(p: Player): ArchetypeInfo {
  const s = p.skills;
  if (isGoalie(p)) {
    return (s.reflexes ?? 65) >= (s.positioning ?? 65) + 2 ? ARCHETYPES.butterfly_g : ARCHETYPES.positional_g;
  }
  if (isDefense(p)) {
    const off = ((s.passing ?? 65) + (s.puckControl ?? 65) + (s.shooting ?? 60)) / 3;
    const def = ((s.defense ?? 65) + (s.checking ?? 65)) / 2;
    if (off >= def + 2.5) return ARCHETYPES.offensive_d;
    if (def >= off + 6.5) return ARCHETYPES.stayhome_d;
    return ARCHETYPES.twoway_d;
  }
  const sh = s.shooting ?? 65;
  const pa = ((s.passing ?? 65) * 0.65 + (s.puckControl ?? 65) * 0.35);
  const df = s.defense ?? 62;
  const ch = s.checking ?? 62;
  if (sh >= pa + 3 && sh >= df + 4) return ARCHETYPES.sniper;
  if (pa >= sh + 2.5 && pa >= df + 3) return ARCHETYPES.playmaker;
  if (ch >= 73 && (p.weight >= 89 || ch >= sh + 4)) return ARCHETYPES.power;
  if (df >= 71 && df >= sh - 2) return ARCHETYPES.twoway;
  return ARCHETYPES.universal;
}

export function unitChemKey(ids: (string | null)[]): string | null {
  const valid = ids.filter((x): x is string => !!x).sort();
  return valid.length >= 2 ? valid.join('|') : null;
}

export interface ChemistryBreakdown {
  score: number; // -5 .. +5
  gamesTogether: number;
  summary: string;
  roles: ArchetypeInfo[];
}

export function calcForwardChemistry(ids: (string | null)[] | undefined, P: Record<string, Player>, chemGP?: Record<string, number>): ChemistryBreakdown {
  const ps = (ids ?? []).map((id) => (id ? P[id] : null)).filter((p): p is Player => !!p && isForward(p));
  if (ps.length < 3) {
    return { score: ps.length === 0 ? 0 : -2, gamesTogether: 0, summary: 'Неполная тройка', roles: ps.map(getArchetype) };
  }
  const roles = ps.map(getArchetype);
  const rIds = roles.map((r) => r.id);
  let pts = 0;
  const notes: string[] = [];

  const hasSnp = rIds.includes('sniper');
  const hasPlay = rIds.includes('playmaker');
  const hasGlue = rIds.includes('twoway') || rIds.includes('power') || rIds.includes('universal');

  if (hasSnp && hasPlay && hasGlue) {
    pts += 2.5;
    notes.push('идеальный баланс ролей');
  } else if ((hasSnp && hasPlay) || (hasPlay && hasGlue) || (hasSnp && hasGlue)) {
    pts += 1.2;
    notes.push('дополняющие роли');
  } else if (rIds[0] === rIds[1] && rIds[1] === rIds[2] && rIds[0] !== 'universal' && rIds[0] !== 'twoway') {
    pts -= 2.2;
    notes.push('три однотипных игрока');
  }

  // Center suitability
  const cPlayer = ids?.[0] ? P[ids[0]] : null;
  if (cPlayer) {
    if (cPlayer.position === 'C') pts += 0.5;
    else {
      pts -= 1.0;
      notes.push('крайний на точке вбрасывания');
    }
  }

  // Handedness variety for wingers
  if (ps.some((p) => p.hand === 'L') && ps.some((p) => p.hand === 'R')) {
    pts += 0.5;
  }

  const key = unitChemKey(ids ?? []);
  const gp = key && chemGP ? (chemGP[key] ?? 0) : 0;
  if (gp >= 12) {
    pts += 2;
    notes.push(`сыграны (${gp} игр)`);
  } else if (gp >= 4) {
    pts += 1;
    notes.push(`${gp} игр вместе`);
  }

  const score = clamp(Math.round(pts), -5, 5);
  return {
    score,
    gamesTogether: gp,
    summary: notes.join(' · ') || 'стандартное сочетание',
    roles,
  };
}

export function calcDefenseChemistry(ids: (string | null)[] | undefined, P: Record<string, Player>, chemGP?: Record<string, number>): ChemistryBreakdown {
  const ps = (ids ?? []).map((id) => (id ? P[id] : null)).filter((p): p is Player => !!p && isDefense(p));
  if (ps.length < 2) {
    return { score: ps.length === 0 ? 0 : -2, gamesTogether: 0, summary: 'Неполная пара', roles: ps.map(getArchetype) };
  }
  const roles = ps.map(getArchetype);
  const [a, b] = roles.map((r) => r.id);
  let pts = 0;
  const notes: string[] = [];

  if ((a === 'offensive_d' && b === 'stayhome_d') || (b === 'offensive_d' && a === 'stayhome_d')) {
    pts += 2.5;
    notes.push('пакмувер + домосед');
  } else if (a === 'twoway_d' || b === 'twoway_d') {
    pts += 1.2;
    notes.push('надёжная пара');
  } else if (a === 'offensive_d' && b === 'offensive_d') {
    pts -= 2.0;
    notes.push('два атакующих без страховки');
  }

  if (ps[0].hand !== ps[1].hand) {
    pts += 1.0;
    notes.push('левый + правый хват');
  }

  const key = unitChemKey(ids ?? []);
  const gp = key && chemGP ? (chemGP[key] ?? 0) : 0;
  if (gp >= 12) {
    pts += 1.5;
    notes.push(`сыграны (${gp} игр)`);
  } else if (gp >= 4) {
    pts += 0.8;
    notes.push(`${gp} игр вместе`);
  }

  const score = clamp(Math.round(pts), -5, 5);
  return {
    score,
    gamesTogether: gp,
    summary: notes.join(' · ') || 'стандартная пара',
    roles,
  };
}

/** Record one match played together for each active forward trio and defense pair; prune stale keys. */
export function recordLineupChemistryGP(team: Team, lineup: Lineup) {
  const map: Record<string, number> = { ...(team.chemGP ?? {}) };
  const active = new Set<string>();
  for (const f of lineup.F) {
    const k = unitChemKey(f);
    if (k) {
      map[k] = (map[k] ?? 0) + 1;
      active.add(k);
    }
  }
  for (const d of lineup.D) {
    const k = unitChemKey(d);
    if (k) {
      map[k] = (map[k] ?? 0) + 1;
      active.add(k);
    }
  }
  const entries = Object.entries(map);
  if (entries.length > 16) {
    entries.sort((a, b) => (active.has(b[0]) ? 1000 : 0) + b[1] - ((active.has(a[0]) ? 1000 : 0) + a[1]));
    const pruned: Record<string, number> = {};
    for (const [k, v] of entries.slice(0, 14)) pruned[k] = v;
    team.chemGP = pruned;
  } else {
    team.chemGP = map;
  }
}

/* ---------------- Captains (К / А) & Mentoring ---------------- */

export function leaderScore(p: Player): number {
  if (isGoalie(p)) return -999;
  const ageBonus = p.age >= 28 ? 14 : p.age >= 25 ? 9 : p.age >= 23 ? 3 : -8;
  return p.overall * 1.15 + ageBonus + (p.morale - 65) * 0.25 + ((p.skills.defense ?? 65) - 65) * 0.15;
}

export function ensureCaptains(team: Team, P: Record<string, Player>) {
  const valid = new Set(team.players.filter((id) => P[id] && !isGoalie(P[id]) && !P[id].inVhl));
  let cap = team.captainId && valid.has(team.captainId) ? team.captainId : null;
  const assts = (team.assistantIds ?? []).filter((id) => valid.has(id) && id !== cap);
  const candidates = [...valid].map((id) => P[id]).sort((a, b) => leaderScore(b) - leaderScore(a));
  if (!cap && candidates.length > 0) {
    cap = candidates[0].id;
  }
  for (const c of candidates) {
    if (assts.length >= 2) break;
    if (c.id !== cap && !assts.includes(c.id)) assts.push(c.id);
  }
  team.captainId = cap;
  team.assistantIds = assts.slice(0, 2);
}

/** Give a player the «C» or an «A» (null strips the letter); the old captain becomes an alternate. */
export function assignTeamRole(t: Team, P: Record<string, Player>, playerId: string, role: 'C' | 'A' | null) {
  t.assistantIds ??= [];
  if (role === 'C') {
    const oldCap = t.captainId;
    t.captainId = playerId;
    t.assistantIds = t.assistantIds.filter((id) => id !== playerId);
    if (oldCap && oldCap !== playerId && t.assistantIds.length < 2) t.assistantIds.push(oldCap);
  } else if (role === 'A') {
    if (t.captainId === playerId) t.captainId = null;
    if (!t.assistantIds.includes(playerId)) {
      if (t.assistantIds.length >= 2) t.assistantIds.shift();
      t.assistantIds.push(playerId);
    }
    ensureCaptains(t, P);
  } else {
    if (t.captainId === playerId) t.captainId = null;
    t.assistantIds = t.assistantIds.filter((id) => id !== playerId);
    ensureCaptains(t, P);
  }
}

export function playerCaptainRole(team: Team | undefined, playerId: string): 'C' | 'A' | null {
  if (!team) return null;
  if (team.captainId === playerId) return 'C';
  if (team.assistantIds?.includes(playerId)) return 'A';
  return null;
}

/** Clutch rating bonus in OT, shootouts, playoffs, and derbies from team captains. */
export function teamLeadershipBonus(team: Team | undefined, P: Record<string, Player>): number {
  if (!team) return 0;
  let b = 0;
  const c = team.captainId ? P[team.captainId] : null;
  if (c && !c.injury && !c.inVhl) {
    b += c.age >= 26 && c.morale >= 70 ? 0.9 : 0.4;
  }
  for (const aid of team.assistantIds ?? []) {
    const a = P[aid];
    if (a && !a.injury && !a.inVhl && a.age >= 25) b += 0.3;
  }
  return clamp(b, 0, 1.5);
}

/** True when a young player skates on the same forward line or D pair as a veteran C/A (26+). */
export function hasCaptainMentorOnLine(team: Team, P: Record<string, Player>, youthId: string): boolean {
  const leaders = new Set<string>(
    [team.captainId, ...(team.assistantIds ?? [])].filter(
      (id): id is string => !!id && !!P[id] && P[id].age >= 26 && !P[id].injury
    )
  );
  if (!leaders.size) return false;
  for (const line of team.lineup.F) {
    if (line.includes(youthId) && line.some((id) => id && leaders.has(id))) return true;
  }
  for (const pair of team.lineup.D) {
    if (pair.includes(youthId) && pair.some((id) => id && leaders.has(id))) return true;
  }
  return false;
}

/* ---------------- Goalie Freshness & Fatigue ---------------- */

export function goalieFreshness(p: Player | null | undefined): number {
  if (!p) return 100;
  return clamp(Math.round(100 - (p.fatigue ?? 0)), 0, 100);
}

export function effectiveGoalieOvr(p: Player | null | undefined, roadStreak = 0): number {
  if (!p) return 55;
  const fresh = goalieFreshness(p);
  let pen = 0;
  if (fresh < 45) pen = 6 + Math.round((45 - fresh) * 0.15);
  else if (fresh < 65) pen = Math.round((65 - fresh) * 0.18);
  if (roadStreak >= 4) pen += 1;
  if (p.injury && p.playingThroughInjury) pen += 3;
  return clamp(p.overall - pen, 45, 99);
}

export function freshnessTone(fresh: number): { label: string; color: string; warn: boolean } {
  if (fresh >= 82) return { label: 'Свежий', color: '#3FCF8E', warn: false };
  if (fresh >= 65) return { label: 'В тонусе', color: '#8FD8F0', warn: false };
  if (fresh >= 48) return { label: 'Подустал', color: '#F2B544', warn: true };
  return { label: 'Измотан', color: '#E5323E', warn: true };
}

/* ---------------- Team Tactics ---------------- */

export const FORECHECK_INFO: Record<ForecheckStyle, { label: string; short: string; desc: string; shotMult: number; oppShotMult: number; penMult: number; hitMult: number; xgMult: number; oppXgMult: number }> = {
  aggressive: {
    label: 'Активный форчекинг 2-1-2',
    short: '2-1-2 Прессинг',
    desc: 'Высокое давление в чужой зоне: +10% к броскам и остроте атак, больше силовых, но выше риск контратак и удалений.',
    shotMult: 1.1,
    oppShotMult: 1.04,
    penMult: 1.14,
    hitMult: 1.25,
    xgMult: 1.05,
    oppXgMult: 1.07,
  },
  balanced: {
    label: 'Сбалансированный 1-2-2',
    short: '1-2-2 Баланс',
    desc: 'Классическая система КХЛ без перекосов между давлением и плотностью средней зоны.',
    shotMult: 1.0,
    oppShotMult: 1.0,
    penMult: 1.0,
    hitMult: 1.0,
    xgMult: 1.0,
    oppXgMult: 1.0,
  },
  trap: {
    label: 'Откат / Капкан 1-3-1',
    short: '1-3-1 Капкан',
    desc: 'Плотный заслон на синей линии: снижает темп матча, режет моменты соперника (−13% xG), идеально для удержания счёта.',
    shotMult: 0.9,
    oppShotMult: 0.87,
    penMult: 0.88,
    hitMult: 0.85,
    xgMult: 0.96,
    oppXgMult: 0.87,
  },
};

export const ATTACK_STYLE_INFO: Record<AttackStyle, { label: string; short: string; desc: string; shotMult: number; xgMult: number }> = {
  shoot: {
    label: 'Набросы и трафик на пятаке',
    short: 'Броски от синей',
    desc: 'Бросать при любой возможности и закрывать обзор вратарю: больше бросков и добиваний.',
    shotMult: 1.1,
    xgMult: 0.93,
  },
  balanced: {
    label: 'Комбинационная атака',
    short: 'Комбинации',
    desc: 'Сочетание бросков сходу и позиционного розыгрыша.',
    shotMult: 1.0,
    xgMult: 1.0,
  },
  cycle: {
    label: 'Розыгрыш до верного',
    short: 'До верного',
    desc: 'Меньше бросков с периметра, но намного опаснее моменты из слота и на дальней штанге (+11% к xG броска).',
    shotMult: 0.9,
    xgMult: 1.11,
  },
};

export const PULL_GOALIE_INFO: Record<PullGoaliePolicy, { label: string; short: string; secondsLeft: number }> = {
  early: { label: 'Ранний риск (за 3:00)', short: 'За 3:00', secondsLeft: 180 },
  normal: { label: 'Стандарт (за 2:15)', short: 'За 2:15', secondsLeft: 135 },
  never: { label: 'Не снимать авто', short: 'Не снимать', secondsLeft: 0 },
};

export function getTeamTactics(team: Pick<Team, 'tactics'> | undefined): TeamTactics {
  return team?.tactics ? { ...defaultTactics(), ...team.tactics } : defaultTactics();
}
