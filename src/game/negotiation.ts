import type { Coach, CoachContract, CoachPitch, CoachRole, ContractBonus, GameState, Player, PlayerPitch } from '../types';
import { bonusChance, depthRank, strengthFraction } from './bonuses';
import { seeded, talksKey, TALKS } from './contracts';
import { clamp, formatMoney } from './ratings';

/**
 * The human side of contract talks: how interested a player (or coach) is in the club, what matters most
 * to him, pitches that can win him over, and how he values signing and achievement bonuses.
 */

export type Priority = 'money' | 'winning' | 'role';
export const PRIORITY_LABEL: Record<Priority, string> = { money: 'деньги', winning: 'борьба за трофеи', role: 'игровое время и роль' };
export interface InterestFactor { label: string; value: number }
export interface Interest {
  /** 0..100 */
  score: number;
  level: 'high' | 'mid' | 'low' | 'none';
  /** below the refusal threshold the player will not discuss terms at all */
  refuses: boolean;
  priority: Priority;
  factors: InterestFactor[];
}
export const REFUSE_BELOW = 25;
export const MAX_BONUS_SHARE = 0.5;
export const MAX_SIGNING_SHARE = 0.5;
export const INTEREST_LABEL: Record<Interest['level'], string> = { high: 'Высокий интерес', mid: 'Умеренный интерес', low: 'Слабый интерес', none: 'Не рассматривает ваш клуб' };

const level = (score: number): Interest['level'] => (score < REFUSE_BELOW ? 'none' : score < 45 ? 'low' : score < 70 ? 'mid' : 'high');

/** What the player cares about most: a stable trait, biased by age. */
export function priorityOf(p: Pick<Player, 'id' | 'age'>): Priority {
  const x = seeded(`${p.id}|priority`)();
  if (p.age >= 31) return x < 0.5 ? 'winning' : x < 0.8 ? 'money' : 'role';
  if (p.age <= 24) return x < 0.5 ? 'role' : x < 0.8 ? 'money' : 'winning';
  return x < 0.45 ? 'money' : x < 0.75 ? 'winning' : 'role';
}
const weight = (pr: Priority, k: Priority) => (pr === k ? 1.5 : 0.8);
const groupOf = (p: Player) => (p.position === 'G' ? 'G' : p.position === 'D' ? 'D' : 'F');
const TOP: Record<'F' | 'D' | 'G', number> = { F: 6, D: 4, G: 1 };
const DRESSED: Record<'F' | 'D' | 'G', number> = { F: 12, D: 6, G: 2 };

function confPlace(state: GameState, teamId: string) {
  const t = state.teams[teamId];
  let place = 1;
  for (const id of state.teamOrder) {
    const o = state.teams[id];
    if (o.id !== teamId && o.conference === t.conference && o.record.points > t.record.points) place++;
  }
  return { place, gp: t.record.gp };
}

type TalkState = { key: string; left: number; boost?: number; pitched?: string[]; promise?: boolean; notes?: string[] };
/** Current negotiation window (fresh values once the window changes). */
export function playerTalks(state: GameState, p: Player): TalkState {
  return p.talks && p.talks.key === talksKey(state) ? p.talks : { key: talksKey(state), left: TALKS };
}
function openTalks(state: GameState, p: Player) {
  if (!p.talks || p.talks.key !== talksKey(state)) p.talks = { key: talksKey(state), left: TALKS };
  return p.talks;
}

