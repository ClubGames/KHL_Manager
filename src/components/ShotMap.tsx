import { useMemo, useState } from 'react';
import type { Player, ShotPoint, ShotZone, Team } from '../types';
import { visibleClubColor } from '../game/clubColors';
import { cn } from '../utils/cn';

const ZONE_RU: Record<ShotZone, string> = {
  crease: 'Пятак',
  slot: 'Слот',
  circles: 'Круги вбрасывания',
  point: 'Синяя линия',
  perimeter: 'Периметр',
};

const SHOT_RU: Record<string, string> = {
  wrist: 'кистевой',
  slap: 'щелчок',
  snap: 'сходу',
  backhand: 'с неудобной',
  tip: 'подправление',
  rebound: 'добивание',
};

export function ShotMap({
  shots,
  home,
  away,
  players,
  compact = false,
}: {
  shots: ShotPoint[];
  home: Team;
  away: Team;
  players: Record<string, Player>;
  compact?: boolean;
}) {
  const [mode, setMode] = useState<'xg' | 'heat'>('xg');
  const [teamFilter, setTeamFilter] = useState<'all' | 0 | 1>('all');
  const [periodFilter, setPeriodFilter] = useState<number>(0);
  const [onlyDanger, setOnlyDanger] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  const homeColor = visibleClubColor(home, '#38BDF8');
  const awayColor = visibleClubColor(away, '#F87171');
  const effAwayColor = awayColor.toLowerCase() === homeColor.toLowerCase() ? '#F59E0B' : awayColor;

  const maxPeriod = useMemo(() => Math.max(3, ...shots.map((s) => s.period)), [shots]);

  const filtered = useMemo(() => {
    return shots.filter((s) => {
      if (teamFilter !== 'all' && s.t !== teamFilter) return false;
      if (periodFilter > 0 && s.period !== periodFilter) return false;
      if (onlyDanger && s.xg < 0.12 && s.outcome !== 'goal') return false;
      return true;
    });
  }, [shots, teamFilter, periodFilter, onlyDanger]);

  const totals = useMemo(() => {
    let hxg = 0, axg = 0, hd = 0, ad = 0, hs = 0, as_ = 0;
    const zones: Record<'slotCrease' | 'circles' | 'point', [number, number]> = {
      slotCrease: [0, 0],
      circles: [0, 0],
      point: [0, 0],
    };
    for (const s of shots) {
      if (periodFilter > 0 && s.period !== periodFilter) continue;
      if (s.t === 0) {
        hxg += s.xg;
        hs++;
        if (s.xg >= 0.12) hd++;
      } else {
        axg += s.xg;
        as_++;
        if (s.xg >= 0.12) ad++;
      }
      const zk = s.zone === 'crease' || s.zone === 'slot' ? 'slotCrease' : s.zone === 'circles' ? 'circles' : 'point';
      zones[zk][s.t]++;
    }
    return { hxg, axg, hd, ad, hs, as: as_, zones };
  }, [shots, periodFilter]);

  // Smooth 2D Gaussian kernel heatmap on a 32x16 grid over viewBox 200x100
  const heatCells = useMemo(() => {
    if (mode !== 'heat' || !filtered.length) return [];
    const cols = 32;
    const rows = 16;
    const cw = 200 / cols;
    const ch = 100 / rows;
    const grid = new Float64Array(cols * rows);
    const sigma2 = 2 * 11.5 * 11.5;
    let peak = 0;
    for (let r = 0; r < rows; r++) {
      const cy = (r + 0.5) * ch;
      for (let c = 0; c < cols; c++) {
        const cx = (c + 0.5) * cw;
        let val = 0;
        for (const s of filtered) {
          const sx = s.x * 2;
          const sy = s.y;
          const d2 = (cx - sx) * (cx - sx) + (cy - sy) * (cy - sy);
          if (d2 > 620) continue;
          const weight = 0.55 + s.xg * 3.2;
          val += weight * Math.exp(-d2 / sigma2);
        }
        grid[r * cols + c] = val;
        if (val > peak) peak = val;
      }
    }
    if (peak <= 0.001) return [];
    const out: { x: number; y: number; w: number; h: number; fill: string; opacity: number }[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const norm = grid[r * cols + c] / peak;
        if (norm < 0.08) continue;
        let fill = '#38BDF8';
        if (norm >= 0.72) fill = '#EF4444';
        else if (norm >= 0.48) fill = '#F97316';
        else if (norm >= 0.26) fill = '#FACC15';
        out.push({
          x: c * cw,
          y: r * ch,
          w: cw + 0.4,
          h: ch + 0.4,
          fill,
          opacity: Math.min(0.78, 0.16 + norm * 0.66),
        });
      }
    }
    return out;
  }, [mode, filtered]);

  const activeShot = selectedIdx !== null && filtered[selectedIdx] ? filtered[selectedIdx] : filtered[filtered.length - 1] ?? null;
  const totalXgSum = totals.hxg + totals.axg;
  const homeXgPct = totalXgSum > 0 ? Math.round((totals.hxg / totalXgSum) * 100) : 50;

  return (
    <div data-shot-map className="space-y-2.5">
      {/* Controls bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="inline-flex rounded-md border border-line bg-bg/70 p-0.5">
          <button
            type="button"
            onClick={() => setMode('xg')}
            className={cn(
              'px-2.5 py-1 rounded text-[11px] font-semibold transition cursor-pointer',
              mode === 'xg' ? 'bg-accent text-white' : 'text-muted hover:text-ice'
            )}
          >
            Мини-карта xG
          </button>
          <button
            type="button"
            onClick={() => setMode('heat')}
            className={cn(
              'px-2.5 py-1 rounded text-[11px] font-semibold transition cursor-pointer',
              mode === 'heat' ? 'bg-red text-white' : 'text-muted hover:text-ice'
            )}
          >
            Тепловая карта
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="inline-flex rounded-md border border-line bg-bg/70 p-0.5">
            {([
              ['all', 'Обе'],
              [0, home.short],
              [1, away.short],
            ] as const).map(([val, lbl]) => (
              <button
                key={String(val)}
                type="button"
                onClick={() => {
                  setTeamFilter(val);
                  setSelectedIdx(null);
                }}
                className={cn(
                  'px-2 py-0.5 rounded text-[11px] font-semibold transition cursor-pointer',
                  teamFilter === val ? 'bg-panel2 text-ice border border-line/80' : 'text-muted hover:text-ice'
                )}
              >
                {lbl}
              </button>
            ))}
          </div>

          <div className="inline-flex rounded-md border border-line bg-bg/70 p-0.5">
            <button
              type="button"
              onClick={() => setPeriodFilter(0)}
              className={cn('px-1.5 py-0.5 rounded text-[11px] cursor-pointer', periodFilter === 0 ? 'bg-panel2 text-ice font-semibold' : 'text-muted hover:text-ice')}
            >
              Все
            </button>
            {[1, 2, 3, ...(maxPeriod > 3 ? [4] : [])].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriodFilter(p)}
                className={cn('px-1.5 py-0.5 rounded text-[11px] cursor-pointer', periodFilter === p ? 'bg-panel2 text-ice font-semibold' : 'text-muted hover:text-ice')}
              >
                {p <= 3 ? `${p}П` : 'ОТ'}
              </button>
            ))}
          </div>

          {mode === 'xg' && (
            <button
              type="button"
              onClick={() => setOnlyDanger((v) => !v)}
              className={cn(
                'px-2 py-1 rounded border text-[11px] font-medium transition cursor-pointer',
                onlyDanger ? 'border-gold/60 bg-gold/15 text-gold' : 'border-line bg-bg/60 text-muted hover:text-ice'
              )}
            >
              Опасные (xG ≥ 0.12)
            </button>
          )}
        </div>
      </div>

      {/* Direction header */}
      <div className="flex items-center justify-between text-[11px] px-1">
        <span className="flex items-center gap-1.5 font-medium" style={{ color: effAwayColor }}>
          <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: effAwayColor }} />
          ← Атака {away.short} ({totals.axg.toFixed(2)} xG · {totals.ad} опасн.)
        </span>
        <span className="flex items-center gap-1.5 font-medium" style={{ color: homeColor }}>
          ({totals.hxg.toFixed(2)} xG · {totals.hd} опасн.) Атака {home.short} →
          <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: homeColor }} />
        </span>
      </div>

      {/* Ice Rink SVG */}
      <div className="relative rounded-xl border border-line bg-[#0B1726] overflow-hidden shadow-inner">
        <svg viewBox="0 0 200 100" className={cn('w-full block select-none', compact ? 'max-h-48' : 'max-h-60')}>
          <defs>
            <clipPath id="khl-rink-clip">
              <rect x="2" y="2" width="196" height="96" rx="28" ry="28" />
            </clipPath>
            <filter id="heat-blur" x="-15%" y="-15%" width="130%" height="130%">
              <feGaussianBlur stdDeviation="3.2" />
            </filter>
          </defs>

          <g clipPath="url(#khl-rink-clip)">
            {/* Ice surface */}
            <rect x="2" y="2" width="196" height="96" fill="#0E1E32" />
            <rect x="2" y="2" width="196" height="96" fill="url(#ice-grad)" opacity="0.3" />

            {/* Heatmap layer */}
            {mode === 'heat' && heatCells.length > 0 && (
              <g filter="url(#heat-blur)">
                {heatCells.map((c, idx) => (
                  <rect key={idx} x={c.x} y={c.y} width={c.w} height={c.h} fill={c.fill} opacity={c.opacity} />
                ))}
              </g>
            )}

            {/* Rink markings */}
            {/* Goal lines */}
            {/* Real IIHF/KHL proportions: 200 × 100 units = 60 × 30 m */}
            <line x1="13.3" y1="2" x2="13.3" y2="98" stroke="#EF4444" strokeOpacity="0.45" strokeWidth="0.7" />
            <line x1="186.7" y1="2" x2="186.7" y2="98" stroke="#EF4444" strokeOpacity="0.45" strokeWidth="0.7" />
            {/* Blue lines */}
            <line x1="75.7" y1="2" x2="75.7" y2="98" stroke="#38BDF8" strokeOpacity="0.45" strokeWidth="1" />
            <line x1="124.3" y1="2" x2="124.3" y2="98" stroke="#38BDF8" strokeOpacity="0.45" strokeWidth="1" />
            {/* Center red line & circle */}
            <line x1="100" y1="2" x2="100" y2="98" stroke="#EF4444" strokeOpacity="0.5" strokeWidth="1.1" strokeDasharray="3 2" />
            <circle cx="100" cy="50" r="15" fill="none" stroke="#38BDF8" strokeOpacity="0.32" strokeWidth="0.8" />
            <circle cx="100" cy="50" r="1.3" fill="#38BDF8" fillOpacity="0.6" />

            {/* End-zone faceoff circles */}
            {[
              [33.3, 26.7],
              [33.3, 73.3],
              [166.7, 26.7],
              [166.7, 73.3],
            ].map(([cx, cy], idx) => (
              <g key={idx}>
                <circle cx={cx} cy={cy} r="15" fill="none" stroke="#EF4444" strokeOpacity="0.28" strokeWidth="0.7" />
                <circle cx={cx} cy={cy} r="1.1" fill="#EF4444" fillOpacity="0.55" />
              </g>
            ))}

            {/* Neutral-zone faceoff dots (offsides) */}
            {[[81.2, 26.7], [81.2, 73.3], [118.8, 26.7], [118.8, 73.3]].map(([cx, cy], idx) => (
              <circle key={idx} cx={cx} cy={cy} r="1" fill="#EF4444" fillOpacity="0.5" />
            ))}

            {/* High-danger slot outlines (subtle tactical guide) */}
            <polygon points="13.3,40 46,32 46,68 13.3,60" fill="none" stroke="#93A4BC" strokeOpacity="0.14" strokeDasharray="2 2" strokeWidth="0.6" />
            <polygon points="186.7,40 154,32 154,68 186.7,60" fill="none" stroke="#93A4BC" strokeOpacity="0.14" strokeDasharray="2 2" strokeWidth="0.6" />

            {/* Goal creases & nets */}
            <path d="M 13.3 43.9 A 6.1 6.1 0 0 1 13.3 56.1 Z" fill="#38BDF8" fillOpacity="0.22" stroke="#38BDF8" strokeOpacity="0.6" strokeWidth="0.7" />
            <rect x="9.6" y="46.95" width="3.7" height="6.1" rx="1" fill="none" stroke="#E8EEF5" strokeOpacity="0.7" strokeWidth="0.8" />
            <path d="M 186.7 43.9 A 6.1 6.1 0 0 0 186.7 56.1 Z" fill="#38BDF8" fillOpacity="0.22" stroke="#38BDF8" strokeOpacity="0.6" strokeWidth="0.7" />
            <rect x="186.7" y="46.95" width="3.7" height="6.1" rx="1" fill="none" stroke="#E8EEF5" strokeOpacity="0.7" strokeWidth="0.8" />

            {/* Shot markers */}
            {filtered.map((s, idx) => {
              const cx = s.x * 2;
              const cy = s.y;
              const col = s.t === 0 ? homeColor : effAwayColor;
              const isGoal = s.outcome === 'goal';
              const isDanger = s.xg >= 0.12;
              const isSel = selectedIdx === idx;
              if (mode === 'heat' && !isGoal) {
                return <circle key={idx} cx={cx} cy={cy} r={1.1} fill="#E8EEF5" fillOpacity={0.38} />;
              }
              const r = Math.max(1.9, Math.min(6.4, 1.6 + Math.sqrt(s.xg) * 8.2));
              return (
                <g
                  key={idx}
                  onMouseEnter={() => setSelectedIdx(idx)}
                  onClick={() => setSelectedIdx(idx)}
                  className="cursor-pointer"
                >
                  {isDanger && !isGoal && (
                    <circle cx={cx} cy={cy} r={r + 1.8} fill="none" stroke={col} strokeOpacity="0.45" strokeWidth="0.7" />
                  )}
                  {isGoal ? (
                    <>
                      <circle cx={cx} cy={cy} r={r + 2.2} fill="#F5B82E" fillOpacity="0.28" />
                      <circle cx={cx} cy={cy} r={r + 0.5} fill={col} stroke="#F5B82E" strokeWidth="1.35" />
                      <circle cx={cx} cy={cy} r={1.3} fill="#FFF" />
                    </>
                  ) : s.outcome === 'miss' ? (
                    <circle cx={cx} cy={cy} r={r} fill="none" stroke={col} strokeOpacity="0.7" strokeWidth="0.9" strokeDasharray="1.5 1" />
                  ) : (
                    <circle
                      cx={cx}
                      cy={cy}
                      r={r}
                      fill={col}
                      fillOpacity={isDanger ? 0.78 : 0.48}
                      stroke={isSel ? '#FFFFFF' : col}
                      strokeWidth={isSel ? 1.2 : 0.6}
                    />
                  )}
                </g>
              );
            })}
          </g>

          {/* Outer boards */}
          <rect x="2" y="2" width="196" height="96" rx="28" ry="28" fill="none" stroke="#2B4263" strokeWidth="1.5" />
        </svg>

        {filtered.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted pointer-events-none bg-bg/35">
            Бросков по выбранному фильтру пока нет
          </div>
        )}
      </div>

      {/* Selected / latest shot inspector */}
      {activeShot && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line/70 bg-bg/55 px-3 py-1.5 text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="inline-block w-2 h-2 rounded-full shrink-0"
              style={{ background: activeShot.t === 0 ? homeColor : effAwayColor }}
            />
            <span className="text-muted tabular-nums">
              {activeShot.period <= 3 ? `${activeShot.period}-й пер.` : 'ОТ'} {activeShot.time}
            </span>
            <span className="font-medium truncate">
              {activeShot.player ? players[activeShot.player]?.name ?? 'Игрок' : 'Бросок'}
            </span>
            <span className="text-muted hidden sm:inline">
              · {ZONE_RU[activeShot.zone]} ({SHOT_RU[activeShot.shotType ?? 'wrist'] ?? 'бросок'})
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={cn('font-display font-bold tabular-nums', activeShot.xg >= 0.12 ? 'text-gold' : 'text-ice')}>
              xG {activeShot.xg.toFixed(2)}
            </span>
            <span
              className={cn(
                'px-1.5 py-0.5 rounded text-[10px] font-bold uppercase',
                activeShot.outcome === 'goal'
                  ? 'bg-gold/25 text-gold border border-gold/50'
                  : activeShot.outcome === 'save'
                    ? 'bg-accent/15 text-accent'
                    : 'bg-panel2 text-muted'
              )}
            >
              {activeShot.outcome === 'goal' ? 'ГОЛ' : activeShot.outcome === 'save' ? 'Сейв' : 'Мимо'}
            </span>
          </div>
        </div>
      )}

      {/* Legend & xG balance bar */}
      <div className="space-y-1.5 pt-0.5">
        <div className="flex items-center justify-between text-[11px] text-muted">
          <span>
            Ожидаемые голы (xG): <b className="text-ice tabular-nums">{totals.hxg.toFixed(2)}</b> ({home.short}) —{' '}
            <b className="text-ice tabular-nums">{totals.axg.toFixed(2)}</b> ({away.short})
          </span>
          <span className="hidden sm:inline">
            Пятак/слот: <b className="text-ice tabular-nums">{totals.zones.slotCrease[0]}:{totals.zones.slotCrease[1]}</b> · Синяя:{' '}
            <b className="text-ice tabular-nums">{totals.zones.point[0]}:{totals.zones.point[1]}</b>
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-bg overflow-hidden flex">
          <div style={{ width: `${homeXgPct}%`, background: homeColor }} className="transition-all duration-300" />
          <div style={{ width: `${100 - homeXgPct}%`, background: effAwayColor }} className="transition-all duration-300" />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted">
          <span className="inline-flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full border-2 border-gold bg-accent inline-block" /> Гол
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full ring-1 ring-accent bg-accent/75 inline-block" /> Опасный момент (xG ≥ 0.12)
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-muted/60 inline-block" /> Сейв (размер = xG)
          </span>
          {mode === 'heat' && <span className="text-gold">Палитра тепла: голубой → жёлтый → красный (пик угроз)</span>}
        </div>
      </div>
    </div>
  );
}
