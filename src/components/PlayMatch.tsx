import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Game, GameEvent } from '../types';
import { pads } from '../padSource';
import type { BlockKind } from '../game/engine';
import { fmtClock } from '../game/engine';
import { commitUserResult, makeUserSim, useGame } from '../game/state';
import { gameClipsKey, goalClipKey, saveGameClips, type GameClips } from '../game/clipStore';
import { PlayRink, screenToRink, type PadState, type PlayOut } from '../game/playRink';
import { endsSwitched } from '../game/rinkGeometry';
import type { ReplayClip } from '../game/rinkPlayback';
import { setSettings, useSettings } from '../game/settings';
import { enterFullscreen, fullscreenSupported } from '../fullscreen';
import { cn } from '../utils/cn';
import { Button, Icon, TeamLogo } from './ui';
import { LiveRink } from './RinkView';
import { GoalReplay } from './GoalReplay';
import { ShootoutBoard } from './Shootout';
import type { FigureRequest } from './replayCache';
import { anyGamepad, CAPTURED, COMMAND_KEYS, detectDevice, emptyTouch, gamepadPad, keyboardPad, mergePads, mouseDown, mouseMove, mousePad, mouseUp, newMouse, stickVector, type Command, type InputDevice, type MouseState, type TouchState } from './playInput';
import { suspendPadNav } from '../gamepadNav';

/**
 * A match the manager plays himself, NHL style: he skates one of his players — the puck carrier when his team has
 * it, a defender he can switch when it does not — and the rest of both teams is played by the rink AI. The rink
 * (playRink.ts) decides what happens; the statistical engine only keeps the books (GameSim.beginPlayed /
 * recordPlayed / endPlayed), so the result, the box score, the player lines, the shot map and the standings are
 * exactly those of any other game. Keyboard, gamepad and an on-screen stick with buttons on touch screens.
 */
type Phase = 'intro' | 'playing' | 'break' | 'shootout' | 'final';
interface Hud {
  clock: number; len: number; score: [number, number]; shots: [number, number]; men: [number, number];
  boxed: [{ id: string; left: number }[], { id: string; left: number }[]]; delayed: 0 | 1 | null; mode: PlayRink['mode'];
  ctl: string | null; power: number; context: 'carry' | 'support' | 'defend'; labels: { shoot: string; pass: string; deke: string }; energy: number; faceoff: boolean; foCue: 'ready' | 'now' | null; foCall: string | null; pulled: boolean; move: string | null;
}
export interface GoalItem { event: GameEvent; tau: number; clip?: ReplayClip; period: number }
interface Toast { id: number; text: string; tone: 'goal' | 'pen' | 'info' }

/** Shown on the intro screen and in the pause menu. */
const KEY_HELP: [string, string][] = [
  ['W A S D / стрелки', 'катиться'],
  ['Shift', 'рывок (тратит силы)'],
  ['Пробел / J', 'бросок: держать — сильнее (щелчок), отпустить — бросок; без шайбы в обороне — силовой приём'],
  ['K / E', 'пас в сторону стика; держать — пас верхом; в обороне — смена игрока; в атаке без шайбы — «дай пас»'],
  ['L / Q', 'финт (с рывком — вертушка, стик назад — протяжка, дважды — между ног); в замахе — ложный замах; в обороне — отбор клюшкой (сзади — подбить клюшку)'],
  ['U / Z', 'модификатор (как LB): в обороне — блокировать бросок (держать); с шайбой: + K/E — пас верхом, + L/Q — особые финты (стик назад — между ног, вбок — протяжка, прямо — ложный бросок)'],
  ['I / X', 'в обороне — подбить клюшку'],
  ['O / Y', 'в обороне — прижать к борту'],
  ['H / 1', 'в обороне — толчок (Пробел/J — силовой приём плечом)'],
  ['M / 3', 'контроль обзора (держать): лицом к шайбе, отход спиной'],
  ['N / 2', 'ускорение (держится, пока катитесь; ещё раз — выкл.)'],
  ['Пробел без шайбы', 'в атаке — держать стик для броска в одно касание (пас прилетит — бросок сразу)'],
  ['F', 'вбрасывание: нажмите, когда судья бросает шайбу (Пробел и K тоже работают, но окно уже)'],
  ['C / Tab', 'сменить игрока (к шайбе или в сторону стика); в обороне смена на защитника идёт сама'],
  ['V', 'смена звена'],
  ['T / B', 'тактика: форчекинг / выход из зоны (переключение)'],
  ['G', 'снять / вернуть вратаря'],
  ['R', 'повтор последнего гола'],
  ['Esc / P', 'пауза'],
  ['Мышь: курсор', 'прицел: бросок идёт в ту сторону ворот, где курсор (метка на воротах), пас — партнёру у курсора'],
  ['Мышь: ЛКМ', 'бросок (держать — сильнее); в обороне — силовой приём'],
  ['ЛКМ + провести', 'клюшка, как правый стик: вниз и вверх — щелчок, рывок вверх — кистевой, вбок — финт'],
  ['Мышь: ПКМ', 'пас к курсору (держать — верхом); в обороне — смена на игрока у курсора'],
  ['Колесо / средняя', 'колесо — приблизить / отдалить камеру; средняя кнопка — финт, в обороне — отбор клюшкой'],
  ['Боковые кнопки', '«назад» — финт, «вперёд» — сменить игрока; остальное — клавишами выше (мышь + клавиатура)'],
];
/** The gamepad: the NHL 25/26 scheme (playInput.ts). */
const PAD_HELP: [string, string][] = [
  ['Атака', ''],
  ['Левый стик', 'катиться и целиться: куда наклонён в момент броска или паса — туда и летит (метка на воротах)'],
  ['Правый стик влево / вправо', 'ведение шайбы, прикрыть шайбу (держите стик в сторону от защитника)'],
  ['Правый стик: вбок и вверх', 'кистевой / с неудобной руки (вбок к удобной или неудобной стороне и рывком к воротам)'],
  ['Правый стик: вниз и вверх', 'щелчок (дольше вниз — сильнее)'],
  ['Правый стик: рывки и круги', 'финты: рывок вбок — финт, вбок туда-обратно — между ног, круг — вертушка, вниз и отпустить — ложный замах'],
  ['LB + правый стик', 'особые финты: вбок — протяжка, вниз — между ног, вверх — ложный бросок'],
  ['RT', 'пас: коротко — мягкий, держать — сильнее; LB + RT — пас верхом'],
  ['RT держать + правый стик', 'быстрое ведение без случайных финтов (отпустите RT со стиком в центре — пас)'],
  ['L3', 'ускорение (пока катитесь)'],
  ['D-pad вправо', 'смена звена нападения'],
  ['B', 'бросок кнопкой (держать — сильнее), дополнительно'],
  ['Оборона', ''],
  ['LT', 'контроль обзора: игрок смотрит на шайбу, отходит спиной'],
  ['LB', 'блокировать бросок (держать): шире и надёжнее, но медленнее'],
  ['RB', 'отбор клюшкой'],
  ['RT', 'сменить игрока (ближе к шайбе или в сторону левого стика)'],
  ['Y', 'прижать к борту'],
  ['A', 'подбить клюшку'],
  ['Правый стик вверх', 'толчок'],
  ['Правый стик вниз и вверх', 'силовой приём плечом'],
  ['B', 'силовой приём кнопкой (плечом, бедром или к борту — по ситуации)'],
  ['D-pad вверх / вниз', 'форчекинг / выход из зоны (переключение тактики)'],
  ['D-pad влево', 'смена пары защитников'],
  ['Прочее', ''],
  ['RB / R3 / правый стик', 'вбрасывание: в момент, когда судья бросает шайбу'],
  ['Back', 'снять / вернуть вратаря'],
  ['Start', 'пауза'],
];

