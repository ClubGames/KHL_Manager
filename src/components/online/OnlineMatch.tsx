import { useEffect, useMemo, useRef, useState } from 'react';
import type { GameEvent } from '../../types';
import { pads } from '../../padSource';
import { fmtClock } from '../../game/engine';
import { NO_PAD, type PlayHud, type PlayOut, type PlayRink } from '../../game/playRink';
import { useSettings } from '../../game/settings';
import { enterFullscreen, fullscreenSupported } from '../../fullscreen';
import { suspendPadNav } from '../../gamepadNav';
import { cn } from '../../utils/cn';
import { Button, Icon, TeamLogo } from '../ui';
import { MatchSettings } from '../SettingsPanel';
import { LiveRink } from '../RinkView';
import { GoalReplay } from '../GoalReplay';
import { ShootoutBoard } from '../Shootout';
import type { FigureRequest } from '../replayCache';
import { anyGamepad, bindKeys, CAPTURED, COMMAND_KEYS, detectDevice, emptyTouch, gamepadPad, mouseDown, mouseMove, mouseUp, newMouse, type Command, type MouseState, type TouchState } from '../playInput';
import { Controls, framePad, GoalList, LineChip, Sheet, TouchControls, type GoalItem } from '../PlayMatch';
import { buildCtx, GuestMatch, HostMatch, outToast, type MatchCommand, type MatchSide } from '../../net/match';
import type { OnlineSession } from '../../net/session';
import type { MatchView, TeamPack } from '../../net/wire';
import { useCrowdVerdict } from '../sound/useMatchSound';

/**
 * The online match on this device: the host's runs the rink (HostMatch), the guest's shows the host's frames and
 * sends its pad (GuestMatch). The same screen for both — scoreboard, HUD, touch controls, toasts — with the
 * intermissions and the final waiting for both players' «ready».
 */
interface Toast { id: number; text: string; tone: 'goal' | 'pen' | 'info' }
interface Hud extends PlayHud { to: { side: 0 | 1; left: number } | null; tol: boolean; line: string; show: boolean; men: [number, number]; boxed: [{ id: string; left: number }[], { id: string; left: number }[]]; delayed: 0 | 1 | null; pulled: boolean; clock: number; len: number; score: [number, number]; shots: [number, number] }
class Ticker { sec = 0; tau = 0; wait = false; hold = false; slow = false; shows = false; ui = false; }

/** The guest's picture runs this far behind the newest frame (the next one is always there to interpolate to). */
const GUEST_DELAY = 0.1;

