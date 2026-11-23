import type { CoachProfile, CoachRole, Coach, GameState, Player, Team, TeamFocus, TeamIntervention, TeamManagement } from '../types';
import { COACH_PROFILES, defaultCoachMarket, defaultStaff } from './coachData';
import { getOfficialClubPalette, OFFICIAL_KHL_PALETTES } from './clubColors';
import { clamp, mean } from './ratings';

export const TEAM_FOCUS: Record<TeamFocus, { label: string; description: string; attack: number; defense: number; special: number; recovery: number }> = {
  balanced: { label: 'Баланс', description: 'Без профильного бонуса. Нагрузка −4/день.', attack: 0, defense: 0, special: 0, recovery: 4 },
  attack: { label: 'Атака', description: 'После 3 дней: +3 атака, −1 оборона. Нагрузка −1/день.', attack: 3, defense: -1, special: 0, recovery: 1 },
  defense: { label: 'Оборона', description: 'После 3 дней: +3 оборона, −1 атака. Нагрузка −2/день.', attack: -1, defense: 3, special: 0, recovery: 2 },
  special: { label: 'Спецбригады', description: 'После 3 дней: +7% к качеству большинства и защите меньшинства; −1 атака. Нагрузка −2/день.', attack: -1, defense: 0, special: 0.07, recovery: 2 },
  recovery: { label: 'Восстановление', description: 'Нагрузка −9/день, дополнительный отдых вратарям. После 3 дней: −2 атака, −1 оборона.', attack: -2, defense: -1, special: 0, recovery: 9 },
};
export const INTERVENTIONS: Record<TeamIntervention, { label: string; description: string; cost: number }> = {
  support: { label: 'Поддержать команду', description: '+5 мораль, +4 доверие. Общий перерыв между собраниями — 14 дней.', cost: 0 },
  demand: { label: 'Жёсткий видеоразбор', description: '7 дней: +2 оборона. −4 мораль, −3 доверие; при доверии <45 команда не примет разбор.', cost: 0 },
  bonding: { label: 'Командное мероприятие', description: '+6 сплочённость, +3 мораль, −4 нагрузка. Перерыв — 14 дней.', cost: 3_000_000 },
};

