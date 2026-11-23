import './fonts.css';
import { useEffect, useMemo, useState } from 'react';
import type { Game } from './types';
import { Button, Icon, Modal, Tag, TeamLogo, UIContext, money, type UIApi, type View } from './components/ui';
import { FormatDoc, Startup } from './components/Startup';
import { Dashboard } from './components/Dashboard';
import { PlayerModal, Roster } from './components/Roster';
import { Lines } from './components/Lines';
import { Standings } from './components/Standings';
import { GameBox, Schedule } from './components/Schedule';
import { Match } from './components/Match';
import { Trades } from './components/Trades';
import { Market } from './components/Market';
import { Offseason } from './components/Offseason';
import { Leaders } from './components/Leaders';
import { Contracts, NegotiationModal } from './components/Contracts';
import { Coaching } from './components/Coaching';
import { Club } from './components/Club';
import { SaveIndicator, SavesList } from './components/Saves';
import { exitToMenu, exportCareer, roundName, saveNow, startNewGame, useGame, useSaveStatus } from './game/state';
import { regularSeasonLength, seasonDate } from './game/schedule';
import { effectivePayroll } from './game/cap';
import { countRosterLegionnaires, teamForeignLimit } from './game/legionnaires';
import { cn } from './utils/cn';

const NAV: { id: View; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Обзор', icon: 'dashboard' },
  { id: 'roster', label: 'Состав', icon: 'roster' },
  { id: 'lines', label: 'Звенья', icon: 'lines' },
  { id: 'schedule', label: 'Календарь', icon: 'calendar' },
  { id: 'standings', label: 'Таблица', icon: 'table' },
  { id: 'stats', label: 'Статистика', icon: 'chart' },
  { id: 'trades', label: 'Обмены', icon: 'trade' },
  { id: 'market', label: 'Рынок', icon: 'market' },
  { id: 'contracts', label: 'Контракты', icon: 'contract' },
  { id: 'management', label: 'Управление командой', icon: 'roster' },
  { id: 'club', label: 'Инфраструктура', icon: 'trophy' },
];

const MOBILE_MAIN: View[] = ['dashboard', 'roster', 'lines', 'standings'];

type ConfirmState = { title: string; text?: string; confirmLabel?: string; danger?: boolean; onYes: () => void } | null;

