import { useGame } from '../game/state';
import { visibleClubColor } from '../game/clubColors';
import type { Game } from '../types';
import { Icon, useUI } from './ui';
import { cn } from '../utils/cn';

/** Scoreboard strip: today's results (or tomorrow's fixtures) sliding under the header. */
export function Ticker() {
  const s = useGame()!;
  const ui = useUI();
  const today = s.schedule[s.day] ?? [];
  const playedToday = today.filter((g) => g.played && g.result);
  const playedPrev = (s.schedule[s.day - 1] ?? []).filter((g) => g.played && g.result);
  const fixtures = today.filter((g) => !g.played);
  const results = playedToday.length ? playedToday : playedPrev;
  const mode = playedToday.length ? 'Результаты дня' : results.length ? 'Итоги вчера' : 'Анонс дня';
  const list: Game[] = results.length ? results : fixtures;
  if (!list.length) return null;
  const items = [...list, ...list];
  return (
    <div className={cn('ticker border-b border-line bg-panel/70 relative overflow-hidden')} aria-hidden="false">
      <div className="absolute left-0 top-0 bottom-0 z-10 flex items-center gap-1.5 px-3 bg-gradient-to-r from-bg via-bg to-transparent text-[10px] uppercase tracking-[0.18em] text-muted">
        {results.length ? <span className="live-dot" /> : <Icon name="calendar" className="w-3 h-3" />}
        <span className={cn(results.length && 'text-ok')}>{mode}</span>
      </div>
      <div className="ticker-track" style={{ ['--dur' as string]: `${Math.max(26, list.length * 7)}s` }}>
        {items.map((g, i) => {
          const r = g.result;
          const mine = g.home === s.userTeamId || g.away === s.userTeamId;
          return (
            <button
              key={`${g.id}-${i}`}
              onClick={() => r && ui.openGame(g.id)}
              className={cn('flex items-center gap-2 px-3 py-1.5 text-xs whitespace-nowrap hover:bg-panel2 transition-colors', mine && 'bg-ice/5')}
              title={r ? 'Открыть протокол' : undefined}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: visibleClubColor(s.teams[g.away]) }} />
              <span className="text-muted">{s.teams[g.away].short}</span>
              <span className="font-display text-sm tabular text-text">
                {r ? `${r.awayScore}:${r.homeScore}` : '—:—'}
                {r?.so ? <span className="text-amber ml-0.5">Б</span> : r?.ot ? <span className="text-amber ml-0.5">ОТ</span> : null}
              </span>
              <span className="text-muted">{s.teams[g.home].short}</span>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: visibleClubColor(s.teams[g.home]) }} />
              {mine && <span className="text-ice/80">· ваш матч</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
