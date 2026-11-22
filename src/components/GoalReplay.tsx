import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { GameEvent, Player, Team } from '../types';
import { Button, Icon, TeamLogo } from './ui';
import { cn } from '../utils/cn';

type WP = { t: number; x: number; y: number; s?: number };
type RP = { id: string; player: Player; side: 'attack' | 'defend'; slot: number; path: WP[] };

type Scenario = {
  kind: string;
  label: string;
  dur: number;
  attack: RP[];
  defense: RP[];
  goalie: { present: boolean; path: WP[] };
  puck: WP[];
};

type Kind = 'ev' | 'pp' | 'sh' | 'en' | 'ev4' | 'ot';
type Seg = [[number, number], [number, number]];

const seg = (a: [number, number], b: [number, number]): WP[] => [
  { t: 0, x: a[0], y: a[1] },
  { t: 1, x: b[0], y: b[1] },
];

function pickKind(event: GameEvent): Kind {
  const strength = event.strength ?? 'EV';
  const isOT = event.period > 3;
  let kind: Kind = 'ev';
  if (strength === 'PP') kind = 'pp';
  else if (strength === 'SH') kind = 'sh';
  else if (strength === 'EN') kind = 'en';
  else if (strength === '4v4') kind = 'ev4';
  if (isOT && strength !== 'EN') kind = 'ot';
  return kind;
}

type Cfg = {
  label: string;
  dur: number;
  scorer: WP[];
  others: Seg[];
  defenders: Seg[];
  goalie: WP[] | null;
  puck: WP[];
};

function insertWaypoint(puck: WP[], t: number, x: number, y: number): WP[] {
  const out: WP[] = [];
  let inserted = false;
  for (const w of puck) {
    if (!inserted && w.t > t) {
      out.push({ t, x, y });
      inserted = true;
    }
    out.push(w);
  }
  if (!inserted) out.push({ t, x, y });
  return out;
}

function applyShotType(cfg: Cfg, shotType?: string): void {
  if (!shotType) return;
  switch (shotType) {
    case 'slap':
      cfg.label += ' · бросок щелчком';
      cfg.puck = cfg.puck.map((w) => (w.t > 0.6 ? { ...w, t: Math.max(0.6, (w.t - 0.6) * 0.7 + 0.6) } : w));
      break;
    case 'tip':
      cfg.label += ' · гол-касание (tip-in)';
      cfg.puck = insertWaypoint(cfg.puck, 0.64, 81, 47);
      break;
    case 'rebound':
      cfg.label += ' · добивание (rebound)';
      cfg.puck = insertWaypoint(cfg.puck, 0.63, 89, 47).map((w) => (w.t === 0.74 ? { ...w, x: 92, y: 46 } : w));
      break;
    case 'backhand':
      cfg.label += ' · с тыльной стороны клюшки';
      break;
    case 'snap':
      cfg.label += ' · бросок с руки (snap)';
      break;
    default:
      break;
  }
}