class PlayTicker {
  sec = 0;
  tau = 0;
  wait = false;
  hold = false;
  slow = false;
  shows = false;
}

export function PlayMatch({ game, onFinished }: { game: Game; onFinished: () => void }) {
  const s = useGame()!;
  const P = s.players;
  const H = s.teams[game.home], A = s.teams[game.away];
  const userIdx: 0 | 1 = game.home === s.userTeamId ? 0 : 1;
  const sim = useRef(makeUserSim(s, game)).current.sim;
  const settings = useSettings();
  const [phase, setPhase] = useState<Phase>('intro');
  const [paused, setPaused] = useState(false);
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hud, setHud] = useState<Hud | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [replay, setReplay] = useState<GoalItem | null>(null);
  const [soEvents, setSoEvents] = useState<GameEvent[]>([]);
  const [padOn, setPadOn] = useState(false);
  const [, setTick] = useState(0);
  const rink = useRef<PlayRink | null>(null);
  const ticker = useRef(new PlayTicker()).current;
  const keys = useRef(new Set<string>());
  const touch = useRef<TouchState>(emptyTouch());
  const mouse = useRef<MouseState>(newMouse());
  const goals = useRef<GoalItem[]>([]);
  const carry = useRef<[[string, number][], [string, number][]] | null>(null);
  const toastId = useRef(0);
  const prevCommands = useRef(new Set<Command>());
  const root = useRef<HTMLDivElement>(null);
  const touchUI = settings.playTouch === 'on' || (settings.playTouch === 'auto' && typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches);
  // What he plays on, for the hints: a gamepad as soon as one is connected (outside play the pads are polled here;
  // during play the game loop reads them), else the touch screen or the keyboard.
  const device: InputDevice = detectDevice(padOn, touchUI);
  useEffect(() => {
    if (phase === 'playing' && !paused) return;
    const read = () => { const on = anyGamepad(pads()); if (on !== padOnRef.current) { padOnRef.current = on; setPadOn(on); } };
    read();
    const id = window.setInterval(read, 500);
    window.addEventListener('gamepadconnected', read); window.addEventListener('gamepaddisconnected', read);
    return () => { window.clearInterval(id); window.removeEventListener('gamepadconnected', read); window.removeEventListener('gamepaddisconnected', read); };
  }, [phase, paused]);

  // Everyone who may step on the ice in 3D (figures prepared up front).
  const roster3d = useMemo(() => {
    const out: FigureRequest[] = [], seen = new Set<string>();
    ([0, 1] as const).forEach((side) => {
      const L = sim.team(side).lineup;
      const add = (id: string | null | undefined, goalie: boolean) => { if (id && !seen.has(id)) { seen.add(id); out.push({ id, side, goalie }); } };
      [...L.F.flat(), ...L.D.flat(), L.u20F, L.u20D, ...L.pp1, ...L.pp2, ...L.pk1, ...L.pk2].forEach((id) => add(id, false));
      add(L.starterG, true); add(L.backupG, true);
    });
    return out;
  }, [sim]);

  const toast = (text: string, tone: Toast['tone'] = 'info', ms = 2600) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  };

  const blockKind = (): BlockKind => (sim.status === 'ot' ? (sim.playoff ? 'ot5' : 'ot3') : sim.status === 'so' ? 'so' : 'reg');

  const startBlock = () => {
    const k = blockKind();
    if (k === 'so') {
      const evs = sim.simShootout();
      setSoEvents(evs);
      setPhase('shootout');
      return;
    }
    sim.beginPlayed(k);
    const start = sim.sec;
    const box = carry.current ? ([carry.current[0].map(([id, end]) => [id, end - start]), carry.current[1].map(([id, end]) => [id, end - start])] as [[string, number][], [string, number][]]) : undefined;
    rink.current = new PlayRink({
      home: H, away: A, players: P, lineups: [sim.team(0).lineup, sim.team(1).lineup], userSide: userIdx, kind: k,
      flip: endsSwitched(sim.period), periodMinutes: settings.playPeriod, penaltyClock: settings.playPenaltyClock, difficulty: settings.playDifficulty, autoSwitch: settings.playAutoSwitch,
      goalies: [sim.goalies[0] ?? sim.team(0).lineup.starterG, sim.goalies[1] ?? sim.team(1).lineup.starterG], box, score: [sim.score[0], sim.score[1]], period: sim.period,
    });
    ticker.tau = 0; ticker.sec = 0;
    setPaused(false);
    setPhase('playing');
  };

  /** The rink's events into the books (and on the screen). */
  const book = (k: PlayRink, out: PlayOut[]) => {
    for (const o of out) {
      if (o.type === 'shot') {
        const e = sim.recordPlayed(k.clock, o);
        if (o.outcome === 'goal' && e) {
          const g = k.goalsFor[k.goalsFor.length - 1];
          goals.current.push({ event: e, tau: g?.tau ?? k.tau, period: sim.period });
          const mine = o.side === userIdx;
          toast(`${mine ? 'ГОЛ!' : 'Гол соперника'} ${P[o.shooter]?.name ?? ''}${o.assists.length ? ` (${o.assists.map((a) => P[a]?.name).join(', ')})` : ''}`, 'goal', 3600);
        }
      } else if (o.type === 'penalty' || o.type === 'hit') {
        sim.recordPlayed(k.clock, o);
        if (o.type === 'penalty') toast(`Удаление: ${P[o.player]?.name ?? ''} — ${o.reason}, ${o.min} мин`, 'pen');
      } else if (o.type === 'waived') {
        sim.recordPlayed(k.clock, { type: 'info', side: o.side, text: o.text });
        toast(o.text);
      } else if (o.type === 'icing') toast('Проброс', 'info', 1600);
      else if (o.type === 'offside') toast('Офсайд', 'info', 1600);
    }
  };

  /** Clips of this block's goals, cut while the rink still has their frames. */
  const keepClips = (k: PlayRink) => {
    for (const g of goals.current) if (!g.clip && g.period === sim.period) g.clip = k.goalClip(g.tau) ?? undefined;
  };

  const endBlock = () => {
    const k = rink.current;
    if (!k) return;
    book(k, k.drain());
    keepClips(k);
    sim.endPlayed(k.clock);
    carry.current = sim.playedBox();
    rink.current = null;
    setPhase(sim.status === 'done' ? 'final' : 'break');
  };

  /** «Досимулировать»: the rest of the period by the rink AI, the rest of the match by the engine. */
  const simRest = () => {
    setBusy(true);
    window.setTimeout(() => {
      const k = rink.current;
      if (k) { k.runToEnd(); book(k, k.drain()); keepClips(k); sim.endPlayed(k.clock); carry.current = sim.playedBox(); rink.current = null; }
      let guard = 0;
      while (sim.status !== 'done' && guard++ < 12) {
        if (sim.status === 'playing') sim.simPeriod();
        else if (sim.status === 'ot') sim.simOT();
        else sim.simShootout();
      }
      setBusy(false); setPaused(false);
      setPhase('final');
    }, 30);
  };

  const finish = () => {
    // the goals as they were really scored: the match card replays these clips, not a reconstruction
    const clips: GameClips = {};
    for (const g of goals.current) if (g.clip) clips[goalClipKey(g.event)] = g.clip;
    void saveGameClips(gameClipsKey(s.saveId, s.seasonNumber, game.id), clips);
    commitUserResult(game.id, sim.result());
    onFinished();
  };

  const command = (c: Command) => {
    const k = rink.current;
    if (c === 'pause') { if (phase === 'playing' && !replay) setPaused((p) => !p); return; }
    if (!k || paused || phase !== 'playing') return;
    if (c === 'pull') { const on = !k.pulled[userIdx]; k.setPulled(userIdx, on); toast(on ? 'Вратарь уходит — шестой полевой' : 'Вратарь возвращается в ворота'); }
    if (c === 'change') { k.requestChange(userIdx); toast('Смена звена'); }
    if (c === 'changeF') { k.requestChange(userIdx, 'F'); toast('Смена звена нападения'); }
    if (c === 'changeD') { k.requestChange(userIdx, 'D'); toast('Смена пары защитников'); }
    if (c === 'forecheck') toast(`Форчекинг: ${k.cycleForecheck(userIdx)}`);
    if (c === 'breakout') toast(`Выход из зоны: ${k.cycleBreakout(userIdx)}`);
    if (c === 'replay') { const g = goals.current[goals.current.length - 1]; if (g) openReplay(g); }
  };
  const commandRef = useRef(command); commandRef.current = command;

  const openReplay = (g: GoalItem) => {
    const k = rink.current;
    if (!g.clip && k && g.period === sim.period) {
      if (k.tau - g.tau < 2.3) return; // the frames after the goal are still coming
      g.clip = k.goalClip(g.tau) ?? undefined;
    }
    setReplay(g);
  };

  // Keyboard: held keys by their physical code; commands on key down.
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
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, []);
  const phaseRef = useRef(phase); phaseRef.current = phase;
  // the gamepad drives the menus everywhere — except while it skates a player here
  useEffect(() => { suspendPadNav(phase === 'playing' && !paused && !replay); return () => suspendPadNav(false); }, [phase, paused, replay]);

  // The game loop: input → rink (fixed 1/60 s steps inside) → books → HUD.
  useEffect(() => {
    if (phase !== 'playing' || paused || replay || busy) return;
    let raf = 0, last = performance.now(), hudAt = 0, waited = 0, held = 0;
    // a button still held from the menu (Start that resumed the match) is not a new press
    prevCommands.current = gamepadPad(pads()).commands;
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const k = rink.current;
      if (!k) return;
      const gp = gamepadPad(pads());
      if (gp.connected !== padOnRef.current) { padOnRef.current = gp.connected; setPadOn(gp.connected); }
      for (const c of gp.commands) if (!prevCommands.current.has(c)) commandRef.current(c);
      prevCommands.current = gp.commands;
      // the 3D picture is being prepared: the match waits (a few seconds at most)
      // … and the teams' entrance before the first period (skippable, capped)
      if (ticker.wait && waited < 8) { waited += dt; raf = requestAnimationFrame(loop); return; }
      // … while it holds the clock: the teams' entrance, a replay (skippable; a safety cap all the same)
      if (ticker.hold && held < 240) { held += dt; raf = requestAnimationFrame(loop); return; }
      if (!ticker.hold) held = 0;
      const pad = framePad(k, keys.current, gp.pad, touch.current, mouse.current, now, settingsRef.current);
      k.advance(dt, pad);
      book(k, k.drain());
      ticker.tau = Math.max(0, k.tau - 1 / 60);
      ticker.sec = k.clock;
      if (now - hudAt > 90 || k.ended) {
        hudAt = now;
        const h = k.hud();
        setHud({ clock: k.clock, len: k.len, score: [k.score[0], k.score[1]], shots: [sim.shots[0], sim.shots[1]], men: k.men(), boxed: k.boxed(), delayed: k.delayed, mode: k.mode, pulled: k.pulled[userIdx], ...h });
      }
      if (k.ended) { endBlock(); return; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, paused, replay, busy]);
  const padOnRef = useRef(false);
  const settingsRef = useRef(settings); settingsRef.current = settings;

  // Pause when the window is hidden (a phone call, switching apps).
  useEffect(() => {
    const vis = () => { if (document.hidden && phaseRef.current === 'playing') setPaused(true); };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, []);

  const begin = () => {
    if (touchUI && fullscreenSupported(root.current)) void enterFullscreen(root.current);
    startBlock();
  };

  const k = rink.current;
  const periodLabel = sim.period <= 3 ? `${sim.period}-й период` : sim.playoff ? `${sim.period - 3}-й ОТ` : 'Овертайм';
  const nextLabel = (() => {
    const kk = blockKind();
    if (kk === 'so') return 'К буллитам';
    if (kk !== 'reg') return 'Начать овертайм';
    return `Начать ${sim.period + 1}-й период`;
  })();
  const score: [number, number] = hud && phase === 'playing' ? hud.score : [sim.score[0], sim.score[1]];
  const ctlName = hud?.ctl ? P[hud.ctl] : null;
  const ppSide = hud ? (hud.men[0] > hud.men[1] ? 0 : hud.men[1] > hud.men[0] ? 1 : null) : null;
  const ppLeft = hud && ppSide !== null ? hud.boxed[1 - ppSide][0]?.left ?? 0 : 0;

  return (
    <div ref={root} className="fixed inset-0 z-30 bg-bg text-text flex flex-col select-none overflow-hidden" data-play-match data-phase={phase} style={{ touchAction: 'none' }}>
      {/* Scoreboard */}
      <header className="flex items-center gap-2 px-2 sm:px-3 py-1.5 border-b border-line bg-panel/95 pt-[max(.375rem,env(safe-area-inset-top))] pl-[max(.5rem,env(safe-area-inset-left))] pr-[max(.5rem,env(safe-area-inset-right))]">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <TeamLogo team={H} size={26} />
          <span className="font-semibold truncate hidden sm:inline">{H.short}</span>
          {userIdx === 0 && <span className="text-[9px] uppercase tracking-wide text-ice" title="Ваша команда">вы</span>}
        </div>
        <div className="flex flex-col items-center leading-none" data-play-score={`${score[0]}:${score[1]}`}>
          <span className="font-display text-2xl tabular">{score[0]} : {score[1]}</span>
          <span className="text-[10px] text-muted mt-0.5 tabular">
            {phase === 'playing' && hud ? <>{periodLabel} · <b className="text-text" data-play-clock>{fmtClock(Math.max(0, Math.ceil(hud.len - hud.clock)))}</b> · <span data-play-shots>бр. {hud.shots[0]}–{hud.shots[1]}</span></> : phase === 'final' ? 'Матч окончен' : phase === 'shootout' ? 'Буллиты' : periodLabel}
          </span>
        </div>
        <div className="flex items-center gap-1.5 min-w-0 flex-1 justify-end">
          {userIdx === 1 && <span className="text-[9px] uppercase tracking-wide text-ice" title="Ваша команда">вы</span>}
          <span className="font-semibold truncate hidden sm:inline">{A.short}</span>
          <TeamLogo team={A} size={26} />
        </div>
        {phase === 'playing' && (
          <button type="button" className="ml-1 rounded-sm border border-line px-2 py-1 text-xs hover:bg-panel2" onClick={() => setPaused(true)} aria-label="Пауза" data-play-pause>
            <Icon name="pause" />
          </button>
        )}
      </header>

      {/* Situation strip */}
      {phase === 'playing' && hud && (ppSide !== null || hud.men[0] !== 5 || hud.men[1] !== 5 || hud.delayed !== null || hud.pulled || hud.faceoff) && (
        <div className="absolute left-1/2 -translate-x-1/2 top-[calc(env(safe-area-inset-top)+3.4rem)] z-20 flex items-center justify-center gap-2 text-[11px] px-2 py-0.5 rounded-sm bg-black/55 text-white pointer-events-none" data-play-strip>
          {ppSide !== null && <span className={cn('rounded-sm px-1.5 font-semibold', ppSide === userIdx ? 'bg-ok/15 text-ok' : 'bg-accent/15 text-accent')} data-play-manpower>{ppSide === userIdx ? 'Большинство' : 'Меньшинство'} {hud.men[userIdx]}×{hud.men[1 - userIdx]} · {fmtClock(Math.ceil(ppLeft))}</span>}
          {ppSide === null && hud.men[0] !== 5 && <span className="rounded-sm px-1.5 bg-amber/15 text-amber font-semibold">{hud.men[0]} на {hud.men[1]}</span>}
          {hud.delayed !== null && <span className="rounded-sm px-1.5 bg-gold/20 text-gold font-semibold" data-play-delayed>Отложенный штраф</span>}
          {hud.pulled && <span className="rounded-sm px-1.5 bg-accent/15 text-accent font-semibold">Без вратаря</span>}
          {hud.faceoff && !hud.foCue && <span className="text-ice font-semibold">Вбрасывание</span>}
          {hud.foCue === 'ready' && <span className="text-ice font-semibold" data-play-fo-cue="ready">Вбрасывание: {device === 'gamepad' ? 'RB или правый стик' : device === 'touch' ? 'кнопка «Вбрасывание»' : 'F'} — когда шайба падает</span>}
        </div>
      )}

      {/* The ice */}
      <main className="relative flex-1 min-h-0 flex" data-play-ice
        onPointerDown={(e) => { if (e.pointerType === 'mouse' && phase === 'playing' && !paused && !replay && !(e.target as HTMLElement).closest('button, a, input, select, [data-play-touch]')) { e.preventDefault(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not an active pointer */ } mouseDown(mouse.current, e.button, e.clientX, e.clientY, performance.now()); } }}
        onPointerMove={(e) => { if (e.pointerType === 'mouse') mouseMove(mouse.current, e.clientX, e.clientY, performance.now()); }}
        onPointerUp={(e) => { if (e.pointerType === 'mouse') mouseUp(mouse.current, e.button, performance.now()); }}
        onPointerCancel={() => { mouse.current = { ...newMouse(), x: mouse.current.x, y: mouse.current.y, at: mouse.current.at }; }}
        onContextMenu={(e) => { if (phase === 'playing') e.preventDefault(); }}>
        {phase === 'playing' && k ? (
          <LiveRink fill className="flex-1 min-h-0 rounded-none border-0" ticker={ticker} ids={[[], []]} goalies={[null, null]} event={null} home={H} away={A} players={P} ai={k} running={!paused && !replay} roster={roster3d} allow3d={!replay} bare minimap={!touchUI} intro={sim.period === 1 && !carry.current} />
        ) : (
          <div className="flex-1 bg-[#0a1828]" />
        )}

        {/* HUD: the controlled player, the shot meter */}
        {phase === 'playing' && hud && (
          <div className={cn('absolute pointer-events-none flex flex-col gap-1 w-[min(46vw,220px)] z-10', touchUI ? 'left-1/2 -translate-x-1/2 bottom-2 w-[min(34vw,200px)]' : 'left-2 bottom-2')} data-play-hud>
            {ctlName && (
              <div className={cn('rounded-sm px-2 py-1 text-white text-xs', touchUI ? 'bg-black/25 [text-shadow:0_1px_2px_rgba(0,0,0,.85)]' : 'bg-black/55 backdrop-blur-sm')}>
                <div className="flex items-center gap-1.5"><b className="text-[#ffd23f] tabular">#{ctlName.number}</b><span className="truncate" data-play-ctl>{ctlName.name}</span><span className="ml-auto text-[10px] text-white/60">{ctlName.position}</span></div>
                {hud.move && <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-ice" data-play-move>{hud.move}</div>}
                <div className="mt-1 h-1 rounded bg-white/15 overflow-hidden" title="Силы"><div className={cn('h-full', hud.energy > 0.5 ? 'bg-ok' : hud.energy > 0.25 ? 'bg-amber' : 'bg-accent')} style={{ width: `${Math.round(hud.energy * 100)}%` }} data-play-energy /></div>
              </div>
            )}
            {hud.power > 0 && (
              <div className={cn('rounded-sm px-2 py-1 text-white text-[10px]', touchUI ? 'bg-black/25' : 'bg-black/55')} data-play-power>
                <div className="flex justify-between"><span>{hud.power > 0.68 ? 'Щелчок' : hud.power > 0.35 ? 'С кисти, сильно' : 'Кистевой'}</span><span className="tabular">{Math.round(hud.power * 100)}%</span></div>
                <div className="mt-0.5 h-1.5 rounded bg-white/15 overflow-hidden"><div className="h-full bg-gradient-to-r from-ice via-amber to-accent" style={{ width: `${Math.round(hud.power * 100)}%` }} /></div>
              </div>
            )}
          </div>
        )}

        {/* The draw: «now!» the moment the puck falls, then how it was timed */}
        {phase === 'playing' && hud && (hud.foCue === 'now' || hud.foCall) && (
          <div className="absolute left-1/2 top-[22%] -translate-x-1/2 -translate-y-1/2 z-20 pointer-events-none" data-play-fo-cue={hud.foCue === 'now' ? 'now' : 'call'}>
            <span className={cn('rounded-md px-4 py-1.5 font-display text-2xl shadow-xl', hud.foCue === 'now' ? 'bg-ice text-bg animate-pulse' : hud.foCall === 'Идеально!' ? 'bg-ok text-bg' : 'bg-black/65 text-white')}>
              {hud.foCue === 'now' ? (device === 'gamepad' ? 'RB!' : device === 'touch' ? 'Жми!' : 'F!') : hud.foCall}
            </span>
          </div>
        )}

        {/* Toasts */}
        <div className="absolute top-2 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 pointer-events-none z-10" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={cn('rounded-sm px-3 py-1 text-sm font-semibold shadow-lg fade-in', t.tone === 'goal' ? 'bg-accent text-white text-base' : t.tone === 'pen' ? 'bg-gold text-[#1b1300]' : 'bg-black/65 text-white')} data-play-toast={t.tone}>
              {t.text}
            </div>
          ))}
        </div>

        {/* Desktop quick actions */}
        {phase === 'playing' && !touchUI && (
          <div className="absolute right-2 bottom-2 flex gap-1.5 z-10">
            <Button size="sm" onClick={() => command('change')} data-play-change>Смена звена <kbd className="opacity-60">V</kbd></Button>
            <Button size="sm" variant={hud?.pulled ? 'primary' : 'secondary'} onClick={() => command('pull')} data-play-pull>{hud?.pulled ? 'Вернуть вратаря' : 'Снять вратаря'} <kbd className="opacity-60">G</kbd></Button>
          </div>
        )}

        {phase === 'playing' && touchUI && !paused && <TouchControls touch={touch} labels={hud?.labels ?? { shoot: 'Бросок', pass: 'Пас', deke: 'Финт' }} onCommand={command} pulled={!!hud?.pulled} faceoff={!!hud?.faceoff} context={hud?.context ?? 'carry'} />}
      </main>

      {/* Intro: what to press */}
      {phase === 'intro' && (
        <Sheet>
          <div className="flex items-center justify-center gap-3 mb-2">
            <TeamLogo team={H} size={40} /><span className="font-display text-xl">{H.short} — {A.short}</span><TeamLogo team={A} size={40} />
          </div>
          <p className="text-sm text-muted mb-3">Вы управляете хоккеистом своей команды: с шайбой — тем, кто её ведёт, в обороне — ближайшим к шайбе (можно переключаться). Остальные играют сами. Голы, броски и штрафы идут в протокол как в обычном матче.</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 w-full text-left mb-3">
            <SettingPick label="Период" value={settings.playPeriod} options={[[3, '3 мин'], [5, '5 мин'], [8, '8 мин'], [12, '12 мин']]} onChange={(v) => setSettings({ playPeriod: v })} id="playPeriod" />
            <SettingPick label="Сложность" value={settings.playDifficulty} options={[['rookie', 'Новичок'], ['pro', 'Профи'], ['star', 'Звезда']]} onChange={(v) => setSettings({ playDifficulty: v })} id="playDifficulty" />
            <SettingPick label="Вид" value={settings.matchView} options={[['3d', '3D'], ['2d', '2D']]} onChange={(v) => setSettings({ matchView: v })} id="matchView" />
          </div>
          <Controls device={device} />
          <div className="flex gap-2 mt-4 flex-wrap justify-center">
            <Button variant="primary" size="lg" onClick={begin} data-play-start><Icon name="play" /> Начать матч</Button>
            <Button size="lg" variant="ghost" onClick={simRest} disabled={busy}>Досимулировать</Button>
          </div>
        </Sheet>
      )}

      {/* Pause */}
      {phase === 'playing' && paused && (
        <Sheet>
          <h2 className="font-display text-xl mb-1">Пауза</h2>
          <p className="text-xs text-muted mb-3">{periodLabel} · {hud ? fmtClock(Math.max(0, Math.ceil(hud.len - hud.clock))) : ''} · счёт {score[0]}:{score[1]}</p>
          <div className="flex flex-col gap-2 w-full max-w-xs">
            <Button variant="primary" size="lg" onClick={() => setPaused(false)} data-play-resume>Продолжить</Button>
            <Button onClick={() => { rink.current?.requestChange(userIdx); setPaused(false); }}>Смена звена</Button>
            <Button onClick={() => { const kk = rink.current; if (kk) kk.setPulled(userIdx, !kk.pulled[userIdx]); setPaused(false); }}>{hud?.pulled ? 'Вернуть вратаря' : 'Снять вратаря'}</Button>
            <Button variant="ghost" onClick={() => setHelp((h) => !h)}>{help ? 'Скрыть управление' : 'Управление'}</Button>
            {goals.current.length > 0 && <Button variant="ghost" onClick={() => openReplay(goals.current[goals.current.length - 1])}>Повтор последнего гола</Button>}
            <Button variant="ghost" onClick={simRest} disabled={busy} data-play-simrest>{busy ? 'Симуляция…' : 'Досимулировать матч'}</Button>
          </div>
          {help && <div className="mt-3 w-full"><Controls device={device} /></div>}
        </Sheet>
      )}

      {/* Intermission */}
      {phase === 'break' && (
        <Sheet>
          <h2 className="font-display text-xl mb-1">{periodLabel} завершён</h2>
          <BoxLine sim={sim} home={H.short} away={A.short} />
          <GoalList goals={goals.current} P={P} onReplay={(g) => setReplay(g)} />
          <div className="flex gap-2 mt-4 flex-wrap justify-center">
            <Button variant="primary" size="lg" onClick={() => { startBlock(); setTick((t) => t + 1); }} data-play-next>{nextLabel}</Button>
            <Button size="lg" variant="ghost" onClick={simRest} disabled={busy}>{busy ? 'Симуляция…' : 'Досимулировать'}</Button>
          </div>
        </Sheet>
      )}

      {/* Shootout (by the engine) */}
      {phase === 'shootout' && (
        <Sheet>
          <h2 className="font-display text-xl mb-2">Буллиты</h2>
          <ShootoutBoard events={soEvents} home={H} away={A} players={P} className="w-full" />
          <Button variant="primary" size="lg" className="mt-4" onClick={() => setPhase('final')}>Итоги матча</Button>
        </Sheet>
      )}

      {/* Final */}
      {phase === 'final' && (
        <Sheet>
          <h2 className="font-display text-2xl mb-1" data-play-final>{sim.score[userIdx] > sim.score[1 - userIdx] ? 'Победа!' : 'Поражение'}</h2>
          <div className="font-display text-3xl tabular mb-1">{H.short} {sim.score[0]} : {sim.score[1]} {A.short}{sim.status === 'done' && sim.period > 3 ? (soEvents.length ? ' (Б)' : ' (ОТ)') : ''}</div>
          <BoxLine sim={sim} home={H.short} away={A.short} />
          <GoalList goals={goals.current} P={P} onReplay={(g) => setReplay(g)} />
          <Button variant="primary" size="lg" className="mt-4" onClick={finish} data-play-finish>Продолжить сезон</Button>
        </Sheet>
      )}

      {replay && (
        <GoalReplay event={replay.event} events={sim.events} home={H} away={A} players={P} motionClip={replay.clip} onClose={() => setReplay(null)} closeLabel={phase === 'playing' ? 'Продолжить матч' : 'Закрыть'} />
      )}
    </div>
  );
}

