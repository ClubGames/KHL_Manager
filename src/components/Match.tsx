import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MutableRefObject } from 'react';
import type { AttackStyle, ForecheckStyle, Game, GameEvent, Lineup, PullGoaliePolicy } from '../types';
import type { BlockKind } from '../game/engine';
import { fmtClock } from '../game/engine';
import { commitUserResult, makeUserSim, useGame } from '../game/state';
import { applyEvent, emptyLive, foldEvents, manpower } from '../game/live';
import type { LiveStats } from '../game/live';
import { Button, Icon, Panel, PosBadge, shortName, TeamLogo } from './ui';
import { cn } from '../utils/cn';
import { GoalReplay } from './GoalReplay';
import { ShotMap } from './ShotMap';
import { LineupPreview } from './LineupPreview';
import { previewPowerPlay } from '../game/lineupCompare';
import { ATTACK_STYLE_INFO, FORECHECK_INFO, freshnessTone, goalieFreshness, PULL_GOALIE_INFO } from '../game/chemistry';
import { formatMoney } from '../game/ratings';

const RATE: Record<1 | 2 | 4, number> = { 1: 30, 2: 60, 4: 120 };

function cloneL(L: Lineup): Lineup {
  return {
    F: L.F.map((l) => [...l]),
    D: L.D.map((l) => [...l]),
    pp1: [...L.pp1],
    pp2: [...L.pp2],
    pk1: [...L.pk1],
    pk2: [...L.pk2],
    starterG: L.starterG,
    backupG: L.backupG,
    u20F: L.u20F ?? null,
    u20D: L.u20D ?? null,
  };
}

const EVENT_COLOR: Record<string, string> = { goal: '#E5323E', shot: '#93A4BC', miss: '#93A4BC', penalty: '#F2B544', hit: '#8FD8F0', period_start: '#3FCF8E', period_end: '#3FCF8E', so_goal: '#E5323E', so_miss: '#93A4BC' };

