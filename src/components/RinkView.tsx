import { useEffect, useId, useRef, useState } from 'react';
import type { GameEvent, Player, Team } from '../types';
import { clipFrame, liveRinkFrame, type LiveFrame } from '../game/rinkPlayback';
import type { LiveSource } from './liveMotion';
import { FACEOFF_SPOTS, RINK } from '../game/rinkGeometry';
import { cn } from '../utils/cn';
import { LG } from '../brand';
import { setSettings, useSettings } from '../game/settings';
import { LIVE_CAMERAS } from './replayCameras';
import type { FigureRequest } from './replayCache';
import { resolveReplayQuality } from './ReplayScene';
import { LiveScene3D } from './LiveScene3D';
import type { OutroSpec } from './matchOutro';
import { crewFor } from './officialCrew';
import { useMatchSound } from './sound/useMatchSound';

export { clipFrame };
/** Static ice markings in real IIHF/KHL proportions (viewBox 100 × 50 = 60 × 30 m, 1 m = 5/3 units). */
const U = 100 / RINK.length;
const BLUE_X = [RINK.blueLine * U, 100 - RINK.blueLine * U];
const GOAL_X = [RINK.goalLine * U, 100 - RINK.goalLine * U];
const END_DOTS = FACEOFF_SPOTS.end.map(d => ({ x: d.x * U, y: d.y * U }));
const NEUTRAL_DOTS = FACEOFF_SPOTS.neutral.map(d => ({ x: d.x * U, y: d.y * U }));
const CIRCLE_R = RINK.circleR * U, DOT_R = RINK.dotR * U, CREASE_R = RINK.crease * U, NET_W = RINK.goalWidth * U, NET_D = RINK.goalDepth * U;
function RinkMarkings() {
  const clip = useId().replace(/:/g, '');
  return <>
    <defs><clipPath id={`rink-${clip}`}><rect x=".7" y=".7" width="98.6" height="48.6" rx={RINK.corner * U} /></clipPath></defs>
    <rect x=".7" y=".7" width="98.6" height="48.6" rx={RINK.corner * U} fill="#e5f0f4" stroke="#95b1c3" strokeWidth="1.2" />
    <g clipPath={`url(#rink-${clip})`} data-rink-markings>
      {GOAL_X.map(x => <path key={x} d={`M ${x} 0 V 50`} stroke="#db5066" strokeWidth={RINK.lineWidth * U * 2} />)}
      {BLUE_X.map(x => <path key={x} d={`M ${x} 0 V 50`} stroke="#4076b7" strokeWidth={RINK.blueWidth * U} data-rink-blue={x.toFixed(2)} />)}
      <path d="M 50 0 V 50" stroke="#db5066" strokeWidth={RINK.redWidth * U} strokeDasharray="1.4 .5" />
      <circle cx="50" cy="25" r={CIRCLE_R} stroke="#4076b7" fill="none" strokeWidth=".2" />
      <circle cx="50" cy="25" r={DOT_R * .5} fill="#4076b7" />
      {END_DOTS.map(d => <g key={`${d.x}-${d.y}`} stroke="#dc6070" fill="none" strokeWidth=".2" data-rink-circle>
        <circle cx={d.x} cy={d.y} r={CIRCLE_R} />
        <circle cx={d.x} cy={d.y} r={DOT_R} fill="#dc6070" stroke="none" />
        {[-1, 1].map(sy => [-1, 1].map(sx => <path key={`${sx}${sy}`} d={`M ${d.x + sx * .95} ${d.y + sy * (CIRCLE_R - .1)} V ${d.y + sy * (CIRCLE_R + 1)}`} />))}
        {[-1, 1].map(sx => <path key={sx} d={`M ${d.x + sx * 1.1} ${d.y - .5} H ${d.x + sx * 2.1} M ${d.x + sx * 1.1} ${d.y + .5} H ${d.x + sx * 2.1}`} />)}
      </g>)}
      {NEUTRAL_DOTS.map(d => <circle key={`${d.x}-${d.y}`} cx={d.x} cy={d.y} r={DOT_R} fill="#dc6070" data-rink-neutral-dot />)}
      {GOAL_X.map((x, i) => { const s = i ? -1 : 1; return <g key={x}>
        <path d={`M ${x} ${25 - CREASE_R} A ${CREASE_R} ${CREASE_R} 0 0 ${i ? 0 : 1} ${x} ${25 + CREASE_R} Z`} fill="#6db9df66" stroke="#db5066" strokeWidth=".12" />
        <rect x={s > 0 ? x - NET_D : x} y={25 - NET_W / 2} width={NET_D} height={NET_W} rx=".5" fill="#beced9" stroke="#ce3d51" strokeWidth=".3" />
      </g>; })}
    </g>
    <text x="50" y="26" textAnchor="middle" fontSize="2" fill="#7c9cac" fontFamily="sans-serif">{LG()}</text>
  </>;
}
/** An official on the 2D rink: rink percent, a referee (orange armband) or a linesman, and whether he is signalling. */
export type RinkOfficial = { x: number; y: number; ref: boolean; signal: boolean; heading: number };
const officialLabel = (o: RinkOfficial) => (o.ref ? 'Главный судья' : 'Линейный судья');
export function RinkSvg({ frame, home, away, players, aim, officials }: { frame: LiveFrame; home: Team; away: Team; players: Record<string, Player>; aim?: { x: number; y: number; charge: number } | null; officials?: readonly RinkOfficial[] }) {
  return <svg viewBox="0 0 100 50" className="w-full h-full" role="img" aria-label="Площадка сверху: хоккеисты и шайба" data-rink-svg>
    <RinkMarkings />
    {frame.skaters.map(p => <g key={`${p.side}-${p.id}`} transform={`translate(${p.pos.x} ${p.pos.y / 2})`} data-rink-player={p.id}>
      <title>{players[p.id]?.name ?? p.id}{p.goalie ? ' · вратарь' : ''}</title>
      <ellipse cy=".5" rx="1.65" ry="1" fill="#233a4b30" />
      {frame.carrier === p.id && !p.goalie && <g data-rink-carrier><circle r="3.1" fill="#2ee6ff2e" stroke="#2ee6ff" strokeWidth=".55" /><circle r="3.1" fill="none" stroke="#06283a" strokeWidth=".15" strokeDasharray=".9 .7" /></g>}
      {p.ctrl && <g data-rink-ctrl><circle r="2.5" fill="#ffd23f33" stroke="#ffd23f" strokeWidth=".45" /><path d="M -1 -4.2 H 1 L 0 -2.9 Z" fill="#ffd23f" /></g>}
      {(p.fall ?? 0) > .3 && <path d="M -1.6 -1.6 L 1.6 1.6 M 1.6 -1.6 L -1.6 1.6" stroke="#e5323e" strokeWidth=".3" opacity={p.fall} />}
      {p.goalie ? <rect x="-1.4" y="-1" width="2.8" height="2" rx=".5" fill={p.side ? '#f7fafc' : home.primaryColor} stroke={p.side ? away.primaryColor : '#fff'} strokeWidth=".35" /> : <circle r="1.3" fill={p.side ? '#f7fafc' : home.primaryColor} stroke={p.side ? away.primaryColor : '#0b1726'} strokeWidth={p.side ? '.5' : '.35'} />}
      <text y=".4" textAnchor="middle" fontSize="1.2" fontWeight="bold" fill={p.side ? away.primaryColor : '#fff'} stroke={p.side ? '#fff' : '#000'} strokeWidth=".15" paintOrder="stroke" fontFamily="sans-serif">{players[p.id]?.number ?? ''}</text>
    </g>)}
    {officials?.map((o, i) => <g key={i} transform={`translate(${o.x} ${o.y / 2})`} aria-label={officialLabel(o)} data-rink-official={o.ref ? 'ref' : 'line'} data-rink-signal={o.signal || undefined}>
      <circle r="1" fill="#f4f6f8" stroke={o.ref ? '#ff6a1a' : '#202a34'} strokeWidth=".32" /><path d="M-.5 -.8 V.8 M0 -.95 V.95 M.5 -.8 V.8" stroke="#202a34" strokeWidth=".22" />
      {o.signal && <path d={`M0 0 L${(Math.cos(o.heading) * 2).toFixed(2)} ${(-Math.sin(o.heading) * 2).toFixed(2)}`} stroke="#ff6a1a" strokeWidth=".35" strokeLinecap="round" />}
    </g>)}
    {!officials && frame.faceoff && <g transform={frame.official ? `translate(${frame.official.x} ${frame.official.y / 2})` : `translate(${frame.puck.x + 1} ${frame.puck.y / 2 + 3})`} aria-label="Судья на вбрасывании" data-rink-official><circle r="1" fill="#202a34" /><path d="M-.6 -.7 V.7 M0 -.9 V.9 M.6 -.7 V.7" stroke="#fff" strokeWidth=".2" /></g>}
    <circle cx={frame.puck.x} cy={frame.puck.y / 2} r="1.2" fill="none" stroke="#e68c22" strokeWidth=".25" opacity=".7" />
    {aim && <g transform={`translate(${aim.x} ${aim.y / 2})`} data-rink-aim><circle r={0.8 + aim.charge * 0.5} fill="none" stroke={aim.charge > 0.6 ? '#ff3b30' : '#ffd23f'} strokeWidth=".3" /><circle r=".22" fill={aim.charge > 0.6 ? '#ff3b30' : '#ffd23f'} /></g>}
    <circle data-rink-puck cx={frame.puck.x} cy={frame.puck.y / 2 - frame.puck.h * 1.5} r=".5" fill="#0a1321" stroke="#fff" strokeWidth=".12" />
  </svg>;
}

