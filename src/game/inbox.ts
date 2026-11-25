import type { GameState } from '../types';
import { restTiredStarter, tradeWindow } from './ai';
import { getCapSummary } from './cap';
import { goalieFreshness } from './chemistry';
import { formatInjuryDays } from './medical';
import { preseasonOpen } from './preseason';
import { ensureScouting, scoutSlots } from './scouting';
import { promiseLabel, promiseProgress } from './dressingRoom';
import { LG } from '../brand';

/**
 * The manager's inbox: everything that needs a decision today, derived from the career state so it
 * can never go stale. Tasks the user dismisses stay hidden until their content changes (the id
 * carries the relevant data).
 */
export type InboxSeverity = 'urgent' | 'warn' | 'info';
export type InboxView = 'dashboard' | 'roster' | 'lines' | 'trades' | 'contracts' | 'club' | 'management' | 'market' | 'inbox';

export interface InboxTask {
  id: string;
  severity: InboxSeverity;
  kind: 'press' | 'event' | 'promise' | 'offer' | 'rfa' | 'lineup' | 'goalie' | 'injury' | 'contract' | 'morale' | 'request' | 'cap' | 'ltir' | 'preseason' | 'deadline' | 'scout' | 'board';
  title: string;
  text: string;
  view: InboxView;
  playerId?: string;
}

const SEV_ORDER: Record<InboxSeverity, number> = { urgent: 0, warn: 1, info: 2 };

