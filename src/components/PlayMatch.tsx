import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Game, GameEvent, Player, Team } from '../types';
import { pads } from '../padSource';
import type { BlockKind, GameSim } from '../game/engine';
import { fmtClock } from '../game/engine';
import { commitUserResult, makeUserSim, useGame } from '../game/state';
import { gameClipsKey, goalClipKey, saveGameClips, type GameClips } from '../game/clipStore';
import { PlayRink, screenToRink, type PadState, type PlayOut } from '../game/playRink';
import { endsSwitched } from '../game/rinkGeometry';
import type { ReplayClip } from '../game/rinkPlayback';
import { setSettings, useSettings, type Settings } from '../game/settings';
import { MatchSettings } from './SettingsPanel';
import { enterFullscreen, fullscreenSupported } from '../fullscreen';
import { cn } from '../utils/cn';
import { Button, Icon, TeamLogo } from './ui';
import { LiveRink } from './RinkView';
import { GoalReplay } from './GoalReplay';
import { ShooterPicker, ShootoutBoard, ShootoutStrip } from './Shootout';
import type { FigureRequest } from './replayCache';
import { anyGamepad, CAPTURED, COMMAND_KEYS, detectDevice, emptyTouch, gamepadPad, keyboardPad, mergePads, mouseDown, mouseMove, mousePad, mouseUp, newMouse, stickVector, swipeDeke, swipeDir, MOVE_KEYS, keyLabel, bindKeys, bindButtons, type KeyBind, type PadBind, type Command, type InputDevice, type MouseState, type SwipeDir, type TouchState } from './playInput';
import { suspendPadNav } from '../gamepadNav';
import { useCrowdVerdict } from './sound/useMatchSound';
import { useSilenceMenuMusic } from './sound/menuMusic';
import { penLength } from '../game/penalties';
import { touchBuzz, touchLayout, TOUCH_ALPHA, type Spot } from './touchLayout';
import { careerOutroInfo, outroSpecOf, type OutroInfo, type OutroSpec } from './matchOutro';

/**
 * A match the manager plays himself, NHL style: he skates one of his players — the puck carrier when his team has
 * it, a defender he can switch when it does not — and the rest of both teams is played by the rink AI. The rink
 * (playRink.ts) decides what happens; the statistical engine only keeps the books (GameSim.beginPlayed /
 * recordPlayed / endPlayed), so the result, the box score, the player lines, the shot map and the standings are
 * exactly those of any other game. Keyboard, gamepad and an on-screen stick with buttons on touch screens.
 */
type Phase = 'intro' | 'playing' | 'break' | 'shootout' | 'outro' | 'final';
interface Hud {
  clock: number; len: number; score: [number, number]; shots: [number, number]; men: [number, number];
  boxed: [{ id: string; left: number }[], { id: string; left: number }[]]; delayed: 0 | 1 | null; mode: PlayRink['mode'];
  ctl: string | null; power: number; context: 'carry' | 'support' | 'defend' | 'celebrate' | 'stop'; labels: { shoot: string; pass: string; deke: string }; energy: number; faceoff: boolean; foCue: 'ready' | 'now' | null; foCall: string | null; pulled: boolean; move: string | null;
  /** the timeout under way; whether the manager still has his; his unit on the ice in words */
  to: { side: 0 | 1; left: number } | null; tol: boolean; line: string;
  /** a shootout under way: the series so far and who is next */
  so: PlayRink['shootout'];
}
export interface GoalItem { event: GameEvent; tau: number; clip?: ReplayClip; period: number }
interface Toast { id: number; text: string; tone: 'goal' | 'pen' | 'info' }

/**
 * Shown on the intro screen and in the pause menu. The keys come from the bindings in effect (the settings can
 * rebind them): «{pass}» in a line is the pass key(s), «{move}» the four directions.
 */
const KEY_HELP: [string, string][] = [
  ['{move}', 'катиться'],
  ['{sprint}', 'рывок (тратит силы)'],
  ['{shoot}', 'бросок: держать — сильнее (щелчок), отпустить — бросок; без шайбы в обороне — силовой приём'],
  ['{pass}', 'пас в сторону стика; держать — пас верхом; в обороне — смена игрока; в атаке без шайбы — «дай пас»'],
  ['{deke}', 'финт (с рывком — вертушка, стик назад — протяжка, дважды — между ног); в замахе — ложный замах; в обороне — отбор клюшкой (сзади — подбить клюшку)'],
  ['{mod}', 'модификатор (как LB): в обороне — блокировать бросок (держать); с шайбой: + {pass} — пас верхом, + {deke} — особые финты (стик назад — между ног, вбок — протяжка, прямо — ложный бросок)'],
  ['{lift}', 'в обороне — подбить клюшку; с шайбой (держать) — прикрыть шайбу корпусом'],
  ['{pin}', 'в обороне — прижать к борту; с шайбой у борта (держать) — игра в коньках; дважды — драка'],
  ['{push}', 'в обороне — толчок ({shoot} — силовой приём плечом)'],
  ['{vision}', 'контроль обзора (держать): лицом к шайбе, отход спиной; с шайбой — держать лицо в одну сторону, коротко — вертушка'],
  ['{r3}', 'R3: с шайбой — пнуть шайбу коньком, под пас — принять на конёк; в обороне — силовой бедром'],
  ['{fight}', 'драка с ближайшим соперником (в игре — сразу свисток; пять минут обоим)'],
  ['{o} · {sq}', 'после гола (с {lift}, {pin}, {vision}, {pass}, {r3}) — празднование: ○ и □'],
  ['{hustle}', 'ускорение (держится, пока катитесь; ещё раз — выкл.)'],
  ['{shoot} без шайбы', 'в атаке — держать стик для броска в одно касание (пас прилетит — бросок сразу)'],
  ['{faceoff}', 'вбрасывание: нажмите, когда судья бросает шайбу ({shoot} и {pass} тоже работают, но окно уже)'],
  ['{swap}', 'сменить игрока (к шайбе или в сторону стика); в обороне смена на защитника идёт сама'],
  ['{change}', 'смена звена'],
  ['{changeF} · {changeD}', 'смена звена нападения · пары защитников'],
  ['{forecheck} · {breakout}', 'тактика: форчекинг / выход из зоны (переключение)'],
  ['{pull}', 'снять / вернуть вратаря'],
  ['{timeout}', 'тайм-аут (30 с, один на матч)'],
  ['{replay}', 'повтор последнего гола'],
  ['{pause}', 'пауза'],
  ['Мышь: курсор', 'прицел: бросок идёт в ту сторону ворот, где курсор (метка на воротах), пас — партнёру у курсора'],
  ['Мышь: ЛКМ', 'бросок (держать — сильнее); в обороне — силовой приём'],
  ['ЛКМ + провести', 'клюшка, как правый стик: вниз и вверх — щелчок, рывок вверх — кистевой, вбок — финт'],
  ['Мышь: ПКМ', 'пас к курсору (держать — верхом); в обороне — смена на игрока у курсора'],
  ['Колесо / средняя', 'колесо — приблизить / отдалить камеру; средняя кнопка — финт, в обороне — отбор клюшкой'],
  ['Боковые кнопки', '«назад» — финт, «вперёд» — сменить игрока; остальное — клавишами выше (мышь + клавиатура)'],
];
/** «{pass}» → the keys of the pass now; «{move}» → «W A S D / ↑ ← ↓ →». Lines of unbound commands drop out. */
export function fillKeys(t: string): string {
  return t.replace(/\{(\w+)\}/g, (_, b: string) => {
    if (b === 'move') {
      const d = (['up', 'left', 'down', 'right'] as const).map(x => MOVE_KEYS[x]);
      const row = (i: number) => d.every(l => l[i]) ? d.map(l => keyLabel(l[i])).join(' ') : '';
      return [row(0), row(1)].filter(Boolean).join(' / ') || '—';
    }
    return bindKeys(b as KeyBind);
  });
}
/** The pad's lines: «{p:pass}» → the button(s) of the pass now. */
export function fillButtons(t: string): string {
  return t.replace(/\{p:(\w+)\}/g, (_, b: string) => bindButtons(b as PadBind));
}
const helpRows = (rows: [string, string][], fill: (t: string) => string): [string, string][] =>
  rows.map(([k, v]) => [fill(k), fill(v)] as [string, string]).filter(([k, v]) => !v || !/^—( · —)?$/.test(k));
