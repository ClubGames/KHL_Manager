import type { Game, GameState } from '../types';
import { regularSeasonLength, seasonDate } from '../game/schedule';
import { Button, TeamLogo, useUI } from './ui';
import { cn } from '../utils/cn';

const mine = (s: GameState, g: Game) => g.home === s.userTeamId || g.away === s.userTeamId;

/** Played games of the manager's club on days [from, to). */
export function userGamesBetween(s: GameState, from: number, to: number): Game[] {
  const out: Game[] = [];
  for (let d = Math.max(0, from); d < Math.min(to, s.schedule.length); d++) for (const g of s.schedule[d] ?? []) if (g.played && g.result && mine(s, g)) out.push(g);
  return out;
}

/** The most recent played game of the manager's club. */
export function lastUserGame(s: GameState): Game | null {
  for (let d = Math.min(s.day, s.schedule.length - 1); d >= 0; d--) {
    const g = (s.schedule[d] ?? []).find((x) => x.played && x.result && mine(s, x));
    if (g) return g;
  }
  return null;
}

function ResultRow({ s, g, big = false }: { s: GameState; g: Game; big?: boolean }) {
  const ui = useUI();
  const r = g.result!;
  const H = s.teams[g.home], A = s.teams[g.away];
  const won = (r.homeScore > r.awayScore) === (g.home === s.userTeamId);
  const tag = r.so ? 'Б' : r.ot ? 'ОТ' : '';
  const goals = r.events.filter((e) => e.type === 'goal').length;
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5', big ? 'text-sm' : 'text-xs')} data-result-row={g.id}>
      <span className={cn('font-display uppercase tracking-wide px-1.5 py-0.5 rounded-sm text-[11px]', won ? 'bg-ok/15 text-ok' : 'bg-accent/15 text-accent')}>{won ? 'Победа' : 'Поражение'}{tag ? ` · ${tag}` : ''}</span>
      <span className="inline-flex items-center gap-1.5 min-w-0">
        <TeamLogo team={A} size={big ? 22 : 16} />
        <b className={cn(g.away === s.userTeamId && 'text-ice')}>{A.short}</b>
        <span className={cn('font-display tabular', big ? 'text-2xl' : 'text-base')} data-result-score>{r.awayScore}:{r.homeScore}</span>
        <b className={cn(g.home === s.userTeamId && 'text-ice')}>{H.short}</b>
        <TeamLogo team={H} size={big ? 22 : 16} />
      </span>
      <span className="text-muted">{seasonDate(g.day, regularSeasonLength(s.schedule), s.league.season)}{g.kind === 'playoff' ? ' · плей-офф' : ''}</span>
      <Button size="sm" variant={big ? 'primary' : 'secondary'} className="ml-auto" onClick={() => ui.openGame(g.id)} data-open-report>
        {goals ? 'Протокол и повторы голов' : 'Протокол матча'}
      </Button>
    </div>
  );
}

/** Always-visible result of the club's last game, plus every game of the latest fast simulation. */
export function LastResults({ s, simulated, onDismiss }: { s: GameState; simulated: number[]; onDismiss: () => void }) {
  const last = lastUserGame(s);
  const games = simulated.map((id) => s.schedule.flat().find((g) => g.id === id)).filter((g): g is Game => !!g?.result);
  if (!last && !games.length) return null;
  return (
    <div className="rounded-md border border-ice/40 bg-ice/5 p-3 space-y-2" data-last-result>
      {games.length > 1 ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] uppercase tracking-widest text-ice">Итоги симуляции · матчей вашей команды: {games.length}</div>
            <button type="button" onClick={onDismiss} className="text-xs text-muted hover:text-text" aria-label="Скрыть итоги симуляции">Скрыть</button>
          </div>
          <div className="space-y-1.5 divide-y divide-line/50">
            {games.map((g) => <div key={g.id} className="pt-1.5 first:pt-0"><ResultRow s={s} g={g} /></div>)}
          </div>
        </>
      ) : (
        <>
          <div className="text-[11px] uppercase tracking-widest text-ice">{games.length ? 'Итог симуляции матча' : 'Последний матч'}</div>
          <ResultRow s={s} g={games[0] ?? last!} big />
        </>
      )}
    </div>
  );
}
