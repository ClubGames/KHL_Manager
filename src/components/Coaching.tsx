import { useState } from 'react';
import type { Coach, CoachRole, Team, TeamFocus, TeamIntervention } from '../types';
import { COACH_PROFILES, COACH_ROLE_LABEL } from '../game/coachData';
import { coachingEffects, INTERVENTIONS, recentTeamForm, TEAM_FOCUS } from '../game/coaching';
import { formatMoney, mean } from '../game/ratings';
import { fireUserCoach, holdTeamMeeting, setUserTeamFocus, useGame } from '../game/state';
import { Button, Panel, Stat, Tag, useUI } from './ui';
import { CoachNegotiationModal } from './Negotiation';
import { coachAsk, coachInterest, coachSeverance, INTEREST_LABEL } from '../game/negotiation';
import { bonusText } from '../game/bonuses';

const signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;
function CoachCard({ coach, market = false }: { coach: Coach; market?: boolean }) {
  return <div className="rounded-md border border-line bg-panel2/60 p-3 space-y-2" data-coach={coach.id}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><div className="text-[11px] text-muted uppercase">{market ? 'Свободный тренер' : coach.acting ? 'И. о. главного тренера' : COACH_ROLE_LABEL[coach.role]}</div><div className="font-display text-lg">{coach.name}</div></div>
      <Tag color="#8FD8F0">{coach.label ?? COACH_PROFILES[coach.profile].label}</Tag>
    </div>
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
      {([['attack', 'Атака'], ['defense', 'Оборона'], ['special', 'Спецбригады'], ['development', 'Развитие'], ['motivation', 'Мотивация']] as const).map(([key, label]) =>
        <div key={key}><span className="text-muted">{label} </span><b className="tabular">{coach[key]}</b></div>)}
    </div>
    {!market && coach.contract && <div className="text-[11px] text-muted" data-coach-contract>Контракт: {coach.contract.years ? `ещё ${coach.contract.years} г.` : 'продлевается ежегодно'}{coach.contract.guarantee ? ' · гарантия полномочий' : ''}{coach.contract.bonuses?.length ? ` · бонусы: ${coach.contract.bonuses.map((b) => `${bonusText(b)} — ${formatMoney(b.amount)}`).join(', ')}` : ''}</div>}
    <div className="flex justify-between gap-2 text-xs text-muted"><span>{formatMoney(coach.salary)}/год</span>
      {coach.source && <a href={coach.source} target="_blank" rel="noreferrer" className="text-ice hover:underline">Источник ↗</a>}
    </div>
  </div>;
}

export function StaffSummary({ team }: { team: Team }) {
  const ui = useUI(); const s = useGame()!;
  return <Panel title="Тренерский штаб" right={team.id === s.userTeamId ? <Button size="sm" onClick={() => ui.nav('management')}>Управление командой →</Button> : undefined}>
    <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm" data-staff-summary>
      {(team.coaches ?? []).map((c) => <div key={c.role}><span className="text-muted text-xs">{c.acting ? 'И. о. главного тренера' : COACH_ROLE_LABEL[c.role]}: </span><b>{c.name}</b> <span className="text-xs text-ice">{c.label ?? COACH_PROFILES[c.profile].label}</span></div>)}
    </div>
  </Panel>;
}

