import './fonts.css';
import { UpdateBanner } from './components/UpdateBanner';
import { useEffect, useMemo, useState } from 'react';
import type { Game } from './types';
import { Button, Icon, Modal, Tag, TeamLogo, UIContext, money, type UIApi, type View } from './components/ui';
import { FormatDoc, SAFE_START, Startup } from './components/Startup';
import { MainMenu } from './components/MainMenu';
import { Dashboard } from './components/Dashboard';
import { PlayerModal, Roster } from './components/Roster';
import { TeamModal } from './components/TeamInfo';
import { Lines } from './components/Lines';
import { Standings } from './components/Standings';
import { GameBox, Schedule } from './components/Schedule';
import { Match } from './components/Match';
import { PlayMatch } from './components/PlayMatch';
import { useMenuMusic } from './components/sound/menuMusic';
import { OnlineScreen } from './components/online/OnlineScreen';
import { QuickPlay } from './components/QuickPlay';
import { MatchModeModal, type MatchMode } from './components/MatchModes';
import { getSettings } from './game/settings';
import { Trades } from './components/Trades';
import { Market } from './components/Market';
import { Offseason } from './components/Offseason';
import { Leaders } from './components/Leaders';
import { Contracts, NegotiationModal } from './components/Contracts';
import { Coaching } from './components/Coaching';
import { Club } from './components/Club';
import { Inbox } from './components/Inbox';
import { FullscreenButton } from './components/FullscreenButton';
import { blockingTasks, buildInbox } from './game/inbox';
import { SaveIndicator, SavesList } from './components/Saves';
import { SettingsPanel } from './components/SettingsPanel';
import { simulateDay, exitToMenu, exportCareer, roundName, saveNow, startNewGame, syncCoachMarketFromRoster, syncPlayersFromRoster, useGame, useSaveStatus } from './game/state';
import { nextUserGame, regularSeasonLength, seasonDate } from './game/schedule';
import { effectivePayroll } from './game/cap';
import { countRosterLegionnaires, teamForeignLimit } from './game/legionnaires';
import { cn } from './utils/cn';
import { GAME_NAME, GAME_NAME_EN } from './brand';

// in the order of the groups below (the team, the season, transfers, the club)
const NAV: { id: View; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Обзор', icon: 'dashboard' },
  { id: 'inbox', label: 'Входящие', icon: 'bell' },
  { id: 'roster', label: 'Состав', icon: 'roster' },
  { id: 'lines', label: 'Звенья', icon: 'lines' },
  { id: 'management', label: 'Управление командой', icon: 'roster' },
  { id: 'schedule', label: 'Календарь', icon: 'calendar' },
  { id: 'standings', label: 'Таблица', icon: 'table' },
  { id: 'stats', label: 'Статистика', icon: 'chart' },
  { id: 'trades', label: 'Обмены', icon: 'trade' },
  { id: 'market', label: 'Рынок', icon: 'market' },
  { id: 'contracts', label: 'Контракты', icon: 'contract' },
  { id: 'club', label: 'Инфраструктура', icon: 'trophy' },
];
/** The sections in groups: the sidebar and «Все разделы» show a heading over each. */
const NAV_GROUPS: [string, View[]][] = [
  ['Главное', ['dashboard', 'offseason', 'inbox']],
  ['Команда', ['roster', 'lines', 'management']],
  ['Сезон', ['schedule', 'standings', 'stats']],
  ['Трансферы', ['trades', 'market', 'contracts']],
  ['Клуб', ['club', 'format']],
];
const grouped = (nav: View[]) => {
  const out = NAV_GROUPS.map(([title, ids]) => ({ title, ids: ids.filter((v) => nav.includes(v)) })).filter((g) => g.ids.length);
  const rest = nav.filter((v) => !NAV_GROUPS.some(([, ids]) => ids.includes(v)));
  if (rest.length) out.push({ title: 'Ещё', ids: rest });
  return out;
};

/** Labels of the landscape-phone rail: long words get soft hyphens (they wrap onto a second line instead of being cut). */
const SHY = '\u00ad';
const RAIL_LABEL: Partial<Record<string, string>> = {
  offseason: `Меж${SHY}сезонье`, format: 'Формат', management: `Управ${SHY}ление`, club: `Инфра${SHY}струк${SHY}тура`,
  schedule: `Кален${SHY}дарь`, stats: `Стати${SHY}стика`, contracts: `Кон${SHY}тракты`, inbox: `Вхо${SHY}дящие`,
};


