import type { Player } from '../types';
import { useGame } from '../game/state';
import { scoutedOvr, scoutedPotential } from '../game/scouting';
import { overallColor } from '../game/ratings';
import { cn } from '../utils/cn';

/**
 * A rating as the manager knows it: exact for his own (and fully scouted) players, otherwise the
 * scouts' estimate with its error margin, e.g. "78 ±6".
 */
export function ScoutOvr({ p, size = 'sm', potential = false }: { p: Player; size?: 'sm' | 'md' | 'lg'; potential?: boolean }) {
  const s = useGame()!;
  const v = potential ? scoutedPotential(s, p) : scoutedOvr(s, p);
  const c = overallColor(v.value);
  return (
    <span
      data-scout-ovr={v.exact ? 'exact' : `${v.value}±${v.err}`}
      title={v.exact ? undefined : `Оценка скаутов: ${v.value} ± ${v.err}. Изученность ${Math.round(v.knowledge)}%. Отправьте скаута, чтобы узнать точно.`}
      className={cn(
        'font-display font-bold tabular inline-flex items-center justify-center rounded-sm border shrink-0 gap-0.5',
        size === 'sm' && 'text-xs h-5 min-w-8 px-1',
        size === 'md' && 'text-sm h-6 min-w-9 px-1',
        size === 'lg' && 'text-2xl h-10 min-w-14 px-1.5',
        !v.exact && 'border-dashed'
      )}
      style={{ color: c, background: `${c}1f`, borderColor: `${c}66` }}
    >
      {v.value}
      {!v.exact && <span className={cn('font-sans font-semibold opacity-75', size === 'lg' ? 'text-xs' : 'text-[9px]')}>±{v.err}</span>}
    </span>
  );
}