/**
 * This frame's pad from every device, in rink terms: the sticks are read in screen terms and the camera of the 3D
 * picture turns them (the skill stick's up / down stays the screen's — NHL style — only the side of a deke or the
 * stickhandling turns); the mouse aims with the cursor on the ice for a few seconds after it moved.
 */
export function framePad(k: Pick<PlayRink, 'frameAt' | 'tau' | 'attack' | 'screenPick' | 'fromPercent'>, keys: Set<string>, gp: PadState, touch: TouchState, mouse: MouseState, now: number, settings: { matchView: string; matchCamera: string }): PadState {
  let pad: PadState = mergePads(keyboardPad(keys), gp, touch, mousePad(mouse, now));
  const cam = settings.matchView === '3d' ? settings.matchCamera : 'top';
  if (cam === 'end' || cam === 'vertical') {
    const px = k.frameAt(k.tau).puck.x, att = k.attack ?? 1;
    if (pad.mx || pad.my) { const v = screenToRink(pad.mx, pad.my, cam, px, att); pad = { ...pad, mx: v.x, my: v.y }; }
    if (pad.sx || pad.sy) { const v = screenToRink(pad.sx ?? 0, pad.sy ?? 0, cam, px, att); pad = { ...pad, srx: v.x, sry: v.y }; }
  }
  if (mouse.at > 0 && (now - mouse.at < 3000 || mouse.lmb || mouse.rmb)) {
    const pick = settings.matchView === '3d' && k.screenPick ? k.screenPick : svgPick;
    const pc = pick(mouse.x, mouse.y);
    if (pc) pad = { ...pad, aimAt: k.fromPercent(pc.x, pc.y) };
  }
  return pad;
}