function baseConfig(kind: Kind, assists: number): Cfg {
  switch (kind) {
    case 'pp':
      return {
        label: 'Большинство (PP)',
        dur: 5.4,
        scorer: [{ t: 0, x: 58, y: 50 }, { t: 0.56, x: 70, y: 50 }, { t: 1, x: 70, y: 50 }] as WP[],
        others: [
          [[48, 50], [50, 50]],
          [[66, 28], [64, 30]],
          [[60, 72], [62, 70]],
          [[76, 50], [80, 50]],
        ] as Seg[],
        defenders: [
          [[84, 50], [83, 50]],
          [[82, 42], [82, 45]],
          [[82, 58], [82, 55]],
          [[88, 40], [87, 42]],
          [[88, 60], [87, 58]],
        ] as Seg[],
        goalie: [{ t: 0, x: 90, y: 50 }, { t: 0.72, x: 90, y: 50 }, { t: 0.82, x: 89, y: 48 }, { t: 1, x: 89, y: 48 }] as WP[],
        puck: [
          { t: 0, x: 48, y: 50 }, { t: 0.18, x: 48, y: 50 }, { t: 0.34, x: 66, y: 28 },
          { t: 0.46, x: 66, y: 28 }, { t: 0.56, x: 70, y: 50 }, { t: 0.62, x: 70, y: 50 },
          { t: 0.74, x: 95, y: 50, s: 1.15 }, { t: 1, x: 96, y: 50, s: 0.85 },
        ] as WP[],
      };
    case 'sh':
      return {
        label: 'Меньшинство (SH) · выход 1-в-1',
        dur: 4.8,
        scorer: [{ t: 0, x: 18, y: 48 }, { t: 0.62, x: 74, y: 48 }, { t: 1, x: 74, y: 48 }] as WP[],
        others: [
          [[14, 58], [58, 60]],
          [[22, 40], [50, 38]],
          [[10, 52], [42, 54]],
          [[16, 46], [46, 46]],
        ] as Seg[],
        defenders: [
          [[84, 50], [83, 50]],
          [[80, 40], [80, 42]],
          [[80, 60], [80, 58]],
          [[88, 36], [87, 38]],
          [[88, 64], [87, 62]],
        ] as Seg[],
        goalie: [{ t: 0, x: 92, y: 50 }, { t: 0.5, x: 84, y: 49 }, { t: 0.74, x: 86, y: 51 }, { t: 1, x: 86, y: 51 }] as WP[],
        puck: [
          { t: 0, x: 18, y: 48 }, { t: 0.5, x: 58, y: 49 }, { t: 0.62, x: 74, y: 48 },
          { t: 0.74, x: 95, y: 50, s: 1.15 }, { t: 1, x: 96, y: 50, s: 0.85 },
        ] as WP[],
      };
    case 'en':
      return {
        label: 'Пустые ворота (EN)',
        dur: 6.0,
        scorer: [{ t: 0, x: 40, y: 50 }, { t: 0.6, x: 82, y: 50 }, { t: 1, x: 82, y: 50 }] as WP[],
        others: [
          [[46, 36], [60, 38]],
          [[34, 64], [54, 62]],
          [[30, 44], [50, 44]],
          [[44, 58], [64, 58]],
        ] as Seg[],
        defenders: [
          [[80, 50], [78, 50]],
          [[76, 40], [76, 42]],
          [[76, 60], [76, 58]],
          [[84, 38], [83, 40]],
          [[84, 62], [83, 60]],
        ] as Seg[],
        goalie: null,
        puck: [
          { t: 0, x: 40, y: 50 }, { t: 0.45, x: 72, y: 50 }, { t: 0.6, x: 82, y: 50 },
          { t: 0.8, x: 96, y: 52, s: 1.1 }, { t: 1, x: 97, y: 52, s: 0.9 },
        ] as WP[],
      };
    case 'ot':
      return {
        label: 'Овертайм · золотой гол',
        dur: 5.0,
        scorer: [{ t: 0, x: 16, y: 50 }, { t: 0.62, x: 76, y: 50 }, { t: 1, x: 76, y: 50 }] as WP[],
        others: [
          [[12, 60], [56, 62]],
          [[20, 40], [50, 38]],
          [[10, 50], [40, 52]],
          [[14, 46], [44, 46]],
        ] as Seg[],
        defenders: [
          [[84, 50], [83, 50]],
          [[80, 40], [80, 42]],
          [[80, 60], [80, 58]],
          [[88, 36], [87, 38]],
          [[88, 64], [87, 62]],
        ] as Seg[],
        goalie: [{ t: 0, x: 92, y: 50 }, { t: 0.45, x: 82, y: 49 }, { t: 0.74, x: 84, y: 51 }, { t: 1, x: 84, y: 51 }] as WP[],
        puck: [
          { t: 0, x: 16, y: 50 }, { t: 0.5, x: 60, y: 50 }, { t: 0.62, x: 76, y: 50 },
          { t: 0.74, x: 95, y: 50, s: 1.15 }, { t: 1, x: 96, y: 50, s: 0.85 },
        ] as WP[],
      };
    case 'ev4':
      return evBase(true);
    default:
      return evBase(false);
  }
}