const MOBILE_MAIN: View[] = ['dashboard', 'roster', 'lines', 'standings'];

type StartScreen = 'menu' | 'career' | 'online' | 'shootout' | 'friendly';
/** The start screen survives a reload of the page (a mod installed, the boot watchdog) within the tab. */
const START_KEY = 'khl.start';
function readStart(): StartScreen {
  if (SAFE_START) return 'career';
  try {
    const v = sessionStorage.getItem(START_KEY);
    // the network game is not resumed by a reload: its connection is gone
    return v === 'career' ? 'career' : 'menu';
  } catch {
    return 'menu';
  }
}

type ConfirmState = { title: string; text?: string; confirmLabel?: string; danger?: boolean; onYes: () => void } | null;

export default function App() {
  const s = useGame();
  const saveStatus = useSaveStatus();
  const [view, setView] = useState<View>('dashboard');
  const [matchGame, setMatchGame] = useState<Game | null>(null);
  /** with no career open: the main menu, the career screen (saves, a new career) or the network game */
  const [start, setStartState] = useState<StartScreen>(readStart);
  const setStart = (v: StartScreen) => { setStartState(v); try { sessionStorage.setItem(START_KEY, v); } catch { /* private mode */ } };
  /** how the open match is taken: played by the manager or watched from the bench */
  const [matchMode, setMatchMode] = useState<'play' | 'watch'>('watch');
  /** «Играть матч» was pressed: the choice of play / watch / quick simulation is open */
  const [chooseGame, setChooseGame] = useState<Game | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [teamCardId, setTeamCardId] = useState<string | null>(null);
  const [boxId, setBoxId] = useState<number | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);
  const [preselect, setPreselect] = useState<string | null>(null);
  const [savesOpen, setSavesOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // the menu music (the match screens silence it while they are open)
  useMenuMusic(true);
  const [settingsOpen, setSettingsOpenState] = useState(false);
  const [settingsScope, setSettingsScope] = useState<'all' | 'match'>('all');
  /** the settings window: from the menus everything, from a match without what it runs with */
  const setSettingsOpen = (on: boolean, scope: 'all' | 'match' = 'all') => { setSettingsOpenState(on); if (on) setSettingsScope(scope); };
  const [negId, setNegId] = useState<string | null>(null);
  const saveId = s?.saveId ?? null;
  const phase = s?.phase ?? null;

  // A different career was opened (or closed): drop everything that belonged to the previous one.
  useEffect(() => {
    setMatchGame(null);
    setPlayerId(null);
    setTeamCardId(null);
    setBoxId(null);
    setPreselect(null);
    setSavesOpen(false);
    setMoreOpen(false);
    setNegId(null);
    setView(phase === 'offseason' ? 'offseason' : 'dashboard');
    // the club selection screen may have been scrolled down to the club overview
    window.scrollTo?.({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveId]);

  useEffect(() => {
    if (phase === 'offseason') setView('offseason');
  }, [phase]);

  // Older careers kept the built-in coach list: pick up `freeCoaches` from roster.json once.
  const coachSource = s?.coachMarketSource;
  useEffect(() => {
    if (saveId && coachSource !== 'roster') void syncCoachMarketFromRoster(saveId);
  }, [saveId, coachSource]);
  // roster.json is the source of truth for names, numbers, nationality and photos (matched by player id):
  // re-read it whenever a career is opened, so edits to the file reach old saves.
  useEffect(() => {
    if (saveId) void syncPlayersFromRoster(saveId);
  }, [saveId]);

  // the career screen: Esc (the pad's B) and Android «Back» go back to the main menu when nothing is open over it
  const onCareerScreen = !s && start === 'career';
  useEffect(() => {
    if (!onCareerScreen) return;
    const overlay = () => !!document.querySelector('div.fixed.inset-0, [role="dialog"], [aria-modal="true"]');
    const back = (e: Event) => { if (!overlay()) { e.preventDefault(); setStart('menu'); } };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== 'Escape' || e.defaultPrevented || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      back(e);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('khl-back', back);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('khl-back', back); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCareerScreen]);

  const api = useMemo<UIApi>(
    () => ({
      openPlayer: (id) => setPlayerId(id),
      openTeam: (id) => {
        setPlayerId(null);
        setBoxId(null);
        setTeamCardId(id);
      },
      openGame: (id) => setBoxId(id),
      confirm: (opts) => setConfirmState(opts),
      nav: (v) => {
        if (v !== 'trades') setPreselect(null);
        setView(v);
      },
      tradeWith: (id) => {
        setPreselect(id);
        setView('trades');
      },
      negotiate: (id) => setNegId(id),
      openSettings: (scope) => { setSettingsOpenState(true); setSettingsScope(scope ?? 'all'); },
    }),
    []
  );

  /** The choice after «Играть матч»: play it, watch it, or the result at once (the dashboard's fast simulation). */
  const pickMode = (mode: MatchMode, g: Game) => {
    setChooseGame(null);
    if (mode !== 'quick') { setMatchMode(mode); setMatchGame(g); return; }
    const run = () => { simulateDay(true); if (getSettings().simOpenReport) setBoxId(g.id); };
    const open = s ? blockingTasks(s) : [];
    if (open.length && getSettings().simConfirm) {
      setConfirmState({ title: 'Есть нерешённые задачи', text: `Во входящих: ${open.slice(0, 3).map((t) => t.title).join('; ')}${open.length > 3 ? '…' : ''}. Симулировать матч по текущим звеньям?`, confirmLabel: 'Всё равно продолжить', onYes: run });
    } else run();
  };

  const confirmModal = confirmState && (
    <Modal open onClose={() => setConfirmState(null)} title={<span className="font-display uppercase tracking-wide">{confirmState.title}</span>} width="max-w-md">
      <div className="text-sm text-text/90">{confirmState.text}</div>
      <div className="flex gap-2 justify-end mt-4">
        <Button onClick={() => setConfirmState(null)}>Отмена</Button>
        <Button
          variant={confirmState.danger ? 'danger' : 'primary'}
          onClick={() => {
            const fn = confirmState.onYes;
            setConfirmState(null);
            fn();
          }}
        >
          {confirmState.confirmLabel ?? 'Подтвердить'}
        </Button>
      </div>
    </Modal>
  );

  if (!s) {
    return (
      <UIContext.Provider value={api}>
        {start === 'online' ? <OnlineScreen onClose={() => setStart('menu')} />
          : start === 'shootout' || start === 'friendly' ? <QuickPlay kind={start === 'shootout' ? 'so' : 'match'} onClose={() => setStart('menu')} />
          : start === 'career' ? <Startup onStart={(r, id) => void startNewGame(r, id)} onBack={() => setStart('menu')} />
          : <MainMenu onPlay={(m) => setStart(m)} onOnline={() => setStart('online')} />}
      {settingsOpen && (
        <Modal open onClose={() => setSettingsOpen(false)} width="max-w-2xl" title={<span className="font-display uppercase tracking-wide">Настройки</span>}>
          <SettingsPanel onClose={() => setSettingsOpen(false)} scope={settingsScope} />
        </Modal>
      )}
        {confirmModal}
        <UpdateBanner />
      </UIContext.Provider>
    );
  }

  const U = s.teams[s.userTeamId];
  const phaseLabel = s.phase === 'playoffs' ? `Плей-офф · ${roundName(s.playoffs?.round ?? 0)}` : s.phase === 'offseason' ? 'Межсезонье' : 'Регулярный чемпионат';
  const phaseShort = s.phase === 'playoffs' ? roundName(s.playoffs?.round ?? 0) : s.phase === 'offseason' ? 'Межсезонье' : 'Регулярка';
  const ltirReadyCount = U.players.filter((id) => s.players[id]?.inLtir && !s.players[id]?.injury).length;
  const rfaOffersCount = (s.rfaOffers ?? []).length;
  const inboxTasks = buildInbox(s);
  const inboxUrgent = inboxTasks.filter((t) => t.severity !== 'info').length;
  const moreBadgeCount = s.offers.length + rfaOffersCount + ltirReadyCount;
  const curFol = effectivePayroll(U, s.players, s.phase);
  const fl = teamForeignLimit(U, s.league.foreignLimit);
  const legNum = countRosterLegionnaires(U.players, s.players);
  // The next game in the header on every screen: today's — straight to «Играть матч» (play / watch / result);
  // a later one — the overview, where the days are simulated up to it
  const todayGame = (s.schedule[s.day] ?? []).find((g) => !g.played && (g.home === U.id || g.away === U.id)) ?? null;
  const nextGame = s.phase === 'offseason' ? null : todayGame ?? nextUserGame(s, U.id);
  const nextOpp = nextGame ? s.teams[nextGame.home === U.id ? nextGame.away : nextGame.home] : null;
  const nextChip = nextGame && nextOpp ? (
    <button
      type="button"
      onClick={() => (todayGame ? setChooseGame(todayGame) : switchView('dashboard'))}
      className={cn('inline-flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-sm border text-xs shrink-0 transition-colors', todayGame ? 'border-accent/70 bg-accent/15 text-text hover:bg-accent/25' : 'border-line text-muted hover:text-text')}
      title={todayGame ? 'Матч сегодня: играть, смотреть или сразу результат' : 'Следующий матч — на обзоре'}
      data-next-game={nextGame.id}
    >
      {todayGame && <Icon name="play" className="w-3.5 h-3.5 text-accent" />}
      <span className="hidden sm:inline">{nextGame.home === U.id ? 'vs' : '@'}</span>
      <TeamLogo team={nextOpp} size={18} />
      <span className="font-semibold">{nextOpp.short}</span>
      <span className={cn('tabular', todayGame ? 'text-accent' : 'text-muted')}>{todayGame ? 'сегодня' : nextGame.day === s.day + 1 ? 'завтра' : <><span className="hidden sm:inline">через </span>{nextGame.day - s.day} дн.</>}</span>
    </button>
  ) : null;
  const switchView = (v: View) => {
    setView(v);
    window.scrollTo?.({ top: 0 });
  };
  const nav: View[] =
    s.phase === 'offseason'
      ? ['dashboard', 'offseason', ...NAV.filter((n) => n.id !== 'dashboard').map((n) => n.id)]
      : NAV.map((n) => n.id);
  const navItem = (v: View, mobile = false) => {
    const item = NAV.find((n) => n.id === v);
    const label = v === 'offseason' ? 'Межсезонье' : v === 'format' ? 'Формат JSON' : item?.label ?? v;
    const icon = v === 'offseason' ? 'trophy' : v === 'format' ? 'code' : item?.icon ?? 'dashboard';
    const active = view === v;
    const badge = v === 'inbox' ? inboxTasks.length : v === 'trades' && s.offers.length > 0 ? s.offers.length : v === 'contracts' && rfaOffersCount > 0 ? rfaOffersCount : v === 'club' && ltirReadyCount > 0 ? ltirReadyCount : 0;
    const isOffTab = v === 'offseason';
    const cls = cn(
      'flex items-center gap-3 transition-colors',
      mobile
        ? cn('flex-col justify-center text-[10px] gap-1 py-1.5 px-1 flex-1 min-w-0 min-h-[54px] border-t-2', active ? 'border-ice text-ice bg-ice/5' : 'border-transparent')
        : 'px-4 py-1.5 text-sm border-l-2',
      active
        ? mobile
          ? 'text-ice'
          : 'bg-accent/15 text-text border-accent'
        : mobile
          ? isOffTab
            ? 'text-gold'
            : 'text-muted'
          : isOffTab
            ? 'text-gold font-semibold bg-gold/10 hover:bg-gold/20 border-gold/60'
            : 'text-muted hover:text-text hover:bg-panel2 border-transparent'
    );
    return (
      <button key={v} onClick={() => switchView(v)} className={cls} title={label} aria-current={active ? 'page' : undefined} data-nav-view={v}>
        <span className="relative">
          <Icon name={icon} className={mobile ? 'w-5 h-5' : ''} />
          {badge > 0 && <span className="absolute -top-1.5 -right-2 bg-amber text-bg text-[9px] font-bold px-1 rounded-sm leading-3">{badge}</span>}
        </span>
        <span className={cn('min-w-0 max-w-full', v === 'management' ? 'whitespace-normal text-left leading-tight' : 'truncate', mobile && 'font-medium')}>{label}</span>
      </button>
    );
  };

  const content = (() => {
    switch (view) {
      case 'roster':
        return <Roster />;
      case 'lines':
        return <Lines />;
      case 'schedule':
        return <Schedule onPlay={(g) => setChooseGame(g)} />;
      case 'standings':
        return <Standings />;
      case 'stats':
        return <Leaders />;
      case 'trades':
        return <Trades preselect={preselect} />;
      case 'market':
        return <Market />;
      case 'contracts':
        return <Contracts />;
      case 'management': return <Coaching />;
      case 'club':
        return <Club />;
      case 'offseason':
        return <Offseason />;
      case 'format':
        return <FormatDoc />;
      case 'inbox':
        return <Inbox />;
      default:
        return <Dashboard onPlay={(g) => setChooseGame(g)} />;
    }
  })();

  return (
    <UIContext.Provider value={api}>
      {matchGame ? (
        matchMode === 'play' ? (
          <PlayMatch key={matchGame.id} game={matchGame} onFinished={() => { setMatchGame(null); setView(s.phase === 'offseason' ? 'offseason' : 'dashboard'); }} />
        ) : (
          <Match key={matchGame.id} game={matchGame} onFinished={() => { setMatchGame(null); setView(s.phase === 'offseason' ? 'offseason' : 'dashboard'); }} />
        )
      ) : (
        <div className="min-h-screen flex land:h-[100dvh] land:min-h-0 land:overflow-hidden">
          {/* Landscape phones: a slim scrollable rail instead of the bottom bar, so the content gets the full height. */}
          <nav className="hidden land:flex flex-col w-[calc(76px+env(safe-area-inset-left))] shrink-0 border-r border-line bg-panel/90 overflow-y-auto no-scrollbar pl-[env(safe-area-inset-left)]" aria-label="Разделы" data-land-rail data-pad-sections>
            {nav.map((v) => {
              const item = NAV.find((n) => n.id === v);
              const label = RAIL_LABEL[v] ?? item?.label ?? v;
              const icon = v === 'offseason' ? 'trophy' : v === 'format' ? 'code' : item?.icon ?? 'dashboard';
              return (
                <button key={v} type="button" onClick={() => switchView(v)} aria-current={view === v ? 'page' : undefined} data-nav-view={v} className={cn('flex flex-col items-center gap-0.5 px-1 py-1.5 text-[9.5px] leading-tight border-l-2 shrink-0', view === v ? 'border-ice text-ice bg-ice/5' : 'border-transparent text-muted')}>
                  <span className="relative">
                    <Icon name={icon} className="w-[18px] h-[18px]" />
                    {v === 'inbox' && inboxTasks.length > 0 && <span className="absolute -top-1.5 -right-2.5 bg-amber text-bg text-[8.5px] font-bold px-0.5 rounded-sm leading-3">{inboxTasks.length}</span>}
                  </span>
                  <span className="w-full text-center break-words [hyphens:manual]">{label}</span>
                </button>
              );
            })}
            <button type="button" onClick={() => setSavesOpen(true)} className="flex flex-col items-center gap-0.5 px-1 py-1.5 text-[9.5px] text-muted shrink-0"><Icon name="save" className="w-[18px] h-[18px]" />Сохран.</button>
            <button type="button" onClick={() => setSettingsOpen(true)} className="flex flex-col items-center gap-0.5 px-1 py-1.5 text-[9.5px] text-muted shrink-0"><Icon name="settings" className="w-[18px] h-[18px]" />Настр.</button>
            <button type="button" onClick={() => void exitToMenu()} className="flex flex-col items-center gap-0.5 px-1 py-1.5 text-[9.5px] text-muted shrink-0"><Icon name="logout" className="w-[18px] h-[18px]" />Меню</button>
          </nav>
          <aside className="hidden lg:flex flex-col w-56 shrink-0 border-r border-line bg-panel/80 sticky top-0 h-screen">
            <div className="px-3 py-3 border-b border-line flex items-center gap-2.5" title={GAME_NAME}>
              <img src="./icon-game.png" alt="" className="w-11 h-11 object-contain shrink-0" />
              <div className="min-w-0">
                <div className="font-display text-[15px] uppercase leading-[1.05]">
                  Хоккейный симулятор <span className="text-accent">менеджера</span>
                </div>
                <div className="text-[10px] text-muted mt-0.5 truncate">{GAME_NAME_EN}</div>
              </div>
            </div>
            <div className="px-3 py-3 border-b border-line flex items-center gap-2">
              <TeamLogo team={U} size={36} />
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{U.name}</div>
                <div className="text-[11px] text-muted">{s.league.season} · {U.record.points} очков</div>
              </div>
            </div>
            <nav className="flex-1 py-1 overflow-y-auto no-scrollbar" data-pad-sections>
              {grouped(nav).map((g, i) => (
                <div key={g.title} className="pb-0.5">
                  {i > 0 && <div className="px-4 pt-1.5 pb-0.5 text-[10px] uppercase tracking-[0.18em] text-muted/70 font-semibold leading-tight">{g.title}</div>}
                  {g.ids.map((v) => navItem(v))}
                </div>
              ))}
            </nav>
            <div className="p-3 border-t border-line text-xs text-muted space-y-1.5">
              <div className="flex justify-between">
                <span>Бюджет</span>
                <span className="text-ok tabular">{money(U.budget)}</span>
              </div>
              <div className="flex justify-between">
                <span>ФОТ</span>
                <span className={cn('tabular', effectivePayroll(U, s.players, s.phase) > s.league.salaryCap && 'text-accent font-semibold')}>
                  {money(effectivePayroll(U, s.players, s.phase))}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Легионеры</span>
                <span className="tabular text-ice">
                  {(() => {
                    const fl = teamForeignLimit(U, s.league.foreignLimit);
                    const n = countRosterLegionnaires(U.players, s.players);
                    return fl !== null ? `${n} / ${fl}` : `${n} (без лим.)`;
                  })()}
                </span>
              </div>
              <button onClick={() => setSavesOpen(true)} className="flex items-center gap-2 hover:text-text w-full pt-1">
                <Icon name="save" /> Сохранения
              </button>
              <button onClick={() => setSettingsOpen(true)} className="flex items-center gap-2 hover:text-text w-full" data-open-settings>
                <Icon name="settings" /> Настройки
              </button>
              <button onClick={() => void exitToMenu()} className="flex items-center gap-2 hover:text-text w-full" title="Карьера будет сохранена — продолжить можно из главного меню">
                <Icon name="logout" /> В главное меню
              </button>
            </div>
          </aside>

          <main className="flex-1 min-w-0 rink-lines pb-[calc(4.5rem+env(safe-area-inset-bottom))] lg:pb-0 land:pb-0 land:flex land:flex-col land:min-h-0">
            <header className="sticky top-0 z-30 bg-bg/90 backdrop-blur border-b border-line px-3 sm:px-4 py-2 flex items-center gap-2 sm:gap-3 flex-wrap land:flex-nowrap land:py-1 land:shrink-0 land:pr-[max(0.75rem,env(safe-area-inset-right))]">
              <button
                type="button"
                onClick={() => switchView('dashboard')}
                className="lg:hidden inline-flex items-center gap-1.5 pr-2 border-r border-line text-left shrink-0"
                title={U.name}
              >
                <TeamLogo team={U} size={26} />
                <div className="leading-none">
                  <div className="font-display text-xs font-bold uppercase text-text">{U.short}</div>
                  <div className="text-[10px] text-ice tabular mt-0.5">{U.record.points} очк.</div>
                </div>
              </button>
              <div className="font-display uppercase tracking-wide text-xs sm:text-sm">{seasonDate(s.day, regularSeasonLength(s.schedule), s.league.season)}</div>
              <Tag className="hidden sm:inline-flex" color={s.phase === 'playoffs' ? '#F2B544' : s.phase === 'offseason' ? '#8FD8F0' : '#93A4BC'}>{phaseLabel}</Tag>
              <Tag className={cn('sm:hidden', nextChip && 'hidden')} color={s.phase === 'playoffs' ? '#F2B544' : s.phase === 'offseason' ? '#8FD8F0' : '#93A4BC'}>{phaseShort}</Tag>
              {s.phase === 'offseason' && view !== 'offseason' && (
                <Button size="sm" variant="primary" onClick={() => switchView('offseason')}>
                  <Icon name="trophy" /> <span className="hidden sm:inline">Межсезонье →</span><span className="sm:hidden">Драфт/ТО</span>
                </Button>
              )}
              {nextChip}
              <div className="ml-auto flex items-center gap-2 sm:gap-3">
                <div className="hidden 2xl:flex land:hidden items-center gap-2 text-xs text-muted">
                  <span>День {Math.min(s.day + 1, s.schedule.length)} / {s.schedule.length}</span>
                  <span>·</span>
                  <span>Сезон {s.league.season}</span>
                  <span>·</span>
                  <span>
                    {U.record.w + U.record.otw + U.record.sow}−{U.record.otl + U.record.sol + U.record.l}
                  </span>
                  <span>·</span>
                  <span>{U.conference}</span>
                </div>
                <button
                  type="button"
                  onClick={() => switchView('inbox')}
                  className={cn('relative inline-flex items-center gap-1 px-2 py-1 rounded-sm border text-xs', view === 'inbox' ? 'border-ice text-ice' : inboxUrgent ? 'border-amber/60 text-amber' : 'border-line text-muted')}
                  title="Входящие задачи"
                  data-inbox-bell
                >
                  <Icon name="bell" />
                  <span className="tabular">{inboxTasks.length}</span>
                </button>
                <button type="button" onClick={() => setSettingsOpen(true)} className="inline-flex items-center justify-center w-8 h-8 rounded-sm border border-line text-muted hover:text-text" title="Настройки" aria-label="Настройки" data-header-settings>
                  <Icon name="settings" />
                </button>
                <FullscreenButton />
                <SaveIndicator onClick={() => setSavesOpen(true)} />
              </div>
            </header>
            {saveStatus.state === 'error' && (
              <div role="alert" className="mx-3 sm:mx-4 mt-3 sm:mt-4 rounded-md border border-accent/60 bg-accent/10 p-3 text-sm flex items-center gap-3 flex-wrap">
                <span className="text-accent">
                  <Icon name="alert" />
                </span>
                <span className="flex-1 min-w-[220px]">
                  <b>Карьера сейчас не сохраняется.</b> {saveStatus.error}
                </span>
                <Button size="sm" onClick={() => void saveNow()}>
                  Повторить
                </Button>
                <Button size="sm" onClick={() => void exportCareer(s.saveId)}>
                  Скачать сохранение файлом
                </Button>
              </div>
            )}
            <div className="p-2.5 sm:p-4 max-w-[1500px] mx-auto land:w-full land:flex-1 land:min-h-0 land:overflow-y-auto land:overscroll-contain land:p-2 land:pr-[max(0.5rem,env(safe-area-inset-right))]" data-view-scroll>{content}</div>
          </main>

          <nav className="lg:hidden land:hidden fixed bottom-0 inset-x-0 z-30 bg-panel/95 backdrop-blur border-t border-line flex justify-around px-1 pb-[env(safe-area-inset-bottom)]" aria-label="Разделы" data-pad-sections>
            {(s.phase === 'offseason' ? (['dashboard', 'offseason', 'contracts', 'market'] as View[]) : MOBILE_MAIN).map((id) => navItem(id, true))}
            <button
              onClick={() => setMoreOpen(true)}
              className={cn(
                'flex flex-col items-center justify-center text-[10px] gap-1 py-1.5 px-1 flex-1 min-w-0 min-h-[54px] border-t-2 transition-colors',
                !(s.phase === 'offseason' ? (['dashboard', 'offseason', 'contracts', 'market'] as View[]) : MOBILE_MAIN).includes(view)
                  ? 'border-ice text-ice bg-ice/5'
                  : 'border-transparent text-muted'
              )}
              title="Все разделы"
            >
              <span className="relative">
                <Icon name="more" className="w-5 h-5" />
                {moreBadgeCount > 0 && <span className="absolute -top-1.5 -right-2 bg-amber text-bg text-[9px] font-bold px-1 rounded-sm leading-3">{moreBadgeCount}</span>}
              </span>
              <span className="font-medium">Ещё</span>
            </button>
          </nav>
        </div>
      )}

      {teamCardId && <TeamModal key={teamCardId} id={teamCardId} onClose={() => setTeamCardId(null)} />}
      {playerId && <PlayerModal id={playerId} onClose={() => setPlayerId(null)} />}
      {boxId != null && <GameBox gameId={boxId} onClose={() => setBoxId(null)} />}
      <MatchModeModal game={chooseGame} onClose={() => setChooseGame(null)} onPick={pickMode} />
      {negId && <NegotiationModal key={negId} id={negId} onClose={() => setNegId(null)} />}
      {savesOpen && (
        <Modal open onClose={() => setSavesOpen(false)} width="max-w-4xl" title={<span className="font-display uppercase tracking-wide">Сохранения</span>}>
          <p className="text-sm text-muted mb-4">
            Открытая карьера сохраняется автоматически после каждого действия. «Сделать копию» создаёт отдельное сохранение текущего момента, к которому можно вернуться позже. При загрузке другой карьеры текущая сначала сохраняется.
          </p>
          <SavesList onLoaded={() => setSavesOpen(false)} />
          <div className="flex justify-between gap-2 mt-4 pt-4 border-t border-line flex-wrap">
            <Button variant="ghost" onClick={() => void exitToMenu()}>
              <Icon name="logout" /> Сохранить и выйти в главное меню
            </Button>
            <Button onClick={() => setSavesOpen(false)}>Закрыть</Button>
          </div>
        </Modal>
      )}
      {moreOpen && (
        <Modal open onClose={() => setMoreOpen(false)} width="max-w-md" title={<span className="font-display uppercase tracking-wide">Все разделы</span>}>
          <div className="mb-3 rounded-md border border-line bg-bg/60 p-2.5 flex items-center gap-3 text-xs">
            <TeamLogo team={U} size={36} />
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-sm truncate">{U.name}</div>
              <div className="text-[11px] text-muted">
                {s.league.season} · {U.record.points} очк. · Бюджет <b className="text-ok">{money(U.budget)}</b>
              </div>
              <div className="text-[11px] text-muted">
                ФОТ <b className={curFol > s.league.salaryCap ? 'text-accent' : 'text-text'}>{money(curFol)}</b> · Лег.{' '}
                <b className="text-ice">{fl !== null ? `${legNum}/${fl}` : legNum}</b>
              </div>
            </div>
          </div>
          {grouped(nav).map((g) => (
          <div key={g.title} className="mb-2.5">
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted font-semibold mb-1">{g.title}</div>
          <div className="grid grid-cols-2 gap-2">
            {g.ids.map((v) => {
              const item = NAV.find((n) => n.id === v);
              const label = v === 'offseason' ? 'Межсезонье' : v === 'format' ? 'Формат JSON' : item?.label ?? v;
              const icon = v === 'offseason' ? 'trophy' : v === 'format' ? 'code' : item?.icon ?? 'dashboard';
              const bdg = v === 'trades' && s.offers.length > 0 ? s.offers.length : v === 'contracts' && rfaOffersCount > 0 ? rfaOffersCount : v === 'club' && ltirReadyCount > 0 ? ltirReadyCount : 0;
              return (
                <button key={v} onClick={() => { switchView(v); setMoreOpen(false); }} className={cn('flex items-center gap-2.5 rounded-sm border px-3 py-3 text-sm text-left transition-colors min-h-[44px]', view === v ? 'border-accent bg-accent/15 text-text font-semibold' : 'border-line bg-panel2 text-text/90 hover:border-muted')}>
                  <Icon name={icon} />
                  <span className="flex-1 truncate">{label}</span>
                  {bdg > 0 && <span className="bg-amber text-bg text-[10px] font-bold px-1.5 rounded-sm">{bdg}</span>}
                </button>
              );
            })}
          </div>
          </div>
          ))}
          <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-line">
            <button onClick={() => { setMoreOpen(false); setSavesOpen(true); }} className="flex items-center gap-2.5 rounded-sm border border-line bg-panel2 px-3 py-3 text-sm text-left hover:border-muted min-h-[44px]">
              <Icon name="save" /> Сохранения
            </button>
            <button onClick={() => { setMoreOpen(false); setSettingsOpen(true); }} className="flex items-center gap-2.5 rounded-sm border border-line bg-panel2 px-3 py-3 text-sm text-left hover:border-muted min-h-[44px]">
              <Icon name="settings" /> Настройки
            </button>
            <button onClick={() => void exitToMenu()} className="flex items-center gap-2.5 rounded-sm border border-line bg-panel2 px-3 py-3 text-sm text-left hover:border-muted min-h-[44px]">
              <Icon name="logout" /> Главное меню
            </button>
          </div>
        </Modal>
      )}
      {settingsOpen && (
        <Modal open onClose={() => setSettingsOpen(false)} width="max-w-2xl" title={<span className="font-display uppercase tracking-wide">Настройки</span>}>
          <SettingsPanel onClose={() => setSettingsOpen(false)} scope={settingsScope} />
        </Modal>
      )}
      {confirmModal}
      <UpdateBanner />
    </UIContext.Provider>
  );
}