/** The 2D rink under the mouse: a screen point → rink percent (the 3D view brings its own through the camera). */
export function svgPick(cx: number, cy: number): { x: number; y: number } | null {
  const svg = document.querySelector<SVGSVGElement>('[data-play-match] [data-live-rink] > div:not([data-rink-3d]) [data-rink-svg]');
  const m = svg?.getScreenCTM();
  if (!svg || !m) return null;
  const p = new DOMPoint(cx, cy).matrixTransform(m.inverse());
  return { x: Math.max(0, Math.min(100, p.x)), y: Math.max(0, Math.min(100, p.y * 2)) };
}

export function Sheet({ children }: { children: React.ReactNode }) {
  return (
    <div data-pad-scope className="absolute inset-0 z-40 bg-bg/80 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4 overflow-y-auto">
      <div className="bg-panel border border-line rounded-md p-4 sm:p-5 w-full max-w-2xl text-center shadow-2xl flex flex-col items-center max-h-[94dvh] overflow-y-auto overscroll-contain fade-in">{children}</div>
    </div>
  );
}

export function SettingPick<V extends string | number>({ label, value, options, onChange, id }: { label: string; value: V; options: [V, string][]; onChange: (v: V) => void; id: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted mb-1">{label}</div>
      <div className="flex rounded-sm border border-line overflow-hidden text-xs" role="radiogroup" data-play-setting={id}>
        {options.map(([v, t]) => (
          <button key={String(v)} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)} className={cn('flex-1 px-2 py-1.5 border-r border-line last:border-r-0', value === v ? 'bg-ice text-bg font-semibold' : 'text-muted hover:text-text')}>{t}</button>
        ))}
      </div>
    </div>
  );
}

