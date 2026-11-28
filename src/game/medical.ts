import { FL } from '../brand';
import type {
  AllStarResult,
  ClubFacilities,
  FacilityKey,
  GameState,
  Injury,
  InjurySeverity,
  Phase,
  Player,
  Team,
} from '../types';
import { seasonDateObj } from './schedule';
import { isDefense, isForward, isGoalie } from './ratings';

export const LTIR_MIN_DAYS = 14;
export const PLAY_THROUGH_MAX_DAYS = 6;
export const FACILITY_MAX_LEVEL = 5;

interface InjuryTemplate {
  name: string;
  severity: InjurySeverity;
  minDays: number;
  maxDays: number;
  goalieOnly?: boolean;
  skaterOnly?: boolean;
}

const INJURY_TEMPLATES: InjuryTemplate[] = [
  // Minor (3–7 days, ~54%)
  { name: 'Ушиб верхней части тела', severity: 'minor', minDays: 3, maxDays: 6 },
  { name: 'Микротравма паха', severity: 'minor', minDays: 4, maxDays: 7 },
  { name: 'Ушиб голеностопа', severity: 'minor', minDays: 3, maxDays: 6, skaterOnly: true },
  { name: 'ОРВИ / вирусная инфекция', severity: 'minor', minDays: 3, maxDays: 5 },
  { name: 'Спазм мышц спины', severity: 'minor', minDays: 4, maxDays: 7 },
  // Moderate (9–21 days, ~34%)
  { name: 'Растяжение связок колена', severity: 'moderate', minDays: 10, maxDays: 20 },
  { name: 'Растяжение приводящей мышцы', severity: 'moderate', minDays: 9, maxDays: 17 },
  { name: 'Сотрясение мозга', severity: 'moderate', minDays: 10, maxDays: 18, skaterOnly: true },
  { name: 'Травма кисти', severity: 'moderate', minDays: 11, maxDays: 21, skaterOnly: true },
  { name: 'Растяжение паховых колец', severity: 'moderate', minDays: 10, maxDays: 19, goalieOnly: true },
  { name: 'Подвывих плеча', severity: 'moderate', minDays: 12, maxDays: 21 },
  // Severe (24–50 days, ~12% — eligible for KHL LTIR / ДСБТ)
  { name: 'Надрыв боковой связки колена', severity: 'severe', minDays: 25, maxDays: 46 },
  { name: 'Перелом пальца / кисти', severity: 'severe', minDays: 24, maxDays: 42, skaterOnly: true },
  { name: 'Травма мениска', severity: 'severe', minDays: 28, maxDays: 50 },
  { name: 'Разрыв мышцы задней поверхности бедра', severity: 'severe', minDays: 24, maxDays: 44 },
];

export function severityOfDays(days: number): InjurySeverity {
  if (days >= 22) return 'severe';
  if (days >= 8) return 'moderate';
  return 'minor';
}

/** Normalize raw or legacy `{ name, games }` / `{ name, days }` injury payloads into calendar-day Injury. */
export function normalizeInjury(raw: unknown): Injury | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const rawDays = Number(r.days);
  const rawGames = Number(r.games);
  let days = 0;
  if (Number.isFinite(rawDays) && rawDays > 0) {
    days = Math.max(1, Math.round(rawDays));
  } else if (Number.isFinite(rawGames) && rawGames > 0) {
    // Legacy save / roster migration: 1 KHL game ≈ 2.5 calendar days
    days = Math.max(1, Math.round(rawGames * 2.5));
  } else {
    return null;
  }
  const totalRaw = Number(r.totalDays);
  const totalDays = Number.isFinite(totalRaw) && totalRaw >= days ? Math.round(totalRaw) : days;
  const sev = r.severity === 'minor' || r.severity === 'moderate' || r.severity === 'severe' ? r.severity : severityOfDays(totalDays);
  const daySustained = Number.isFinite(Number(r.daySustained)) ? Math.round(Number(r.daySustained)) : undefined;
  return {
    name: String(r.name || 'Травма'),
    days,
    totalDays,
    severity: sev,
    ...(daySustained !== undefined ? { daySustained } : {}),
  };
}

export function daysWord(n: number): string {
  const abs = Math.abs(Math.round(n));
  const mod100 = abs % 100;
  const mod10 = abs % 10;
  if (mod100 >= 11 && mod100 <= 19) return 'дней';
  if (mod10 === 1) return 'день';
  if (mod10 >= 2 && mod10 <= 4) return 'дня';
  return 'дней';
}