/** The gamepad: the NHL 25/26 scheme (playInput.ts). */
const PAD_HELP: [string, string][] = [
  ['Атака', ''],
  ['Левый стик', 'катиться и целиться: куда наклонён в момент броска или паса — туда и летит (метка на воротах)'],
  ['Правый стик влево / вправо', 'ведение шайбы, прикрыть шайбу (держите стик в сторону от защитника)'],
  ['Правый стик: вбок и вверх', 'кистевой / с неудобной руки (вбок к удобной или неудобной стороне и рывком к воротам)'],
  ['Правый стик: вниз и вверх', 'щелчок (дольше вниз — сильнее)'],
  ['Правый стик: рывки и круги', 'финты: рывок вбок — финт, вбок туда-обратно — между ног, круг — вертушка, вниз и отпустить — ложный замах'],
  ['{p:mod} + правый стик', 'особые финты: вбок — протяжка, вниз — между ног, вверх — ложный бросок'],
  ['{p:mod} + рывок левого стика', 'финт одним касанием: вбок — финт, назад — между ног, вперёд — протяжка'],
  ['{p:pass}', 'пас: коротко — мягкий, держать — сильнее; {p:mod} + {p:pass} — пас верхом; {p:mod} во время замаха — отменить пас'],
  ['{p:pass} держать + правый стик', 'быстрое ведение без случайных финтов (отпустите {p:pass} со стиком в центре — пас)'],
  ['{p:poke} + правый стик вверх', 'вброс шайбы в зону ({p:poke} подержать — подброс над клюшками)'],
  ['{p:lift} (держать)', 'прикрыть шайбу корпусом'],
  ['{p:pin} (держать) у борта', 'игра в коньках у борта'],
  ['{p:vision}', 'держать — лицо в одну сторону, катиться в любую; коротко — вертушка'],
  ['{p:r3}', 'пнуть шайбу коньком; без шайбы, когда летит пас, — принять на конёк'],
  ['{p:hustle}', 'ускорение (пока катитесь)'],
  ['{p:changeF}', 'смена звена нападения'],
  ['Оборона', ''],
  ['{p:vision}', 'контроль обзора: игрок смотрит на шайбу, отходит спиной'],
  ['{p:mod}', 'блокировать бросок (держать): шире и надёжнее, но медленнее'],
  ['{p:poke}', 'отбор клюшкой; держать — клюшкой по льду из стороны в сторону'],
  ['{p:mod} + {p:poke}', 'бросок под шайбу (лечь, перекрыть бросок или пас)'],
  ['{p:pass}', 'сменить игрока (ближе к шайбе или в сторону левого стика)'],
  ['{p:pin}', 'прижать к борту'],
  ['{p:lift}', 'подбить клюшку'],
  ['Правый стик вверх', 'толчок'],
  ['Правый стик вниз и вверх', 'силовой приём плечом'],
  ['{p:r3}', 'силовой приём бедром'],
  ['{p:forecheck} · {p:breakout}', 'форчекинг / выход из зоны (переключение тактики)'],
  ['{p:changeD}', 'смена пары защитников'],
  ['Прочее', ''],
  ['{p:faceoff} / правый стик', 'вбрасывание: в момент, когда судья бросает шайбу'],
  ['{p:pin} дважды', 'драка с ближайшим соперником (пять минут обоим, команды в равных составах)'],
  ['После гола', 'празднование: {p:lift}, {p:o}, {p:sq}, {p:pin}; {p:vision} — верхом на клюшке, {p:pass} — на колене, {p:r3} — кулак (и вместе с ними)'],
  ['{p:pull}', 'снять / вернуть вратаря'],
  ['{p:pause}', 'пауза (там же — тайм-аут, 30 с, один на матч)'],
  ['{p:fight}', 'драка'],
  ['{p:push}', 'толчок'],
  ['{p:shoot}', 'бросок кнопкой'],
  ['{p:change}', 'смена звена'],
  ['{p:timeout}', 'тайм-аут'],
  ['{p:replay}', 'повтор последнего гола'],
];

class PlayTicker {
  sec = 0;
  tau = 0;
  wait = false;
  hold = false;
  slow = false;
  shows = false;
  ui = false;
}

/** A career match: the books from the save, the result into the season, the goal clips kept with the save. */
export function PlayMatch({ game, onFinished }: { game: Game; onFinished: () => void }) {
  const s = useGame()!;
  const [m] = useState(() => ({ sim: makeUserSim(s, game).sim, userIdx: (game.home === s.userTeamId ? 0 : 1) as 0 | 1 }));
  // the series as it stands before this game (the scene after the siren: the handshakes, the Cup)
  const [outro] = useState<OutroInfo>(() => careerOutroInfo(s, game));
  const done = (clips: GameClips) => {
    void saveGameClips(gameClipsKey(s.saveId, s.seasonNumber, game.id), clips);
    commitUserResult(game.id, m.sim.result());
    onFinished();
  };
  return <PlayMatchCore sim={m.sim} H={s.teams[game.home]} A={s.teams[game.away]} P={s.players} userIdx={m.userIdx} onDone={done} outro={outro} />;
}

export interface PlayMatchProps {
  /** the books (a career game's or a game of its own — a shootout alone starts in status 'so') */
  sim: GameSim;
  H: Team; A: Team; P: Record<string, Player>;
  /** the manager's side */
  userIdx: 0 | 1;
  /** the match over: its goal clips (a career keeps them with the save) */
  onDone: (clips: GameClips) => void;
  /**
   * A game of its own from the menu, saved nowhere: «Буллиты» ('so': the series alone — its result is the end) or
   * «Товарищеский матч» ('match'). At the end «ещё раз» or back to the menu instead of «продолжить сезон».
   */
  standalone?: { kind: 'so' | 'match'; onAgain: () => void; onQuit: () => void };
  /** the scene after the final siren in 3D (a playoff series, the Cup); without it — none */
  outro?: OutroInfo | null;
}

