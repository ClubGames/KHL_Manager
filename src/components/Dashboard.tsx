import { nextUserGame, regularSeasonLength, seasonDate } from '../game/schedule';
import { rankConference, simulateDay, simulateDays, simulateToNextUserGame, useGame } from '../game/state';
import { isGoalie, isSkater, payroll, points } from '../game/ratings';
import type { Game, NewsItem, Team } from '../types';
import { Bar, Button, Icon, money, Panel, ResultPill, Stat, Tag, TeamLogo, useUI } from './ui';
import { boardOnTrack } from '../game/board';

function TeamBlock({ team, place, right }: { team: Team; place: number | null; right?: boolean }) {
  const r = team.record;
  return (
    <div className={`flex items-center gap-3 ${right ? 'flex-row-reverse text-right' : ''}`}>
      <TeamLogo team={team} size={56} />
      <div className="min-w-0">
        <div className="font-display text-xl uppercase leading-tight truncate">{team.name}</div>
        <div className="text-xs text-muted">{team.city}</div>
        <div className="text-xs text-text/80 mt-0.5 tabular">
          {r.gp} игр · {r.points} очк.{place ? ` · ${place}-е место` : ''}
        </div>
      </div>
    </div>
  );
}

const NEWS_ICON: Record<NewsItem['type'], string> = { result: 'puck', injury: 'injury', trade: 'trade', offer: 'trade', info: 'news', milestone: 'trophy', playoff: 'trophy' };
const NEWS_COLOR: Record<NewsItem['type'], string> = { result: '#8FD8F0', injury: '#E5323E', trade: '#F2B544', offer: '#F2B544', info: '#93A4BC', milestone: '#3FCF8E', playoff: '#3FCF8E' };