export function Match({ game, onFinished }: { game: Game; onFinished: () => void }) {
  const s = useGame()!;
  const P = s.players;
  const H = s.teams[game.home];
  const A = s.teams[game.away];
  const userIdx: 0 | 1 = game.home === s.userTeamId ? 0 : 1;
  const ctx = useRef(makeUserSim(s, game)).current;
  const sim = ctx.sim;
  const [userL, setUserL] = useState<Lineup>(cloneL(sim.team(userIdx).lineup));
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const seq = useRef(0);
  // The game clock ticks every frame; only the two tiny clock components listen to it, the screen itself
  // re-renders when something actually happens (an event, a change of manpower, pause, end of period).
  const ticker = useRef(new Ticker()).current;
  const [mpKey, setMpKey] = useState('null');
  const mpRef = useRef('null');
  const [period, setPeriod] = useState(0);
  const [kind, setKind] = useState<BlockKind>('reg');
  const [status, setStatus] = useState<'intro' | 'playing' | 'break' | 'done'>('intro');
  const [speed, setSpeed] = useState<1 | 2 | 4>(2);
  const [curLines, setCurLines] = useState<[number, number]>([0, 0]);
  const [score, setScore] = useState<[number, number]>([0, 0]);
  const [curIce, setCurIce] = useState<[(string | null)[], (string | null)[]] | null>(null);
  const [paused, setPaused] = useState(false);
  // Statistics shown on screen are built only from events that have already been revealed.
  const live = useRef(emptyLive());
  const [goalFlash, setGoalFlash] = useState<string | null>(null);
  const [replayEvent, setReplayEvent] = useState<GameEvent | null>(null);
  const [countdown, setCountdown] = useState(8);
  const [swapSel, setSwapSel] = useState<number | null>(null);
  const [showPreLineup, setShowPreLineup] = useState(false);
  const [showPostMap, setShowPostMap] = useState(true);
  const [mobileTab, setMobileTab] = useState<'live' | 'coach' | 'stats'>('live');
  const [forecheck, setForecheckState] = useState<ForecheckStyle>(sim.tactics[userIdx].forecheck);
  const [attackStyle, setAttackStyleState] = useState<AttackStyle>(sim.tactics[userIdx].style);
  const [pullPolicy, setPullPolicyState] = useState<PullGoaliePolicy>(sim.tactics[userIdx].pullGoalie);
  const [timeoutUsed, setTimeoutUsed] = useState(false);
  const [pulledNow, setPulledNow] = useState(false);
  const [, setCoachTick] = useState(0);
  const periodEvs = useRef<GameEvent[]>([]);
  const idx = useRef(0);
  const clockRef = useRef(0);
  const blockStart = useRef(0);
  const blockEnd = useRef(0);
  const feedRef = useRef<HTMLDivElement>(null);

  const blockKind = (): BlockKind => (sim.status === 'ot' ? (sim.playoff ? 'ot5' : 'ot3') : sim.status === 'so' ? 'so' : 'reg');

  const startBlock = () => {
    const k = blockKind();
    const evs = k === 'so' ? sim.simShootout() : k === 'reg' ? sim.simPeriod() : sim.simOT();
    periodEvs.current = evs;
    idx.current = 0;
    blockStart.current = evs[0]?.sec ?? sim.sec;
    blockEnd.current = sim.sec;
    clockRef.current = blockStart.current;
    ticker.set(blockStart.current);
    setKind(k);
    setPeriod(sim.period);
    setPaused(false);
    setStatus('playing');
  };

  useEffect(() => {
    if (status !== 'playing' || paused || replayEvent) return;
    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      clockRef.current += dt * RATE[speed];
      const evs = periodEvs.current;
      const c = Math.min(clockRef.current, blockEnd.current);
      const newly: FeedItem[] = [];
      while (idx.current < evs.length && evs[idx.current].sec <= c) {
        const e = evs[idx.current++];
        newly.push({ k: seq.current++, e });
        applyEvent(live.current, e, game.home);
        if (e.score) setScore(e.score);
        if (e.lines) setCurLines(e.lines);
        if (e.ice) setCurIce(e.ice);
        if (e.type === 'goal') {
          setGoalFlash(e.team);
          window.setTimeout(() => setGoalFlash(null), 900);
          setReplayEvent(e);
          break;
        }
      }
      if (newly.length) setFeed((f) => [...newly.reverse(), ...f]);
      ticker.set(c);
      const mpNow = String(manpower(live.current, c).state);
      if (mpNow !== mpRef.current) {
        mpRef.current = mpNow;
        setMpKey(mpNow);
      }
      if (c >= blockEnd.current) {
        setStatus(sim.status === 'done' ? 'done' : 'break');
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [status, speed, sim, paused, replayEvent, game.home, ticker]);

  // Space toggles pause while the puck is in play.
  useEffect(() => {
    if (status !== 'playing') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if ((e.target as HTMLElement | null)?.closest?.('button, input, select, textarea, a')) return;
      e.preventDefault();
      setPaused((p) => !p);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status]);

  useEffect(() => {
    if (status !== 'break') return;
    setCountdown(kind === 'reg' && period >= 3 ? 4 : 8);
    const id = window.setInterval(() => setCountdown((c) => c - 1), 1000);
    return () => window.clearInterval(id);
  }, [status, kind, period]);
  useEffect(() => {
    if (status === 'break' && countdown <= 0) startBlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown, status]);

  useEffect(() => {
    (feedRef.current as unknown as { scrollTo?: (o: object) => void } | null)?.scrollTo?.({ top: 0, behavior: 'smooth' });
  }, [feed.length]);

  const finishNow = () => {
    let guard = 0;
    while (sim.status !== 'done' && guard++ < 30) {
      if (sim.status === 'ot') sim.simOT();
      else if (sim.status === 'so') sim.simShootout();
      else sim.simPeriod();
    }
    if (sim.status !== 'done') {
      sim.score[Math.random() < 0.5 ? 0 : 1]++;
      sim.status = 'done';
    }
    live.current = foldEvents(sim.events, game.home);
    seq.current = sim.events.length;
    setFeed(sim.events.map((e, k) => ({ k, e })).reverse());
    setScore([sim.score[0], sim.score[1]]);
    setPeriod(sim.period);
    setPaused(false);
    setStatus('done');
  };

  const applyLiveCoaching = (mutate: () => string | null) => {
    if (status === 'playing' && kind !== 'so') {
      // Ensure at least period_start has been revealed before replanning
      if (idx.current === 0 && periodEvs.current.length > 0) {
        const e0 = periodEvs.current[0];
        idx.current = 1;
        applyEvent(live.current, e0, game.home);
        setFeed((f) => [{ k: seq.current++, e: e0 }, ...f]);
      }
      const revealed = periodEvs.current.slice(0, idx.current);
      const updated = sim.replanLivePeriod(revealed, clockRef.current, s.userTeamId, mutate);
      if (updated) {
        periodEvs.current = updated;
        blockEnd.current = sim.sec;
        // Immediately reveal the coaching info event on the feed if present
        if (idx.current < updated.length && updated[idx.current].type === 'info') {
          const infoEv = updated[idx.current++];
          applyEvent(live.current, infoEv, game.home);
          setFeed((f) => [{ k: seq.current++, e: infoEv }, ...f]);
        }
        setCoachTick((x) => x + 1);
        return;
      }
    }
    mutate();
    setCoachTick((x) => x + 1);
  };

  const changeForecheck = (fc: ForecheckStyle) => {
    if (fc === forecheck) return;
    setForecheckState(fc);
    applyLiveCoaching(() => {
      sim.setForecheck(userIdx, fc);
      return `Тренерский мостик «${s.teams[s.userTeamId].short}»: система форчекинга → ${FORECHECK_INFO[fc].label}`;
    });
  };

  const changeAttackStyle = (st: AttackStyle) => {
    if (st === attackStyle) return;
    setAttackStyleState(st);
    applyLiveCoaching(() => {
      sim.setAttackStyle(userIdx, st);
      return `Тренерский мостик «${s.teams[s.userTeamId].short}»: акцент в атаке → ${ATTACK_STYLE_INFO[st].label}`;
    });
  };

  const changePullPolicy = (pl: PullGoaliePolicy) => {
    setPullPolicyState(pl);
    sim.setPullGoaliePolicy(userIdx, pl);
  };

  const callTimeoutNow = () => {
    if (timeoutUsed || status === 'done') return;
    setTimeoutUsed(true);
    applyLiveCoaching(() => {
      sim.useTeamTimeout(userIdx, clockRef.current);
      return `⏱ ТАЙМ-АУТ (30 сек) «${s.teams[s.userTeamId].name}» — тренерский штаб сбивает кураж соперника и выпускает лидеров!`;
    });
  };

  const toggleManualPullGoalie = () => {
    const next = !pulledNow;
    setPulledNow(next);
    applyLiveCoaching(() => {
      sim.setForceEmptyNet(userIdx, next);
      return next
        ? `⚡ ПУСТЫЕ ВОРОТА! «${s.teams[s.userTeamId].short}» меняет вратаря на шестого полевого игрока!`
        : `Вратарь «${s.teams[s.userTeamId].short}» возвращается в ворота.`;
    });
  };

  const swapLine = (i: number, j: number) => {
    const c = cloneL(userL);
    const f = c.F[i];
    c.F[i] = c.F[j];
    c.F[j] = f;
    const d = c.D[i % 3];
    c.D[i % 3] = c.D[j % 3];
    c.D[j % 3] = d;
    setUserL(c);
    sim.setLineup(userIdx, c);
    setSwapSel(null);
  };
  const switchGoalie = () => {
    if (!userL.backupG) return;
    const c = cloneL(userL);
    const g = c.starterG;
    c.starterG = c.backupG;
    c.backupG = g;
    setUserL(c);
    applyLiveCoaching(() => {
      sim.setLineup(userIdx, c);
      sim.setGoalie(userIdx, c.starterG);
      const newName = c.starterG && P[c.starterG] ? P[c.starterG].name : 'бэкап';
      return `🔄 Замена вратаря «${s.teams[s.userTeamId].short}»: в игру вступает ${newName}!`;
    });
  };

  const periodLabel = period === 0 ? '' : `${periodNameOf(period, kind)}`;
  const homeL = sim.team(0).lineup;
  const awayL = sim.team(1).lineup;
  const goalieName = (ti: 0 | 1) => {
    const gid = sim.goalies[ti];
    return gid && P[gid] ? P[gid].name : 'замена';
  };
  const stats = live.current;
  const goalieLine = (ti: 0 | 1) => {
    const gid = sim.goalies[ti];
    return gid ? stats.goalies[gid] ?? { saves: 0, shotsAgainst: 0, goalsAgainst: 0 } : undefined;
  };
  const mpState: 0 | 1 | 'even' | null = status === 'playing' && kind === 'reg' ? (mpKey === '0' ? 0 : mpKey === '1' ? 1 : mpKey === 'even' ? 'even' : null) : null;
  const mp = { state: mpState };
  const iceLabel = (ti: 0 | 1, li: number) => {
    if (kind === 'ot3') return 'овертайм · 3 на 3';
    if (mp.state === 'even') return '4 на 4';
    if (mp.state === ti) return 'большинство';
    if (mp.state !== null) return 'меньшинство';
    return `звено ${li + 1}`;
  };

  const renderOnIce = (ti: 0 | 1) => {
    const L = ti === 0 ? homeL : awayL;
    const li = curLines[ti];
    const F = L.F[li] ?? [];
    const D = L.D[li % 3] ?? [];
    const ids = curIce ? curIce[ti] : [...F, ...D];
    const team = ti === 0 ? H : A;
    const special = mp.state !== null && kind === 'reg';
    return (
      <div className={cn('rounded-md border p-2 transition-colors duration-300', goalFlash === team.id ? 'border-accent bg-accent/20 goal-flash' : 'border-line bg-panel2/60')}>
        <div className="flex items-center gap-2 mb-1.5">
          <TeamLogo team={team} size={18} />
          <span className={cn('text-[11px] uppercase tracking-wider', special ? 'text-amber' : 'text-muted')}>на льду · {iceLabel(ti, li)}</span>
          <span className="ml-auto text-[11px] text-muted truncate">вр: {shortName(goalieName(ti))}</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
          {ids.map((id, i) => {
            const p = id ? P[id] : null;
            return (
              <div key={i} className="rounded-sm bg-panel border border-line px-2 py-1.5 min-w-0 flex sm:block items-center gap-1.5">
                {p ? (
                  <>
                    <div className="flex items-center gap-1 shrink-0">
                      <PosBadge pos={p.position} />
                      <span className="font-display text-xs text-muted">{p.number}</span>
                    </div>
                    <div className="text-xs truncate sm:mt-0.5 min-w-0">
                      <span className="sm:hidden">{shortName(p.name)}</span>
                      <span className="hidden sm:inline">{p.name}</span>
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-muted">замена</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // The engine finishes a period ahead of the playback, so the result may only be read once the playback is over.
  const res = status === 'done' && sim.status === 'done' ? sim.result() : null;
  const teamShort = (id: string) => {
    const p = P[id];
    return p && p.teamId ? s.teams[p.teamId]?.short ?? '' : '';
  };
  const userTeam = s.teams[s.userTeamId];
  const userWon = res ? (res.homeScore > res.awayScore ? game.home : game.away) === userTeam.id : false;

  return (
    <div className="min-h-screen rink-lines flex flex-col fade-in">
      <header className="sticky top-0 z-30 bg-panel/95 backdrop-blur border-b border-line">
        {sim.derby && (
          <div className="bg-gradient-to-r from-accent/25 via-gold/20 to-accent/25 border-b border-gold/30 px-3 py-1 text-center text-[11px] sm:text-xs truncate" data-derby-banner>
            <span className="font-display uppercase tracking-wider font-bold text-gold">🔥 {sim.derby.title}</span>
            <span className="hidden sm:inline text-text/85 ml-2">{sim.derby.subtitle}</span>
            {game.home === s.userTeamId && (
              <span className="text-ok ml-2 font-semibold">· +{formatMoney(sim.derby.gateBonus)}</span>
            )}
          </div>
        )}
        <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2 sm:py-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-3">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <TeamLogo team={H} size={32} className="sm:w-10 sm:h-10" />
            <div className="min-w-0">
              <div className="font-display text-sm sm:text-xl uppercase leading-none truncate">
                <span className="sm:hidden">{H.short}</span>
                <span className="hidden sm:inline">{H.name}</span>
              </div>
              <div className="text-[10px] sm:text-[11px] text-muted truncate">дома · {H.record.points} очк.</div>
            </div>
            <span className="font-display text-3xl sm:text-5xl tabular leading-none ml-auto score-tick" key={`h${score[0]}`}>
              {score[0]}
            </span>
          </div>
          <div className="text-center px-1.5 sm:px-4 min-w-[82px] sm:min-w-[120px]">
            <ClockFace ticker={ticker} end={blockEnd} shootout={kind === 'so'} />
            <div className={cn('text-[10px] sm:text-[11px] uppercase tracking-widest mt-0.5 sm:mt-1', paused ? 'text-amber' : 'text-muted')}>{paused ? 'Пауза' : periodLabel || 'Старт'}</div>
            <div className="min-h-[18px] mt-0.5 flex items-center justify-center">
              {mp.state !== null && (
                <span data-manpower className="inline-flex items-center gap-1 text-[10px] sm:text-[11px] font-semibold uppercase tracking-wide px-1.5 sm:px-2 py-0.5 rounded-sm bg-amber/15 text-amber tabular whitespace-nowrap">
                  {mp.state === 'even' ? '4×4' : `ЧБ ${mp.state === 0 ? H.short : A.short}`} · <PenaltyTimer ticker={ticker} live={live} />
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-row-reverse">
            <TeamLogo team={A} size={32} className="sm:w-10 sm:h-10" />
            <div className="min-w-0 text-right">
              <div className="font-display text-sm sm:text-xl uppercase leading-none truncate">
                <span className="sm:hidden">{A.short}</span>
                <span className="hidden sm:inline">{A.name}</span>
              </div>
              <div className="text-[10px] sm:text-[11px] text-muted truncate">гости · {A.record.points} очк.</div>
            </div>
            <span className="font-display text-3xl sm:text-5xl tabular leading-none mr-auto score-tick" key={`a${score[1]}`}>
              {score[1]}
            </span>
          </div>
        </div>

        {/* Sticky Mobile Live Control Strip + Section Tabs */}
        <div className="lg:hidden border-t border-line/70 px-3 py-1.5 bg-bg/85 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={status !== 'playing'}
              onClick={() => setPaused((p) => !p)}
              className={cn(
                'px-2.5 py-1.5 rounded-sm text-xs font-semibold inline-flex items-center gap-1 border disabled:opacity-45',
                paused ? 'bg-ice text-bg border-ice' : 'bg-panel2 text-text border-line'
              )}
            >
              <Icon name={paused ? 'play' : 'pause'} className="w-3.5 h-3.5" />
              {paused ? 'Возобновить' : 'Пауза'}
            </button>
            <div className="inline-flex rounded-sm border border-line bg-panel2 p-0.5">
              {([1, 2, 4] as const).map((sp) => (
                <button
                  key={sp}
                  type="button"
                  onClick={() => setSpeed(sp)}
                  className={cn('px-2 py-1 rounded-sm text-xs font-semibold tabular', speed === sp ? 'bg-ice text-bg' : 'text-muted')}
                >
                  ×{sp}
                </button>
              ))}
            </div>
            {!timeoutUsed && status !== 'done' && (
              <button
                type="button"
                disabled={status === 'intro'}
                onClick={callTimeoutNow}
                className={cn(
                  'px-2 py-1.5 rounded-sm text-xs font-semibold border disabled:opacity-45',
                  sim.unansweredGoals[1 - userIdx] >= 2 ? 'bg-accent text-white border-accent' : 'bg-panel2 text-gold border-line'
                )}
              >
                ⏱ Т-А
              </button>
            )}
            {status !== 'done' && (
              <button
                type="button"
                onClick={finishNow}
                className="ml-auto px-2.5 py-1.5 rounded-sm text-xs font-semibold bg-panel2 border border-line text-muted hover:text-text"
              >
                В конец ⏭
              </button>
            )}
          </div>

          <div className="grid grid-cols-3 gap-1">
            {([
              ['live', 'Трансляция'],
              ['coach', 'Мостик и звенья'],
              ['stats', `Карта xG (${stats.shots[0]}:${stats.shots[1]})`],
            ] as const).map(([id, lbl]) => (
              <button
                key={id}
                type="button"
                onClick={() => setMobileTab(id)}
                className={cn(
                  'py-1.5 px-1 rounded-sm text-[11px] font-semibold text-center truncate transition-colors',
                  mobileTab === id ? 'bg-accent text-white' : 'bg-panel2/70 text-muted'
                )}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="flex-1 max-w-7xl mx-auto w-full px-3 sm:px-4 py-3 sm:py-4 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="space-y-3 min-w-0">
          <div className={cn('grid grid-cols-1 md:grid-cols-2 gap-2', mobileTab !== 'live' && 'hidden lg:grid')}>
            {renderOnIce(0)}
            {renderOnIce(1)}
          </div>
          <div className={cn(mobileTab !== 'stats' && 'hidden lg:block')}>
            <Panel title="Мини-карта опасных моментов (xG) и тепловая карта бросков">
              <ShotMap shots={stats.shotMap} home={H} away={A} players={P} compact />
            </Panel>
          </div>
          <div className={cn(mobileTab !== 'live' && 'hidden lg:block')}>
            <Panel title="Хроника матча" noPad className="min-h-[260px]">
              <div ref={feedRef} data-feed className="max-h-[46vh] sm:max-h-[42vh] overflow-y-auto divide-y divide-line/60">
                {feed.length === 0 && status === 'playing' && <div className="p-4 text-muted text-sm">Игра началась…</div>}
                <FeedRows feed={feed} onReplay={setReplayEvent} />
              </div>
            </Panel>
          </div>
        </div>

        <div className="space-y-3">
          <div className={cn(mobileTab !== 'stats' && 'hidden lg:block')}>
          <Panel title="Статистика" noPad>
            <table className="w-full text-sm tabular" data-live-stats data-shots={`${stats.shots[0]}:${stats.shots[1]}`} data-periods={stats.periods.map((x) => x.join('-')).join(' ')}>
              <thead>
                <tr className="text-[11px] uppercase tracking-wider text-muted">
                  <th className="text-left pl-4 py-2 font-semibold">{H.short}</th>
                  <th className="py-2 font-semibold"></th>
                  <th className="text-right pr-4 py-2 font-semibold">{A.short}</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-line/60">
                  <td className="pl-4 py-1.5 font-display text-lg">{stats.shots[0]}</td>
                  <td className="text-center text-xs text-muted">Броски</td>
                  <td className="pr-4 py-1.5 font-display text-lg text-right">{stats.shots[1]}</td>
                </tr>
                <tr className="border-t border-line/60">
                  <td className="pl-4 py-1.5 font-semibold text-accent">{stats.xg[0].toFixed(2)}</td>
                  <td className="text-center text-xs text-muted">Ожид. голы (xG)</td>
                  <td className="pr-4 py-1.5 font-semibold text-accent text-right">{stats.xg[1].toFixed(2)}</td>
                </tr>
                <tr className="border-t border-line/60">
                  <td className="pl-4 py-1.5 text-gold">{stats.dangerShots[0]}</td>
                  <td className="text-center text-xs text-muted">Опасные (xG ≥ 0.12)</td>
                  <td className="pr-4 py-1.5 text-gold text-right">{stats.dangerShots[1]}</td>
                </tr>
                <tr className="border-t border-line/60">
                  <td className="pl-4 py-1.5">{stats.ppGoals[0]}/{stats.ppChances[0]}</td>
                  <td className="text-center text-xs text-muted">Большинство</td>
                  <td className="pr-4 py-1.5 text-right">{stats.ppGoals[1]}/{stats.ppChances[1]}</td>
                </tr>
                <tr className="border-t border-line/60">
                  <td className="pl-4 py-1.5">{stats.hits[0]}</td>
                  <td className="text-center text-xs text-muted">Силовые</td>
                  <td className="pr-4 py-1.5 text-right">{stats.hits[1]}</td>
                </tr>
                <tr className="border-t border-line/60">
                  <td className="pl-4 py-1.5">{stats.pim[0]}</td>
                  <td className="text-center text-xs text-muted">Штраф, мин</td>
                  <td className="pr-4 py-1.5 text-right">{stats.pim[1]}</td>
                </tr>
                {stats.periods.length > 0 && (
                  <tr className="border-t border-line/60">
                    <td className="pl-4 py-1.5">{stats.periods.map((p) => p[0]).join(' ')}</td>
                    <td className="text-center text-xs text-muted">По периодам</td>
                    <td className="pr-4 py-1.5 text-right">{stats.periods.map((p) => p[1]).join(' ')}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </Panel>
          </div>
          <div className={cn('space-y-3', mobileTab !== 'coach' && 'hidden lg:block')}>
          <Panel title="Тренерский мостик (на лету)" data-live-coaching>
            <div className="space-y-2.5 text-xs">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Форчекинг и средняя зона</div>
                <div className="grid grid-cols-3 gap-1">
                  {(['aggressive', 'balanced', 'trap'] as const).map((fc) => (
                    <button
                      key={fc}
                      type="button"
                      disabled={status === 'done'}
                      onClick={() => changeForecheck(fc)}
                      title={FORECHECK_INFO[fc].desc}
                      className={cn(
                        'px-1.5 py-1.5 rounded-sm font-semibold text-[11px] border transition cursor-pointer',
                        forecheck === fc
                          ? 'bg-accent text-white border-accent'
                          : 'bg-panel2 border-line text-muted hover:text-text'
                      )}
                    >
                      {FORECHECK_INFO[fc].short}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Акцент в атаке</div>
                <div className="grid grid-cols-3 gap-1">
                  {(['shoot', 'balanced', 'cycle'] as const).map((st) => (
                    <button
                      key={st}
                      type="button"
                      disabled={status === 'done'}
                      onClick={() => changeAttackStyle(st)}
                      title={ATTACK_STYLE_INFO[st].desc}
                      className={cn(
                        'px-1.5 py-1.5 rounded-sm font-semibold text-[11px] border transition cursor-pointer',
                        attackStyle === st
                          ? 'bg-ice text-bg border-ice'
                          : 'bg-panel2 border-line text-muted hover:text-text'
                      )}
                    >
                      {ATTACK_STYLE_INFO[st].short}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Автоснятие вратаря в 3-м периоде</div>
                <div className="grid grid-cols-3 gap-1">
                  {(['early', 'normal', 'never'] as const).map((pl) => (
                    <button
                      key={pl}
                      type="button"
                      disabled={status === 'done'}
                      onClick={() => changePullPolicy(pl)}
                      className={cn(
                        'px-1.5 py-1 rounded-sm font-semibold text-[11px] border transition cursor-pointer',
                        pullPolicy === pl ? 'bg-gold/25 border-gold text-gold' : 'bg-panel2 border-line text-muted hover:text-text'
                      )}
                    >
                      {PULL_GOALIE_INFO[pl].short}
                    </button>
                  ))}
                </div>
              </div>

              {status !== 'done' && (
                <div className="grid grid-cols-1 gap-1.5 pt-1 border-t border-line/60">
                  <Button
                    size="sm"
                    variant={!timeoutUsed && sim.unansweredGoals[1 - userIdx] >= 2 ? 'primary' : 'secondary'}
                    disabled={timeoutUsed || status === 'intro'}
                    onClick={callTimeoutNow}
                  >
                    ⏱ {timeoutUsed ? 'Тайм-аут использован' : sim.unansweredGoals[1 - userIdx] >= 2 ? 'Взять тайм-аут (сбить натиск!)' : 'Тайм-аут 30 сек'}
                  </Button>
                  {userL.backupG && (
                    <Button size="sm" variant="secondary" onClick={switchGoalie}>
                      🔄 Сменить вратаря → {P[userL.backupG]?.name.split(' ').slice(-1)[0] ?? 'бэкап'}
                    </Button>
                  )}
                  {period === 3 && kind === 'reg' && status === 'playing' && (
                    <Button
                      size="sm"
                      variant={pulledNow ? 'danger' : 'secondary'}
                      onClick={toggleManualPullGoalie}
                    >
                      {pulledNow ? 'Вернуть вратаря в ворота' : '⚡ Снять вратаря (6-й полевой)'}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </Panel>

          <Panel title="Управление">
            <div className="flex items-center gap-2 text-xs text-muted mb-2">Скорость</div>
            <div className="grid grid-cols-3 gap-1.5">
              {([1, 2, 4] as const).map((sp) => (
                <button key={sp} onClick={() => setSpeed(sp)} className={cn('text-sm py-1.5 rounded-sm font-semibold', speed === sp ? 'bg-ice text-bg' : 'bg-panel2 text-muted hover:text-text')}>
                  ×{sp}
                </button>
              ))}
            </div>
            <Button className="w-full mt-2" variant={paused ? 'ice' : 'secondary'} disabled={status !== 'playing'} onClick={() => setPaused((p) => !p)} title="Пробел">
              <Icon name={paused ? 'play' : 'pause'} /> {paused ? 'Возобновить' : 'Пауза'}
            </Button>
            <div className="text-xs text-muted mt-3 mb-1">Пауза — клавиша «Пробел». Тактику, тайм-аут и вратаря можно менять прямо по ходу периода!</div>
            {status !== 'done' && (
              <Button className="w-full mt-2" onClick={finishNow}>
                <Icon name="fast" /> Завершить мгновенно
              </Button>
            )}
          </Panel>
          </div>
          <div className={cn(mobileTab !== 'stats' && mobileTab !== 'coach' && 'hidden lg:block')}>
          <Panel title="Вратари и свежесть">
            <div className="text-xs space-y-1.5">
              {([0, 1] as const).map((ti) => {
                const gid = sim.goalies[ti];
                const gp = gid ? P[gid] : null;
                const fr = goalieFreshness(gp);
                const ft = freshnessTone(fr);
                const gl = goalieLine(ti);
                return (
                  <div key={ti} className="flex items-center justify-between gap-2">
                    <span className="truncate">{goalieName(ti)}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded tabular" style={{ background: ft.color + '22', color: ft.color }}>
                      {fr}%
                    </span>
                    <span className="tabular text-muted">{gl ? `${gl.saves}/${gl.shotsAgainst}` : '—'}</span>
                  </div>
                );
              })}
            </div>
          </Panel>
          </div>
        </div>
      </div>

      {replayEvent && (
        <GoalReplay event={replayEvent} home={H} away={A} players={P} onClose={() => setReplayEvent(null)} />
      )}
      {status === 'intro' && (() => {
        const oppId = game.home === s.userTeamId ? game.away : game.home;
        const [pp1, pp2] = previewPowerPlay(s, s.userTeamId, oppId, userL);
        return (
          <Overlay wide={showPreLineup}>
            <div className="font-display text-3xl uppercase">
              {sim.derby ? `🔥 ${sim.derby.title}` : 'Матч начинается'}
            </div>
            <div className="text-muted text-sm mt-1">
              {H.name} — {A.name}. {sim.derby ? `${sim.derby.subtitle}. ` : ''}Проверьте тактику, свежесть вратаря и бригады большинства до стартового вбрасывания.
            </div>
            {(() => {
              const stG = userL.starterG ? P[userL.starterG] : null;
              const bkG = userL.backupG ? P[userL.backupG] : null;
              const stFresh = goalieFreshness(stG);
              if (stG && stFresh < 66 && bkG) {
                return (
                  <div className="mt-2 w-full rounded-md border border-gold/50 bg-gold/10 px-3 py-2 text-xs flex items-center justify-between gap-2">
                    <span className="text-gold text-left">
                      ⚠ Стартер <b>{stG.name}</b> подустал (свежесть <b>{stFresh}%</b>) — бэкап <b>{bkG.name}</b> свеж на <b>{goalieFreshness(bkG)}%</b>!
                    </span>
                    <Button size="sm" variant="secondary" onClick={switchGoalie}>
                      Выпустить {bkG.name.split(' ').slice(-1)[0]}
                    </Button>
                  </div>
                );
              }
              return null;
            })()}

            {/* Compact pre-game PP preview right in the intro card */}
            <div className="mt-3 w-full rounded-lg border border-line bg-bg/55 p-3 text-left text-xs space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-display uppercase tracking-wider text-accent font-semibold">
                  Кто выйдет в большинстве ({userTeam.short})
                </span>
                <span className="text-muted">Прогноз ЧБ: <b className="text-ice">{pp1.expectedPpPct}%</b></span>
              </div>
              <div className="text-[11px] text-ice">
                <span className="text-muted">1-я ЧБ (~58%): </span>
                {pp1.slots.map((sl) => sl.player?.name).filter(Boolean).join(' · ')}
              </div>
              <div className="text-[11px] text-ice/85">
                <span className="text-muted">2-я ЧБ (~42%): </span>
                {pp2.slots.map((sl) => sl.player?.name).filter(Boolean).join(' · ')}
              </div>
            </div>

            {showPreLineup && (
              <div className="mt-3 w-full max-h-[52vh] overflow-y-auto text-left">
                <LineupPreview
                  state={s}
                  leftTeamId={s.userTeamId}
                  initialOpponentId={oppId}
                  overrideLeftLineup={userL}
                  allowPickOpponent={false}
                  initialTab="compare"
                />
              </div>
            )}

            <div className="flex gap-2 mt-4 flex-wrap justify-center">
              <Button variant="primary" size="lg" onClick={startBlock}>
                <Icon name="play" /> Начать матч
              </Button>
              <Button size="lg" onClick={finishNow}>
                <Icon name="fast" /> Симулировать
              </Button>
              <Button variant="secondary" size="lg" onClick={() => setShowPreLineup((v) => !v)}>
                {showPreLineup ? 'Скрыть тактику' : 'Сравнение звеньев и схема ЧБ'}
              </Button>
            </div>
          </Overlay>
        );
      })()}
      {status === 'break' && (
        <Overlay>
          <div className="text-[11px] uppercase tracking-widest text-muted">{periodNameOf(period, kind)} завершён</div>
          <div className="font-display text-4xl tabular">
            {score[0]} : {score[1]}
          </div>
          <div className="text-xs text-muted mb-3">
            {H.short} {sim.periodScores.map((p) => p[0]).join(' ')} · {A.short} {sim.periodScores.map((p) => p[1]).join(' ')}
          </div>
          {sim.status !== 'so' && sim.status !== 'ot' && (
            <div className="text-left w-full max-w-md">
              <div className="text-[11px] uppercase tracking-wider text-muted mb-1.5">Звенья {userTeam.name} — нажмите на два звена, чтобы поменять их местами</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                {userL.F.map((line, i) => (
                  <button key={i} onClick={() => (swapSel === null ? setSwapSel(i) : swapSel === i ? setSwapSel(null) : swapLine(swapSel, i))} className={cn('rounded-sm border p-2 text-xs transition-colors text-left sm:text-center', swapSel === i ? 'border-accent bg-accent/15' : 'border-line bg-panel2 hover:border-muted')}>
                    <div className="font-display text-base">{i + 1}-е звено</div>
                    <div className="truncate">{line.filter(Boolean).map((id) => P[id!]?.name.split(' ').slice(-1)[0]).join(' · ') || '—'}</div>
                  </button>
                ))}
              </div>
              <div className="flex gap-2 mt-3 justify-center">
                {userL.backupG && (
                  <Button size="sm" onClick={switchGoalie}>
                    Сменить вратаря → {sim.goalies[userIdx] === userL.starterG ? P[userL.backupG ?? '']?.name ?? '—' : P[userL.starterG ?? '']?.name ?? '—'}
                  </Button>
                )}
              </div>
            </div>
          )}
          <div className="flex gap-2 mt-4 flex-wrap justify-center items-center">
            <Button variant="primary" size="lg" onClick={startBlock}>
              Продолжить
            </Button>
            <span className="text-xs text-muted">автоматически через {Math.max(0, countdown)} с</span>
            <Button size="lg" onClick={finishNow}>
              <Icon name="fast" /> Завершить мгновенно
            </Button>
          </div>
        </Overlay>
      )}
      {status === 'done' && res && (
        <Overlay wide={showPostMap}>
          <div className="text-[11px] uppercase tracking-widest text-muted">Матч завершён{res.so ? ' · буллиты' : res.ot ? ` · овертайм${res.periods > 4 ? ` ${res.periods - 3}×` : ''}` : ''}</div>
          <div className={cn('font-display text-5xl tabular', userWon ? 'text-ok' : 'text-accent')}>{userWon ? 'Победа' : 'Поражение'}</div>
          <div className="font-display text-3xl tabular mt-1">
            {H.short} {res.homeScore} : {res.awayScore} {A.short}
          </div>
          <div className="text-xs text-muted">
            {res.periodScores.map((p, i) => `${i < 3 ? i + 1 : 'OT'}-й: ${p[0]}-${p[1]}`).join(' · ')} · броски {res.homeStats.shots}:{res.awayStats.shots} · xG {(res.homeStats.xg ?? 0).toFixed(2)}:{(res.awayStats.xg ?? 0).toFixed(2)}
          </div>
          <div className="flex gap-2 mt-3 flex-wrap justify-center">
            {res.stars.map((id, i) => (
              <span key={id} className="text-xs bg-panel2 border border-amber/40 rounded-sm px-2 py-1">
                <span className="text-amber">★{i + 1}</span> {P[id]?.name} <span className="text-muted">({teamShort(id)})</span>
              </span>
            ))}
          </div>
          {showPostMap && (res.shotMap?.length ?? stats.shotMap.length) > 0 && (
            <div className="mt-3 w-full text-left">
              <ShotMap shots={res.shotMap ?? stats.shotMap} home={H} away={A} players={P} compact />
            </div>
          )}
          <div className="mt-3 w-full max-w-lg text-left text-xs max-h-32 overflow-y-auto">
            {res.scorers.map((sc, i) => (
              <div key={i} className="flex gap-2 py-0.5">
                <span className="w-12 text-muted tabular shrink-0">{sc.period <= 3 ? sc.period : 'ОТ'} · {sc.time}</span>
                <span>
                  <b className={sc.team === game.home ? 'text-ice' : 'text-amber'}>{s.teams[sc.team].short}</b> {P[sc.scorer]?.name}
                  {sc.assists.length > 0 && <span className="text-muted"> ({sc.assists.map((a) => P[a]?.name).join(', ')})</span>}
                </span>
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-4 flex-wrap justify-center">
            <Button variant="secondary" onClick={() => setShowPostMap((v) => !v)}>
              {showPostMap ? 'Скрыть карту бросков' : 'Показать карту xG / тепловую'}
            </Button>
            <Button
              variant="primary"
              size="lg"
              onClick={() => {
                commitUserResult(game.id, sim.result());
                onFinished();
              }}
            >
              Продолжить сезон
            </Button>
          </div>
        </Overlay>
      )}
    </div>
  );
}

function periodNameOf(period: number, kind: BlockKind): string {
  if (kind === 'so') return 'Буллиты';
  if (period <= 3) return `${period}-й период`;
  if (kind === 'ot3') return 'Овертайм';
  return period === 4 ? 'Овертайм' : `${period - 3}-й овертайм`;
}

function Overlay({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-40 bg-bg/85 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto">
      <div className={cn('bg-panel border-t sm:border border-line rounded-t-xl sm:rounded-md p-4 sm:p-5 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-5 w-full text-center shadow-2xl fade-in flex flex-col items-center max-h-[92dvh] overflow-y-auto overscroll-contain', wide ? 'max-w-4xl' : 'max-w-xl')}>
        {children}
      </div>
    </div>
  );
}

interface FeedItem {
  /** stable number of the event within the match */
  k: number;
  e: GameEvent;
}

/** Game clock shared by the playback loop and the components that display time. */
class Ticker {
  sec = 0;
  private subs = new Set<() => void>();
  subscribe = (f: () => void) => {
    this.subs.add(f);
    return () => {
      this.subs.delete(f);
    };
  };
  set(v: number) {
    this.sec = v;
    for (const f of this.subs) f();
  }
}

function ClockFace({ ticker, end, shootout }: { ticker: Ticker; end: MutableRefObject<number>; shootout: boolean }) {
  const get = () => (shootout ? 'Буллиты' : fmtClock(Math.max(0, end.current - ticker.sec)));
  const text = useSyncExternalStore(ticker.subscribe, get, get);
  return (
    <div className="font-display text-2xl tabular leading-none" data-clock>
      {text}
    </div>
  );
}

function PenaltyTimer({ ticker, live }: { ticker: Ticker; live: MutableRefObject<LiveStats> }) {
  const get = () => fmtClock(Math.ceil(manpower(live.current, ticker.sec).remaining));
  const text = useSyncExternalStore(ticker.subscribe, get, get);
  return <>{text}</>;
}

const FeedRow = memo(function FeedRow({ e, onReplay }: { e: GameEvent; onReplay: (event: GameEvent) => void }) {
  return (
    <div className={cn('flex items-start gap-3 px-4 py-1.5 text-sm fade-in', e.type === 'goal' && 'bg-accent/10')}>
      <span className="w-14 shrink-0 text-[11px] text-muted tabular pt-0.5">{e.type === 'period_start' || e.type === 'period_end' ? '' : `${e.period <= 3 ? e.period : 'ОТ'} · ${e.time}`}</span>
      <span className="mt-0.5 shrink-0" style={{ color: EVENT_COLOR[e.type] ?? '#93A4BC' }}>
        <Icon name={e.type === 'goal' || e.type === 'so_goal' ? 'puck' : e.type === 'penalty' ? 'alert' : e.type === 'hit' ? 'injury' : e.type === 'shot' || e.type === 'miss' ? 'puck' : 'check'} />
      </span>
      <span className={cn('flex-1 min-w-0', e.type === 'goal' && 'font-semibold text-text', e.type === 'shot' || e.type === 'miss' || e.type === 'hit' ? 'text-text/75' : 'text-text/90')}>{e.text}</span>
      {e.xg !== undefined && (e.type === 'goal' || e.xg >= 0.12) && (
        <span className={cn('shrink-0 text-[10px] tabular px-1.5 py-0.5 rounded', e.xg >= 0.12 ? 'bg-gold/15 text-gold font-semibold' : 'bg-panel2 text-muted')}>
          xG {e.xg.toFixed(2)}
        </span>
      )}
      {e.type === 'goal' && (
        <button onClick={() => onReplay(e)} className="shrink-0 text-[10px] uppercase tracking-wide rounded border border-accent/40 px-2 py-1 text-accent hover:bg-accent/10" title="Посмотреть 3D-повтор">3D повтор</button>
      )}
      {e.score && (
        <span className="font-display text-sm tabular text-muted shrink-0">
          {e.score[0]}:{e.score[1]}
        </span>
      )}
    </div>
  );
});

/** The feed re-renders only when an event is added, and then only the new row is created. */
const FeedRows = memo(function FeedRows({ feed, onReplay }: { feed: FeedItem[]; onReplay: (event: GameEvent) => void }) {
  return (
    <>
      {feed.map((it) => (
        <FeedRow key={it.k} e={it.e} onReplay={onReplay} />
      ))}
    </>
  );
});
