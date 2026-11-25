import type { Game } from '../types';
import { useGame } from '../game/state';
import { cn } from '../utils/cn';
import { Icon, Modal, TeamLogo } from './ui';

export type MatchMode = 'play' | 'watch' | 'quick';

const MODES: { id: MatchMode; title: string; text: string; icon: string; tone: string }[] = [
  { id: 'play', title: 'Играть', text: 'Управляйте хоккеистом сами, как в NHL: клавиатура, геймпад или экранный стик на телефоне.', icon: 'puck', tone: 'border-accent/60 hover:bg-accent/10' },
  { id: 'watch', title: 'Симуляция', text: 'Смотрите матч в 2D/3D и руководите со скамейки: звенья, тактика, тайм-аут, вратарь.', icon: 'play', tone: 'border-ice/50 hover:bg-ice/10' },
  { id: 'quick', title: 'Быстрая симуляция', text: 'Сразу итог по текущим звеньям — без просмотра. Отчёт и повторы голов откроются после.', icon: 'fast', tone: 'border-line hover:bg-panel2' },
];

/** «Играть матч»: how the manager wants to take the game — play it, watch it from the bench, or just the result. */
export function MatchModeModal({ game, onClose, onPick }: { game: Game | null; onClose: () => void; onPick: (mode: MatchMode, game: Game) => void }) {
  const s = useGame();
  const H = game && s ? s.teams[game.home] : null, A = game && s ? s.teams[game.away] : null;
  return (
    <Modal open={!!game} onClose={onClose} title={<span className="font-display uppercase tracking-wide">Как сыграть матч?</span>} width="max-w-lg">
      {H && A && (
        <div className="flex items-center justify-center gap-3 mb-3 text-sm" data-mode-teams>
          <TeamLogo team={H} size={28} /><b>{H.short}</b><span className="text-muted">—</span><b>{A.short}</b><TeamLogo team={A} size={28} />
        </div>
      )}
      <div className="flex flex-col gap-2" data-match-modes>
        {MODES.map((m) => (
          <button key={m.id} type="button" onClick={() => game && onPick(m.id, game)} className={cn('w-full text-left rounded-md border-2 px-3 py-2.5 flex items-start gap-3 transition-colors', m.tone)} data-match-mode={m.id}>
            <Icon name={m.icon} className="w-5 h-5 mt-0.5" />
            <span className="min-w-0">
              <span className="block font-semibold">{m.title}</span>
              <span className="block text-xs text-muted">{m.text}</span>
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