export function OnlineMatch({ session, packs, onLobby, onLeave }: { session: OnlineSession; packs: [TeamPack, TeamPack]; onLobby: () => void; onLeave: () => void }) {
  const role = session.state.role;
  const ctx = useMemo(() => buildCtx(packs, session.state.settings, role), [packs, session, role]);
  const { home: H, away: A, players: P, mySide } = ctx;
  const settings = useSettings();
  const [view, setView] = useState<MatchView>(() => ({ phase: 'loading', period: 1, status: 'playing', score: [0, 0], shots: [0, 0], hits: [0, 0], periodScores: [], goals: [], events: [], soEvents: [], ready: [false, false], paused: null, beyond: '' }));
  // the arena is the home side's: its fans cheer or boo the result on both devices
  useCrowdVerdict(view.phase === 'final', view.score[0] > view.score[1]);
  const [rink, setRink] = useState<PlayRink | null>(null);
  const [hud, setHud] = useState<Hud | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [replay, setReplay] = useState<GoalItem | null>(null);
  const [help, setHelp] = useState(false);
  const [setOpen, setSetOpen] = useState(false);
  const [padOn, setPadOn] = useState(false);
  const [waitLong, setWaitLong] = useState(false);
  const ticker = useRef(new Ticker()).current;
  const keys = useRef(new Set<string>());
  const touch = useRef<TouchState>(emptyTouch());
  const mouse = useRef<MouseState>(newMouse());
  const prevCommands = useRef(new Set<Command>());
  const root = useRef<HTMLDivElement>(null);
  const toastId = useRef(0);
  const clips = useRef(new Map<number, GoalItem['clip']>());
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const toast = (text: string, tone: Toast['tone'] = 'info', ms = 2600) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  };
  const toastRef = useRef(toast); toastRef.current = toast;

  // the match: the host plays it, the guest follows
  const side = useMemo<MatchSide>(() => {
    const ev = {
      view: (v: MatchView) => setView(v),
      rink: (k: PlayRink | null) => { if (k) { ticker.tau = 0; ticker.sec = 0; setRink(k); } },
      out: (o: PlayOut[]) => { for (const x of o) { const t = outToast(x, mySide, P); if (t) toastRef.current(t.text, t.tone, t.ms); } },
      toast: (t: string) => toastRef.current(t),
    };
    const send = (m: Parameters<OnlineSession['send']>[0]) => session.send(m);
    return role === 'host' ? new HostMatch(ctx, send, ev) : new GuestMatch(ctx, send, ev);
  }, [ctx, role, session, mySide, P, ticker]);
  useEffect(() => {
    session.setMatchHandler((m) => side.onMessage(m));
    if (side instanceof HostMatch) side.begin();
    return () => session.setMatchHandler(null);
  }, [session, side]);

  const touchUI = settings.playTouch === 'on' || (settings.playTouch === 'auto' && typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches);
  const device = detectDevice(padOn, touchUI);
  const playing = view.phase === 'playing';
  // the menu: online the match never stops for it — the other player plays on, the AI skates this team meanwhile
  const [menu, setMenu] = useState(false);
  const paused = menu;
  const phaseRef = useRef(view.phase); phaseRef.current = view.phase;
  const pausedRef = useRef(paused); pausedRef.current = paused;
  const setOpenRef = useRef(setOpen); setOpenRef.current = setOpen;
  useEffect(() => { if (!paused) setSetOpen(false); }, [paused]);
  const openMenu = (on: boolean) => { setMenu(on); pausedRef.current = on; side.pause(on); };
  useEffect(() => { if (!playing && menu) { setMenu(false); side.pause(false); } }, [playing, menu, side]);

  // the goal clips are cut while the period's rink still has their frames
  const keepClips = (k: PlayRink | null) => { if (k) for (const g of view.goals) if (!clips.current.has(g.tau) && g.period === view.period) { const c = k.goalClip(g.tau); if (c) clips.current.set(g.tau, c); } };
  useEffect(() => { if (view.phase !== 'playing' && view.phase !== 'loading') keepClips(rink); });
  const goals: GoalItem[] = view.goals.map((g) => ({ ...g, clip: clips.current.get(g.tau) }));

  const roster3d = useMemo(() => {
    const out: FigureRequest[] = [], seen = new Set<string>();
    ([0, 1] as const).forEach((s) => {
      const L = ctx.lineups[s];
      const add = (id: string | null | undefined, goalie: boolean) => { if (id && !seen.has(id)) { seen.add(id); out.push({ id, side: s, goalie }); } };
      [...L.F.flat(), ...L.D.flat(), L.u20F, L.u20D, ...L.pp1, ...L.pp2, ...L.pk1, ...L.pk2].forEach((id) => add(id, false));
      add(L.starterG, true); add(L.backupG, true);
    });
    return out;
  }, [ctx]);

  const command = (c: Command) => {
    if (c === 'pause') { if (setOpenRef.current) { setSetOpen(false); return; } if (phaseRef.current === 'playing') openMenu(!pausedRef.current); return; }
    if (c === 'replay') return; // online the match never stops for a replay: they are in the intermission
    if (phaseRef.current !== 'playing' || pausedRef.current) return;
    side.command(c as MatchCommand);
  };
  const commandRef = useRef(command); commandRef.current = command;

  // keyboard
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (CAPTURED.has(e.code) && phaseRef.current === 'playing') e.preventDefault();
      if (!e.repeat) for (const [c, list] of Object.entries(COMMAND_KEYS) as [Command, string[]][]) if (list.includes(e.code)) commandRef.current(c);
      keys.current.add(e.code);
    };
    const up = (e: KeyboardEvent) => { keys.current.delete(e.code); };
    const blur = () => keys.current.clear();
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, []);
  useEffect(() => { suspendPadNav(playing && !paused); return () => suspendPadNav(false); }, [playing, paused]);
  // a phone call, another app: the menu opens (the match goes on for the other player, the AI takes this team)
  useEffect(() => {
    const vis = () => { if (document.hidden && phaseRef.current === 'playing' && !pausedRef.current) openMenu(true); };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, [side]);
  useEffect(() => { if (touchUI && fullscreenSupported(root.current)) void enterFullscreen(root.current); }, [touchUI]);

  // the period's picture is ready (3D figures prepared) → tell the host; a slow device does not hold the match forever
  useEffect(() => {
    if (view.phase !== 'loading' || !rink) return;
    setWaitLong(false);
    const t0 = performance.now();
    const id = window.setInterval(() => {
      if (!ticker.wait || performance.now() - t0 > 9000) side.loaded();
      if (performance.now() - t0 > 6000) setWaitLong(true);
      if (side instanceof HostMatch && performance.now() - t0 > 20000) side.forceStart();
    }, 250);
    return () => window.clearInterval(id);
  }, [view.phase, rink, side, ticker]);

  // the loop: pads → the rink (host) or the host (guest), the picture's time, the HUD
  useEffect(() => {
    if (!rink) return;
    let raf = 0, last = performance.now(), hudAt = 0, pres = -1;
    prevCommands.current = gamepadPad(pads()).commands;
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const gp = gamepadPad(pads());
      if (gp.connected !== padOn) setPadOn(gp.connected);
      for (const c of gp.commands) if (!prevCommands.current.has(c)) commandRef.current(c);
      prevCommands.current = gp.commands;
      const live = phaseRef.current === 'playing' && !pausedRef.current;
      const pad = live ? framePad(rink, keys.current, gp.pad, touch.current, mouse.current, now, settingsRef.current) : NO_PAD;
      // this screen holds the play (the entrance, a replay): the host waits for both screens
      side.hold(phaseRef.current === 'playing' && !!ticker.hold);
      if (side instanceof HostMatch) {
        side.advance(dt, pad);
        ticker.tau = Math.max(0, rink.tau - 1 / 60);
      } else if (side instanceof GuestMatch) {
        if (live) side.pad(pad, now);
        const f = rink.frames;
        if (f.length) {
          // the host waits for a screen (its replay has just begun): catch up to its last frame at once, where the
          // same replay begins here — both screens show it together
          const held = !!side.view.held, target = held ? f[f.length - 1].tau : rink.tau - GUEST_DELAY;
          pres = pres < 0 || Math.abs(pres - target) > 0.6 ? target : held ? Math.min(target, pres + dt * 3) : pres + dt + (target - pres - dt) * 0.08;
          ticker.tau = Math.max(f[0].tau, Math.min(f[f.length - 1].tau, pres));
        }
      }
      ticker.sec = rink.clock;
      if (now - hudAt > 90) {
        hudAt = now;
        // the host's own seat is 0; the guest's copy reports the guest's seat whatever is asked
        setHud({ ...rink.hud(0), to: rink.timeoutNow(), tol: rink.timeoutLeft[mySide], line: rink.lineOn(mySide), show: ticker.ui, men: rink.men(), boxed: rink.boxed(), delayed: rink.delayed, pulled: rink.pulled[mySide], clock: rink.clock, len: rink.len, score: [rink.score[0], rink.score[1]], shots: side.shots() });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rink, side]);
  useEffect(() => {
    if (playing && !paused) return;
    const read = () => setPadOn(anyGamepad(pads()));
    read();
    const id = window.setInterval(read, 600);
    return () => window.clearInterval(id);
  }, [playing, paused]);

  const periodName = (p: number) => (p <= 3 ? `${p}-й период` : 'Овертайм');
  const score: [number, number] = playing && hud ? hud.score : view.score;
  const shots: [number, number] = playing && hud ? hud.shots : view.shots;
  const ctlName = hud?.ctl ? P[hud.ctl] : null;
  const ppSide = hud ? (hud.men[0] > hud.men[1] ? 0 : hud.men[1] > hud.men[0] ? 1 : null) : null;
  const ppLeft = hud && ppSide !== null ? hud.boxed[1 - ppSide][0]?.left ?? 0 : 0;
  const peerName = session.state.peer?.name ?? 'Соперник';
  const myName = session.state.name;
  const who = (s: 0 | 1) => (s === mySide ? myName : peerName);
  const iWon = view.score[mySide] > view.score[1 - mySide];
  const readyMe = view.ready[mySide], readyPeer = view.ready[1 - mySide];
  const nextLabel = view.status === 'so' ? 'К буллитам' : view.status === 'ot' ? 'Овертайм' : `${view.period + 1}-й период`;
  const rtt = session.state.rtt;

  return (
    <div ref={root} className="fixed inset-0 z-30 bg-bg text-text flex flex-col select-none overflow-hidden" data-play-match data-online-match={role} data-phase={view.phase} style={{ touchAction: 'none' }}>
      {/* Scoreboard */}
      <header className="flex items-center gap-2 px-2 sm:px-3 py-1.5 border-b border-line bg-panel/95 pt-[max(.375rem,env(safe-area-inset-top))] pl-[max(.5rem,env(safe-area-inset-left))] pr-[max(.5rem,env(safe-area-inset-right))]">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <TeamLogo team={H} size={26} />
          <div className="min-w-0 leading-tight hidden sm:block"><div className="font-semibold truncate">{H.short}</div><div className={cn('text-[10px] truncate', mySide === 0 ? 'text-ice' : 'text-muted')}>{who(0)}</div></div>
        </div>
        <div className="flex flex-col items-center leading-none" data-play-score={`${score[0]}:${score[1]}`}>
          <span className="font-display text-2xl tabular">{score[0]} : {score[1]}</span>
          <span className="text-[10px] text-muted mt-0.5 tabular">
            {playing && hud ? <>{periodName(view.period)} · <b className="text-text" data-play-clock>{fmtClock(Math.max(0, Math.ceil(hud.len - hud.clock)))}</b> · бр. {shots[0]}–{shots[1]}</> : view.phase === 'final' ? 'Матч окончен' : view.phase === 'shootout' ? 'Буллиты' : periodName(view.period)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 min-w-0 flex-1 justify-end">
          <div className="min-w-0 leading-tight text-right hidden sm:block"><div className="font-semibold truncate">{A.short}</div><div className={cn('text-[10px] truncate', mySide === 1 ? 'text-ice' : 'text-muted')}>{who(1)}</div></div>
          <TeamLogo team={A} size={26} />
        </div>
        <span className={cn('hidden sm:inline-flex items-center gap-1 text-[10px] tabular ml-1', rtt === null ? 'text-muted' : rtt < 60 ? 'text-ok' : rtt < 150 ? 'text-amber' : 'text-accent')} title="Задержка связи с соперником" data-online-ping>
          <span className="w-1.5 h-1.5 rounded-full bg-current" />{rtt === null ? '—' : `${rtt} мс`}
        </span>
        {playing && (
          <button type="button" className="ml-1 rounded-sm border border-line px-2 py-1 text-xs hover:bg-panel2" onClick={() => openMenu(true)} aria-label="Меню" data-play-pause>
            <Icon name="pause" />
          </button>
        )}
      </header>

      {/* Situation strip */}
      {playing && hud && (ppSide !== null || hud.men[0] !== 5 || hud.men[1] !== 5 || hud.delayed !== null || hud.pulled || hud.faceoff) && (
        <div className="absolute left-1/2 -translate-x-1/2 top-[calc(env(safe-area-inset-top)+3.4rem)] z-20 flex items-center justify-center gap-2 text-[11px] px-2 py-0.5 rounded-sm bg-black/55 text-white pointer-events-none" data-play-strip>
          {ppSide !== null && <span className={cn('rounded-sm px-1.5 font-semibold', ppSide === mySide ? 'bg-ok/15 text-ok' : 'bg-accent/15 text-accent')}>{ppSide === mySide ? 'Большинство' : 'Меньшинство'} {hud.men[mySide]}×{hud.men[1 - mySide]} · {fmtClock(Math.ceil(ppLeft))}</span>}
          {ppSide === null && hud.men[0] !== 5 && <span className="rounded-sm px-1.5 bg-amber/15 text-amber font-semibold">{hud.men[0]} на {hud.men[1]}</span>}
          {hud.delayed !== null && <span className="rounded-sm px-1.5 bg-gold/20 text-gold font-semibold">Отложенный штраф</span>}
          {hud.pulled && <span className="rounded-sm px-1.5 bg-accent/15 text-accent font-semibold">Без вратаря</span>}
          {hud.faceoff && !hud.foCue && <span className="text-ice font-semibold">Вбрасывание</span>}
          {hud.foCue === 'ready' && <span className="text-ice font-semibold" data-play-fo-cue="ready">Вбрасывание: {device === 'gamepad' ? 'RB или правый стик' : device === 'touch' ? 'кнопка «Вбрасывание»' : 'F'} — когда шайба падает</span>}
        </div>
      )}

      {/* The ice */}
      <main className="relative flex-1 min-h-0 flex" data-play-ice
        onPointerDown={(e) => { if (e.pointerType === 'mouse' && playing && !paused && !(e.target as HTMLElement).closest('button, a, input, select, [data-play-touch]')) { e.preventDefault(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not an active pointer */ } mouseDown(mouse.current, e.button, e.clientX, e.clientY, performance.now()); } }}
        onPointerMove={(e) => { if (e.pointerType === 'mouse') mouseMove(mouse.current, e.clientX, e.clientY, performance.now()); }}
        onPointerUp={(e) => { if (e.pointerType === 'mouse') mouseUp(mouse.current, e.button, performance.now()); }}
        onPointerCancel={() => { mouse.current = { ...newMouse(), x: mouse.current.x, y: mouse.current.y, at: mouse.current.at }; }}
        onContextMenu={(e) => { if (playing) e.preventDefault(); }}>
        {rink ? (
          <LiveRink fill className="flex-1 min-h-0 rounded-none border-0" ticker={ticker} ids={[[], []]} goalies={[null, null]} event={null} home={H} away={A} players={P} ai={rink} running={playing} roster={roster3d} allow3d={!replay} bare minimap={!touchUI} intro={view.period === 1} />
        ) : <div className="flex-1 bg-[#0a1828]" />}

        {playing && hud && (
          <div className={cn('absolute pointer-events-none flex flex-col gap-1 w-[min(46vw,220px)] z-10', touchUI ? 'left-1/2 -translate-x-1/2 bottom-2 w-[min(34vw,200px)]' : 'left-2 bottom-2')} data-play-hud>
            <LineChip line={hud.line} touchUI={touchUI} />
            {ctlName && (
              <div className={cn('rounded-sm px-2 py-1 text-white text-xs', touchUI ? 'bg-black/25 [text-shadow:0_1px_2px_rgba(0,0,0,.85)]' : 'bg-black/55 backdrop-blur-sm')}>
                <div className="flex items-center gap-1.5"><b className="text-[#ffd23f] tabular">#{ctlName.number}</b><span className="truncate" data-play-ctl>{ctlName.name}</span><span className="ml-auto text-[10px] text-white/60">{ctlName.position}</span></div>
                {hud.move && <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-ice">{hud.move}</div>}
                <div className="mt-1 h-1 rounded bg-white/15 overflow-hidden" title="Силы"><div className={cn('h-full', hud.energy > 0.5 ? 'bg-ok' : hud.energy > 0.25 ? 'bg-amber' : 'bg-accent')} style={{ width: `${Math.round(hud.energy * 100)}%` }} /></div>
              </div>
            )}
            {hud.power > 0 && (
              <div className={cn('rounded-sm px-2 py-1 text-white text-[10px]', touchUI ? 'bg-black/25' : 'bg-black/55')}>
                <div className="flex justify-between"><span>{hud.power > 0.68 ? 'Щелчок' : hud.power > 0.35 ? 'С кисти, сильно' : 'Кистевой'}</span><span className="tabular">{Math.round(hud.power * 100)}%</span></div>
                <div className="mt-0.5 h-1.5 rounded bg-white/15 overflow-hidden"><div className="h-full bg-gradient-to-r from-ice via-amber to-accent" style={{ width: `${Math.round(hud.power * 100)}%` }} /></div>
              </div>
            )}
          </div>
        )}

        {playing && hud && (hud.foCue === 'now' || hud.foCall) && (
          <div className="absolute left-1/2 top-[22%] -translate-x-1/2 -translate-y-1/2 z-20 pointer-events-none" data-play-fo-cue={hud.foCue === 'now' ? 'now' : 'call'}>
            <span className={cn('rounded-md px-4 py-1.5 font-display text-2xl shadow-xl', hud.foCue === 'now' ? 'bg-ice text-bg animate-pulse' : hud.foCall === 'Идеально!' ? 'bg-ok text-bg' : 'bg-black/65 text-white')}>
              {hud.foCue === 'now' ? (device === 'gamepad' ? 'RB!' : device === 'touch' ? 'Жми!' : 'F!') : hud.foCall}
            </span>
          </div>
        )}

        <div className="absolute top-2 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 pointer-events-none z-10" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={cn('rounded-sm px-3 py-1 text-sm font-semibold shadow-lg fade-in', t.tone === 'goal' ? 'bg-accent text-white text-base' : t.tone === 'pen' ? 'bg-gold text-[#1b1300]' : 'bg-black/65 text-white')} data-play-toast={t.tone}>{t.text}</div>
          ))}
        </div>

        {playing && !touchUI && (
          <div className="absolute right-2 bottom-2 flex gap-1.5 z-10">
            <Button size="sm" onClick={() => command('change')} data-play-change>Смена звена <kbd className="opacity-60">{bindKeys('change')}</kbd></Button>
            <Button size="sm" variant={hud?.pulled ? 'primary' : 'secondary'} onClick={() => command('pull')} data-play-pull>{hud?.pulled ? 'Вернуть вратаря' : 'Снять вратаря'} <kbd className="opacity-60">{bindKeys('pull')}</kbd></Button>
            <Button size="sm" onClick={() => command('timeout')} disabled={!hud?.tol || !!hud?.to} data-play-timeout>Тайм-аут <kbd className="opacity-60">{bindKeys('timeout')}</kbd></Button>
          </div>
        )}
        {playing && view.away?.[1 - mySide] && (
          <div className="absolute left-2 top-12 z-10 rounded-sm bg-black/60 px-2 py-1 text-[11px] text-white pointer-events-none" data-online-peer-away>{peerName} в меню — его командой пока играет компьютер</div>
        )}
        {playing && hud?.to && (
          <div className="absolute left-1/2 -translate-x-1/2 top-3 z-20 flex flex-col items-center gap-1.5 rounded-sm bg-black/65 px-4 py-2 text-white shadow-lg fade-in" data-play-timeout-on={hud.to.side === mySide ? 'mine' : 'theirs'}>
            <div className="text-[11px] uppercase tracking-[.2em] text-white/70">Тайм-аут · {who(hud.to.side)}</div>
            <div className="font-display text-2xl tabular leading-none" data-play-timeout-left>0:{String(Math.ceil(hud.to.left)).padStart(2, '0')}</div>
            <div className="text-[11px] text-white/70">{hud.to.side === mySide ? 'Тренер объясняет установку, игроки отдыхают' : 'Соперник отдыхает и получает установку'}</div>
            {hud.to.side === mySide && <Button size="sm" onClick={() => command('timeout')} data-play-timeout-skip>Продолжить игру</Button>}
          </div>
        )}
        {playing && touchUI && !paused && !hud?.to && !hud?.show && <TouchControls touch={touch} labels={hud?.labels ?? { shoot: 'Бросок', pass: 'Пас', deke: 'Финт' }} onCommand={command} pulled={!!hud?.pulled} faceoff={!!hud?.faceoff} context={hud?.context ?? 'carry'} timeout={!!hud?.tol && !hud?.to} />}
      </main>

      {view.phase === 'loading' && (
        <Sheet>
          <div className="flex items-center justify-center gap-3 mb-3">
            <TeamLogo team={H} size={44} /><span className="font-display text-xl">{H.short} — {A.short}</span><TeamLogo team={A} size={44} />
          </div>
          <div className="flex items-center gap-2 text-sm text-muted" data-online-loading>
            <span className="w-4 h-4 rounded-full border-2 border-ice border-t-transparent animate-spin" />
            {view.period === 1 && !view.goals.length ? 'Готовим площадку на обоих устройствах…' : `${periodName(view.period)}: выходим на лёд…`}
          </div>
          {waitLong && <p className="text-xs text-muted mt-2">Устройство соперника ещё готовит 3D-картинку — матч начнётся, как только оно будет готово.</p>}
          <div className="mt-4 w-full"><Controls device={device} /></div>
        </Sheet>
      )}

      {playing && paused && setOpen && (
        <Sheet>
          <MatchSettings onBack={() => setSetOpen(false)} />
        </Sheet>
      )}

      {playing && paused && !setOpen && (
        <Sheet>
          <h2 className="font-display text-xl mb-1" data-online-paused>Меню</h2>
          <p className="text-xs text-muted mb-3">Сетевой матч не останавливается: {peerName} играет дальше, а вашей командой пока управляет компьютер · счёт {score[0]}:{score[1]}</p>
          <div className="flex flex-col gap-2 w-full max-w-xs">
            <Button variant="primary" size="lg" onClick={() => openMenu(false)} data-play-resume>Вернуться в игру</Button>
            <Button onClick={() => { openMenu(false); side.command('change'); }}>Смена звена</Button>
            <Button onClick={() => { openMenu(false); side.command('timeout'); }} disabled={!hud?.tol || !!hud?.to} data-play-pause-timeout>{hud?.tol ? 'Тайм-аут (30 с)' : 'Тайм-аут уже взят'}</Button>
            <Button variant="ghost" onClick={() => setSetOpen(true)} data-play-settings><Icon name="settings" /> Настройки</Button>
            <Button variant="ghost" onClick={() => setHelp((h) => !h)}>{help ? 'Скрыть управление' : 'Управление'}</Button>
            <Button variant="danger" onClick={onLeave} data-online-leave>Выйти из матча</Button>
          </div>
          {help && <div className="mt-3 w-full"><Controls device={device} /></div>}
        </Sheet>
      )}

      {view.phase === 'break' && (
        <Sheet>
          <h2 className="font-display text-xl mb-1">{periodName(view.period)} завершён</h2>
          <BoxScore view={view} home={H.short} away={A.short} />
          <GoalList goals={goals} P={P} onReplay={(g) => setReplay(g)} />
          <ReadyRow me={myName} peer={peerName} readyMe={readyMe} readyPeer={readyPeer} />
          <Button variant="primary" size="lg" className="mt-3" disabled={readyMe} onClick={() => side.next()} data-play-next data-online-ready-next>{readyMe ? `Ждём: ${peerName}…` : `Готов: ${nextLabel}`}</Button>
        </Sheet>
      )}

      {view.phase === 'shootout' && (
        <Sheet>
          <h2 className="font-display text-xl mb-2">Буллиты</h2>
          <ShootoutBoard events={view.soEvents as GameEvent[]} home={H} away={A} players={P} className="w-full" />
          <ReadyRow me={myName} peer={peerName} readyMe={readyMe} readyPeer={readyPeer} />
          <Button variant="primary" size="lg" className="mt-3" disabled={readyMe} onClick={() => side.next()}>{readyMe ? `Ждём: ${peerName}…` : 'Итоги матча'}</Button>
        </Sheet>
      )}

      {view.phase === 'final' && (
        <Sheet>
          <div className="text-[11px] uppercase tracking-[0.25em] text-muted mb-1">Сетевой матч · {myName} — {peerName}</div>
          <h2 className={cn('font-display text-3xl mb-1', iWon ? 'text-ok' : 'text-accent')} data-play-final>{iWon ? 'Победа!' : 'Поражение'}</h2>
          <div className="flex items-center justify-center gap-3 my-1">
            <TeamLogo team={H} size={40} />
            <div className="font-display text-3xl tabular">{view.score[0]} : {view.score[1]}{view.beyond ? <span className="text-base text-muted"> ({view.beyond})</span> : null}</div>
            <TeamLogo team={A} size={40} />
          </div>
          <BoxScore view={view} home={H.short} away={A.short} />
          <GoalList goals={goals} P={P} onReplay={(g) => setReplay(g)} />
          <div className="flex gap-2 mt-4 flex-wrap justify-center">
            <Button variant="primary" size="lg" onClick={onLobby} data-online-rematch><Icon name="swap" /> Реванш — в лобби</Button>
            <Button size="lg" variant="ghost" onClick={onLeave}>Выйти</Button>
          </div>
        </Sheet>
      )}

      {replay && <GoalReplay event={replay.event} events={view.events} home={H} away={A} players={P} motionClip={replay.clip} onClose={() => setReplay(null)} closeLabel="Закрыть" />}
    </div>
  );
}

