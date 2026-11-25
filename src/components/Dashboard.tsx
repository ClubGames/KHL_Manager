import { getSettings } from '../game/settings';
import { recentTeamForm } from '../game/coaching';
import { useState } from 'react';
import { nextUserGame, regularSeasonLength, seasonDate } from '../game/schedule';
import { rankConference, simulateDay, simulateDays, simulateToNextUserGame, store, useGame } from '../game/state';
import { LastResults, userGamesBetween } from './LastResults';
import { isGoalie, isSkater, points } from '../game/ratings';
import { getCapSummary } from '../game/cap';
import { countRosterLegionnaires, teamForeignLimit } from '../game/legionnaires';
import { isYouthPlayer } from '../game/training';
import { tradeWindow } from '../game/ai';
import { previewPowerPlay } from '../game/lineupCompare';
import { FORECHECK_INFO, freshnessTone, getTeamTactics, goalieFreshness } from '../game/chemistry';
import { getDerby } from '../game/derbies';
import { ensureFacilities, formatInjuryDays, injuryReturnDate } from '../game/medical';
import type { Game, NewsItem, Team } from '../types';
import { Bar, Button, Icon, money, Panel, PlayerFace, ResultPill, Stat, Tag, TeamLogo, useUI } from './ui';
import { LineupPreview } from './LineupPreview';
import { boardOnTrack } from '../game/board';
import { blockingTasks, buildInbox } from '../game/inbox';
import { InboxList } from './Inbox';
import { PressConferencePanel } from './PressConference';
import { DressingRoomPanel } from './DressingRoom';
import { PreseasonPanel } from './Preseason';
import { TeamLink } from './TeamInfo';
import { LG } from '../brand';