export function playerInterest(state: GameState, p: Player, teamId: string): Interest {
  const t = state.teams[teamId];
  const priority = priorityOf(p);
  const factors: InterestFactor[] = [];
  const add = (label: string, v: number) => { const value = Math.round(v); if (value) factors.push({ label, value }); };
  if (!t) return { score: 50, level: 'mid', refuses: false, priority, factors };
  const own = p.teamId === teamId;
  const r = strengthFraction(state, teamId);
  add(r <= 0.25 ? 'Один из сильнейших составов лиги' : r >= 0.75 ? 'Слабый состав' : 'Состав середины таблицы', (0.5 - r) * 24 * weight(priority, 'winning'));
  const { place, gp } = confPlace(state, teamId);
  if (gp >= 10) add(place <= 4 ? `${place}-е место в конференции` : place >= 10 ? `${place}-е место в конференции` : '', (place <= 4 ? 5 : place >= 10 ? -5 : 0) * weight(priority, 'winning'));
  const g = groupOf(p), rank = depthRank(state, p, teamId);
  const role = rank < TOP[g] ? 10 : rank < DRESSED[g] - (g === 'F' ? 3 : g === 'D' ? 1 : 0) ? 3 : rank < DRESSED[g] ? -3 : -12;
  add(role >= 10 ? (g === 'G' ? 'Будет основным вратарём' : 'Место в ведущих звеньях') : role > 0 ? 'Стабильное место в составе' : role > -10 ? 'Роль в нижних звеньях' : 'Рискует не попадать в состав', role * weight(priority, 'role'));
  const head = t.coaches?.find((c) => c.role === 'head');
  if (head) add(p.age <= 24 ? `Главный тренер умеет развивать молодых (${head.development})` : `Авторитет главного тренера (${head.motivation})`, ((p.age <= 24 ? head.development : head.motivation) - 65) / 3);
  if (own) {
    add('Привязанность к клубу', 8);
    add(`Мораль ${p.morale}`, (p.morale - 65) / 3);
  }
  add('Личные обстоятельства', (seeded(`${p.id}|${teamId}|fit`)() - 0.5) * 12);
  const talks = playerTalks(state, p);
  if (talks.boost) add('Итоги переговоров', talks.boost);
  const score = clamp(Math.round(50 + factors.reduce((s, f) => s + f.value, 0)), 0, 100);
  return { score, level: level(score), refuses: score < REFUSE_BELOW, priority, factors: factors.filter((f) => f.label) };
}

/** High interest lowers the price, low interest raises it. */
export const interestDemandMult = (score: number) => 1 + (50 - score) * 0.004;

export const PLAYER_PITCHES: Record<PlayerPitch, { label: string; hint: string; cost?: number }> = {
  role: { label: 'Пообещать ведущую роль', hint: 'Первые два звена / пары или место основного вратаря. Обещание проверят в конце регулярки.' },
  ambition: { label: 'Рассказать о целях клуба', hint: 'Сильнее всего действует на тех, кто хочет бороться за трофеи; слабому клубу не поверят.' },
  coach: { label: 'Звонок главного тренера', hint: 'Зависит от авторитета главного тренера.' },
  development: { label: 'Индивидуальный план развития', hint: 'Для игроков до 24 лет: академия и тренер по развитию.' },
  relocation: { label: 'Помощь с переездом', hint: 'Жильё, школа, перелёты семьи — оплачивается сразу из бюджета.', cost: 2_000_000 },
};
export function pitchAvailable(state: GameState, p: Player, pitch: PlayerPitch, teamId: string): string | null {
  if (playerTalks(state, p).pitched?.includes(pitch)) return 'Уже использовано в этих переговорах';
  if (pitch === 'development' && p.age > 24) return 'Только для игроков до 24 лет';
  if (pitch === 'relocation' && p.teamId === teamId) return 'Игрок уже живёт в городе клуба';
  if (pitch === 'relocation' && (state.teams[teamId]?.budget ?? 0) < (PLAYER_PITCHES.relocation.cost ?? 0)) return 'Недостаточно средств';
  return null;
}

/** Use a pitch: changes interest for this negotiation window. Mutates the player (and the budget for relocation). */
export function pitchPlayer(state: GameState, p: Player, teamId: string, pitch: PlayerPitch): { ok: boolean; delta: number; text: string } {
  const why = pitchAvailable(state, p, pitch, teamId);
  if (why) return { ok: false, delta: 0, text: why };
  const t = state.teams[teamId];
  const pr = priorityOf(p);
  const talks = openTalks(state, p);
  let delta = 0, text = '';
  if (pitch === 'role') {
    const g = groupOf(p), rank = depthRank(state, p, teamId);
    if (rank <= TOP[g] - (g === 'G' ? 1 : 0)) {
      delta = Math.round(7 * weight(pr, 'role'));
      talks.promise = true;
      text = `${p.name} верит обещанию: ${g === 'G' ? 'место основного вратаря' : 'роль в ведущих звеньях'} — серьёзный аргумент.`;
    } else {
      delta = -5;
      text = `${p.name} не поверил: в составе слишком много игроков сильнее него.`;
    }
  } else if (pitch === 'ambition') {
    const r = strengthFraction(state, teamId);
    delta = r <= 0.33 ? Math.round(7 * weight(pr, 'winning')) : r <= 0.66 ? Math.round(3 * weight(pr, 'winning')) : -4;
    text = delta > 0 ? `${p.name} оценил амбиции клуба.` : `${p.name} сомневается, что с этим составом можно бороться за Кубок.`;
  } else if (pitch === 'coach') {
    const head = t.coaches?.find((c) => c.role === 'head');
    delta = head ? clamp(Math.round((head.motivation - 58) / 3), -3, 9) : -2;
    text = delta > 0 ? `Разговор с ${head?.name ?? 'тренером'} произвёл впечатление.` : 'Разговор с тренером не помог.';
  } else if (pitch === 'development') {
    const head = t.coaches?.find((c) => c.role === 'head');
    const academy = t.facilities?.academy ?? 1;
    delta = clamp(Math.round(academy * 1.5 + ((head?.development ?? 65) - 62) / 4), 0, 11);
    if (pr === 'role') delta += 2;
    text = delta >= 5 ? `${p.name} впечатлён программой развития.` : `Программа развития не убедила ${p.name}.`;
  } else {
    t.budget -= PLAYER_PITCHES.relocation.cost ?? 0;
    delta = 5;
    text = `Семья ${p.name} благодарна за помощь с переездом.`;
  }
  talks.boost = (talks.boost ?? 0) + delta;
  talks.pitched = [...(talks.pitched ?? []), pitch];
  talks.notes = [...(talks.notes ?? []), text];
  return { ok: true, delta, text };
}