function ReadyRow({ me, peer, readyMe, readyPeer }: { me: string; peer: string; readyMe: boolean; readyPeer: boolean }) {
  const chip = (name: string, on: boolean) => (
    <span className={cn('inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-xs', on ? 'border-ok/50 text-ok bg-ok/10' : 'border-line text-muted')}>
      <span className={cn('w-1.5 h-1.5 rounded-full', on ? 'bg-ok' : 'bg-muted/60')} />{name}: {on ? 'готов' : 'ещё нет'}
    </span>
  );
  return <div className="flex gap-2 flex-wrap justify-center mt-3" data-online-ready-row>{chip(me, readyMe)}{chip(peer, readyPeer)}</div>;
}

function BoxScore({ view, home, away }: { view: MatchView; home: string; away: string }) {
  const ps = view.periodScores;
  return (
    <table className="text-xs tabular my-2" data-play-box>
      <thead><tr className="text-muted"><th className="text-left pr-3"></th>{ps.map((_, i) => <th key={i} className="px-1.5">{i < 3 ? i + 1 : 'ОТ'}</th>)}<th className="px-1.5">Б</th><th className="px-1.5">Ш</th><th className="px-1.5">Уд</th></tr></thead>
      <tbody>
        {([0, 1] as const).map((t) => (
          <tr key={t}><td className="text-left pr-3 font-semibold">{t ? away : home}</td>{ps.map((p, i) => <td key={i} className="px-1.5 text-center">{p[t]}</td>)}<td className="px-1.5 text-center">{view.shots[t]}</td><td className="px-1.5 text-center">{view.score[t]}</td><td className="px-1.5 text-center">{view.hits[t]}</td></tr>
        ))}
      </tbody>
    </table>
  );
}