export function LiveRink({ ticker, ids, goalies, event, home, away, players, running, ai = null, className, fill = false, roster, allow3d = true, bare = false, minimap = true, intro = false, replays, outro = null, onOutroEnd }: {
  ticker: { sec: number; tau?: number }; ids: [string[], string[]]; goalies: [string | null, string | null]; event: GameEvent | null;
  home: Team; away: Team; players: Record<string, Player>; running: boolean; ai?: LiveSource | null; className?: string; fill?: boolean;
  /** everyone who may come on the ice: the 3D view prepares their figures up front */
  roster?: FigureRequest[];
  /** false while something else uses the 3D renderer (a goal replay is open) */
  allow3d?: boolean;
  /** no caption bar above the ice (the played match has its own scoreboard; the 2D/3D switch moves onto the ice) */
  bare?: boolean;
  /** false: no 2D minimap over the 3D picture (the touch controls need the corner) */
  minimap?: boolean;
  /** the start of the match: the 3D picture shows the teams' entrance (if the settings want it) */
  intro?: boolean;
  /** the broadcast's replays of moments (they hold the clock): the settings' choice unless given (online: never — the other device would not wait) */
  replays?: boolean;
  /** the match is over: the 3D scene after the final siren (if the settings want it), then `onOutroEnd` — at once without it */
  outro?: OutroSpec | null;
  onOutroEnd?: () => void;
}) {
  const settings = useSettings();
  const [failed3d, setFailed3d] = useState(false);
  const [camOpen, setCamOpen] = useState(false);
  // The 3D match reads the same rink frames as the 2D picture; without the agent rink (or WebGL) it is 2D.
  const can3d = !!ai && !failed3d;
  const show3d = can3d && settings.matchView === '3d' && allow3d;
  const read = () => (ai ? ticker.tau ?? 0 : ticker.sec);
  // the scene after the siren needs the 3D picture: without it (or switched off) the match screen goes on at once
  const outroOn = !!outro && show3d && settings.matchOutro;
  const outroEnd = useRef(onOutroEnd); outroEnd.current = onOutroEnd;
  useEffect(() => { if (outro && !outroOn) outroEnd.current?.(); }, [outro, outroOn]);
  // (a safety net: the picture never got going — the final comes all the same)
  useEffect(() => { if (!outroOn) return; const id = window.setTimeout(() => outroEnd.current?.(), 150_000); return () => window.clearTimeout(id); }, [outroOn]);
  // the match's sound follows the same frames (only with the agent rink: the formation picture has no play)
  useMatchSound(ai, ticker, running);
  const [t, setT] = useState(read);
  const last = useRef(0);
  useEffect(() => {
    setT(read());
    if (!running) return;
    let raf = 0;
    const tick = (now: number) => {
      if (now - last.current > 33) { setT(read()); last.current = now; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, running, event, ai]);
  let frame: LiveFrame;
  if (ai) {
    const f = ai.frameAt(t);
    frame = { ...f, skaters: f.skaters.filter(p => !p.box) };
  } else {
    const source = liveRinkFrame(t, ids, goalies, null, home.id);
    // Goalie pulls/substitutions are revealed state, never simulator end-of-period state.
    frame = { ...source, skaters: source.skaters.filter(p => !p.goalie || goalies[p.side] !== null).map(p => p.goalie && goalies[p.side] ? { ...p, id: goalies[p.side]! } : p) };
  }
  const flipped = !!ai?.flipped;
  const state = outroOn ? 'Матч окончен' : frame.faceoff ? 'Вбрасывание · время стоит' : frame.stopped ? 'Свисток · время стоит' : running ? 'В игре' : 'Пауза';
  // the played match: the aim marker on the net, also in 2D
  const am = ai?.aimMarker?.() ?? null;
  const aim = am ? { x: am.x / RINK.length * 100 + 50, y: am.z / RINK.width * 100 + 50, charge: am.charge } : null;
  // the four officials (the same crew the 3D picture shows)
  const officials: RinkOfficial[] | undefined = ai ? crewFor(ai).update(frame, ai.plays, t).map(o => ({ x: o.x / RINK.length * 100 + 50, y: o.z / RINK.width * 100 + 50, ref: o.role === 'ref', signal: o.gesture !== 'none', heading: o.heading })) : undefined;
  const svg = <RinkSvg frame={frame} home={home} away={away} players={players} aim={aim} officials={officials} />;
  const soundButton = ai && <button type="button" aria-pressed={settings.sound} onClick={() => setSettings({ sound: !settings.sound })} title={settings.sound ? 'Выключить звук' : 'Включить звук'}
    className={cn('rounded-sm px-1.5 py-0.5 text-[10px] font-semibold backdrop-blur-sm', settings.sound ? 'bg-white/85 text-[#0b1726]' : 'bg-black/35 text-white/85 hover:bg-black/55')} data-live-sound-toggle>{settings.sound ? '🔊 Звук' : '🔇 Звук'}</button>;
  const viewToggle = can3d && <span className="flex rounded-sm border border-line overflow-hidden shrink-0" role="radiogroup" aria-label="Вид площадки" data-rink-view={show3d ? '3d' : '2d'}>
    {(['2d', '3d'] as const).map(v => <button key={v} type="button" role="radio" aria-checked={settings.matchView === v} onClick={() => setSettings({ matchView: v })}
      className={cn('px-1.5 py-0.5 text-[10px] font-bold uppercase', settings.matchView === v ? 'bg-ice text-bg' : 'text-muted hover:text-text')} data-rink-view-button={v}>{v}</button>)}
  </span>;
  return <section className={cn('rounded-md border border-line bg-panel overflow-hidden flex flex-col', className)} data-live-rink data-faceoff={frame.faceoff || undefined} data-stopped={frame.stopped || undefined}>
    {!bare && <div className="flex items-center justify-between gap-2 px-2.5 py-1 text-[11px] border-b border-line min-h-[26px]">
      <span className="flex items-center gap-2 min-w-0">
        {/* Who attacks which way: teams switch ends every period. */}
        <span className="flex items-center gap-1 shrink-0" data-rink-ends={flipped ? 'switched' : 'normal'}><i style={{ background: home.primaryColor }} className="inline-block w-2 h-2 rounded-full border border-white/50" />{flipped ? `← ${home.short}` : `${home.short} →`}</span>
        <span className="flex items-center gap-1 shrink-0">{flipped ? `${away.short} →` : `← ${away.short}`}<i style={{ background: '#f7fafc', borderColor: away.primaryColor }} className="inline-block w-2 h-2 rounded-full border-2" /></span>
        <span className="truncate text-muted" data-rink-caption>{frame.caption ?? ''}</span>
      </span>
      <span className="flex items-center gap-2 shrink-0">
        <span className={cn('font-semibold', frame.stopped ? 'text-gold' : running ? 'text-ok' : 'text-muted')} data-rink-state>{state}</span>
        {viewToggle}
      </span>
    </div>}
    {show3d ? (
      <div className={cn('relative bg-[#081421] overflow-hidden', fill ? 'flex-1 min-h-0' : 'w-full')} style={fill ? undefined : { aspectRatio: '16 / 9' }} data-rink-3d>
        <LiveScene3D ai={ai!} ticker={ticker} home={home} away={away} players={players} roster={roster ?? []} camera={settings.matchCamera} zoom={settings.matchZoom} quality={resolveReplayQuality(settings.replayQuality)} onFail={() => setFailed3d(true)} intro={intro && settings.matchIntro} replays={replays ?? settings.matchReplays} outro={outroOn ? outro : null} onOutroEnd={onOutroEnd} />
        {/* above the phone controls of the played match (their stick zone covers the left of the picture): the camera
            list opens down over it and must take the taps */}
        <div className="absolute top-1.5 left-1.5 flex flex-wrap gap-1 z-30" data-live-view-controls>
          {/* the camera: one button with the current view; it opens the list (eight NHL-style cameras) */}
          <span className="relative">
            <button type="button" aria-haspopup="true" aria-expanded={camOpen} onClick={() => setCamOpen(o => !o)}
              className="rounded-sm px-1.5 py-0.5 text-[10px] font-semibold backdrop-blur-sm bg-white/85 text-[#0b1726]" data-live-camera-menu>Камера: {LIVE_CAMERAS.find(([c]) => c === settings.matchCamera)?.[1] ?? 'ТВ'} ▾</button>
            {camOpen && <span className="absolute left-0 top-full mt-1 z-30 flex flex-col gap-0.5 rounded-sm bg-black/70 backdrop-blur-sm p-1 min-w-[112px]" role="radiogroup" aria-label="Камера">
              {LIVE_CAMERAS.map(([c, label]) => <button key={c} type="button" role="radio" aria-checked={settings.matchCamera === c} onClick={() => { setSettings({ matchCamera: c }); setCamOpen(false); }}
                className={cn('rounded-sm px-2 py-1 text-left text-[11px] font-semibold', settings.matchCamera === c ? 'bg-white/85 text-[#0b1726]' : 'text-white/90 hover:bg-white/20')} data-live-camera={c}>{label}</button>)}
            </span>}
          </span>
          {bare && viewToggle && <span className="bg-panel/90 rounded-sm">{viewToggle}</span>}
          <button type="button" aria-pressed={settings.matchMinimap} onClick={() => setSettings({ matchMinimap: !settings.matchMinimap })}
            className={cn('rounded-sm px-1.5 py-0.5 text-[10px] font-semibold backdrop-blur-sm', settings.matchMinimap ? 'bg-white/85 text-[#0b1726]' : 'bg-black/35 text-white/85 hover:bg-black/55')} data-live-minimap-toggle>Карта</button>
          {soundButton}
        </div>
        {/* The same frame on the 2D rink: both pictures are one simulation. */}
        {settings.matchMinimap && minimap && !outroOn && <div className="absolute right-1.5 bottom-1.5 w-[28%] min-w-[120px] max-w-[240px] rounded-sm border border-white/25 bg-[#0a1828]/75 p-0.5 pointer-events-none" style={{ aspectRatio: '2 / 1' }} data-rink-minimap>{svg}</div>}
      </div>
    ) : (
      <div className="bg-[#0a1828] p-1 flex-1 min-h-0 flex items-center justify-center relative"><div className="absolute top-1.5 left-1.5 z-10 flex gap-1">{bare && viewToggle && <span className="bg-panel/90 rounded-sm">{viewToggle}</span>}{soundButton}</div><div className={fill ? 'w-full h-full' : 'w-full max-w-[560px]'} style={fill ? undefined : { aspectRatio: '2 / 1' }}>{svg}</div></div>
    )}
  </section>;
}
