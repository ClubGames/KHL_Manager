import { answerRoomEvent, useGame } from '../game/state';
import { promiseLabel, promiseProgress } from '../game/dressingRoom';
import type { ClubEventKind } from '../types';
import { AnswerButton } from './PressConference';
import { Icon, Panel, PlayerFace, Tag, useUI } from './ui';
import { cn } from '../utils/cn';

const KIND: Record<ClubEventKind, { label: string; color: string; icon: string }> = {
  wish: { label: 'Желание игрока', color: '#8FD8F0', icon: 'roster' },
  conflict: { label: 'Конфликт', color: '#E5323E', icon: 'alert' },
  agent: { label: 'Агент', color: '#F2B544', icon: 'contract' },
  media: { label: 'Пресса', color: '#B79CFF', icon: 'mic' },
  team: { label: 'Команда', color: '#3FCF8E', icon: 'roster' },
  fans: { label: 'Болельщики', color: '#F2B544', icon: 'trophy' },
};

/** Dressing-room situations waiting for an answer, and the promises the manager has made. */
export function DressingRoomPanel() {
  const s = useGame()!;
  const ui = useUI();
  const events = s.roomEvents ?? [];
  const promises = (s.roomPromises ?? []).filter((p) => s.players[p.playerId]?.teamId === s.userTeamId);
  if (!events.length && !promises.length) return null;
  const T = s.teams[s.userTeamId];
  return (
    <Panel
      title={<span className="flex items-center gap-2"><Icon name="roster" /> Раздевалка</span>}
      right={events.length ? <Tag color="#F2B544">ждут ответа: {events.length}</Tag> : undefined}
      className={events.length ? 'border-amber/40' : undefined}
      data-dressing-room
    >
      <div className="space-y-4">
        {events.map((e) => {
          const k = KIND[e.kind];
          const left = e.expires - s.day;
          return (
            <div key={e.id} data-room-event={e.key} className="space-y-2">
              <div className="flex items-start gap-2.5">
                <div className="flex -space-x-2 shrink-0">
                  {e.playerIds.slice(0, 2).map((id) => {
                    const p = s.players[id];
                    return p ? (
                      <button key={id} type="button" onClick={() => ui.openPlayer(id)} title={p.name} className="rounded-full ring-2 ring-panel">
                        <PlayerFace face={p.face} name={p.name} number={p.number} team={T} size={36} />
                      </button>
                    ) : null;
                  })}
                  {!e.playerIds.length && (
                    <span className="w-9 h-9 rounded-full bg-panel2 grid place-items-center" style={{ color: k.color }}><Icon name={k.icon} /></span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Tag color={k.color}>{k.label}</Tag>
                    <b className="text-sm">{e.title}</b>
                  </div>
                  <div className="text-sm text-text/85 mt-1">{e.text}</div>
                  <div className={cn('text-[11px] mt-0.5', left <= 0 ? 'text-accent' : 'text-muted')}>
                    {left <= 0 ? 'Ответить нужно сегодня — иначе всё решится без вас.' : `Ответ ждут ещё ${left + 1} дн.`}
                  </div>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {e.options.map((o) => (
                  <AnswerButton key={o.id} o={o} data={{ 'data-room-option': o.id }} onPick={() => answerRoomEvent(e.id, o.id)} />
                ))}
              </div>
            </div>
          );
        })}
        {promises.length > 0 && (
          <div data-room-promises>
            <div className="text-[11px] uppercase tracking-wide text-muted mb-1.5">Обещания игрокам</div>
            <div className="space-y-1">
              {promises.map((pr) => {
                const pg = promiseProgress(s, pr);
                return (
                  <div key={pr.id} data-room-promise={pr.kind} className={cn('flex flex-col sm:flex-row sm:items-center justify-between gap-x-2 gap-y-0.5 rounded-sm border px-2.5 py-1.5 text-xs', pg.risk ? 'border-accent/50 bg-accent/5' : 'border-line bg-panel2/40')}>
                    <button type="button" className="text-left min-w-0 sm:truncate hover:text-ice" onClick={() => ui.openPlayer(pr.playerId)}>{promiseLabel(s, pr)}</button>
                    <span className={cn('shrink-0 tabular', pg.risk ? 'text-accent' : 'text-muted')}>{pg.text}</span>
                  </div>
                );
              })}
            </div>
            <div className="text-[11px] text-muted mt-1.5">Сдержанное слово поднимает мораль игрока и доверие раздевалки, невыполненное — оборачивается конфликтом и вопросами журналистов.</div>
          </div>
        )}
      </div>
    </Panel>
  );
}
