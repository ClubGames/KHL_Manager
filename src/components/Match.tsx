import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MutableRefObject } from 'react';
import type { Game, GameEvent, Lineup } from '../types';
import type { BlockKind } from '../game/engine';
import { fmtClock } from '../game/engine';
import { commitUserResult, makeUserSim, useGame } from '../game/state';
import { applyEvent, emptyLive, foldEvents, manpower } from '../game/live';
import type { LiveStats } from '../game/live';
import { Button, Icon, Panel, PosBadge, TeamLogo } from './ui';
import { cn } from '../utils/cn';
import { GoalReplay } from './GoalReplay';

const RATE: Record<1 | 2 | 4, number> = { 1: 30, 2: 60, 4: 120 };

function cloneL(L: Lineup): Lineup {
  return { F: L.F.map((l) => [...l]), D: L.D.map((l) => [...l]), pp1: [...L.pp1], pp2: [...L.pp2], pk1: [...L.pk1], pk2: [...L.pk2], starterG: L.starterG, backupG: L.backupG };
}

const EVENT_COLOR: Record<string, string> = { goal: '#E5323E', shot: '#93A4BC', miss: '#93A4BC', penalty: '#F2B544', hit: '#8FD8F0', period_start: '#3FCF8E', period_end: '#3FCF8E', so_goal: '#E5323E', so_miss: '#93A4BC' };

