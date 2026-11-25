import { answerPress, useGame } from '../game/state';
import { formatMoney } from '../game/ratings';
import { promiseLabel } from '../game/dressingRoom';
import { Button, Icon, Panel } from './ui';
import type { GameState, PressEffect, PressOption } from '../types';

/** Effect chips of an answer: what it does to the dressing room, the owners, the stands, players and the budget. */
export function effectChips(s: GameState, e: PressEffect) {
  const out: { t: string; good: boolean | null }[] = [];
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  const last = (id: string) => s.players[id]?.name.split(' ').slice(-1)[0] ?? 'игрок';
  if (e.morale) out.push({ t: `мораль ${sign(e.morale)}`, good: e.morale > 0 });
  if (e.board) out.push({ t: `руководство ${sign(e.board)}`, good: e.board > 0 });
  if (e.fans) out.push({ t: `болельщики ${sign(e.fans)}`, good: e.fans > 0 });
  const per: Record<string, number> = { ...(e.players ?? {}) };
  if (e.playerId && e.playerMorale) per[e.playerId] = (per[e.playerId] ?? 0) + e.playerMorale;
  for (const id in per) if (per[id]) out.push({ t: `${last(id)} ${sign(per[id])}`, good: per[id] > 0 });
  if (e.budget) out.push({ t: `бюджет ${e.budget > 0 ? '+' : ''}${formatMoney(e.budget)}`, good: e.budget > 0 });
  if (e.promise) out.push({ t: `обещание: ${promiseLabel(s, e.promise)}`, good: null });
  if (e.tradeFlag === 'block' && e.playerId) out.push({ t: `${last(e.playerId)} — на обмен`, good: null });
  if (e.tradeFlag === 'keep' && e.playerId) out.push({ t: `${last(e.playerId)} — не продаётся`, good: null });
  if (e.role && e.playerId) out.push({ t: `${last(e.playerId)} — ${e.role === 'C' ? 'капитан' : 'ассистент'}`, good: null });
  if (e.trainingXp) out.push({ t: 'прогресс молодого игрока', good: true });
  if (e.rest) out.push({ t: 'меньше нагрузки', good: true });
  return out;
}

export function AnswerButton({ o, onPick, data }: { o: PressOption; onPick: () => void; data: Record<string, string> }) {
  const s = useGame()!;
  return (
    <button type="button" {...data} onClick={onPick} className="text-left rounded-sm border border-line bg-panel2/60 hover:border-ice px-3 py-2 transition-colors">
      <div className="text-sm">{o.text}</div>
      <div className="flex flex-wrap gap-x-2 text-[11px] mt-1">
        {effectChips(s, o.effects).map((x) => (
          <span key={x.t} className={x.good === null ? 'text-amber' : x.good ? 'text-ok' : 'text-accent'}>{x.t}</span>
        ))}
      </div>
      {o.hint && <div className="text-[11px] text-muted mt-0.5">{o.hint}</div>}
    </button>
  );
}

export function PressConferencePanel() {
  const s = useGame()!;
  const pc = s.press;
  if (!pc) return null;
  const total = pc.total ?? 1, step = pc.step ?? 1;
  return (
    <Panel
      title={<span className="flex items-center gap-2"><Icon name="mic" /> Пресс-конференция{pc.title ? ` · ${pc.title}` : ''}</span>}
      right={total > 1 ? <span className="text-xs text-muted tabular" data-press-step={`${step}/${total}`}>вопрос {step} из {total}</span> : undefined}
      className="border-ice/40"
      data-press
    >
      <div className="flex items-baseline justify-between gap-2 flex-wrap mb-1">
        <span className="text-[11px] uppercase tracking-wide text-ice" data-press-topic>{pc.topic}</span>
        {pc.reporter && <span className="text-[11px] text-muted" data-press-reporter>{pc.reporter}</span>}
      </div>
      <div className="text-sm text-text/90 mb-3">«{pc.question}»</div>
      <div className="grid gap-2">
        {pc.options.map((o) => (
          <AnswerButton key={o.id} o={o} data={{ 'data-press-option': o.id }} onPick={() => answerPress(o.id)} />
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 mt-2 flex-wrap">
        <span className="text-[11px] text-muted">{total > 1 && step < total ? `Дальше ещё ${total - step} ${total - step === 1 ? 'вопрос' : 'вопроса'}.` : ''}</span>
        <Button size="sm" variant="ghost" onClick={() => answerPress(null)}>
          Уйти без комментариев
        </Button>
      </div>
    </Panel>
  );
}
