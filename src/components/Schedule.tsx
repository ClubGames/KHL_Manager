import { useMemo, useState } from 'react';
import type { Game } from '../types';
import {
  isWeekendDay,
  MONDAY_FIRST_HEADERS,
  MONTH_NAMES_RU,
  regularSeasonLength,
  seasonDate,
  seasonDateObj,
  seasonDateOnly,
  seasonWeekdayCap,
} from '../game/schedule';
import { getTradeWindowsSchedule, novemberTradeFreeze, tradeDeadline } from '../game/ai';
import { getDerby } from '../game/derbies';
import { roundName, useGame } from '../game/state';
import { Button, Empty, Modal, Panel, TeamLogo, Tag, useUI } from './ui';
import { ShotMap } from './ShotMap';
import { LineupPreview } from './LineupPreview';
import { cn } from '../utils/cn';

function scoreTag(g: Game) {
  const r = g.result;
  if (!r) return '';
  return r.so ? ' Б' : r.ot ? (r.periods > 4 ? ' 2ОТ' : ' ОТ') : '';
}

export function GameBox({ gameId, onClose }: { gameId: number; onClose: () => void }) {
  const s = useGame()!;
  let game: Game | null = null;
  for (const d of s.schedule) {
    const g = d.find((x) => x.id === gameId);
    if (g) {
      game = g;
      break;
    }
  }
  if (!game) return null;
  const r = game.result;
  const H = s.teams[game.home];
  const A = s.teams[game.away];
  const P = s.players;
  const ser = game.seriesId != null ? s.playoffs?.series.find((x) => x.id === game.seriesId) : null;
  const isUserMatch = game.home === s.userTeamId || game.away === s.userTeamId;
  const oppId = game.home === s.userTeamId ? game.away : game.home;

  return (
    <Modal open onClose={onClose} width="max-w-3xl">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-3">
        <div className="flex flex-col sm:flex-row items-center gap-1.5 sm:gap-3 min-w-0 text-center sm:text-left">
          <TeamLogo team={A} size={38} className="sm:w-11 sm:h-11" />
          <div className="min-w-0 max-w-full">
            <div className="font-display text-sm sm:text-lg uppercase leading-tight truncate">{A.name}</div>
            <div className="text-[10px] sm:text-[11px] text-muted">гости</div>
          </div>
        </div>
        <div className="text-center px-1">
          <div className="font-display text-2xl sm:text-4xl tabular leading-none">{r ? `${r.awayScore}:${r.homeScore}` : 'VS'}</div>
          <div className="text-[10px] sm:text-[11px] text-muted mt-1">
            {r ? (r.so ? 'буллиты' : r.ot ? 'овертайм' : 'осн. время') : 'предстоящий'}
            {game.kind === 'playoff' && ser ? ` · м.${ser.games.indexOf(game.id) + 1} (${ser.wins[0]}:${ser.wins[1]})` : ''}
          </div>
        </div>
        <div className="flex flex-col-reverse sm:flex-row items-center gap-1.5 sm:gap-3 justify-end text-center sm:text-right min-w-0">
          <div className="min-w-0 max-w-full">
            <div className="font-display text-sm sm:text-lg uppercase leading-tight truncate">{H.name}</div>
            <div className="text-[10px] sm:text-[11px] text-muted">хозяева</div>
          </div>
          <TeamLogo team={H} size={38} className="sm:w-11 sm:h-11" />
        </div>
      </div>
      <div className="text-center text-[11px] text-muted mt-1">
        {seasonDate(game.day, regularSeasonLength(s.schedule), s.league.season)} · {game.kind === 'playoff' ? roundName(s.playoffs?.round ?? 0) : 'Регулярный чемпионат'}
      </div>
      {(() => {
        const dby = getDerby(H, A);
        return dby ? (
          <div className="mt-2 rounded-sm border border-gold/50 bg-gold/10 px-3 py-1.5 text-center text-xs">
            <b className="text-gold">🔥 {dby.title}</b> <span className="text-muted">— {dby.subtitle}</span>
          </div>
        ) : null;
      })()}

      {!r && isUserMatch && (
        <div className="mt-4">
          <LineupPreview
            state={s}
            leftTeamId={s.userTeamId}
            initialOpponentId={oppId}
            allowPickOpponent={false}
            initialTab="pp"
          />
        </div>
      )}

      {r && (
        <>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm tabular">
              <thead className="text-[11px] uppercase tracking-wider text-muted">
                <tr>
                  <th className="text-left py-1 font-semibold">Периоды</th>
                  {r.periodScores.map((_, i) => (
                    <th key={i} className="text-right px-2 font-semibold">{i < 3 ? `${i + 1}` : r.so && i === r.periodScores.length - 1 ? 'Б' : 'ОТ'}</th>
                  ))}
                  <th className="text-right px-2 font-semibold">Броски</th>
                  <th className="text-right px-2 font-semibold">xG</th>
                  <th className="text-right px-2 font-semibold">Опасн.</th>
                  <th className="text-right px-2 font-semibold">Большинство</th>
                  <th className="text-right px-2 font-semibold">Штраф</th>
                  <th className="text-right pl-2 font-semibold">Силовые</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-line/60">
                  <td className="py-1.5 flex items-center gap-2"><TeamLogo team={A} size={18} />{A.short}</td>
                  {r.periodScores.map((p, i) => (
                    <td key={i} className="text-right px-2">{p[0]}</td>
                  ))}
                  <td className="text-right px-2">{r.awayStats.shots}</td>
                  <td className="text-right px-2 text-accent font-semibold">{(r.awayStats.xg ?? 0).toFixed(2)}</td>
                  <td className="text-right px-2 text-gold">{r.awayStats.dangerShots ?? 0}</td>
                  <td className="text-right px-2">{r.awayStats.ppGoals}/{r.awayStats.ppChances}</td>
                  <td className="text-right px-2">{r.awayStats.pim}</td>
                  <td className="text-right pl-2">{r.awayStats.hits}</td>
                </tr>
                <tr className="border-t border-line/60">
                  <td className="py-1.5 flex items-center gap-2"><TeamLogo team={H} size={18} />{H.short}</td>
                  {r.periodScores.map((p, i) => (
                    <td key={i} className="text-right px-2">{p[1]}</td>
                  ))}
                  <td className="text-right px-2">{r.homeStats.shots}</td>
                  <td className="text-right px-2 text-accent font-semibold">{(r.homeStats.xg ?? 0).toFixed(2)}</td>
                  <td className="text-right px-2 text-gold">{r.homeStats.dangerShots ?? 0}</td>
                  <td className="text-right px-2">{r.homeStats.ppGoals}/{r.homeStats.ppChances}</td>
                  <td className="text-right px-2">{r.homeStats.pim}</td>
                  <td className="text-right pl-2">{r.homeStats.hits}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {r.shotMap && r.shotMap.length > 0 && (
            <div className="mt-4 rounded-xl border border-line bg-bg/35 p-3">
              <ShotMap shots={r.shotMap} home={H} away={A} players={P} compact />
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Заброшенные шайбы</div>
              <ul className="text-xs space-y-1 max-h-56 overflow-y-auto pr-1">
                {r.scorers.length === 0 && <li className="text-muted">Шайб не было</li>}
                {r.scorers.map((sc, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="w-10 text-muted tabular shrink-0">{sc.period <= 3 ? sc.period : 'ОТ'} · {sc.time}</span>
                    <span className="truncate">
                      <b className={sc.team === game.home ? 'text-ice' : 'text-amber'}>{s.teams[sc.team].short}</b> {P[sc.scorer]?.name}
                      {sc.assists.length > 0 && <span className="text-muted"> ({sc.assists.map((a) => P[a]?.name).join(', ')})</span>}
                      {sc.strength === 'PP' && <span className="text-muted"> Бол</span>}
                      {sc.strength === 'SH' && <span className="text-muted"> Мен</span>}
                      {sc.strength === 'EN' && <span className="text-muted"> ПВ</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Вратари и звёзды</div>
              <ul className="text-xs space-y-1">
                {[r.awayGoalie, r.homeGoalie].map((gid, i) => {
                  const p = gid ? P[gid] : null;
                  const l = gid ? r.lines[gid] : null;
                  return (
                    <li key={i} className="flex justify-between gap-2">
                      <span className="truncate">{p?.name ?? '—'}</span>
                      <span className="text-muted tabular">{l ? `${l.saves}/${l.shotsAgainst} сейвов` : ''}</span>
                    </li>
                  );
                })}
              </ul>
              <div className="text-[11px] uppercase tracking-wider text-muted mt-3 mb-1">Три звезды</div>
              <div className="flex gap-2 flex-wrap">
                {r.stars.map((id, i) => (
                  <Tag key={id} color="#F2B544">
                    ★ {i + 1}. {P[id]?.name}
                  </Tag>
                ))}
                {!r.stars.length && <span className="text-xs text-muted">—</span>}
              </div>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

export function Schedule({ onPlay }: { onPlay: (g: Game) => void }) {
  const s = useGame()!;
  const U = s.userTeamId;
  const ui = useUI();
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [filter, setFilter] = useState<'all' | 'mine' | 'po'>('all');
  const [showAll, setShowAll] = useState(false);

  const regLen = regularSeasonLength(s.schedule);
  const deadlineDay = tradeDeadline(s);
  const freeze = novemberTradeFreeze(s);
  const windows = useMemo(() => getTradeWindowsSchedule(s), [s]);

  // Group all calendar dates into months (Sep .. Apr) for the Mon-Sun grid
  const months = useMemo(() => {
    const map = new Map<string, { key: string; year: number; month: number; label: string; cells: ({ date: Date; dayIdx: number | null; games: Game[] } | null)[] }>();
    const totalDays = Math.max(regLen, s.schedule.length);
    // Build a lookup from YYYY-MM-DD -> gameDayIndex
    const byIso = new Map<string, number>();
    for (let d = 0; d < totalDays; d++) {
      const dt = seasonDateObj(d, regLen, s.league.season);
      const iso = `${dt.getFullYear()}-${dt.getMonth()}-${dt.getDate()}`;
      byIso.set(iso, d);
      const mk = `${dt.getFullYear()}-${String(dt.getMonth()).padStart(2, '0')}`;
      if (!map.has(mk)) {
        map.set(mk, {
          key: mk,
          year: dt.getFullYear(),
          month: dt.getMonth(),
          label: `${MONTH_NAMES_RU[dt.getMonth()]} ${dt.getFullYear()}`,
          cells: [],
        });
      }
    }
    for (const m of map.values()) {
      const first = new Date(m.year, m.month, 1);
      const daysInMonth = new Date(m.year, m.month + 1, 0).getDate();
      // Monday-first offset: Sun(0)->6, Mon(1)->0, ..., Sat(6)->5
      const lead = (first.getDay() + 6) % 7;
      for (let i = 0; i < lead; i++) m.cells.push(null);
      for (let dom = 1; dom <= daysInMonth; dom++) {
        const dt = new Date(m.year, m.month, dom);
        const iso = `${m.year}-${m.month}-${dom}`;
        const dayIdx = byIso.get(iso) ?? null;
        m.cells.push({
          date: dt,
          dayIdx,
          games: dayIdx !== null ? s.schedule[dayIdx] ?? [] : [],
        });
      }
    }
    return [...map.values()];
  }, [s.schedule, regLen, s.league.season]);

  const currentMonthKey = useMemo(() => {
    const curDay = Math.min(s.day, Math.max(0, s.schedule.length - 1));
    const dt = seasonDateObj(curDay, regLen, s.league.season);
    return `${dt.getFullYear()}-${String(dt.getMonth()).padStart(2, '0')}`;
  }, [s.day, s.schedule.length, regLen, s.league.season]);

  const [selMonthKey, setSelMonthKey] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  const activeMonth = months.find((m) => m.key === (selMonthKey ?? currentMonthKey)) ?? months[0];

  const from = showAll ? 0 : Math.max(0, s.day - 4);
  const days = s.schedule
    .map((games, day) => ({ day, games }))
    .slice(from)
    .filter(({ games }) => {
      if (filter === 'mine') return games.some((g) => g.home === U || g.away === U);
      if (filter === 'po') return games.some((g) => g.kind === 'playoff');
      return true;
    });

  const inspectedDay = selectedDay ?? (s.schedule[s.day] ? s.day : null);
  const inspectedGames = inspectedDay !== null ? s.schedule[inspectedDay] ?? [] : [];

  return (
    <div className="space-y-3.5 fade-in" data-calendar-screen>
      {/* Trade Windows Schedule Strip */}
      <Panel title="Окна обменов и трансферный регламент сезона">
        <div className="flex overflow-x-auto no-scrollbar sm:grid sm:grid-cols-2 lg:grid-cols-5 gap-2 pb-0.5" data-trade-windows-timeline>
          {windows.map((w) => {
            const active = w.status === 'active';
            const dateRange =
              w.id === 'offseason'
                ? 'Май – Август'
                : `${seasonDateOnly(w.startDay, regLen, s.league.season)} — ${seasonDateOnly(w.endDay, regLen, s.league.season)}`;
            return (
              <div
                key={w.id}
                className={cn(
                  'rounded-lg border p-2.5 text-xs transition min-w-[215px] sm:min-w-0 shrink-0',
                  active
                    ? w.open
                      ? 'border-good/60 bg-good/10'
                      : 'border-gold/60 bg-gold/10'
                    : 'border-line/70 bg-bg/45 opacity-80'
                )}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="font-display font-bold uppercase tracking-wide truncate">{w.title}</span>
                  <span
                    className={cn(
                      'px-1.5 py-0.5 rounded text-[10px] font-bold uppercase shrink-0',
                      w.open ? 'bg-good/20 text-good' : 'bg-red/20 text-red'
                    )}
                  >
                    {w.open ? 'Открыто' : 'Закрыто'}
                  </span>
                </div>
                <div className="text-[11px] text-ice/90 mt-1 font-medium">{dateRange}</div>
                <div className="text-[10px] text-muted mt-0.5 leading-snug">{w.note}</div>
              </div>
            );
          })}
        </div>
      </Panel>

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex rounded-sm border border-line bg-panel p-0.5">
          <button
            type="button"
            onClick={() => setView('grid')}
            className={cn('text-xs px-3 py-1.5 rounded-sm font-semibold cursor-pointer', view === 'grid' ? 'bg-accent text-white' : 'text-muted hover:text-text')}
          >
            Календарь по дням недели (Пн–Вс)
          </button>
          <button
            type="button"
            onClick={() => setView('list')}
            className={cn('text-xs px-3 py-1.5 rounded-sm font-semibold cursor-pointer', view === 'list' ? 'bg-accent text-white' : 'text-muted hover:text-text')}
          >
            Список матчей
          </button>
        </div>

        {view === 'list' &&
          (['all', 'mine', 'po'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn('text-xs px-3 py-1.5 rounded-sm font-semibold cursor-pointer', filter === f ? 'bg-panel2 text-ice border border-line' : 'bg-panel2/50 text-muted hover:text-text')}
            >
              {f === 'all' ? 'Все матчи' : f === 'mine' ? 'Моя команда' : 'Плей-офф'}
            </button>
          ))}

        <span className="text-xs text-muted ml-auto">
          Сегодня: <b className="text-ice">{seasonDate(Math.min(s.day, Math.max(0, s.schedule.length - 1)), regLen, s.league.season)}</b> · день {Math.min(s.day + 1, s.schedule.length)}/{s.schedule.length}
        </span>

        {view === 'list' && !showAll && (
          <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
            Показать с начала сезона
          </Button>
        )}
      </div>

      {/* Real Weekday Monthly Calendar Grid */}
      {view === 'grid' && activeMonth && (
        <div className="space-y-3">
          <Panel
            title={
              <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar sm:flex-wrap max-w-[78vw] sm:max-w-none">
                {months.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => setSelMonthKey(m.key)}
                    className={cn(
                      'px-2.5 py-1 rounded text-xs font-display uppercase tracking-wider cursor-pointer transition shrink-0',
                      m.key === activeMonth.key
                        ? 'bg-accent text-white font-bold'
                        : m.key === currentMonthKey
                          ? 'bg-panel2 text-ice border border-accent/40'
                          : 'bg-bg/60 text-muted hover:text-ice'
                    )}
                  >
                    {MONTH_NAMES_RU[m.month]}
                  </button>
                ))}
              </div>
            }
            right={<span className="text-xs text-muted hidden sm:inline">{activeMonth.label}</span>}
          >
            <div className="grid grid-cols-7 gap-1 sm:gap-1.5 mb-1 sm:mb-1.5" data-weekday-headers>
              {MONDAY_FIRST_HEADERS.map((wd, idx) => (
                <div
                  key={wd}
                  className={cn(
                    'text-center text-[10px] sm:text-[11px] font-display font-bold uppercase tracking-wider py-1 rounded bg-bg/60',
                    idx >= 5 ? 'text-gold' : 'text-muted'
                  )}
                >
                  {wd}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1 sm:gap-1.5" data-calendar-grid>
              {activeMonth.cells.map((cell, idx) => {
                if (!cell) return <div key={`empty-${idx}`} className="min-h-[54px] sm:min-h-[78px] rounded-md bg-bg/20 border border-line/20" />;
                const { date, dayIdx, games } = cell;
                const isToday = dayIdx !== null && dayIdx === s.day;
                const isSelected = dayIdx !== null && dayIdx === inspectedDay;
                const weekend = date.getDay() === 0 || date.getDay() === 6;
                const userGame = games.find((g) => g.home === U || g.away === U);
                const oppId = userGame ? (userGame.home === U ? userGame.away : userGame.home) : null;
                const opp = oppId ? s.teams[oppId] : null;
                const isHome = userGame ? userGame.home === U : false;
                const ur = userGame?.result;
                const userWon = ur ? (isHome ? ur.homeScore > ur.awayScore : ur.awayScore > ur.homeScore) : null;

                const isDeadline = dayIdx === deadlineDay;
                const inFreeze = freeze !== null && dayIdx !== null && dayIdx >= freeze[0] && dayIdx < freeze[1];
                const isWinterOpen = freeze !== null && dayIdx === freeze[1];

                return (
                  <div
                    key={date.toISOString()}
                    onClick={() => dayIdx !== null && setSelectedDay(dayIdx)}
                    className={cn(
                      'min-h-[54px] sm:min-h-[82px] rounded-md sm:rounded-lg border p-1 sm:p-1.5 flex flex-col justify-between text-xs transition select-none overflow-hidden',
                      dayIdx !== null ? 'cursor-pointer hover:border-accent/60' : 'opacity-45',
                      isToday
                        ? 'border-accent bg-accent/12 ring-1 ring-accent/50'
                        : isSelected
                          ? 'border-ice/60 bg-panel2/80'
                          : userGame
                            ? 'border-line bg-panel2/45'
                            : 'border-line/50 bg-bg/40'
                    )}
                  >
                    <div className="flex items-center justify-between gap-0.5">
                      <span className={cn('font-display text-xs sm:text-sm font-bold tabular-nums leading-none', isToday ? 'text-accent' : weekend ? 'text-gold' : 'text-ice')}>
                        {date.getDate()}
                      </span>
                      {isToday && <span className="hidden sm:inline text-[9px] uppercase font-bold px-1 rounded bg-accent text-white">сегодня</span>}
                      {isToday && <span className="sm:hidden w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                      {!isToday && games.length > 0 && <span className="hidden sm:inline text-[10px] text-muted tabular-nums">{games.length} м.</span>}
                    </div>

                    {/* Trade window milestone badges */}
                    {(isDeadline || inFreeze || isWinterOpen) && (
                      <div className="hidden sm:block my-0.5">
                        {isDeadline && <span className="block text-[9px] font-bold uppercase px-1 py-0.5 rounded bg-red/25 text-red truncate">Дедлайн КХЛ</span>}
                        {isWinterOpen && <span className="block text-[9px] font-bold uppercase px-1 py-0.5 rounded bg-good/20 text-good truncate">Зимнее окно</span>}
                        {inFreeze && !isDeadline && <span className="block text-[9px] uppercase px-1 py-0.5 rounded bg-gold/15 text-gold truncate">Мораторий</span>}
                      </div>
                    )}

                    {/* User match pill inside calendar cell */}
                    {userGame && opp ? (
                      <>
                        {/* Compact mobile pill (fits 42px cell width cleanly) */}
                        <div
                          className={cn(
                            'sm:hidden mt-0.5 rounded px-0.5 py-0.5 text-center border text-[9px] leading-tight font-semibold truncate',
                            ur
                              ? userWon
                                ? 'bg-good/20 border-good/40 text-good'
                                : 'bg-bad/20 border-bad/40 text-bad'
                              : 'bg-bg/85 border-line text-ice'
                          )}
                        >
                          <div className="truncate">{opp.short}</div>
                          <div className="tabular-nums text-[8.5px]">
                            {ur ? `${ur.awayScore}:${ur.homeScore}` : isHome ? 'дом' : 'выезд'}
                          </div>
                        </div>
                        {/* Full sm+ pill */}
                        <div
                          onClick={(e) => {
                            e.stopPropagation();
                            ui.openGame(userGame.id);
                          }}
                          className={cn(
                            'hidden sm:flex mt-1 rounded px-1.5 py-1 items-center justify-between gap-1 border text-[11px]',
                            ur
                              ? userWon
                                ? 'bg-good/15 border-good/40 text-ice'
                                : 'bg-bad/15 border-bad/40 text-ice'
                              : 'bg-bg/80 border-line hover:border-accent/60'
                          )}
                        >
                          <span className="flex items-center gap-1 min-w-0 truncate font-semibold">
                            <span className="text-[9px] text-muted">{isHome ? 'Д' : 'Г'}</span>
                            <TeamLogo team={opp} size={15} />
                            <span className="truncate">{opp.short}</span>
                            {getDerby(s.teams[userGame.home], s.teams[userGame.away]) && (
                              <span title={getDerby(s.teams[userGame.home], s.teams[userGame.away])!.title}>🔥</span>
                            )}
                          </span>
                          {ur ? (
                            <span className={cn('font-display font-bold tabular-nums shrink-0', userWon ? 'text-good' : 'text-bad')}>
                              {ur.awayScore}:{ur.homeScore}
                            </span>
                          ) : (
                            <span className="text-[9px] text-accent shrink-0">разбор</span>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="hidden sm:block text-[10px] text-muted/60 mt-auto">{dayIdx !== null ? 'выходной клуба' : ''}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </Panel>

          {/* Matches of the selected day */}
          {inspectedDay !== null && inspectedGames.length > 0 && (
            <Panel
              noPad
              title={
                <span>
                  Матчи дня: {seasonDate(inspectedDay, regLen, s.league.season)}
                  {isWeekendDay(inspectedDay, regLen, s.league.season) ? ' · выходной тур' : ''}
                  {inspectedDay === s.day ? ' · сегодня' : ''}
                </span>
              }
              right={<span className="text-xs text-muted">{inspectedGames.length} матчей · нажмите на счёт или «Разбор» для карты xG / звеньев</span>}
            >
              <ul className="divide-y divide-line/60">
                {inspectedGames.map((g) => {
                  const r = g.result;
                  const mine = g.home === U || g.away === U;
                  return (
                    <li key={g.id} className={cn('flex flex-wrap sm:flex-nowrap items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 sm:py-2 text-sm', mine && 'bg-ice/5')}>
                      <span className="hidden sm:inline w-16 text-[11px] text-muted shrink-0">
                        {seasonWeekdayCap(g.day, regLen, s.league.season)} · {g.kind === 'playoff' ? 'ПО' : `#${g.id}`}
                      </span>
                      <span className="flex items-center gap-1.5 sm:gap-2 flex-1 sm:w-[28%] sm:flex-none min-w-0 justify-end">
                        <span className="truncate sm:hidden font-semibold">{s.teams[g.away].short}</span>
                        <span className="truncate hidden sm:inline">{s.teams[g.away].name}</span>
                        <TeamLogo team={s.teams[g.away]} size={22} />
                      </span>
                      {r ? (
                        <button onClick={() => ui.openGame(g.id)} className="font-display text-base sm:text-lg tabular w-16 sm:w-24 text-center hover:text-ice cursor-pointer shrink-0">
                          {r.awayScore}:{r.homeScore}
                          <span className="text-[10px] text-muted ml-0.5">{scoreTag(g)}</span>
                        </button>
                      ) : (
                        <span className="w-12 sm:w-24 text-center text-muted text-xs shrink-0">VS</span>
                      )}
                      <span className="flex items-center gap-1.5 sm:gap-2 flex-1 sm:w-[28%] sm:flex-none min-w-0">
                        <TeamLogo team={s.teams[g.home]} size={22} />
                        <span className="truncate sm:hidden font-semibold">{s.teams[g.home].short}</span>
                        <span className="truncate hidden sm:inline">{s.teams[g.home].name}</span>
                      </span>
                      <span className="w-full sm:w-auto sm:ml-auto flex items-center justify-end gap-2">
                        {getDerby(s.teams[g.home], s.teams[g.away]) && <Tag tone="warn" className="hidden md:inline-flex">🔥 {getDerby(s.teams[g.home], s.teams[g.away])!.title}</Tag>}
                        {mine && !r && inspectedDay === s.day && (
                          <Button size="sm" variant="primary" onClick={() => onPlay(g)}>
                            Играть
                          </Button>
                        )}
                        {mine && !r && (
                          <Button size="sm" variant="ghost" onClick={() => ui.openGame(g.id)}>
                            Разбор ЧБ
                          </Button>
                        )}
                        {mine && r && (
                          <button onClick={() => ui.openGame(g.id)} className="cursor-pointer">
                            <Tag color="#8FD8F0">карта xG</Tag>
                          </button>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          )}
        </div>
      )}

      {/* Classic List View */}
      {view === 'list' && (
        <>
          {days.length === 0 && (
            <Panel>
              <Empty text="Матчей по этому фильтру нет" />
            </Panel>
          )}
          <div className="space-y-2">
            {days.map(({ day, games }) => {
              const isToday = day === s.day;
              const filtered = filter === 'mine' ? games.filter((g) => g.home === U || g.away === U) : games;
              return (
                <Panel
                  key={day}
                  noPad
                  className={cn(isToday && 'border-ice/50')}
                  title={
                    <span className={cn(isToday && 'text-ice')}>
                      {seasonDate(day, regLen, s.league.season)}
                      {isToday ? ' · сегодня' : ''}
                    </span>
                  }
                  right={<span className="text-xs text-muted">{games.some((g) => g.kind === 'playoff') ? 'Плей-офф' : 'Регулярный чемпионат'} · {filtered.length} матчей</span>}
                >
                  <ul className="divide-y divide-line/60">
                    {filtered.map((g) => {
                      const r = g.result;
                      const mine = g.home === U || g.away === U;
                      return (
                        <li key={g.id} className={cn('flex flex-wrap sm:flex-nowrap items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 sm:py-2 text-sm', mine && 'bg-ice/5')}>
                          <span className="hidden sm:inline w-16 text-[11px] text-muted shrink-0">{g.kind === 'playoff' ? 'ПО' : `#${g.id}`}</span>
                          <span className="flex items-center gap-1.5 sm:gap-2 flex-1 sm:w-[30%] sm:flex-none min-w-0 justify-end">
                            <span className="truncate sm:hidden font-semibold">{s.teams[g.away].short}</span>
                            <span className="truncate hidden sm:inline">{s.teams[g.away].name}</span>
                            <TeamLogo team={s.teams[g.away]} size={22} />
                          </span>
                          {r ? (
                            <button onClick={() => ui.openGame(g.id)} className="font-display text-base sm:text-lg tabular w-16 sm:w-20 text-center hover:text-ice cursor-pointer shrink-0">
                              {r.awayScore}:{r.homeScore}
                              <span className="text-[10px] text-muted ml-0.5">{scoreTag(g)}</span>
                            </button>
                          ) : (
                            <span className="w-12 sm:w-20 text-center text-muted text-xs shrink-0">VS</span>
                          )}
                          <span className="flex items-center gap-1.5 sm:gap-2 flex-1 sm:w-[30%] sm:flex-none min-w-0">
                            <TeamLogo team={s.teams[g.home]} size={22} />
                            <span className="truncate sm:hidden font-semibold">{s.teams[g.home].short}</span>
                            <span className="truncate hidden sm:inline">{s.teams[g.home].name}</span>
                          </span>
                          <span className="w-full sm:w-auto sm:ml-auto flex items-center justify-end gap-2">
                            {getDerby(s.teams[g.home], s.teams[g.away]) && <Tag tone="warn" className="hidden md:inline-flex">🔥 {getDerby(s.teams[g.home], s.teams[g.away])!.title}</Tag>}
                            {mine && !r && isToday && (
                              <Button size="sm" variant="primary" onClick={() => onPlay(g)}>
                                Играть
                              </Button>
                            )}
                            {mine && !r && (
                              <Button size="sm" variant="ghost" onClick={() => ui.openGame(g.id)}>
                                Разбор ЧБ
                              </Button>
                            )}
                            {mine && r && <Tag color="#8FD8F0">ваш матч</Tag>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </Panel>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
