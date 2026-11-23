import { useState } from 'react';
import { talksLeft, askingSalary } from '../game/contracts';
import { formatMoney, isGoalie } from '../game/ratings';
import { TRAINING_PLANS } from '../game/training';
import { getArchetype } from '../game/chemistry';
import { currentDraftTeamId } from '../game/dynasty';
import { isRfaEligibleAge, qualifyingOfferSalary } from '../game/khlRules';
import { finishJuniorDraftAuto, letGo, pickJuniorProspect, respondRfaOfferSheet, simulateToNextUserGame, startNewSeason, tenderQualifyingOffer, useGame } from '../game/state';
import { nextUserGame } from '../game/schedule';
import { Button, Empty, Panel, PosBadge, Tag, TeamLogo, useUI } from './ui';
import { ScoutOvr } from './Scout';
import { cn } from '../utils/cn';

function nextLabel(s: string): string {
  const m = /^(\d{4})\/(\d{2})$/.exec(s);
  if (!m) return '';
  const y = parseInt(m[1], 10) + 1;
  return `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
}

export function Offseason() {
  const s = useGame()!;
  const ui = useUI();
  const P = s.players;
  const U = s.teams[s.userTeamId];
  const plan = s.offseason;
  const summary = s.summaries[s.summaries.length - 1];
  const [offNotice, setOffNotice] = useState<string | null>(null);
  const [draftPos, setDraftPos] = useState<'ALL' | 'F' | 'D' | 'G'>('ALL');
  if (!plan) {
    // Reached before the season is over (e.g. the club has no games left but others still play).
    const userHasGames = !!nextUserGame(s, U.id);
    const finish = () => {
      if (simulateToNextUserGame() !== 'offseason') ui.nav('dashboard');
    };
    return (
      <Panel>
        <div className="space-y-3 py-2" data-offseason-pending>
          <div className="text-sm text-text/90">
            {s.phase === 'playoffs' ? 'Межсезонье начнётся после финала Кубка Гагарина.' : 'Межсезонье начнётся после регулярного чемпионата и плей-офф.'}
            {userHasGames ? ' У вашей команды ещё есть матчи.' : ' Ваша команда свои матчи уже сыграла.'}
          </div>
          <div className="flex flex-wrap gap-2">
            {userHasGames ? (
              <Button variant="primary" onClick={() => ui.nav('dashboard')}>К ближайшему матчу</Button>
            ) : (
              <Button variant="primary" onClick={finish}>Досимулировать сезон и перейти в межсезонье</Button>
            )}
          </div>
        </div>
      </Panel>
    );
  }
  const expiring = plan.expiring.map((id) => P[id]).filter(Boolean);
  const progressions = plan.progressions.filter((x) => P[x.id] && P[x.id].teamId === U.id);
  const ups = progressions.filter((x) => x.to > x.from);
  const downs = progressions.filter((x) => x.to < x.from);
  const draft = plan.draft;
  const retired = plan.retired ?? [];
  const onClockTeamId = draft ? currentDraftTeamId(draft) : null;
  const isUserPick = onClockTeamId === U.id;
  const totalPicks = draft ? draft.rounds * draft.order.length : 0;
  const roundSize = Math.max(1, draft?.order.length ?? Object.keys(s.teams).length);
  const curRound = draft ? Math.floor(draft.pickIndex / roundSize) + 1 : 1;
  const pickedIds = new Set((draft?.picks ?? []).map((pk) => pk.playerId));
  const availableProspects = (draft?.prospects ?? []).filter((pr) => {
    if (pickedIds.has(pr.id)) return false;
    const jp = P[pr.id];
    if (!jp) return false;
    if (draftPos === 'ALL') return true;
    if (draftPos === 'G') return isGoalie(jp);
    if (draftPos === 'D') return jp.position === 'D';
    return jp.position !== 'D' && !isGoalie(jp);
  });
  const begin = () => {
    const go = () => {
      startNewSeason();
      ui.nav('dashboard');
    };
    if (expiring.length) ui.confirm({ title: 'Начать новый сезон?', text: `Игроки с истёкшими контрактами (${expiring.length}) без нового соглашения уйдут на рынок свободных агентов.`, confirmLabel: 'Начать сезон', onYes: go });
    else go();
  };
  const net = (summary?.revenue ?? 0) - (summary?.payroll ?? 0) + (summary?.boardBonus ?? 0);
  return (
    <div className="space-y-4 fade-in">
      {summary && (
        <Panel title={`Итоги сезона ${summary.season}`} right={<Tag color="#F2B544">{summary.userResult}</Tag>}>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="bg-panel2/70 border border-line/70 rounded-sm p-3">
              <div className="text-[11px] uppercase tracking-wider text-muted">Обладатель Кубка Гагарина</div>
              <div className="flex items-center gap-2 mt-1">
                <TeamLogo team={s.teams[summary.champion]} size={30} />
                <span className="font-display text-lg">{s.teams[summary.champion].name}</span>
              </div>
              {s.playoffs?.mvp && <div className="text-xs text-amber mt-1">MVP плей-офф: {P[s.playoffs.mvp]?.name}</div>}
            </div>
            <div className="bg-panel2/70 border border-line/70 rounded-sm p-3">
              <div className="text-[11px] uppercase tracking-wider text-muted">Ваш результат</div>
              <div className="font-display text-lg mt-1">
                {summary.userPoints} очков · {summary.userPlace}-е место
              </div>
              {summary.board && <div className={cn('text-xs mt-1', s.board.last?.verdict === 'failed' ? 'text-accent' : 'text-ok')}>{summary.board}</div>}
              <div className="text-[11px] text-muted mt-1">Доверие руководства: {s.board.confidence} из 100</div>
            </div>
            <div className="bg-panel2/70 border border-line/70 rounded-sm p-3 text-sm">
              <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Финансы сезона</div>
              {summary.revenue != null ? (
                <div className="space-y-0.5 tabular">
                  <div className="flex justify-between">
                    <span className="text-muted">Доходы</span>
                    <span className="text-ok">+{formatMoney(summary.revenue)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Зарплаты</span>
                    <span className="text-accent">−{formatMoney(summary.payroll ?? 0)}</span>
                  </div>
                  {!!summary.boardBonus && (
                    <div className="flex justify-between">
                      <span className="text-muted">{summary.boardBonus > 0 ? 'Премия от руководства' : 'Урезание бюджета'}</span>
                      <span className={summary.boardBonus > 0 ? 'text-ok' : 'text-accent'}>{summary.boardBonus > 0 ? '+' : '−'}{formatMoney(Math.abs(summary.boardBonus))}</span>
                    </div>
                  )}
                  <div className="flex justify-between border-t border-line/60 pt-1 mt-1 font-semibold">
                    <span>Итог</span>
                    <span className={net >= 0 ? 'text-ok' : 'text-accent'}>{net >= 0 ? '+' : '−'}{formatMoney(Math.abs(net))}</span>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-muted">Доход по итогам сезона зачислен в бюджет.</div>
              )}
            </div>
          </div>
          {summary.awards.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-3">
              {summary.awards.map((a) => (
                <div key={a.title} className="bg-panel2/70 border border-line/70 rounded-sm p-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted">{a.title}</div>
                  <div className="text-sm font-semibold truncate">{P[a.player]?.name}</div>
                  <div className="text-xs text-muted">
                    {s.teams[a.team]?.short} · <span className="text-amber tabular">{a.value}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      {offNotice && (
        <div className="rounded-md border border-ice/40 bg-ice/10 px-3 py-2 text-xs text-ice">{offNotice}</div>
      )}

      {(s.rfaOffers ?? []).length > 0 && (
        <Panel title="⚡ Оффершиты КХЛ по вашим ограниченно свободным агентам (ОСА)" className="border-gold/50">
          <div className="space-y-2">
            {(s.rfaOffers ?? []).map((os) => {
              const op = P[os.playerId];
              const fromT = s.teams[os.fromTeamId];
              if (!op) return null;
              return (
                <div key={os.id} className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-line bg-panel2/70 px-3 py-2 text-xs">
                  <div>
                    <b>{fromT?.name}</b> предложил вашему ОСА <b>{op.name}</b> ({op.age} л., OVR {op.overall}) контракт{' '}
                    <b className="text-gold">{formatMoney(os.salary)} × {os.years} г.</b> Компенсация за права:{' '}
                    <b className="text-ok">+{formatMoney(os.compensation)}</b>.
                  </div>
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        const err = respondRfaOfferSheet(os.id, true);
                        setOffNotice(err ?? `Оффершит повторён — ${op.name} остаётся в клубе!`);
                      }}
                    >
                      Повторить контракт
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        const err = respondRfaOfferSheet(os.id, false);
                        setOffNotice(err ?? `Получена компенсация ${formatMoney(os.compensation)} за права ОСА ${op.name}.`);
                      }}
                    >
                      Отпустить за {formatMoney(os.compensation)}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {draft && (
        <Panel
          title={`Ярмарка юниоров КХЛ и Выпуск Академии МХЛ · ${s.league.season}`}
          data-junior-draft
          right={
            <div className="flex items-center gap-2 flex-wrap">
              {draft.completed ? (
                <Tag tone="good">Ярмарка завершена ({draft.picks.length} выборов)</Tag>
              ) : (
                <>
                  <Tag tone={isUserPick ? 'warn' : 'accent'}>
                    Раунд {curRound} · Пик #{draft.pickIndex + 1}/{totalPicks} ({s.teams[onClockTeamId!]?.short})
                  </Tag>
                  <Button size="sm" variant="secondary" onClick={() => finishJuniorDraftAuto()}>
                    Автовыбор до конца
                  </Button>
                </>
              )}
            </div>
          }
        >
          {!draft.completed && isUserPick && (
            <div className="mb-3 rounded-md border border-gold/60 bg-gold/15 px-3 py-2 text-xs text-gold font-semibold">
              🎯 Сейчас выбор вашего клуба ({U.name})! Выберите лучшего 17–19-летнего проспекта МХЛ на двусторонний контракт новичка (лимитчик U20).
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs text-muted">Доступные юниоры скаутского бюро ({availableProspects.length})</span>
                <div className="flex gap-1">
                  {(['ALL', 'F', 'D', 'G'] as const).map((k) => (
                    <button
                      key={k}
                      onClick={() => setDraftPos(k)}
                      className={cn(
                        'text-[11px] px-2 py-0.5 rounded-sm font-semibold cursor-pointer',
                        draftPos === k ? 'bg-accent text-white' : 'bg-panel2 text-muted hover:text-text'
                      )}
                    >
                      {k === 'ALL' ? 'Все' : k === 'F' ? 'Нап' : k === 'D' ? 'Защ' : 'Вр'}
                    </button>
                  ))}
                </div>
              </div>

              {draft.completed ? (
                <Empty text="Все раунды Ярмарки юниоров КХЛ проведены. Выбранные новички уже зачислены в систему клубов!" />
              ) : (
                <div className="max-h-72 overflow-y-auto divide-y divide-line/60 border border-line/70 rounded-sm">
                  {availableProspects.slice(0, 28).map((pr, idx) => {
                    const jp = P[pr.id];
                    if (!jp) return null;
                    const arch = getArchetype(jp);
                    const gradeTone =
                      pr.tag === 'Топ-проспект'
                        ? 'warn'
                        : pr.tag === 'Готов к КХЛ'
                          ? 'good'
                          : pr.tag === 'Тёмная лошадка'
                            ? 'accent'
                            : 'muted';
                    return (
                      <div key={pr.id} className="px-3 py-2 flex items-center justify-between gap-2 text-xs hover:bg-panel2/60">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-muted font-display w-6">#{idx + 1}</span>
                            <PosBadge pos={jp.position} />
                            <button onClick={() => ui.openPlayer(jp.id)} className="font-semibold text-sm truncate hover:text-ice text-left">
                              {jp.name}
                            </button>
                            <span className="text-muted">{jp.age} л. · {jp.country}</span>
                            <Tag tone={gradeTone}>{pr.tag}</Tag>
                            <span className="text-[10px] px-1 rounded bg-panel2" style={{ color: arch.color }}>
                              {arch.short}
                            </span>
                          </div>
                          <div className="text-[11px] text-muted mt-0.5 pl-7">
                            Школа: {pr.school} · Оценка скаута: <b>{pr.grade}</b> · Прогноз потенциала: {pr.potRange[0]}–{pr.potRange[1]}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <ScoutOvr p={jp} />
                          {isUserPick && (
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={() => {
                                const picked = pickJuniorProspect(pr.id);
                                if (picked) setOffNotice(`В систему клуба выбран юниор ${picked}!`);
                              }}
                            >
                              Выбрать
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <div className="text-xs text-muted mb-1.5">Ход Ярмарки ({draft.picks.length} выбрано)</div>
              {draft.picks.length === 0 ? (
                <Empty text="Пока не сделано ни одного выбора" />
              ) : (
                <ul className="max-h-72 overflow-y-auto divide-y divide-line/50 border border-line/70 rounded-sm text-xs">
                  {[...draft.picks].reverse().map((pk) => {
                    const t = s.teams[pk.teamId];
                    const pp = P[pk.playerId];
                    const mine = pk.teamId === U.id;
                    return (
                      <li key={pk.overallPick} className={cn('px-2.5 py-1.5 flex items-center gap-2', mine && 'bg-gold/10')}>
                        <span className="text-muted tabular w-7">#{pk.overallPick}</span>
                        {t && <TeamLogo team={t} size={18} />}
                        {pp && <PosBadge pos={pp.position} />}
                        <button
                          onClick={() => pp && ui.openPlayer(pk.playerId)}
                          className={cn('truncate flex-1 text-left hover:text-ice', mine && 'font-semibold text-gold')}
                        >
                          {pp?.name ?? pk.playerId}
                        </button>
                        <span className="font-display tabular text-ice">{pp?.overall ?? '—'}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </Panel>
      )}

      {retired.length > 0 && (
        <Panel title={`Завершение карьеры ветеранов (${retired.length})`} right={<Tag tone="warn">Выведено номеров: {retired.filter((r) => r.jerseyRetired).length}</Tag>}>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2 text-xs">
            {retired.slice(0, 12).map((ret) => {
              const rt = ret.teamId ? s.teams[ret.teamId] : null;
              return (
                <div
                  key={ret.id}
                  className={cn(
                    'rounded-sm border px-3 py-2 flex items-center justify-between gap-2',
                    ret.jerseyRetired ? 'border-gold/50 bg-gold/10' : 'border-line bg-panel2/50'
                  )}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <PosBadge pos={ret.position} />
                      <span className="font-semibold truncate">{ret.name}</span>
                      {ret.jerseyRetired && <Tag tone="warn">★ №{ret.number} в Зале славы</Tag>}
                    </div>
                    <div className="text-[11px] text-muted">
                      {rt ? rt.short : ret.teamName} · {ret.age} лет · {ret.gp} И ({ret.position === 'G' ? `${ret.wins} поб.` : `${ret.goals + ret.assists} О`})
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel title="Изменение рейтинга игроков" right={<span className="text-xs text-muted">↑ {ups.length} · ↓ {downs.length}</span>}>
          {progressions.length === 0 ? (
            <Empty text="Без изменений" />
          ) : (
            <ul className="divide-y divide-line/60 text-sm max-h-[420px] overflow-y-auto">
              {[...progressions]
                .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))
                .map((x) => {
                  const p = P[x.id];
                  const d = x.to - x.from;
                  return (
                    <li key={x.id} className="flex items-center gap-2 py-1.5">
                      <PosBadge pos={p.position} />
                      <button className="flex-1 truncate text-left hover:text-ice" onClick={() => ui.openPlayer(x.id)}>
                        {p.name}
                      </button>
                      {x.plan && TRAINING_PLANS[x.plan] && (
                        <Tag tone="accent">{TRAINING_PLANS[x.plan].short}</Tag>
                      )}
                      <span className="text-xs text-muted">{p.age} л.</span>
                      <span className="font-display tabular">
                        {x.from} → <span className={d > 0 ? 'text-ok' : 'text-accent'}>{x.to}</span>
                      </span>
                      <span className={cn('text-xs tabular', d > 0 ? 'text-ok' : 'text-accent')}>{d > 0 ? `+${d}` : d}</span>
                    </li>
                  );
                })}
            </ul>
          )}
        </Panel>

        <Panel title="Истёкшие контракты" right={<Tag color="#F2B544">{expiring.length}</Tag>}>
          {expiring.length === 0 ? (
            <Empty text="Все игроки состава под контрактом" />
          ) : (
            <ul className="divide-y divide-line/60 text-sm max-h-[420px] overflow-y-auto" data-expiring>
              {expiring.map((p) => {
                const left = talksLeft(s, p);
                const isRfa = isRfaEligibleAge(p.age);
                return (
                  <li key={p.id} className="py-2 flex items-center gap-2 flex-wrap">
                    <PosBadge pos={p.position} />
                    <button className="flex-1 min-w-[120px] truncate text-left hover:text-ice" onClick={() => ui.openPlayer(p.id)}>
                      {p.name}
                    </button>
                    <span className={cn('text-[10px] font-semibold px-1 rounded', isRfa ? 'bg-ice/20 text-ice' : 'bg-panel2 text-muted')}>
                      {isRfa ? 'ОСА' : 'НСА'}
                    </span>
                    <span className="text-xs text-muted">{p.age} л.</span>
                    <ScoutOvr p={p} />
                    <span className="text-xs text-muted tabular whitespace-nowrap">запрос {formatMoney(askingSalary(s, p, 1, U.id))}</span>
                    {isRfa && (
                      <Button
                        size="sm"
                        variant="secondary"
                        title={`Квалификационное предложение на 1 год (${formatMoney(qualifyingOfferSalary(p))}) или сохранение прав ОСА`}
                        onClick={() => {
                          const err = tenderQualifyingOffer(p.id);
                          setOffNotice(err ?? `Квалификационное предложение сделано — права ОСА на ${p.name} закреплены!`);
                        }}
                      >
                        КП (ОСА)
                      </Button>
                    )}
                    <Button size="sm" variant="primary" disabled={left <= 0} onClick={() => ui.negotiate(p.id)}>
                      {left <= 0 ? 'Отказ' : 'Переговоры'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => letGo(p.id)}>
                      Отпустить
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="text-[11px] text-muted mt-3">Все условия и продления — в разделе «Контракты». Окно обменов в межсезонье открыто.</div>
        </Panel>
      </div>

      <Panel title="Трофеи клуба">
        {s.trophies.length === 0 ? (
          <div className="text-sm text-muted">Пока пусто. Кубок Гагарина и Кубок Континента ждут.</div>
        ) : (
          <div className="flex gap-2 flex-wrap">
            {s.trophies.map((t, i) => (
              <Tag key={i} color="#F2B544">
                {t.title} · {t.season}
              </Tag>
            ))}
          </div>
        )}
      </Panel>

      <div className="sticky bottom-16 lg:bottom-4 z-10">
        <div className="bg-panel2/95 backdrop-blur border border-line rounded-md p-3 flex items-center justify-between gap-4 shadow-xl flex-wrap">
          <div className="text-sm text-muted flex-1 min-w-[220px]">
            Сезон {s.league.season} завершён. {expiring.length ? `Осталось решить судьбу ${expiring.length} игроков с истёкшими контрактами.` : 'Состав готов к новому сезону.'} Свободные агенты — в разделе «Рынок».
          </div>
          <Button variant="primary" size="lg" onClick={begin}>
            Начать сезон {nextLabel(s.league.season)}
          </Button>
        </div>
      </div>
    </div>
  );
}
