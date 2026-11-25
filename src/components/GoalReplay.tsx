import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GameEvent, Player, Team } from '../types';
import { buildReplayClip, clamp, type ReplayClip } from '../game/rinkPlayback';
import { CAMERAS, QUALITY_LABEL, ReplayScene, resolveReplayQuality, VIEW_LABEL, viewFor, ZOOM, type ReplayCamera, type ReplayQuality } from './ReplayScene';
import { canExportMp4, exportReplayMp4, saveVideo, videoFileName, type ExportGraphics, type ReplayFrameSource } from './replayExport';
import { REPLAY_SPEEDS, setSettings, useSettings } from '../game/settings';
import { Button, Icon, TeamLogo, useClosing } from './ui';
import { exitFullscreen, fullscreenElement, useFullscreen } from '../fullscreen';
import { broadcastFor, clockAt, fmtGameClock, ppClockAt, STRENGTH_TEXT, STRENGTH_TITLE, type Broadcast, type BroadcastStrength } from './replayBroadcast';
import { LG } from '../brand';

/** Finished videos of this session: downloading the same replay with the same options again is instant. */
const videoCache = new Map<string, { blob: Blob; name: string; note: string }>();
const rememberVideo = (key: string, v: { blob: Blob; name: string; note: string }) => {
  videoCache.delete(key); videoCache.set(key, v);
  while (videoCache.size > 4) videoCache.delete(videoCache.keys().next().value as string);
};
const fmtSeconds = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} мин ${Math.round(s % 60)} с` : `${Math.max(1, Math.round(s))} с`);

/** «→ where» for the apps (a file path / the shared folder); the browser's own download bar says it already. */
const savedTo = (where: string) => (where === 'загрузки браузера' ? '' : ` → ${where}`);

/** KHL-style TV graphics over the replay: score bug with the running game clock, «ПОВТОР» tag, goal lower third. */
function BroadcastGraphics({ b, clip, time, home, away, scorer, number, assists, big, flat }: {
  b: Broadcast; clip: ReplayClip; time: number; home: Team; away: Team; scorer?: string; number?: number; assists?: string; big: boolean; flat: boolean;
}) {
  const goal = time >= clip.goal;
  const score = goal ? b.after : b.before;
  const side = (team: Team, ti: 0 | 1) => {
    const st: BroadcastStrength = b.strength[ti];
    const pc = st && st !== 'en' ? ppClockAt(b, clip, time) : '';
    return <div className="flex items-stretch" data-bug-team={ti}>
      <span className="w-1 sm:w-1.5 shrink-0" style={{ background: team.primaryColor }} />
      <span className={`px-1.5 sm:px-2.5 flex items-center font-display uppercase tracking-wide ${big ? 'sm:text-xl' : 'sm:text-base'}`}>{(team.short || team.name).toUpperCase()}</span>
      {st && <span className="px-1 sm:px-1.5 flex items-center bg-[#f5b942] text-[#0a1424] font-bold text-[8px] sm:text-[10px] tracking-wide" title={STRENGTH_TITLE[st]} data-bug-strength={st}>{STRENGTH_TEXT[st]}{pc && <span className="ml-1 tabular font-semibold" data-bug-pp-clock>{pc}</span>}</span>}
      <span key={`${ti}-${score[ti]}`} className={`min-w-[1.6em] px-1 sm:px-1.5 flex items-center justify-center font-display tabular bg-white ${big ? 'sm:text-2xl' : 'sm:text-lg'} ${goal && b.after[ti] !== b.before[ti] ? 'score-tick text-[#d8314b]' : 'text-[#0a1424]'}`} data-bug-score={ti}>{score[ti]}</span>
    </div>;
  };
  return <div className="absolute inset-0 pointer-events-none select-none text-white" data-broadcast>
    {/* Score bug, top left. */}
    <div className={`absolute top-2 left-2 sm:top-3 sm:left-3 flex items-stretch h-6 ${big ? 'sm:h-10' : 'sm:h-8'} text-xs rounded-sm overflow-hidden shadow-lg shadow-black/40 bg-[#0a1a33]/95 ring-1 ring-white/10`} data-score-bug>
      <span className="px-1.5 sm:px-2 flex items-center bg-gradient-to-b from-[#1f5fbf] to-[#123a78] font-display font-bold tracking-wider text-[10px] sm:text-sm">{LG()}</span>
      {side(home, 0)}
      <span className="w-px bg-white/15" />
      {side(away, 1)}
      <span className="px-1.5 sm:px-2.5 flex items-center gap-1.5 sm:gap-2 bg-[#06101f] font-display tabular">
        <span className="text-white/70 text-[10px] sm:text-sm">{b.period === 'ОТ' ? 'ОТ' : `${b.period}-й`}</span>
        <span className={`${big ? 'sm:text-xl' : 'sm:text-base'} min-w-[2.6em] text-right`} data-replay-clock>{fmtGameClock(clockAt(b, clip, time))}</span>
      </span>
    </div>
    {/* Replay tag, top right. */}
    <div className={`absolute top-2 sm:top-3 flex items-stretch h-5 sm:h-7 text-[9px] sm:text-xs rounded-sm overflow-hidden shadow-lg shadow-black/40 ${big ? 'right-12 sm:right-14' : 'right-2 sm:right-3'}`} data-replay-tag>
      <span className="px-1.5 sm:px-2.5 flex items-center gap-1.5 bg-[#d8314b] font-display font-bold tracking-[.2em]"><span className="w-1.5 h-1.5 rounded-full bg-white" />ПОВТОР</span>
      <span className="hidden min-[480px]:flex px-1.5 sm:px-2.5 items-center bg-[#0a1a33]/90 uppercase tracking-wide">{clip.label}</span>
    </div>
    {/* Lower third once the puck is in. */}
    {goal && <div className={`absolute left-2 sm:left-4 right-2 flex items-stretch slide-in ${flat ? 'bottom-7 sm:bottom-8' : 'bottom-2 sm:bottom-4'}`} data-goal-lower-third>
      <span className={`px-2.5 sm:px-5 flex items-center bg-[#d8314b] font-display font-bold tracking-widest rounded-l-sm text-lg ${big ? 'sm:text-4xl' : 'sm:text-3xl'}`}>ГОЛ!</span>
      {scorer && <div className="min-w-0 px-2.5 sm:px-4 py-1 sm:py-1.5 bg-[#0a1a33]/95 rounded-r-sm flex flex-col justify-center border-l-4" style={{ borderColor: (b.after[0] !== b.before[0] ? home : away).primaryColor }}>
        <div className={`font-display uppercase tracking-wide leading-tight truncate text-sm ${big ? 'sm:text-2xl' : 'sm:text-xl'}`}>{number ? <span className="text-[#f5b942] mr-1.5 tabular">#{number}</span> : null}{scorer}</div>
        {assists && <div className="text-[10px] sm:text-xs text-[#9fb6c4] truncate">{assists}</div>}
      </div>}
    </div>}
  </div>;
}

export function GoalReplay({ event, events, home, away, players, onClose, motionClip, closeLabel = 'Продолжить матч' }: {
  event: GameEvent; home: Team; away: Team; players: Record<string, Player>; onClose: () => void; motionClip?: ReplayClip;
  /** the game's play-by-play (the penalty clock of the score bug); optional */
  events?: GameEvent[];
  /** label of the button that closes the replay (the match goes on / back to the report) */
  closeLabel?: string;
}) {
  const clip = useMemo(() => motionClip ?? buildReplayClip(event, home, away, players), [motionClip, event, home, away, players]);
  const reduced = useRef(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches).current;
  const [time, setTime] = useState(reduced ? .8 : 0);
  // Seeks (slider, restart) are numbered: a progress report from the render loop that was already in flight
  // when the viewer seeked must not undo the seek.
  const [seek, setSeek] = useState({ time: reduced ? .8 : 0, id: 0 });
  const seekId = useRef(0);
  const seekTo = (t: number) => { seekId.current += 1; setSeek({ time: t, id: seekId.current }); setTime(t); };
  const onTime = useCallback((t: number, id: number) => { if (id === seekId.current) setTime(t); }, []);
  const settings = useSettings();
  const flat = !settings.replay3d;
  const [playing, setPlaying] = useState(!reduced);
  const [speed, setSpeed] = useState(settings.replaySpeed);
  // The game directs the replay itself unless the viewer picks a camera (the default camera is a setting).
  const [camera, setCamera] = useState<ReplayCamera>(settings.replayCamera);
  const [zoom, setZoom] = useState(1);
  const quality = resolveReplayQuality(settings.replayQuality);
  const setQuality = (q: ReplayQuality) => setSettings({ replayQuality: q });
  // The 3D picture shows up once its shaders are compiled; the clock waits for it, so the start is never missed.
  const [ready3d, setReady3d] = useState(false);
  const running = playing && (flat || ready3d);
  // MP4 export: offline rendering through the scene's frame source; progress 0..1 while running.
  const exporter = useRef<ReplayFrameSource | null>(null);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [exportNote, setExportNote] = useState('');
  const [mp4, setMp4] = useState<boolean | null>(null);
  const videoHeight = settings.videoHeight;
  const setVideoHeight = (h: 720 | 1080) => setSettings({ videoHeight: h });
  const exportStart = useRef(0);
  const exportAbort = useRef<AbortController | null>(null);
  useEffect(() => { let live = true; canExportMp4().then(ok => { if (live) setMp4(ok); }, () => { if (live) setMp4(false); }); return () => { live = false; exportAbort.current?.abort(); }; }, []);
  const dialog = useRef<HTMLDivElement>(null);
  // Fullscreen: the real Fullscreen API where it exists; iPhone Safari (no element fullscreen) fills the viewport instead.
  const box = useRef<HTMLDivElement>(null);
  const fs = useFullscreen(box);
  const [pseudo, setPseudo] = useState(false);
  const expanded = fs.active || pseudo;
  const toggleFs = useRef(() => {}); toggleFs.current = () => { if (fs.supported) void fs.toggle(); else setPseudo(p => !p); };
  const pseudoRef = useRef(pseudo); pseudoRef.current = pseudo;
  // Closing: the replay fades out first and only then reports back — the match stays frozen until it is gone.
  const [closing, startClosing] = useClosing();
  const finish = () => {
    if (box.current && fullscreenElement() === box.current) void exitFullscreen();
    setPlaying(false);
    startClosing(onClose);
  };
  const close = useRef(finish); close.current = finish;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.querySelector<HTMLButtonElement>('[aria-label="Закрыть повтор"]')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        // Esc first leaves fullscreen (the browser does that itself for the real API), a second Esc closes the replay.
        if (pseudoRef.current) setPseudo(false);
        else if (!fullscreenElement()) close.current();
      }
      if ((e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') && !(e.target as HTMLElement)?.closest('input, select')) { e.preventDefault(); e.stopPropagation(); toggleFs.current(); }
      if (e.key === ' ' && !(e.target as HTMLElement)?.closest('button, input, select')) { e.preventDefault(); e.stopPropagation(); setPlaying(p => !p); }
      if (e.key === 'Tab') {
        const nodes = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, [tabindex="0"]');
        if (!nodes?.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); document.body.style.overflow = overflow; previous?.focus({ preventScroll: true }); };
  }, []);
  // Playback itself runs inside ReplayScene (every display frame, no React re-render per frame); it reports here.
  useEffect(() => { if (time >= 1) setPlaying(false); }, [time]);
  const attack = event.team === home.id ? home : away;
  const broadcast = useMemo(() => broadcastFor(event, home.id, events), [event, home.id, events]);
  const scorerP = event.player ? players[event.player] : undefined;
  const assistNames = (event.players ?? []).map(id => players[id]?.name.trim().split(/\s+/).pop()).filter(Boolean);
  const runExport = async () => {
    const source = exporter.current;
    if (mp4 === false) { setExportNote('Этот браузер не умеет записывать видео (нужен Chrome, Edge, Яндекс Браузер, Safari 16.4+ или Firefox 130+).'); return; }
    if (!clip || exportProgress !== null) return;
    const options = { camera, height: videoHeight, fps: settings.videoFps, slowmo: settings.videoSlowmo, graphics: settings.videoGraphics, fast: settings.videoQuality === 'fast' };
    const key = [home.id, away.id, event.period, event.sec, event.player, event.score?.join(':'), JSON.stringify(options)].join('|');
    const cached = videoCache.get(key);
    if (cached) {
      setExportNote('');
      try { const where = await saveVideo(cached.blob, cached.name); setExportNote(where ? `${cached.note} · уже был готов, сохранён сразу${savedTo(where)}` : `${cached.note} · сохранение отменено`); } catch (e) { setExportNote(`Не удалось сохранить видео: ${(e as Error)?.message ?? e}`); }
      return;
    }
    if (!source) { setExportNote('3D-сцена ещё готовится — попробуйте через секунду.'); return; }
    setPlaying(false); setExportNote(''); setExportProgress(0); exportStart.current = performance.now();
    const controller = new AbortController(); exportAbort.current = controller;
    const after = (event.score ?? [0, 0]) as [number, number], side = event.team === home.id ? 0 : 1;
    const before: [number, number] = [after[0] - (side === 0 ? 1 : 0), after[1] - (side === 1 ? 1 : 0)];
    const scorer = event.player ? players[event.player] : undefined;
    const assists = (event.players ?? []).map(id => players[id]?.name.trim().split(/\s+/).pop()).filter(Boolean);
    const graphics: ExportGraphics = {
      label: clip.label, strength: event.strength ?? 'EV', period: event.period <= 3 ? `${event.period}-й период · ${event.time}` : `Овертайм · ${event.time}`,
      home: { short: (home.short || home.name).toUpperCase(), color: home.primaryColor }, away: { short: (away.short || away.name).toUpperCase(), color: away.primaryColor },
      before: [Math.max(0, before[0]), Math.max(0, before[1])], after,
      scorer: scorer ? `${scorer.name}${scorer.number ? ` · #${scorer.number}` : ''}` : undefined,
      assists: assists.length ? `Передачи: ${assists.join(', ')}` : undefined,
      broadcast,
    };
    try {
      const result = await exportReplayMp4({ source, clip, camera, graphics: options.graphics ? graphics : null, height: videoHeight, fps: options.fps, slowmo: options.slowmo, fast: options.fast, signal: controller.signal, onProgress: p => setExportProgress(p) });
      const name = videoFileName(['Gol', scorer?.name.trim().split(/\s+/).pop() ?? '', after.join('-'), `${graphics.home.short}-${graphics.away.short}`]);
      const took = (performance.now() - exportStart.current) / 1000;
      const note = `MP4 готов: ${(result.blob.size / 1048576).toFixed(1)} МБ · ${Math.round(result.seconds)} с видео · ${result.codec} · ${videoHeight}p${options.fps} · за ${fmtSeconds(took)}`;
      rememberVideo(key, { blob: result.blob, name, note });
      const where = await saveVideo(result.blob, name);
      setExportNote(where ? `${note}${savedTo(where)}` : `${note} · сохранение отменено (можно скачать снова — сразу)`);
    } catch (e) {
      setExportNote((e as DOMException)?.name === 'AbortError' ? 'Экспорт отменён' : `Не удалось сохранить видео: ${(e as Error)?.message ?? e}`);
    } finally { exportAbort.current = null; setExportProgress(null); }
  };
  // Portalled to <body>: a transformed/animated ancestor would otherwise become the containing block of this
  // `position: fixed` layer and push the replay down the page instead of centring it in the viewport.
  const overlay = <div className={`fixed inset-0 z-[70] bg-[#040a14]/95 backdrop-blur flex items-center justify-center ${expanded ? 'p-0' : 'p-0 sm:p-4'} ${closing ? 'fade-out pointer-events-none' : ''}`} role="dialog" aria-modal="true" aria-label="3D-повтор гола" ref={dialog} data-goal-replay data-closing={closing || undefined}>
    <div ref={box} data-replay-box data-expanded={expanded || undefined} className={(closing ? 'pop-out ' : '') + (expanded ? 'w-screen h-[100dvh] max-w-none flex flex-col overflow-hidden bg-[#0c1929] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)]' : 'w-full max-w-5xl max-h-[100dvh] flex flex-col overflow-hidden sm:rounded-xl border-white/15 sm:border bg-[#0c1929] shadow-2xl')}>
      <div className={`${expanded ? 'hidden' : 'flex'} items-center gap-3 px-3 py-1.5 sm:py-2.5 border-b border-white/10 shrink-0`}>
        <TeamLogo team={attack} size={28} /><div className="min-w-0"><div className="text-[10px] uppercase tracking-[.2em] text-ice">Голевой эпизод · {flat ? '2D' : '3D'}</div><div className="font-semibold text-sm truncate">{event.player ? players[event.player]?.name ?? 'Автор гола' : 'Автор гола'} <span className="text-muted ml-2">{event.score?.join(' : ')}</span></div></div>
        <button onClick={finish} className="ml-auto px-2 text-2xl leading-none text-white/70 hover:text-white" aria-label="Закрыть повтор">×</button>
      </div>
      {clip ? <>
        <div className={`relative bg-[#081421] overflow-hidden ${expanded ? 'flex-1 min-h-0' : 'shrink min-h-[140px]'}`} data-replay-stage style={expanded ? undefined : { height: 'min(56.25vw, 560px)' }}>
          <ReplayScene clip={clip} time={seek.time} seek={seek.id} quality={quality} flat={flat} onReady={setReady3d} exporter={exporter} camera={camera} home={home} away={away} players={players} playing={running} speed={speed} zoom={zoom} onTime={onTime} onZoom={setZoom} overlay={<>
          {camera === 'auto' && <div className={`absolute left-2 sm:left-3 pointer-events-none text-[10px] uppercase tracking-widest text-white/80 ${expanded ? 'top-10 sm:top-16' : 'top-10 sm:top-14'}`}><span className="rounded px-1.5 py-0.5 bg-black/50" data-replay-auto-view>Авто · {VIEW_LABEL[viewFor('auto', clip, time)]}</span></div>}
          <div className={`absolute right-2 sm:right-3 flex flex-col gap-1 ${expanded ? 'top-12 sm:top-14' : 'top-9 sm:top-12'}`}>
            <button type="button" aria-label="Приблизить" title="Приблизить (колесо мыши / щипок)" disabled={zoom <= ZOOM.min + 1e-6} onClick={() => setZoom(z => Math.max(ZOOM.min, z / 1.25))} className="w-7 h-7 rounded bg-black/55 text-white text-base leading-none disabled:opacity-40">+</button>
            <button type="button" aria-label="Отдалить" title="Отдалить" disabled={zoom >= ZOOM.max - 1e-6} onClick={() => setZoom(z => Math.min(ZOOM.max, z * 1.25))} className="w-7 h-7 rounded bg-black/55 text-white text-base leading-none disabled:opacity-40">−</button>
            <button type="button" aria-label="Скачать видео MP4" title="Скачать повтор видеофайлом MP4" data-replay-export-quick disabled={exportProgress !== null || !ready3d} onClick={() => void runExport()} className="mt-2 w-7 h-7 rounded bg-[#d8314b]/85 hover:bg-[#d8314b] text-white text-sm leading-none disabled:opacity-40">⤓</button>
          </div>
          {/* Fullscreen hides the header: the replay keeps a close button of its own (phones above all). */}
          {expanded && <button type="button" onClick={finish} aria-label="Закрыть повтор" data-replay-close-fs className="absolute top-2 right-2 sm:top-3 sm:right-3 w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-black/60 hover:bg-black/80 text-white text-2xl leading-none flex items-center justify-center ring-1 ring-white/20">×</button>}</>} />
          {!flat && !ready3d && <div className="absolute inset-0 z-[5] flex items-center justify-center bg-[#081421] pointer-events-none" data-replay-preparing>
            <div className="flex items-center gap-2 text-xs text-white/80"><span className="w-4 h-4 border-2 border-white/20 border-t-sky-300 rounded-full animate-spin" />Подготовка 3D-повтора…</div>
          </div>}
          <BroadcastGraphics b={broadcast} clip={clip} time={time} home={home} away={away} scorer={scorerP?.name} number={scorerP?.number} assists={assistNames.length ? `Передачи: ${assistNames.join(', ')}` : event.player ? 'Без передач' : undefined} big={expanded} flat={flat} />
          {exportProgress !== null && <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/45" data-export-progress={Math.round(exportProgress * 100)}>
            <div className="w-[min(320px,80%)] rounded-lg bg-[#0c1929]/95 border border-white/15 p-3 text-xs text-white">
              <div className="flex justify-between mb-2"><span>Экспорт MP4… {settings.videoHeight}p{settings.videoFps}{settings.videoQuality === 'fast' ? ' · быстрый' : ''}</span><span className="tabular">{Math.round(exportProgress * 100)}%</span></div>
              <div className="h-1.5 rounded bg-white/10 overflow-hidden"><div className="h-full bg-sky-300" style={{ width: `${exportProgress * 100}%` }} /></div>
              <div className="mt-2 flex justify-between items-center"><button type="button" className="text-muted hover:text-white" onClick={() => exportAbort.current?.abort()}>Отменить</button>
                {exportProgress > .04 && <span className="text-muted tabular" data-export-eta>осталось ~{fmtSeconds(((performance.now() - exportStart.current) / 1000) * (1 - exportProgress) / exportProgress)}</span>}</div>
            </div>
          </div>}
        </div>
        <div className="px-3 py-1.5 sm:py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 shrink-0">
          <div className="flex items-center gap-2 text-xs flex-1 min-w-[180px]"><span className="tabular text-muted w-[4.5rem] shrink-0 whitespace-nowrap">{(time * clip.duration).toFixed(1)} / {clip.duration.toFixed(1)} c</span><input className="flex-1 min-w-0 accent-sky-300" type="range" min="0" max="1000" step="1" value={Math.round(time * 1000)} aria-label="Позиция повтора" onChange={e => { setPlaying(false); seekTo(clamp(Number(e.target.value) / 1000, 0, 1)); }} /></div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" onClick={() => { if (time >= 1) seekTo(0); setPlaying(p => !p); }}>{playing ? 'Пауза повтора' : 'Воспроизвести'}</Button>
            <Button size="sm" onClick={() => { seekTo(0); setPlaying(true); }}>↻ Повторить</Button>
            <label className="text-xs text-muted">Скорость <select aria-label="Скорость повтора" value={speed} onChange={e => setSpeed(Number(e.target.value))} className="bg-[#15283d] rounded p-1 text-white">{REPLAY_SPEEDS.map(v => <option key={v} value={v}>×{v}</option>)}</select></label>
            <div className="flex rounded border border-line overflow-hidden text-xs" role="group" aria-label="Режим повтора">
              {([[true, '3D'], [false, '2D']] as const).map(([on, text]) => <button key={text} type="button" aria-pressed={settings.replay3d === on} data-replay-mode={text} disabled={exportProgress !== null} title={on ? 'Объёмный повтор' : 'Лёгкий повтор на схеме площадки'} onClick={() => setSettings({ replay3d: on })} className={`px-2 py-1 ${settings.replay3d === on ? 'bg-ice text-bg' : 'text-muted hover:text-white'}`}>{text}</button>)}
            </div>
            {!flat && <>
              <div className="flex flex-wrap gap-1" role="group" aria-label="Камера">{CAMERAS.map(([id, text]) => <button key={id} aria-pressed={camera === id} className={`px-2 py-1 text-xs rounded border ${camera === id ? 'bg-ice text-bg border-ice' : 'border-line text-muted'}`} onClick={() => setCamera(id)}>{text}</button>)}</div>
              <label className="text-xs text-muted">Качество <select aria-label="Качество картинки" value={quality} onChange={e => setQuality(e.target.value as ReplayQuality)} className="bg-[#15283d] rounded p-1 text-white" disabled={exportProgress !== null}>{(Object.keys(QUALITY_LABEL) as ReplayQuality[]).map(q => <option key={q} value={q}>{QUALITY_LABEL[q]}</option>)}</select></label>
              <button type="button" onClick={() => void runExport()} disabled={mp4 === null || exportProgress !== null || !ready3d} data-replay-export title={`Сохранить повтор как видео MP4${settings.videoGraphics ? ' с графикой' : ''}${settings.videoSlowmo ? ' и замедленным повтором' : ''} (параметры — в настройках)`} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded bg-[#d8314b] hover:bg-[#e8445d] text-white disabled:opacity-50">⤓ Скачать видео</button>
              {mp4 && <select aria-label="Разрешение видео" value={videoHeight} onChange={e => setVideoHeight(Number(e.target.value) === 720 ? 720 : 1080)} disabled={exportProgress !== null} className="bg-[#15283d] rounded p-1 text-xs text-white"><option value={1080}>1080p</option><option value={720}>720p</option></select>}
            </>}
            <button type="button" onClick={() => toggleFs.current()} aria-pressed={expanded} data-replay-fullscreen title={expanded ? 'Свернуть (Esc)' : 'Во весь экран (F)'} aria-label={expanded ? 'Свернуть повтор' : 'Повтор во весь экран'} className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded border ${expanded ? 'bg-ice text-bg border-ice' : 'border-line text-muted hover:text-white'}`}><Icon name={expanded ? 'shrink' : 'expand'} /><span className="hidden sm:inline">{expanded ? 'Свернуть' : 'Во весь экран'}</span></button>
            {expanded && <Button size="sm" variant="primary" onClick={finish} data-replay-continue>{closeLabel}</Button>}
          </div>
          {exportNote && <div className="w-full text-[11px] text-muted" role="status" data-export-note>{exportNote}</div>}
        </div>
      </> : <div className="p-6 text-muted">Недостаточно данных для реконструкции эпизода.</div>}
      <div className={`${expanded && clip ? 'hidden' : 'flex'} gap-3 justify-between items-center px-3 py-1.5 border-t border-white/10 shrink-0`}><p className="text-[11px] min-w-0 flex-1 truncate" title={event.text}>{event.text}</p><Button size="sm" variant="primary" onClick={finish}>{closeLabel}</Button></div>
    </div>
  </div>;
  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body);
}