export function Match({ game, onFinished }: { game: Game; onFinished: () => void }) {
  const s = useGame()!;
  const replayEnabled = s.settings?.goalReplay3d ?? true;
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
    const c = cloneL(userL);
    const g = c.starterG;
    c.starterG = c.backupG;
    c.backupG = g;
    setUserL(c);
    sim.setLineup(userIdx, c);
    sim.setGoalie(userIdx, c.starterG);
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
          <span className="ml-auto text-[11px] text-muted truncate">вратарь: {goalieName(ti)}</span>
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {ids.map((id, i) => {
            const p = id ? P[id] : null;
            return (
              <div key={i} className="rounded-sm bg-panel border border-line px-2 py-1.5 min-w-0">
                {p ? (
                  <>
                    <div className="flex items-center gap-1">
                      <PosBadge pos={p.position} />
                      <span className="font-display text-xs text-muted">{p.number}</span>
                    </div>
                    <div className="text-xs truncate mt-0.5">{p.name}</div>
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
      <header className="bg-panel border-b border-line">
        <div className="max-w-7xl mx-auto px-4 py-3 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <TeamLogo team={H} size={40} />
            <div className="min-w-0">
              <div className="font-display text-xl uppercase leading-none truncate">{H.name}</div>
              <div className="text-[11px] text-muted">дома · {H.record.points} очк.</div>
            </div>
            <span className="font-display text-5xl tabular leading-none ml-auto score-tick" key={`h${score[0]}`}>
              {score[0]}
            </span>
          </div>
          <div className="text-center px-4 min-w-[120px]">
            <ClockFace ticker={ticker} end={blockEnd} shootout={kind === 'so'} />
            <div className={cn('text-[11px] uppercase tracking-widest mt-1', paused ? 'text-amber' : 'text-muted')}>{paused ? 'Пауза' : periodLabel || 'Старт'}</div>
            <div className="h-5 mt-1 flex items-center justify-center">
              {mp.state !== null && (
                <span data-manpower className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-sm bg-amber/15 text-amber tabular whitespace-nowrap">
                  {mp.state === 'even' ? '4 на 4' : `Большинство ${mp.state === 0 ? H.short : A.short}`} · <PenaltyTimer ticker={ticker} live={live} />
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3 min-w-0 flex-row-reverse">
            <TeamLogo team={A} size={40} />
            <div className="min-w-0 text-right">
              <div className="font-display text-xl uppercase leading-none truncate">{A.name}</div>
              <div className="text-[11px] text-muted">в гостях · {A.record.points} очк.</div>
            </div>
            <span className="font-display text-5xl tabular leading-none mr-auto score-tick" key={`a${score[1]}`}>
              {score[1]}
            </span>
          </div>
        </div>
      </header>

      <div className="flex-1 max-w-7xl mx-auto w-full px-4 py-4 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <div className="space-y-3 min-w-0">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {renderOnIce(0)}
            {renderOnIce(1)}
          </div>
          <Panel title="Хроника матча" noPad className="min-h-[320px]">
            <div ref={feedRef} data-feed className="max-h-[52vh] overflow-y-auto divide-y divide-line/60">
              {feed.length === 0 && status === 'playing' && <div className="p-4 text-muted text-sm">Игра началась…</div>}
              <FeedRows feed={feed} onReplay={setReplayEvent} replayEnabled={replayEnabled} />
            </div>
          </Panel>
        </div>

        <div className="space-y-3">
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
            <div className="text-xs text-muted mt-3 mb-1">Пауза — клавиша «Пробел». Между периодами можно поменять звенья и вратаря.</div>
            {status !== 'done' && (
              <Button className="w-full mt-2" onClick={finishNow}>
                <Icon name="fast" /> Завершить мгновенно
              </Button>
            )}
          </Panel>
          <Panel title="Вратари">
            <div className="text-xs space-y-1">
              <div className="flex justify-between">
                <span className="truncate">{goalieName(0)}</span>
                <span className="tabular text-muted">{goalieLine(0) ? `${goalieLine(0)?.saves ?? 0}/${goalieLine(0)?.shotsAgainst ?? 0}` : '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="truncate">{goalieName(1)}</span>
                <span className="tabular text-muted">{goalieLine(1) ? `${goalieLine(1)?.saves ?? 0}/${goalieLine(1)?.shotsAgainst ?? 0}` : '—'}</span>
              </div>
            </div>
          </Panel>
        </div>
      </div>

      {replayEvent && replayEnabled && (
        <GoalReplay event={replayEvent} home={H} away={A} players={P} onClose={() => setReplayEvent(null)} />
      )}
      {status === 'intro' && (
        <Overlay>
          <div className="font-display text-3xl uppercase">Матч начинается</div>
          <div className="text-muted text-sm mt-2">{H.name} — {A.name}. Настройте звенья заранее или начните прямо сейчас.</div>
          <div className="flex gap-2 mt-5 flex-wrap justify-center">
            <Button variant="primary" size="lg" onClick={startBlock}>
              <Icon name="play" /> Начать матч
            </Button>
            <Button size="lg" onClick={finishNow}>
              <Icon name="fast" /> Симулировать
            </Button>
          </div>
        </Overlay>
      )}
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
              <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Звенья {userTeam.name} — нажмите на два звена, чтобы поменять их местами</div>
              <div className="grid grid-cols-4 gap-1.5">
                {userL.F.map((line, i) => (
                  <button key={i} onClick={() => (swapSel === null ? setSwapSel(i) : swapSel === i ? setSwapSel(null) : swapLine(swapSel, i))} className={cn('rounded-sm border p-2 text-xs transition-colors', swapSel === i ? 'border-accent bg-accent/15' : 'border-line bg-panel2 hover:border-muted')}>
                    <div className="font-display text-base">{i + 1}</div>
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
        <Overlay>
          <div className="text-[11px] uppercase tracking-widest text-muted">Матч завершён{res.so ? ' · буллиты' : res.ot ? ` · овертайм${res.periods > 4 ? ` ${res.periods - 3}×` : ''}` : ''}</div>
          <div className={cn('font-display text-5xl tabular', userWon ? 'text-ok' : 'text-accent')}>{userWon ? 'Победа' : 'Поражение'}</div>
          <div className="font-display text-3xl tabular mt-1">
            {H.short} {res.homeScore} : {res.awayScore} {A.short}
          </div>
          <div className="text-xs text-muted">
            {res.periodScores.map((p, i) => `${i < 3 ? i + 1 : 'OT'}-й: ${p[0]}-${p[1]}`).join(' · ')} · броски {res.homeStats.shots}:{res.awayStats.shots}
          </div>
          <div className="flex gap-2 mt-4 flex-wrap justify-center">
            {res.stars.map((id, i) => (
              <span key={id} className="text-xs bg-panel2 border border-amber/40 rounded-sm px-2 py-1">
                <span className="text-amber">★{i + 1}</span> {P[id]?.name} <span className="text-muted">({teamShort(id)})</span>
              </span>
            ))}
          </div>
          <div className="mt-4 w-full max-w-md text-left text-xs max-h-40 overflow-y-auto">
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
          <Button
            variant="primary"
            size="lg"
            className="mt-5"
            onClick={() => {
              commitUserResult(game.id, sim.result());
              onFinished();
            }}
          >
            Продолжить сезон
          </Button>
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

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 bg-bg/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-panel border border-line rounded-md p-6 max-w-xl w-full text-center shadow-2xl fade-in flex flex-col items-center">{children}</div>
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
  const text = useSyncExternalStore(ticker.subscribe, () => (shootout ? 'Буллиты' : fmtClock(Math.max(0, end.current - ticker.sec))));
  return (
    <div className="font-display text-2xl tabular leading-none" data-clock>
      {text}
    </div>
  );
}

function PenaltyTimer({ ticker, live }: { ticker: Ticker; live: MutableRefObject<LiveStats> }) {
  const text = useSyncExternalStore(ticker.subscribe, () => fmtClock(Math.ceil(manpower(live.current, ticker.sec).remaining)));
  return <>{text}</>;
}

const FeedRow = memo(function FeedRow({ e, onReplay, replayEnabled }: { e: GameEvent; onReplay: (event: GameEvent) => void; replayEnabled: boolean }) {
  return (
    <div className={cn('flex items-start gap-3 px-4 py-1.5 text-sm fade-in', e.type === 'goal' && 'bg-accent/10')}>
      <span className="w-14 shrink-0 text-[11px] text-muted tabular pt-0.5">{e.type === 'period_start' || e.type === 'period_end' ? '' : `${e.period <= 3 ? e.period : 'ОТ'} · ${e.time}`}</span>
      <span className="mt-0.5 shrink-0" style={{ color: EVENT_COLOR[e.type] ?? '#93A4BC' }}>
        <Icon name={e.type === 'goal' || e.type === 'so_goal' ? 'puck' : e.type === 'penalty' ? 'alert' : e.type === 'hit' ? 'injury' : e.type === 'shot' || e.type === 'miss' ? 'puck' : 'check'} />
      </span>
      <span className={cn('flex-1 min-w-0', e.type === 'goal' && 'font-semibold text-text', e.type === 'shot' || e.type === 'miss' || e.type === 'hit' ? 'text-text/75' : 'text-text/90')}>{e.text}</span>
      {e.type === 'goal' && replayEnabled && (
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
const FeedRows = memo(function FeedRows({ feed, onReplay, replayEnabled }: { feed: FeedItem[]; onReplay: (event: GameEvent) => void; replayEnabled: boolean }) {
  return (
    <>
      {feed.map((it) => (
        <FeedRow key={it.k} e={it.e} onReplay={onReplay} replayEnabled={replayEnabled} />
      ))}
    </>
  );
});