export function buildInbox(state: GameState, includeDismissed = false): InboxTask[] {
  const out: InboxTask[] = [];
  const U = state.teams[state.userTeamId];
  if (!U) return out;
  const P = state.players;
  const mine = U.players.map((id) => P[id]).filter(Boolean);
  const today = state.schedule[state.day] ?? [];
  const gameToday = today.find((g) => !g.played && (g.home === U.id || g.away === U.id)) ?? null;

  if (state.press) {
    out.push({ id: `press-${state.press.id}`, severity: 'info', kind: 'press', title: `Пресс-конференция: ${state.press.topic}`, text: state.press.question, view: 'dashboard' });
  }
  for (const e of state.roomEvents ?? []) {
    const left = e.expires - state.day;
    out.push({ id: `event-${e.id}`, severity: 'warn', kind: 'event', title: e.title, text: `${e.text} ${left <= 0 ? 'Ответить нужно сегодня.' : `Ответ ждут ещё ${left + 1} дн.`}`, view: 'dashboard', playerId: e.playerIds[0] });
  }
  for (const pr of state.roomPromises ?? []) {
    const pg = promiseProgress(state, pr);
    if (pg.risk && pr.kind !== 'scratch') out.push({ id: `promise-${pr.id}-${pr.played}`, severity: 'info', kind: 'promise', title: `Обещание под угрозой: ${promiseLabel(state, pr)}`, text: pg.text, view: pr.kind === 'extend' ? 'contracts' : pr.kind === 'callup' ? 'roster' : 'lines', playerId: pr.playerId });
  }
  if (preseasonOpen(state)) {
    const ps = state.preseason!;
    out.push({ id: `preseason-${ps.season}`, severity: 'info', kind: 'preseason', title: `Предсезонка: ${ps.name}`, text: `Август, ${ps.city}. Проверьте звенья и молодёжь до старта сезона — матчи не идут в зачёт.`, view: 'dashboard' });
  }
  for (const o of state.offers) {
    const from = state.teams[o.from];
    const left = o.expires - state.day;
    out.push({
      id: `offer-${o.id}`,
      severity: left <= 1 ? 'urgent' : 'warn',
      kind: 'offer',
      title: `Предложение обмена от «${from?.name ?? o.from}»`,
      text: `Хотят: ${o.get.map((id) => P[id]?.name).join(', ')} · дают: ${o.give.map((id) => P[id]?.name).join(', ')} · ${left <= 0 ? 'истекает сегодня' : `ещё ${left + 1} дн.`}`,
      view: 'trades',
    });
  }
  for (const r of state.rfaOffers ?? []) {
    const p = P[r.playerId];
    out.push({ id: `rfa-${r.id}`, severity: 'urgent', kind: 'rfa', title: `Оффер-шит на ${p?.name ?? 'игрока'}`, text: 'Другой клуб предложил контракт нашему ОСА. Нужно решить: уравнять или получить компенсацию.', view: 'contracts', playerId: r.playerId });
  }
  if (state.phase !== 'offseason') {
    const L = U.lineup;
    const holes = [...L.F.flat(), ...L.D.flat()].filter((x) => !x).length + (L.starterG ? 0 : 1);
    if (holes > 0) out.push({ id: `lineup-${state.seasonNumber}-${holes}`, severity: 'urgent', kind: 'lineup', title: 'Неполный состав на матч', text: `В звеньях ${holes} пустых мест. Заполните состав или вызовите игроков из ВХЛ.`, view: 'lines' });
    const g = L.starterG ? P[L.starterG] : null;
    const fresh = goalieFreshness(g);
    if (gameToday && g && fresh < 62) {
      const b = L.backupG ? P[L.backupG] : null;
      const auto = U.tactics?.autoGoalie !== false && restTiredStarter(L, P);
      if (!auto) out.push({ id: `goalie-${state.day}`, severity: 'warn', kind: 'goalie', title: 'Вратарь устал', text: `${g.name}: свежесть ${fresh}%${b ? `. ${b.name} свеж на ${goalieFreshness(b)}% — может, дать ему матч?` : ''}`, view: 'lines', playerId: g.id });
    }
  }
  for (const p of mine) {
    if (!p.injury || p.injury.daySustained == null || state.day - p.injury.daySustained > 3) continue;
    out.push({
      id: `injury-${p.id}-${p.injury.daySustained}`,
      severity: p.injury.days >= 14 ? 'warn' : 'info',
      kind: 'injury',
      title: `Травма: ${p.name}`,
      text: `${p.injury.name}, ещё ${formatInjuryDays(p.injury.days)}.${p.injury.days >= 14 ? ' Можно перевести в ДСБТ и освободить место под потолком.' : ''}`,
      view: 'roster',
      playerId: p.id,
    });
  }
  const ltir = mine.filter((p) => p.inLtir && !p.injury);
  if (ltir.length) out.push({ id: `ltir-${ltir.map((p) => p.id).join(',')}`, severity: 'warn', kind: 'ltir', title: 'Игроки готовы выйти из ДСБТ', text: ltir.map((p) => p.name).join(', '), view: 'club' });

  const cap = getCapSummary(state, U.id);
  if (cap.over) out.push({ id: `cap-${state.seasonNumber}-${cap.sanctionsActive ? 's' : 'g'}`, severity: 'urgent', kind: 'cap', title: 'Превышен потолок зарплат', text: cap.sanctionsActive ? `Действуют санкции ${LG()}: штрафы и блокировка лидеров.` : `Льготный период: ${cap.graceDaysLeft} дн.`, view: 'contracts' });

  if (state.phase === 'season') {
    const regLen = state.schedule.length;
    const late = state.day >= regLen * 0.55;
    const expiring = mine.filter((p) => p.contract.years <= 1 && !p.contract.next && p.overall >= 70).sort((a, b) => b.overall - a.overall);
    if (late && expiring.length) {
      out.push({
        id: `contracts-${state.seasonNumber}-${expiring.length}`,
        severity: 'warn',
        kind: 'contract',
        title: `Истекают контракты: ${expiring.length}`,
        text: `${expiring.slice(0, 3).map((p) => `${p.name} (${p.overall})`).join(', ')}${expiring.length > 3 ? '…' : ''}. Продлите сейчас, пока игроки не вышли на рынок.`,
        view: 'contracts',
      });
    }
    const w = tradeWindow(state);
    if (w.open && w.daysLeft <= 5 && w.windowId !== 'offseason') {
      out.push({ id: `deadline-${w.windowId}`, severity: 'info', kind: 'deadline', title: `Окно обменов закрывается через ${w.daysLeft} дн.`, text: w.text, view: 'trades' });
    }
  }
  for (const p of mine) {
    if (p.morale < 35 && p.overall >= 68 && !p.inVhl) {
      out.push({ id: `request-${p.id}-${state.seasonNumber}`, severity: 'warn', kind: 'request', title: `${p.name} просит обмен`, text: `Мораль ${p.morale}. Игрок недоволен ролью — поговорите с ним (больше игрового времени) или выставьте на обмен.`, view: 'trades', playerId: p.id });
    }
  }
  const unhappy = mine.filter((p) => p.morale >= 35 && p.morale < 45);
  if (unhappy.length >= 3) out.push({ id: `morale-${state.day >> 3}`, severity: 'info', kind: 'morale', title: `Низкая мораль у ${unhappy.length} игроков`, text: unhappy.slice(0, 4).map((p) => p.name).join(', '), view: 'management' });

  if (state.board && state.board.confidence < 35) out.push({ id: `board-${state.day >> 3}`, severity: 'warn', kind: 'board', title: 'Руководство теряет терпение', text: `Доверие ${state.board.confidence}/100. Задача сезона: ${state.board.text.toLowerCase()}.`, view: 'dashboard' });

  if (state.phase !== 'playoffs') {
    const sc = ensureScouting(state);
    const free = scoutSlots(state) - sc.assignments.length;
    if (free > 0) out.push({ id: `scout-${free}-${state.day >> 4}`, severity: 'info', kind: 'scout', title: `Свободные скауты: ${free}`, text: 'Отправьте скаутов изучать игроков или клубы — рейтинги соперников станут точными.', view: 'trades' });
  }

  const dismissed = state.inboxDismissed ?? {};
  return out
    .filter((t) => includeDismissed || dismissed[t.id] === undefined)
    .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
}

/** Tasks that should stop fast simulation: they need a decision before time moves on. */
export const blockingTasks = (state: GameState) => buildInbox(state).filter((t) => t.severity === 'urgent' || t.kind === 'offer' || t.kind === 'request' || t.kind === 'event');

export function dismissInboxTask(state: GameState, id: string) {
  state.inboxDismissed ??= {};
  state.inboxDismissed[id] = state.day;
  // Old entries are never needed again.
  for (const k in state.inboxDismissed) if (state.inboxDismissed[k] < state.day - 60) delete state.inboxDismissed[k];
}