function evBase(assists: boolean): Cfg {
  return {
    label: 'Равные составы',
    dur: 5.2,
    scorer: assists
      ? ([{ t: 0, x: 34, y: 50 }, { t: 0.36, x: 60, y: 48 }, { t: 0.6, x: 70, y: 50 }, { t: 1, x: 70, y: 50 }] as WP[])
      : ([{ t: 0, x: 34, y: 50 }, { t: 0.6, x: 70, y: 50 }, { t: 1, x: 70, y: 50 }] as WP[]),
    others: [
      [[44, 30], [56, 36]],
      [[28, 70], [52, 64]],
      [[46, 20], [60, 24]],
      [[22, 46], [46, 44]],
    ] as Seg[],
    defenders: [
      [[82, 50], [80, 50]],
      [[78, 38], [76, 40]],
      [[78, 62], [76, 60]],
      [[86, 34], [84, 36]],
      [[86, 66], [84, 64]],
    ] as Seg[],
    goalie: [{ t: 0, x: 90, y: 50 }, { t: 0.72, x: 90, y: 50 }, { t: 0.82, x: 88, y: 46 }, { t: 1, x: 88, y: 46 }] as WP[],
    puck: assists
      ? ([
          { t: 0, x: 44, y: 30 }, { t: 0.16, x: 44, y: 30 }, { t: 0.36, x: 60, y: 48 },
          { t: 0.6, x: 70, y: 50 }, { t: 0.74, x: 95, y: 50, s: 1.15 }, { t: 1, x: 96, y: 50, s: 0.85 },
        ] as WP[])
      : ([
          { t: 0, x: 34, y: 50 }, { t: 0.6, x: 70, y: 50 },
          { t: 0.74, x: 95, y: 50, s: 1.15 }, { t: 1, x: 96, y: 50, s: 0.85 },
        ] as WP[]),
  };
}

