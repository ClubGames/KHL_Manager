import { answerPress, useGame } from '../game/state';
import { Button, Icon, Panel } from './ui';
import type { PressEffect } from '../types';

const fx = (e: PressEffect, name?: string) => {
  const out: { t: string; good: boolean }[] = [];
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  if (e.morale) out.push({ t: `мораль ${sign(e.morale)}`, good: e.morale > 0 });
  if (e.board) out.push({ t: `руководство ${sign(e.board)}`, good: e.board > 0 });
  if (e.fans) out.push({ t: `болельщики ${sign(e.fans)}`, good: e.fans > 0 });
  if (e.playerMorale) out.push({ t: `${name ?? 'игрок'} ${sign(e.playerMorale)}`, good: e.playerMorale > 0 });
  return out;
};

export function PressConferencePanel() {
  const s = useGame()!;
  const pc = s.press;
  if (!pc) return null;
  return (
    <Panel title={<span className="flex items-center gap-2"><Icon name="mic" /> Пресс-конференция · {pc.topic}</span>} className="border-ice/40" data-press>
      <div className="text-sm text-text/90 mb-3">«{pc.question}»</div>
      <div className="grid gap-2">
        {pc.options.map((o) => (
          <button key={o.id} type="button" data-press-option={o.id} onClick={() => answerPress(o.id)} className="text-left rounded-sm border border-line bg-panel2/60 hover:border-ice px-3 py-2 transition-colors">
            <div className="text-sm">{o.text}</div>
            <div className="flex flex-wrap gap-x-2 text-[11px] mt-1">
              {fx(o.effects, o.effects.playerId ? s.players[o.effects.playerId]?.name.split(' ').slice(-1)[0] : undefined).map((x) => (
                <span key={x.t} className={x.good ? 'text-ok' : 'text-accent'}>{x.t}</span>
              ))}
            </div>
          </button>
        ))}
      </div>
      <div className="flex justify-end mt-2">
        <Button size="sm" variant="ghost" onClick={() => answerPress(null)}>
          Пропустить («без комментариев»)
        </Button>
      </div>
    </Panel>
  );
}
