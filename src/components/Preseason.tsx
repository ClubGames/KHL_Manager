import { useState } from 'react';
import { playPreseason, useGame } from '../game/state';
import { nextPreseasonRound, preseasonOpen, preseasonTable } from '../game/preseason';
import { Button, Icon, Panel, Tag, TeamLogo, useUI } from './ui';
import { cn } from '../utils/cn';

/** August preseason tournament: try lines and youngsters before the season opener. */
export function PreseasonPanel() {
  const s = useGame()!;
  const ui = useUI();
  const [mode, setMode] = useState<'main' | 'youth'>('main');
  const [last, setLast] = useState<string | null>(null);
  const ps = s.preseason;
  if (!ps || ps.season !== s.league.season || s.phase !== 'season') return null;
  if (ps.done && s.day > 6) return null;
  const open = preseasonOpen(s);
  const round = nextPreseasonRound(ps);
  const table = preseasonTable(ps);
  const U = s.userTeamId;
  return (
    <Panel
      title={<span className="flex items-center gap-2"><Icon name="trophy" /> Предсезонка · {ps.name}</span>}
      right={<Tag color={ps.done ? '#3FCF8E' : '#F2B544'}>{ps.done ? (ps.champion === U ? 'Победа в турнире!' : 'Турнир завершён') : `${ps.city} · август`}</Tag>}
      data-preseason
    >
      <div className="grid grid-cols-1 md:grid-cols-[1fr_240px] gap-3 text-xs">
        <div className="space-y-1">
          {ps.games.map((g, i) => {
            const mine = g.home === U || g.away === U;
            return (
              <div key={i} className={cn('flex items-center gap-2 rounded-sm px-2 py-1', mine ? 'bg-panel2/70' : 'opacity-75')}>
                <span className="w-20 text-muted shrink-0">{g.date.replace(/ \d{4}$/, '')}</span>
                <TeamLogo team={s.teams[g.home]} size={16} />
                <span className="truncate flex-1">{s.teams[g.home].short} — {s.teams[g.away].short}</span>
                <TeamLogo team={s.teams[g.away]} size={16} />
                <span className="w-14 text-right tabular font-semibold">{g.result ? `${g.result.home}:${g.result.away}${g.result.so ? ' Б' : g.result.ot ? ' ОТ' : ''}` : '—'}</span>
              </div>
            );
          })}
        </div>
        <table className="w-full tabular self-start">
          <thead>
            <tr className="text-[10px] uppercase text-muted"><th className="text-left">Клуб</th><th>И</th><th>Ш</th><th>О</th></tr>
          </thead>
          <tbody>
            {table.map((r, i) => (
              <tr key={r.id} className={cn(r.id === U && 'text-ice font-semibold')}>
                <td className="py-0.5">{i + 1}. {s.teams[r.id].short}</td>
                <td className="text-center">{r.gp}</td>
                <td className="text-center">{r.gf}:{r.ga}</td>
                <td className="text-center">{r.pts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && round >= 0 && (
        <div className="mt-3 pt-3 border-t border-line flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-sm border border-line bg-panel2 p-0.5 text-xs">
            {([['main', 'Основной состав'], ['youth', 'Шанс молодёжи']] as const).map(([id, lbl]) => (
              <button key={id} type="button" onClick={() => setMode(id)} className={cn('px-2 py-1 rounded-sm font-semibold', mode === id ? 'bg-ice text-bg' : 'text-muted')}>
                {lbl}
              </button>
            ))}
          </div>
          <Button variant="primary" size="sm" onClick={() => setLast(playPreseason(mode))} data-preseason-play>
            <Icon name="play" /> Сыграть {round + 1}-й тур
          </Button>
          <Button size="sm" variant="ghost" onClick={() => ui.nav('lines')}>Звенья</Button>
        </div>
      )}
      <div className="text-[11px] text-muted mt-2">
        {last ? <span className="text-text">{last}. </span> : null}
        Матчи не идут в зачёт: звенья набирают сыгранность, молодёжь (U23) — опыт и мораль. Если начать сезон раньше, оставшиеся матчи сыграются автоматически.
      </div>
    </Panel>
  );
}