function configFor(kind: Kind, assists: number, shotType?: string): Cfg {
  const cfg = baseConfig(kind, assists);
  applyShotType(cfg, shotType);
  return cfg;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildScenario(event: GameEvent, home: Team, _away: Team, players: Record<string, Player>): Scenario | null {
  if (!event.player || !players[event.player]) return null;
  const attackingIce = (event.team === home.id ? event.ice?.[0] : event.ice?.[1]) ?? [];
  const defendingIce = (event.team === home.id ? event.ice?.[1] : event.ice?.[0]) ?? [];
  const aids = attackingIce.filter((id): id is string => !!id && !!players[id]);
  const dids = defendingIce.filter((id): id is string => !!id && !!players[id]);
  const ordered = [event.player, ...(event.players ?? [])]
    .concat(aids.filter((id) => id !== event.player && !(event.players ?? []).includes(id)))
    .filter((id): id is string => !!id && !!players[id]);
  const attack = ordered.slice(0, 5).map((id, slot) => ({ id, player: players[id], side: 'attack' as const, slot }));
  const defense = dids.filter((id) => id !== event.goalie).slice(0, 5).map((id, slot) => ({ id, player: players[id], side: 'defend' as const, slot }));

  const kind = pickKind(event);
  const assists = (event.players ?? []).length;
  const cfg = configFor(kind, assists, event.shotType);

  const attackRP: RP[] = attack.map((a) =>
    a.slot === 0
      ? { ...a, path: cfg.scorer }
      : { ...a, path: seg(cfg.others[a.slot - 1]?.[0] ?? [50, 50], cfg.others[a.slot - 1]?.[1] ?? [50, 50]) },
  );
  const defenseRP: RP[] = defense.map((d) =>
    d.slot < cfg.defenders.length
      ? { ...d, path: seg(cfg.defenders[d.slot][0], cfg.defenders[d.slot][1]) }
      : { ...d, path: seg([82, 50], [80, 50]) },
  );

  // deterministic per-event variety: nudge non-scorer skaters so no two goals line up identically
  const seed = (hashStr(event.player || '0') ^ Math.round(event.sec ?? 0) * 2654435761 ^ (event.period || 1) * 97) >>> 0;
  const rand = rng(seed);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const jitter = (rp: RP): RP => {
    const dx = (rand() - 0.5) * 7;
    const dy = (rand() - 0.5) * 5;
    return { ...rp, path: rp.path.map((w) => ({ ...w, x: clamp(w.x + dx, 6, 94), y: clamp(w.y + dy, 10, 90) })) };
  };
  const attackJ = attackRP.map((a) => (a.slot === 0 ? a : jitter(a)));
  const defenseJ = defenseRP.map((d) => jitter(d));

  return {
    kind,
    label: cfg.label,
    dur: cfg.dur,
    attack: attackJ,
    defense: defenseJ,
    goalie: { present: cfg.goalie !== null && !!event.goalie, path: cfg.goalie ?? [] },
    puck: cfg.puck,
  };
}

// broadcast camera presets — different angle per goal for variety
const CAMERAS = [
  { rx: 57, rz: -4, scale: 1.12 },
  { rx: 61, rz: 3, scale: 1.18 },
  { rx: 53, rz: -11, scale: 1.06 },
  { rx: 59, rz: 9, scale: 1.14 },
];

export function GoalReplay({ event, home, away, players, onClose }: {
  event: GameEvent;
  home: Team;
  away: Team;
  players: Record<string, Player>;
  onClose: () => void;
}) {
  const [take, setTake] = useState(0);
  const scenario = useMemo(() => buildScenario(event, home, away, players), [event, home.id, away.id, players]);
  const attacking = event.team === home.id ? home : away;
  const defending = event.team === home.id ? away : home;
  const shooter = event.player ? players[event.player] : undefined;
  const assistNames = (event.players ?? []).map((id) => players[id]?.name).filter(Boolean);

  const flip = event.team === away.id; // guests attack the opposite end → different net on screen
  const cam = CAMERAS[(Math.abs(Math.round(event.sec ?? 0)) + take) % CAMERAS.length];
  const baseTransform = (zoom: number, shift: number) =>
    `scaleX(${flip ? -1 : 1}) rotateX(${cam.rx}deg) rotateZ(${cam.rz}deg) scale(${(cam.scale * zoom).toFixed(3)}) translateX(${-shift}%)`;

  const css = useMemo(() => {
    const kf = (name: string, stops: { t: number; css: string }[]) =>
      `@keyframes ${name}{` + stops.map((s) => `${(s.t * 100).toFixed(2)}%{${s.css}}`).join('') + `}`;
    const dyn: string[] = [];
    if (scenario) {
      scenario.attack.forEach((rp) => {
        dyn.push(kf(`sk-${rp.id}-${take}`, rp.path.map((w) => ({ t: w.t, css: `left:${w.x}%;top:${w.y}%` }))));
      });
      scenario.defense.forEach((rp) => {
        dyn.push(kf(`sk-${rp.id}-${take}`, rp.path.map((w) => ({ t: w.t, css: `left:${w.x}%;top:${w.y}%` }))));
      });
      if (scenario.goalie.present) {
        dyn.push(kf(`gk-${take}`, scenario.goalie.path.map((w) => ({ t: w.t, css: `left:${w.x}%;top:${w.y}%` }))));
      }
      dyn.push(kf(`puck-${take}`, scenario.puck.map((w) => ({ t: w.t, css: `left:${w.x}%;top:${w.y}%;transform:translate(-50%,-50%) scale(${w.s ?? 1})` }))));
      // broadcast camera: hold, then punch-zoom toward the net on the shot, then ease back
      const base = baseTransform(1, 0);
      const punch = baseTransform(1.32, 6);
      const ease = baseTransform(1.3, 5);
      dyn.push(kf(`cam-${take}`, [
        { t: 0, css: `transform:${base}` },
        { t: 0.5, css: `transform:${base}` },
        { t: 0.58, css: `transform:${punch}` },
        { t: 0.82, css: `transform:${ease}` },
        { t: 1, css: `transform:${base}` },
      ]));
      dyn.push(kf(`flash-${take}`, [
        { t: 0, css: 'opacity:0;transform:scale(.7)' },
        { t: 0.06, css: 'opacity:1;transform:scale(1.1)' },
        { t: 0.18, css: 'opacity:1;transform:scale(1)' },
        { t: 0.32, css: 'opacity:0;transform:scale(1.05)' },
        { t: 1, css: 'opacity:0;transform:scale(1)' },
      ]));
    }
    return STATIC_CSS + dyn.join('\n');
  }, [scenario, take, flip, cam.rx, cam.rz, cam.scale]);

  if (!scenario) {
    return (
      <div className="fixed inset-0 z-[70] bg-[#050a12]/95 backdrop-blur-md flex items-center justify-center p-3 sm:p-6" role="dialog" aria-modal="true" aria-label="3D-повтор гола">
        <div className="w-full max-w-5xl rounded-xl overflow-hidden border border-white/15 bg-[#101b2a] shadow-2xl p-6 text-center text-slate-300">Нет данных для повтора.</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[70] bg-[#050a12]/95 backdrop-blur-md flex items-center justify-center p-3 sm:p-6" role="dialog" aria-modal="true" aria-label="3D-повтор гола">
      <div className="w-full max-w-5xl rounded-xl overflow-hidden border border-white/15 bg-[#101b2a] shadow-2xl">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10">
          <span className="text-xs font-bold tracking-[.2em] uppercase text-red-400">3D Replay</span>
          <span className="text-xs text-slate-400">Телевизионная камера · {scenario.label}</span>
          <button onClick={onClose} className="ml-auto text-slate-300 hover:text-white p-1" aria-label="Закрыть повтор"><span className="text-2xl leading-none">×</span></button>
        </div>
        <div className="relative overflow-hidden bg-[#07121e]" style={{ '--home': home.primaryColor, '--away': away.primaryColor, '--attack': attacking.primaryColor, '--defend': defending.primaryColor } as CSSProperties}>
          <div className="absolute inset-0 replay-arena-glow" />
          <div className="absolute top-3 left-3 right-3 z-20 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0"><TeamLogo team={attacking} size={30} /><div className="min-w-0"><div className="text-[10px] text-slate-400 uppercase tracking-widest">Гол</div><div className="text-sm sm:text-base font-bold truncate">{shooter?.name ?? 'Автор гола'}</div></div></div>
            <div className="font-display text-2xl sm:text-3xl tabular text-white px-3">{event.score?.[0] ?? '—'} : {event.score?.[1] ?? '—'}</div>
            <div className="flex items-center gap-2 min-w-0"><div className="text-right min-w-0"><div className="text-[10px] text-slate-400 uppercase tracking-widest">Вратарь</div><div className="text-sm sm:text-base font-bold truncate">{event.goalie ? players[event.goalie]?.name ?? 'Вратарь' : 'Пустые ворота'}</div></div><TeamLogo team={defending} size={30} /></div>
          </div>
          <div className="replay-camera" key={take}>
            <div className="replay-goalflash" style={{ animation: `flash-${take} ${scenario.dur}s ease-out both` }}>ГОЛ!</div>
            <div className={cn('replay-rink', flip && 'replay-flipped')} style={{ transform: baseTransform(1, 0), animation: `cam-${take} ${scenario.dur}s ease-in-out both` }}>
              <div className="replay-slab" />
              <div className="replay-board" />
              <div className="replay-ice">
                <div className="replay-center-line" /><div className="replay-blue-line replay-blue-left" /><div className="replay-blue-line replay-blue-right" /><div className="replay-red-circle replay-circle-left" /><div className="replay-red-circle replay-circle-right" /><div className="replay-center-circle" />
                <div className="replay-goal-crease" /><div className="replay-goal-net"><span /></div><div className="replay-goal-frame" />
                <div className="replay-goal-crease replay-crease-left" /><div className="replay-goal-net replay-goal-net-left"><span /></div><div className="replay-goal-frame replay-goal-frame-left" />
                {scenario.attack.map((rp) => {
                  const isShooter = rp.id === event.player;
                  const isAssist = (event.players ?? []).includes(rp.id);
                  return (
                    <div key={rp.id} className={cn('replay-skater', rp.side === 'attack' ? 'replay-attacker' : 'replay-defender', isShooter && 'replay-shooter', isAssist && 'replay-assist')} style={{ animation: `sk-${rp.id}-${take} ${scenario.dur}s cubic-bezier(.3,.7,.3,1) both`, '--jersey': rp.side === 'attack' ? attacking.primaryColor : defending.primaryColor, '--trim': rp.side === 'attack' ? attacking.secondaryColor : defending.secondaryColor } as CSSProperties}>
                      <span className="replay-shadow" /><span className="replay-legs" /><span className="replay-stick" /><span className="replay-blade" /><span className="replay-body">{rp.player.number}</span><span className="replay-head" /><span className="replay-helmet" /><span className="replay-helmet-cage" />
                    </div>
                  );
                })}
                {scenario.defense.map((rp) => (
                  <div key={rp.id} className={cn('replay-skater', 'replay-defender')} style={{ animation: `sk-${rp.id}-${take} ${scenario.dur}s cubic-bezier(.3,.7,.3,1) both`, '--jersey': defending.primaryColor, '--trim': defending.secondaryColor } as CSSProperties}>
                    <span className="replay-shadow" /><span className="replay-legs" /><span className="replay-stick" /><span className="replay-blade" /><span className="replay-body">{rp.player.number}</span><span className="replay-head" /><span className="replay-helmet" /><span className="replay-helmet-cage" />
                  </div>
                ))}
                {scenario.goalie.present && (
                  <div className="replay-goalie" style={{ animation: `gk-${take} ${scenario.dur}s ease-out both` }}>
                    <span className="replay-goalie-pad" /><span className="replay-goalie-body" /><span className="replay-goalie-mask" /><span className="replay-goalie-glove" />
                  </div>
                )}
                <div className="replay-puck" style={{ animation: `puck-${take} ${scenario.dur}s cubic-bezier(.2,.6,.2,1) both` }} />
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
          <div className="flex items-center gap-2 shrink-0"><Button size="sm" onClick={() => setTake((v) => v + 1)}>↻ Повторить</Button><Button size="sm" variant="primary" onClick={onClose}>Продолжить матч <Icon name="play" /></Button></div>
        </div>
      </div>
      <style>{css}</style>
    </div>
  );
}

const STATIC_CSS = `
  .replay-arena-glow{background:radial-gradient(ellipse at 50% 6%,rgba(90,150,200,.30),transparent 55%),linear-gradient(180deg,#0c1d2e 0%,#06101b 100%)}
  .replay-camera{height:clamp(320px,56vw,580px);max-height:66vh;perspective:1000px;perspective-origin:50% 34%;overflow:hidden;position:relative;background:radial-gradient(130% 90% at 50% 0%,#0d2538,#06101b 72%)}
  .replay-rink{position:absolute;left:3%;right:3%;top:7%;bottom:2%;transform-style:preserve-3d;border-radius:30px}
  .replay-slab{position:absolute;inset:0;border-radius:30px;background:linear-gradient(160deg,#0c1722,#060c14);transform:translateZ(-30px);box-shadow:0 40px 55px #000b}
  .replay-board{position:absolute;inset:-1.6%;border-radius:32px;background:linear-gradient(160deg,#eef4f8,#9fb2bf 30%,#eef4f8 70%,#7f94a3);transform:translateZ(-3px);box-shadow:inset 0 0 0 4px #fff,0 6px 14px #0008}
  .replay-ice{position:absolute;inset:0;overflow:hidden;border-radius:26px;background:repeating-linear-gradient(0deg,rgba(60,105,130,.03) 0 3px,transparent 3px 7px),radial-gradient(120% 100% at 50% 26%,#eaf6fa,#cfe6ee 62%,#bcd7e0);box-shadow:inset 0 0 0 4px #e9eff3,inset 0 18px 38px #ffffff86}
  .replay-center-line,.replay-blue-line{position:absolute;top:0;bottom:0;width:1.1%;left:50%;background:#df3b46;opacity:.9}.replay-blue-line{background:#3979bc;width:.7%}.replay-blue-left{left:27%}.replay-blue-right{left:73%}
  .replay-center-circle,.replay-red-circle{position:absolute;width:18%;aspect-ratio:1;border:2px solid #d84b55;border-radius:50%;left:41%;top:36%;background:transparent}.replay-red-circle{width:9%;left:12%;top:39%;border-color:#d84b55}.replay-circle-right{left:79%}
  .replay-goal-crease{position:absolute;right:0;top:39%;height:22%;width:10%;border:2px solid #6aa6d4;border-right:0;border-radius:50% 0 0 50%;background:#9fcbe533}
  .replay-crease-left{left:0;right:auto;top:39%;border-left:0;border-radius:0 50% 50% 0}
  .replay-goal-net{position:absolute;right:-.5%;top:42%;width:7%;height:16%;border:2px solid var(--defend);border-left:0;background:repeating-linear-gradient(0deg,transparent 0 5px,#8ba3b2 5px 6px),repeating-linear-gradient(90deg,transparent 0 5px,#8ba3b2 5px 6px);transform:translateZ(6px);box-shadow:0 6px 12px #0007}.replay-goal-net span{position:absolute;inset:0;background:#fff4}
  .replay-goal-net-left{right:auto;left:-.5%;border:2px solid var(--attack);border-right:0}
  .replay-goal-frame{position:absolute;right:-.5%;top:41%;width:1.6%;height:18%;background:linear-gradient(var(--defend),color-mix(in srgb,var(--defend) 60%,#000));transform:translateZ(11px);border-radius:2px;box-shadow:0 0 7px #0003}
  .replay-goal-frame-left{right:auto;left:-.5%}
  .replay-skater{position:absolute;width:26px;height:46px;z-index:5;transform:translate(-50%,-50%) rotateX(-57deg);transform-style:preserve-3d}
  .replay-shadow{position:absolute;left:-8px;bottom:-4px;width:42px;height:18px;background:radial-gradient(closest-side,#22384a99,transparent);filter:blur(2px);transform:translateZ(-1px)}
  .replay-legs{position:absolute;left:4px;top:25px;width:18px;height:15px}
  .replay-legs::before,.replay-legs::after{content:"";position:absolute;top:0;width:6px;height:13px;background:linear-gradient(#33454f,#16222e);border-radius:3px 3px 2px 2px;box-shadow:inset 1px 0 0 #0004,0 13px 0 -3px #d7e0e6}
  .replay-legs::before{left:1px;transform:rotate(9deg)}
  .replay-legs::after{right:1px;transform:rotate(-9deg)}
  .replay-body{position:absolute;left:3px;top:11px;width:19px;height:20px;border-radius:7px 7px 6px 6px;background:linear-gradient(180deg,color-mix(in srgb,var(--jersey) 92%,#fff) 0 8%,var(--jersey) 32%,color-mix(in srgb,var(--jersey) 78%,#000) 100%);border:1px solid #16222e;color:#fff;font:700 8px/20px Arial;text-align:center;box-shadow:inset 2px 0 3px #fff3,inset -2px 0 3px #0005,2px 0 0 color-mix(in srgb,var(--jersey) 70%,#000),4px 0 0 color-mix(in srgb,var(--jersey) 55%,#000),0 4px 6px #0007;overflow:hidden}
  .replay-flipped .replay-body{transform:scaleX(-1)}
  .replay-head{position:absolute;left:7px;top:3px;width:12px;height:12px;border-radius:50% 50% 48% 48%;background:radial-gradient(circle at 35% 28%,#f6dcc0,#b1886a 66%,#865f49 100%);border:1px solid #182432;box-shadow:inset -2px -2px 3px #0004,inset 1px 1px 2px #fff6}
  .replay-helmet{position:absolute;left:4px;top:0;width:18px;height:11px;border-radius:9px 9px 5px 5px;background:linear-gradient(180deg,#fff3 0 1px,var(--jersey) 14%,color-mix(in srgb,var(--jersey) 72%,#000) 100%);border:1px solid #16222e;box-shadow:inset 0 1px 0 #fff6,0 1px 1px #0007,0 0 0 1px #0003}
  .replay-helmet::after{content:"";position:absolute;left:5px;top:2.5px;width:8px;height:4px;border-radius:3px;background:radial-gradient(circle at 50% 40%,#fff9,transparent 70%)}
  .replay-helmet-cage{position:absolute;left:6px;top:10px;width:14px;height:5px;border-radius:0 0 4px 4px;background:repeating-linear-gradient(90deg,#cdd6dd 0 1px,transparent 1px 2px);opacity:.85;border-bottom:1px solid #16222e}
  .replay-stick{position:absolute;left:20px;top:18px;width:3px;height:26px;background:linear-gradient(#6b4a32,#3a2716);transform:rotate(-32deg);transform-origin:top;border-radius:2px;box-shadow:0 0 1px #000;translate:0 -2px}
  .replay-blade{position:absolute;left:11px;top:40px;width:14px;height:4px;background:linear-gradient(#3a3f45,#1c2024);border-radius:3px;transform:rotate(-12deg);box-shadow:0 1px 1px #0006}
  .replay-shooter .replay-body{filter:drop-shadow(0 0 6px #fff8)}
  .replay-goalie{position:absolute;width:42px;height:30px;z-index:7;transform:translate(-50%,-50%) rotateX(-57deg);transform-style:preserve-3d}
  .replay-goalie-body{position:absolute;left:8px;top:2px;width:21px;height:20px;border-radius:9px;background:linear-gradient(90deg,var(--defend),#fff,var(--defend));border:2px solid #24394c}
  .replay-goalie-mask{position:absolute;left:14px;top:-9px;width:14px;height:14px;border-radius:8px 8px 5px 5px;background:linear-gradient(180deg,#fff3 0 1px,var(--defend) 16%,color-mix(in srgb,var(--defend) 65%,#000) 100%);border:1px solid #24394c;box-shadow:inset 0 0 0 1px #fff5,0 1px 2px #0007}
  .replay-goalie-mask::after{content:"";position:absolute;inset:2.5px;border-radius:3px;background:repeating-linear-gradient(0deg,transparent 0 1px,#0b1622 1px 2px),repeating-linear-gradient(90deg,transparent 0 1px,#0b1622 1px 2px);opacity:.85}
  .replay-goalie-pad{position:absolute;left:0;top:13px;width:42px;height:13px;border-radius:9px;background:#e8edf1;border:2px solid var(--defend)}
  .replay-goalie-glove{position:absolute;left:30px;top:4px;width:10px;height:10px;border-radius:50%;background:#e8edf1;border:2px solid var(--defend);box-shadow:0 0 4px #0005}
  .replay-puck{position:absolute;width:11px;height:7px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#3a3f45,#070a0d 70%);box-shadow:inset 0 -1px 0 #000,0 0 0 1px #000,0 6px 6px #0007,0 0 12px #0006;z-index:14}
  .replay-puck::after{content:"";position:absolute;left:-3px;top:9px;width:16px;height:6px;background:radial-gradient(closest-side,#1b2c3a99,transparent);filter:blur(2px);border-radius:50%}
  .replay-goalflash{position:absolute;inset:0;z-index:30;display:grid;place-items:center;pointer-events:none;font:800 clamp(40px,9vw,96px)/1 'Oswald',Arial;letter-spacing:.04em;color:#fff;text-shadow:0 0 18px #ff2b3a,0 4px 0 #7a0c14;opacity:0}
  .replay-assist .replay-body{box-shadow:0 0 0 2px #ffd34d,0 0 10px #ffd34daa,2px 0 0 color-mix(in srgb,var(--jersey) 70%,#000),4px 0 0 color-mix(in srgb,var(--jersey) 55%,#000),0 4px 6px #0007}
  .replay-assist .replay-head{box-shadow:inset -2px -2px 3px #0004,inset 1px 1px 2px #fff6,0 0 0 1px #ffd34d}
  @media(prefers-reduced-motion:reduce){.replay-skater,.replay-puck,.replay-goalie,.replay-rink,.replay-goalflash{animation-duration:1ms!important;animation-delay:0ms!important;animation-iteration-count:1!important}}
`;