function TeamBlock({ team, place, right }: { team: Team; place: number | null; right?: boolean }) {
  const r = team.record;
  const ui = useUI();
  return (
    <button type="button" onClick={() => ui.openTeam(team.id)} title={`О клубе «${team.name}»`} data-team-link={team.id} className={`flex flex-col sm:flex-row items-center sm:items-center gap-1.5 sm:gap-3 min-w-0 text-center rounded-md hover:bg-panel2/60 p-1 -m-1 transition-colors ${right ? 'sm:flex-row-reverse sm:text-right' : 'sm:text-left'}`}>
      <TeamLogo team={team} size={46} className="sm:w-14 sm:h-14" />
      <div className="min-w-0 max-w-full">
        <div className="font-display text-base sm:text-xl uppercase leading-tight truncate">{team.name}</div>
        <div className="text-[11px] sm:text-xs text-muted truncate">{team.city}</div>
        <div className="text-[11px] sm:text-xs text-text/80 mt-0.5 tabular">
          {r.gp} и · {r.points} очк.{place ? ` · #${place}` : ''}
        </div>
      </div>
    </button>
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
  const injured = U.players.map((id) => P[id]).filter((p) => p && (p.injury || p.inLtir));
  const regLen = regularSeasonLength(s.schedule);
  const fac = ensureFacilities(U);
  const curRoundSeries = s.playoffs
    ? s.playoffs.series.find((x) => x.round === s.playoffs!.round && (x.high === U.id || x.low === U.id)) ?? null
    : null;
  const waitingNextRound = s.phase === 'playoffs' && !!curRoundSeries?.done && curRoundSeries.winner === U.id;
  const eliminated = s.phase === 'playoffs' && (!curRoundSeries || (curRoundSeries.done && curRoundSeries.winner !== U.id));
  const [showTactics, setShowTactics] = useState(false);
  const cap = s.league.salaryCap;
  const capInfo = getCapSummary(s, U.id);
  const fol = capInfo.totalPayroll;
  const fl = teamForeignLimit(U, s.league.foreignLimit);
  const legCount = countRosterLegionnaires(U.players, P);
  const youthCount = U.players.filter((id) => isYouthPlayer(P[id])).length;
  const tw = tradeWindow(s);
  const topSal = [...U.players].sort((a, b) => P[b].contract.salary - P[a].contract.salary).slice(0, 4);
  const onTrack = boardOnTrack(s);
  const teamForm = recentTeamForm(s, U.id);
  const dayLabel = (g: Game) => (g.day === s.day ? 'Сегодня' : g.day === s.day + 1 ? 'Завтра' : `Через ${g.day - s.day} дн.`);
  const series = upcoming?.seriesId != null ? s.playoffs?.series.find((x) => x.id === upcoming.seriesId) : null;
  const upcomingOppId = upcoming ? (upcoming.home === U.id ? upcoming.away : upcoming.home) : undefined;
  const ppQuick = upcomingOppId ? previewPowerPlay(s, U.id, upcomingOppId)[0] : null;

  const [simNote, setSimNote] = useState<string | null>(null);
  const inbox = buildInbox(s);
  /** Before fast simulation: make sure nothing important is left unanswered. */
  const guarded = (label: string, run: () => void) => {
    const open = blockingTasks(s);
    if (!open.length || !getSettings().simConfirm) return run();
    ui.confirm({
      title: 'Есть нерешённые задачи',
      text: `Во входящих: ${open.slice(0, 3).map((t) => t.title).join('; ')}${open.length > 3 ? '…' : ''}. ${label}?`,
      confirmLabel: 'Всё равно продолжить',
      onYes: run,
    });
  };
  /** Fast simulation never hides the club's results: they are listed, and a single game opens its report. */
  const [simulated, setSimulated] = useState<number[]>([]);
  const track = (run: () => void, openSingle = false) => {
    const from = store.get()?.day ?? s.day;
    run();
    const after = store.get();
    if (!after) return;
    const games = userGamesBetween(after, from, after.day);
    if (games.length) setSimulated(games.map((g) => g.id));
    if (openSingle && games.length === 1 && getSettings().simOpenReport) ui.openGame(games[0].id);
  };
  const simDay = () => track(() => simulateDay(true), true);
  const simToNext = () =>
    guarded('Симулировать до следующего матча', () => {
      const box: { res: ReturnType<typeof simulateToNextUserGame> } = { res: 'stalled' };
      track(() => { box.res = simulateToNextUserGame(true); });
      const res = box.res;
      if (res === 'offseason') ui.nav('offseason');
      setSimNote(res === 'inbox' ? 'Симуляция остановлена: во входящих новая задача.' : null);
    });
  const simGame = () =>
    !getSettings().simConfirm
      ? simDay()
      : blockingTasks(s).length
      ? guarded('Симулировать матч по текущим звеньям', simDay)
      : ui.confirm({ title: 'Симулировать матч?', text: 'Результат будет рассчитан по текущим звеньям без просмотра матча. Итог и повторы голов откроются сразу после симуляции.', confirmLabel: 'Симулировать', onYes: simDay });
  const simWeek = () =>
    guarded('Симулировать 5 дней', () => {
      const box: { res: ReturnType<typeof simulateDays> } = { res: { days: 0, stop: 'done' } };
      track(() => { box.res = simulateDays(5); });
      const res = box.res;
      setSimNote(res.stop === 'inbox' ? `Симуляция остановлена через ${res.days} дн.: во входящих новая задача.` : null);
    });

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

      <LastResults s={s} simulated={simulated} onDismiss={() => setSimulated([])} />
      {s.press && <PressConferencePanel />}
      <DressingRoomPanel />
      <PreseasonPanel />
      {(simNote || inbox.length > 0) && (
        <Panel title={<span className="flex items-center gap-2"><Icon name="bell" /> Входящие ({inbox.length})</span>} right={<Button size="sm" variant="ghost" onClick={() => ui.nav('inbox')}>Все →</Button>} data-dashboard-inbox>
          {simNote && <div className="mb-2 text-xs text-amber" data-sim-note>{simNote}</div>}
          <InboxList limit={4} compact />
        </Panel>
      )}

      <div className={`rounded-md border p-3 flex flex-wrap items-center justify-between gap-3 text-xs ${teamForm.crisis ? 'border-accent/60 bg-accent/10' : 'border-line bg-panel'}`} data-team-management-link>
        <div><b>{teamForm.crisis ? `Кризис: ${teamForm.losses} поражений в ${teamForm.played} матчах.` : 'Управляйте не только звеньями.'}</b><span className="text-muted ml-2">Штаб, тренировки, восстановление и работа с раздевалкой — в разделе «Клуб».</span></div>
        <Button size="sm" variant={teamForm.crisis ? 'primary' : 'secondary'} onClick={() => ui.nav('management')}>Управление командой →</Button>
      </div>

      {capInfo.over && (
        <div className="rounded-md border border-accent/60 bg-accent/12 p-3 text-xs flex flex-wrap items-center justify-between gap-2">
          <div>
            <b className="text-accent uppercase">
              {capInfo.sanctionsActive
                ? `⛔ Санкции ${LG()} за превышение потолка зарплат (−${capInfo.pointsDeducted} очк.)`
                : `⚠ Превышение потолка зарплат на ${money(capInfo.excess)} (льготный период: ${capInfo.graceDaysLeft} дн.)`}
            </b>
            <span className="text-text/85 ml-2">
              {capInfo.sanctionsActive
                ? `Заблокировано игроков: ${capInfo.suspendedIds.length} · штраф ${money(capInfo.dailyFine)}/день.`
                : 'Разгрузите ведомость через обмен или расторжение контракта до введения жёстких санкций!'}
            </span>
          </div>
          <div className="flex gap-1.5">
            <Button size="sm" variant="primary" onClick={() => ui.nav('contracts')}>Контракты</Button>
            <Button size="sm" onClick={() => ui.nav('trades')}>Обмены</Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 space-y-4">
          <Panel title={userGame ? 'Матч сегодня' : 'Следующий матч'} right={upcoming && <Tag color={upcoming.kind === 'playoff' ? '#F2B544' : '#93A4BC'}>{upcoming.kind === 'playoff' ? 'Плей-офф' : 'Регулярный чемпионат'} · {dayLabel(upcoming)}</Tag>}>
            {upcoming ? (
              <>
                {(() => {
                  const dby = getDerby(s.teams[upcoming.home], s.teams[upcoming.away]);
                  return dby ? (
                    <div
                      data-dashboard-derby
                      className="mb-2 rounded-md border border-gold/50 bg-gold/10 px-3 py-2 text-xs flex flex-wrap items-center justify-between gap-2"
                    >
                      <div>
                        <b className="uppercase font-display tracking-wider text-gold">
                          🔥 {dby.title}
                        </b>
                        <span className="text-muted ml-2">{dby.subtitle}</span>
                      </div>
                      <span className="text-[11px] text-gold font-semibold">
                        Аншлаг +{money(dby.gateBonus)} · ×{dby.moraleMult} мораль и Совет
                      </span>
                    </div>
                  ) : null;
                })()}
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

                {ppQuick && (
                  <div className="my-2 rounded-md border border-line/80 bg-bg/45 px-3 py-2 text-xs flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="text-ice font-semibold">1-я ЧБ на матч: </span>
                      <span className="text-text/90">
                        {ppQuick.slots.map((sl) => sl.player?.name).filter(Boolean).join(' · ')}
                      </span>
                    </div>
                    <span className="text-muted shrink-0">
                      Прогноз ЧБ: <b className="text-amber">{ppQuick.expectedPpPct}%</b>
                    </span>
                  </div>
                )}

                <div className="pt-3 border-t border-line space-y-2 sm:space-y-0 sm:flex sm:flex-wrap sm:gap-2">
                  {eliminated ? (
                    <Button variant="primary" className="w-full sm:w-auto" onClick={simToNext}>
                      <Icon name="fast" /> Симулировать плей-офф до конца
                    </Button>
                  ) : userGame ? (
                    <>
                      <Button variant="primary" size="lg" className="w-full sm:w-auto" onClick={() => onPlay(userGame)}>
                        <Icon name="play" /> Играть матч
                      </Button>
                      <div className="grid grid-cols-2 gap-2 sm:contents">
                        <Button size="lg" className="w-full sm:w-auto" onClick={simGame}>
                          <Icon name="fast" /> Симулировать матч
                        </Button>
                        <Button size="lg" variant="ghost" className="w-full sm:w-auto border border-line sm:border-0" onClick={() => ui.nav('lines')}>
                          Звенья
                        </Button>
                        <Button size="lg" variant="ghost" className="w-full sm:w-auto border border-line sm:border-0" onClick={simWeek}>
                          5 дней
                        </Button>
                        <Button size="lg" variant="secondary" className="w-full sm:w-auto" onClick={() => setShowTactics((v) => !v)}>
                          {showTactics ? 'Скрыть разбор' : 'Сравнение ЧБ'}
                        </Button>
                        <Button size="lg" variant="ghost" className="col-span-2 sm:col-span-1 w-full sm:w-auto border border-line sm:border-0" onClick={() => ui.nav('schedule')}>
                          Календарь
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <Button variant="primary" size="lg" className="w-full sm:w-auto" onClick={simToNext}>
                        <Icon name="fast" /> Симулировать до матча
                      </Button>
                      <div className="grid grid-cols-2 gap-2 sm:contents">
                        <Button size="lg" className="w-full sm:w-auto" onClick={simDay}>
                          Симулировать день
                        </Button>
                        <Button size="lg" variant="ghost" className="w-full sm:w-auto border border-line sm:border-0" onClick={simWeek}>
                          5 дней
                        </Button>
                        <Button size="lg" variant="secondary" className="w-full sm:w-auto" onClick={() => setShowTactics((v) => !v)}>
                          {showTactics ? 'Скрыть разбор' : 'Сравнение ЧБ'}
                        </Button>
                        <Button size="lg" variant="ghost" className="w-full sm:w-auto border border-line sm:border-0" onClick={() => ui.nav('schedule')}>
                          Календарь
                        </Button>
                      </div>
                    </>
                  )}
                </div>
                {showTactics && upcomingOppId && (
                  <div className="mt-3">
                    <LineupPreview
                      state={s}
                      leftTeamId={U.id}
                      initialOpponentId={upcomingOppId}
                      allowPickOpponent={false}
                      onPlayer={(id) => ui.openPlayer(id)}
                    />
                  </div>
                )}
                {eliminated && <div className="mt-3 text-xs text-amber">Команда выбыла из борьбы за Кубок Гагарина. Досимулируйте плей-офф, чтобы перейти к межсезонью.</div>}
              </>
            ) : waitingNextRound ? (
              <div className="space-y-3" data-playoff-wait>
                <div className="text-sm text-ok font-medium">
                  ✓ Вы выиграли серию ({curRoundSeries!.wins[0]}:{curRoundSeries!.wins[1]}) и вышли в следующий раунд Кубка Гагарина! Дождитесь завершения остальных пар раунда.
                </div>
                <div className="flex flex-wrap gap-2 pt-2 border-t border-line">
                  <Button variant="primary" size="lg" onClick={simToNext}>
                    <Icon name="fast" /> Симулировать до следующего раунда
                  </Button>
                  <Button size="lg" onClick={simDay}>
                    Симулировать день
                  </Button>
                  <Button size="lg" variant="ghost" onClick={() => ui.nav('standings')}>
                    Сетка плей-офф
                  </Button>
                </div>
              </div>
            ) : eliminated ? (
              <div className="space-y-3" data-playoff-eliminated>
                <div className="text-sm text-amber">
                  Ваша команда завершила выступление в этом розыгрыше сезона. Досимулируйте оставшиеся матчи Кубка Гагарина, чтобы перейти в раздел «Межсезонье» (Ярмарка юниоров {LG()}, продление контрактов и старт нового сезона).
                </div>
                <div className="flex flex-wrap gap-2 pt-2 border-t border-line">
                  <Button variant="primary" size="lg" onClick={simToNext}>
                    <Icon name="fast" /> Досимулировать плей-офф и перейти в межсезонье
                  </Button>
                  <Button size="lg" onClick={simDay}>
                    Симулировать день
                  </Button>
                  <Button size="lg" variant="ghost" onClick={() => ui.nav('standings')}>
                    Сетка плей-офф
                  </Button>
                </div>
              </div>
            ) : s.phase === 'season' ? (
              <div className="space-y-3" data-regular-finish>
                <div className="text-sm text-text/90">
                  Ваша команда провела все матчи регулярного чемпионата. Остальные клубы доигрывают календарь — после этого определятся участники плей-офф Кубка Гагарина.
                </div>
                <div className="flex flex-wrap gap-2 pt-2 border-t border-line">
                  <Button variant="primary" size="lg" onClick={simToNext}>
                    <Icon name="fast" /> Досимулировать регулярку
                  </Button>
                  <Button size="lg" onClick={simDay}>
                    Симулировать день
                  </Button>
                  <Button size="lg" variant="ghost" onClick={() => ui.nav('standings')}>
                    Таблица
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3" data-offseason-cta>
                <div className="text-sm text-text/90">
                  Сезон <b className="text-ice">{s.league.season}</b> завершён! В разделе <b className="text-gold">«Межсезонье»</b> вас ждут итоги Кубка Гагарина, Ярмарка юниоров {LG()}, продление контрактов и переход в новый сезон.
                </div>
                <div className="flex flex-wrap gap-2 pt-2 border-t border-line">
                  <Button variant="primary" size="lg" onClick={() => ui.nav('offseason')}>
                    <Icon name="trophy" /> Перейти в «Межсезонье»
                  </Button>
                  <Button size="lg" variant="secondary" onClick={() => ui.nav('contracts')}>
                    Контракты
                  </Button>
                  <Button size="lg" variant="secondary" onClick={() => ui.nav('market')}>
                    Рынок агентов
                  </Button>
                </div>
              </div>
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
                    <div key={g.id} onClick={() => res && ui.openGame(g.id)} className={`flex items-center justify-between gap-2 px-3 py-2 rounded-sm border text-sm transition-colors ${mine ? 'border-ice/50 bg-ice/5' : 'border-line bg-panel2/40'} ${res ? 'hover:bg-panel2 cursor-pointer' : ''}`}>
                      <TeamLink team={s.teams[g.away]} size={22} className="gap-2" />
                      <span className="font-display text-base tabular text-text px-1">{res ? `${res.awayScore}:${res.homeScore}` : '—'}{res?.so ? ' Б' : res?.ot ? ' ОТ' : ''}</span>
                      <TeamLink team={s.teams[g.home]} size={22} className="gap-2 flex-row-reverse" />
                    </div>
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
                <li key={t.id} onClick={() => ui.openTeam(t.id)} title={`О клубе «${t.name}»`} className={`flex items-center gap-2 px-2 py-1 rounded-sm cursor-pointer hover:bg-panel2 ${t.id === U.id ? 'bg-ice/10 text-ice' : ''}`}>
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
                    <PlayerFace face={p.face} name={p.name} number={p.number} team={U} size={24} />
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
                    <PlayerFace face={p.face} name={p.name} number={p.number} team={U} size={24} />
                    <span className="flex-1 truncate text-left">{p.name}</span>
                    <span className="text-[10px] tabular" style={{ color: freshnessTone(goalieFreshness(p)).color }}>
                      свеж. {goalieFreshness(p)}%
                    </span>
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
            <div className="flex items-center gap-3 mt-2 text-xs" data-fans>
              <span className="text-muted whitespace-nowrap">Болельщики</span>
              <Bar value={s.fans ?? 60} color={(s.fans ?? 60) >= 60 ? '#8FD8F0' : (s.fans ?? 60) >= 35 ? '#F2B544' : '#E5323E'} className="flex-1" />
              <span className="tabular w-7 text-right">{Math.round(s.fans ?? 60)}</span>
            </div>
            <div className="text-[11px] text-muted mt-1">Поддержка трибун влияет на кассу домашних матчей; её двигают результаты, пресс-конференции и предсезонные трофеи.</div>
          </Panel>

          <Panel title="Регламент и финансы">
            <div className="flex justify-between text-sm">
              <span className="text-muted">ФОТ</span>
              <span className={`tabular ${fol > cap ? 'text-accent font-semibold' : ''}`}>{money(fol)} / {money(cap)}</span>
            </div>
            <div className="h-2 bg-line rounded-full overflow-hidden mt-1">
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, (fol / cap) * 100)}%`, background: fol > cap ? '#E5323E' : fol / cap > 0.95 ? '#F2B544' : '#3FCF8E' }} />
            </div>
            <div className="mt-2.5 pt-2 border-t border-line/60 space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-muted">Легионеры</span>
                <span className="tabular text-ice">{fl !== null ? `${legCount} / ${fl}` : `${legCount} (без лим.)`}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Окно обменов</span>
                <span className={tw.open ? 'text-ok' : 'text-amber'}>{tw.windowTitle}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Молодёжь U23</span>
                <button onClick={() => ui.nav('roster')} className="text-ice hover:underline">{youthCount} игр. (планы →)</button>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Тактика / Капитан</span>
                <button onClick={() => ui.nav('lines')} className="text-gold hover:underline truncate max-w-[165px]">
                  {FORECHECK_INFO[getTeamTactics(U).forecheck].short}
                  {U.captainId && P[U.captainId] ? ` · К: ${P[U.captainId].name.split(' ').slice(-1)[0]}` : ''}
                </button>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Штаб / Арена</span>
                <button onClick={() => ui.nav('club')} className="text-ice hover:underline">
                  Мед.{fac.medical} · Акад.{fac.academy} · Ар.{fac.arena} →
                </button>
              </div>
              {(U.seasonGateRevenue ?? 0) > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted">Касса дома</span>
                  <span className="tabular text-ok">+{money(U.seasonGateRevenue!)}</span>
                </div>
              )}
              {capInfo.ltirRelief > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted">Льгота ДСБТ</span>
                  <span className="tabular text-ice">−{money(capInfo.ltirRelief)}</span>
                </div>
              )}
              {(s.waivers?.length ?? 0) > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted">Драфт отказов</span>
                  <button onClick={() => ui.nav('market')} className="text-amber hover:underline">{s.waivers!.length} на отказах →</button>
                </div>
              )}
            </div>
            <ul className="mt-3 pt-2 border-t border-line/60 space-y-1 text-xs">
              {topSal.map((id) => (
                <li key={id} className="flex justify-between">
                  <button onClick={() => ui.openPlayer(id)} className="truncate hover:text-ice text-left">{P[id].name}</button>
                  <span className="tabular text-muted">{money(P[id].contract.salary)}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Лазарет и ДСБТ" right={injured.length ? <Tag color="#E5323E">{injured.length}</Tag> : <Tag color="#3FCF8E">Здоровы</Tag>}>
            {injured.length === 0 ? (
              <div className="text-sm text-muted">Все игроки здоровы и доступны.</div>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {injured.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2">
                    <button onClick={() => ui.openPlayer(p.id)} className="truncate text-left hover:text-ice flex items-center gap-1.5">
                      <span className="truncate">{p.name}</span>
                      {p.inLtir && <span className="text-[9px] font-bold px-1 rounded bg-ice/20 text-ice shrink-0">ДСБТ</span>}
                      {p.playingThroughInjury && <span className="text-[9px] font-bold px-1 rounded bg-gold/25 text-gold shrink-0">УКОЛЫ</span>}
                    </button>
                    {p.injury ? (
                      <span className="text-xs text-muted whitespace-nowrap tabular">
                        {p.injury.name} · {formatInjuryDays(p.injury.days, true)} (до {injuryReturnDate(s.day, p.injury.days, regLen, s.league.season)})
                      </span>
                    ) : (
                      <span className="text-xs text-ok whitespace-nowrap">здоров · вывести из ДСБТ</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {s.allStar && (
            <Panel
              title={`★ Неделя Звёзд ${LG()}`}
              right={<Tag color="#F2B544">Запад {s.allStar.westScore}:{s.allStar.eastScore} Восток</Tag>}
            >
              <div className="text-xs space-y-1 text-text/90">
                <div>
                  MVP Матча Звёзд: <button onClick={() => ui.openPlayer(s.allStar!.mvpId)} className="font-semibold text-gold hover:underline">{P[s.allStar.mvpId]?.name ?? '—'}</button>
                </div>
                <div className="text-muted">
                  Скорость: {P[s.allStar.fastestSkaterId]?.name ?? '—'} · Бросок: {P[s.allStar.hardestShotId]?.name ?? '—'}
                </div>
                {s.allStar.userSelectedIds.length > 0 && (
                  <div className="text-ice pt-0.5">
                    Представители «{U.short}»: {s.allStar.userSelectedIds.map((id) => P[id]?.name).filter(Boolean).join(', ')}
                  </div>
                )}
              </div>
            </Panel>
          )}

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