function finite(v: unknown, fallback: number, lo: number, hi: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
}
const PROFILE_ALIASES: Record<string, CoachProfile> = {
  motivation: 'motivator', 'мотиватор': 'motivator', mentor: 'development', 'наставник': 'development', 'развитие': 'development',
  offense: 'attack', offensive: 'attack', 'атакующий': 'attack', defensive: 'defense', 'оборонительный': 'defense', system: 'balanced', 'системный': 'balanced',
};
function coachProfile(v: unknown, fallback: CoachProfile): CoachProfile {
  if (typeof v !== 'string') return fallback;
  if (Object.prototype.hasOwnProperty.call(COACH_PROFILES, v)) return v as CoachProfile;
  return PROFILE_ALIASES[v.trim().toLowerCase()] ?? fallback;
}
export function normalizeCoach(raw: unknown, fallback: Coach): Coach {
  if (!raw || typeof raw !== 'object') return { ...fallback };
  const r = raw as Partial<Coach>;
  const profile = coachProfile(r.profile, fallback.profile);
  const c: Coach = { ...fallback, ...COACH_PROFILES[profile], profile };
  delete c.source; delete c.snapshot; delete c.acting; delete c.actingFromAssistant; delete c.label;
  c.id = typeof r.id === 'string' && r.id.trim() ? r.id.trim().slice(0, 120) : fallback.id;
  c.name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 100) : fallback.name;
  for (const k of ['attack', 'defense', 'special', 'development', 'motivation'] as const) c[k] = finite(r[k], c[k], 40, 95);
  c.salary = finite(r.salary, fallback.salary, 0, 100_000_000);
  c.fictional = typeof r.fictional === 'boolean' ? r.fictional : !r.source;
  if (typeof r.source === 'string' && /^https:\/\//.test(r.source)) c.source = r.source.slice(0, 800);
  if (typeof r.snapshot === 'string') c.snapshot = r.snapshot.slice(0, 40);
  if (typeof r.label === 'string' && r.label.trim()) c.label = r.label.trim().slice(0, 30);
  if (typeof r.acting === 'boolean') c.acting = r.acting && c.role === 'head';
  if (typeof r.actingFromAssistant === 'boolean') c.actingFromAssistant = r.actingFromAssistant && !!c.acting;
  return c;
}
export function ensureTeamManagement(t: Team): TeamManagement {
  const palette = getOfficialClubPalette(t);
  const key = Object.keys(OFFICIAL_KHL_PALETTES).find((id) => OFFICIAL_KHL_PALETTES[id] === palette) ?? t.id;
  const defaults = defaultStaff(key);
  const saved = Array.isArray(t.coaches) ? t.coaches : [];
  t.coaches = defaults.flatMap((fallback) => {
    const raw = saved.find((c) => c?.role === fallback.role);
    return !raw && t.management?.staffVersion === 2 ? [] : [normalizeCoach(raw, fallback)];
  });
  const r = t.management;
  t.management = {
    staffVersion: 2,
    focus: typeof r?.focus === 'string' && Object.prototype.hasOwnProperty.call(TEAM_FOCUS, r.focus) ? r.focus : 'balanced',
    focusDays: finite(r?.focusDays, 0, 0, 30), load: finite(r?.load, 20, 0, 100),
    cohesion: finite(r?.cohesion, 65, 0, 100), trust: finite(r?.trust, 65, 0, 100),
    familiarity: finite(r?.familiarity, 100, 0, 100),
    meetingCooldown: finite(r?.meetingCooldown, 0, 0, 14),
    staffCooldown: { head: finite(r?.staffCooldown?.head, 0, 0, 30), assistant: finite(r?.staffCooldown?.assistant, 0, 0, 30) },
    disciplineDays: finite(r?.disciplineDays, 0, 0, 7),
    lastAction: typeof r?.lastAction === 'string' ? r.lastAction.slice(0, 300) : undefined,
  };
  return t.management;
}
export function ensureCoachingState(s: GameState) {
  Object.values(s.teams).forEach(ensureTeamManagement);
  const identity = (c: Coach) => c.name.toLowerCase().replace(/ё/g, 'е').trim();
  const staff = Object.values(s.teams).flatMap((t) => t.coaches ?? []);
  const occupied = new Set(staff.map(identity));
  const ids = new Set(staff.map(c => c.id));
  const defaults = defaultCoachMarket();
  // Migrate only unoccupied market entries; never rewrite coaches already hired in a saved career.
  const saved = Array.isArray(s.coachMarket) ? s.coachMarket : [];
  const market = s.coachMarketVersion === 2 && Array.isArray(s.coachMarket) ? saved : [...saved.filter(c => !c?.id?.startsWith('generated-')), ...defaults];
  s.coachMarket = market.flatMap((raw) => {
    if (!raw || (raw.role !== 'head' && raw.role !== 'assistant')) return [];
    const c = normalizeCoach(raw, { ...defaults[0], role: raw.role });
    if (occupied.has(identity(c)) || ids.has(c.id)) return [];
    occupied.add(identity(c)); ids.add(c.id);
    return [c];
  });
  s.coachMarketVersion = 2;
}

/**
 * Careers started before free coaches were read from roster.json still hold the built-in list
 * (`market-*` ids). Replace those entries with the roster's `freeCoaches`; coaches released during
 * the career stay on the market, and anyone already in a club staff is skipped. Runs once per save.
 */
export function adoptRosterCoachMarket(s: GameState, freeCoaches: Coach[]): boolean {
  if (s.coachMarketSource === 'roster') return false;
  const kept = (s.coachMarket ?? []).filter((c) => !c?.id?.startsWith('market-'));
  s.coachMarket = [...kept, ...freeCoaches.map((c) => ({ ...c }))];
  s.coachMarketVersion = 2;
  s.coachMarketSource = 'roster';
  ensureCoachingState(s);
  return true;
}

export interface CoachingEffects { attack: number; defense: number; special: number; development: number; goalie: number }
/** Pure: UI and both match paths use exactly the same bounded modifiers. */
export function coachingEffects(t: Team, players: Record<string, Player>): CoachingEffects {
  const m = t.management;
  if (!m || !t.coaches?.length) return { attack: 0, defense: 0, special: 0, development: 1, goalie: 0 };
  const skill = (key: 'attack' | 'defense' | 'special' | 'development' | 'motivation') => {
    const h = t.coaches!.find((c) => c.role === 'head')?.[key] ?? 65;
    const a = t.coaches!.find((c) => c.role === 'assistant')?.[key] ?? 65;
    return h * 0.65 + a * 0.35;
  };
  const roster = t.players.map((id) => players[id]).filter((p) => p && !p.inVhl);
  const morale = roster.length ? mean(roster.map((p) => p.morale)) : 65;
  const mental = (morale - 65) * 0.055 + (m.cohesion - 65) * 0.025 + (m.trust - 65) * 0.025;
  const overload = Math.max(0, m.load - 50) * 0.07;
  const adaptation = (100 - m.familiarity) * 0.035;
  const focus = TEAM_FOCUS[m.focus];
  const prepared = Math.min(1, m.focusDays / 3);
  return {
    attack: clamp((skill('attack') - 65) * 0.09 + mental - overload - adaptation + focus.attack * prepared, -8, 8),
    defense: clamp((skill('defense') - 65) * 0.09 + mental - overload - adaptation + focus.defense * prepared + (m.disciplineDays > 0 ? 2 : 0), -8, 8),
    special: clamp((skill('special') - 65) * 0.002 + focus.special * prepared, -0.08, 0.13),
    development: clamp(1 + (skill('development') - 65) * 0.006, 0.85, 1.18),
    goalie: clamp((skill('defense') - 65) * 0.025 - overload * 0.3, -1.5, 1),
  };
}

