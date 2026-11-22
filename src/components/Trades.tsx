import { useEffect, useState } from 'react';
import { groupOf, tradeValue, tradeWindow } from '../game/ai';
import { formatMoney, payroll } from '../game/ratings';
import { proposeTrade, respondOffer, useGame } from '../game/state';
import { Button, Empty, OverallChip, Panel, PosBadge, TeamLogo, money, useUI } from './ui';
import { cn } from '../utils/cn';

function PlayerList({ ids, selected, onToggle, title, empty, footer }: { ids: string[]; selected: string[]; onToggle: (id: string) => void; title: React.ReactNode; empty: string; footer?: React.ReactNode }) {
  const s = useGame()!;
  const ui = useUI();
  const P = s.players;
  const groups: [string, 'F' | 'D' | 'G'][] = [
    ['Нападающие', 'F'],
    ['Защитники', 'D'],
    ['Вратари', 'G'],
  ];
  return (
    <Panel title={title} noPad>
      {ids.length === 0 ? (
        <div className="p-4">
          <Empty text={empty} />
        </div>
      ) : (
        groups.map(([g, key]) => {
          const list = ids.filter((id) => groupOf(P[id]) === key).sort((a, b) => P[b].overall - P[a].overall);
          if (!list.length) return null;
          return (
            <div key={g}>
              <div className="px-3 pt-3 pb-1 text-[11px] uppercase tracking-wider text-muted">{g}</div>
              <ul>
                {list.map((id) => {
                  const p = P[id];
                  const sel = selected.includes(id);
                  return (
                    <li key={id}>
                      <div className={cn('flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer transition-colors border-l-2', sel ? 'bg-accent/10 border-accent' : 'border-transparent hover:bg-panel2', p.injury && 'opacity-60')} onClick={() => onToggle(id)}>
                        <PosBadge pos={p.position} />
                        <button className="flex-1 truncate text-left hover:text-ice min-w-0" onClick={(e) => { e.stopPropagation(); ui.openPlayer(id); }} title={p.name}>
                          {p.name}
                        </button>
                        <span className="text-xs text-muted w-6 tabular">{p.age}</span>
                        <OverallChip value={p.overall} size="sm" />
                        <span className="text-xs text-muted w-20 text-right tabular">{money(p.contract.salary)}</span>
                        <span className="text-xs text-muted w-8 text-right tabular">{p.contract.years} г.</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })
      )}
      {footer && <div className="px-3 py-2 border-t border-line/60 text-xs text-muted">{footer}</div>}
    </Panel>
  );
}

export function Trades({ preselect }: { preselect: string | null }) {
  const s = useGame()!;
  const ui = useUI();
  const P = s.players;
  const U = s.teams[s.userTeamId];
  const [partnerId, setPartnerId] = useState(s.teamOrder.find((id) => id !== U.id) ?? '');
  const [give, setGive] = useState<string[]>([]);
  const [get, setGet] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!preselect) return;
    const pl = s.players[preselect];
    if (!pl || !pl.teamId) return;
    setMsg(null);
    if (pl.teamId === s.userTeamId) {
      setGive([preselect]);
    } else {
      // a player of another club: open that club and put him on the "we get" side
      setPartnerId(pl.teamId);
      setGet([preselect]);
      setGive([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselect]);
  const partner = s.teams[partnerId];
  const gv = give.reduce((a, id) => a + tradeValue(P[id]), 0);
  const rv = get.reduce((a, id) => a + tradeValue(P[id]), 0);
  const afterIds = U.players.filter((id) => !give.includes(id)).concat(get);
  const afterPayroll = payroll(afterIds, P);
  const overCap = afterPayroll > s.league.salaryCap;
  const win = tradeWindow(s);
  const maxValue = Math.max(gv, rv, 1);

  const toggle = (id: string, list: string[], set: (v: string[]) => void, other: string[]) => {
    if (other.includes(id)) return;
    set(list.includes(id) ? list.filter((x) => x !== id) : list.length >= 3 ? list : [...list, id]);
  };
  const propose = () => {
    const r = proposeTrade(partnerId, give, get);
    setMsg({ ok: r.ok, text: r.reason });
    if (r.ok) {
      setGive([]);
      setGet([]);
    }
  };

  return (
    <div className="space-y-4 fade-in">
      <div data-trade-window className={cn('rounded-md border px-3 py-2 text-sm flex items-center gap-2 flex-wrap', win.open ? (win.daysLeft <= 8 ? 'border-amber/50 bg-amber/10 text-amber' : 'border-line bg-panel2/50 text-text/85') : 'border-accent/50 bg-accent/10 text-accent')}>
        <b>{win.open ? 'Окно обменов открыто.' : 'Окно обменов закрыто.'}</b>
        <span>{win.text}</span>
      </div>
      {s.offers.length > 0 && (
        <Panel title={`Входящие предложения (${s.offers.length})`} className="border-amber/40">
          <div className="space-y-2">
            {s.offers.map((o) => {
              const from = s.teams[o.from];
              return (
                <div key={o.id} className="flex items-center gap-3 flex-wrap rounded-sm border border-line bg-panel2/60 p-2.5">
                  <TeamLogo team={from} size={30} />
                  <div className="flex-1 min-w-[240px] text-sm">
                    <div>
                      <b>{from.name}</b> хочет:{' '}
                      {o.get.map((id) => (
                        <button key={id} className="text-ice hover:underline" onClick={() => ui.openPlayer(id)}>
                          {P[id].name}
                        </button>
                      ))}
                    </div>
                    <div className="text-muted">
                      взамен предлагает:{' '}
                      {o.give.map((id) => (
                        <button key={id} className="text-amber hover:underline" onClick={() => ui.openPlayer(id)}>
                          {P[id].name}
                        </button>
                      ))}
                    </div>
                    {o.reason && <div className="text-xs text-ice mt-1" data-offer-reason>{o.reason}</div>}
                    <div className="text-[11px] text-muted mt-0.5">предложение действует до дня {o.expires + 1}</div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="primary" size="sm" onClick={() => { const e = respondOffer(o.id, true); if (e) setMsg({ ok: false, text: e }); else setMsg({ ok: true, text: 'Обмен завершён' }); }}>
                      Принять
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => respondOffer(o.id, false)}>
                      Отклонить
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_1fr_320px] gap-4">
        <PlayerList ids={U.players} selected={give} onToggle={(id) => toggle(id, give, setGive, get)} title={<span className="flex items-center gap-2"><TeamLogo team={U} size={20} /> Отдаём: {U.short}</span>} empty="Нет игроков" footer="Клик — добавить/убрать из обмена. До 3 игроков с каждой стороны." />
        <PlayerList
          ids={partner.players}
          selected={get}
          onToggle={(id) => toggle(id, get, setGet, give)}
          title={
            <span className="flex items-center gap-2">
              <TeamLogo team={partner} size={20} />
              <select value={partnerId} onChange={(e) => { setPartnerId(e.target.value); setGet([]); }} className="bg-panel2 border border-line rounded-sm text-sm px-2 py-1 text-text max-w-[180px]">
                {s.teamOrder.filter((id) => id !== U.id).map((id) => (
                  <option key={id} value={id}>
                    {s.teams[id].name}
                  </option>
                ))}
              </select>
            </span>
          }
          empty="Нет игроков"
          footer={`${partner.name}: ${partner.record.points} очков, ФОТ ${formatMoney(payroll(partner.players, P))}`}
        />

        <div className="space-y-4">
          <Panel title="Условия обмена">
            <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Вы отдаёте</div>
            <div className="flex flex-wrap gap-1 mb-3 min-h-[26px]">
              {give.length === 0 && <span className="text-xs text-muted">— выберите слева</span>}
              {give.map((id) => (
                <button key={id} onClick={() => setGive(give.filter((x) => x !== id))} className="text-xs bg-panel2 border border-accent/50 rounded-sm px-2 py-0.5 hover:border-accent">
                  {P[id].name} ×
                </button>
              ))}
            </div>
            <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Вы получаете</div>
            <div className="flex flex-wrap gap-1 mb-3 min-h-[26px]">
              {get.length === 0 && <span className="text-xs text-muted">— выберите справа</span>}
              {get.map((id) => (
                <button key={id} onClick={() => setGet(get.filter((x) => x !== id))} className="text-xs bg-panel2 border border-ok/50 rounded-sm px-2 py-0.5 hover:border-ok">
                  {P[id].name} ×
                </button>
              ))}
            </div>
            <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Ценность по оценке клубов</div>
            <div className="space-y-1.5 text-xs tabular">
              <div className="flex items-center gap-2">
                <span className="w-20 text-muted">Отдаёте</span>
                <div className="flex-1 h-2 bg-line rounded-full overflow-hidden">
                  <div className="h-full bg-accent rounded-full transition-all duration-300" style={{ width: `${(gv / maxValue) * 100}%` }} />
                </div>
                <span className="w-10 text-right">{gv.toFixed(1)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-20 text-muted">Получаете</span>
                <div className="flex-1 h-2 bg-line rounded-full overflow-hidden">
                  <div className="h-full bg-ok rounded-full transition-all duration-300" style={{ width: `${(rv / maxValue) * 100}%` }} />
                </div>
                <span className="w-10 text-right">{rv.toFixed(1)}</span>
              </div>
            </div>
            <div className="mt-3 text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-muted">ФОТ после обмена</span>
                <span className={cn('tabular', overCap ? 'text-accent' : 'text-text')}>{formatMoney(afterPayroll)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Потолок</span>
                <span className="tabular">{formatMoney(s.league.salaryCap)}</span>
              </div>
            </div>
            {msg && (
              <div className={cn('mt-3 text-xs rounded-sm border px-2.5 py-2', msg.ok ? 'border-ok/50 text-ok bg-ok/10' : 'border-accent/50 text-accent bg-accent/10')}>{msg.text}</div>
            )}
            <Button variant="primary" className="w-full mt-3" disabled={!give.length || !get.length || overCap || !win.open} onClick={propose}>
              Предложить обмен
            </Button>
            {overCap && <div className="text-[11px] text-accent mt-1">Обмен превышает потолок зарплат</div>}
          </Panel>
          <Panel title="Как оценивают клубы">
            <ul className="text-xs text-text/80 space-y-1.5">
              <li>• Ценность игрока зависит от рейтинга, возраста, потенциала и контракта.</li>
              <li>• Клубы неохотно отдают лидеров и не станут ослаблять позицию, где и так мало игроков.</li>
              <li>• Предложения клубов приходят в ленту новостей и сюда, действуют до 5 игровых дней.</li>
              <li>• Клубы предлагают обмены не случайно: претенденты закрывают слабую позицию и платят молодёжью, перестраивающиеся команды продают ветеранов. Причина указана в каждом предложении.</li>
              <li>• В карточке игрока можно выставить его на обмен (по нему будут чаще приходить предложения) или объявить неприкосновенным.</li>
              <li>• Обмены закрываются дедлайном — примерно после двух третей регулярного чемпионата — и снова открываются в межсезонье.</li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
