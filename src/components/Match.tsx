import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { MutableRefObject } from 'react';
import type { AttackStyle, ForecheckStyle, Game, GameEvent, Lineup, PullGoaliePolicy } from '../types';
import type { BlockKind } from '../game/engine';
import { fmtClock } from '../game/engine';
import { commitUserResult, makeUserSim, useGame } from '../game/state';
import { applyEvent, emptyLive, foldEvents, manpower } from '../game/live';
import { Button, Icon, Panel, PlayerFace, PosBadge, shortName, TeamLogo, useUI } from './ui';
import { autoReplayFor, getSettings, useSettings } from '../game/settings';
import { prewarmReplays, type FigureRequest } from './replayCache';
import { arenaDetail, resolveReplayQuality } from './ReplayScene';
import { cn } from '../utils/cn';
import { GoalReplay } from './GoalReplay';
import { ShooterPicker, ShootoutBoard } from './Shootout';
import { goalEventFor } from '../game/live';
import type { ReplayClip } from '../game/rinkPlayback';
import { ShotMap } from './ShotMap';
import { RinkAI, type PlayKind, type RinkPlay, type RinkTactics } from '../game/rinkAI';
import { LiveRink } from './RinkView';
import { endsSwitched } from '../game/rinkGeometry';
import { LineupPreview } from './LineupPreview';
import { previewPowerPlay } from '../game/lineupCompare';
import { ATTACK_STYLE_INFO, FORECHECK_INFO, freshnessTone, goalieFreshness, PULL_GOALIE_INFO } from '../game/chemistry';
import { formatMoney } from '../game/ratings';
import { intermissionHints, promoteToPP1, swapInLineup, type CoachHint } from '../game/assistant';
import { BreakStats } from './BreakStats';