export interface OfferExtras { signingBonus?: number; bonuses?: ContractBonus[] }
/** Bonus limits keep the cap meaningful: achievement bonuses ≤ 50% and the signing bonus ≤ 50% of the salary. */
export function extrasError(salary: number, extras?: OfferExtras): string | null {
  const bonus = (extras?.bonuses ?? []).reduce((s, b) => s + Math.max(0, b.amount), 0);
  if (bonus > salary * MAX_BONUS_SHARE + 1) return `Сумма бонусов за достижения не может превышать 50% оклада (${formatMoney(salary * MAX_BONUS_SHARE)})`;
  if ((extras?.signingBonus ?? 0) > salary * MAX_SIGNING_SHARE + 1) return `Подъёмные не могут превышать 50% годового оклада (${formatMoney(salary * MAX_SIGNING_SHARE)})`;
  if ((extras?.signingBonus ?? 0) < 0 || (extras?.bonuses ?? []).some((b) => b.amount < 0)) return 'Суммы бонусов не могут быть отрицательными';
  return null;
}

/** How the player values bonuses: guaranteed money is worth more than a bonus he may not reach. */
export function extrasValue(state: GameState, p: Player | null, teamId: string, years: number, extras: OfferExtras | undefined, priority: Priority) {
  const signing = (extras?.signingBonus ?? 0) / Math.max(1, years) * (priority === 'money' ? 1.1 : 1);
  const bonuses = (extras?.bonuses ?? []).reduce((s, b) => s + b.amount * Math.min(0.98, bonusChance(state, b, teamId, p) * 1.15) * (priority === 'money' ? 0.95 : 0.85), 0);
  return { signing: Math.round(signing), bonuses: Math.round(bonuses) };
}

/* ------------------------------------------------------------------ coaches */

export const COACH_MAX_YEARS = 3;
export const COACH_PITCHES: Record<CoachPitch, { label: string; hint: string; cost?: number }> = {
  ambition: { label: 'Рассказать о целях клуба', hint: 'Работает, если состав действительно сильный.' },
  authority: { label: 'Гарантировать полномочия', hint: 'Полный контроль над составом. Увольнение обойдётся в 1,5 раза дороже.' },
  project: { label: 'Долгосрочный проект', hint: 'Убедительно только при контракте от 2 лет.' },
  staff: { label: 'Бюджет на штаб', hint: 'Видеоаналитики и специалисты по выбору тренера — сразу из бюджета.', cost: 3_000_000 },
};

type CoachTalk = NonNullable<GameState['coachTalks']>[string];
export function coachTalks(state: GameState, c: Coach): CoachTalk {
  const t = state.coachTalks?.[c.id];
  return t && t.key === talksKey(state) ? t : { key: talksKey(state), left: TALKS };
}
function openCoachTalks(state: GameState, c: Coach): CoachTalk {
  state.coachTalks ??= {};
  const cur = state.coachTalks[c.id];
  if (!cur || cur.key !== talksKey(state)) state.coachTalks[c.id] = { key: talksKey(state), left: TALKS };
  return state.coachTalks[c.id];
}

