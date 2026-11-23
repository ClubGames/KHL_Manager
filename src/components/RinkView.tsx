import { useEffect, useRef, useState } from 'react';
import type { GameEvent, Player, Team } from '../types';
import { clipFrame, liveRinkFrame, type LiveFrame } from '../game/rinkPlayback';
import type { RinkAI } from '../game/rinkAI';
import { cn } from '../utils/cn';

export { clipFrame };
export function RinkSvg({ frame, home, away, players }: { frame: LiveFrame; home: Team; away: Team; players: Record<string, Player> }) {
  return <svg viewBox="0 0 100 50" className="w-full h-full" role="img" aria-label="Площадка сверху: хоккеисты и шайба" data-rink-svg>
    <rect x=".7" y=".7" width="98.6" height="48.6" rx="10" fill="#e5f0f4" stroke="#95b1c3" strokeWidth="1.2" />
    <path d="M 50 1 V 49" stroke="#db5066" strokeWidth=".35" />
    {[28, 72].map(x => <path key={x} d={`M ${x} 1 V 49`} stroke="#4076b7" strokeWidth=".6" />)}
    <circle cx="50" cy="25" r="7.3" stroke="#4076b7" fill="none" strokeWidth=".25" />
    {[19, 81].flatMap(x => [12, 38].map(y => <g key={`${x}-${y}`} stroke="#dc6070" fill="none" strokeWidth=".2"><circle cx={x} cy={y} r="7.3" /><circle cx={x} cy={y} r=".45" fill="#dc6070" /></g>))}
    {[7, 93].map(x => <g key={x}><path d={`M ${x} 3 V 47`} stroke="#db5066" strokeWidth=".2" /><ellipse cx={x} cy="25" rx="3.5" ry="3" fill="#6db9df66" stroke="#4287b5" strokeWidth=".15" /><rect x={x < 50 ? x - 2.3 : x} y="23.475" width="2.3" height="3.05" fill="#beced9" stroke="#ce3d51" strokeWidth=".3" /></g>)}
    <text x="50" y="26" textAnchor="middle" fontSize="2" fill="#7c9cac" fontFamily="sans-serif">КХЛ</text>
    {frame.skaters.map(p => <g key={`${p.side}-${p.id}`} transform={`translate(${p.pos.x} ${p.pos.y / 2})`} data-rink-player={p.id}>
      <title>{players[p.id]?.name ?? p.id}{p.goalie ? ' · вратарь' : ''}</title>
      <ellipse cy=".5" rx="1.65" ry="1" fill="#233a4b30" />
      {frame.carrier === p.id && <circle r="2" fill="none" stroke="#f5b942" strokeWidth=".3" data-rink-carrier />}
      {p.goalie ? <rect x="-1.4" y="-1" width="2.8" height="2" rx=".5" fill={p.side ? '#f7fafc' : home.primaryColor} stroke={p.side ? away.primaryColor : '#fff'} strokeWidth=".35" /> : <circle r="1.3" fill={p.side ? '#f7fafc' : home.primaryColor} stroke={p.side ? away.primaryColor : '#0b1726'} strokeWidth={p.side ? '.5' : '.35'} />}
      <text y=".4" textAnchor="middle" fontSize="1.2" fontWeight="bold" fill={p.side ? away.primaryColor : '#fff'} stroke={p.side ? '#fff' : '#000'} strokeWidth=".15" paintOrder="stroke" fontFamily="sans-serif">{players[p.id]?.number ?? ''}</text>
    </g>)}
    {frame.faceoff && <g transform={frame.official ? `translate(${frame.official.x} ${frame.official.y / 2})` : `translate(${frame.puck.x + 1} ${frame.puck.y / 2 + 3})`} aria-label="Судья на вбрасывании" data-rink-official><circle r="1" fill="#202a34" /><path d="M-.6 -.7 V.7 M0 -.9 V.9 M.6 -.7 V.7" stroke="#fff" strokeWidth=".2" /></g>}
    <circle cx={frame.puck.x} cy={frame.puck.y / 2} r="1.5" fill="none" stroke="#e68c22" strokeWidth=".3" opacity=".7" />
    <circle data-rink-puck cx={frame.puck.x} cy={frame.puck.y / 2 - frame.puck.h * 1.5} r=".65" fill="#0a1321" stroke="#fff" strokeWidth=".15" />
  </svg>;
}

export function LiveRink({ ticker, ids, goalies, event, home, away, players, running, ai = null, className, fill = false }: {
  ticker: { sec: number; tau?: number }; ids: [string[], string[]]; goalies: [string | null, string | null]; event: GameEvent | null;
  home: Team; away: Team; players: Record<string, Player>; running: boolean; ai?: RinkAI | null; className?: string; fill?: boolean;
}) {
  const read = () => (ai ? ticker.tau ?? 0 : ticker.sec);
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
  const state = frame.faceoff ? 'Вбрасывание · время стоит' : frame.stopped ? 'Свисток · время стоит' : running ? 'В игре' : 'Пауза';
  return <section className={cn('rounded-md border border-line bg-panel overflow-hidden flex flex-col', className)} data-live-rink data-faceoff={frame.faceoff || undefined} data-stopped={frame.stopped || undefined}>
    <div className="flex items-center justify-between gap-2 px-2.5 py-1 text-[11px] border-b border-line min-h-[26px]">
      <span className="flex items-center gap-2 min-w-0">
        <span className="flex items-center gap-1 shrink-0"><i style={{ background: home.primaryColor }} className="inline-block w-2 h-2 rounded-full border border-white/50" />{home.short} →</span>
        <span className="flex items-center gap-1 shrink-0">← {away.short}<i style={{ background: '#f7fafc', borderColor: away.primaryColor }} className="inline-block w-2 h-2 rounded-full border-2" /></span>
        <span className="truncate text-muted" data-rink-caption>{frame.caption ?? ''}</span>
      </span>
      <span className={cn('shrink-0 font-semibold', frame.stopped ? 'text-gold' : running ? 'text-ok' : 'text-muted')} data-rink-state>{state}</span>
    </div>
    <div className="bg-[#0a1828] p-1 flex-1 min-h-0 flex items-center justify-center"><div className={fill ? 'w-full h-full' : 'w-full max-w-[560px]'} style={fill ? undefined : { aspectRatio: '2 / 1' }}><RinkSvg frame={frame} home={home} away={away} players={players} /></div></div>
  </section>;
}
