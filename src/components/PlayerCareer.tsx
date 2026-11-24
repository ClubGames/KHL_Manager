import { useState } from 'react';
import type { Player } from '../types';
import { careerClubs, careerRows, sumRows, type CareerRow } from '../game/careerStats';
import { useGame } from '../game/state';
import { TeamLogo, useUI } from './ui';
import { cn } from '../utils/cn';

type Stage = 'regular' | 'playoff';

const dash = '—';
const num = (v: number | undefined) => (v === undefined ? dash : String(v));
const signed = (v: number | undefined) => (v === undefined ? dash : v > 0 ? `+${v}` : String(v));
const svPct = (saves?: number, sa?: number) => (saves === undefined || !sa ? dash : ((saves / sa) * 100).toFixed(1));
const gaa = (saves?: number, sa?: number, min?: number) => (saves === undefined || sa === undefined || !min ? dash : (((sa - saves) * 60) / min).toFixed(2));

/** Career table of a player: every season at every club, regular season and playoffs, plus the clubs of the career. */
export function PlayerCareer({ p }: { p: Player }) {
  const s = useGame()!;
  const ui = useUI();
  const [stage, setStage] = useState<Stage>('regular');
  const all = careerRows(s, p);
  const legacy = all.some((r) => !r.kind);
  const rows = all.filter((r) => (stage === 'playoff' ? r.kind === 'playoff' : r.kind !== 'playoff'));
  const playoffGames = all.some((r) => r.kind === 'playoff' && r.gp > 0);
  const clubs = careerClubs(s, p);
  const isG = p.position === 'G';
  if (!all.length) return null;

  const club = (teamId: string | null) => {
    const t = teamId ? s.teams[teamId] : null;
    if (!t) return <span className="text-muted">{dash}</span>;
    return (
      <button type="button" onClick={() => ui.openTeam(t.id)} className="inline-flex items-center gap-1.5 hover:text-ice min-w-0" title={t.name}>
        <TeamLogo team={t} size={16} />
        <span className="truncate">{t.short}</span>
      </button>
    );
  };
  const full = (key: keyof CareerRow) => rows.every((r) => r[key] !== undefined);
  const tot = sumRows(rows);
  const cells = (r: { gp: number; goals: number; assists: number; wins: number; shutouts: number; plusMinus?: number; pim?: number; shots?: number; losses?: number; otl?: number; saves?: number; shotsAgainst?: number; minutes?: number }) =>
    isG
      ? [num(r.gp), num(r.wins), num(r.losses), num(r.otl), num(r.shutouts), svPct(r.saves, r.shotsAgainst), gaa(r.saves, r.shotsAgainst, r.minutes)]
      : [num(r.gp), num(r.goals), num(r.assists), String(r.goals + r.assists), signed(r.plusMinus), num(r.pim), num(r.shots)];
  const heads = isG ? ['И', 'В', 'П', 'ПО', 'СО', '%ОБ', 'КН'] : ['И', 'Ш', 'П', 'О', '+/−', 'Штр', 'Бр'];
  const totals = {
    ...tot,
    plusMinus: full('plusMinus') ? tot.plusMinus : undefined,
    pim: full('pim') ? tot.pim : undefined,
    shots: full('shots') ? tot.shots : undefined,
    losses: full('losses') ? tot.losses : undefined,
    otl: full('otl') ? tot.otl : undefined,
    saves: full('saves') ? tot.saves : undefined,
    shotsAgainst: full('shotsAgainst') ? tot.shotsAgainst : undefined,
    minutes: full('minutes') ? tot.minutes : undefined,
  };

  return (
    <div className="mt-4 bg-panel2/70 border border-line/70 rounded-sm p-3 text-xs" data-player-career>
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
        <div className="text-[11px] uppercase tracking-wider text-muted">Статистика по сезонам</div>
        <div className="flex gap-1" role="group" aria-label="Этап сезона">
          {(['regular', 'playoff'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={stage === k}
              onClick={() => setStage(k)}
              disabled={k === 'playoff' && !playoffGames}
              className={cn('px-2 py-0.5 rounded border font-semibold transition disabled:opacity-40', stage === k ? 'bg-ice text-bg border-ice' : 'bg-panel border-line text-muted hover:text-text')}
            >
              {k === 'regular' ? 'Регулярка' : 'Плей-офф'}
            </button>
          ))}
        </div>
      </div>
      {clubs.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-2" data-career-clubs>
          <span className="text-muted">Клубы:</span>
          {clubs.map((c, i) => {
            const t = s.teams[c.teamId];
            if (!t) return null;
            return (
              <span key={`${c.teamId}-${i}`} className="inline-flex items-center gap-1">
                {i > 0 && <span className="text-muted">→</span>}
                <button type="button" onClick={() => ui.openTeam(t.id)} className="inline-flex items-center gap-1 rounded-sm border border-line bg-panel px-1.5 py-0.5 hover:border-ice" title={`${t.name}: ${c.gp} матчей`}>
                  <TeamLogo team={t} size={14} />
                  <b>{t.short}</b>
                  <span className="text-muted tabular">{c.from === c.to ? c.from : `${c.from}–${c.to}`}</span>
                </button>
              </span>
            );
          })}
        </div>
      )}
      <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full tabular min-w-[420px]">
          <thead className="text-muted">
            <tr>
              <th className="text-left font-semibold py-0.5">Сезон</th>
              <th className="text-left font-semibold">Клуб</th>
              <th className="text-right font-semibold" title="Рейтинг в конце сезона">ОВР</th>
              {heads.map((h) => (
                <th key={h} className="text-right font-semibold pl-2">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={3 + heads.length} className="py-2 text-center text-muted">{stage === 'playoff' ? 'Игр в плей-офф пока нет' : 'Матчей пока нет'}</td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={`${r.season}-${r.teamId}-${r.kind}-${i}`} className={cn('border-t border-line/50', r.current && 'text-ice')} data-career-row={r.current ? 'current' : 'past'}>
                <td className="py-0.5 whitespace-nowrap">
                  {r.season}
                  {!r.kind && <span className="text-muted" title="Старое сохранение: регулярка и плей-офф вместе"> *</span>}
                  {r.current && <span className="ml-1 text-[10px] uppercase text-muted">идёт</span>}
                </td>
                <td className="max-w-[110px]">{club(r.teamId)}</td>
                <td className="text-right text-muted">{r.overall}</td>
                {cells(r).map((v, k) => (
                  <td key={k} className={cn('text-right pl-2', k === (isG ? 1 : 3) && 'font-semibold')}>{v}</td>
                ))}
              </tr>
            ))}
          </tbody>
          {rows.length > 1 && (
            <tfoot>
              <tr className="border-t border-line font-semibold">
                <td className="py-0.5" colSpan={3}>Всего{stage === 'playoff' ? ' в плей-офф' : ''}</td>
                {cells(totals).map((v, k) => (
                  <td key={k} className="text-right pl-2">{v}</td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {legacy && <div className="mt-1.5 text-[10px] text-muted">* Сезон из старого сохранения: регулярный чемпионат и плей-офф вместе, клуб — на конец сезона.</div>}
    </div>
  );
}