export function Dashboard({ onPlay }: { onPlay: (g: Game) => void }) {
  const s = useGame()!;
  const ui = useUI();
  const U = s.teams[s.userTeamId];
  const P = s.players;
  const today = s.schedule[s.day] ?? [];
  const userGame = today.find((g) => !g.played && (g.home === U.id || g.away === U.id)) ?? null;
  const upcoming = userGame ?? nextUserGame(s, U.id);
  const conf = rankConference(s, U.conference);
  const place = conf.indexOf(U) + 1;
  const r = U.record;
  const skaters = U.players.map((id) => P[id]).filter(isSkater);
  const topPts = [...skaters].sort((a, b) => points(b) - points(a)).slice(0, 5);
  const goalies = U.players.map((id) => P[id]).filter(isGoalie).sort((a, b) => b.stats.wins - a.stats.wins);
  const injured = U.players.map((id) => P[id]).filter((p) => p.injury);
  const alive = s.playoffs ? s.playoffs.series.filter((x) => (x.high === U.id || x.low === U.id) && !x.done) : [];
  const eliminated = s.phase === 'playoffs' && alive.length === 0;
  const cap = s.league.salaryCap;
  const fol = payroll(U.players, P);
  const topSal = [...U.players].sort((a, b) => P[b].contract.salary - P[a].contract.salary).slice(0, 4);
  const onTrack = boardOnTrack(s);
  const dayLabel = (g: Game) => (g.day === s.day ? 'Сегодня' : g.day === s.day + 1 ? 'Завтра' : `Через ${g.day - s.day} дн.`);
  const series = upcoming?.seriesId != null ? s.playoffs?.series.find((x) => x.id === upcoming.seriesId) : null;

  const simToNext = () => {
    const res = simulateToNextUserGame();
    if (res === 'offseason') ui.nav('offseason');
  };
  const simGame = () => ui.confirm({ title: 'Симулировать матч?', text: 'Результат будет рассчитан по текущим звеньям без просмотра матча.', confirmLabel: 'Симулировать', onYes: () => simulateDay(true) });
  const simWeek = () => ui.confirm({ title: 'Симулировать 5 дней?', text: 'Все матчи, включая матчи вашей команды, будут рассчитаны автоматически.', confirmLabel: 'Симулировать', onYes: () => simulateDays(5) });

  return (
    <div className="space-y-4 fade-in">
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
        <Stat label="Дата" value={seasonDate(s.day, regularSeasonLength(s.schedule), s.league.season)} sub={`${s.phase === 'playoffs' ? 'Плей-офф' : s.phase === 'offseason' ? 'Межсезонье' : `День ${s.day + 1}`}`} />
        <Stat label="Матчи" value={`${r.gp} / ${s.league.gamesPerTeam}`} sub={`сезон ${s.league.season}`} />
        <Stat label="Очки" value={r.points} sub={`${place}-е место, ${U.conference}`} color="#8FD8F0" />
        <Stat label="Баланс" value={`${r.w + r.otw + r.sow}−${r.otl + r.sol + r.l}`} sub={`ВО ${r.otw} · ВБ ${r.sow} · ПО ${r.otl}`} />
        <Stat label="Форма" value={<span className="flex gap-1 text-base">{r.last.slice(-5).map((c, i) => <ResultPill key={i} code={c} />)}</span>} sub={r.streakType ? (r.streakType === 'W' ? `Победная серия: ${r.streak}` : `Серия поражений: ${r.streak}`) : '—'} />
        <Stat label="Бюджет" value={money(U.budget)} sub={`ФОТ ${money(fol)}`} color="#3FCF8E" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 space-y-4">
          <Panel title={userGame ? 'Матч сегодня' : 'Следующий матч'} right={upcoming && <Tag color={upcoming.kind === 'playoff' ? '#F2B544' : '#93A4BC'}>{upcoming.kind === 'playoff' ? 'Плей-офф' : 'Регулярный чемпионат'} · {dayLabel(upcoming)}</Tag>}>
            {upcoming ? (
              <>
                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 py-2">
                  <TeamBlock team={s.teams[upcoming.home]} place={rankConference(s, s.teams[upcoming.home].conference).findIndex((t) => t.id === upcoming.home) + 1} />
                  <div className="text-center px-2">
                    <div className="text-[11px] uppercase tracking-widest text-muted">{upcoming.home === U.id ? 'Дома' : 'В гостях'}</div>
                    <div className="font-display text-3xl text-muted">VS</div>
                    {series && (
                      <div className="text-xs text-amber tabular">
                        Серия {series.wins[0]}:{series.wins[1]} · матч {series.games.length}
                      </div>
                    )}
                  </div>
                  <TeamBlock team={s.teams[upcoming.away]} right place={rankConference(s, s.teams[upcoming.away].conference).findIndex((t) => t.id === upcoming.away) + 1} />
                </div>
                <div className="flex flex-wrap gap-2 pt-3 border-t border-line">
                  {eliminated ? (
                    <Button variant="primary" onClick={simToNext}>
                      <Icon name="fast" /> Симулировать плей-офф до конца
                    </Button>
                  ) : userGame ? (
                    <>
                      <Button variant="primary" size="lg" onClick={() => onPlay(userGame)}>
                        <Icon name="play" /> Играть матч
                      </Button>
                      <Button size="lg" onClick={simGame}>
                        <Icon name="fast" /> Симулировать матч
                      </Button>
                      <Button size="lg" variant="ghost" onClick={() => ui.nav('lines')}>
                        Звенья
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button variant="primary" size="lg" onClick={simToNext}>
                        <Icon name="fast" /> Симулировать до матча
                      </Button>
                      <Button size="lg" onClick={() => simulateDay(true)}>
                        Симулировать день
                      </Button>
                    </>
                  )}
                  {!eliminated && (
                    <Button size="lg" variant="ghost" onClick={simWeek}>
                      5 дней
                    </Button>
                  )}
                  <Button size="lg" variant="ghost" onClick={() => ui.nav('schedule')}>
                    Календарь
                  </Button>
                </div>
                {eliminated && <div className="mt-3 text-xs text-amber">Команда выбыла из борьбы за Кубок Гагарина. Досимулируйте плей-офф, чтобы перейти к межсезонью.</div>}
              </>
            ) : (
              <div className="text-muted text-sm">Матчей не осталось. Перейдите в раздел «Межсезонье», чтобы начать новый сезон.</div>
            )}
          </Panel>

          <Panel title="Матчи дня" right={<span className="text-xs text-muted">{today.filter((g) => g.played).length} / {today.length} сыграно</span>}>
            {today.length === 0 ? (
              <div className="text-muted text-sm">Сегодня матчей нет.</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {today.map((g) => {
                  const res = g.result;
                  const mine = g.home === U.id || g.away === U.id;
                  return (
                    <button key={g.id} onClick={() => res && ui.openGame(g.id)} className={`flex items-center justify-between gap-2 px-3 py-2 rounded-sm border text-sm transition-colors ${mine ? 'border-ice/50 bg-ice/5' : 'border-line bg-panel2/40'} ${res ? 'hover:bg-panel2' : ''}`}>
                      <span className="flex items-center gap-2 min-w-0">
                        <TeamLogo team={s.teams[g.away]} size={22} />
                        <span className="truncate">{s.teams[g.away].short}</span>
                      </span>
                      <span className="font-display text-base tabular text-text px-1">{res ? `${res.awayScore}:${res.homeScore}` : '—'}{res?.so ? ' Б' : res?.ot ? ' ОТ' : ''}</span>
                      <span className="flex items-center gap-2 min-w-0 flex-row-reverse">
                        <TeamLogo team={s.teams[g.home]} size={22} />
                        <span className="truncate">{s.teams[g.home].short}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Panel>

          <Panel title="Лента новостей" right={<Button size="sm" variant="ghost" onClick={() => ui.nav('roster')}>Состав →</Button>}>
            <ul className="divide-y divide-line/70">
              {s.news.slice(0, 14).map((n) => (
                <li key={n.id}>
                  <button onClick={() => n.game && ui.openGame(n.game)} className={`w-full text-left flex items-start gap-3 py-2 text-sm ${n.game ? 'hover:text-ice' : ''}`}>
                    <span className="mt-0.5" style={{ color: NEWS_COLOR[n.type] }}>
                      <Icon name={NEWS_ICON[n.type]} />
                    </span>
                    <span className="flex-1 text-text/90">{n.text}</span>
                    <span className="text-[11px] text-muted whitespace-nowrap">день {n.day + 1}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title={`${U.conference} · топ-8`} right={<Button size="sm" variant="ghost" onClick={() => ui.nav('standings')}>Все →</Button>}>
            <ol className="space-y-1 text-sm">
              {conf.slice(0, 8).map((t, i) => (
                <li key={t.id} className={`flex items-center gap-2 px-2 py-1 rounded-sm ${t.id === U.id ? 'bg-ice/10 text-ice' : ''}`}>
                  <span className="w-4 text-xs text-muted tabular">{i + 1}</span>
                  <TeamLogo team={t} size={20} />
                  <span className="flex-1 truncate">{t.short}</span>
                  <span className="text-xs text-muted tabular">{t.record.gp}</span>
                  <span className="font-display tabular w-8 text-right">{t.record.points}</span>
                </li>
              ))}
              {place > 8 && (
                <li className="flex items-center gap-2 px-2 py-1 rounded-sm bg-ice/10 text-ice text-xs">
                  <span className="w-4 tabular">…{place}</span>
                  <TeamLogo team={U} size={18} />
                  <span className="flex-1 truncate">{U.short}</span>
                  <span className="font-display tabular">{r.points}</span>
                </li>
              )}
            </ol>
          </Panel>

          <Panel title="Лидеры команды">
            <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Очки (шайбы + передачи)</div>
            <ol className="space-y-1 text-sm">
              {topPts.map((p) => (
                <li key={p.id}>
                  <button onClick={() => ui.openPlayer(p.id)} className="w-full flex items-center gap-2 hover:text-ice">
                    <span className="font-display text-xs text-muted w-4">{p.number}</span>
                    <span className="flex-1 truncate text-left">{p.name}</span>
                    <span className="text-xs text-muted tabular">{p.stats.goals}+{p.stats.assists}</span>
                    <span className="font-display tabular w-6 text-right">{points(p)}</span>
                  </button>
                </li>
              ))}
            </ol>
            <div className="text-[11px] uppercase tracking-wider text-muted mt-3 mb-1">Вратари</div>
            <ol className="space-y-1 text-sm">
              {goalies.map((p) => (
                <li key={p.id}>
                  <button onClick={() => ui.openPlayer(p.id)} className="w-full flex items-center gap-2 hover:text-ice">
                    <span className="flex-1 truncate text-left">{p.name}</span>
                    <span className="text-xs text-muted tabular">{p.stats.wins}−{p.stats.losses}−{p.stats.otl}</span>
                    <span className="font-display tabular w-12 text-right">{p.stats.shotsAgainst ? ((p.stats.saves / p.stats.shotsAgainst) * 100).toFixed(1) + '%' : '—'}</span>
                  </button>
                </li>
              ))}
            </ol>
          </Panel>

          <Panel title="Задача руководства" right={onTrack === null ? <Tag color="#93A4BC">сезон только начался</Tag> : onTrack ? <Tag color="#3FCF8E">в графике</Tag> : <Tag color="#E5323E">под угрозой</Tag>}>
            <div className="font-display text-lg leading-tight" data-board-goal>{s.board.text}</div>
            <div className="text-xs text-muted mt-1">Состав оценён как №{s.board.rank} в лиге по силе. Выполнение приносит премию в бюджет, провал снижает доверие.</div>
            <div className="flex items-center gap-3 mt-3 text-xs">
              <span className="text-muted whitespace-nowrap">Доверие</span>
              <Bar value={s.board.confidence} color={s.board.confidence >= 60 ? '#3FCF8E' : s.board.confidence >= 30 ? '#F2B544' : '#E5323E'} className="flex-1" />
              <span className="tabular w-7 text-right">{s.board.confidence}</span>
            </div>
          </Panel>

          <Panel title="Финансы">
            <div className="flex justify-between text-sm">
              <span className="text-muted">ФОТ</span>
              <span className="tabular">{money(fol)} / {money(cap)}</span>
            </div>
            <div className="h-2 bg-line rounded-full overflow-hidden mt-1">
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, (fol / cap) * 100)}%`, background: fol / cap > 0.95 ? '#E5323E' : '#3FCF8E' }} />
            </div>
            <ul className="mt-3 space-y-1 text-xs">
              {topSal.map((id) => (
                <li key={id} className="flex justify-between">
                  <button onClick={() => ui.openPlayer(id)} className="truncate hover:text-ice text-left">{P[id].name}</button>
                  <span className="tabular text-muted">{money(P[id].contract.salary)}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Травмы" right={injured.length ? <Tag color="#E5323E">{injured.length}</Tag> : <Tag color="#3FCF8E">Здоровы</Tag>}>
            {injured.length === 0 ? (
              <div className="text-sm text-muted">Все игроки доступны.</div>
            ) : (
              <ul className="space-y-1 text-sm">
                {injured.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2">
                    <button onClick={() => ui.openPlayer(p.id)} className="truncate text-left hover:text-ice">
                      {p.name}
                    </button>
                    <span className="text-xs text-muted whitespace-nowrap">{p.injury!.name} · {p.injury!.games} матчей</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {s.offers.length > 0 && (
            <Panel title="Предложения обмена" className="border-amber/40">
              <div className="text-sm">Входящих предложений: {s.offers.length}</div>
              <Button size="sm" className="mt-2" onClick={() => ui.nav('trades')}>
                Перейти к обменам
              </Button>
            </Panel>
          )}


        </div>
      </div>
    </div>
  );
}
