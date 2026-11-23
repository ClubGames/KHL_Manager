import { Coaching } from './Coaching';
import { useState } from 'react';
import { getCapSummary } from '../game/cap';
import {
  allStarTargetDay,
  canPlaceInLtir,
  canPlayThroughInjury,
  computeHomeGateRevenue,
  ensureFacilities,
  FACILITY_MAX_LEVEL,
  FACILITY_META,
  facilityUpgradeCost,
  formatInjuryDays,
  injuryReturnDate,
  LTIR_MIN_DAYS,
  severityLabel,
} from '../game/medical';
import { formatMoney } from '../game/ratings';
import { regularSeasonLength, seasonDateOnly } from '../game/schedule';
import {
  activatePlayerFromLtir,
  placePlayerInLtir,
  togglePlayThroughInjury,
  upgradeClubFacility,
  useGame,
} from '../game/state';
import { Bar, Button, OverallChip, Panel, PosBadge, Stat, Tag, useUI } from './ui';
import { cn } from '../utils/cn';

export function Club() {
  const s = useGame()!;
  const ui = useUI();
  const U = s.teams[s.userTeamId];
  const P = s.players;
  const fac = ensureFacilities(U);
  const capInfo = getCapSummary(s, U.id);
  const regLen = regularSeasonLength(s.schedule);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const medPatients = U.players
    .map((id) => P[id])
    .filter((p) => p && (p.injury || p.inLtir))
    .sort((a, b) => (b.injury?.days ?? 0) - (a.injury?.days ?? 0));

  const avgLevel = ((fac.medical + fac.academy + fac.arena + fac.scouting) / 4).toFixed(1);
  const sampleHomeGate = computeHomeGateRevenue(fac.arena, s.phase === 'playoffs', false, 50);
  const targetAsgDay = allStarTargetDay(regLen);

  return (
    <div className="space-y-4 fade-in" data-club-hub>
      <Coaching />
      {/* Top KPI Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat
          label="Бюджет клуба"
          value={formatMoney(U.budget)}
          sub="резерв на модернизацию и выкупы"
          color="#3FCF8E"
        />
        <Stat
          label="Касса арены за сезон"
          value={formatMoney(U.seasonGateRevenue ?? 0)}
          sub={`~${formatMoney(sampleHomeGate)} за домашний матч`}
          color="#8FD8F0"
        />
        <Stat
          label="Лазарет и ДСБТ"
          value={medPatients.length ? `${medPatients.length} игр.` : 'Все в строю'}
          sub={capInfo.ltirRelief > 0 ? `льгота ДСБТ: −${formatMoney(capInfo.ltirRelief)}` : `ДСБТ доступен от ${LTIR_MIN_DAYS} дн.`}
          color={medPatients.length ? '#F2B544' : '#3FCF8E'}
        />
        <Stat
          label="Уровень инфраструктуры"
          value={`${avgLevel} / ${FACILITY_MAX_LEVEL}`}
          sub={`Мед.${fac.medical} · Акад.${fac.academy} · Ар.${fac.arena} · Ск.${fac.scouting}`}
          color="#F2B544"
        />
      </div>

      {notice && (
        <div
          className={cn(
            'rounded-sm border px-3 py-2 text-xs',
            notice.ok ? 'border-ok/50 bg-ok/10 text-ok' : 'border-accent/50 bg-accent/10 text-accent'
          )}
        >
          {notice.text}
        </div>
      )}

      {/* 4 Facility Upgrade Cards */}
      <Panel
        title={`Инфраструктура клуба · ${U.name}`}
        right={<span className="text-xs text-muted">Вложения остаются с клубом во всех следующих сезонах Династии</span>}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {FACILITY_META.map((m) => {
            const lv = fac[m.key];
            const cost = facilityUpgradeCost(lv);
            const canAfford = cost !== null && U.budget >= cost;
            return (
              <div
                key={m.key}
                data-facility-card={m.key}
                className="rounded-md border border-line bg-panel2/60 p-3.5 flex flex-col justify-between gap-3"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-display text-base uppercase tracking-wide text-text">{m.title}</div>
                      <div className="text-xs text-muted mt-0.5">{m.subtitle}</div>
                    </div>
                    <Tag color={lv >= 4 ? '#F2B544' : lv >= 2 ? '#8FD8F0' : '#93A4BC'}>
                      Ур. {lv}/{FACILITY_MAX_LEVEL}
                    </Tag>
                  </div>

                  {/* Level pips */}
                  <div className="flex gap-1.5 mt-3">
                    {Array.from({ length: FACILITY_MAX_LEVEL }).map((_, idx) => (
                      <div
                        key={idx}
                        className={cn(
                          'h-2 flex-1 rounded-sm transition-colors',
                          idx < lv ? 'bg-ice' : 'bg-line/70'
                        )}
                      />
                    ))}
                  </div>

                  <div className="mt-2.5 text-xs text-text/90">
                    <span className="text-muted">Текущий эффект:</span> <b>{m.effectLabel(lv)}</b>
                  </div>
                  {cost !== null && (
                    <div className="mt-1 text-[11px] text-ice/90">
                      На Ур. {lv + 1}: {m.effectLabel(lv + 1)}
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2 pt-2 border-t border-line/60">
                  {cost === null ? (
                    <span className="text-xs text-gold font-semibold">★ Максимальный уровень достигнут</span>
                  ) : (
                    <>
                      <span className="text-xs text-muted tabular">
                        Стоимость: <b className={canAfford ? 'text-text' : 'text-accent'}>{formatMoney(cost)}</b>
                      </span>
                      <Button
                        size="sm"
                        variant={canAfford ? 'primary' : 'secondary'}
                        disabled={!canAfford}
                        onClick={() => {
                          const err = upgradeClubFacility(m.key);
                          setNotice(
                            err
                              ? { ok: false, text: err }
                              : { ok: true, text: `«${m.title}» повышен до Ур. ${lv + 1}!` }
                          );
                        }}
                      >
                        Улучшить до Ур. {lv + 1}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      {/* Medical Center: Calendar-Day Injuries, LTIR (ДСБТ) & Playoff «На уколах» */}
      <Panel
        title="Медицинский бюллетень и список ДСБТ КХЛ"
        right={
          <span className="text-xs text-muted">
            Восстановление идёт каждый календарный день · ДСБТ (от {LTIR_MIN_DAYS} дн.) снимает 100% зарплаты с потолка
          </span>
        }
      >
        {medPatients.length === 0 ? (
          <div className="text-sm text-muted py-2">
            В лазарете клуба пусто — все хоккеисты основной команды здоровы.
          </div>
        ) : (
          <div className="space-y-2.5">
            {medPatients.map((p) => {
              const inj = p.injury;
              const total = Math.max(inj?.totalDays ?? inj?.days ?? 1, inj?.days ?? 1);
              const pct = inj ? Math.round(((total - inj.days) / Math.max(1, total)) * 100) : 100;
              const retDate = inj ? injuryReturnDate(s.day, inj.days, regLen, s.league.season) : null;
              return (
                <div
                  key={p.id}
                  className="rounded-sm border border-line bg-panel2/50 px-3 py-2.5 flex flex-wrap items-center justify-between gap-3"
                >
                  <div className="min-w-[220px] flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <PosBadge pos={p.position} />
                      <button onClick={() => ui.openPlayer(p.id)} className="font-semibold hover:text-ice text-sm">
                        {p.name}
                      </button>
                      <OverallChip value={p.overall} size="sm" />
                      {p.inLtir && <Tag tone="accent">ДСБТ (−{formatMoney(p.contract.salary)} с потолка)</Tag>}
                      {p.playingThroughInjury && <Tag tone="warn">На уколах (−3 навык)</Tag>}
                      {inj && (
                        <Tag color={inj.severity === 'severe' ? '#E5323E' : inj.severity === 'moderate' ? '#F2B544' : '#8FD8F0'}>
                          {severityLabel(inj.severity)}
                        </Tag>
                      )}
                    </div>
                    {inj ? (
                      <div className="mt-1.5 flex items-center gap-3 text-xs text-muted">
                        <span>
                          Диагноз: <b className="text-text">{inj.name}</b> · осталось{' '}
                          <b className="text-accent">{formatInjuryDays(inj.days)}</b> (возвращение ~<b>{retDate}</b>)
                        </span>
                        <Bar value={pct} color="#3FCF8E" className="w-28 hidden sm:block" />
                      </div>
                    ) : (
                      <div className="mt-1 text-xs text-ok">
                        Полностью здоров — выведите игрока из ДСБТ, чтобы вернуть в заявку на матчи.
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {canPlaceInLtir(p) && s.phase !== 'offseason' && (
                      <Button
                        size="sm"
                        variant="ice"
                        onClick={() => {
                          const err = placePlayerInLtir(p.id);
                          setNotice(
                            err
                              ? { ok: false, text: err }
                              : { ok: true, text: `${p.name} переведён в ДСБТ — освобождено ${formatMoney(p.contract.salary)} под потолком.` }
                          );
                        }}
                      >
                        🏥 Перевести в ДСБТ
                      </Button>
                    )}
                    {p.inLtir && !p.injury && (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => {
                          const err = activatePlayerFromLtir(p.id);
                          setNotice(err ? { ok: false, text: err } : { ok: true, text: `${p.name} выведен из ДСБТ!` });
                        }}
                      >
                        ✓ Вывести из ДСБТ
                      </Button>
                    )}
                    {(canPlayThroughInjury(p, s.phase) || p.playingThroughInjury) && (
                      <Button
                        size="sm"
                        variant={p.playingThroughInjury ? 'danger' : 'secondary'}
                        onClick={() => {
                          const err = togglePlayThroughInjury(p.id);
                          setNotice(
                            err
                              ? { ok: false, text: err }
                              : {
                                  ok: true,
                                  text: p.playingThroughInjury
                                    ? `${p.name} возвращён в лазарет.`
                                    : `${p.name} допущен к матчам плей-офф «на уколах»!`,
                                }
                          );
                        }}
                      >
                        {p.playingThroughInjury ? 'Снять с игры «на уколах»' : '💉 На уколах (плей-офф)'}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {/* KHL All-Star Weekend (Неделя Звёзд КХЛ) */}
      <Panel
        title="★ Неделя Звёзд КХЛ (Запад vs Восток)"
        right={
          s.allStar ? (
            <Tag color="#F2B544">
              Запад {s.allStar.westScore}:{s.allStar.eastScore} Восток
            </Tag>
          ) : (
            <Tag color="#8FD8F0">Запланирована на {seasonDateOnly(targetAsgDay, regLen, s.league.season)}</Tag>
          )
        }
      >
        {!s.allStar ? (
          <div className="text-xs text-text/85 leading-relaxed">
            В середине регулярного чемпионата ({seasonDateOnly(targetAsgDay, regLen, s.league.season)}) лучшие бомбардиры и вратари{' '}
            <b>Запада</b> и <b>Востока</b> встретятся в Матче Звёзд КХЛ и Мастер-шоу. Каждый вызванный игрок вашего клуба получит{' '}
            <b className="text-ok">+8 к морали</b> и принесёт <b className="text-gold">+15,0 млн ₽</b> медиа-бонуса в бюджет клуба, а остальные вратари лиги дополнительно восстановят свежесть.
          </div>
        ) : (
          <div className="space-y-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-gold/30 bg-gold/10 px-3 py-2.5">
              <div>
                <span className="font-display text-base uppercase text-gold">
                  Сборная Запада {s.allStar.westScore} : {s.allStar.eastScore} Сборная Востока
                </span>
                <div className="text-text/85 mt-0.5">
                  MVP матча:{' '}
                  <button onClick={() => ui.openPlayer(s.allStar!.mvpId)} className="font-semibold text-ice hover:underline">
                    {P[s.allStar.mvpId]?.name ?? '—'}
                  </button>{' '}
                  · Круг на скорость:{' '}
                  <button onClick={() => ui.openPlayer(s.allStar!.fastestSkaterId)} className="font-semibold hover:underline">
                    {P[s.allStar.fastestSkaterId]?.name ?? '—'}
                  </button>{' '}
                  · Сила броска:{' '}
                  <button onClick={() => ui.openPlayer(s.allStar!.hardestShotId)} className="font-semibold hover:underline">
                    {P[s.allStar.hardestShotId]?.name ?? '—'}
                  </button>
                </div>
              </div>
              {s.allStar.userSelectedIds.length > 0 && (
                <Tag tone="good">От «{U.short}»: {s.allStar.userSelectedIds.length} игр. (+{formatMoney(s.allStar.userSelectedIds.length * 15_000_000)})</Tag>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {[
                { label: 'Сборная Запада', ids: s.allStar.westRoster },
                { label: 'Сборная Востока', ids: s.allStar.eastRoster },
              ].map((side) => (
                <div key={side.label} className="rounded-sm border border-line bg-panel2/40 p-2.5">
                  <div className="font-display uppercase tracking-wider text-xs text-muted mb-1.5">{side.label}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {side.ids.map((pid) => {
                      const pl = P[pid];
                      if (!pl) return null;
                      const isMine = pl.teamId === U.id;
                      return (
                        <button
                          key={pid}
                          onClick={() => ui.openPlayer(pid)}
                          className={cn(
                            'px-2 py-0.5 rounded-sm border text-[11px] hover:border-ice transition-colors',
                            isMine ? 'border-gold/60 bg-gold/15 text-gold font-semibold' : 'border-line bg-panel text-text/90'
                          )}
                        >
                          {pl.name} ({pl.teamId ? s.teams[pl.teamId]?.short : '—'})
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