export function formatInjuryDays(days: number, short = false): string {
  const d = Math.max(1, Math.round(days));
  return short ? `${d} дн.` : `${d} ${daysWord(d)}`;
}

export function injuryReturnDate(dayNow: number, daysLeft: number, regularSeasonDays: number, season: string): string {
  const base = seasonDateObj(dayNow, regularSeasonDays, season);
  const ret = new Date(base.getFullYear(), base.getMonth(), base.getDate() + Math.max(1, Math.round(daysLeft)));
  return ret.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace(/\.$/, '');
}

export function severityLabel(sev?: InjurySeverity): string {
  if (sev === 'severe') return 'тяжёлая';
  if (sev === 'moderate') return 'средняя';
  return 'лёгкая';
}

/** True when a player cannot be dressed in the active KHL lineup. */
export function isUnavailable(p: Player | undefined, phase?: Phase): boolean {
  if (!p) return true;
  if (p.inLtir) return true;
  if (!p.injury) return false;
  if (phase === 'playoffs' && p.playingThroughInjury && p.injury.days <= PLAY_THROUGH_MAX_DAYS) return false;
  return true;
}

/** True when a player is currently dressed in playoffs while injured («на уколах»). */
export function isPlayingHurt(p: Player | undefined, phase?: Phase): boolean {
  return !!(p && phase === 'playoffs' && p.injury && !p.inLtir && p.playingThroughInjury && p.injury.days <= PLAY_THROUGH_MAX_DAYS);
}

/** Eligible to be placed into KHL Long-Term Injured Reserve (ДСБТ, 14+ calendar days). */
export function canPlaceInLtir(p: Player | undefined): boolean {
  if (!p || !p.injury || p.inLtir) return false;
  return p.injury.days >= LTIR_MIN_DAYS || (p.injury.totalDays ?? 0) >= LTIR_MIN_DAYS;
}

/** True when a player's salary is currently exempt from KHL salary cap via ДСБТ. */
export function isLtirCapExempt(p: Player | undefined): boolean {
  return !!(p && p.inLtir);
}

export function canPlayThroughInjury(p: Player | undefined, phase: Phase): boolean {
  return !!(p && phase === 'playoffs' && p.injury && !p.inLtir && p.injury.days <= PLAY_THROUGH_MAX_DAYS);
}

// ─────────────── Club Facilities (Lv. 1..5) ───────────────

export interface FacilityMeta {
  key: FacilityKey;
  title: string;
  subtitle: string;
  effectLabel: (level: number) => string;
}

export const FACILITY_UPGRADE_COSTS: Record<number, number> = {
  1: 80_000_000,  // 1 -> 2: 80 млн ₽
  2: 145_000_000, // 2 -> 3: 145 млн ₽
  3: 230_000_000, // 3 -> 4: 230 млн ₽
  4: 340_000_000, // 4 -> 5: 340 млн ₽
};

export function facilityUpgradeCost(currentLevel: number): number | null {
  if (currentLevel >= FACILITY_MAX_LEVEL) return null;
  return FACILITY_UPGRADE_COSTS[Math.max(1, Math.min(4, Math.round(currentLevel)))] ?? null;
}

export function defaultFacilities(budget: number): ClubFacilities {
  const rich = budget >= 1_750_000_000;
  const mid = budget >= 1_400_000_000;
  return {
    medical: rich ? 2 : 1,
    academy: mid ? 2 : 1,
    arena: rich ? 2 : 1,
    scouting: mid ? 2 : 1,
  };
}

export function ensureFacilities(t: Team): ClubFacilities {
  if (!t.facilities) {
    t.facilities = defaultFacilities(t.budget);
  } else {
    t.facilities.medical = Math.max(1, Math.min(FACILITY_MAX_LEVEL, Math.round(t.facilities.medical || 1)));
    t.facilities.academy = Math.max(1, Math.min(FACILITY_MAX_LEVEL, Math.round(t.facilities.academy || 1)));
    t.facilities.arena = Math.max(1, Math.min(FACILITY_MAX_LEVEL, Math.round(t.facilities.arena || 1)));
    t.facilities.scouting = Math.max(1, Math.min(FACILITY_MAX_LEVEL, Math.round(t.facilities.scouting || 1)));
  }
  return t.facilities;
}