/** The played match: the rink, the input, the HUD, the intermissions, the final. */
export function PlayMatchCore({ sim, H, A, P, userIdx, onDone, standalone, outro: outroInfo }: PlayMatchProps) {
  const shootoutOnly = standalone?.kind === 'so' ? standalone : null;
  const settings = useSettings();
  const [phase, setPhase] = useState<Phase>('intro');
  useSilenceMenuMusic();
  useCrowdVerdict(phase === 'final' || phase === 'outro' || (!!shootoutOnly && phase === 'shootout'), sim.score[userIdx] > sim.score[1 - userIdx]);
  const [paused, setPaused] = useState(false);
  const [help, setHelp] = useState(false);
  /** the settings open over the pause menu / the intermission (without the ones the match runs with) */
  const [setOpen, setSetOpen] = useState(false);
  /** what the match runs with, fixed when it starts (the settings may change in the menus meanwhile) */
  const fixed = useRef<{ periodMinutes: Settings['playPeriod']; penaltyClock: Settings['playPenaltyClock']; difficulty: Settings['playDifficulty'] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [hud, setHud] = useState<Hud | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [replay, setReplay] = useState<GoalItem | null>(null);
  const [soEvents, setSoEvents] = useState<GameEvent[]>([]);
  /** the manager's three shooters (the intermission before the shootout; the bench's best by default) */
  const [soPick, setSoPick] = useState<string[] | null>(null);
  const [padOn, setPadOn] = useState(false);
  const [, setTick] = useState(0);
  const rink = useRef<PlayRink | null>(null);
  // (development builds: the probes reach the rink to fast-forward a period)
  if (import.meta.env.DEV) (window as unknown as { __playRink?: () => PlayRink | null }).__playRink = () => rink.current;
  const ticker = useRef(new PlayTicker()).current;
  const [show, setShow] = useState(false);
  const showRef = useRef(false);
  const keys = useRef(new Set<string>());
  const touch = useRef<TouchState>(emptyTouch());
  const mouse = useRef<MouseState>(newMouse());
  const goals = useRef<GoalItem[]>([]);
  const carry = useRef<[[string, number, boolean?][], [string, number, boolean?][]] | null>(null);
  /** each team's timeout still to take this match (one per game) */
  const timeouts = useRef<[boolean, boolean]>([true, true]);
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
    fixed.current ??= { periodMinutes: settings.playPeriod, penaltyClock: settings.playPenaltyClock, difficulty: settings.playDifficulty };
    if (k === 'so') {
      // the shootout on the ice: the manager takes his team's attempts, the goalies (and the other side's shooters) are the AI
      rink.current = new PlayRink({
        home: H, away: A, players: P, lineups: [sim.team(0).lineup, sim.team(1).lineup], userSide: userIdx, kind: 'so',
        so: { order: sim.soOrders() }, ...fixed.current, autoSwitch: settings.playAutoSwitch,
        goalies: [sim.goalies[0] ?? sim.team(0).lineup.starterG, sim.goalies[1] ?? sim.team(1).lineup.starterG], score: [sim.score[0], sim.score[1]], period: sim.period + 1,
        timeouts: [false, false],
      });
      ticker.tau = 0; ticker.sec = 0;
      setPaused(false);
      setPhase('playing');
      return;
    }
    sim.beginPlayed(k);
    fixed.current ??= { periodMinutes: settings.playPeriod, penaltyClock: settings.playPenaltyClock, difficulty: settings.playDifficulty };
    const start = sim.sec;
    const box = carry.current ? ([carry.current[0].map(([id, end, coin]) => [id, end - start, coin]), carry.current[1].map(([id, end, coin]) => [id, end - start, coin])] as [[string, number, boolean?][], [string, number, boolean?][]]) : undefined;
    rink.current = new PlayRink({
      home: H, away: A, players: P, lineups: [sim.team(0).lineup, sim.team(1).lineup], userSide: userIdx, kind: k,
      flip: endsSwitched(sim.period), ...fixed.current, autoSwitch: settings.playAutoSwitch,
      goalies: [sim.goalies[0] ?? sim.team(0).lineup.starterG, sim.goalies[1] ?? sim.team(1).lineup.starterG], box, score: [sim.score[0], sim.score[1]], period: sim.period,
      timeouts: [timeouts.current[0], timeouts.current[1]],
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
        if (o.type === 'penalty') toast(`${o.kind === 'bench' ? 'Малый скамеечный штраф' : 'Удаление'}: ${P[o.player]?.name ?? ''} — ${o.reason}, ${o.kind ? penLength({ kind: o.kind, plus: o.plus }) : `${o.min} мин`}`, 'pen');
      } else if (o.type === 'penaltyShot') {
        sim.recordPlayed(k.clock, o);
        toast(`Штрафной бросок: ${P[o.shooter]?.name ?? ''} — ${o.goal ? 'гол!' : 'не реализован'}`, o.goal ? 'goal' : 'info', 2600);
      } else if (o.type === 'soAttempt') {
        const mine = o.side === userIdx;
        toast(`${o.round}-й буллит: ${P[o.shooter]?.name ?? ''} — ${o.goal ? 'ГОЛ!' : 'не забил'} · серия ${o.so[0]}:${o.so[1]}`, o.goal ? (mine ? 'goal' : 'info') : 'info', 2600);
      } else if (o.type === 'waived') {
        sim.recordPlayed(k.clock, { type: 'info', side: o.side, text: o.text });
        toast(o.text);
      } else if (o.type === 'timeout') {
        const name = (o.side ? A : H).name;
        sim.recordPlayed(k.clock, { type: 'info', side: o.side, text: `Тайм-аут: ${name}` });
        toast(o.side === userIdx ? 'Тайм-аут — тренер объясняет, игроки отдыхают' : `Тайм-аут взял соперник (${name})`, 'info', 2600);
      } else if (o.type === 'icing') toast('Проброс', 'info', 1600);
      else if (o.type === 'offside') toast('Офсайд', 'info', 1600);
    }
  };

  /** Clips of this block's goals, cut while the rink still has their frames. */
  const keepClips = (k: PlayRink) => {
    for (const g of goals.current) if (!g.clip && g.period === sim.period) g.clip = k.goalClip(g.tau) ?? undefined;
  };

  /** The shootout played on the ice into the books: the series' board, then the final. */
  const endShootout = (k: PlayRink) => {
    book(k, k.drain());
    keepClips(k);
    const evs = sim.applyShootout(k.soAttempts);
    rink.current = null;
    setSoEvents(evs);
    toEnd(k, 'shootout');
  };

  // After the final siren: the 3D scene (the winners, the losers, the handshakes, the Cup) on the last picture of the
  // rink, then the final sheet (or the shootout's)
  const [outro, setOutro] = useState<OutroSpec | null>(null);
  const outroRink = useRef<PlayRink | null>(null);
  const outroNext = useRef<Phase>('final');
  const toEnd = (k: PlayRink, next: Phase) => {
    const st = settingsRef.current;
    if (outroInfo && !shootoutOnly && sim.status === 'done' && st.matchOutro && st.matchView === '3d') {
      outroRink.current = k; outroNext.current = next;
      const spec = outroSpecOf(sim.result(), { ...outroInfo, home: H.id, away: A.id, teamOf: (id) => P[id]?.teamId });
      // (development builds: the probes ask for the series / the Cup scene in any match)
      const force = import.meta.env.DEV ? (window as unknown as { __outroKind?: OutroSpec['kind'] }).__outroKind : undefined;
      setOutro(force ? { ...spec, kind: force, cup: 'Кубок Гагарина', season: '2026/27', series: [4, 2] } : spec);
      setPhase('outro');
      return;
    }
    setPhase(next);
  };
  const endOutro = () => {
    if (phaseRef.current !== 'outro') return;
    outroRink.current = null; setOutro(null);
    setPhase(outroNext.current);
  };

  const endBlock = () => {
    const k = rink.current;
    if (!k) return;
    if (k.shootout) { endShootout(k); return; }
    book(k, k.drain());
    keepClips(k);
    sim.endPlayed(k.clock);
    carry.current = sim.playedBox();
    timeouts.current = [k.timeoutLeft[0], k.timeoutLeft[1]];
    rink.current = null;
    if (sim.status === 'done') toEnd(k, 'final'); else setPhase('break');
  };

  /** «Досимулировать»: the rest of the period by the rink AI, the rest of the match by the engine. */
  const simRest = () => {
    setBusy(true);
    window.setTimeout(() => {
      const k = rink.current;
      // a shootout under way: what was taken stands, the engine takes the rest of the series
      if (k?.shootout) { book(k, k.drain()); setSoEvents(sim.applyShootout(k.soAttempts)); rink.current = null; }
      else if (k) { k.runToEnd(); book(k, k.drain()); keepClips(k); sim.endPlayed(k.clock); carry.current = sim.playedBox(); rink.current = null; }
      let guard = 0;
      while (sim.status !== 'done' && guard++ < 12) {
        if (sim.status === 'playing') sim.simPeriod();
        else if (sim.status === 'ot') sim.simOT();
        else setSoEvents(sim.simShootout());
      }
      setBusy(false); setPaused(false);
      setPhase(shootoutOnly ? 'shootout' : 'final');
    }, 30);
  };

  const finish = () => {
    // the goals as they were really scored: the match card replays these clips, not a reconstruction
    const clips: GameClips = {};
    for (const g of goals.current) if (g.clip) clips[goalClipKey(g.event)] = g.clip;
    onDone(clips);
  };

  const command = (c: Command) => {
    const k = rink.current;
    // (with the settings open the pause key goes back to the menu first)
    if (c === 'pause') { if (setOpen) { setSetOpen(false); return; } if (phase === 'playing' && !replay) setPaused((p) => !p); return; }
    if (!k || paused || phase !== 'playing') return;
    // a shootout: no lines, no goalie to pull, no timeout — only the replay of the last goal
    if (k.shootout && c !== 'replay') return;
    if (c === 'pull') { const on = !k.pulled[userIdx]; k.setPulled(userIdx, on); toast(on ? 'Вратарь уходит — шестой полевой' : 'Вратарь возвращается в ворота'); }
    if (c === 'change') { k.requestChange(userIdx); toast('Смена звена'); }
    if (c === 'changeF') { k.requestChange(userIdx, 'F'); toast('Смена звена нападения'); }
    if (c === 'changeD') { k.requestChange(userIdx, 'D'); toast('Смена пары защитников'); }
    if (c === 'forecheck') toast(`Форчекинг: ${k.cycleForecheck(userIdx)}`);
    if (c === 'breakout') toast(`Выход из зоны: ${k.cycleBreakout(userIdx)}`);
    if (c === 'replay') { const g = goals.current[goals.current.length - 1]; if (g) openReplay(g); }
    if (c === 'timeout') timeout(k);
  };
  const timeout = (k: PlayRink) => {
    if (k.timeoutNow()) { k.endTimeout(); return; }
    const r = k.callTimeout(userIdx);
    if (r === 'next') toast('Тайм-аут — при следующей остановке игры');
    else if (r === null) toast(k.timeoutLeft[userIdx] ? 'Тайм-аут уже заказан' : 'Тайм-аут уже взят в этом матче');
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
      // (a slow device: up to 15 fixed steps a frame keep the game — and the clock — in real time; past that it slows)
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const k = rink.current;
      if (!k) return;
      const gp = gamepadPad(pads());
      if (gp.connected !== padOnRef.current) { padOnRef.current = gp.connected; setPadOn(gp.connected); }
      for (const c of gp.commands) if (!prevCommands.current.has(c)) commandRef.current(c);
      prevCommands.current = gp.commands;
      // the broadcast's own picture (the entrance, a replay): the touch controls step aside for its «skip» button
      if (ticker.ui !== showRef.current) { showRef.current = ticker.ui; setShow(ticker.ui); }
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
        setHud({ clock: k.clock, len: k.len, score: [k.score[0], k.score[1]], shots: [sim.shots[0], sim.shots[1]], men: k.men(), boxed: k.boxed(), delayed: k.delayed, mode: k.mode, pulled: k.pulled[userIdx], ...h, to: k.timeoutNow(), tol: k.timeoutLeft[userIdx], line: k.lineOn(userIdx), so: k.shootout });
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
  // the automatic switch is a control preference: it follows the settings at once, also mid-period
  useEffect(() => { rink.current?.setAutoSwitch(settings.playAutoSwitch); }, [settings.playAutoSwitch]);
  // the menu closed (resumed, the period over): the settings with it
  useEffect(() => { if (!(phase === 'playing' && paused) && phase !== 'break') setSetOpen(false); }, [phase, paused]);

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
  // the rink on the screen: the period being played, or its last picture for the scene after the final siren
  const rinkAi = phase === 'playing' ? k : phase === 'outro' ? outroRink.current : null;
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
            {phase === 'playing' && hud?.so ? <span data-play-so>Буллиты · серия <b className="text-text tabular">{hud.so.so[0]}:{hud.so.so[1]}</b></span> : phase === 'playing' && hud ? <>{periodLabel} · <b className="text-text" data-play-clock>{fmtClock(Math.max(0, Math.ceil(hud.len - hud.clock)))}</b> · <span data-play-shots>бр. {hud.shots[0]}–{hud.shots[1]}</span></> : phase === 'final' || phase === 'outro' ? 'Матч окончен' : phase === 'shootout' ? 'Буллиты' : periodLabel}
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
      {phase === 'playing' && hud && !hud.so && (ppSide !== null || hud.men[0] !== 5 || hud.men[1] !== 5 || hud.delayed !== null || hud.pulled || hud.faceoff) && (
        <div className="absolute left-1/2 -translate-x-1/2 top-[calc(env(safe-area-inset-top)+3.4rem)] z-20 flex items-center justify-center gap-2 text-[11px] px-2 py-0.5 rounded-sm bg-black/55 text-white pointer-events-none" data-play-strip>
          {ppSide !== null && <span className={cn('rounded-sm px-1.5 font-semibold', ppSide === userIdx ? 'bg-ok/15 text-ok' : 'bg-accent/15 text-accent')} data-play-manpower>{ppSide === userIdx ? 'Большинство' : 'Меньшинство'} {hud.men[userIdx]}×{hud.men[1 - userIdx]} · {fmtClock(Math.ceil(ppLeft))}</span>}
          {ppSide === null && hud.men[0] !== 5 && <span className="rounded-sm px-1.5 bg-amber/15 text-amber font-semibold">{hud.men[0]} на {hud.men[1]}</span>}
          {hud.delayed !== null && <span className="rounded-sm px-1.5 bg-gold/20 text-gold font-semibold" data-play-delayed>Отложенный штраф</span>}
          {hud.pulled && <span className="rounded-sm px-1.5 bg-accent/15 text-accent font-semibold">Без вратаря</span>}
          {hud.faceoff && !hud.foCue && <span className="text-ice font-semibold" data-play-fo-cue="gather">Вбрасывание<span className="font-normal text-muted"> · {device === 'gamepad' ? 'RB' : device === 'touch' ? '«Вбрасывание»' : 'F'} — сразу к точке</span></span>}
          {hud.foCue === 'ready' && <span className="text-ice font-semibold" data-play-fo-cue="ready">Вбрасывание: {device === 'gamepad' ? 'RB или правый стик' : device === 'touch' ? 'кнопка «Вбрасывание»' : 'F'} — когда шайба падает</span>}
        </div>
      )}

      {/* The shootout: the series so far, who is up */}
      {phase === 'playing' && hud?.so && k && (
        <ShootoutStrip attempts={k.soAttempts} next={hud.so.live ?? hud.so.next} home={H} away={A} players={P} userIdx={userIdx}
          className="absolute left-1/2 -translate-x-1/2 top-[calc(env(safe-area-inset-top)+3.4rem)] z-20 pointer-events-none" />
      )}

      {/* The ice */}
      <main className="relative flex-1 min-h-0 flex" data-play-ice
        onPointerDown={(e) => { if (e.pointerType === 'mouse' && phase === 'playing' && !paused && !replay && !(e.target as HTMLElement).closest('button, a, input, select, [data-play-touch]')) { e.preventDefault(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not an active pointer */ } mouseDown(mouse.current, e.button, e.clientX, e.clientY, performance.now()); } }}
        onPointerMove={(e) => { if (e.pointerType === 'mouse') mouseMove(mouse.current, e.clientX, e.clientY, performance.now()); }}
        onPointerUp={(e) => { if (e.pointerType === 'mouse') mouseUp(mouse.current, e.button, performance.now()); }}
        onPointerCancel={() => { mouse.current = { ...newMouse(), x: mouse.current.x, y: mouse.current.y, at: mouse.current.at }; }}
        onContextMenu={(e) => { if (phase === 'playing') e.preventDefault(); }}>
        {rinkAi ? (
          <LiveRink fill className="flex-1 min-h-0 rounded-none border-0" ticker={ticker} ids={[[], []]} goalies={[null, null]} event={null} home={H} away={A} players={P} ai={rinkAi} running={!paused && !replay} roster={roster3d} allow3d={!replay} bare minimap={!touchUI} intro={sim.period === 1 && !carry.current} outro={phase === 'outro' ? outro : null} onOutroEnd={endOutro} />
        ) : (
          <div className="flex-1 bg-[#0a1828]" />
        )}

        {/* HUD: the controlled player, the shot meter */}
        {phase === 'playing' && hud && (
          <div className={cn('absolute pointer-events-none flex flex-col gap-1 w-[min(46vw,220px)] z-10', touchUI ? 'left-1/2 -translate-x-1/2 bottom-2 w-[min(34vw,200px)]' : 'left-2 bottom-2')} data-play-hud>
            {!hud.so && <LineChip line={hud.line} touchUI={touchUI} />}
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
        {phase === 'playing' && !touchUI && !hud?.so && (
          <div className="absolute right-2 bottom-2 flex gap-1.5 z-10">
            <Button size="sm" onClick={() => command('change')} data-play-change>Смена звена <kbd className="opacity-60">{bindKeys('change')}</kbd></Button>
            <Button size="sm" variant={hud?.pulled ? 'primary' : 'secondary'} onClick={() => command('pull')} data-play-pull>{hud?.pulled ? 'Вернуть вратаря' : 'Снять вратаря'} <kbd className="opacity-60">{bindKeys('pull')}</kbd></Button>
            <Button size="sm" onClick={() => command('timeout')} disabled={!hud?.tol || !!hud?.to} data-play-timeout>Тайм-аут <kbd className="opacity-60">{bindKeys('timeout')}</kbd></Button>
          </div>
        )}

        {phase === 'playing' && hud?.to && !paused && (
          <div className="absolute left-1/2 -translate-x-1/2 top-3 z-20 flex flex-col items-center gap-1.5 rounded-sm bg-black/65 px-4 py-2 text-white shadow-lg fade-in" data-play-timeout-on={hud.to.side === userIdx ? 'mine' : 'theirs'}>
            <div className="text-[11px] uppercase tracking-[.2em] text-white/70">Тайм-аут · {(hud.to.side ? A : H).name}</div>
            <div className="font-display text-2xl tabular leading-none" data-play-timeout-left>0:{String(Math.ceil(hud.to.left)).padStart(2, '0')}</div>
            <div className="text-[11px] text-white/70">{hud.to.side === userIdx ? 'Тренер объясняет установку, игроки отдыхают' : 'Соперник отдыхает и получает установку'}</div>
            <Button size="sm" onClick={() => command('timeout')} data-play-timeout-skip>Продолжить игру</Button>
          </div>
        )}
        {phase === 'playing' && touchUI && !paused && !hud?.to && !show && <TouchControls touch={touch} labels={hud?.labels ?? { shoot: 'Бросок', pass: 'Пас', deke: 'Финт' }} onCommand={command} pulled={!!hud?.pulled} faceoff={!!hud?.faceoff} context={hud?.context ?? 'carry'} timeout={!!hud?.tol && !hud?.to} calls={!hud?.so} />}
      </main>

      {/* Intro: what to press */}
      {phase === 'intro' && (
        <Sheet>
          <div className="flex items-center justify-center gap-3 mb-2">
            <TeamLogo team={H} size={40} /><span className="font-display text-xl">{H.short} — {A.short}</span><TeamLogo team={A} size={40} />
          </div>
          {shootoutOnly
            ? <p className="text-sm text-muted mb-3" data-play-so-intro>Серия буллитов: за свою команду бросаете вы — один на один с вратарём, от центра. Вратари и бьющие соперника — за компьютером. По три броска разными игроками, при равенстве — по одному до первого промаха.</p>
            : <p className="text-sm text-muted mb-3">Вы управляете хоккеистом своей команды: с шайбой — тем, кто её ведёт, в обороне — ближайшим к шайбе (можно переключаться). Остальные играют сами. {standalone ? 'Товарищеский матч: результат никуда не записывается.' : 'Голы, броски и штрафы идут в протокол как в обычном матче.'}</p>}
          <div className={cn('grid grid-cols-1 gap-2 w-full text-left mb-3', shootoutOnly ? 'sm:grid-cols-2' : 'sm:grid-cols-3')}>
            {!shootoutOnly && <SettingPick label="Период" value={settings.playPeriod} options={[[3, '3 мин'], [5, '5 мин'], [8, '8 мин'], [12, '12 мин']]} onChange={(v) => setSettings({ playPeriod: v })} id="playPeriod" />}
            <SettingPick label="Сложность" value={settings.playDifficulty} options={[['rookie', 'Новичок'], ['pro', 'Профи'], ['star', 'Звезда']]} onChange={(v) => setSettings({ playDifficulty: v })} id="playDifficulty" />
            <SettingPick label="Вид" value={settings.matchView} options={[['3d', '3D'], ['2d', '2D']]} onChange={(v) => setSettings({ matchView: v })} id="matchView" />
          </div>
          <Controls device={device} />
          <div className="flex gap-2 mt-4 flex-wrap justify-center">
            <Button variant="primary" size="lg" onClick={begin} data-play-start><Icon name="play" /> {shootoutOnly ? 'Начать серию' : 'Начать матч'}</Button>
            <Button size="lg" variant="ghost" onClick={simRest} disabled={busy}>Досимулировать</Button>
            {standalone && <Button size="lg" variant="ghost" onClick={standalone.onQuit} data-play-quit>Назад</Button>}
          </div>
        </Sheet>
      )}

      {/* Pause */}
      {setOpen && (phase === 'break' || (phase === 'playing' && paused)) && (
        <Sheet>
          <MatchSettings onBack={() => setSetOpen(false)} />
        </Sheet>
      )}

      {phase === 'playing' && paused && !setOpen && (
        <Sheet>
          <h2 className="font-display text-xl mb-1">Пауза</h2>
          <p className="text-xs text-muted mb-3">{hud?.so ? `Буллиты · серия ${hud.so.so[0]}:${hud.so.so[1]}` : `${periodLabel} · ${hud ? fmtClock(Math.max(0, Math.ceil(hud.len - hud.clock))) : ''} · счёт ${score[0]}:${score[1]}`}</p>
          <div className="flex flex-col gap-2 w-full max-w-xs">
            <Button variant="primary" size="lg" onClick={() => setPaused(false)} data-play-resume>Продолжить</Button>
            {!hud?.so && <>
            <Button onClick={() => { rink.current?.requestChange(userIdx); setPaused(false); }}>Смена звена</Button>
            <Button onClick={() => { const kk = rink.current; if (kk) kk.setPulled(userIdx, !kk.pulled[userIdx]); setPaused(false); }}>{hud?.pulled ? 'Вернуть вратаря' : 'Снять вратаря'}</Button>
            <Button onClick={() => { setPaused(false); if (rink.current) timeout(rink.current); }} disabled={!hud?.tol || !!hud?.to} data-play-pause-timeout>{hud?.tol ? 'Тайм-аут (30 с)' : 'Тайм-аут уже взят'}</Button>
            </>}
            <Button variant="ghost" onClick={() => setSetOpen(true)} data-play-settings><Icon name="settings" /> Настройки</Button>
            <Button variant="ghost" onClick={() => setHelp((h) => !h)}>{help ? 'Скрыть управление' : 'Управление'}</Button>
            {goals.current.length > 0 && <Button variant="ghost" onClick={() => openReplay(goals.current[goals.current.length - 1])}>Повтор последнего гола</Button>}
            <Button variant="ghost" onClick={simRest} disabled={busy} data-play-simrest>{busy ? 'Симуляция…' : shootoutOnly ? 'Досимулировать серию' : 'Досимулировать матч'}</Button>
            {standalone && <Button variant="ghost" onClick={standalone.onQuit} data-play-quit>Выйти в меню</Button>}
          </div>
          {help && <div className="mt-3 w-full"><Controls device={device} /></div>}
        </Sheet>
      )}

      {/* Intermission */}
      {phase === 'break' && !setOpen && (
        <Sheet>
          <h2 className="font-display text-xl mb-1">{periodLabel} завершён</h2>
          <BoxLine sim={sim} home={H.short} away={A.short} />
          <GoalList goals={goals.current} P={P} onReplay={(g) => setReplay(g)} />
          {blockKind() === 'so' && (() => {
            const cands = sim.shootoutCandidates(userIdx);
            const cur = (soPick ?? sim.soOrder[userIdx] ?? []).filter((id) => cands.includes(id));
            const value = [...cur, ...cands.filter((id) => !cur.includes(id))].slice(0, 3);
            return <div className="mt-3 w-full flex justify-center"><ShooterPicker candidates={cands} value={value} players={P} onChange={(ids) => { setSoPick(ids); sim.soOrder[userIdx] = ids; }} /></div>;
          })()}
          <div className="flex gap-2 mt-4 flex-wrap justify-center">
            <Button variant="primary" size="lg" onClick={() => { startBlock(); setTick((t) => t + 1); }} data-play-next>{nextLabel}</Button>
            <Button size="lg" variant="ghost" onClick={simRest} disabled={busy}>{busy ? 'Симуляция…' : 'Досимулировать'}</Button>
            <Button size="lg" variant="ghost" onClick={() => setSetOpen(true)} data-play-settings><Icon name="settings" /> Настройки</Button>
          </div>
        </Sheet>
      )}

      {/* Shootout: the series' board */}
      {phase === 'shootout' && (
        <Sheet>
          <h2 className="font-display text-xl mb-2" data-play-so-result={shootoutOnly ? (sim.score[userIdx] > sim.score[1 - userIdx] ? 'win' : 'loss') : undefined}>
            {shootoutOnly ? (sim.score[userIdx] > sim.score[1 - userIdx] ? 'Серия ваша!' : 'Серия проиграна') : 'Буллиты'}
          </h2>
          <ShootoutBoard events={soEvents} home={H} away={A} players={P} className="w-full" />
          {shootoutOnly ? (
            <div className="flex gap-2 mt-4 flex-wrap justify-center">
              <Button variant="primary" size="lg" onClick={shootoutOnly.onAgain} data-play-so-again>Ещё серия</Button>
              <Button size="lg" variant="ghost" onClick={shootoutOnly.onQuit} data-play-quit>В меню</Button>
            </div>
          ) : <Button variant="primary" size="lg" className="mt-4" onClick={() => setPhase('final')} data-play-so-next>Итоги матча</Button>}
        </Sheet>
      )}

      {/* Final */}
      {phase === 'final' && (
        <Sheet>
          <h2 className="font-display text-2xl mb-1" data-play-final>{sim.score[userIdx] > sim.score[1 - userIdx] ? 'Победа!' : 'Поражение'}</h2>
          <div className="font-display text-3xl tabular mb-1">{H.short} {sim.score[0]} : {sim.score[1]} {A.short}{sim.status === 'done' && sim.period > 3 ? (soEvents.length ? ' (Б)' : ' (ОТ)') : ''}</div>
          <BoxLine sim={sim} home={H.short} away={A.short} />
          <GoalList goals={goals.current} P={P} onReplay={(g) => setReplay(g)} />
          {standalone ? (
            <div className="flex gap-2 mt-4 flex-wrap justify-center">
              <Button variant="primary" size="lg" onClick={standalone.onAgain} data-play-again>Ещё матч</Button>
              <Button size="lg" variant="ghost" onClick={standalone.onQuit} data-play-quit>В меню</Button>
            </div>
          ) : <Button variant="primary" size="lg" className="mt-4" onClick={finish} data-play-finish>Продолжить сезон</Button>}
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
    const pick: (x: number, y: number) => { x: number; y: number; h?: number } | null = settings.matchView === '3d' && k.screenPick ? k.screenPick : svgPick;
    const pc = pick(mouse.x, mouse.y);
    if (pc) pad = { ...pad, aimAt: { ...k.fromPercent(pc.x, pc.y), ...(pc.h !== undefined ? { h: pc.h } : {}) } };
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
          <p className="mb-1 text-muted" data-play-skill-help>Клюшка, как правый стик в NHL: проведите пальцем вниз и резко вверх — <b className="text-text">щелчок</b> (чем дольше внизу — тем сильнее, полная сила примерно за треть секунды); короткий рывок вверх — <b className="text-text">кистевой</b>; палец сбоку — ведение шайбы, рывок вбок — <b className="text-text">финт</b>, вбок и сразу обратно — <b className="text-text">между ног</b>, вниз и вбок — <b className="text-text">протяжка</b>, круг — <b className="text-text">вертушка</b>, вниз и отпустить — <b className="text-text">ложный замах</b>. Кнопка <b className="text-text">Финт</b> — проведите по ней пальцем: <b className="text-text">вверх</b> — вертушка, <b className="text-text">вниз</b> — между ног, <b className="text-text">влево / вправо</b> — протяжка в эту сторону; просто нажать — обычный финт (с зажатым «Рывком» — вертушка, второе нажатие сразу после финта — между ног). В обороне рывок клюшкой или «Отбор» — отбор шайбы (сбоку и сзади — подбить клюшку); без шайбы в атаке — <b className="text-text">щелчок в одно касание</b>: отдайте пас партнёру, пока шайба летит — клюшку вниз (замах, сила копится) и рывок вверх, когда шайба приходит; замахнулись раньше — держите клюшку внизу, бросок уйдёт с рывком вверх. То же кнопкой «В касание»: зажать, пока идёт пас, отпустить — бросок. Метка на воротах показывает, куда полетит бросок: целится стик движения.</p>
          <p className="mb-1 text-muted" data-play-extra-help>Над основными кнопками — дополнительные, по ситуации. С шайбой: <b className="text-text">Верхом</b> (держать: «Пас» — пас верхом, клюшка или «Финт» — особые финты, как LB) и <b className="text-text">Ускор.</b>; без шайбы в атаке — <b className="text-text">Ускор.</b>, а основные кнопки становятся «Дай пас» и «В касание» (держать — стик готов к броску с лёта). В обороне: <b className="text-text">Блок</b> (держать), <b className="text-text">Подбить</b> клюшку, <b className="text-text">К борту</b>, <b className="text-text">Толчок</b>, <b className="text-text">Обзор</b> (держать — лицом к шайбе).</p>
          <p className="text-muted">На вбрасывании появляется большая кнопка <b className="text-text">Вбрасывание</b> — нажмите её, когда судья бросает шайбу. В обороне управление само переходит к защитнику между шайбой и воротами.</p>
        </>
      ) : (
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {(view === 'gamepad' ? helpRows(PAD_HELP, fillButtons) : helpRows(KEY_HELP, fillKeys)).map(([k, v], i) => v
            ? <Fragment key={i}><kbd className="font-mono text-[11px] text-ice whitespace-nowrap">{k}</kbd><span className="text-muted">{v}</span></Fragment>
            : <div key={i} className="col-span-2 mt-1.5 first:mt-0 text-[10px] uppercase tracking-wider text-text/80 font-semibold" data-help-section>{k}</div>)}
        </div>
      )}
      {view === 'gamepad' && device !== 'gamepad' && <p className="mt-1 text-[11px] text-muted">Геймпад не найден: подключите его и нажмите любую кнопку.</p>}
      {view !== 'touch' && <p className="mt-1.5 text-[11px] text-muted" data-play-rebind-hint>Любую {view === 'gamepad' ? 'кнопку' : 'клавишу'} можно переназначить: Настройки → Управление.</p>}
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
/** The centre of a fixed stick: this far in from its zone's bottom corner, px (where its dashed hint is drawn). */
const FIXED_STICK = { x: 76, y: 80 };
function FloatStick({ className, style, R, hint, onVec, data, fixed }: { className: string; style?: React.CSSProperties; R: number; hint: React.ReactNode; onVec: (x: number, y: number) => void; data: string; /** always centred at the zone's bottom corner on this side (else where the thumb lands) */ fixed?: 'left' | 'right' }) {
  const [stick, setStick] = useState<{ ox: number; oy: number; x: number; y: number } | null>(null);
  const stickId = useRef<number | null>(null);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (stickId.current !== null) return;
    stickId.current = e.pointerId;
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* not an active pointer */ }
    const r = e.currentTarget.getBoundingClientRect();
    if (!fixed) { setStick({ ox: e.clientX - r.left, oy: e.clientY - r.top, x: 0, y: 0 }); return; }
    // fixed: the stick stays put and the first touch already pushes it
    const ox = fixed === 'left' ? FIXED_STICK.x : r.width - FIXED_STICK.x, oy = r.height - FIXED_STICK.y;
    const v = stickVector(e.clientX - r.left - ox, e.clientY - r.top - oy, R);
    onVec(v.x, v.y);
    setStick({ ox, oy, x: v.x, y: v.y });
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
    <div className={cn('absolute pointer-events-auto touch-none', className)} style={style} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} {...{ [data]: '' }}>
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
type TouchKey = 'shoot' | 'pass' | 'deke' | 'swap' | 'sprint' | 'faceoff' | 'lb' | 'lift' | 'pin' | 'push' | 'vision' | 'hustle' | 'r3' | 'fight' | 'o' | 'sq';
type TouchContext = 'carry' | 'support' | 'defend' | 'celebrate' | 'stop';
/** The extra buttons above the main ones, by the situation (the gamepad's NHL buttons). */
const TOUCH_EXTRA: Record<TouchContext, [TouchKey, string, string][]> = {
  carry: [['lb', 'Верхом', 'держать: пас верхом, финты — особые'], ['lift', 'Прикрыть', 'держать: прикрыть шайбу корпусом'], ['pin', 'У борта', 'держать у борта: игра в коньках'], ['r3', 'Конёк', 'пнуть шайбу коньком'], ['hustle', 'Ускор.', 'ускорение']],
  support: [['r3', 'На конёк', 'принять пас на конёк'], ['hustle', 'Ускор.', 'ускорение']],
  defend: [['lb', 'Блок', 'держать: блокировать бросок'], ['lift', 'Подбить', 'подбить клюшку'], ['pin', 'К борту', 'прижать к борту'], ['push', 'Толчок', 'толчок'], ['r3', 'Бедро', 'силовой приём бедром'], ['vision', 'Обзор', 'держать: лицом к шайбе, спиной назад']],
  celebrate: [['o', 'Лук', 'лук и стрела'], ['pin', 'Трибуны', 'слышу трибуны'], ['vision', 'Клюшка', 'верхом на клюшке'], ['r3', 'Кулак', 'кулак (и вместе с клюшкой / коленом)']],
  stop: [['fight', 'Драка', 'сбросить перчатки с ближайшим соперником']],
};
/** The shortest press a touch button gives the rink (ms): several of its 1/60 s steps. */
const TAP_MS = 110;

export function TouchControls({ touch, labels, onCommand, pulled, faceoff, context = 'carry', timeout = true, calls = true }: { touch: React.MutableRefObject<TouchState>; labels: { shoot: string; pass: string; deke: string }; onCommand: (c: Command) => void; pulled: boolean; faceoff: boolean; context?: TouchContext; /** the timeout can still be called */ timeout?: boolean; /** the bench's calls (a shootout has none) */ calls?: boolean }) {
  // a button that disappears with the situation (defence → attack) is let go
  useEffect(() => { for (const k of ['lb', 'lift', 'pin', 'push', 'vision', 'hustle', 'r3', 'fight', 'o', 'sq'] as const) if (!TOUCH_EXTRA[context].some(([x]) => x === k)) touch.current[k] = false; }, [context, touch]);
  useEffect(() => () => { touch.current = emptyTouch(); }, [touch]);
  useEffect(() => { if (!faceoff) touch.current.faceoff = false; }, [faceoff, touch]);
  // the player's own layout (Настройки → Управление → «Сенсорный экран»)
  const settings = useSettings();
  const buzz = () => touchBuzz(settings.touchHaptics);
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
      buzz();
      window.clearTimeout(timers.current[key]);
      // a second tap right after the first: release first, so the rink sees a new press
      if (touch.current[key]) { touch.current[key] = false; window.setTimeout(() => { touch.current[key] = true; downAt.current[key] = performance.now(); }, 34); return; }
      touch.current[key] = true; downAt.current[key] = performance.now();
    },
    onPointerUp: () => up(key),
    onPointerCancel: () => up(key),
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });
  // The deke button with the puck: which way the thumb goes across it picks the deke — up a spin-o-rama, down between
  // the legs, left / right a toe drag that way; a tap (or a thumb held still) the usual deke. The press waits for the
  // swipe (or the release), so the rink gets the kind together with the press.
  const swipe = useRef<{ id: number; x: number; y: number; done: boolean; timer: number } | null>(null);
  const [swiped, setSwiped] = useState<SwipeDir | 'tap' | null>(null);
  const flashT = useRef(0);
  useEffect(() => () => { window.clearTimeout(swipe.current?.timer); window.clearTimeout(flashT.current); }, []);
  // the puck lost before the swipe came: no deke (and no poke) out of it
  useEffect(() => { if (context !== 'carry' && swipe.current) { window.clearTimeout(swipe.current.timer); swipe.current = null; } }, [context]);
  const fireDeke = (dir: SwipeDir | null) => {
    const sw = swipe.current; if (!sw || sw.done) return;
    sw.done = true; window.clearTimeout(sw.timer);
    const d = swipeDeke(dir);
    const press = () => {
      touch.current.dekeKind = d.kind; touch.current.dekeSide = d.side;
      touch.current.deke = true; downAt.current.deke = performance.now();
      timers.current.deke = window.setTimeout(() => { touch.current.deke = false; touch.current.dekeKind = undefined; touch.current.dekeSide = undefined; }, TAP_MS);
    };
    window.clearTimeout(timers.current.deke);
    // still held from the last one: let go first, so the rink sees a new press
    if (touch.current.deke) { touch.current.deke = false; timers.current.deke = window.setTimeout(press, 34); } else press();
    setSwiped(dir ?? 'tap'); window.clearTimeout(flashT.current); flashT.current = window.setTimeout(() => setSwiped(null), 520);
  };
  const dekeSwipe = {
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault(); try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* not an active pointer */ }
      buzz();
      window.clearTimeout(swipe.current?.timer);
      // a still thumb is a tap after a moment (no waiting for the release)
      swipe.current = { id: e.pointerId, x: e.clientX, y: e.clientY, done: false, timer: window.setTimeout(() => fireDeke(null), 260) };
    },
    onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
      const sw = swipe.current; if (!sw || sw.done || sw.id !== e.pointerId) return;
      const dir = swipeDir(e.clientX - sw.x, e.clientY - sw.y);
      if (dir) fireDeke(dir);
    },
    onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => { const sw = swipe.current; if (sw && !sw.done) fireDeke(swipeDir(e.clientX - sw.x, e.clientY - sw.y)); swipe.current = null; },
    onPointerCancel: () => { if (swipe.current) window.clearTimeout(swipe.current.timer); swipe.current = null; },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };
  const DEKE_SWIPE_NAME: Record<SwipeDir | 'tap', string> = { up: 'вертушка', down: 'между ног', left: '← протяжка', right: 'протяжка →', tap: 'финт' };
  // see-through: a faint tint and a thin outline (the label keeps a shadow so it reads over the ice), solid only while pressed
  const look = TOUCH_ALPHA[settings.touchAlpha];
  const btn = cn('absolute rounded-full border border-white/30 bg-black/15 active:bg-white/30 active:scale-95 transition-transform text-white/90 font-semibold [text-shadow:0_1px_2px_rgba(0,0,0,.85)] flex items-center justify-center text-center leading-none touch-none select-none', look.cls);
  const pill = 'rounded-full bg-black/25 text-white/90 text-[11px] px-3 py-1.5 border border-white/25 [text-shadow:0_1px_2px_rgba(0,0,0,.85)] active:bg-white/30 disabled:opacity-40';
  // The right thumb's cluster, laid out like the mobile hockey games: the shot the biggest, in the corner under the
  // thumb; pass next to it; the deke, the switch and the burst in an arc above; the situation's extras in an outer arc
  // (all reached by rolling the thumb, none hidden under another). Positions from the bottom-right corner, px.
  // (on defence the pass button switches the player already: no second «Смена» there)
  const outer: [TouchKey, string, string][] = [...(context === 'defend' || context === 'celebrate' || context === 'stop' ? [] : [['swap', 'Смена', 'сменить игрока'] as [TouchKey, string, string]]), ...TOUCH_EXTRA[context]];
  const [screenH, setScreenH] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 400));
  useEffect(() => { const f = () => setScreenH(window.innerHeight); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
  const L = touchLayout(settings, screenH), side = L.side, other = side === 'right' ? 'left' : 'right';
  const inset = (sd: 'left' | 'right') => `max(.5rem, env(safe-area-inset-${sd}))`;
  const at = (p: Spot | { x: number; y: number; w: number; h: number }) => ({ [side]: `calc(${inset(side)} + ${p.x}px)`, bottom: `calc(max(.5rem, env(safe-area-inset-bottom)) + ${p.y}px)`, width: 'size' in p ? p.size : p.w, height: 'size' in p ? p.size : p.h });
  return (
    <div className="absolute inset-0 z-20 pointer-events-none" data-play-touch={context} data-touch-side={side}>
      {/* the skating stick on the other thumb's side (on the right for a left-handed player) */}
      <FloatStick className="top-[16%] bottom-0 w-[42%]" style={{ [other]: 0 }} R={56 * Math.min(1.2, settings.touchSize)} data="data-play-stick-zone" fixed={settings.touchStick === 'fixed' ? other : undefined} onVec={(x, y) => { touch.current.mx = x; touch.current.my = y; }}
        hint={<div className={cn('absolute bottom-6 w-28 h-28 rounded-full border border-dashed flex items-center justify-center text-[10px]', settings.touchStick === 'fixed' ? 'border-white/40 bg-white/[.05] text-white/60' : 'border-white/25 text-white/50')} style={{ [other]: `max(1.25rem, env(safe-area-inset-${other}))`, opacity: look.opacity }}>стик</div>} />
      {settings.touchSkill && <FloatStick className="top-[16%] bottom-0" style={{ [other]: '44%', [side]: L.skillGap }} R={60} data="data-play-skill-zone" onVec={(x, y) => { touch.current.sx = x; touch.current.sy = y; }}
        hint={<div style={{ [side]: '.5rem', opacity: look.opacity }} className="absolute bottom-10 w-28 h-28 rounded-full border border-dashed border-ice/35 flex flex-col items-center justify-center text-center text-[9px] leading-tight text-white/55 [text-shadow:0_1px_2px_rgba(0,0,0,.85)] px-2"><b className="text-[10px] text-ice/80">клюшка</b>назад и вперёд — щелчок<br />рывок вперёд — кистевой<br />вбок — финт</div>} />}
      <div className="absolute inset-0 pointer-events-none" style={{ opacity: look.opacity }} data-play-buttons>
        <button type="button" className={cn(btn, 'pointer-events-auto text-sm bg-accent/30 border-accent/60')} style={at(L.shoot)} {...hold('shoot')} data-touch="shoot">{labels.shoot}</button>
        <button type="button" className={cn(btn, 'pointer-events-auto text-xs')} style={at(L.pass)} {...hold('pass')} data-touch="pass">{labels.pass}</button>
        {context === 'carry'
          ? <button type="button" className={cn(btn, 'pointer-events-auto text-[11px]')} style={at(L.deke)} {...dekeSwipe} data-touch="deke" data-touch-swipe={swiped ?? undefined} title="Финт: тап — обычный, вверх — вертушка, вниз — между ног, влево / вправо — протяжка">
              {/* the four ways, faintly round the label */}
              <span aria-hidden className="absolute inset-0 pointer-events-none text-[8px] text-white/45">
                <span className="absolute top-0.5 left-1/2 -translate-x-1/2">▲</span><span className="absolute bottom-0.5 left-1/2 -translate-x-1/2">▼</span>
                <span className="absolute left-1 top-1/2 -translate-y-1/2">◀</span><span className="absolute right-1 top-1/2 -translate-y-1/2">▶</span>
              </span>
              {labels.deke}
              {swiped && <span className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-sm bg-black/60 px-1.5 py-0.5 text-[10px] text-ice fade-in" data-touch-deke-kind>{DEKE_SWIPE_NAME[swiped]}</span>}
            </button>
          : <button type="button" className={cn(btn, 'pointer-events-auto text-[11px]')} style={at(L.deke)} {...hold('deke')} data-touch="deke">{labels.deke}</button>}
        <button type="button" className={cn(btn, 'pointer-events-auto text-[11px]')} style={at(L.sprint)} {...hold('sprint')} data-touch="sprint">Рывок</button>
      </div>
      <div className="absolute inset-0 pointer-events-none" style={{ opacity: look.opacity }} data-play-extra={context}>
        {outer.map(([k, label, title], i) => { const p = L.ring(i, outer.length); return <button key={k} type="button" title={title} aria-label={title} className={cn(btn, 'pointer-events-auto text-[10px]', k === 'swap' ? 'bg-black/15' : 'bg-black/25 border-white/20')} style={at(p)} {...hold(k)} data-touch={k}>{label}</button>; })}
      </div>
      {/* the draw: one big button left of the cluster, pressed as the puck falls */}
      {faceoff && <button type="button" className={cn(btn, 'z-10 pointer-events-auto rounded-2xl text-sm bg-ice/35 border-ice/70 text-white')} style={at(L.faceoff)} {...hold('faceoff')} data-touch="faceoff">Вбрасывание</button>}
      {/* the bench's calls: a row at the top right, out of the thumbs' way */}
      {calls && <div className="absolute right-[max(.5rem,env(safe-area-inset-right))] top-[calc(env(safe-area-inset-top)+3.1rem)] pointer-events-auto flex gap-1.5" data-play-calls>
        <button type="button" className={pill} onClick={() => onCommand('change')} data-touch="change">Смена звена</button>
        <button type="button" className={pill} onClick={() => onCommand('pull')} data-touch="pull">{pulled ? 'Вратаря в ворота' : 'Снять вратаря'}</button>
        <button type="button" className={pill} onClick={() => onCommand('timeout')} disabled={!timeout} data-touch="timeout">Тайм-аут</button>
      </div>}
    </div>
  );
}

/** The manager's unit on the ice (forwards and the defence pair); it lights up for a moment when a new one goes out. */
export function LineChip({ line, touchUI }: { line: string; touchUI: boolean }) {
  // shown once it has held for a moment (a change on the fly passes through mixed units for a second)
  const [shown, setShown] = useState(line);
  const [fresh, setFresh] = useState(0);
  useEffect(() => {
    if (line === shown) return;
    const t = window.setTimeout(() => { setShown(line); setFresh((n) => n + 1); }, line === 'смешанный состав' ? 1600 : 500);
    return () => window.clearTimeout(t);
  }, [line, shown]);
  if (!shown) return null;
  return (
    <div key={fresh} className={cn('rounded-sm px-2 py-0.5 text-[10px] text-white flex items-center gap-1.5', touchUI ? 'bg-black/25 [text-shadow:0_1px_2px_rgba(0,0,0,.85)]' : 'bg-black/55', fresh > 0 && 'fade-in')} data-play-line={shown}>
      <span className="text-white/60 uppercase tracking-wide">На льду</span><b className={cn('font-semibold', fresh > 0 ? 'text-ice' : '')}>{shown}</b>
    </div>
  );
}
