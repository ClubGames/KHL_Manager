import { useState } from 'react';
import { groupOf } from '../game/ai';
import { askingSalary, talksLeft } from '../game/contracts';
import { formatMoney, payroll } from '../game/ratings';
import { useGame } from '../game/state';
import { Button, OverallChip, Panel, PosBadge, useUI } from './ui';
import { cn } from '../utils/cn';

export function Market() {
  const s = useGame()!;
  const ui = useUI();
  const P = s.players;
  const U = s.teams[s.userTeamId];
  const [pos, setPos] = useState<'ALL' | 'F' | 'D' | 'G'>('ALL');
  const list = s.freeAgents.map((id) => P[id]).filter((p) => p && (pos === 'ALL' || groupOf(p) === pos)).sort((a, b) => b.overall - a.overall);
  const fol = s.phase === 'offseason' ? U.players.reduce((a, id) => a + (P[id].contract.years > 0 ? P[id].contract.salary : 0), 0) : payroll(U.players, P);
  const cap = s.league.salaryCap;
  return (
    <div className="space-y-4 fade-in">
      <Panel
        title="Рынок свободных агентов"
        right={
          <div className="flex items-center gap-2">
            {(['ALL', 'F', 'D', 'G'] as const).map((k) => (
              <button key={k} onClick={() => setPos(k)} className={cn('text-xs px-2.5 py-1 rounded-sm font-semibold', pos === k ? 'bg-accent text-white' : 'text-muted hover:text-text bg-panel2')}>
                {k === 'ALL' ? 'Все' : k === 'F' ? 'Нападающие' : k === 'D' ? 'Защитники' : 'Вратари'}
              </button>
            ))}
          </div>
        }
        noPad
      >
        <div className="px-4 py-2 text-xs text-muted flex gap-4 flex-wrap border-b border-line/60">
          <span>
            Игроков на рынке: <b className="text-text">{s.freeAgents.length}</b>
          </span>
          <span>
            ФОТ: <b className={fol > cap ? 'text-accent' : 'text-text'}>{formatMoney(fol)}</b> / {formatMoney(cap)}
          </span>
          <span>
            Свободно под потолком: <b className="text-ok">{formatMoney(Math.max(0, cap - fol))}</b>
          </span>
          <span>
            Бюджет: <b className="text-text">{formatMoney(U.budget)}</b>
          </span>
          <span>Состав: {U.players.length} / 30</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular" data-market>
            <thead className="text-[11px] uppercase tracking-wider text-muted">
              <tr>
                <th className="text-left pl-4 py-2 font-semibold">Игрок</th>
                <th className="text-left py-2 font-semibold">Поз</th>
                <th className="text-left py-2 font-semibold">Возр</th>
                <th className="text-left py-2 font-semibold">ОВР</th>
                <th className="text-left py-2 font-semibold">Пот</th>
                <th className="text-right py-2 font-semibold">Запрос за сезон</th>
                <th className="text-right py-2 font-semibold pr-4">Контракт</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-muted">
                    Свободных агентов по этому фильтру нет
                  </td>
                </tr>
              )}
              {list.map((p) => {
                const ask = askingSalary(s, p, 1, U.id);
                const left = talksLeft(s, p);
                const noRoom = fol + ask * 0.87 > cap;
                return (
                  <tr key={p.id} className="border-t border-line/60 hover:bg-panel2 transition-colors">
                    <td className="pl-4 py-2 font-medium whitespace-nowrap">
                      <button className="hover:text-ice text-left" onClick={() => ui.openPlayer(p.id)}>
                        {p.name}
                      </button>
                    </td>
                    <td className="py-2">
                      <PosBadge pos={p.position} />
                    </td>
                    <td className="py-2 text-muted">{p.age}</td>
                    <td className="py-2">
                      <OverallChip value={p.overall} size="sm" />
                    </td>
                    <td className={cn('py-2', p.potential > p.overall ? 'text-ice' : 'text-muted')}>{p.age <= 25 ? p.potential : '—'}</td>
                    <td className={cn('py-2 text-right whitespace-nowrap', noRoom && 'text-muted')} title={noRoom ? 'Не помещается под потолок зарплат' : undefined}>
                      {formatMoney(ask)}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      <Button size="sm" variant={left > 0 ? 'secondary' : 'ghost'} disabled={left <= 0 || U.players.length >= 30} onClick={() => ui.negotiate(p.id)} title={left <= 0 ? 'Игрок прервал переговоры с вашим клубом' : undefined}>
                        {left <= 0 ? 'Отказ' : 'Переговоры'}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="Правила подписания">
        <ul className="text-xs text-text/80 space-y-1.5">
          <li>• Запрос показан для контракта на один сезон; в переговорах можно выбрать срок и попробовать снизить оклад.</li>
          <li>• Подписание невозможно, если ФОТ превысит потолок зарплат или в бюджете меньше годового оклада игрока.</li>
          <li>• В межсезонье клубы лиги тоже подписывают свободных агентов, чтобы закрыть позиции.</li>
          <li>• Все условия своих игроков — в разделе «Контракты».</li>
        </ul>
      </Panel>
    </div>
  );
}
