import { useState } from 'react';
import type { GameEvent, Player, Team } from '../types';
import type { LiveStats } from '../game/live';
import { cn } from '../utils/cn';
import { TeamLogo } from './ui';

export type BreakTally = Record<'faceoff' | 'block' | 'takeaway' | 'icing' | 'offside', [number, number]>;
export type BreakSide = { live: LiveStats; tally: BreakTally | null; events: GameEvent[] };

const periodTitle = (p: number) => (p <= 3 ? `${p}-й период` : p === 4 ? 'Овертайм' : `Овертайм ${p - 3}`);

/**
 * Statistics in the intermission window: the period that has just ended and the whole match so far.
 * Two-sided bars like a TV stat graphic, then the goals and penalties (and the goalies for the match).
 */
export function BreakStats({ period, match, periodNo, home, away, players, onInteract }: {
  period: BreakSide; match: BreakSide; periodNo: number; home: Team; away: Team; players: Record<string, Player>;
  /** the viewer is reading the stats: the automatic continue stops */
  onInteract?: () => void;
}) {
  const [tab, setTab] = useState<'period' | 'match'>('period');
  const d = tab === 'period' ? period : match;
  const L = d.live, T = d.tally;
  const pct = (a: number, b: number) => (a + b ? Math.round((a / (a + b)) * 100) : 0);
  const rows: [string, number | string, number | string, number, number][] = [
    ['Голы', L.score[0], L.score[1], L.score[0], L.score[1]],
    ['Броски в створ', L.shots[0], L.shots[1], L.shots[0], L.shots[1]],
    ['Ожидаемые голы (xG)', L.xg[0].toFixed(2), L.xg[1].toFixed(2), L.xg[0], L.xg[1]],
    ['Опасные моменты', L.dangerShots[0], L.dangerShots[1], L.dangerShots[0], L.dangerShots[1]],
    ['Большинство', `${L.ppGoals[0]}/${L.ppChances[0]}`, `${L.ppGoals[1]}/${L.ppChances[1]}`, L.ppChances[0], L.ppChances[1]],
    ['Штрафные минуты', L.pim[0], L.pim[1], L.pim[0], L.pim[1]],
    ['Силовые приёмы', L.hits[0], L.hits[1], L.hits[0], L.hits[1]],
  ];
  if (T) {
    rows.push(['Вбрасывания', `${T.faceoff[0]} (${pct(T.faceoff[0], T.faceoff[1])}%)`, `${T.faceoff[1]} (${pct(T.faceoff[1], T.faceoff[0])}%)`, T.faceoff[0], T.faceoff[1]]);
    rows.push(['Блокированные броски', T.block[0], T.block[1], T.block[0], T.block[1]]);
    rows.push(['Отборы и перехваты', T.takeaway[0], T.takeaway[1], T.takeaway[0], T.takeaway[1]]);
  }
  const teamOf = (id: string | null) => (id === home.id ? home : id === away.id ? away : null);
  const name = (id?: string) => (id && players[id] ? players[id].name : '—');
  const goals = d.events.filter(e => e.type === 'goal');
  const pens = d.events.filter(e => e.type === 'penalty');
  const byPeriod = (list: GameEvent[]) => {
    const out = new Map<number, GameEvent[]>();
    for (const e of list) out.set(e.period, [...(out.get(e.period) ?? []), e]);
    return [...out.entries()].sort((a, b) => a[0] - b[0]);
  };
  const goalRow = (e: GameEvent, i: number) => {
    const t = teamOf(e.team);
    const assists = (e.players ?? []).map(name).filter(n => n !== '—');
    return (
      <div key={`g${i}`} className="flex items-center gap-2 py-1 text-xs border-t border-line/50 first:border-t-0" data-break-goal>
        <span className="tabular text-muted w-10 shrink-0">{e.time}</span>
        {t && <TeamLogo team={t} size={16} />}
        <span className="min-w-0 flex-1 truncate"><b className="font-semibold">{name(e.player)}</b>{assists.length ? <span className="text-muted"> ({assists.join(', ')})</span> : null}</span>
        {e.strength && e.strength !== 'EV' && <span className="text-[10px] px-1 rounded-sm bg-amber/15 text-amber shrink-0">{e.strength === 'PP' ? 'ЧБ' : e.strength === 'SH' ? 'ЧМ' : e.strength === 'EN' ? 'ПВ' : e.strength}</span>}
        {e.score && <span className="tabular font-display shrink-0">{e.score[0]}:{e.score[1]}</span>}
      </div>
    );
  };
  const penRow = (e: GameEvent, i: number) => {
    const t = teamOf(e.team);
    return (
      <div key={`p${i}`} className="flex items-center gap-2 py-1 text-xs border-t border-line/50 first:border-t-0" data-break-penalty>
        <span className="tabular text-muted w-10 shrink-0">{e.time}</span>
        {t && <TeamLogo team={t} size={16} />}
        <span className="min-w-0 flex-1 truncate">{name(e.player)}</span>
        <span className="tabular text-muted shrink-0">{e.pim ?? 2} мин</span>
      </div>
    );
  };
  const goalieRows = Object.entries(match.live.goalies).filter(([id]) => players[id]);
  return (
    <div className="w-full max-w-md text-left mb-3" data-break-stats={tab} onPointerDown={onInteract}>
      <div className="flex rounded-sm border border-line bg-panel2 p-0.5 mb-2" role="tablist" aria-label="Статистика перерыва">
        {(['period', 'match'] as const).map(k => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} data-break-tab={k} onClick={() => setTab(k)}
            className={cn('flex-1 px-2 py-1.5 text-xs font-semibold rounded-sm', tab === k ? 'bg-ice text-bg' : 'text-muted hover:text-text')}>
            {k === 'period' ? `Статистика: ${periodTitle(periodNo).toLowerCase()}` : 'Статистика матча'}
          </button>
        ))}
      </div>
      <div className="rounded-md border border-line bg-bg/40 px-3 py-2">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-muted pb-1">
          <span className="inline-flex items-center gap-1.5"><TeamLogo team={home} size={16} />{home.short}</span>
          <span>{tab === 'period' ? periodTitle(periodNo) : 'Матч'}</span>
          <span className="inline-flex items-center gap-1.5">{away.short}<TeamLogo team={away} size={16} /></span>
        </div>
        {rows.map(([label, a, b, va, vb]) => {
          const sum = va + vb, left = sum ? (va / sum) * 100 : 50;
          return (
            <div key={label} className="py-1" data-break-row={label}>
              <div className="flex items-baseline justify-between text-xs">
                <span className={cn('tabular font-semibold', va > vb && 'text-ice')}>{a}</span>
                <span className="text-[11px] text-muted">{label}</span>
                <span className={cn('tabular font-semibold', vb > va && 'text-ice')}>{b}</span>
              </div>
              <div className="mt-0.5 flex h-1 rounded-full overflow-hidden bg-line/60">
                <span style={{ width: `${sum ? left : 50}%`, background: sum ? home.primaryColor : 'transparent' }} />
                <span className="flex-1" style={{ background: sum ? away.primaryColor : 'transparent' }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 rounded-md border border-line bg-bg/40 px-3 py-2">
        <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Голы</div>
        {goals.length === 0 ? <div className="text-xs text-muted">Голов не было</div>
          : tab === 'period' ? goals.map(goalRow)
            : byPeriod(goals).map(([p, list]) => <div key={p}><div className="text-[10px] uppercase tracking-wider text-muted mt-1">{periodTitle(p)}</div>{list.map(goalRow)}</div>)}
        <div className="text-[11px] uppercase tracking-wider text-muted mt-2 mb-1">Удаления</div>
        {pens.length === 0 ? <div className="text-xs text-muted">Удалений не было</div> : pens.map(penRow)}
        {tab === 'match' && goalieRows.length > 0 && <>
          <div className="text-[11px] uppercase tracking-wider text-muted mt-2 mb-1">Вратари</div>
          {goalieRows.map(([id, g]) => (
            <div key={id} className="flex items-center gap-2 py-1 text-xs border-t border-line/50 first:border-t-0" data-break-goalie>
              <span className="min-w-0 flex-1 truncate">{name(id)}</span>
              <span className="tabular text-muted">{g.saves}/{g.shotsAgainst} · {g.shotsAgainst ? ((g.saves / g.shotsAgainst) * 100).toFixed(1) : '—'}%</span>
            </div>
          ))}
        </>}
      </div>
    </div>
  );
}