export default function App() {
  const s = useGame();
  const saveStatus = useSaveStatus();
  const [view, setView] = useState<View>('dashboard');
  const [matchGame, setMatchGame] = useState<Game | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [boxId, setBoxId] = useState<number | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);
  const [preselect, setPreselect] = useState<string | null>(null);
  const [savesOpen, setSavesOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [negId, setNegId] = useState<string | null>(null);
  const saveId = s?.saveId ?? null;
  const phase = s?.phase ?? null;

  // A different career was opened (or closed): drop everything that belonged to the previous one.
  useEffect(() => {
    setMatchGame(null);
    setPlayerId(null);
    setBoxId(null);
    setPreselect(null);
    setSavesOpen(false);
    setMoreOpen(false);
    setNegId(null);
    setView(phase === 'offseason' ? 'offseason' : 'dashboard');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveId]);

  useEffect(() => {
    if (phase === 'offseason') setView('offseason');
  }, [phase]);

  const api = useMemo<UIApi>(
    () => ({
      openPlayer: (id) => setPlayerId(id),
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
    }),
    []
  );

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
        <Startup onStart={(r, id) => void startNewGame(r, id)} />
        {confirmModal}
      </UIContext.Provider>
    );
  }

  const U = s.teams[s.userTeamId];
  const phaseLabel = s.phase === 'playoffs' ? `Плей-офф · ${roundName(s.playoffs?.round ?? 0)}` : s.phase === 'offseason' ? 'Межсезонье' : 'Регулярный чемпионат';
  const phaseShort = s.phase === 'playoffs' ? roundName(s.playoffs?.round ?? 0) : s.phase === 'offseason' ? 'Межсезонье' : 'Регулярка';
  const ltirReadyCount = U.players.filter((id) => s.players[id]?.inLtir && !s.players[id]?.injury).length;
  const rfaOffersCount = (s.rfaOffers ?? []).length;
  const moreBadgeCount = s.offers.length + rfaOffersCount + ltirReadyCount;
  const curFol = effectivePayroll(U, s.players, s.phase);
  const fl = teamForeignLimit(U, s.league.foreignLimit);
  const legNum = countRosterLegionnaires(U.players, s.players);
  const switchView = (v: View) => {
    setView(v);
    window.scrollTo?.({ top: 0 });
  };
  const nav: View[] =
    s.phase === 'offseason'
      ? ['dashboard', 'offseason', ...NAV.filter((n) => n.id !== 'dashboard').map((n) => n.id), 'format']
      : [...NAV.map((n) => n.id), 'format'];
  const navItem = (v: View, mobile = false) => {
    const item = NAV.find((n) => n.id === v);
    const label = v === 'offseason' ? 'Межсезонье' : v === 'format' ? 'Формат JSON' : item?.label ?? v;
    const icon = v === 'offseason' ? 'trophy' : v === 'format' ? 'code' : item?.icon ?? 'dashboard';
    const active = view === v;
    const badge = v === 'trades' && s.offers.length > 0 ? s.offers.length : v === 'contracts' && rfaOffersCount > 0 ? rfaOffersCount : v === 'club' && ltirReadyCount > 0 ? ltirReadyCount : 0;
    const isOffTab = v === 'offseason';
    const cls = cn(
      'flex items-center gap-3 transition-colors',
      mobile
        ? cn('flex-col justify-center text-[10px] gap-1 py-1.5 px-1 flex-1 min-w-0 min-h-[54px] border-t-2', active ? 'border-ice text-ice bg-ice/5' : 'border-transparent')
        : 'px-4 py-2.5 text-sm border-l-2',
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
      <button key={v} onClick={() => switchView(v)} className={cls} title={label}>
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
        return <Schedule onPlay={(g) => setMatchGame(g)} />;
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
      default:
        return <Dashboard onPlay={(g) => setMatchGame(g)} />;
    }
  })();

  return (
    <UIContext.Provider value={api}>
      {matchGame ? (
        <Match key={matchGame.id} game={matchGame} onFinished={() => { setMatchGame(null); setView(s.phase === 'offseason' ? 'offseason' : 'dashboard'); }} />
      ) : (
        <div className="min-h-screen flex">
          <aside className="hidden lg:flex flex-col w-56 shrink-0 border-r border-line bg-panel/80 sticky top-0 h-screen">
            <div className="p-4 border-b border-line">
              <div className="font-display text-2xl uppercase leading-none">
                КХЛ <span className="text-accent">ГМ</span>
              </div>
              <div className="text-[11px] text-muted mt-1">Симулятор генерального менеджера</div>
            </div>
            <div className="px-3 py-3 border-b border-line flex items-center gap-2">
              <TeamLogo team={U} size={36} />
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{U.name}</div>
                <div className="text-[11px] text-muted">{s.league.season} · {U.record.points} очков</div>
              </div>
            </div>
            <nav className="flex-1 py-2 overflow-y-auto">{nav.map((v) => navItem(v))}</nav>
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
              <button onClick={() => void exitToMenu()} className="flex items-center gap-2 hover:text-text w-full" title="Карьера будет сохранена — продолжить можно из главного меню">
                <Icon name="logout" /> В главное меню
              </button>
            </div>
          </aside>

          <main className="flex-1 min-w-0 rink-lines pb-[calc(4.5rem+env(safe-area-inset-bottom))] lg:pb-0">
            <header className="sticky top-0 z-30 bg-bg/90 backdrop-blur border-b border-line px-3 sm:px-4 py-2 flex items-center gap-2 sm:gap-3 flex-wrap">
              <button
                type="button"
                onClick={() => switchView('dashboard')}
                className="lg:hidden inline-flex items-center gap-1.5 pr-2 border-r border-line text-left"
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
              <Tag className="sm:hidden" color={s.phase === 'playoffs' ? '#F2B544' : s.phase === 'offseason' ? '#8FD8F0' : '#93A4BC'}>{phaseShort}</Tag>
              {s.phase === 'offseason' && view !== 'offseason' && (
                <Button size="sm" variant="primary" onClick={() => switchView('offseason')}>
                  <Icon name="trophy" /> <span className="hidden sm:inline">Межсезонье →</span><span className="sm:hidden">Драфт/ТО</span>
                </Button>
              )}
              <div className="ml-auto flex items-center gap-2 sm:gap-3">
                <div className="hidden md:flex items-center gap-2 text-xs text-muted">
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
            <div className="p-2.5 sm:p-4 max-w-[1500px] mx-auto">{content}</div>
          </main>

          <nav className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-panel/95 backdrop-blur border-t border-line flex justify-around px-1 pb-[env(safe-area-inset-bottom)]" aria-label="Разделы">
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

      {playerId && <PlayerModal id={playerId} onClose={() => setPlayerId(null)} />}
      {boxId != null && <GameBox gameId={boxId} onClose={() => setBoxId(null)} />}
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
          <div className="grid grid-cols-2 gap-2">
            {nav.map((v) => {
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
          <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-line">
            <button onClick={() => { setMoreOpen(false); setSavesOpen(true); }} className="flex items-center gap-2.5 rounded-sm border border-line bg-panel2 px-3 py-3 text-sm text-left hover:border-muted min-h-[44px]">
              <Icon name="save" /> Сохранения
            </button>
            <button onClick={() => void exitToMenu()} className="flex items-center gap-2.5 rounded-sm border border-line bg-panel2 px-3 py-3 text-sm text-left hover:border-muted min-h-[44px]">
              <Icon name="logout" /> Главное меню
            </button>
          </div>
        </Modal>
      )}
      {confirmModal}
    </UIContext.Provider>
  );
}