const RATE: Record<1 | 2 | 4, number> = { 1: 30, 2: 60, 4: 120 };
/** Seconds between shootout attempts at each speed: one shooter at a time, with a moment to see the result. */
const SO_STEP: Record<1 | 2 | 4, number> = { 1: 2.6, 2: 1.7, 4: 0.85 };
/** Three different shooters still in the lineup (the best remaining ones fill any gap). */
const validPick = (pick: string[], candidates: string[]) => {
  const out = pick.filter((id, i) => candidates.includes(id) && pick.indexOf(id) === i).slice(0, 3);
  for (const id of candidates) if (out.length < 3 && !out.includes(id)) out.push(id);
  return out;
};
const clipKey = (e: GameEvent) => `${e.period}:${e.sec}:${e.player ?? ''}`;
/** Rink plays that also go to the match feed (the engine already reports shots, goals, penalties and hits). */
const FEED_PLAYS = new Set<PlayKind>(['faceoff', 'takeaway', 'interception', 'block', 'icing', 'offside']);
const PLAY_ICON: Partial<Record<PlayKind, string>> = { faceoff: '◎', takeaway: '⇄', interception: '✂', block: '▣', icing: '⇥', offside: '⊘' };

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
  const [mpKey, setMpKey] = useState('null|55');
  const mpRef = useRef('null|55');
  const [period, setPeriod] = useState(0);
  const [kind, setKind] = useState<BlockKind>('reg');
  const [status, setStatus] = useState<'intro' | 'playing' | 'break' | 'done'>('intro');
  const [speed, setSpeed] = useState<1 | 2 | 4>(() => getSettings().matchSpeed);
  const [curLines, setCurLines] = useState<[number, number]>([0, 0]);
  const [score, setScore] = useState<[number, number]>([0, 0]);
  const [curIce, setCurIce] = useState<[(string | null)[], (string | null)[]] | null>(null);
  const [paused, setPaused] = useState(false);
  // Statistics shown on screen are built only from events that have already been revealed.
  const live = useRef(emptyLive());
  const [goalFlash, setGoalFlash] = useState<string | null>(null);
  const [replayEvent, setReplayEvent] = useState<GameEvent | null>(null);
  const [countdown, setCountdown] = useState(8);
  // The viewer is reading the intermission window (stats tabs, lines): it waits for «Продолжить».
  const [breakHold, setBreakHold] = useState(false);
  // Bench advice at a whistle (timeout, goalie change, pulling/returning the goalie): the match waits for the answer.
  const [advice, setAdvice] = useState<BenchAdvice | null>(null);
  const [adviceLeft, setAdviceLeft] = useState(0);
  const adviceDone = useRef(new Set<string>());
  const adviceCheck = useRef<(c: number) => boolean>(() => false);
  const wasStopped = useRef(true);
  const goalsSeen = useRef<GameEvent[]>([]);
  const goalieSwitched = useRef(false);
  const [swapSel, setSwapSel] = useState<number | null>(null);
  const [showPreLineup, setShowPreLineup] = useState(false);
  const [showPostMap, setShowPostMap] = useState(true);
  const [showRink, setShowRink] = useState(() => getSettings().matchRink2d);
  const [mobileTab, setMobileTab] = useState<'live' | 'coach' | 'stats'>('live');
  const land = useLandscapePhone();
  const [forecheck, setForecheckState] = useState<ForecheckStyle>(sim.tactics[userIdx].forecheck);
  const [attackStyle, setAttackStyleState] = useState<AttackStyle>(sim.tactics[userIdx].style);
  const [pullPolicy, setPullPolicyState] = useState<PullGoaliePolicy>(sim.tactics[userIdx].pullGoalie);
  const [timeoutUsed, setTimeoutUsed] = useState(false);
  const [pulledNow, setPulledNow] = useState(false);
  const [visibleGoalies, setVisibleGoalies] = useState<[string | null, string | null]>([sim.goalies[0], sim.goalies[1]]);
  const [, setCoachTick] = useState(0);
  const [shortBenchOn, setShortBenchOn] = useState(false);
  const [doneHints, setDoneHints] = useState<string[]>([]);
  const periodEvs = useRef<GameEvent[]>([]);
  // Agent-based rink simulation of the current period; `tau` is presentation time (keeps running at whistles).
  const rinkAI = useRef<RinkAI | null>(null);
  const tauRef = useRef(0);
  const playIdx = useRef(0);
  const iceSig = useRef('');
  const doneTally = useRef<RinkTally>({ faceoff: [0, 0], block: [0, 0], takeaway: [0, 0], icing: [0, 0], offside: [0, 0] });
  const paceRef = useRef<number>(RinkAI.PACE.cold);
  const idx = useRef(0);
  const clockRef = useRef(0);
  const blockStart = useRef(0);
  const blockEnd = useRef(0);
  const feedRef = useRef<HTMLDivElement>(null);
  // Shootout: attempts are revealed one by one (soAcc counts revealed steps).
  const soMode = useRef(false);
  const soAcc = useRef(0);
  const [soPick, setSoPick] = useState<string[]>(() => sim.shootoutCandidates(userIdx).slice(0, 3));
  const ui = useUI();
  const settings = useSettings();
  // 3D replays are prepared in the background while the match runs (arena + every dressed player), so the
  // first goal's replay opens at once instead of building the scene and compiling its shaders on the spot.
  const prewarm = settings.replay3d && settings.replayPrewarm, prewarmDetail = arenaDetail(resolveReplayQuality(settings.replayQuality));
  useEffect(() => {
    if (!prewarm) return;
    const figures: FigureRequest[] = [];
    ([0, 1] as const).forEach((side) => {
      const L = sim.team(side).lineup;
      [...L.F.flat(), ...L.D.flat()].forEach((id) => { if (id) figures.push({ id, side, goalie: false }); });
      if (L.starterG) figures.push({ id: L.starterG, side, goalie: true });
    });
    return prewarmReplays({ home: H, away: A, players: P, figures, detail: prewarmDetail });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prewarm, prewarmDetail]);
  // Everyone who may step on the ice in the 3D match (figures are prepared up front, not when he jumps over the boards).
  const roster3d = useMemo(() => {
    const out: FigureRequest[] = [], seen = new Set<string>();
    ([0, 1] as const).forEach((side) => {
      const L = sim.team(side).lineup;
      const add = (id: string | null | undefined, goalie: boolean) => { if (id && !seen.has(id)) { seen.add(id); out.push({ id, side, goalie }); } };
      [...L.F.flat(), ...L.D.flat(), L.u20F, L.u20D].forEach((id) => add(id, false));
      add(L.starterG, true); add(L.backupG, true);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim]);
  // Rink-based motion of every goal, kept after its period is over so the goals can be replayed after the match.
  const clips = useRef(new Map<string, ReplayClip>());
  const clipFor = (e: GameEvent): ReplayClip | undefined => {
    const key = clipKey(e);
    let c = clips.current.get(key);
    if (!c && rinkAI.current) {
      c = rinkAI.current.goalClip(e) ?? undefined;
      if (c) clips.current.set(key, c);
    }
    return c;
  };

  const blockKind = (): BlockKind => (sim.status === 'ot' ? (sim.playoff ? 'ot5' : 'ot3') : sim.status === 'so' ? 'so' : 'reg');

  const startBlock = () => {
    const k = blockKind();
    setVisibleGoalies([sim.team(0).lineup.starterG, sim.team(1).lineup.starterG]);
    if (rinkAI.current) {
      for (const e of periodEvs.current) if (e.type === 'goal') clipFor(e);
      const t = rinkAI.current.tally(Infinity);
      (Object.keys(t) as (keyof RinkTally)[]).forEach(key => { doneTally.current[key][0] += t[key][0]; doneTally.current[key][1] += t[key][1]; });
      rinkAI.current = null;
    }
    if (k === 'so') sim.soOrder[userIdx] = validPick(soPick, sim.shootoutCandidates(userIdx));
    soMode.current = k === 'so';
    soAcc.current = 0;
    const evs = k === 'so' ? sim.simShootout() : k === 'reg' ? sim.simPeriod() : sim.simOT();
    periodEvs.current = evs;
    idx.current = 0;
    blockStart.current = evs[0]?.sec ?? sim.sec;
    blockEnd.current = sim.sec;
    rinkAI.current = k === 'so' ? null : new RinkAI(evs, H, A, P, blockStart.current, blockEnd.current, {
      suddenDeath: k !== 'reg',
      // Teams switch ends every period (and for the overtime).
      flip: endsSwitched(sim.period),
      goalies: [sim.team(0).lineup.starterG || null, sim.team(1).lineup.starterG || null],
      tactics: (): RinkTactics => [
        { forecheck: sim.tactics[0].forecheck, style: sim.tactics[0].style },
        { forecheck: sim.tactics[1].forecheck, style: sim.tactics[1].style },
      ],
    });
    tauRef.current = 0;
    wasStopped.current = true;
    playIdx.current = 0;
    iceSig.current = '';
    paceRef.current = RinkAI.PACE.cold;
    clockRef.current = blockStart.current;
    ticker.set(blockStart.current, 0);
    setCurIce(null);
    setCurLines([0, 0]);
    setKind(k);
    setPeriod(sim.period);
    setPaused(false);
    setStatus('playing');
  };

  useEffect(() => {
    if (status !== 'playing' || paused || replayEvent) return;
    let raf = 0;
    let last = performance.now(), waited = 0;
    const loop = (t: number) => {
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      // The match waits while the 3D picture is being prepared (at most a few seconds), so nothing is missed.
      if (ticker.wait && waited < 8) { waited += dt; raf = requestAnimationFrame(loop); return; }
      const ai = rinkAI.current;
      if (ai) {
        // Highlights play near real time, routine skating is fast-forwarded; the change of pace is eased.
        const want = ai.paceAt(tauRef.current);
        paceRef.current += (want - paceRef.current) * Math.min(1, dt * 5);
        tauRef.current = Math.min(tauRef.current + dt * speed * paceRef.current, ai.ended ? ai.lastTau : Infinity);
        ai.ensure(tauRef.current);
        // The game clock comes from the rink: it stands still from every whistle until the puck is dropped.
        clockRef.current = Math.max(clockRef.current, ai.clockAt(tauRef.current));
        if (ai.ended && tauRef.current >= ai.lastTau) clockRef.current = blockEnd.current;
      } else if (soMode.current) soAcc.current += dt / SO_STEP[speed];
      else clockRef.current += dt * RATE[speed];
      const evs = periodEvs.current;
      let c = Math.min(clockRef.current, blockEnd.current);
      const soShown = 1 + Math.floor(soAcc.current);
      let hitGoal = false;
      const newly: FeedItem[] = [];
      if (ai) {
        // Faceoffs, takeaways, blocks and icings happen on the rink and are reported as they are seen.
        while (playIdx.current < ai.plays.length && ai.plays[playIdx.current].tau <= tauRef.current) {
          const p = ai.plays[playIdx.current++];
          if (!FEED_PLAYS.has(p.kind)) continue;
          newly.push({ k: seq.current++, play: p, e: { type: 'info', sec: p.g, period: evs[0]?.period ?? 1, time: fmtClock(Math.max(0, blockEnd.current - p.g)), team: p.side === null ? null : p.side ? game.away : game.home, text: p.text } });
        }
      }
      while (idx.current < evs.length && (soMode.current ? idx.current < soShown : evs[idx.current].sec <= c)) {
        const e = evs[idx.current++];
        newly.push({ k: seq.current++, e });
        applyEvent(live.current, e, game.home);
        if (e.score) setScore(e.score);
        if (!ai && e.lines) setCurLines(e.lines);
        if (!ai && e.ice) setCurIce(e.ice);
        if (e.goalie !== undefined && e.team) {
          const defending = e.team === game.home ? 1 : 0;
          setVisibleGoalies(previous => { const next: [string | null, string | null] = [...previous]; next[defending] = e.goalie ?? null; return next; });
        }
        if (e.type === 'goal') {
          goalsSeen.current.push(e);
          setGoalFlash(e.team);
          window.setTimeout(() => setGoalFlash(null), 900);
          c = e.sec; clockRef.current = c;
          if (rinkAI.current) tauRef.current = rinkAI.current.tauOf(e) ?? tauRef.current;
          // Auto-replay (a setting): the match freezes on the goal while its replay is open.
          if (autoReplayFor(getSettings(), e.team, s.userTeamId)) { setReplayEvent(e); hitGoal = true; }
          break;
        }
      }
      let stoppedNow = false;
      if (ai) {
        // The on-ice panels follow the rink itself: line changes on the fly are visible the moment they happen.
        const frame = ai.frameAt(tauRef.current);
        stoppedNow = !!frame.stopped;
        const onIce = frame.skaters.filter(p => !p.goalie && !p.box);
        const ice: [string[], string[]] = [onIce.filter(p => p.side === 0).map(p => p.id), onIce.filter(p => p.side === 1).map(p => p.id)];
        const sig = ice.map(x => [...x].sort().join(',')).join('|');
        if (sig !== iceSig.current) {
          iceSig.current = sig;
          setCurIce(ice);
          setCurLines(([0, 1] as const).map(ti => {
            const F = sim.team(ti).lineup.F;
            let best = 0, hits = -1;
            F.forEach((line, i) => { const n = line.filter(id => id && ice[ti].includes(id)).length; if (n > hits) { hits = n; best = i; } });
            return best;
          }) as [number, number]);
        }
      }
      if (newly.length) setFeed((f) => [...newly.reverse(), ...f]);
      ticker.set(c, tauRef.current);
      const mpCur = manpower(live.current, c);
      const mpNow = `${mpCur.state}|${mpCur.men[0]}${mpCur.men[1]}`;
      if (mpNow !== mpRef.current) {
        mpRef.current = mpNow;
        setMpKey(mpNow);
      }
      if (hitGoal) return; // Freeze exactly on the revealed goal; no extra frame leaks past it.
      // A whistle has just gone: if the bench should act, the match pauses with a recommendation.
      if (ai && stoppedNow && !wasStopped.current && c < blockEnd.current - 1) {
        wasStopped.current = true;
        if (getSettings().matchAdvice && adviceCheck.current(c)) return;
      }
      wasStopped.current = stoppedNow;
      // The shootout ends one step after its last attempt is shown.
      if (soMode.current ? idx.current >= evs.length && soAcc.current >= evs.length : c >= blockEnd.current) {
        // The countdown is set together with the status: a value left at 0 by the previous intermission must
        // never start the next period at once (that used to skip the «period over» window).
        if (sim.status !== 'done') { setCountdown(sim.status === 'playing' ? BREAK_SECONDS : 10); setBreakHold(false); }
        setStatus(sim.status === 'done' ? 'done' : 'break');
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [status, speed, sim, paused, replayEvent, game.home, ticker]);

  // The shootout board replaces the rink: bring it into view when the shootout starts.
  useEffect(() => {
    if (kind === 'so' && status === 'playing') (document.querySelector('[data-shootout]') as HTMLElement | null)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [kind, status]);

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
    if (status !== 'break' || breakHold) return;
    const id = window.setInterval(() => setCountdown((c) => c - 1), 1000);
    return () => window.clearInterval(id);
  }, [status, breakHold]);
  useEffect(() => {
    if (status === 'break' && !breakHold && countdown <= 0) startBlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown, status, breakHold]);

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
        // The players keep skating from where they are; only the future of the period changes.
        rinkAI.current?.setEvents(updated, sim.sec);
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
    setVisibleGoalies(previous => { const updated: [string | null, string | null] = [...previous]; updated[userIdx] = next ? null : userL.starterG; return updated; });
    applyLiveCoaching(() => {
      sim.setForceEmptyNet(userIdx, next);
      return next
        ? `⚡ ПУСТЫЕ ВОРОТА! «${s.teams[s.userTeamId].short}» меняет вратаря на шестого полевого игрока!`
        : `Вратарь «${s.teams[s.userTeamId].short}» возвращается в ворота.`;
    });
  };

  const toggleShortBench = (on = !shortBenchOn) => {
    if (on === shortBenchOn) return;
    setShortBenchOn(on);
    applyLiveCoaching(() => {
      sim.setShortBench(userIdx, on);
      return on
        ? `Тренерский мостик «${s.teams[s.userTeamId].short}»: игра в три звена — четвёртое садится на скамейку.`
        : `Тренерский мостик «${s.teams[s.userTeamId].short}»: снова в четыре звена.`;
    });
  };
  /** Quick decisions: chase the game or protect the lead with one tap. */
  const goPress = () => {
    setForecheckState('aggressive');
    setAttackStyleState('shoot');
    applyLiveCoaching(() => {
      sim.setForecheck(userIdx, 'aggressive');
      sim.setAttackStyle(userIdx, 'shoot');
      return `Тренерский мостик «${s.teams[s.userTeamId].short}»: ВСЕ ВПЕРЁД! Агрессивный прессинг и броски с любых позиций.`;
    });
  };
  const goProtect = () => {
    setForecheckState('trap');
    setAttackStyleState('cycle');
    if (!shortBenchOn) setShortBenchOn(true);
    applyLiveCoaching(() => {
      sim.setForecheck(userIdx, 'trap');
      sim.setAttackStyle(userIdx, 'cycle');
      sim.setShortBench(userIdx, true);
      return `Тренерский мостик «${s.teams[s.userTeamId].short}»: закрываемся — ловушка в средней зоне, держим шайбу, три звена.`;
    });
  };
  const applyLineup = (c: Lineup, note: string) => {
    setUserL(c);
    applyLiveCoaching(() => {
      sim.setLineup(userIdx, c);
      return note;
    });
  };
  const applyHint = (h: CoachHint) => {
    const a = h.action;
    if (!a) return;
    const nm = (id: string) => P[id]?.name.split(' ').slice(-1)[0] ?? '—';
    if (a.kind === 'swap') applyLineup(swapInLineup(userL, a.a, a.b), `Перестановка в звеньях: ${nm(a.a)} ⇄ ${nm(a.b)}.`);
    else if (a.kind === 'pp') applyLineup(promoteToPP1(userL, a.a, a.b), `Первая бригада большинства: ${nm(a.a)} вместо ${nm(a.b)}.`);
    else if (a.kind === 'forecheck') changeForecheck(a.value);
    else if (a.kind === 'style') changeAttackStyle(a.value);
    else if (a.kind === 'goalie') switchGoalie();
    else if (a.kind === 'shortBench') toggleShortBench(a.value);
    setDoneHints((d) => [...d, h.id]);
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
    goalieSwitched.current = true;
    const c = cloneL(userL);
    const g = c.starterG;
    c.starterG = c.backupG;
    c.backupG = g;
    setUserL(c);
    setVisibleGoalies(previous => { const updated: [string | null, string | null] = [...previous]; updated[userIdx] = c.starterG; return updated; });
    applyLiveCoaching(() => {
      sim.setLineup(userIdx, c);
      sim.setGoalie(userIdx, c.starterG);
      const newName = c.starterG && P[c.starterG] ? P[c.starterG].name : 'бэкап';
      return `🔄 Замена вратаря «${s.teams[s.userTeamId].short}»: в игру вступает ${newName}!`;
    });
  };

  // Bench advice at a whistle. Assigned on every render, so the playback loop always sees the current state.
  adviceCheck.current = (c: number) => {
    if (kind === 'so' || status !== 'playing') return false;
    const L = live.current, me = userIdx, op = (1 - userIdx) as 0 | 1;
    const diff = L.score[me] - L.score[op];
    const left = blockEnd.current - c;
    const scoreKey = `${L.score[0]}:${L.score[1]}`;
    const my = s.teams[s.userTeamId];
    const ask = (a: BenchAdvice) => {
      if (adviceDone.current.has(a.id)) return false;
      adviceDone.current.add(a.id);
      setAdvice(a); setAdviceLeft(ADVICE_SECONDS); setPaused(true);
      return true;
    };
    // 1. The goalie is out but the team is no longer behind: back into the net.
    if (pulledNow && diff >= 0) {
      return ask({ id: `return:${scoreKey}`, title: 'Верните вратаря', text: diff > 0 ? `«${my.short}» впереди — пустые ворота больше не нужны.` : `Счёт сравнялся (${scoreKey}) — вратарь может вернуться в ворота.`, actions: [{ key: 'return', label: 'Вернуть вратаря', primary: true }] });
    }
    // 2. Late in the third, one or two goals down: the six-on-five (with a timeout to set it up).
    if (kind === 'reg' && period === 3 && !pulledNow && diff < 0 && diff >= -2) {
      const want = diff === -1 ? 150 : 210, auto = PULL_GOALIE_INFO[pullPolicy].secondsLeft;
      if (left <= want && left > 25 && left > auto + 5) {
        const actions: BenchAdvice['actions'] = [];
        if (!timeoutUsed) actions.push({ key: 'timeout_pull', label: 'Тайм-аут и снять вратаря', primary: true });
        actions.push({ key: 'pull', label: 'Снять вратаря', primary: timeoutUsed });
        if (!timeoutUsed) actions.push({ key: 'timeout', label: 'Только тайм-аут' });
        return ask({ id: `pull:${scoreKey}`, title: 'Время для шестого полевого', text: `До конца ${fmtClock(left)}, «${my.short}» ${diff === -1 ? 'проигрывает в одну шайбу' : 'проигрывает две шайбы'}. Штаб предлагает снять вратаря${timeoutUsed ? '' : ' и взять тайм-аут, чтобы выпустить лучших'}.`, actions });
      }
    }
    // 3. The goalie is having a bad night: put the backup in.
    const gid = sim.goalies[me], g = gid ? L.goalies[gid] : undefined;
    if (gid && userL.backupG && !goalieSwitched.current && g && !(period >= 3 && left < 300) && (g.goalsAgainst >= 4 || (g.goalsAgainst >= 3 && g.shotsAgainst > 0 && g.saves / g.shotsAgainst < 0.86))) {
      const backup = userL.starterG === gid ? userL.backupG : userL.starterG;
      return ask({ id: `goalie:${gid}`, title: 'Замена вратаря?', text: `${P[gid]?.name ?? 'Вратарь'}: ${g.goalsAgainst} пропущенных, ${g.saves}/${g.shotsAgainst} (${g.shotsAgainst ? ((g.saves / g.shotsAgainst) * 100).toFixed(1) : '—'}%). Свежий вратарь может переломить игру.`, actions: [{ key: 'goalie', label: `Выпустить: ${P[backup ?? '']?.name ?? 'запасной'}`, primary: true }] });
    }
    // 4. The opponent has scored twice in a row in a few minutes: a timeout breaks the run.
    const last = goalsSeen.current.slice(-2);
    const oppId = me === 0 ? game.away : game.home;
    if (!timeoutUsed && last.length === 2 && last.every((e) => e.team === oppId) && last[1].sec - last[0].sec <= 300 && c - last[1].sec <= 60 && diff <= 0) {
      return ask({ id: `timeout:${scoreKey}`, title: 'Соперник на кураже', text: `Две шайбы подряд за ${Math.max(1, Math.round((last[1].sec - last[0].sec) / 60))} мин. Тайм-аут даст передохнуть и сбить темп «${s.teams[oppId].short}».`, actions: [{ key: 'timeout', label: 'Взять тайм-аут', primary: true }] });
    }
    return false;
  };
  const answerAdvice = (key: BenchAdviceKey | null) => {
    if (key === 'timeout' || key === 'timeout_pull') callTimeoutNow();
    if (key === 'pull' || key === 'timeout_pull' || key === 'return') toggleManualPullGoalie();
    if (key === 'goalie') { goalieSwitched.current = true; switchGoalie(); }
    setAdvice(null);
    setPaused(false);
  };
  useEffect(() => {
    if (!advice) return;
    const id = window.setInterval(() => setAdviceLeft((x) => x - 1), 1000);
    return () => window.clearInterval(id);
  }, [advice]);
  useEffect(() => {
    if (advice && adviceLeft <= 0) answerAdvice(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adviceLeft, advice]);

  const soNow = kind === 'so' ? feed.find((it) => !it.play && it.e.so)?.e.so : undefined;
  const periodLabel = period === 0 ? '' : kind === 'so' ? `серия ${soNow ? `${soNow[0]}:${soNow[1]}` : '0:0'}` : `${periodNameOf(period, kind)}`;
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
  const [mpStateKey, mpMenKey = '55'] = mpKey.split('|');
  const mpOn = status === 'playing' && (kind === 'reg' || kind === 'ot5');
  const mpState: 0 | 1 | 'even' | null = mpOn ? (mpStateKey === '0' ? 0 : mpStateKey === '1' ? 1 : mpStateKey === 'even' ? 'even' : null) : null;
  const mpMen: [number, number] = mpState === null ? [5, 5] : [Number(mpMenKey[0]) || 5, Number(mpMenKey[1]) || 5];
  const mp = { state: mpState, men: mpMen };
  const iceLabel = (ti: 0 | 1, li: number) => {
    if (kind === 'ot3') return 'овертайм · 3 на 3';
    if (mp.state === 'even') return `${mp.men[0]} на ${mp.men[1]}`;
    if (mp.state === ti) return 'большинство';
    if (mp.state !== null) return 'меньшинство';
    return `звено ${li + 1}`;
  };

  const rinkIds = ([0, 1] as const).map(ti => {
    const L = ti === 0 ? homeL : awayL;
    const base = curIce?.[ti] ?? [...(L.F[curLines[ti]] ?? []), ...(L.D[curLines[ti] % 3] ?? [])];
    // the unit's skaters (5, 4 or 3), plus room for an extra attacker when not short-handed
    const count = kind === 'so' ? 0 : kind === 'ot3' ? 3 : mpMen[ti] + (mpMen[ti] >= mpMen[1 - ti] ? 1 : 0);
    return [...new Set(base)].filter((id): id is string => !!id && !!P[id] && P[id].position !== 'G').slice(0, count);
  }) as [string[], string[]];
  // Outcomes and lineup/goalie UI use only revealed state; private motion paths share this clock.
  const rinkGoalies = ([0, 1] as const).map(ti => {
    if (ti === userIdx && pulledNow) return null;
    return visibleGoalies[ti];
  }) as [string | null, string | null];
  const rinkEvent = feed.find(it => it.e.x !== undefined && it.e.period === period)?.e ?? null;

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
  // Revealed shootout attempts (the feed is newest first).
  const soEvents = kind === 'so' ? feed.filter((it) => !it.play && (it.e.type === 'so_goal' || it.e.type === 'so_miss' || it.e.type === 'period_end')).map((it) => it.e).reverse() : [];
  const teamShort = (id: string) => {
    const p = P[id];
    return p && p.teamId ? s.teams[p.teamId]?.short ?? '' : '';
  };
  const userTeam = s.teams[s.userTeamId];
  const userWon = res ? (res.homeScore > res.awayScore ? game.home : game.away) === userTeam.id : false;

  // Rink-level hockey counted over the whole match (finished periods + what has been shown of the current one).
  const shownTally = rinkAI.current?.tally(tauRef.current);
  const rinkTally = status === 'intro' ? null : (() => {
    const t = { faceoff: [...doneTally.current.faceoff], block: [...doneTally.current.block], takeaway: [...doneTally.current.takeaway], icing: [...doneTally.current.icing], offside: [...doneTally.current.offside] } as RinkTally;
    if (shownTally) (Object.keys(t) as (keyof RinkTally)[]).forEach(k => { t[k][0] += shownTally[k][0]; t[k][1] += shownTally[k][1]; });
    return t;
  })();
  const hints: CoachHint[] =
    status === 'break' && rinkTally
      ? intermissionHints({
          live: stats,
          userIdx,
          faceoffs: [rinkTally.faceoff[0], rinkTally.faceoff[1]],
          lineup: userL,
          P,
          tactics: sim.tactics[userIdx],
          period,
          goalieId: sim.goalies[userIdx],
          shortBench: shortBenchOn,
        })
      : [];
  const shotMapPanel = (
    <Panel title="Мини-карта опасных моментов (xG) и тепловая карта бросков">
              <ShotMap shots={stats.shotMap} home={H} away={A} players={P} compact />
            </Panel>
  );
  const statsPanel = (
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
                {rinkTally && (<>
                  <tr className="border-t border-line/60" data-faceoffs={`${rinkTally.faceoff[0]}:${rinkTally.faceoff[1]}`}>
                    <td className="pl-4 py-1.5">{rinkTally.faceoff[0]}</td>
                    <td className="text-center text-xs text-muted">Выигр. вбрасывания</td>
                    <td className="pr-4 py-1.5 text-right">{rinkTally.faceoff[1]}</td>
                  </tr>
                  <tr className="border-t border-line/60">
                    <td className="pl-4 py-1.5">{rinkTally.block[0]}</td>
                    <td className="text-center text-xs text-muted">Блок-шоты</td>
                    <td className="pr-4 py-1.5 text-right">{rinkTally.block[1]}</td>
                  </tr>
                  <tr className="border-t border-line/60">
                    <td className="pl-4 py-1.5">{rinkTally.takeaway[0]}</td>
                    <td className="text-center text-xs text-muted">Отборы и перехваты</td>
                    <td className="pr-4 py-1.5 text-right">{rinkTally.takeaway[1]}</td>
                  </tr>
                  <tr className="border-t border-line/60">
                    <td className="pl-4 py-1.5">{rinkTally.icing[0]}</td>
                    <td className="text-center text-xs text-muted">Проброс</td>
                    <td className="pr-4 py-1.5 text-right">{rinkTally.icing[1]}</td>
                  </tr>
                  <tr className="border-t border-line/60" data-offsides={`${rinkTally.offside[0]}:${rinkTally.offside[1]}`}>
                    <td className="pl-4 py-1.5">{rinkTally.offside[0]}</td>
                    <td className="text-center text-xs text-muted">Офсайды</td>
                    <td className="pr-4 py-1.5 text-right">{rinkTally.offside[1]}</td>
                  </tr>
                </>)}
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
  );
  const coachPanel = (
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

              {status !== 'done' && kind !== 'so' && (
                <div data-quick-decisions>
                  <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Быстрые решения</div>
                  <div className="grid grid-cols-3 gap-1">
                    <button
                      type="button"
                      onClick={() => toggleShortBench()}
                      title="Четвёртое звено садится, лидеры получают больше времени (быстрее устают)"
                      className={cn('px-1.5 py-1.5 rounded-sm font-semibold text-[11px] border transition', shortBenchOn ? 'bg-amber/25 border-amber text-amber' : 'bg-panel2 border-line text-muted hover:text-text')}
                      data-short-bench={shortBenchOn ? 'on' : 'off'}
                    >
                      {shortBenchOn ? '✓ 3 звена' : '3 звена'}
                    </button>
                    <button
                      type="button"
                      onClick={goPress}
                      title="Агрессивный форчек + броски: когда нужно отыгрываться"
                      className={cn('px-1.5 py-1.5 rounded-sm font-semibold text-[11px] border transition', score[userIdx] < score[1 - userIdx] ? 'bg-accent/20 border-accent text-text' : 'bg-panel2 border-line text-muted hover:text-text')}
                    >
                      Прессинг
                    </button>
                    <button
                      type="button"
                      onClick={goProtect}
                      title="Ловушка в средней зоне, контроль шайбы и три звена: удержать счёт"
                      className={cn('px-1.5 py-1.5 rounded-sm font-semibold text-[11px] border transition', score[userIdx] > score[1 - userIdx] ? 'bg-ok/20 border-ok text-text' : 'bg-panel2 border-line text-muted hover:text-text')}
                    >
                      Закрыться
                    </button>
                  </div>
                </div>
              )}

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
  );
  const goaliesPanel = (
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
  );
  return (
    <div className={cn('rink-lines flex flex-col', land ? 'h-[100dvh] overflow-hidden' : 'min-h-screen')} data-match-root>
      <header className="sticky top-0 z-30 land:static land:shrink-0 bg-panel/95 backdrop-blur border-b border-line">
        {sim.derby && (
          <div className="bg-gradient-to-r from-accent/25 via-gold/20 to-accent/25 border-b border-gold/30 px-3 py-1 text-center text-[11px] sm:text-xs truncate land:hidden" data-derby-banner>
            <span className="font-display uppercase tracking-wider font-bold text-gold">🔥 {sim.derby.title}</span>
            <span className="hidden sm:inline text-text/85 ml-2">{sim.derby.subtitle}</span>
            {game.home === s.userTeamId && (
              <span className="text-ok ml-2 font-semibold">· +{formatMoney(sim.derby.gateBonus)}</span>
            )}
          </div>
        )}
        <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2 sm:py-3 land:py-1 land:px-[max(0.75rem,env(safe-area-inset-left))] grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-3">
          <div className="flex flex-wrap sm:flex-nowrap items-center gap-x-2 gap-y-1 sm:gap-3 min-w-0">
            <TeamLogo team={H} size={32} className="sm:w-10 sm:h-10" />
            <div className="min-w-0 flex-1 basis-0 sm:flex-initial sm:basis-auto">
              <div className="flex items-center gap-2 min-w-0">
                <div className="font-display text-sm sm:text-xl uppercase leading-none truncate">
                  <span className="sm:hidden">{H.short}</span>
                  <span className="hidden sm:inline">{H.name}</span>
                </div>
                <span className="hidden sm:inline-flex"><ManpowerBadge state={mp.state} men={mp.men} ti={0} /></span>
              </div>
              <div className="text-[10px] sm:text-[11px] text-muted truncate">дома · {H.record.points} очк.</div>
            </div>
            <span className="font-display text-3xl sm:text-5xl tabular leading-none ml-auto score-tick" key={`h${score[0]}`}>
              {score[0]}
            </span>
            {mp.state !== null && <div className="basis-full sm:hidden"><ManpowerBadge state={mp.state} men={mp.men} ti={0} compact /></div>}
          </div>
          <div className="text-center px-1.5 sm:px-4 min-w-[82px] sm:min-w-[120px]">
            <ClockFace ticker={ticker} end={blockEnd} shootout={kind === 'so'} />
            <div className={cn('text-[10px] sm:text-[11px] uppercase tracking-widest mt-0.5 sm:mt-1', paused ? 'text-amber' : 'text-muted')}>{paused ? 'Пауза' : periodLabel || 'Старт'}</div>
          </div>
          <div className="flex flex-wrap sm:flex-nowrap items-center gap-x-2 gap-y-1 sm:gap-3 min-w-0 flex-row-reverse">
            <TeamLogo team={A} size={32} className="sm:w-10 sm:h-10" />
            <div className="min-w-0 text-right flex-1 basis-0 sm:flex-initial sm:basis-auto">
              <div className="flex items-center gap-2 sm:flex-row-reverse min-w-0">
                <div className="font-display text-sm sm:text-xl uppercase leading-none truncate">
                  <span className="sm:hidden">{A.short}</span>
                  <span className="hidden sm:inline">{A.name}</span>
                </div>
                <span className="hidden sm:inline-flex"><ManpowerBadge state={mp.state} men={mp.men} ti={1} /></span>
              </div>
              <div className="text-[10px] sm:text-[11px] text-muted truncate">гости · {A.record.points} очк.</div>
            </div>
            <span className="font-display text-3xl sm:text-5xl tabular leading-none mr-auto score-tick" key={`a${score[1]}`}>
              {score[1]}
            </span>
            {mp.state !== null && <div className="basis-full sm:hidden text-right"><ManpowerBadge state={mp.state} men={mp.men} ti={1} compact /></div>}
          </div>
        </div>

        {/* Sticky Mobile Live Control Strip + Section Tabs */}
        <div className="lg:hidden border-t border-line/70 px-3 py-1.5 bg-bg/85 space-y-1.5 land:flex land:items-center land:gap-3 land:space-y-0 land:py-1 land:px-[max(0.75rem,env(safe-area-inset-left))]">
          <div className="flex items-center gap-1.5 land:order-2 land:shrink-0">
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

          <div className="grid grid-cols-3 gap-1 land:flex-1 land:order-1">
            {([
              ['live', land ? 'Хроника' : 'Трансляция'],
              ['coach', land ? 'Мостик' : 'Мостик и звенья'],
              ['stats', land ? `Статистика ${stats.shots[0]}:${stats.shots[1]}` : `Карта xG (${stats.shots[0]}:${stats.shots[1]})`],
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

      {land ? (
        <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_minmax(270px,36%)] grid-rows-[minmax(0,1fr)] gap-2 py-1.5 pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] pb-[max(0.375rem,env(safe-area-inset-bottom))]" data-match-land>
          <div className="min-h-0 flex flex-col">
            {kind === 'so' && status !== 'intro' ? <ShootoutBoard events={soEvents} home={H} away={A} players={P} live className="flex-1 min-h-0 overflow-y-auto" /> : <LiveRink fill className="flex-1 min-h-0" ticker={ticker} ids={rinkIds} goalies={rinkGoalies} event={rinkEvent} home={H} away={A} players={P} ai={rinkAI.current} running={status === 'playing' && !paused && !replayEvent} roster={roster3d} allow3d={!replayEvent} />}
          </div>
          {/* Only this side list scrolls; the rink, score and controls stay put. */}
          <div ref={mobileTab === 'live' ? feedRef : undefined} className="min-h-0 overflow-y-auto overscroll-contain rounded-md border border-line bg-panel" data-land-side data-feed={mobileTab === 'live' || undefined}>
            {mobileTab === 'live' && <div className="divide-y divide-line/60">
              {feed.length === 0 && status === 'playing' && <div className="p-3 text-muted text-sm">Игра началась…</div>}
              <FeedRows feed={feed} onReplay={setReplayEvent} />
            </div>}
            {mobileTab === 'coach' && <div className="space-y-2 p-1.5">{coachPanel}{renderOnIce(0)}{renderOnIce(1)}{goaliesPanel}</div>}
            {mobileTab === 'stats' && <div className="space-y-2 p-1.5">{statsPanel}{shotMapPanel}{goaliesPanel}</div>}
          </div>
        </div>
      ) : (
      <div className="flex-1 max-w-7xl mx-auto w-full px-3 sm:px-4 py-3 sm:py-4 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="space-y-3 min-w-0">
          <div className={cn(mobileTab !== 'live' && 'hidden lg:block')}>
            <button type="button" className="text-xs text-ice mb-2" aria-expanded={showRink} onClick={() => setShowRink(v => !v)}>{showRink ? 'Скрыть площадку' : 'Показать площадку'}</button>
            {kind === 'so' && status !== 'intro' && <ShootoutBoard events={soEvents} home={H} away={A} players={P} live className="mb-2" />}
            {showRink && kind !== 'so' && <LiveRink ticker={ticker} ids={rinkIds} goalies={rinkGoalies} event={rinkEvent} home={H} away={A} players={P} ai={rinkAI.current} running={status === 'playing' && !paused && !replayEvent} roster={roster3d} allow3d={!replayEvent} />}
          </div>
          <div className={cn('grid grid-cols-1 md:grid-cols-2 gap-2', mobileTab !== 'live' && 'hidden lg:grid')}>
            {renderOnIce(0)}
            {renderOnIce(1)}
          </div>
          <div className={cn(mobileTab !== 'stats' && 'hidden lg:block')}>
            {shotMapPanel}
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
          {statsPanel}
          </div>
          <div className={cn('space-y-3', mobileTab !== 'coach' && 'hidden lg:block')}>
          {coachPanel}

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
            <Button className="w-full mt-2" onClick={() => { if (status === 'playing') setPaused(true); ui.openSettings(); }} data-match-settings title="Повторы голов, видео, скорость матча">
              <Icon name="settings" /> Настройки повторов
            </Button>
            {status !== 'done' && (
              <Button className="w-full mt-2" onClick={finishNow}>
                <Icon name="fast" /> Завершить мгновенно
              </Button>
            )}
          </Panel>
          </div>
          <div className={cn(mobileTab !== 'stats' && mobileTab !== 'coach' && 'hidden lg:block')}>
          {goaliesPanel}
          </div>
        </div>
      </div>
      )}

      {replayEvent && (
        <GoalReplay motionClip={clipFor(replayEvent)} closeLabel={status === 'done' ? 'Назад к итогам' : undefined} event={replayEvent} home={H} away={A} players={P} onClose={() => setReplayEvent(null)} />
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
      {advice && status === 'playing' && !replayEvent && (
        <div className="fixed inset-x-0 bottom-0 sm:inset-0 z-40 flex items-end sm:items-center justify-center sm:bg-bg/60 sm:backdrop-blur-[2px] p-0 sm:p-4 pointer-events-none" data-bench-advice={advice.id.split(':')[0]}>
          <div className="pointer-events-auto w-full sm:max-w-md bg-panel border-t sm:border border-amber/50 rounded-t-xl sm:rounded-md shadow-2xl p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-4 fade-in" role="dialog" aria-label="Совет тренерского штаба">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-amber">
              <span className="w-2 h-2 rounded-full bg-amber" /> Свисток · игра на паузе
            </div>
            <div className="font-display text-xl uppercase mt-1">{advice.title}</div>
            <p className="text-sm text-text/85 mt-1">{advice.text}</p>
            <div className="flex flex-wrap gap-2 mt-3">
              {advice.actions.map((a) => (
                <Button key={a.key} size="sm" variant={a.primary ? 'primary' : 'secondary'} onClick={() => answerAdvice(a.key)} data-advice-action={a.key}>{a.label}</Button>
              ))}
              <Button size="sm" variant="ghost" onClick={() => answerAdvice(null)} data-advice-skip>Не сейчас · {Math.max(0, adviceLeft)} с</Button>
            </div>
            <div className="text-[10px] text-muted mt-2">После решения матч продолжится сам. Подсказки можно выключить в настройках.</div>
          </div>
        </div>
      )}
      {status === 'break' && (
        <Overlay>
          <div className="contents" onPointerDownCapture={(e) => { if (!(e.target as HTMLElement).closest('[data-break-continue]')) setBreakHold(true); }}>
          <div className="text-[11px] uppercase tracking-widest text-muted">{periodNameOf(period, kind)} завершён</div>
          <div className="font-display text-4xl tabular">
            {score[0]} : {score[1]}
          </div>
          <div className="text-xs text-muted mb-3">
            {H.short} {sim.periodScores.map((p) => p[0]).join(' ')} · {A.short} {sim.periodScores.map((p) => p[1]).join(' ')}
          </div>
          <BreakStats
            periodNo={period}
            home={H}
            away={A}
            players={P}
            period={{ live: foldEvents(periodEvs.current, game.home), tally: rinkAI.current?.tally(Infinity) ?? null, events: periodEvs.current }}
            match={{ live: stats, tally: rinkTally, events: feed.filter((it) => !it.play).map((it) => it.e).reverse() }}
          />
          {sim.status !== 'so' && hints.length > 0 && (
            <div className="text-left w-full max-w-md mb-3 rounded-md border border-ice/30 bg-ice/5 p-2" data-intermission-hints>
              <div className="text-[11px] uppercase tracking-wider text-ice mb-1.5">Помощник тренера</div>
              <div className="space-y-1.5">
                {hints.map((h) => (
                  <div key={h.id} className="flex items-start gap-2 text-xs">
                    <span className={cn('mt-1 w-1.5 h-1.5 rounded-full shrink-0', h.tone === 'good' ? 'bg-ok' : h.tone === 'warn' ? 'bg-amber' : 'bg-accent')} />
                    <span className="flex-1">{h.text}</span>
                    {h.action && (
                      doneHints.includes(h.id) ? (
                        <span className="text-ok shrink-0">✓ сделано</span>
                      ) : (
                        <Button size="sm" variant="secondary" className="shrink-0" onClick={() => { setCountdown((c) => Math.max(c, 8)); applyHint(h); }} data-hint-action={h.action.kind}>
                          {h.actionLabel ?? 'Применить'}
                        </Button>
                      )
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
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
          {sim.status === 'so' && (
            <>
              <div className="text-sm mb-2">Ничья после овертайма — <b>серия буллитов</b>.</div>
              <ShooterPicker candidates={sim.shootoutCandidates(userIdx)} value={validPick(soPick, sim.shootoutCandidates(userIdx))} players={P} onChange={(ids) => { setSoPick(ids); setCountdown((c) => Math.max(c, 12)); }} />
            </>
          )}
          <div className="flex gap-2 mt-4 flex-wrap justify-center items-center">
            <Button variant="primary" size="lg" onClick={startBlock} data-break-continue>
              {sim.status === 'so' ? 'К буллитам' : 'Продолжить'}
            </Button>
            {breakHold ? (
              <span className="text-xs text-muted" data-break-hold>перерыв — продолжите, когда будете готовы</span>
            ) : (
              <span className="text-xs text-muted">
                автоматически через {Math.max(0, countdown)} с ·{' '}
                <button type="button" className="underline hover:text-text" onClick={() => setBreakHold(true)} data-break-wait>подождать</button>
              </span>
            )}
            <Button size="lg" onClick={finishNow} data-break-continue>
              <Icon name="fast" /> Завершить мгновенно
            </Button>
          </div>
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
            {res.periodScores.map((p, i) => `${res.so && i === res.periodScores.length - 1 ? 'Буллиты' : i < 3 ? `${i + 1}-й` : 'ОТ'}: ${p[0]}-${p[1]}`).join(' · ')} · броски {res.homeStats.shots}:{res.awayStats.shots} · xG {(res.homeStats.xg ?? 0).toFixed(2)}:{(res.awayStats.xg ?? 0).toFixed(2)}
          </div>
          <div className="flex gap-2 mt-3 flex-wrap justify-center">
            {res.stars.map((id, i) => (
              <span key={id} className="text-xs bg-panel2 border border-amber/40 rounded-sm px-2 py-1 inline-flex items-center gap-1.5">
                <span className="text-amber">★{i + 1}</span>
                {P[id] && <PlayerFace face={P[id].face} name={P[id].name} number={P[id].number} team={P[id].teamId ? s.teams[P[id].teamId!] : null} size={22} />}
                {P[id]?.name} <span className="text-muted">({teamShort(id)})</span>
              </span>
            ))}
          </div>
          {showPostMap && (res.shotMap?.length ?? stats.shotMap.length) > 0 && (
            <div className="mt-3 w-full text-left">
              <ShotMap shots={res.shotMap ?? stats.shotMap} home={H} away={A} players={P} compact />
            </div>
          )}
          {res.so && <ShootoutBoard events={res.events} home={H} away={A} players={P} className="mt-3 w-full max-w-lg" tally={res.periodScores[res.periodScores.length - 1] as [number, number] | undefined} />}
          <div className="mt-3 w-full max-w-lg text-left text-xs max-h-48 overflow-y-auto" data-final-goals>
            {res.scorers.length > 0 && <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Голы · нажмите «▶ Повтор», чтобы посмотреть 3D-повтор</div>}
            {res.scorers.map((sc, i) => {
              const ev = goalEventFor(res.events, sc);
              return (
                <div key={i} className="flex items-center gap-2 py-0.5">
                  <span className="w-16 text-muted tabular shrink-0 whitespace-nowrap">{sc.period <= 3 ? sc.period : 'ОТ'} · {sc.time}</span>
                  <span className="flex-1 min-w-0">
                    <b className={sc.team === game.home ? 'text-ice' : 'text-amber'}>{s.teams[sc.team].short}</b> {P[sc.scorer]?.name}
                    {sc.assists.length > 0 && <span className="text-muted"> ({sc.assists.map((a) => P[a]?.name).join(', ')})</span>}
                  </span>
                  {ev && (
                    <button type="button" onClick={() => setReplayEvent(ev)} className="shrink-0 rounded border border-accent/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent hover:bg-accent/10" data-final-replay title="Посмотреть 3D-повтор гола">
                      ▶ Повтор
                    </button>
                  )}
                </div>
              );
            })}
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

/** «в большинстве / в меньшинстве» next to a team's name while a penalty is running. */
function ManpowerBadge({ state, men, ti, compact = false }: { state: 0 | 1 | 'even' | null; men: [number, number]; ti: 0 | 1; compact?: boolean }) {
  if (state === null) return null;
  const kind = state === 'even' ? 'even' : state === ti ? 'pp' : 'pk';
  const text = kind === 'even' ? `${men[0]} на ${men[1]}` : kind === 'pp' ? 'в большинстве' : 'в меньшинстве';
  const count = kind === 'even' ? '' : `${men[ti]}×${men[1 - ti]}`;
  return (
    <span
      data-team-manpower={kind}
      data-men={`${men[ti]}x${men[1 - ti]}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-sm font-semibold whitespace-nowrap leading-none border',
        compact ? 'text-[10px] px-1.5 py-[3px]' : 'text-xs px-1.5 py-1',
        kind === 'pp' ? 'bg-ok/15 text-ok border-ok/40' : kind === 'pk' ? 'bg-accent/15 text-accent border-accent/40' : 'bg-amber/15 text-amber border-amber/40'
      )}
    >
      {text}
      {count && (!compact || Math.abs(men[0] - men[1]) >= 2) && <span className="tabular opacity-80">{count}</span>}
    </span>
  );
}

function periodNameOf(period: number, kind: BlockKind): string {
  if (kind === 'so') return 'Буллиты';
  if (period <= 3) return `${period}-й период`;
  if (kind === 'ot3') return 'Овертайм';
  return period === 4 ? 'Овертайм' : `${period - 3}-й овертайм`;
}

type BenchAdviceKey = 'timeout' | 'pull' | 'return' | 'goalie' | 'timeout_pull';
interface BenchAdvice { id: string; title: string; text: string; actions: { key: BenchAdviceKey; label: string; primary?: boolean }[] }
/** Seconds the bench advice waits before the match goes on unchanged. */
const ADVICE_SECONDS = 15;

/** Seconds of the intermission window before the next period starts by itself. */
const BREAK_SECONDS = 20;

function Overlay({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-40 bg-bg/85 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto">
      <div className={cn('bg-panel border-t sm:border border-line rounded-t-xl sm:rounded-md p-4 sm:p-5 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-5 w-full text-center shadow-2xl fade-in flex flex-col items-center max-h-[92dvh] overflow-y-auto overscroll-contain', wide ? 'max-w-4xl' : 'max-w-xl')}>
        {children}
      </div>
    </div>
  );
}

type RinkTally = Record<'faceoff' | 'block' | 'takeaway' | 'icing' | 'offside', [number, number]>;

interface FeedItem {
  /** stable number of the event within the match */
  k: number;
  e: GameEvent;
  /** a rink play (faceoff, takeaway…) rather than an engine event */
  play?: RinkPlay;
}

const LAND_QUERY = '(orientation: landscape) and (max-height: 560px)';
/** Phones held sideways (the primary orientation): the match screen becomes a fixed, non-scrolling layout. */
function useLandscapePhone() {
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(LAND_QUERY).matches;
  const [value, setValue] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(LAND_QUERY), on = () => setValue(m.matches);
    on();
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return value;
}

/** Game clock shared by the playback loop and the components that display time. */
class Ticker {
  sec = 0;
  /** presentation time of the rink animation */
  tau = 0;
  /** set by the 3D view while its first picture is not ready yet */
  wait = false;
  private subs = new Set<() => void>();
  subscribe = (f: () => void) => {
    this.subs.add(f);
    return () => {
      this.subs.delete(f);
    };
  };
  set(v: number, tau = this.tau) {
    this.sec = v;
    this.tau = tau;
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

const FeedRow = memo(function FeedRow({ e, onReplay }: { e: GameEvent; onReplay: (event: GameEvent) => void }) {
  const replay3d = useSettings().replay3d;
  return (
    <div className={cn('flex items-start gap-3 px-4 py-1.5 text-sm fade-in', e.type === 'goal' && 'bg-accent/10')}>
      <span className="w-14 shrink-0 text-[11px] text-muted tabular pt-0.5">{e.type === 'period_start' || e.type === 'period_end' ? '' : e.type === 'so_goal' || e.type === 'so_miss' ? `Б · ${e.round ?? ''}` : `${e.period <= 3 ? e.period : 'ОТ'} · ${e.time}`}</span>
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
        <button onClick={() => onReplay(e)} className="shrink-0 text-[10px] uppercase tracking-wide rounded border border-accent/40 px-2 py-1 text-accent hover:bg-accent/10" title="Посмотреть повтор гола">{replay3d ? '3D повтор' : 'Повтор'}</button>
      )}
      {e.score && (
        <span className="font-display text-sm tabular text-muted shrink-0">
          {e.score[0]}:{e.score[1]}
        </span>
      )}
    </div>
  );
});

const PlayRow = memo(function PlayRow({ e, play }: { e: GameEvent; play: RinkPlay }) {
  return (
    <div className="flex items-center gap-3 px-4 py-1 text-xs text-muted fade-in" data-feed-play={play.kind}>
      <span className="w-14 shrink-0 text-[10px] tabular">{`${e.period <= 3 ? e.period : 'ОТ'} · ${e.time}`}</span>
      <span className="w-4 shrink-0 text-center text-ice/80" aria-hidden>{PLAY_ICON[play.kind] ?? '·'}</span>
      <span className="flex-1 min-w-0 truncate">{e.text}</span>
    </div>
  );
});

/** The feed re-renders only when an event is added, and then only the new row is created. */
const FeedRows = memo(function FeedRows({ feed, onReplay }: { feed: FeedItem[]; onReplay: (event: GameEvent) => void }) {
  return (
    <>
      {feed.map((it) => (
        it.play ? <PlayRow key={it.k} e={it.e} play={it.play} /> : <FeedRow key={it.k} e={it.e} onReplay={onReplay} />
      ))}
    </>
  );
});