export function recentTeamForm(s: GameState, tid: string) {
  const games = s.schedule.flat().filter((g) => g.played && g.result && (g.home === tid || g.away === tid))
    .sort((a, b) => a.day - b.day || a.id - b.id).slice(-8);
  let wins = 0, gf = 0, ga = 0;
  for (const g of games) {
    const r = g.result!; const home = g.home === tid;
    const scored = home ? r.homeScore : r.awayScore; const allowed = home ? r.awayScore : r.homeScore;
    gf += scored; ga += allowed; if (scored > allowed) wins++;
  }
  return { played: games.length, wins, losses: games.length - wins, gf, ga, crisis: games.length >= 5 && wins <= 1 };
}

export function coachHireCost(t: Team, candidate: Coach, role: CoachRole = candidate.role): number {
  const outgoing = t.coaches?.find((c) => c.role === role);
  return Math.round((outgoing?.actingFromAssistant ? 0 : outgoing?.salary ?? 0) * 0.5 + candidate.salary * 0.25);
}
export function hireCoach(s: GameState, candidateId: string, chosenRole?: CoachRole): string | null {
  const t = s.teams[s.userTeamId]; const m = ensureTeamManagement(t);
  const candidate = s.coachMarket?.find((c) => c.id === candidateId);
  if (!candidate) return 'Этот тренер уже недоступен.';
  const role = chosenRole ?? candidate.role;
  if (role !== 'head' && role !== 'assistant') return 'Выберите должность.';
  const old = t.coaches!.find((c) => c.role === role);
  if (old && !old.acting && m.staffCooldown[role] > 0) return `Следующая смена на этой должности через ${Math.ceil(m.staffCooldown[role])} дн.`;
  const cost = coachHireCost(t, candidate, role);
  if (t.budget < cost) return 'Недостаточно средств на компенсацию и подписной бонус.';
  if (Object.values(s.teams).some((team) => team.coaches?.some((c) => c.id === candidateId || c.name === candidate.name))) return 'У тренера уже есть клуб.';
  s.coachMarket = s.coachMarket!.filter((c) => c.id !== candidateId);
  t.coaches = t.coaches!.filter(c => c.role !== role);
  if (old?.actingFromAssistant) {
    // An acting assistant returns to his own post, unless a new assistant already occupies it.
    if (!t.coaches.some(c => c.role === 'assistant')) t.coaches.push({ ...old, role: 'assistant', acting: false, actingFromAssistant: false });
    else s.coachMarket.push({ ...old, role: 'assistant', acting: false, actingFromAssistant: false });
  } else if (old) s.coachMarket.push({ ...old, acting: false, actingFromAssistant: false });
  t.coaches.push({ ...candidate, role, acting: false, actingFromAssistant: false });
  t.coaches.sort((a, b) => Number(b.role === 'head') - Number(a.role === 'head'));
  t.budget -= cost;
  m.familiarity = role === 'head' ? 40 : Math.min(m.familiarity, 70);
  if (role === 'head') m.trust = 60;
  m.staffCooldown[role] = 30;
  m.lastAction = `${candidate.name}: ${role === 'head' ? 'главный тренер' : 'ассистент'}. Штабу нужно время на адаптацию.`;
  return null;
}
export function fireCoach(s: GameState, role: CoachRole): string | null {
  const t = s.teams[s.userTeamId]; const m = ensureTeamManagement(t);
  const old = t.coaches!.find(c => c.role === role);
  if (!old) return 'Должность уже свободна.';
  const assistant = t.coaches!.find(c => c.role === 'assistant');
  if (role === 'head' && !assistant) return 'Сначала наймите ассистента или назначьте нового главного: нельзя оставить команду без руководителя.';
  const cost = Math.round(old.salary * .5);
  if (t.budget < cost) return 'Недостаточно средств на компенсацию.';
  t.budget -= cost;
  t.coaches = t.coaches!.filter(c => c.id !== old.id && !(role === 'head' && c.id === assistant!.id));
  s.coachMarket ??= [];
  s.coachMarket.push({ ...old, acting: false, actingFromAssistant: false });
  if (role === 'head') {
    t.coaches.push({ ...assistant!, role: 'head', acting: true, actingFromAssistant: true });
    m.familiarity = Math.min(m.familiarity, 70); m.trust = 60;
  }
  m.staffCooldown[role] = 30;
  m.lastAction = `${old.name} уволен.${role === 'head' ? ` ${assistant!.name} — и. о. главного до назначения нового тренера.` : ' Вакансия ассистента открыта.'}`;
  return null;
}
export function changeTeamFocus(s: GameState, focus: TeamFocus): string | null {
  if (!Object.prototype.hasOwnProperty.call(TEAM_FOCUS, focus)) return 'Неизвестный план подготовки.';
  const m = ensureTeamManagement(s.teams[s.userTeamId]);
  if (m.focus === focus) return null;
  m.focus = focus; m.focusDays = 0;
  m.lastAction = `Новый план: ${TEAM_FOCUS[focus].label}. Полный эффект через 3 календарных дня.`;
  return null;
}
export function interveneTeam(s: GameState, action: TeamIntervention): string | null {
  if (!Object.prototype.hasOwnProperty.call(INTERVENTIONS, action)) return 'Неизвестное решение.';
  if (s.phase === 'offseason') return 'Собрания доступны во время сезона и плей-офф.';
  const t = s.teams[s.userTeamId]; const m = ensureTeamManagement(t); const def = INTERVENTIONS[action];
  if (m.meetingCooldown > 0) return `Команде нужно время: следующее собрание через ${Math.ceil(m.meetingCooldown)} дн.`;
  if (t.budget < def.cost) return 'Недостаточно средств.';
  if (action === 'demand' && m.trust < 45) return 'Доверие ниже 45: сначала поддержите команду, иначе разбор не будет принят.';
  t.budget -= def.cost; m.meetingCooldown = 14;
  const morale = action === 'support' ? 5 : action === 'demand' ? -4 : 3;
  for (const id of t.players) { const p = s.players[id]; if (p && !p.inVhl) p.morale = clamp(p.morale + morale, 30, 99); }
  if (action === 'support') m.trust = clamp(m.trust + 4, 0, 100);
  if (action === 'demand') { m.disciplineDays = 7; m.trust = clamp(m.trust - 3, 0, 100); }
  if (action === 'bonding') { m.cohesion = clamp(m.cohesion + 6, 0, 100); m.load = Math.max(0, m.load - 4); }
  m.lastAction = def.label;
  return null;
}

