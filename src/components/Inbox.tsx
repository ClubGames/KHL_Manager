import { buildInbox, type InboxSeverity, type InboxTask } from '../game/inbox';
import { dismissInbox, useGame } from '../game/state';
import { Button, Empty, Icon, Panel, Tag, useUI } from './ui';
import { PressConferencePanel } from './PressConference';
import { PreseasonPanel } from './Preseason';
import { cn } from '../utils/cn';

const SEV: Record<InboxSeverity, { color: string; label: string }> = {
  urgent: { color: '#E5323E', label: 'срочно' },
  warn: { color: '#F2B544', label: 'важно' },
  info: { color: '#8FD8F0', label: 'инфо' },
};
const KIND_ICON: Partial<Record<InboxTask['kind'], string>> = {
  press: 'mic', offer: 'trade', rfa: 'contract', lineup: 'lines', goalie: 'lines', injury: 'injury', contract: 'contract',
  morale: 'roster', request: 'trade', cap: 'alert', ltir: 'injury', preseason: 'trophy', deadline: 'trade', scout: 'scout', board: 'alert',
};

export function InboxList({ limit, compact = false }: { limit?: number; compact?: boolean }) {
  const s = useGame()!;
  const ui = useUI();
  const all = buildInbox(s);
  const tasks = limit ? all.slice(0, limit) : all;
  if (!all.length) return <Empty text="Входящих задач нет — можно спокойно играть дальше." />;
  return (
    <div className="space-y-1.5" data-inbox-list>
      {tasks.map((t) => {
        const sev = SEV[t.severity];
        return (
          <div key={t.id} data-inbox-task={t.kind} className={cn('flex items-start gap-2 rounded-sm border bg-panel2/50 px-2.5 py-2 text-xs', t.severity === 'urgent' ? 'border-accent/60' : 'border-line')}>
            <span className="mt-0.5" style={{ color: sev.color }}>
              <Icon name={KIND_ICON[t.kind] ?? 'news'} />
            </span>
            <button type="button" className="flex-1 min-w-0 text-left" onClick={() => (t.playerId && (t.kind === 'injury' || t.kind === 'goalie') ? ui.openPlayer(t.playerId) : ui.nav(t.view))}>
              <div className="flex items-center gap-1.5 flex-wrap">
                <b className="text-text">{t.title}</b>
                {!compact && <Tag color={sev.color}>{sev.label}</Tag>}
              </div>
              <div className={cn('text-muted mt-0.5', compact && 'truncate')}>{t.text}</div>
            </button>
            <div className="flex items-center gap-1 shrink-0">
              {t.view !== 'dashboard' && (
                <Button size="sm" variant="secondary" onClick={() => ui.nav(t.view)}>
                  Открыть
                </Button>
              )}
              {t.kind !== 'press' && t.kind !== 'preseason' && (
                <button type="button" className="p-1 text-muted hover:text-text" title="Скрыть задачу" onClick={() => dismissInbox(t.id)}>
                  <Icon name="close" className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        );
      })}
      {limit && all.length > limit && (
        <button type="button" className="text-xs text-ice hover:underline" onClick={() => ui.nav('inbox')}>
          Все задачи ({all.length}) →
        </button>
      )}
    </div>
  );
}

export function Inbox() {
  const s = useGame()!;
  const all = buildInbox(s);
  const urgent = all.filter((t) => t.severity === 'urgent').length;
  return (
    <div className="space-y-4 fade-in" data-inbox-view>
      {s.press && <PressConferencePanel />}
      <PreseasonPanel />
      <Panel title="Входящие" right={<span className="text-xs text-muted">{all.length} задач{urgent ? ` · срочных: ${urgent}` : ''}</span>}>
        <InboxList />
        <div className="text-[11px] text-muted mt-3">
          Быстрая симуляция («до матча», «5 дней») останавливается, когда приходит новое предложение обмена, игрок просит обмен или появляется срочная задача.
        </div>
      </Panel>
    </div>
  );
}
