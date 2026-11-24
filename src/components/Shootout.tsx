import type { GameEvent, Player, Team } from '../types';
import { PlayerFace, TeamLogo } from './ui';
import { cn } from '../utils/cn';

const isAttempt = (e: GameEvent) => e.type === 'so_goal' || e.type === 'so_miss';
const surname = (name?: string) => (name ? name.split(' ').slice(-1)[0] : '—');

/**
 * Shootout scoreboard: three rounds for each team, then sudden-death rounds; ✓ scored, ✗ missed, ○ still to shoot.
 * `live` highlights the latest attempt and keeps the empty slots of the first three rounds visible.
 */
export function ShootoutBoard({ events, home, away, players, live = false, className }: {
  events: GameEvent[]; home: Team; away: Team; players: Record<string, Player>; live?: boolean; className?: string;
}) {
  const attempts = events.filter(isAttempt);
  const rounds = Math.max(3, ...attempts.map((e) => e.round ?? 0));
  const goals = (teamId: string) => attempts.filter((e) => e.team === teamId && e.type === 'so_goal').length;
  const last = attempts[attempts.length - 1];
  const tally: [number, number] = [goals(home.id), goals(away.id)];
  const sudden = (last?.round ?? 0) > 3;
  const shooter = last?.player ? players[last.player] : null;
  const finished = !live || events.some((e) => e.type === 'period_end' && e.so);
  const winner = finished && tally[0] !== tally[1] ? (tally[0] > tally[1] ? home : away) : null;
  const decisive = winner ? [...attempts].reverse().find((e) => e.type === 'so_goal' && e.team === winner.id) : null;

  return (
    <div className={cn('rounded-md border border-line bg-panel p-3 text-left', className)} data-shootout data-shootout-attempts={attempts.length}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-[11px] uppercase tracking-widest text-muted">Серия буллитов{sudden ? ' · до первого промаха' : ' · по три броска'}</div>
        <div className="font-display text-xl tabular" data-shootout-score>{tally[0]} : {tally[1]}</div>
      </div>
      <div className="overflow-x-auto">
        <table className="tabular text-sm">
          <thead>
            <tr className="text-[10px] text-muted">
              <th />
              {Array.from({ length: rounds }, (_, i) => (
                <th key={i} className={cn('px-1 font-semibold', i >= 3 && 'text-amber')}>{i + 1}</th>
              ))}
              <th className="pl-2 font-semibold">Б</th>
            </tr>
          </thead>
          <tbody>
            {[home, away].map((t, ti) => (
              <tr key={t.id}>
                <td className="pr-2 py-0.5 whitespace-nowrap"><span className="inline-flex items-center gap-1.5"><TeamLogo team={t} size={18} /><b className="text-xs">{t.short}</b></span></td>
                {Array.from({ length: rounds }, (_, i) => {
                  const a = attempts.find((e) => e.team === t.id && e.round === i + 1);
                  const name = a?.player ? players[a.player]?.name : undefined;
                  return (
                    <td key={i} className="px-1 text-center">
                      {a ? (
                        <span
                          title={`${i + 1}-й раунд: ${name ?? '—'} — ${a.type === 'so_goal' ? 'гол' : 'не забил'}`}
                          className={cn('inline-flex w-6 h-6 items-center justify-center rounded-full text-xs font-bold', a.type === 'so_goal' ? 'bg-ok/20 text-ok' : 'bg-accent/15 text-accent', a === last && live && 'ring-2 ring-ice')}
                          data-so-cell={a.type === 'so_goal' ? 'goal' : 'miss'}
                        >
                          {a.type === 'so_goal' ? '✓' : '✗'}
                        </span>
                      ) : (
                        <span className={cn('inline-flex w-6 h-6 items-center justify-center rounded-full border text-[10px]', i < 3 && !finished ? 'border-line text-muted' : 'border-transparent text-transparent')}>○</span>
                      )}
                    </td>
                  );
                })}
                <td className="pl-2 font-display text-base">{tally[ti]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {live && last && !finished && (
        <div className="mt-2 flex items-center gap-2 rounded-sm bg-bg/40 px-2 py-1.5 text-sm" data-shootout-last>
          {shooter && <PlayerFace face={shooter.face} name={shooter.name} number={shooter.number} team={last.team === home.id ? home : away} size={30} />}
          <span className="flex-1 min-w-0">
            <span className="text-muted text-xs">{last.round}-й раунд · </span>
            <b>{shooter?.name ?? '—'}</b>{' '}
            <span className={last.type === 'so_goal' ? 'text-ok font-semibold' : 'text-accent'}>{last.type === 'so_goal' ? 'забивает!' : 'не забивает'}</span>
          </span>
        </div>
      )}
      {winner && (
        <div className="mt-2 text-xs text-muted" data-shootout-winner>
          Победа <b className="text-text">{winner.name}</b>{decisive?.player ? <> · победный буллит — <b className="text-text">{surname(players[decisive.player]?.name)}</b></> : null}
        </div>
      )}
      {!attempts.length && <div className="text-xs text-muted">Подробности серии не сохранились.</div>}
    </div>
  );
}

/** The manager picks the first three shooters (the rest of the bench follows by shootout ability). */
export function ShooterPicker({ candidates, value, onChange, players }: {
  candidates: string[]; value: string[]; onChange: (ids: string[]) => void; players: Record<string, Player>;
}) {
  const set = (slot: number, id: string) => {
    const next = [...value];
    const other = next.indexOf(id);
    if (other >= 0 && other !== slot) next[other] = next[slot];
    next[slot] = id;
    onChange(next);
  };
  return (
    <div className="text-left w-full max-w-md rounded-md border border-line bg-panel2/60 p-2.5" data-shooter-picker>
      <div className="text-[11px] uppercase tracking-wider text-muted mb-1.5">Исполнители буллитов</div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
        {[0, 1, 2].map((slot) => (
          <label key={slot} className="text-[11px] text-muted">
            {slot + 1}-й бросок
            <select
              aria-label={`${slot + 1}-й буллит`}
              value={value[slot] ?? ''}
              onChange={(e) => set(slot, e.target.value)}
              className="mt-0.5 w-full bg-panel border border-line rounded-sm px-1.5 py-1 text-xs text-text"
            >
              {candidates.map((id) => (
                <option key={id} value={id}>{players[id]?.name} · бросок {players[id]?.skills.shooting ?? '—'}</option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="mt-1.5 text-[10px] text-muted">По три разных игрока от команды. Если счёт равный — по одному броску до первого промаха, бросать может любой полевой игрок.</div>
    </div>
  );
}
