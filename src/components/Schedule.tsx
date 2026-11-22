import { useState } from 'react';
import type { Game } from '../types';
import { regularSeasonLength, seasonDate } from '../game/schedule';
import { roundName, useGame } from '../game/state';
import { Button, Empty, Modal, Panel, TeamLogo, Tag, useUI } from './ui';
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
  return (
    <Modal open onClose={onClose} width="max-w-2xl">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <div className="flex items-center gap-3">
          <TeamLogo team={A} size={44} />
          <div>
            <div className="font-display text-lg uppercase leading-tight">{A.name}</div>
            <div className="text-[11px] text-muted">гости</div>
          </div>
        </div>
        <div className="text-center">
          <div className="font-display text-4xl tabular leading-none">{r ? `${r.awayScore}:${r.homeScore}` : '—'}</div>
          <div className="text-[11px] text-muted mt-1">{r ? (r.so ? 'победа по буллитам' : r.ot ? 'овертайм' : 'основное время') : 'не сыгран'}{game.kind === 'playoff' && ser ? ` · матч ${ser.games.indexOf(game.id) + 1} · серия ${ser.wins[0]}:${ser.wins[1]}` : ''}</div>
        </div>
        <div className="flex items-center gap-3 justify-end text-right">
          <div>
            <div className="font-display text-lg uppercase leading-tight">{H.name}</div>
            <div className="text-[11px] text-muted">хозяева</div>
          </div>
          <TeamLogo team={H} size={44} />
        </div>
      </div>
      <div className="text-center text-[11px] text-muted mt-1">
        {seasonDate(game.day, regularSeasonLength(s.schedule), s.league.season)} · {game.kind === 'playoff' ? roundName(s.playoffs?.round ?? 0) : 'Регулярный чемпионат'}
      </div>
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
                  <td className="text-right px-2">{r.homeStats.ppGoals}/{r.homeStats.ppChances}</td>
                  <td className="text-right px-2">{r.homeStats.pim}</td>
                  <td className="text-right pl-2">{r.homeStats.hits}</td>
                </tr>
              </tbody>
            </table>
          </div>
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
  const [filter, setFilter] = useState<'all' | 'mine' | 'po'>('all');
  const [showAll, setShowAll] = useState(false);
  const from = showAll ? 0 : Math.max(0, s.day - 4);
  const days = s.schedule
    .map((games, day) => ({ day, games }))
    .slice(from)
    .filter(({ games }) => {
      if (filter === 'mine') return games.some((g) => g.home === U || g.away === U);
      if (filter === 'po') return games.some((g) => g.kind === 'playoff');
      return true;
    });
  return (
    <div className="space-y-3 fade-in">
      <div className="flex items-center gap-2 flex-wrap">
        {(['all', 'mine', 'po'] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={cn('text-xs px-3 py-1.5 rounded-sm font-semibold', filter === f ? 'bg-accent text-white' : 'bg-panel2 text-muted hover:text-text')}>
            {f === 'all' ? 'Все матчи' : f === 'mine' ? 'Моя команда' : 'Плей-офф'}
          </button>
        ))}
        <span className="text-xs text-muted ml-auto">Сыграно {s.day} из {s.schedule.length} дней</span>
        {!showAll && (
          <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
            Показать с начала сезона
          </Button>
        )}
      </div>
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
            <Panel key={day} noPad className={cn(isToday && 'border-ice/50')} title={<span className={cn(isToday && 'text-ice')}>{seasonDate(day, regularSeasonLength(s.schedule), s.league.season)}{isToday ? ' · сегодня' : ''}</span>} right={<span className="text-xs text-muted">{games.some((g) => g.kind === 'playoff') ? 'Плей-офф' : 'Регулярный чемпионат'} · {filtered.length} матчей</span>}>
              <ul className="divide-y divide-line/60">
                {filtered.map((g) => {
                  const r = g.result;
                  const mine = g.home === U || g.away === U;
                  return (
                    <li key={g.id} className={cn('flex items-center gap-3 px-4 py-2 text-sm', mine && 'bg-ice/5')}>
                      <span className="w-16 text-[11px] text-muted shrink-0">{g.kind === 'playoff' ? 'ПО' : `#${g.id}`} </span>
                      <span className="flex items-center gap-2 w-[30%] min-w-0 justify-end">
                        <span className="truncate">{s.teams[g.away].name}</span>
                        <TeamLogo team={s.teams[g.away]} size={22} />
                      </span>
                      {r ? (
                        <button onClick={() => ui.openGame(g.id)} className="font-display text-lg tabular w-20 text-center hover:text-ice">
                          {r.awayScore}:{r.homeScore}
                          <span className="text-[10px] text-muted ml-0.5">{scoreTag(g)}</span>
                        </button>
                      ) : (
                        <span className="w-20 text-center text-muted text-xs">—</span>
                      )}
                      <span className="flex items-center gap-2 w-[30%] min-w-0">
                        <TeamLogo team={s.teams[g.home]} size={22} />
                        <span className="truncate">{s.teams[g.home].name}</span>
                      </span>
                      <span className="ml-auto flex items-center gap-2">
                        {mine && !r && isToday && (
                          <Button size="sm" variant="primary" onClick={() => onPlay(g)}>
                            Играть
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
    </div>
  );
}
