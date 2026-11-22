import { useMemo, useState } from 'react';
import type { GameState, Lineup } from '../types';
import { compareTeamLineups, type LineComparisonRow, type PPUnitPreview } from '../game/lineupCompare';
import { POS_RU, goalieSavePct } from '../game/ratings';
import { isLegionnaire } from '../game/legionnaires';
import { Panel, Tag, TeamLogo } from './ui';
import { cn } from '../utils/cn';

function shortPlayerName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}

function EdgeBadge({ edge }: { edge: number }) {
  if (Math.abs(edge) < 0.6) return <span className="px-1.5 py-0.5 rounded bg-panel2 text-muted text-[11px] font-semibold tabular-nums">≈ 0.0</span>;
  const pos = edge > 0;
  return (
    <span
      className={cn(
        'px-1.5 py-0.5 rounded text-[11px] font-bold tabular-nums',
        pos ? 'bg-good/20 text-good border border-good/40' : 'bg-bad/20 text-bad border border-bad/40'
      )}
    >
      {pos ? `+${edge.toFixed(1)}` : edge.toFixed(1)}
    </span>
  );
}

function OffensiveZonePPRink({ unit, color }: { unit: PPUnitPreview; color: string }) {
  return (
    <div className="relative rounded-xl border border-line bg-[#0B1726] overflow-hidden">
      <svg viewBox="0 0 120 100" className="w-full max-h-56 block select-none">
        {/* Offensive zone ice */}
        <rect x="2" y="2" width="116" height="96" rx="14" fill="#0E1E32" stroke="#2B4263" strokeWidth="1.3" />
        {/* Blue line on left */}
        <line x1="14" y1="2" x2="14" y2="98" stroke="#38BDF8" strokeOpacity="0.55" strokeWidth="1.6" />
        <text x="8" y="50" fill="#38BDF8" fillOpacity="0.5" fontSize="4.2" textAnchor="middle" transform="rotate(-90 8 50)">
          СИНЯЯ ЛИНИЯ
        </text>
        {/* Goal line on right */}
        <line x1="104" y1="4" x2="104" y2="96" stroke="#EF4444" strokeOpacity="0.5" strokeWidth="0.9" />
        {/* Crease & Net */}
        <path d="M 104 42 A 8 8 0 0 0 104 58 Z" fill="#38BDF8" fillOpacity="0.25" stroke="#38BDF8" strokeOpacity="0.7" strokeWidth="0.8" />
        <rect x="104" y="45" width="4.5" height="10" rx="1" fill="none" stroke="#E8EEF5" strokeOpacity="0.8" strokeWidth="0.9" />

        {/* Faceoff circles */}
        {[26, 74].map((cy, idx) => (
          <g key={idx}>
            <circle cx="76" cy={cy} r="14" fill="none" stroke="#EF4444" strokeOpacity="0.28" strokeWidth="0.7" />
            <circle cx="76" cy={cy} r="1.2" fill="#EF4444" fillOpacity="0.6" />
          </g>
        ))}

        {/* Tactical passing seams (1-3-1 umbrella) */}
        <g stroke="#38BDF8" strokeOpacity="0.22" strokeWidth="0.7" strokeDasharray="2 1.5">
          <line x1="34" y1="50" x2="74" y2="23" />
          <line x1="34" y1="50" x2="74" y2="77" />
          <line x1="74" y1="77" x2="67" y2="50" />
          <line x1="74" y1="77" x2="74" y2="23" />
          <line x1="74" y1="23" x2="96" y2="50" />
          <line x1="67" y1="50" x2="96" y2="50" />
        </g>

        {/* 5 Power Play skaters */}
        {unit.slots.map((s, idx) => {
          const cx = 14 + (s.rx / 100) * 90;
          const cy = s.ry;
          const p = s.player;
          return (
            <g key={idx}>
              {s.oneTimerOptimal && <circle cx={cx} cy={cy} r="7.4" fill="none" stroke="#F5B82E" strokeOpacity="0.65" strokeWidth="0.8" strokeDasharray="1.5 1" />}
              <circle
                cx={cx}
                cy={cy}
                r="5.6"
                fill={p ? color : '#1D2C42'}
                stroke={s.autoFilled ? '#F5B82E' : '#FFFFFF'}
                strokeWidth="1.1"
              />
              <text x={cx} y={cy + 1.6} textAnchor="middle" fill="#FFFFFF" fontSize="4.5" fontWeight="bold">
                {p ? p.overall : '—'}
              </text>
              <rect x={cx - 16} y={cy + 6.5} width="32" height="5.6" rx="1.6" fill="#08111D" fillOpacity="0.86" />
              <text x={cx} y={cy + 10.4} textAnchor="middle" fill="#E8EEF5" fontSize="3.5" fontWeight="600">
                {p ? shortPlayerName(p.name).slice(0, 14) : 'Пусто'}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function CompareLineRow({
  row,
  players,
  onPlayer,
}: {
  row: LineComparisonRow;
  players: GameState['players'];
  onPlayer?: (id: string) => void;
}) {
  return (
    <div className="rounded-lg border border-line/80 bg-bg/45 px-3 py-2 space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-display font-semibold uppercase tracking-wider text-ice">{row.label}</span>
          {row.shareLabel && <span className="text-[11px] text-muted">{row.shareLabel}</span>}
        </div>
        <div className="flex items-center gap-2 text-[11px] tabular-nums">
          <span className="text-ice">
            АТК <b>{row.leftAtt}</b> / ОБ <b>{row.leftDef}</b>
          </span>
          <EdgeBadge edge={row.edge} />
          <span className="text-muted">
            АТК <b className="text-ice">{row.rightAtt}</b> / ОБ <b className="text-ice">{row.rightDef}</b>
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
        <div className="flex flex-wrap gap-1.5">
          {row.leftIds.map((id, idx) => {
            const p = id ? players[id] : null;
            if (!p) return <span key={idx} className="text-bad text-[11px]">пусто</span>;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onPlayer?.(p.id)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-panel2/80 border border-line/70 hover:border-accent/50 transition cursor-pointer"
              >
                <span className="text-[10px] text-accent font-bold">{POS_RU[p.position]}</span>
                <span className="truncate max-w-[115px]">{shortPlayerName(p.name)}</span>
                {isLegionnaire(p) && <span className="text-[9px] text-gold font-bold">ЛЕГ</span>}
                <span className="font-display font-bold text-ice tabular-nums">{p.overall}</span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap gap-1.5 md:justify-end">
          {row.rightIds.map((id, idx) => {
            const p = id ? players[id] : null;
            if (!p) return <span key={idx} className="text-bad text-[11px]">пусто</span>;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onPlayer?.(p.id)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-bg/80 border border-line/60 hover:border-accent/50 transition cursor-pointer"
              >
                <span className="text-[10px] text-muted font-bold">{POS_RU[p.position]}</span>
                <span className="truncate max-w-[115px]">{shortPlayerName(p.name)}</span>
                {isLegionnaire(p) && <span className="text-[9px] text-gold font-bold">ЛЕГ</span>}
                <span className="font-display font-bold text-ice tabular-nums">{p.overall}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function LineupPreview({
  state,
  leftTeamId,
  initialOpponentId,
  overrideLeftLineup,
  allowPickOpponent = true,
  initialTab = 'pp',
  onPlayer,
}: {
  state: GameState;
  leftTeamId: string;
  initialOpponentId?: string;
  overrideLeftLineup?: Lineup;
  allowPickOpponent?: boolean;
  initialTab?: 'pp' | 'compare';
  onPlayer?: (id: string) => void;
}) {
  const defaultOpp = useMemo(() => {
    if (initialOpponentId && state.teams[initialOpponentId] && initialOpponentId !== leftTeamId) return initialOpponentId;
    return state.teamOrder.find((id) => id !== leftTeamId) ?? leftTeamId;
  }, [initialOpponentId, leftTeamId, state.teamOrder, state.teams]);

  const [oppId, setOppId] = useState(defaultOpp);
  const [tab, setTab] = useState<'pp' | 'compare'>(initialTab);
  const [ppSide, setPpSide] = useState<'left' | 'right'>('left');

  const effOppId = allowPickOpponent ? oppId : defaultOpp;
  const cmp = useMemo(
    () => compareTeamLineups(state, leftTeamId, effOppId, overrideLeftLineup),
    [state, leftTeamId, effOppId, overrideLeftLineup]
  );

  const leftTeam = state.teams[leftTeamId];
  const rightTeam = state.teams[effOppId];
  const shownPP = ppSide === 'left' ? cmp.ppUnitsLeft : cmp.ppUnitsRight;
  const shownTeam = ppSide === 'left' ? leftTeam : rightTeam;
  const oppDefForPP = ppSide === 'left' ? cmp.pkRightDef : cmp.pkLeftDef;
  const oppTeamForPP = ppSide === 'left' ? rightTeam : leftTeam;

  return (
    <Panel
      data-lineup-preview
      title="Тактический разбор до матча: звенья и бригады большинства"
      right={
        <div className="flex flex-wrap items-center gap-2">
          {allowPickOpponent && (
            <select
              value={effOppId}
              onChange={(e) => setOppId(e.target.value)}
              className="bg-bg border border-line rounded px-2 py-1 text-xs text-ice"
            >
              {state.teamOrder
                .filter((id) => id !== leftTeamId)
                .map((id) => (
                  <option key={id} value={id}>
                    Соперник: {state.teams[id].name}
                  </option>
                ))}
            </select>
          )}
          <div className="inline-flex rounded-md border border-line bg-bg/70 p-0.5">
            <button
              type="button"
              onClick={() => setTab('pp')}
              className={cn(
                'px-2.5 py-1 rounded text-xs font-semibold transition cursor-pointer',
                tab === 'pp' ? 'bg-accent text-white' : 'text-muted hover:text-ice'
              )}
            >
              Кто выйдет в большинстве
            </button>
            <button
              type="button"
              onClick={() => setTab('compare')}
              className={cn(
                'px-2.5 py-1 rounded text-xs font-semibold transition cursor-pointer',
                tab === 'compare' ? 'bg-accent text-white' : 'text-muted hover:text-ice'
              )}
            >
              Сравнение звеньев
            </button>
          </div>
        </div>
      }
    >
      {tab === 'pp' ? (
        <div data-pp-preview className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs bg-bg/50 border border-line/70 rounded-lg px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-muted">Просмотр расстановки 5×4 (1-3-1):</span>
              <button
                type="button"
                onClick={() => setPpSide('left')}
                className={cn(
                  'px-2 py-0.5 rounded font-semibold cursor-pointer transition',
                  ppSide === 'left' ? 'bg-accent/20 text-accent border border-accent/40' : 'text-muted hover:text-ice'
                )}
              >
                {leftTeam.name}
              </button>
              <button
                type="button"
                onClick={() => setPpSide('right')}
                className={cn(
                  'px-2 py-0.5 rounded font-semibold cursor-pointer transition',
                  ppSide === 'right' ? 'bg-accent/20 text-accent border border-accent/40' : 'text-muted hover:text-ice'
                )}
              >
                {rightTeam.name}
              </button>
            </div>
            <div className="text-muted">
              Против меньшинства {oppTeamForPP.short}: <b className="text-ice">1-я МБ {oppDefForPP[0]}</b> · <b className="text-ice">2-я МБ {oppDefForPP[1]}</b>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
            {shownPP.map((unit) => (
              <div key={unit.unitNumber} className="rounded-xl border border-line bg-bg/35 p-3 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <TeamLogo team={shownTeam} size={26} />
                    <div>
                      <div className="font-display font-bold uppercase tracking-wider text-sm">
                        {unit.unitNumber}-я бригада большинства (PP{unit.unitNumber})
                      </div>
                      <div className="text-[11px] text-muted">Доля игрового времени в ЧБ: ~{unit.sharePct}%</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Tag tone="accent">АТК {unit.attack}</Tag>
                    <Tag tone={unit.expectedPpPct >= 22 ? 'good' : unit.expectedPpPct <= 16 ? 'warn' : 'muted'}>
                      Прогноз ЧБ {unit.expectedPpPct}%
                    </Tag>
                  </div>
                </div>

                <OffensiveZonePPRink unit={unit} color={shownTeam.primaryColor || '#1E88E5'} />

                <div className="divide-y divide-line/50 text-xs">
                  {unit.slots.map((s, idx) => {
                    const p = s.player;
                    return (
                      <div key={idx} className="py-1.5 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] font-bold text-accent w-5">{p ? POS_RU[p.position] : '—'}</span>
                            {p ? (
                              <button
                                type="button"
                                onClick={() => onPlayer?.(p.id)}
                                className="font-medium hover:text-accent truncate cursor-pointer"
                              >
                                {p.name}
                              </button>
                            ) : (
                              <span className="text-bad">Не назначен</span>
                            )}
                            {p && (
                              <span className="text-[10px] px-1 rounded bg-panel2 text-muted">
                                хват {p.hand === 'R' ? 'Прав' : 'Лев'}
                              </span>
                            )}
                            {s.oneTimerOptimal && (
                              <span className="text-[10px] px-1 rounded bg-gold/20 text-gold font-semibold" title="Удобный хват под бросок в касание">
                                В касание ✓
                              </span>
                            )}
                            {s.autoFilled && (
                              <span className="text-[10px] px-1 rounded bg-gold/15 text-gold" title={s.replacedNote}>
                                {s.replacedNote ?? 'автозамена'}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-muted pl-6">{s.role}</div>
                        </div>
                        {p && (
                          <div className="text-right shrink-0 tabular-nums">
                            <span className="font-display font-bold text-sm text-ice">{p.overall}</span>
                            <div className="text-[10px] text-muted">
                              Бр {p.skills.shooting ?? p.overall} · Пас {p.skills.passing ?? p.overall}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div data-lines-compare className="space-y-3">
          {/* Header summary */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-bg/55 px-3.5 py-2.5">
            <div className="flex items-center gap-2.5">
              <TeamLogo team={leftTeam} size={32} />
              <div>
                <div className="font-display font-bold uppercase text-sm">{leftTeam.name}</div>
                <div className="text-[11px] text-muted">Ваша заявка на матч</div>
              </div>
            </div>

            <div className="text-center">
              <div className="text-[11px] uppercase tracking-wider text-muted">Суммарный баланс составов</div>
              <div className="flex items-center justify-center gap-2 mt-0.5">
                <EdgeBadge edge={cmp.totalEdge} />
                <span className="text-xs text-ice font-medium">
                  {cmp.totalEdge > 1.2
                    ? `Перевес ${leftTeam.short}`
                    : cmp.totalEdge < -1.2
                      ? `Перевес ${rightTeam.short}`
                      : 'Равные по силе звенья'}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <div className="text-right">
                <div className="font-display font-bold uppercase text-sm">{rightTeam.name}</div>
                <div className="text-[11px] text-muted">Ожидаемая заявка соперника</div>
              </div>
              <TeamLogo team={rightTeam} size={32} />
            </div>
          </div>

          {/* Forward lines */}
          <div className="space-y-1.5">
            <div className="text-xs font-display uppercase tracking-wider text-muted px-1">Звенья нападения (5×5)</div>
            {cmp.forwards.map((r, i) => (
              <CompareLineRow key={i} row={r} players={state.players} onPlayer={onPlayer} />
            ))}
          </div>

          {/* Defense pairs */}
          <div className="space-y-1.5">
            <div className="text-xs font-display uppercase tracking-wider text-muted px-1">Пары защитников</div>
            {cmp.defense.map((r, i) => (
              <CompareLineRow key={i} row={r} players={state.players} onPlayer={onPlayer} />
            ))}
          </div>

          {/* Goalies & Special Teams summary */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 pt-1">
            <div className="rounded-lg border border-line/80 bg-bg/45 p-3 flex items-center justify-between gap-2 text-xs">
              <div>
                <div className="text-[11px] uppercase font-display tracking-wider text-muted">Дуэль стартовых вратарей</div>
                <div className="mt-1 font-medium">
                  {cmp.goalieLeft ? `${cmp.goalieLeft.name} (${cmp.goalieLeft.overall}, ${(goalieSavePct(cmp.goalieLeft.overall) * 100).toFixed(1)}%)` : 'Замена (55)'}
                </div>
                <div className="text-muted mt-0.5">
                  vs {cmp.goalieRight ? `${cmp.goalieRight.name} (${cmp.goalieRight.overall}, ${(goalieSavePct(cmp.goalieRight.overall) * 100).toFixed(1)}%)` : 'Замена (55)'}
                </div>
              </div>
              <EdgeBadge edge={cmp.goalieEdge} />
            </div>

            <div className="rounded-lg border border-line/80 bg-bg/45 p-3 flex items-center justify-between gap-2 text-xs">
              <div>
                <div className="text-[11px] uppercase font-display tracking-wider text-muted">Спецбригады (ЧБ vs МБ)</div>
                <div className="mt-1 font-medium">
                  {leftTeam.short}: ЧБ1 <b>{cmp.ppUnitsLeft[0].attack}</b> ({cmp.ppUnitsLeft[0].expectedPpPct}%) · МБ1 <b>{cmp.pkLeftDef[0]}</b>
                </div>
                <div className="text-muted mt-0.5">
                  {rightTeam.short}: ЧБ1 <b className="text-ice">{cmp.ppUnitsRight[0].attack}</b> ({cmp.ppUnitsRight[0].expectedPpPct}%) · МБ1 <b className="text-ice">{cmp.pkRightDef[0]}</b>
                </div>
              </div>
              <EdgeBadge edge={+(cmp.ppUnitsLeft[0].expectedPpPct - cmp.ppUnitsRight[0].expectedPpPct).toFixed(1)} />
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}
