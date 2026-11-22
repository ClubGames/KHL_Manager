import { useState } from 'react';
import type { Player } from '../types';
import { askingSalary, buyoutCost, commitments, maxYears, TALKS, talksLeft } from '../game/contracts';
import { formatMoney } from '../game/ratings';
import { letGo, offerContract, releasePlayer, useGame } from '../game/state';
import type { ContractAnswer } from '../game/state';
import { Button, Modal, OverallChip, Panel, PosBadge, Stat, Tag, useUI } from './ui';
import { cn } from '../utils/cn';

const seasonLabel = (s: string, plus: number) => {
  const m = /^(\d{4})\/(\d{2})$/.exec(s);
  if (!m) return plus === 0 ? s : `+${plus}`;
  const y = parseInt(m[1], 10) + plus;
  return `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
};
const yearsWord = (n: number) => (n === 1 ? 'год' : n < 5 ? 'года' : 'лет');

/** Negotiation with a free agent or with an own player whose contract is ending. */
export function NegotiationModal({ id, onClose }: { id: string; onClose: () => void }) {
  const s = useGame()!;
  const p: Player | undefined = s.players[id];
  const U = s.teams[s.userTeamId];
  const maxY = p ? maxYears(p.age) : 1;
  const [years, setYears] = useState(Math.min(2, maxY));
  const [pct, setPct] = useState(100);
  const [answer, setAnswer] = useState<ContractAnswer | null>(null);
  if (!p || (p.teamId && p.teamId !== U.id)) return null;
  const free = !p.teamId;
  const extension = !free && p.contract.years === 1;
  const ask = askingSalary(s, p, years, U.id);
  const salary = Math.max(500_000, Math.round((ask * pct) / 100 / 500_000) * 500_000);
  const left = talksLeft(s, p);
  const signed = !!answer?.ok;
  const cap = s.league.salaryCap;
  const committed = extension ? commitments(U.players, s.players, 2)[1] : U.players.reduce((a, x) => a + (s.phase === 'offseason' && s.players[x].contract.years === 0 ? 0 : s.players[x].contract.salary), 0);
  const after = committed + salary;
  const offer = (value: number) => setAnswer(offerContract(p.id, value, years));
  const tone = !answer ? '' : answer.ok ? 'border-ok/50 text-ok bg-ok/10' : 'border-accent/50 text-accent bg-accent/10';
  return (
    <Modal open onClose={onClose} width="max-w-xl" title={<span className="font-display uppercase tracking-wide">{free ? 'Переговоры со свободным агентом' : extension ? 'Продление контракта' : 'Новый контракт'}</span>}>
      <div className="flex items-center gap-3 flex-wrap">
        <PosBadge pos={p.position} />
        <div className="flex-1 min-w-[160px]">
          <div className="font-display text-xl uppercase leading-none">{p.name}</div>
          <div className="text-xs text-muted mt-1">
            {p.age} лет{p.age <= 25 ? ` · потенциал ${p.potential}` : ''} · мораль {p.morale}
            {!free && ` · сейчас ${formatMoney(p.contract.salary)}${p.contract.years ? `, осталось ${p.contract.years} ${yearsWord(p.contract.years)}` : ', контракт истёк'}`}
          </div>
        </div>
        <OverallChip value={p.overall} size="lg" />
      </div>

      {signed ? (
        <div className={cn('mt-4 text-sm rounded-sm border px-3 py-3', tone)} data-neg-result>
          {answer!.text}
        </div>
      ) : (
        <>
          <div className="mt-4">
            <div className="text-[11px] uppercase tracking-wider text-muted mb-1.5">Срок контракта{extension ? ' (начнётся со следующего сезона)' : ''}</div>
            <div className="flex gap-1.5 flex-wrap">
              {[1, 2, 3, 4, 5].map((y) => (
                <button key={y} disabled={y > maxY} onClick={() => { setYears(y); setAnswer(null); }} className={cn('text-sm px-3 py-1.5 rounded-sm font-semibold transition-colors disabled:opacity-35 disabled:cursor-not-allowed', years === y ? 'bg-ice text-bg' : 'bg-panel2 text-muted hover:text-text')} title={y > maxY ? `В ${p.age} лет игрок не подпишет контракт дольше ${maxY} ${yearsWord(maxY)}` : undefined}>
                  {y} {yearsWord(y)}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-4">
            <Stat label="Запрос игрока" value={formatMoney(ask)} sub={`за сезон, на ${years} ${yearsWord(years)}`} color="#F2B544" />
            <Stat label="Ваше предложение" value={<span data-neg-salary>{formatMoney(salary)}</span>} sub={`${pct}% от запроса`} color={pct >= 100 ? '#3FCF8E' : '#E8EEF5'} />
          </div>
          <input type="range" min={70} max={115} step={1} value={pct} onChange={(e) => { setPct(Number(e.target.value)); setAnswer(null); }} className="w-full mt-3 accent-[#e5323e]" aria-label="Оклад в процентах от запроса игрока" />
          <div className="flex justify-between text-[11px] text-muted">
            <span>70%</span>
            <span>игрок согласится не на всякую скидку — у него есть свой минимум</span>
            <span>115%</span>
          </div>
          <div className="mt-3 text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-muted">{extension ? `ФОТ сезона ${seasonLabel(s.league.season, 1)} с этим контрактом` : 'ФОТ с этим контрактом'}</span>
              <span className={cn('tabular', after > cap ? 'text-accent' : 'text-text')}>
                {formatMoney(after)} / {formatMoney(cap)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Бюджет клуба (нужен резерв в размере годового оклада)</span>
              <span className={cn('tabular', U.budget < salary ? 'text-accent' : 'text-text')}>{formatMoney(U.budget)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted">Терпение игрока</span>
              <span className="flex gap-1" title={`Осталось попыток: ${left}`} data-neg-left={left}>
                {Array.from({ length: TALKS }, (_, i) => (
                  <span key={i} className={cn('w-2.5 h-2.5 rounded-full', i < left ? 'bg-ok' : 'bg-line')} />
                ))}
              </span>
            </div>
          </div>
          {answer && (
            <div className={cn('mt-3 text-sm rounded-sm border px-3 py-2', tone)} data-neg-result>
              {answer.text}
            </div>
          )}
          {left <= 0 && !answer && <div className="mt-3 text-sm rounded-sm border border-accent/50 text-accent bg-accent/10 px-3 py-2">Игрок прервал переговоры. Вернуться к ним можно {s.phase === 'offseason' ? 'в следующем сезоне' : 'в межсезонье'}.</div>}
        </>
      )}
      <div className="flex gap-2 justify-end mt-5 pt-4 border-t border-line flex-wrap">
        {signed ? (
          <Button variant="primary" onClick={onClose}>
            Готово
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Закрыть
            </Button>
            <Button disabled={left <= 0} onClick={() => offer(ask)} title="Игрок гарантированно согласится на собственный запрос">
              Принять запрос игрока
            </Button>
            <Button variant="primary" disabled={left <= 0} onClick={() => offer(salary)}>
              Сделать предложение
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}

export function Contracts() {
  const s = useGame()!;
  const ui = useUI();
  const P = s.players;
  const U = s.teams[s.userTeamId];
  const [msg, setMsg] = useState<string | null>(null);
  const rows = U.players.map((id) => P[id]).sort((a, b) => b.contract.salary - a.contract.salary);
  const plan = commitments(U.players, P, 4);
  const cap = s.league.salaryCap;
  const off = s.phase === 'offseason';
  const now = off ? rows.reduce((a, p) => a + (p.contract.years > 0 ? p.contract.salary : 0), 0) : plan[0];
  const ending = rows.filter((p) => p.contract.years <= 1 && !p.contract.next);
  const terminate = (p: Player) => {
    const cost = buyoutCost(s, p);
    ui.confirm({
      title: 'Расторгнуть контракт?',
      text: `${p.name} станет свободным агентом. ${cost > 0 ? `Клуб выплатит компенсацию ${formatMoney(cost)} — треть суммы, оставшейся по контракту.` : 'Компенсация не потребуется.'} ФОТ уменьшится на ${formatMoney(p.contract.salary)}.`,
      danger: true,
      confirmLabel: cost > 0 ? `Расторгнуть за ${formatMoney(cost)}` : 'Расторгнуть',
      onYes: () => setMsg(releasePlayer(p.id)),
    });
  };
  return (
    <div className="space-y-4 fade-in">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Stat label="Фонд оплаты труда" value={formatMoney(now)} sub={`потолок ${formatMoney(cap)}`} color={now > cap ? '#E5323E' : '#E8EEF5'} />
        <Stat label="Свободно под потолком" value={formatMoney(cap - now)} color={cap - now < 0 ? '#E5323E' : '#3FCF8E'} />
        <Stat label="Бюджет клуба" value={formatMoney(U.budget)} sub="зарплаты выплачиваются в конце сезона" />
        <Stat label="Истекают в этом сезоне" value={ending.length} sub={off ? 'решите до старта сезона' : 'можно продлить заранее'} color={ending.length ? '#F2B544' : '#E8EEF5'} />
      </div>

      <Panel title="Обязательства по сезонам">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {plan.map((v, i) => {
            const val = i === 0 ? now : v;
            return (
              <div key={i}>
                <div className="flex justify-between text-xs">
                  <span className="text-muted">{seasonLabel(s.league.season, i)}</span>
                  <span className="tabular">{formatMoney(val)}</span>
                </div>
                <div className="h-2 bg-line rounded-full overflow-hidden mt-1">
                  <div className="h-full rounded-full" style={{ width: `${Math.min(100, (val / cap) * 100)}%`, background: val > cap ? '#E5323E' : val / cap > 0.9 ? '#F2B544' : '#8FD8F0' }} />
                </div>
              </div>
            );
          })}
        </div>
        <div className="text-[11px] text-muted mt-3">Учтены действующие контракты и уже подписанные продления. Свободное место в будущих сезонах — это деньги на новых игроков.</div>
      </Panel>

      {msg && <div className="text-xs rounded-sm border border-accent/50 text-accent bg-accent/10 px-2.5 py-2">{msg}</div>}

      <Panel title={`Контракты · ${U.name}`} noPad>
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular" data-contracts>
            <thead className="bg-panel2/40 text-[11px] uppercase tracking-wider text-muted">
              <tr>
                <th className="text-left pl-4 px-2 py-2 font-semibold">Игрок</th>
                <th className="text-left px-2 py-2 font-semibold">Поз</th>
                <th className="text-left px-2 py-2 font-semibold">Возр</th>
                <th className="text-left px-2 py-2 font-semibold">ОВР</th>
                <th className="text-right px-2 py-2 font-semibold">Оклад</th>
                <th className="text-left px-2 py-2 font-semibold">Срок</th>
                <th className="text-right px-2 py-2 font-semibold">Запрос на продление</th>
                <th className="text-right pr-4 px-2 py-2 font-semibold">Действия</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const c = p.contract;
                const canTalk = c.years <= 1 && !c.next;
                const left = talksLeft(s, p);
                return (
                  <tr key={p.id} className="border-t border-line/60 hover:bg-panel2/60 transition-colors">
                    <td className="pl-4 px-2 py-1.5 font-medium whitespace-nowrap">
                      <button className="hover:text-ice text-left" onClick={() => ui.openPlayer(p.id)}>
                        {p.name}
                      </button>
                      {p.tradeFlag === 'block' && <Tag color="#F2B544" className="ml-2">на обмен</Tag>}
                      {p.tradeFlag === 'keep' && <Tag color="#8FD8F0" className="ml-2">неприкосновенный</Tag>}
                    </td>
                    <td className="px-2 py-1.5">
                      <PosBadge pos={p.position} />
                    </td>
                    <td className="px-2 py-1.5 text-muted">{p.age}</td>
                    <td className="px-2 py-1.5">
                      <OverallChip value={p.overall} size="sm" />
                    </td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">{formatMoney(c.salary)}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {c.years === 0 ? <span className="text-accent">истёк</span> : c.years === 1 ? <span className={c.next ? 'text-text' : 'text-amber'}>последний год</span> : `ещё ${c.years} ${yearsWord(c.years)}`}
                      {c.next && <span className="text-ok"> → {formatMoney(c.next.salary)} × {c.next.years} {yearsWord(c.next.years)}</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right text-muted whitespace-nowrap">{canTalk ? `${formatMoney(askingSalary(s, p, 1, U.id))} / год` : '—'}</td>
                    <td className="pr-4 px-2 py-1.5">
                      <div className="flex gap-1.5 justify-end">
                        {canTalk && (
                          <Button size="sm" variant={c.years === 0 ? 'primary' : 'secondary'} disabled={left <= 0} onClick={() => ui.negotiate(p.id)} title={left <= 0 ? 'Игрок прервал переговоры' : undefined}>
                            {left <= 0 ? 'Отказ' : c.years === 0 ? 'Переговоры' : 'Продлить'}
                          </Button>
                        )}
                        {c.years === 0 ? (
                          <Button size="sm" variant="ghost" onClick={() => letGo(p.id)}>
                            Отпустить
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => terminate(p)} title={`Компенсация ${formatMoney(buyoutCost(s, p))}`}>
                            Расторгнуть
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Как устроены контракты">
        <ul className="text-xs text-text/80 space-y-1.5">
          <li>• У контракта есть оклад за сезон и срок. Зарплаты выплачиваются в конце сезона из доходов клуба; ФОТ не может превышать потолок.</li>
          <li>• В последний год контракт можно продлить заранее: новые условия начнут действовать со следующего сезона. Непродлённые контракты истекают в межсезонье.</li>
          <li>• Переговоры: игрок называет запрос, но готов уступить 3–13% — где именно его предел, неизвестно. На попытки сбить цену у вас {TALKS} попытки; слишком низкое предложение сжигает сразу две.</li>
          <li>• Запрос зависит от рейтинга, возраста и потенциала, срока (молодые берут дороже за длинный контракт, ветераны дешевле), морали и положения команды в таблице.</li>
          <li>• Максимальный срок: до 30 лет — 5 лет, 30–31 — 3 года, 32–34 — 2 года, с 35 — 1 год.</li>
          <li>• Расторжение стоит треть суммы, оставшейся по контракту (упрощённое игровое правило), и выплачивается сразу из бюджета.</li>
        </ul>
      </Panel>
    </div>
  );
}