export function coachInterest(state: GameState, c: Coach, teamId: string, role: CoachRole): Interest {
  const factors: InterestFactor[] = [];
  const add = (label: string, v: number) => { const value = Math.round(v); if (value) factors.push({ label, value }); };
  const t = state.teams[teamId];
  const r = strengthFraction(state, teamId);
  add(r <= 0.25 ? 'Один из сильнейших составов лиги' : r >= 0.75 ? 'Слабый состав' : 'Состав середины таблицы', (0.5 - r) * 24);
  const { place, gp } = confPlace(state, teamId);
  if (gp >= 10 && (place <= 4 || place >= 10)) add(`${place}-е место в конференции`, place <= 4 ? 5 : -5);
  if (c.role === 'head' && role === 'assistant') add('Предлагаете должность ниже его уровня', -22);
  if (c.role === 'assistant' && role === 'head') add('Шанс стать главным тренером', 10);
  if (t) add(t.budget >= 1.5e9 ? 'Богатый клуб' : t.budget < 3e8 ? 'Клуб с финансовыми проблемами' : '', t.budget >= 1.5e9 ? 4 : t.budget < 3e8 ? -6 : 0);
  add('Личные обстоятельства', (seeded(`${c.id}|${teamId}|fit`)() - 0.5) * 12);
  const talks = coachTalks(state, c);
  if (talks.boost) add('Итоги переговоров', talks.boost);
  const score = clamp(Math.round(50 + factors.reduce((s, f) => s + f.value, 0)), 0, 100);
  return { score, level: level(score), refuses: score < REFUSE_BELOW, priority: 'winning', factors: factors.filter((f) => f.label) };
}

const roundMoney = (v: number) => Math.max(500_000, Math.round(v / 100_000) * 100_000);
export function coachAsk(state: GameState, c: Coach, role: CoachRole, years: number, teamId = state.userTeamId): number {
  let v = c.salary * (c.role === 'assistant' && role === 'head' ? 1.25 : 1) * (1 - 0.04 * (clamp(years, 1, COACH_MAX_YEARS) - 1));
  v *= interestDemandMult(coachInterest(state, c, teamId, role).score);
  return roundMoney(v);
}
export function coachFloor(state: GameState, c: Coach, role: CoachRole, years: number, teamId = state.userTeamId): number {
  return Math.round(coachAsk(state, c, role, years, teamId) * (0.86 + 0.1 * seeded(`${c.id}|${talksKey(state)}`)()));
}

export function coachPitchAvailable(state: GameState, c: Coach, pitch: CoachPitch, teamId: string): string | null {
  if (coachTalks(state, c).pitched?.includes(pitch)) return 'Уже использовано в этих переговорах';
  if (pitch === 'staff' && (state.teams[teamId]?.budget ?? 0) < (COACH_PITCHES.staff.cost ?? 0)) return 'Недостаточно средств';
  return null;
}
export function pitchCoach(state: GameState, c: Coach, teamId: string, pitch: CoachPitch, years: number): { ok: boolean; delta: number; text: string } {
  const why = coachPitchAvailable(state, c, pitch, teamId);
  if (why) return { ok: false, delta: 0, text: why };
  const talks = openCoachTalks(state, c);
  let delta = 0, text = '';
  if (pitch === 'ambition') {
    const r = strengthFraction(state, teamId);
    delta = r <= 0.33 ? 8 : r <= 0.66 ? 3 : -4;
    text = delta > 0 ? `${c.name} видит, что с этим составом можно побеждать.` : `${c.name} не верит в амбиции при таком составе.`;
  } else if (pitch === 'authority') {
    delta = 7;
    text = `${c.name} ценит полный контроль над составом. Компенсация при увольнении вырастет в 1,5 раза.`;
  } else if (pitch === 'project') {
    delta = years >= 2 ? 6 : -2;
    text = years >= 2 ? `${c.name} готов строить команду на годы.` : 'Долгосрочный проект с контрактом на год звучит неубедительно.';
  } else {
    state.teams[teamId].budget -= COACH_PITCHES.staff.cost ?? 0;
    delta = 5;
    text = `${c.name} получит своих специалистов в штаб.`;
  }
  talks.boost = (talks.boost ?? 0) + delta;
  talks.pitched = [...(talks.pitched ?? []), pitch];
  talks.notes = [...(talks.notes ?? []), text];
  return { ok: true, delta, text };
}

export interface CoachTerms { salary: number; years: number; signingBonus: number; bonuses: ContractBonus[] }
export interface CoachVerdict { accept: boolean; left: number; tone: 'ok' | 'close' | 'low' | 'insult' | 'closed' | 'refuse'; text: string; counter?: number }

