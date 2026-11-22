import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { GameEvent, Player, Team } from '../types';
import { Button, Icon, TeamLogo } from './ui';
import { cn } from '../utils/cn';

type ReplayPlayer = { id: string; player: Player; side: 'attack' | 'defend'; slot: number };

export function GoalReplay({ event, home, away, players, onClose }: {
  event: GameEvent;
  home: Team;
  away: Team;
  players: Record<string, Player>;
  onClose: () => void;
}) {
  const [take, setTake] = useState(0);
  const attacking = event.team === home.id ? home : away;
  const defending = event.team === home.id ? away : home;
  const roster = useMemo(() => {
    const attackingIce = event.team === home.id ? event.ice?.[0] : event.ice?.[1];
    const defendingIce = event.team === home.id ? event.ice?.[1] : event.ice?.[0];
    const ids = (attackingIce ?? []).filter((id): id is string => !!id && !!players[id]);
    const defenderIds = (defendingIce ?? []).filter((id): id is string => !!id && !!players[id]);
    const ordered = [event.player, ...(event.players ?? []), ...ids.filter((id) => id !== event.player && !(event.players ?? []).includes(id))].filter((id): id is string => !!id && !!players[id]);
    const attack = ordered.slice(0, 5).map((id, slot) => ({ id, player: players[id], side: 'attack' as const, slot }));
    const defense = defenderIds.filter((id) => id !== event.goalie).slice(0, 5).map((id, slot) => ({ id, player: players[id], side: 'defend' as const, slot }));
    return [...attack, ...defense];
  }, [event, home.id, players]);

  const coords = (p: ReplayPlayer) => {
    if (p.side === 'attack') {
      const points = [[67, 51], [56, 37], [59, 65], [76, 35], [77, 66]];
      return points[p.slot] ?? [58, 50];
    }
    const points = [[83, 50], [76, 39], [76, 61], [87, 34], [87, 67]];
    return points[p.slot] ?? [80, 50];
  };
  const goalStyle = { '--home': home.primaryColor, '--away': away.primaryColor, '--attack': attacking.primaryColor, '--defend': defending.primaryColor } as CSSProperties;
  const shooter = event.player ? players[event.player] : undefined;
  const assistNames = (event.players ?? []).map((id) => players[id]?.name).filter(Boolean);

  return (
    <div className="fixed inset-0 z-[70] bg-[#050a12]/95 backdrop-blur-md flex items-center justify-center p-3 sm:p-6" role="dialog" aria-modal="true" aria-label="3D-повтор гола">
      <div className="w-full max-w-5xl rounded-xl overflow-hidden border border-white/15 bg-[#101b2a] shadow-2xl">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10">
          <span className="text-xs font-bold tracking-[.2em] uppercase text-red-400">3D Replay</span>
          <span className="text-xs text-slate-400">Телевизионная камера · повтор гола</span>
          <button onClick={onClose} className="ml-auto text-slate-300 hover:text-white p-1" aria-label="Закрыть повтор"><span className="text-2xl leading-none">×</span></button>
        </div>
        <div className="relative overflow-hidden bg-[#07121e]" style={goalStyle}>
          <div className="absolute inset-0 replay-arena-glow" />
          <div className="absolute top-3 left-3 right-3 z-20 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0"><TeamLogo team={attacking} size={30}/><div className="min-w-0"><div className="text-[10px] text-slate-400 uppercase tracking-widest">Гол</div><div className="text-sm sm:text-base font-bold truncate">{shooter?.name ?? 'Автор гола'}</div></div></div>
            <div className="font-display text-2xl sm:text-3xl tabular text-white">{event.score?.[0] ?? '—'} : {event.score?.[1] ?? '—'}</div>
            <div className="flex items-center gap-2 min-w-0"><div className="text-right min-w-0"><div className="text-[10px] text-slate-400 uppercase tracking-widest">Вратарь</div><div className="text-sm sm:text-base font-bold truncate">{event.goalie ? players[event.goalie]?.name ?? 'Вратарь' : 'Пустые ворота'}</div></div><TeamLogo team={defending} size={30}/></div>
          </div>
          <div className="replay-camera" key={take}>
            <div className="replay-rink">
              <div className="replay-board" />
              <div className="replay-ice">
                <div className="replay-center-line"/><div className="replay-blue-line replay-blue-left"/><div className="replay-blue-line replay-blue-right"/><div className="replay-red-circle replay-circle-left"/><div className="replay-red-circle replay-circle-right"/><div className="replay-center-circle"/><div className="replay-goal-crease"/><div className="replay-goal-net"><span/></div>
                {roster.map((rp) => {
                  const [x,y] = coords(rp);
                  const isShooter = rp.id === event.player;
                  return <div key={rp.id} className={cn('replay-skater', rp.side === 'attack' ? 'replay-attacker' : 'replay-defender', isShooter && 'replay-shooter', `replay-skater-${rp.slot}`)} style={{ left: `${x}%`, top: `${y}%`, '--jersey': rp.side === 'attack' ? attacking.primaryColor : defending.primaryColor, '--trim': rp.side === 'attack' ? attacking.secondaryColor : defending.secondaryColor } as CSSProperties}>
                    <span className="replay-shadow"/><span className="replay-blade"/><span className="replay-stick"/><span className="replay-legs"/><span className="replay-body">{rp.player.number}</span><span className="replay-head"/><span className="replay-helmet"/><span className="replay-helmet-cage"/>
                  </div>;
                })}
                {event.goalie && players[event.goalie] && <div className="replay-goalie"><span className="replay-goalie-pad"/><span className="replay-goalie-body"/><span className="replay-goalie-mask"/></div>}
                <div className="replay-puck"><span/></div>
                <div className="replay-shot-trail"/>
              </div>
            </div>
          </div>
          <div className="absolute bottom-3 left-3 right-3 z-20 flex items-end justify-between gap-3 pointer-events-none">
            <div className="text-[10px] sm:text-xs text-white/80 drop-shadow">{event.period <= 3 ? `${event.period}-й период` : 'Овертайм'} · {event.time}{event.strength && event.strength !== 'EV' ? ` · ${event.strength}` : ''}</div>
            <div className="text-[10px] sm:text-xs text-white/80 text-right drop-shadow">{assistNames.length ? `Передачи: ${assistNames.join(', ')}` : 'Без результативных передач'}</div>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-white/10">
          <div className="text-xs text-slate-400">{event.text}</div>
          <div className="flex items-center gap-2 shrink-0"><Button size="sm" onClick={() => setTake((v) => v + 1)}>↻ Повторить</Button><Button size="sm" variant="primary" onClick={onClose}>Продолжить матч <Icon name="play"/></Button></div>
        </div>
      </div>
      <style>{`
        .replay-arena-glow{background:radial-gradient(ellipse at 50% 10%,rgba(84,145,190,.28),transparent 55%),linear-gradient(180deg,#0b1c2c 0%,#07111c 100%)}
        .replay-camera{height:clamp(290px,53vw,540px);max-height:62vh;perspective:1050px;perspective-origin:50% 38%;overflow:hidden;position:relative}
        .replay-rink{position:absolute;left:4%;right:4%;top:12%;bottom:1%;transform-style:preserve-3d;transform:rotateX(57deg) rotateZ(-2deg) scale(1.12);border-radius:48%;}
        .replay-board{position:absolute;inset:-2.5%;border-radius:48%;background:linear-gradient(135deg,#d9e2e9,#64788a 12%,#e8edf0 18%,#dce5eb 82%,#536879);box-shadow:0 15px 28px #0009,inset 0 0 0 8px #fff8}
        .replay-ice{position:absolute;inset:0;overflow:hidden;border-radius:48%;background:repeating-linear-gradient(0deg,rgba(60,105,130,.025) 0 2px,transparent 2px 5px),linear-gradient(115deg,#dcecf1,#f4fbfd 48%,#d5e8ee);box-shadow:inset 0 0 0 2px #b8d0d9}
        .replay-center-line,.replay-blue-line{position:absolute;top:0;bottom:0;width:1.1%;left:50%;background:#df3b46;opacity:.9}.replay-blue-line{background:#3979bc;width:.7%}.replay-blue-left{left:27%}.replay-blue-right{left:73%}
        .replay-center-circle,.replay-red-circle{position:absolute;width:18%;aspect-ratio:1;border:2px solid #d84b55;border-radius:50%;left:41%;top:36%;background:transparent}.replay-red-circle{width:9%;left:12%;top:39%;border-color:#d84b55}.replay-circle-right{left:79%}
        .replay-goal-crease{position:absolute;right:0;top:39%;height:22%;width:10%;border:2px solid #6aa6d4;border-right:0;border-radius:50% 0 0 50%;background:#9fcbe533}
        .replay-goal-net{position:absolute;right:-.2%;top:43%;width:6%;height:14%;border:2px solid #d94a52;border-left:0;background:repeating-linear-gradient(0deg,transparent 0 5px,#8ba3b2 5px 6px),repeating-linear-gradient(90deg,transparent 0 5px,#8ba3b2 5px 6px);transform:translateZ(3px)}.replay-goal-net span{position:absolute;inset:0;background:#fff5}
        .replay-skater{position:absolute;width:24px;height:42px;z-index:5;transform:translate(-50%,-50%) rotateX(-57deg);transform-style:preserve-3d;animation:replay-glide 4.8s ease-in-out both}
        .replay-shadow{position:absolute;width:34px;height:15px;left:-5px;bottom:0;background:#344c5a55;border-radius:50%;filter:blur(3px);transform:translateZ(-2px)}
        .replay-body{position:absolute;left:3px;top:12px;width:18px;height:19px;border-radius:7px 7px 5px 5px;background:linear-gradient(90deg,var(--trim),var(--jersey) 25%,var(--jersey) 75%,var(--trim));border:1px solid #182432;color:#fff;font:700 8px Arial;display:grid;place-items:center;text-shadow:0 1px 2px #000;box-shadow:0 3px 4px #0006}
        .replay-head{position:absolute;left:7px;top:4px;width:11px;height:11px;border-radius:50% 50% 48% 48%;background:radial-gradient(circle at 35% 28%,#f6dcc0,#b1886a 66%,#865f49 100%);border:1px solid #182432;box-shadow:inset -2px -2px 3px #0004,inset 1px 1px 2px #fff6}
        .replay-helmet{position:absolute;left:4px;top:1px;width:17px;height:10px;border-radius:9px 9px 5px 5px;background:linear-gradient(180deg,#fff3 0 1px,var(--jersey) 14%,color-mix(in srgb,var(--jersey) 72%,#000) 100%);border:1px solid #16222e;box-shadow:inset 0 1px 0 #fff6,0 1px 1px #0007,0 0 0 1px #0003}
        .replay-helmet::after{content:"";position:absolute;left:5px;top:2.5px;width:7px;height:4px;border-radius:3px;background:radial-gradient(circle at 50% 40%,#fff9,transparent 70%)}
        .replay-helmet-cage{position:absolute;left:6px;top:9px;width:13px;height:5px;border-radius:0 0 4px 4px;background:repeating-linear-gradient(90deg,#cdd6dd 0 1px,transparent 1px 2px);opacity:.85;filter:drop-shadow(0 0 0 #16222e);border-bottom:1px solid #16222e}
        .replay-legs{position:absolute;left:5px;top:28px;width:14px;height:11px;border-left:4px solid #182432;border-right:4px solid #182432;transform:perspective(20px) rotateX(12deg)}
        .replay-stick{position:absolute;left:19px;top:24px;width:2px;height:29px;background:#513c2c;transform:rotate(-35deg);transform-origin:top;box-shadow:0 0 1px #000}.replay-blade{position:absolute;left:14px;top:48px;width:13px;height:3px;background:#292d32;border-radius:2px;transform:rotate(-10deg)}
        .replay-shooter{animation:replay-shooter 4.8s cubic-bezier(.2,.6,.25,1) both}.replay-shooter .replay-body{box-shadow:0 0 13px #fff9,0 3px 4px #0006}
        .replay-defender{animation:replay-defend 4.8s ease-in-out both}
        .replay-skater-1{animation-delay:-.12s}.replay-skater-2{animation-delay:-.2s}.replay-skater-3{animation-delay:-.08s}.replay-skater-4{animation-delay:-.16s}
        .replay-goalie{position:absolute;right:5%;top:50%;width:35px;height:24px;z-index:7;transform:translate(0,-50%) rotateX(-57deg);animation:replay-goalie 4.8s ease-out both}
        .replay-goalie-body{position:absolute;left:8px;top:2px;width:19px;height:18px;border-radius:8px;background:linear-gradient(90deg,var(--defend),#fff,var(--defend));border:2px solid #24394c}.replay-goalie-mask{position:absolute;left:13px;top:-9px;width:13px;height:13px;border-radius:8px 8px 5px 5px;background:linear-gradient(180deg,#fff3 0 1px,var(--defend) 16%,color-mix(in srgb,var(--defend) 65%,#000) 100%);border:1px solid #24394c;box-shadow:inset 0 0 0 1px #fff5,0 1px 2px #0007}
        .replay-goalie-mask::after{content:"";position:absolute;inset:2.5px;border-radius:3px;background:repeating-linear-gradient(0deg,transparent 0 1px,#0b1622 1px 2px),repeating-linear-gradient(90deg,transparent 0 1px,#0b1622 1px 2px);opacity:.85}.replay-goalie-pad{position:absolute;left:0;top:13px;width:35px;height:11px;border-radius:8px;background:#e8edf1;border:2px solid var(--defend)}
        .replay-puck{position:absolute;left:68%;top:53%;width:9px;height:5px;border-radius:50%;background:#080b0e;z-index:12;box-shadow:0 0 0 2px #fff5,0 2px 4px #000;animation:replay-puck 4.8s cubic-bezier(.12,.7,.2,1) both}.replay-puck span{position:absolute;inset:-3px;border-radius:50%;background:#fff;opacity:0;filter:blur(5px);animation:replay-puck-glow 4.8s both}
        .replay-shot-trail{position:absolute;left:69%;top:53%;width:0;height:2px;background:linear-gradient(90deg,transparent,#252a31aa,transparent);transform:rotate(-2deg);z-index:10;animation:replay-trail 4.8s ease-out both}
        @keyframes replay-puck{0%,48%{left:66%;top:54%;transform:scale(1)}65%{left:82%;top:51%;transform:scale(1.3)}82%,100%{left:96%;top:49%;transform:scale(.85)}}
        @keyframes replay-puck-glow{0%,45%{opacity:0}62%{opacity:.8}100%{opacity:0}}
        @keyframes replay-trail{0%,45%{width:0;opacity:0}60%{width:22%;opacity:.9}82%,100%{width:28%;opacity:0}}
        @keyframes replay-shooter{0%,20%{left:67%;top:53%}48%{left:75%;top:51%}70%{left:85%;top:49%}100%{left:87%;top:49%}}
        @keyframes replay-glide{0%,20%{translate:0 0}55%{translate:4px -3px}100%{translate:8px -4px}}
        @keyframes replay-defend{0%,30%{translate:0 0}62%{translate:-5px 0}100%{translate:-3px 0}}
        @keyframes replay-goalie{0%,48%{translate:0 0}70%{translate:-8px 3px;rotate:-12deg}85%,100%{translate:-10px 4px;rotate:-22deg}}
        @media(prefers-reduced-motion:reduce){.replay-skater,.replay-puck,.replay-puck span,.replay-shot-trail,.replay-goalie{animation-duration:1ms!important;animation-iteration-count:1!important}}
      `}</style>
    </div>
  );
}