/**
 * The controls of the device he plays on: a connected gamepad shows the pad, a touch screen the on-screen
 * stick and buttons, otherwise the keyboard. Plugging a pad in switches the hints at once; the other devices
 * are a tap away.
 */
export function Controls({ device }: { device: InputDevice }) {
  const [shown, setShown] = useState<InputDevice | null>(null);
  // a new device (a pad plugged in) takes over from a manual pick
  useEffect(() => setShown(null), [device]);
  const view = shown ?? device;
  const title: Record<InputDevice, string> = { gamepad: 'Геймпад', touch: 'Сенсорный экран', keyboard: 'Клавиатура' };
  return (
    <div className="w-full text-left text-xs" data-play-controls={view} data-play-device={device}>
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <span className="text-[11px] text-muted" data-play-device-note>{device === 'gamepad' ? 'Геймпад подключён — подсказки для геймпада' : device === 'touch' ? 'Игра пальцами на экране' : 'Клавиатура — подключите геймпад, и подсказки сменятся сами'}</span>
        <span className="ml-auto flex rounded-sm border border-line overflow-hidden" role="tablist" aria-label="Подсказки для">
          {(['keyboard', 'gamepad', 'touch'] as const).map(d => <button key={d} type="button" role="tab" aria-selected={view === d} onClick={() => setShown(d)}
            className={cn('px-2 py-0.5 text-[10px] border-r border-line last:border-r-0', view === d ? 'bg-ice text-bg font-semibold' : 'text-muted hover:text-text')} data-play-help-tab={d}>{title[d]}</button>)}
        </span>
      </div>
      {view === 'touch' ? (
        <>
          <p className="mb-1 text-muted">Слева — стик (коснитесь и ведите пальцем), в центре справа — <b className="text-text">клюшка</b>, как правый стик в NHL, у края — кнопки <b className="text-text">Бросок</b> (держать — сильнее), <b className="text-text">Пас</b>, <b className="text-text">Финт</b>, <b className="text-text">Смена</b> и <b className="text-text">Рывок</b>. Подписи кнопок меняются: в обороне «Бросок» — силовой приём, «Финт» — отбор клюшкой.</p>
          <p className="mb-1 text-muted" data-play-skill-help>Клюшка, как правый стик в NHL: проведите пальцем вниз и резко вверх — <b className="text-text">щелчок</b> (чем дольше внизу — тем сильнее, полная сила примерно за треть секунды); короткий рывок вверх — <b className="text-text">кистевой</b>; палец сбоку — ведение шайбы, рывок вбок — <b className="text-text">финт</b>, вбок и сразу обратно — <b className="text-text">между ног</b>, вниз и вбок — <b className="text-text">протяжка</b>, круг — <b className="text-text">вертушка</b>, вниз и отпустить — <b className="text-text">ложный замах</b>. Кнопка <b className="text-text">Финт</b>: обычный финт, с зажатым «Рывком» — вертушка, второе нажатие сразу после финта — между ног, стик назад — протяжка. В обороне рывок клюшкой или «Отбор» — отбор шайбы (сбоку и сзади — подбить клюшку); без шайбы в атаке — <b className="text-text">щелчок в одно касание</b>: отдайте пас партнёру, пока шайба летит — клюшку вниз (замах, сила копится) и рывок вверх, когда шайба приходит; замахнулись раньше — держите клюшку внизу, бросок уйдёт с рывком вверх. То же кнопкой «В касание»: зажать, пока идёт пас, отпустить — бросок. Метка на воротах показывает, куда полетит бросок: целится стик движения.</p>
          <p className="mb-1 text-muted" data-play-extra-help>Над основными кнопками — дополнительные, по ситуации. С шайбой: <b className="text-text">Верхом</b> (держать: «Пас» — пас верхом, клюшка или «Финт» — особые финты, как LB) и <b className="text-text">Ускор.</b>; без шайбы в атаке — <b className="text-text">Ускор.</b>, а основные кнопки становятся «Дай пас» и «В касание» (держать — стик готов к броску с лёта). В обороне: <b className="text-text">Блок</b> (держать), <b className="text-text">Подбить</b> клюшку, <b className="text-text">К борту</b>, <b className="text-text">Толчок</b>, <b className="text-text">Обзор</b> (держать — лицом к шайбе).</p>
          <p className="text-muted">На вбрасывании появляется большая кнопка <b className="text-text">Вбрасывание</b> — нажмите её, когда судья бросает шайбу. В обороне управление само переходит к защитнику между шайбой и воротами.</p>
        </>
      ) : (
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {(view === 'gamepad' ? PAD_HELP : KEY_HELP).map(([k, v], i) => v
            ? <Fragment key={i}><kbd className="font-mono text-[11px] text-ice whitespace-nowrap">{k}</kbd><span className="text-muted">{v}</span></Fragment>
            : <div key={i} className="col-span-2 mt-1.5 first:mt-0 text-[10px] uppercase tracking-wider text-text/80 font-semibold" data-help-section>{k}</div>)}
        </div>
      )}
      {view === 'gamepad' && device !== 'gamepad' && <p className="mt-1 text-[11px] text-muted">Геймпад не найден: подключите его и нажмите любую кнопку.</p>}
    </div>
  );
}

