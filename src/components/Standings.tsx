import { useState } from 'react';
import type { Series, Team } from '../types';
import { rankAll, rankConference, roundName, useGame } from '../game/state';
import { Panel, Tag, TeamLogo } from './ui';
import { cn } from '../utils/cn';

function Table({ teams, U }: { teams: Team[]; U: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular">
        <thead className="text-[11px] uppercase tracking-wider text-muted">
          <tr>
            <th className="text-right pr-2 pl-4 py-2 font-semibold">#</th>
            <th className="text-left py-2 font-semibold">Команда</th>
            {['И', 'В', 'ВОТ', 'ВБ', 'ПОТ', 'ПБ', 'П', 'Ш', '±', 'О'].map((h) => (
              <th key={h} className="text-right px-1.5 py-2 font-semibold">
                {h}
              </th>
            ))}
            <th className="pr-4 py-2 font-semibold text-left">Форма</th>
          </tr>
        </thead>
        <tbody>
          {teams.map((t, i) => {
            const r = t.record;
            return (
              <tr key={t.id} className={cn('border-t border-line/60', t.id === U && 'bg-ice/10', i < 8 ? 'border-l-2 border-l-ok' : 'border-l-2 border-l-transparent')}>
                <td className="text-right pr-2 pl-4 py-1.5 text-muted">{i + 1}</td>
                <td className="py-1.5 min-w-[180px]">
                  <span className="flex items-center gap-2">
                    <TeamLogo team={t} size={22} />
                    <span className="truncate">{t.name}</span>
                    {t.id === U && <Tag color="#8FD8F0">вы</Tag>}
                    {t.record.streakType && t.record.streak >= 3 && <Tag color={t.record.streakType === 'W' ? '#3FCF8E' : '#E5323E'}>{t.record.streakType === 'W' ? 'В' : 'П'}{t.record.streak}</Tag>}
                  </span>
                </td>
                <td className="text-right px-1.5">{r.gp}</td>
                <td className="text-right px-1.5">{r.w}</td>
                <td className="text-right px-1.5 text-muted">{r.otw}</td>
                <td className="text-right px-1.5 text-muted">{r.sow}</td>
                <td className="text-right px-1.5 text-muted">{r.otl}</td>
                <td className="text-right px-1.5 text-muted">{r.sol}</td>
                <td className="text-right px-1.5">{r.l}</td>
                <td className="text-right px-1.5 whitespace-nowrap">{r.gf}:{r.ga}</td>
                <td className={cn('text-right px-1.5', r.gf - r.ga >= 0 ? 'text-ok' : 'text-accent')}>{r.gf - r.ga > 0 ? '+' : ''}{r.gf - r.ga}</td>
                <td className="text-right px-1.5 font-display text-base">{r.points}</td>
                <td className="pr-4 py-1.5 text-xs text-muted whitespace-nowrap">{r.last.slice(-5).join(' ')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SeriesCard({ ser }: { ser: Series }) {
  const s = useGame()!;
  const U = s.userTeamId;
  const row = (id: string, w: number, high: boolean) => {
    const t = s.teams[id];
    const winner = ser.done && ser.winner === id;
    return (
      <div className={cn('flex items-center gap-2 px-2 py-1.5', winner && 'bg-ok/10', t.id === U && 'bg-ice/10', high && 'border-b border-line/60')}>
        <TeamLogo team={t} size={22} />
        <span className={cn('flex-1 truncate text-sm', ser.done && !winner && 'text-muted line-through')}>{t.name}</span>
        <span className="font-display text-lg tabular">{w}</span>
      </div>
    );
  };
  return (
    <div className={cn('rounded-md border bg-panel2/50 overflow-hidden', (ser.high === U || ser.low === U) ? 'border-ice/50' : 'border-line')}>
      {row(ser.high, ser.wins[0], true)}
      {row(ser.low, ser.wins[1], false)}
      <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted border-t border-line/60">{ser.done ? `серия ${ser.wins[0]}:${ser.wins[1]}` : `матч ${ser.games.length + 1} · счёт серии ${ser.wins[0]}:${ser.wins[1]}`}</div>
    </div>
  );
}

export function Standings() {
  const s = useGame()!;
  const U = s.userTeamId;
  const [mode, setMode] = useState<'conf' | 'all'>('conf');
  const po = s.playoffs;
  const rounds = [0, 1, 2, 3].map((r) => po?.series.filter((x) => x.round === r) ?? []);
  return (
    <div className="space-y-4 fade-in">
      <div className="flex gap-2">
        <button onClick={() => setMode('conf')} className={cn('text-xs px-3 py-1.5 rounded-sm font-semibold', mode === 'conf' ? 'bg-accent text-white' : 'bg-panel2 text-muted hover:text-text')}>
          По конференциям
        </button>
        <button onClick={() => setMode('all')} className={cn('text-xs px-3 py-1.5 rounded-sm font-semibold', mode === 'all' ? 'bg-accent text-white' : 'bg-panel2 text-muted hover:text-text')}>
          Общая таблица
        </button>
      </div>
      <div className="text-xs text-muted">Очки: любая победа (в основное время, в овертайме или по буллитам) — 2, поражение в овертайме или по буллитам — 1, поражение в основное время — 0. При равенстве очков выше команда с большим числом побед в основное время. Зелёная отметка — зона плей-офф (топ-8 конференции).</div>
      {mode === 'conf' ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <Panel title="Конференция «Запад»" noPad>
            <Table teams={rankConference(s, 'Запад')} U={U} />
          </Panel>
          <Panel title="Конференция «Восток»" noPad>
            <Table teams={rankConference(s, 'Восток')} U={U} />
          </Panel>
        </div>
      ) : (
        <Panel title="Общая таблица · Кубок Контина" noPad>
          <Table teams={rankAll(s)} U={U} />
        </Panel>
      )}
      {po && (
        <Panel title="Сетка плей-офф · Кубок Гагарина" right={po.champion && <Tag color="#F2B544">Чемпион: {s.teams[po.champion].name}</Tag>}>
          {po.awards.length > 0 && (
            <div className="mb-4 grid grid-cols-2 md:grid-cols-5 gap-2">
              {po.awards.map((a) => (
                <div key={a.title} className="bg-panel2/70 border border-line/70 rounded-sm p-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted">{a.title}</div>
                  <div className="text-sm font-semibold truncate">{s.players[a.player]?.name}</div>
                  <div className="text-xs text-amber tabular">{a.value}</div>
                </div>
              ))}
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {rounds.map((rs, r) => (
              <div key={r}>
                <div className="text-[11px] uppercase tracking-wider text-muted mb-2">{roundName(r)}</div>
                <div className="space-y-3">
                  {rs.map((ser) => (
                    <SeriesCard key={ser.id} ser={ser} />
                  ))}
                  {!rs.length && <div className="text-xs text-muted italic">Серии сформированы после завершения предыдущего раунда</div>}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}