/** Called once on each calendar advance (not on UI renders or partial live-match commits). */
export function stepTeamManagement(s: GameState, calendarDays: number) {
  const days = Math.max(1, calendarDays);
  for (const t of Object.values(s.teams)) {
    const m = ensureTeamManagement(t);
    // AI uses the same focus system, but never receives free interventions or hires.
    if (t.id !== s.userTeamId && s.day % 7 === 0) {
      const form = recentTeamForm(s, t.id);
      const next: TeamFocus = m.load > 65 ? 'recovery' : form.played >= 5 && form.gf < form.played * 2 ? 'attack' : form.ga > form.played * 3 && form.played >= 5 ? 'defense' : 'balanced';
      if (next !== m.focus) { m.focus = next; m.focusDays = 0; }
    }
    m.focusDays = Math.min(30, m.focusDays + days);
    m.load = Math.max(0, m.load - TEAM_FOCUS[m.focus].recovery * days);
    m.familiarity = Math.min(100, m.familiarity + 3 * days);
    m.meetingCooldown = Math.max(0, m.meetingCooldown - days);
    m.disciplineDays = Math.max(0, m.disciplineDays - days);
    for (const role of ['head', 'assistant'] as const) m.staffCooldown[role] = Math.max(0, m.staffCooldown[role] - days);
    // Salaries are staff expenses outside the player salary cap; never charge for UI access.
    t.budget -= Math.round(t.coaches!.reduce((sum, c) => sum + c.salary, 0) / 365 * days);
    if (m.focus === 'recovery') for (const id of t.players) {
      const p = s.players[id]; if (p?.position === 'G') p.fatigue = Math.max(0, (p.fatigue ?? 0) - 2 * days);
    }
  }
}
export function recordCoachingResult(t: Team, won: boolean) {
  const m = ensureTeamManagement(t);
  m.load = clamp(m.load + 8, 0, 100);
  const motivation = mean(t.coaches!.map((c) => c.motivation));
  m.trust = clamp(m.trust + (won ? 2 : -2 + (motivation - 65) * 0.035), 20, 95);
  m.cohesion = clamp(m.cohesion + (won ? 1 : -0.5), 30, 95);
}
