import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GameEvent, Player, Team } from '../types';
import { buildReplayClip, clamp, type ReplayClip } from '../game/rinkPlayback';
import { ReplayScene, type ReplayCamera } from './ReplayScene';
import { Button, Icon, TeamLogo } from './ui';
import { exitFullscreen, fullscreenElement, useFullscreen } from '../fullscreen';

export function GoalReplay({ event, home, away, players, onClose, motionClip }: {
  event: GameEvent; home: Team; away: Team; players: Record<string, Player>; onClose: () => void; motionClip?: ReplayClip;
}) {
  const clip = useMemo(() => motionClip ?? buildReplayClip(event, home, away, players), [motionClip, event, home, away, players]);
  const reduced = useRef(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches).current;
  const [time, setTime] = useState(reduced ? .8 : 0);
  const [playing, setPlaying] = useState(!reduced);
  const [speed, setSpeed] = useState(1);
  const [camera, setCamera] = useState<ReplayCamera>('broadcast');
  const dialog = useRef<HTMLDivElement>(null);
  // Fullscreen: the real Fullscreen API where it exists; iPhone Safari (no element fullscreen) fills the viewport instead.
  const box = useRef<HTMLDivElement>(null);
  const fs = useFullscreen(box);
  const [pseudo, setPseudo] = useState(false);
  const expanded = fs.active || pseudo;
  const toggleFs = useRef(() => {}); toggleFs.current = () => { if (fs.supported) void fs.toggle(); else setPseudo(p => !p); };
  const pseudoRef = useRef(pseudo); pseudoRef.current = pseudo;
  const finish = () => { if (box.current && fullscreenElement() === box.current) void exitFullscreen(); onClose(); };
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
    return () => { document.removeEventListener('keydown', key, true); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  useEffect(() => {
    if (!playing || !clip) return;
    let raf = 0, last = performance.now(), accumulated = 0;
    const tick = (now: number) => {
      accumulated += Math.min(.1, (now - last) / 1000); last = now;
      if (accumulated >= 1 / 30) { const delta = accumulated * speed / clip.duration; accumulated = 0; setTime(t => Math.min(1, t + delta)); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, clip, speed]);
  useEffect(() => { if (time >= 1) setPlaying(false); }, [time]);
  const attack = event.team === home.id ? home : away;
  // Portalled to <body>: a transformed/animated ancestor would otherwise become the containing block of this
  // `position: fixed` layer and push the replay down the page instead of centring it in the viewport.
  const overlay = <div className={`fixed inset-0 z-[70] bg-[#040a14]/95 backdrop-blur flex items-center justify-center ${expanded ? 'p-0' : 'p-0 sm:p-4'}`} role="dialog" aria-modal="true" aria-label="3D-повтор гола" ref={dialog} data-goal-replay>
    <div ref={box} data-replay-box data-expanded={expanded || undefined} className={expanded ? 'w-screen h-[100dvh] max-w-none flex flex-col overflow-hidden bg-[#0c1929] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)]' : 'w-full max-w-5xl max-h-[100dvh] flex flex-col overflow-hidden sm:rounded-xl border-white/15 sm:border bg-[#0c1929] shadow-2xl'}>
      <div className={`${expanded ? 'hidden' : 'flex'} items-center gap-3 px-3 py-1.5 sm:py-2.5 border-b border-white/10 shrink-0`}>
        <TeamLogo team={attack} size={28} /><div className="min-w-0"><div className="text-[10px] uppercase tracking-[.2em] text-ice">Голевой эпизод · 3D</div><div className="font-semibold text-sm truncate">{event.player ? players[event.player]?.name ?? 'Автор гола' : 'Автор гола'} <span className="text-muted ml-2">{event.score?.join(' : ')}</span></div></div>
        <button onClick={finish} className="ml-auto px-2 text-2xl leading-none text-white/70 hover:text-white" aria-label="Закрыть повтор">×</button>
      </div>
      {clip ? <>
        <div className={`relative bg-[#081421] overflow-hidden ${expanded ? 'flex-1 min-h-0' : 'shrink-0'}`} data-replay-stage style={expanded ? undefined : { height: 'max(150px, min(56.25vw, calc(100dvh - 142px), 560px))' }}>
          <ReplayScene clip={clip} time={time} camera={camera} home={home} away={away} players={players} />
          <div className="absolute top-3 left-3 right-3 pointer-events-none flex justify-between gap-3 text-[11px] text-white"><span className="rounded px-2 py-1 bg-black/60">{clip.label}</span><span className="rounded px-2 py-1 bg-black/60">{expanded && <b className="mr-1.5">{event.player ? players[event.player]?.name ?? '' : ''} {event.score?.join(':')} ·</b>}{event.period <= 3 ? `${event.period}-й период` : 'Овертайм'} · {event.time} · {event.strength ?? 'EV'}</span></div>
          {time >= clip.goal && <div className="absolute bottom-4 inset-x-0 text-center pointer-events-none"><span className="inline-block px-5 py-1 bg-[#d8314b]/90 text-white font-display text-3xl tracking-widest rounded">ГОЛ</span></div>}
        </div>
        <div className="px-3 py-1.5 sm:py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 shrink-0">
          <div className="flex items-center gap-2 text-xs flex-1 min-w-[180px]"><span className="tabular text-muted w-[4.5rem] shrink-0 whitespace-nowrap">{(time * clip.duration).toFixed(1)} / {clip.duration.toFixed(1)} c</span><input className="flex-1 min-w-0 accent-sky-300" type="range" min="0" max="1000" step="1" value={Math.round(time * 1000)} aria-label="Позиция повтора" onChange={e => { setPlaying(false); setTime(clamp(Number(e.target.value) / 1000, 0, 1)); }} /></div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" onClick={() => { if (time >= 1) setTime(0); setPlaying(p => !p); }}>{playing ? 'Пауза повтора' : 'Воспроизвести'}</Button>
            <Button size="sm" onClick={() => { setTime(0); setPlaying(true); }}>↻ Повторить</Button>
            <label className="text-xs text-muted">Скорость <select aria-label="Скорость повтора" value={speed} onChange={e => setSpeed(Number(e.target.value))} className="bg-[#15283d] rounded p-1 text-white">{[.25, .5, .75, 1, 1.5, 2].map(v => <option key={v} value={v}>×{v}</option>)}</select></label>
            <div className="flex gap-1">{([['broadcast', 'ТВ'], ['ice', 'Со льда'], ['net', 'У ворот']] as const).map(([id, text]) => <button key={id} aria-pressed={camera === id} className={`px-2 py-1 text-xs rounded border ${camera === id ? 'bg-ice text-bg border-ice' : 'border-line text-muted'}`} onClick={() => setCamera(id)}>{text}</button>)}</div>
            <button type="button" onClick={() => toggleFs.current()} aria-pressed={expanded} data-replay-fullscreen title={expanded ? 'Свернуть (Esc)' : 'Во весь экран (F)'} aria-label={expanded ? 'Свернуть повтор' : 'Повтор во весь экран'} className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded border ${expanded ? 'bg-ice text-bg border-ice' : 'border-line text-muted hover:text-white'}`}><Icon name={expanded ? 'shrink' : 'expand'} /><span className="hidden sm:inline">{expanded ? 'Свернуть' : 'Во весь экран'}</span></button>
            {expanded && <Button size="sm" variant="primary" onClick={finish} data-replay-continue>Продолжить матч</Button>}
          </div>
        </div>
      </> : <div className="p-6 text-muted">Недостаточно данных для реконструкции эпизода.</div>}
      <div className={`${expanded && clip ? 'hidden' : 'flex'} gap-3 justify-between items-center px-3 py-1.5 border-t border-white/10 shrink-0`}><p className="text-[11px] min-w-0 flex-1 truncate" title={event.text}>{event.text}</p><Button size="sm" variant="primary" onClick={finish}>Продолжить матч</Button></div>
    </div>
  </div>;
  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body);
}