function BoxLine({ sim, home, away }: { sim: ReturnType<typeof makeUserSim>['sim']; home: string; away: string }) {
  const r = sim.result();
  return (
    <table className="text-xs tabular my-2" data-play-box>
      <thead><tr className="text-muted"><th className="text-left pr-3"></th>{r.periodScores.map((_, i) => <th key={i} className="px-1.5">{i < 3 ? i + 1 : 'ОТ'}</th>)}<th className="px-1.5">Б</th><th className="px-1.5">Ш</th><th className="px-1.5">Уд</th></tr></thead>
      <tbody>
        {[0, 1].map((t) => (
          <tr key={t}><td className="text-left pr-3 font-semibold">{t ? away : home}</td>{r.periodScores.map((p, i) => <td key={i} className="px-1.5 text-center">{p[t]}</td>)}<td className="px-1.5 text-center">{(t ? r.awayStats : r.homeStats).shots}</td><td className="px-1.5 text-center">{t ? r.awayScore : r.homeScore}</td><td className="px-1.5 text-center">{(t ? r.awayStats : r.homeStats).hits}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

export function GoalList({ goals, P, onReplay }: { goals: GoalItem[]; P: Record<string, { name: string }>; onReplay: (g: GoalItem) => void }) {
  if (!goals.length) return null;
  return (
    <ul className="w-full text-left text-xs space-y-1 my-1" data-play-goals>
      {goals.map((g, i) => (
        <li key={i} className="flex items-center gap-2">
          <span className="text-muted tabular w-14 shrink-0">{g.period <= 3 ? `${g.period}-й` : 'ОТ'}</span>
          <span className="truncate flex-1">{P[g.event.player ?? '']?.name ?? ''}{g.event.players?.length ? <span className="text-muted"> ({g.event.players.map((a) => P[a]?.name).join(', ')})</span> : null}</span>
          <span className="tabular text-muted">{g.event.score?.join(':')}</span>
          {g.clip && <button type="button" className="text-ice hover:underline shrink-0" onClick={() => onReplay(g)}>Повтор</button>}
        </li>
      ))}
    </ul>
  );
}

/** A floating touch stick: it appears where the thumb lands inside its zone and reports a vector of length ≤ 1. */
function FloatStick({ className, R, hint, onVec, data }: { className: string; R: number; hint: React.ReactNode; onVec: (x: number, y: number) => void; data: string }) {
  const [stick, setStick] = useState<{ ox: number; oy: number; x: number; y: number } | null>(null);
  const stickId = useRef<number | null>(null);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (stickId.current !== null) return;
    stickId.current = e.pointerId;
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* not an active pointer */ }
    const r = e.currentTarget.getBoundingClientRect();
    setStick({ ox: e.clientX - r.left, oy: e.clientY - r.top, x: 0, y: 0 });
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== stickId.current || !stick) return;
    const r = e.currentTarget.getBoundingClientRect();
    const v = stickVector(e.clientX - r.left - stick.ox, e.clientY - r.top - stick.oy, R);
    onVec(v.x, v.y);
    setStick({ ...stick, x: v.x, y: v.y });
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== stickId.current) return;
    stickId.current = null; onVec(0, 0); setStick(null);
  };
  return (
    <div className={cn('absolute pointer-events-auto touch-none', className)} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} {...{ [data]: '' }}>
      {stick ? (
        <div className="absolute rounded-full border border-white/30 bg-white/[.06]" style={{ left: stick.ox - R, top: stick.oy - R, width: R * 2, height: R * 2 }}>
          <div className="absolute rounded-full bg-white/40 border border-white/50" style={{ left: R - 24 + stick.x * R, top: R - 24 + stick.y * R, width: 48, height: 48 }} />
        </div>
      ) : hint}
    </div>
  );
}

