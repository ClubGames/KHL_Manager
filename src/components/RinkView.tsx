import { useEffect, useRef, useState } from 'react';
import type { GameEvent, Player, Team } from '../types';
import { liveRinkFrame, samplePath, type LiveFrame, type ReplayClip } from '../game/rinkPlayback';

export function clipFrame(clip: ReplayClip, time: number): LiveFrame {
  return { puck: samplePath(clip.puck, time), skaters: clip.tracks.map(tr => ({ id: tr.id, side: tr.side, goalie: tr.goalie, pos: samplePath(tr.keys, time) })) };
}
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
      {p.goalie ? <rect x="-1.4" y="-1" width="2.8" height="2" rx=".5" fill={p.side ? away.primaryColor : home.primaryColor} stroke="#fff" strokeWidth=".35" /> : <circle r="1.3" fill={p.side ? away.primaryColor : home.primaryColor} stroke={p.side ? '#fff' : '#142a40'} strokeWidth=".35" />}
      <text y=".4" textAnchor="middle" fontSize="1.2" fontWeight="bold" fill="#fff" stroke="#000" strokeWidth=".15" paintOrder="stroke" fontFamily="sans-serif">{players[p.id]?.number ?? ''}</text>
    </g>)}
    <circle cx={frame.puck.x} cy={frame.puck.y / 2} r="1.5" fill="none" stroke="#e68c22" strokeWidth=".3" opacity=".7" />
    <circle data-rink-puck cx={frame.puck.x} cy={frame.puck.y / 2} r=".65" fill="#0a1321" stroke="#fff" strokeWidth=".15" />
  </svg>;
}

export function LiveRink({ ticker, ids, goalies, event, home, away, players, running }: {
  ticker: { sec: number }; ids: [string[], string[]]; goalies: [string | null, string | null]; event: GameEvent | null;
  home: Team; away: Team; players: Record<string, Player>; running: boolean;
}) {
  const [sec, setSec] = useState(ticker.sec);
  const last = useRef(0);
  useEffect(() => {
    setSec(ticker.sec);
    if (!running || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    const tick = (now: number) => {
      if (now - last.current > 40) { setSec(ticker.sec); last.current = now; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ticker, running, event]);
  const frame = liveRinkFrame(sec, ids, goalies, event, home.id);
  return <section className="rounded-md border border-line bg-panel overflow-hidden" data-live-rink>
    <div className="flex justify-between gap-2 px-3 py-2 text-xs border-b border-line"><b>Площадка · 2D</b><span className={running ? 'text-ok' : 'text-muted'}>{running ? 'В игре' : 'Пауза / остановка'}</span></div>
    <div className="px-2 py-3 bg-[#0a1828]"><RinkSvg frame={frame} home={home} away={away} players={players} /></div>
    <div className="flex gap-3 flex-wrap px-3 pt-2 text-[11px]"><span><i style={{ background: home.primaryColor }} className="inline-block w-2 h-2 rounded-full mr-1 border border-white/50" />{home.short} →</span><span><i style={{ background: away.primaryColor }} className="inline-block w-2 h-2 rounded-full mr-1 border border-white/50" />← {away.short}</span><span className="text-gold">◉ Шайба</span></div>
    <p className="px-3 py-2 text-[10px] text-muted">Схематичная реконструкция: броски и составы — из событий матча, движение между ними — условное. Направления атаки фиксированы, как на карте xG.</p>
  </section>;
}