/** The coach's answer. A rejection costs patience; a «close» one comes with a counter-offer. */
export function evaluateCoachOffer(state: GameState, c: Coach, role: CoachRole, terms: CoachTerms, teamId = state.userTeamId): CoachVerdict {
  const cur = coachTalks(state, c);
  if (cur.left <= 0) return { accept: false, left: 0, tone: 'closed', text: `${c.name} прервал переговоры. Вернуться к ним можно ${state.phase === 'offseason' ? 'в следующем сезоне' : 'в межсезонье'}.` };
  const interest = coachInterest(state, c, teamId, role);
  if (interest.refuses) return { accept: false, left: cur.left, tone: 'refuse', text: `${c.name} не рассматривает предложение: ${interest.factors.filter((f) => f.value < 0).map((f) => f.label.toLowerCase()).join(', ') || 'нет интереса к клубу'}.` };
  if (terms.years < 1 || terms.years > COACH_MAX_YEARS) return { accept: false, left: cur.left, tone: 'low', text: `Срок контракта тренера — от 1 до ${COACH_MAX_YEARS} лет.` };
  const err = extrasError(terms.salary, terms);
  if (err) return { accept: false, left: cur.left, tone: 'low', text: err };
  const extra = extrasValue(state, null, teamId, terms.years, terms, 'winning');
  const floor = coachFloor(state, c, role, terms.years, teamId);
  const value = terms.salary + extra.signing + extra.bonuses;
  if (value >= floor) return { accept: true, left: cur.left, tone: 'ok', text: `${c.name} согласен.` };
  const ratio = value / floor;
  const talks = openCoachTalks(state, c);
  talks.left = Math.max(0, talks.left - (ratio < 0.8 ? 2 : 1));
  if (ratio < 0.8) talks.boost = (talks.boost ?? 0) - 4;
  const counter = talks.left > 0 ? roundUp(floor - extra.signing - extra.bonuses) : undefined;
  const tail = talks.left > 0 ? ` Осталось попыток: ${talks.left}.` : ' Тренер прервал переговоры.';
  if (ratio < 0.8) return { accept: false, left: talks.left, tone: 'insult', text: `${c.name} считает предложение несерьёзным.${tail}`, counter };
  return { accept: false, left: talks.left, tone: ratio >= 0.95 ? 'close' : 'low', text: `${c.name} отказал${ratio >= 0.95 ? ', но стороны близки' : ''}.${counter ? ` Встречное предложение: ${formatMoney(counter)} за сезон.` : ''}${tail}`, counter };
}
export const roundUp = (v: number) => Math.max(500_000, Math.ceil(v / 100_000) * 100_000);

/** Compensation for dismissing a coach: half a season's salary per remaining contract year (×1.5 with guaranteed powers). */
export function coachSeverance(c: Coach | undefined): number {
  if (!c) return 0;
  const years = Math.max(1, c.contract?.years ?? 1);
  return Math.round(c.salary * 0.5 * years * (c.contract?.guarantee ? 1.5 : 1));
}
export function coachContractFrom(terms: CoachTerms, guarantee: boolean): CoachContract {
  return { years: terms.years, ...(terms.bonuses.length ? { bonuses: terms.bonuses } : {}), ...(terms.signingBonus > 0 ? { signingBonus: terms.signingBonus } : {}), ...(guarantee ? { guarantee: true } : {}) };
}

/** Promises of a leading role are checked at the end of the regular season. */
export function checkPromises(state: GameState): string[] {
  const t = state.teams[state.userTeamId];
  const out: string[] = [];
  if (!t) return out;
  const L = t.lineup;
  const top = new Set<string>([...(L.F[0] ?? []), ...(L.F[1] ?? []), ...(L.D[0] ?? []), ...(L.D[1] ?? []), L.starterG].filter((x): x is string => !!x));
  for (const id of t.players) {
    const p = state.players[id];
    if (!p?.promise) continue;
    if (p.promise.season > state.seasonNumber) continue;
    if (p.promise.season === state.seasonNumber) {
      if (top.has(id)) { p.morale = clamp(p.morale + 5, 30, 99); out.push(`${p.name}: обещание ведущей роли выполнено (+5 к морали)`); }
      else { p.morale = clamp(p.morale - 15, 30, 99); out.push(`${p.name} недоволен: ему обещали место в ведущих звеньях (−15 к морали)`); }
    }
    delete p.promise;
  }
  return out;
}