export function medicalDurationMult(level = 1): number {
  const lv = Math.max(1, Math.min(5, level));
  return [1.0, 0.92, 0.85, 0.78, 0.72][lv - 1];
}

export function medicalRiskMult(level = 1): number {
  const lv = Math.max(1, Math.min(5, level));
  return [1.0, 0.94, 0.88, 0.83, 0.78][lv - 1];
}

export function medicalGoalieRestRecovery(level = 1): number {
  const lv = Math.max(1, Math.min(5, level));
  return [11, 12, 14, 15, 17][lv - 1];
}

export function academyXpMult(level = 1): number {
  const lv = Math.max(1, Math.min(5, level));
  return [1.0, 1.08, 1.16, 1.24, 1.32][lv - 1];
}

export function scoutingMaxSpread(level = 1): number {
  const lv = Math.max(1, Math.min(5, level));
  return [5, 4, 3, 2, 1][lv - 1];
}

export function scoutingDemandMult(level = 1): number {
  const lv = Math.max(1, Math.min(5, level));
  return [1.0, 0.99, 0.98, 0.97, 0.955][lv - 1];
}

export function computeHomeGateRevenue(arenaLevel = 1, isPlayoff = false, isWeekend = false, awayPoints = 0): number {
  const lv = Math.max(1, Math.min(5, arenaLevel));
  const base = [4_200_000, 5_400_000, 6_800_000, 8_300_000, 10_000_000][lv - 1];
  const wkMult = isWeekend ? 1.15 : 1.0;
  const poMult = isPlayoff ? 1.55 : 1.0;
  const marquee = awayPoints >= 60 ? 600_000 : 0;
  return Math.round(((base + marquee) * wkMult * poMult) / 100_000) * 100_000;
}

export const FACILITY_META: FacilityMeta[] = [
  {
    key: 'medical',
    title: 'Медицинский центр и реабилитация',
    subtitle: 'Криосауны, МРТ-диагностика и физиотерапевты первой команды',
    effectLabel: (lv) =>
      `Срок травм −${Math.round((1 - medicalDurationMult(lv)) * 100)}%, риск травм −${Math.round((1 - medicalRiskMult(lv)) * 100)}%, отдых вратарей +${medicalGoalieRestRecovery(lv)}/день`,
  },
  {
    key: 'academy',
    title: 'Академия МХЛ и штаб развития',
    subtitle: 'Индивидуальные тренеры по катанию и броску для молодёжи U23',
    effectLabel: (lv) =>
      `Прогресс U23 ×${academyXpMult(lv).toFixed(2)}, бонус потенциала воспитанников на Драфте юниоров +${lv - 1}`,
  },
  {
    key: 'arena',
    title: 'Домашняя арена и коммерция',
    subtitle: 'VIP-ложи, матчдэй-шоу, фудкорты и клубный ритейл на домашних играх',
    effectLabel: (lv) =>
      `Базовая касса домашнего матча ~${(computeHomeGateRevenue(lv, false, false) / 1e6).toFixed(1)} млн ₽ (в плей-офф ×1.55)`,
  },
  {
    key: 'scouting',
    title: 'Скаутское бюро и видеоаналитика',
    // (read when shown: the farm league of the open career)
    get subtitle() { return `Региональная сеть скаутов МХЛ/${FL()} и контрактная аналитика рынка`; },
    effectLabel: (lv) =>
      `Разброс потенциала на драфте ±${scoutingMaxSpread(lv)}, запросы агентов −${((1 - scoutingDemandMult(lv)) * 100).toFixed(1)}%`,
  },
];

/** Roll a new calendar-day KHL injury adjusted for the club's medical staff level. */
export function rollInjury(isG: boolean, medicalLevel: number, currentDay: number): Injury {
  const r = Math.random();
  const targetSev: InjurySeverity = r < 0.54 ? 'minor' : r < 0.88 ? 'moderate' : 'severe';
  const pool = INJURY_TEMPLATES.filter(
    (t) => t.severity === targetSev && (isG ? !t.skaterOnly : !t.goalieOnly)
  );
  const tpl = pool[Math.floor(Math.random() * pool.length)] ?? INJURY_TEMPLATES[0];
  const rawDays = tpl.minDays + Math.floor(Math.random() * (tpl.maxDays - tpl.minDays + 1));
  const scaled = Math.max(2, Math.round(rawDays * medicalDurationMult(medicalLevel)));
  const finalSev = severityOfDays(scaled);
  return {
    name: tpl.name,
    days: scaled,
    totalDays: scaled,
    severity: finalSev,
    daySustained: currentDay,
  };
}