/**
 * The phone controls: a floating skating stick on the left, the skill stick (NHL style: pull back and flick
 * for a slap / snap shot, flick for a wrist shot, sideways for dekes, a poke check on defence) in the middle of
 * the right half, and the buttons at the right edge.
 */
type TouchKey = 'shoot' | 'pass' | 'deke' | 'swap' | 'sprint' | 'faceoff' | 'lb' | 'lift' | 'pin' | 'push' | 'vision' | 'hustle';
/** The extra buttons above the main ones, by the situation (the gamepad's NHL buttons). */
const TOUCH_EXTRA: Record<'carry' | 'support' | 'defend', [TouchKey, string, string][]> = {
  carry: [['lb', 'Верхом', 'держать: пас верхом, финты — особые'], ['hustle', 'Ускор.', 'ускорение']],
  support: [['hustle', 'Ускор.', 'ускорение']],
  defend: [['lb', 'Блок', 'держать: блокировать бросок'], ['lift', 'Подбить', 'подбить клюшку'], ['pin', 'К борту', 'прижать к борту'], ['push', 'Толчок', 'толчок'], ['vision', 'Обзор', 'держать: лицом к шайбе, спиной назад']],
};
/** The shortest press a touch button gives the rink (ms): several of its 1/60 s steps. */
const TAP_MS = 110;