export function Coaching() {
  const s = useGame()!; const ui = useUI(); const t = s.teams[s.userTeamId];
  const m = t.management; const effects = coachingEffects(t, s.players); const form = recentTeamForm(s, t.id);
  const [tab, setTab] = useState<'staff' | 'preparation'>('staff');
  const [role, setRole] = useState<CoachRole>('head');
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [talk, setTalk] = useState<{ id: string; role: CoachRole } | null>(null);
  if (!m) return null;
  const morale = mean(t.players.map((id) => s.players[id]).filter((p) => p && !p.inVhl).map((p) => p.morale));
  const result = (error: string | null, success: string) => setNotice({ ok: !error, text: error ?? success });
  const hints: string[] = [];
  if (m.load > 60) hints.push('Высокая нагрузка снижает игровые рейтинги. Дайте восстановление и ротируйте вратаря.');
  if (morale < 55 || m.trust < 45) hints.push('Команде не хватает уверенности: поддержка сейчас полезнее жёсткого разбора.');
  if (form.played >= 5 && form.gf < form.played * 2) hints.push('Меньше двух заброшенных за матч: попробуйте атакующий цикл или специалиста по атаке.');
  if (form.played >= 5 && form.ga > form.played * 3) hints.push('Больше трёх пропущенных за матч: оборонительная подготовка и разбор помогут сократить риск.');
  if (m.familiarity < 80) hints.push('Новый штаб ещё адаптируется. Частые перестановки снова замедлят освоение системы.');
  const staffPay = (t.coaches ?? []).reduce((sum, c) => sum + c.salary, 0);

  return <div className="space-y-4" data-coaching-hub>
    {talk && <CoachNegotiationModal key={`${talk.id}-${talk.role}`} coachId={talk.id} role={talk.role} onClose={() => setTalk(null)} onSigned={(text) => setNotice({ ok: true, text })} />}
    <Panel title="Управление командой" right={<Tag tone={form.crisis ? 'bad' : 'good'}>{form.played ? `${form.wins} побед / ${form.played} матчей` : 'Начало сезона'}</Tag>}>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Мораль / доверие штабу" value={`${Math.round(morale)} / ${Math.round(m.trust)}`} sub="Влияют на атаку и оборону" />
        <Stat label="Нагрузка команды" value={`${Math.round(m.load)} / 100`} sub="Каждый матч +8; штраф выше 50" color={m.load > 60 ? '#E5323E' : '#3FCF8E'} />
        <Stat label="Сплочённость" value={`${Math.round(m.cohesion)} / 100`} sub="Победы и мероприятия укрепляют связи" />
        <Stat label="Освоение системы" value={`${Math.round(m.familiarity)}%`} sub="+3 в календарный день после смены штаба" />
      </div>
      <div className="mt-4 p-3 rounded border border-line bg-panel2/50 text-xs leading-relaxed">
        <b>{form.crisis ? 'Кризис результатов. ' : 'Последние восемь матчей. '}</b>
        {form.played ? `${form.wins} побед, ${form.losses} поражений; шайбы ${form.gf}:${form.ga}. ` : 'Для диагностики сначала сыграйте несколько матчей. '}

        {hints.length > 0 && <ul className="mt-2 space-y-1 list-disc pl-4">{hints.map((hint) => <li key={hint}>{hint}</li>)}</ul>}
      </div>
      <div className="flex flex-wrap gap-2 mt-3 text-xs" data-coaching-effects>
        <Tag>Атака {signed(effects.attack)}</Tag><Tag>Оборона {signed(effects.defense)}</Tag>
        <Tag>Спецбригады {signed(effects.special * 100)}%</Tag><Tag>Развитие U23 ×{effects.development.toFixed(2)}</Tag>
        <Tag>Вратарь {signed(effects.goalie)}</Tag>
      </div>
      <details className="text-[11px] text-muted mt-2"><summary className="cursor-pointer">Как работает штаб</summary><p>Суммарные модификаторы к игровым рейтингам: штаб (65% главный / 35% ассистент), мораль, доверие, сплочённость, нагрузка, адаптация и подготовка. Одинаково для просмотра и быстрой симуляции. Бонус спецбригад повышает качество бросков в большинстве и снижает его у соперника в вашем меньшинстве.</p></details>
    </Panel>

    {notice && <div role="status" className={`border rounded p-3 text-sm ${notice.ok ? 'border-ok/50 text-ok bg-ok/10' : 'border-accent/50 text-accent bg-accent/10'}`}>{notice.text}</div>}

    <div className="flex flex-wrap gap-2" role="tablist" aria-label="Управление командой">
      <Button role="tab" aria-selected={tab === 'staff'} variant={tab === 'staff' ? 'ice' : 'secondary'} onClick={() => setTab('staff')}>Штаб и рынок</Button>
      <Button role="tab" aria-selected={tab === 'preparation'} variant={tab === 'preparation' ? 'ice' : 'secondary'} onClick={() => setTab('preparation')}>Подготовка и раздевалка</Button>
    </div>
    {tab === 'preparation' && <>
    <Panel title="Командная подготовка" right={<Tag>{TEAM_FOCUS[m.focus].label} · {Math.min(3, m.focusDays)}/3 дн.</Tag>}>
      <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-2">
        {(Object.entries(TEAM_FOCUS) as [TeamFocus, typeof TEAM_FOCUS[TeamFocus]][]).map(([key, def]) => <button type="button" key={key} aria-pressed={key === m.focus}
          onClick={() => { if (key !== m.focus) result(setUserTeamFocus(key), `Выбран план «${def.label}». Подготовка начинается заново.`); }}
          className={`rounded border p-3 text-left transition-colors ${key === m.focus ? 'border-ice bg-ice/10' : 'border-line bg-panel2/50 hover:border-muted'}`}>
          <div className="font-display uppercase text-sm">{def.label}</div><p className="text-xs text-muted mt-2">{def.description}</p>
        </button>)}
      </div>
      <p className="text-xs text-muted mt-3">Бонус нарастает за 3 календарных дня. Смена плана обнуляет подготовку. Восстановление снижает нагрузку сразу при смене дня, но не лечит травмы. Выбранный план сохраняется, пока вы его не измените.</p>
    </Panel>

    <Panel title="Работа с раздевалкой" right={<Tag>{m.meetingCooldown > 0 ? `Следующее собрание через ${Math.ceil(m.meetingCooldown)} дн.` : 'Команда готова к разговору'}</Tag>}>
      <div className="grid md:grid-cols-3 gap-3">
        {(Object.entries(INTERVENTIONS) as [TeamIntervention, typeof INTERVENTIONS[TeamIntervention]][]).map(([key, def]) => <div key={key} className="rounded border border-line bg-panel2/50 p-3 flex flex-col gap-3">
          <div className="font-display uppercase">{def.label}</div><p className="text-xs text-muted flex-1">{def.description}</p>
          <Button size="sm" disabled={s.phase === 'offseason' || m.meetingCooldown > 0 || t.budget < def.cost || (key === 'demand' && m.trust < 45)} onClick={() => ui.confirm({
            title: def.label, text: `${def.description} Стоимость: ${formatMoney(def.cost)}.`, confirmLabel: 'Провести',
            onYes: () => result(holdTeamMeeting(key), 'Решение принято. Изменения показателей уже учтены.'),
          })}>{def.cost ? formatMoney(def.cost) : 'Провести бесплатно'}</Button>
        </div>)}
      </div>
      {m.disciplineDays > 0 && <p className="text-xs text-ice mt-3">Видеоразбор: +2 к обороне ещё {Math.ceil(m.disciplineDays)} дн.</p>}
      {m.lastAction && <p className="text-xs text-muted mt-3">Последнее решение: {m.lastAction}</p>}
    </Panel>

    </>}
    {tab === 'staff' && <>
    <Panel title="Тренерский штаб" right={<span className="text-xs text-muted">{formatMoney(staffPay)}/год вне потолка игроков</span>}>
      <div className="grid md:grid-cols-2 gap-3">{(['head', 'assistant'] as const).map(r => {
        const coach = t.coaches?.find(c => c.role === r);
        return <div key={r} className="space-y-2">{coach ? <><CoachCard coach={coach} /><Button size="sm" variant="ghost" onClick={() => ui.confirm({
          title: `Уволить ${coach.name}?`, danger: true, confirmLabel: 'Уволить',
          text: `Компенсация: ${formatMoney(coachSeverance(coach))}${coach.contract?.years ? ` (контракт ещё на ${coach.contract.years} г.${coach.contract.guarantee ? ', гарантия полномочий' : ''})` : ''}.${r === 'head' ? ' Ассистент станет и. о. главного до нового назначения.' : ''}`,
          onYes: () => result(fireUserCoach(r), 'Тренер уволен.'),
        })}>Уволить</Button></> : <div className="rounded-md border border-dashed border-line p-4 text-sm text-muted">{COACH_ROLE_LABEL[r]} · вакансия</div>}</div>;
      })}</div>
    </Panel>

    <Panel title="Рынок тренеров" right={<span className="text-xs text-muted">Бюджет: {formatMoney(t.budget)}</span>}>
      <div className="text-xs text-muted mb-2">Должность при подписании</div>
      <div className="flex flex-wrap gap-2 mb-3">{(['head', 'assistant'] as const).map((r) => <Button key={r} size="sm" variant={role === r ? 'ice' : 'secondary'} onClick={() => setRole(r)}>{COACH_ROLE_LABEL[r]}</Button>)}</div>
      <details className="text-xs text-muted mb-3"><summary className="cursor-pointer">Условия назначения</summary><p className="mt-2">Условия обсуждаются в переговорах: срок 1–3 года, любая зарплата, подъёмные и бонусы за результат команды. Тренер может отказаться — например, если должность ниже его уровня или состав слабый. Уходящему тренеру — половина зарплаты за каждый оставшийся год контракта. Зарплата списывается каждый календарный день (1/365). Замена главного сбросит освоение системы до 40%, ассистента — не выше 70%. Повторная замена на той же должности — через 30 дней. Мораль автоматически не повышается. Вакансию или пост и. о. можно заполнить сразу.</p></details>
      {m.staffCooldown[role] > 0 && t.coaches?.some(c => c.role === role && !c.acting) && <p className="text-xs text-gold mb-3">Следующая замена на этой должности через {Math.ceil(m.staffCooldown[role])} дн.</p>}
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
        {(s.coachMarket ?? []).map((coach) => {
          const cooldown = m.staffCooldown[role] > 0 && !!t.coaches?.some(c => c.role === role && !c.acting);
          const interest = coachInterest(s, coach, t.id, role);
          return <div key={coach.id} className="space-y-2"><CoachCard coach={coach} market />
            <div className="flex items-center justify-between gap-2 text-[11px]"><span className="text-muted">Запрос: {formatMoney(coachAsk(s, coach, role, 2))}/год</span><span className={interest.refuses ? 'text-accent' : interest.level === 'high' ? 'text-ok' : 'text-muted'}>{INTEREST_LABEL[interest.level]}</span></div>
            <Button size="sm" className="w-full" disabled={cooldown} onClick={() => setTalk({ id: coach.id, role })}>Переговоры: {COACH_ROLE_LABEL[role]}</Button>
          </div>;
        })}
      </div>
    </Panel>
    </>}
  </div>;
}
