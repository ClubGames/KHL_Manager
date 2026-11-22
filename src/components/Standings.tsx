import { useState } from 'react';
import type { Series, Team } from '../types';
import { rankAll, rankConference, roundName, simulateToNextUserGame, useGame } from '../game/state';
import { Button, Icon, Panel, Tag, TeamLogo, useUI } from './ui';
import { cn } from '../utils/cn';

function Table({ teams, U, fullCols }: { teams: Team[]; U: string; fullCols: boolean }) {
  const optCell = cn('text-right px-1.5', !fullCols && 'hidden md:table-cell');
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs sm:text-sm tabular">
        <thead className="text-[10px] sm:text-[11px] uppercase tracking-wider text-muted">
          <tr>
            <th className="text-right pr-1.5 sm:pr-2 pl-2.5 sm:pl-4 py-2 font-semibold">#</th>
            <th className="text-left py-2 font-semibold">Команда</th>
            <th className="text-right px-1.5 py-2 font-semibold">И</th>
            <th className="text-right px-1.5 py-2 font-semibold">В</th>
            <th className={cn('py-2 font-semibold', optCell)}>ВОТ</th>
            <th className={cn('py-2 font-semibold', optCell)}>ВБ</th>
            <th className={cn('py-2 font-semibold', optCell)}>ПОТ</th>
            <th className={cn('py-2 font-semibold', optCell)}>ПБ</th>
            <th className="text-right px-1.5 py-2 font-semibold">П</th>
            <th className={cn('py-2 font-semibold', optCell)}>Ш</th>
            <th className="text-right px-1.5 py-2 font-semibold">±</th>
            <th className="text-right pr-2.5 sm:px-1.5 py-2 font-semibold">О</th>
            <th className={cn('pr-4 py-2 font-semibold text-left', !fullCols && 'hidden md:table-cell')}>Форма</th>
          </tr>
        </thead>
        <tbody>
          {teams.map((t, i) => {
            const r = t.record;
            return (
              <tr key={t.id} className={cn('border-t border-line/60', t.id === U && 'bg-ice/10', i < 8 ? 'border-l-2 border-l-ok' : 'border-l-2 border-l-transparent')}>
                <td className="text-right pr-1.5 sm:pr-2 pl-2.5 sm:pl-4 py-2 sm:py-1.5 text-muted">{i + 1}</td>
                <td className="py-2 sm:py-1.5 sm:min-w-[180px] max-w-[145px] sm:max-w-none">
                  <span className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                    <TeamLogo team={t} size={20} />
                    <span className="truncate font-medium">{t.name}</span>
                    {t.id === U && <Tag className="hidden sm:inline-flex" color="#8FD8F0">вы</Tag>}
                    {(r.capPenaltyPoints ?? 0) > 0 && <Tag tone="bad">−{r.capPenaltyPoints}</Tag>}
                    {t.record.streakType && t.record.streak >= 3 && <Tag className="hidden sm:inline-flex" color={t.record.streakType === 'W' ? '#3FCF8E' : '#E5323E'}>{t.record.streakType === 'W' ? 'В' : 'П'}{t.record.streak}</Tag>}
                  </span>
                </td>
                <td className="text-right px-1.5">{r.gp}</td>
                <td className="text-right px-1.5">{r.w + (fullCols ? 0 : r.otw + r.sow)}</td>
                <td className={cn('text-muted', optCell)}>{r.otw}</td>
                <td className={cn('text-muted', optCell)}>{r.sow}</td>
                <td className={cn('text-muted', optCell)}>{r.otl}</td>
                <td className={cn('text-muted', optCell)}>{r.sol}</td>
                <td className="text-right px-1.5">{r.l + (fullCols ? 0 : r.otl + r.sol)}</td>
                <td className={cn('whitespace-nowrap', optCell)}>{r.gf}:{r.ga}</td>
                <td className={cn('text-right px-1.5', r.gf - r.ga >= 0 ? 'text-ok' : 'text-accent')}>{r.gf - r.ga > 0 ? '+' : ''}{r.gf - r.ga}</td>
                <td className="text-right pr-2.5 sm:px-1.5 font-display text-sm sm:text-base font-bold text-ice">{r.points}</td>
                <td className={cn('pr-4 py-1.5 text-xs text-muted whitespace-nowrap', !fullCols && 'hidden md:table-cell')}>{r.last.slice(-5).join(' ')}</td>
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
  const ui = useUI();
  const U = s.userTeamId;
  const [mode, setMode] = useState<'conf' | 'all'>('conf');
  const [confPick, setConfPick] = useState<'Обе' | 'Запад' | 'Восток'>('Обе');
  const [fullCols, setFullCols] = useState(false);
  const po = s.playoffs;
  const rounds = [0, 1, 2, 3].map((r) => po?.series.filter((x) => x.round === r) ?? []);
  const userActiveInPo = po ? po.series.some((x) => x.round === po.round && (x.high === U || x.low === U) && !x.done) : false;
  return (
    <div className="space-y-4 fade-in">
      <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
        <button onClick={() => setMode('conf')} className={cn('text-xs px-3 py-1.5 rounded-sm font-semibold', mode === 'conf' ? 'bg-accent text-white' : 'bg-panel2 text-muted hover:text-text')}>
          По конференциям
        </button>
        <button onClick={() => setMode('all')} className={cn('text-xs px-3 py-1.5 rounded-sm font-semibold', mode === 'all' ? 'bg-accent text-white' : 'bg-panel2 text-muted hover:text-text')}>
          Общая таблица
        </button>
        {mode === 'conf' && (
          <div className="xl:hidden inline-flex rounded-sm border border-line bg-panel p-0.5">
            {(['Обе', 'Запад', 'Восток'] as const).map((cf) => (
              <button
                key={cf}
                type="button"
                onClick={() => setConfPick(cf)}
                className={cn('text-[11px] px-2 py-1 rounded-sm font-semibold', confPick === cf ? 'bg-ice text-bg' : 'text-muted')}
              >
                {cf}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => setFullCols((v) => !v)}
          className={cn('md:hidden ml-auto text-[11px] px-2.5 py-1.5 rounded-sm border font-semibold', fullCols ? 'border-ice text-ice bg-ice/10' : 'border-line bg-panel2 text-muted')}
        >
          {fullCols ? 'Компактно' : 'Все колонки'}
        </button>
      </div>
      <div className="text-xs text-muted">Очки: любая победа (в основное время, в овертайме или по буллитам) — 2, поражение в овертайме или по буллитам — 1, поражение в основное время — 0. При равенстве очков выше команда с большим числом побед в основное время. Зелёная отметка — зона плей-офф (топ-8 конференции).</div>
      {mode === 'conf' ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className={cn(confPick === 'Восток' && 'hidden xl:block')}>
            <Panel title="Конференция «Запад»" noPad>
              <Table teams={rankConference(s, 'Запад')} U={U} fullCols={fullCols} />
            </Panel>
          </div>
          <div className={cn(confPick === 'Запад' && 'hidden xl:block')}>
            <Panel title="Конференция «Восток»" noPad>
              <Table teams={rankConference(s, 'Восток')} U={U} fullCols={fullCols} />
            </Panel>
          </div>
        </div>
      ) : (
        <Panel title="Общая таблица · Кубок Контина" noPad>
          <Table teams={rankAll(s)} U={U} fullCols={fullCols} />
        </Panel>
      )}
      {po && (
        <Panel
          title="Сетка плей-офф · Кубок Гагарина"
          right={
            <div className="flex items-center gap-2 flex-wrap">
              {po.champion && <Tag color="#F2B544">Чемпион: {s.teams[po.champion].name}</Tag>}
              {s.phase === 'offseason' && (
                <Button size="sm" variant="primary" onClick={() => ui.nav('offseason')}>
                  <Icon name="trophy" /> Перейти в «Межсезонье»
                </Button>
              )}
              {s.phase === 'playoffs' && !userActiveInPo && (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    const res = simulateToNextUserGame();
                    if (res === 'offseason') ui.nav('offseason');
                  }}
                >
                  <Icon name="fast" /> Досимулировать раунд / плей-офф
                </Button>
              )}
            </div>
          }
        >
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