export function TouchControls({ touch, labels, onCommand, pulled, faceoff, context = 'carry' }: { touch: React.MutableRefObject<TouchState>; labels: { shoot: string; pass: string; deke: string }; onCommand: (c: Command) => void; pulled: boolean; faceoff: boolean; context?: 'carry' | 'support' | 'defend' }) {
  // a button that disappears with the situation (defence → attack) is let go
  useEffect(() => { for (const k of ['lb', 'lift', 'pin', 'push', 'vision', 'hustle'] as const) if (!TOUCH_EXTRA[context].some(([x]) => x === k)) touch.current[k] = false; }, [context, touch]);
  useEffect(() => () => { touch.current = emptyTouch(); }, [touch]);
  useEffect(() => { if (!faceoff) touch.current.faceoff = false; }, [faceoff, touch]);
  // A quick tap is held down for a moment: a press and a release inside one frame would never reach the rink
  // (the deke button used to «not work» on a phone for exactly that reason).
  const downAt = useRef<Partial<Record<TouchKey, number>>>({});
  const timers = useRef<Partial<Record<TouchKey, number>>>({});
  useEffect(() => () => { Object.values(timers.current).forEach((t) => window.clearTimeout(t)); }, []);
  const up = (key: TouchKey) => {
    const left = TAP_MS - (performance.now() - (downAt.current[key] ?? 0));
    window.clearTimeout(timers.current[key]);
    if (left > 0) timers.current[key] = window.setTimeout(() => { touch.current[key] = false; }, left);
    else touch.current[key] = false;
  };
  const hold = (key: TouchKey) => ({
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault(); try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* not an active pointer */ }
      window.clearTimeout(timers.current[key]);
      // a second tap right after the first: release first, so the rink sees a new press
      if (touch.current[key]) { touch.current[key] = false; window.setTimeout(() => { touch.current[key] = true; downAt.current[key] = performance.now(); }, 34); return; }
      touch.current[key] = true; downAt.current[key] = performance.now();
    },
    onPointerUp: () => up(key),
    onPointerCancel: () => up(key),
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });
  // see-through: a faint tint and a thin outline (the label keeps a shadow so it reads over the ice), solid only while pressed
  const btn = 'rounded-full border border-white/30 bg-black/15 active:bg-white/30 text-white/85 font-semibold [text-shadow:0_1px_2px_rgba(0,0,0,.85)] flex items-center justify-center touch-none';
  return (
    <div className="absolute inset-0 z-20 pointer-events-none" data-play-touch>
      <FloatStick className="left-0 top-[18%] bottom-0 w-[44%]" R={56} data="data-play-stick-zone" onVec={(x, y) => { touch.current.mx = x; touch.current.my = y; }}
        hint={<div className="absolute left-[max(1.25rem,env(safe-area-inset-left))] bottom-6 w-28 h-28 rounded-full border border-dashed border-white/25 flex items-center justify-center text-[10px] text-white/50">стик</div>} />
      <FloatStick className="left-[48%] right-[176px] top-[18%] bottom-0" R={60} data="data-play-skill-zone" onVec={(x, y) => { touch.current.sx = x; touch.current.sy = y; }}
        hint={<div className="absolute right-2 bottom-14 w-28 h-28 rounded-full border border-dashed border-ice/35 flex flex-col items-center justify-center text-center text-[9px] leading-tight text-white/55 [text-shadow:0_1px_2px_rgba(0,0,0,.85)] px-2"><b className="text-[10px] text-ice/80">клюшка</b>назад и вперёд — щелчок<br />рывок вперёд — кистевой<br />вбок — финт</div>} />
      <div className="absolute right-[max(.75rem,env(safe-area-inset-right))] bottom-[max(.75rem,env(safe-area-inset-bottom))] pointer-events-auto grid grid-cols-2 grid-rows-3 gap-2 w-[160px] h-[210px]" data-play-buttons>
        <button type="button" className={cn(btn, 'col-start-1 row-start-1 text-[11px]')} {...hold('deke')} data-touch="deke">{labels.deke}</button>
        <button type="button" className={cn(btn, 'col-start-2 row-start-1 text-[11px]')} {...hold('swap')} data-touch="swap">Смена</button>
        <button type="button" className={cn(btn, 'col-start-1 row-start-2 text-[11px]')} {...hold('sprint')} data-touch="sprint">Рывок</button>
        <button type="button" className={cn(btn, 'col-start-2 row-start-2 text-[11px]')} {...hold('pass')} data-touch="pass">{labels.pass}</button>
        <button type="button" className={cn(btn, 'col-start-1 col-span-2 row-start-3 text-sm bg-accent/25 border-accent/55')} {...hold('shoot')} data-touch="shoot">{labels.shoot}</button>
      </div>
      <div className="absolute right-[max(.75rem,env(safe-area-inset-right))] bottom-[calc(max(.75rem,env(safe-area-inset-bottom))+220px)] pointer-events-auto grid grid-cols-3 gap-1.5 w-[160px]" data-play-extra={context}>
        {TOUCH_EXTRA[context].map(([k, label, title]) => <button key={k} type="button" title={title} aria-label={title} className={cn(btn, 'h-11 text-[10px] leading-none')} {...hold(k)} data-touch={k}>{label}</button>)}
      </div>
      {/* the draw: one big button next to the others (over the skill-stick zone, idle at a draw), pressed as the puck falls */}
      {faceoff && <button type="button" className={cn(btn, 'z-10 pointer-events-auto absolute right-[calc(max(.75rem,env(safe-area-inset-right))+172px)] bottom-[calc(max(.75rem,env(safe-area-inset-bottom))+56px)] w-36 h-16 text-sm bg-ice/35 border-ice/70 text-white')} {...hold('faceoff')} data-touch="faceoff">Вбрасывание</button>}
      <div className="absolute right-[max(.75rem,env(safe-area-inset-right))] top-12 pointer-events-auto flex flex-col gap-1.5">
        <button type="button" className="rounded-sm bg-black/20 text-white/85 text-[10px] px-2 py-1 border border-white/20 [text-shadow:0_1px_2px_rgba(0,0,0,.85)]" onClick={() => onCommand('change')} data-touch="change">Смена звена</button>
        <button type="button" className="rounded-sm bg-black/20 text-white/85 text-[10px] px-2 py-1 border border-white/20 [text-shadow:0_1px_2px_rgba(0,0,0,.85)]" onClick={() => onCommand('pull')} data-touch="pull">{pulled ? 'Вернуть вратаря' : 'Снять вратаря'}</button>
      </div>
    </div>
  );
}