// ─────────────── KHL All-Star Weekend (Неделя Звёзд КХЛ) ───────────────

export function allStarTargetDay(regularSeasonDays: number): number {
  return Math.max(12, Math.min(Math.max(12, regularSeasonDays - 8), Math.round(regularSeasonDays * 0.62)));
}

export function simulateAllStarWeekend(state: GameState): AllStarResult | null {
  const P = state.players;
  const pickConfRoster = (conf: 'Запад' | 'Восток'): string[] => {
    const clubIds = state.teamOrder.filter((id) => state.teams[id]?.conference === conf);
    const pool = clubIds
      .flatMap((tid) => state.teams[tid].players)
      .map((pid) => P[pid])
      .filter((p): p is Player => !!p && !p.inVhl && !p.injury && !p.inLtir);

    const scoreSkater = (p: Player) =>
      (p.stats.goals * 2.2 + p.stats.assists * 1.6 + p.stats.plusMinus * 0.4) + p.overall * 0.65;
    const scoreGoalie = (p: Player) => {
      const svPct = p.stats.shotsAgainst > 20 ? p.stats.saves / p.stats.shotsAgainst : 0.91;
      return p.stats.wins * 2.4 + p.stats.shutouts * 4 + svPct * 60 + p.overall * 0.5;
    };

    const forwards = pool
      .filter((p) => isForward(p))
      .sort((a, b) => scoreSkater(b) - scoreSkater(a))
      .slice(0, 6);
    const defenders = pool
      .filter((p) => isDefense(p))
      .sort((a, b) => scoreSkater(b) - scoreSkater(a))
      .slice(0, 4);
    const goalies = pool
      .filter((p) => isGoalie(p))
      .sort((a, b) => scoreGoalie(b) - scoreGoalie(a))
      .slice(0, 2);
    return [...forwards, ...defenders, ...goalies].map((p) => p.id);
  };

  const westRoster = pickConfRoster('Запад');
  const eastRoster = pickConfRoster('Восток');
  if (westRoster.length < 4 || eastRoster.length < 4) return null;

  const avgOvr = (ids: string[]) => ids.reduce((s, id) => s + (P[id]?.overall ?? 75), 0) / Math.max(1, ids.length);
  const wAdv = (avgOvr(westRoster) - avgOvr(eastRoster)) * 0.25;
  let westScore = Math.max(4, Math.round(7 + wAdv + (Math.random() - 0.5) * 5));
  let eastScore = Math.max(4, Math.round(7 - wAdv + (Math.random() - 0.5) * 5));
  if (westScore === eastScore) {
    if (Math.random() < 0.5) westScore += 1;
    else eastScore += 1;
  }

  const winningRoster = westScore > eastScore ? westRoster : eastRoster;
  const winningSkaters = winningRoster.map((id) => P[id]).filter((p): p is Player => !!p && !isGoalie(p));
  const allParticipants = [...westRoster, ...eastRoster].map((id) => P[id]).filter((p): p is Player => !!p);
  const allSkaters = allParticipants.filter((p) => !isGoalie(p));

  const mvp =
    winningSkaters.sort((a, b) => b.overall + Math.random() * 8 - (a.overall + Math.random() * 8))[0] ??
    allParticipants[0];
  const fastest =
    [...allSkaters].sort((a, b) => (b.skills.skating ?? b.overall) - (a.skills.skating ?? a.overall))[0] ?? mvp;
  const hardest =
    [...allSkaters].sort((a, b) => (b.skills.shooting ?? b.overall) - (a.skills.shooting ?? a.overall))[0] ?? mvp;

  const userSelectedIds = [...westRoster, ...eastRoster].filter((id) => P[id]?.teamId === state.userTeamId);

  return {
    season: state.league.season,
    day: state.day,
    westScore,
    eastScore,
    mvpId: mvp.id,
    fastestSkaterId: fastest.id,
    hardestShotId: hardest.id,
    westRoster,
    eastRoster,
    userSelectedIds,
  };
}
