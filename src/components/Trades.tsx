import { useEffect, useMemo, useState } from 'react';
import { getTradeWindowsSchedule, groupOf, hasWants, matchesWants, tradeValue, tradeWindow } from '../game/ai';
import { asScouted, scoutSlots } from '../game/scouting';
import { ScoutOvr } from './Scout';
import type { PosCode } from '../types';
import { countRosterLegionnaires, isLegionnaire, teamForeignLimit } from '../game/legionnaires';
import { isRfaEligibleAge, offerSheetCompensation } from '../game/khlRules';
import { regularSeasonLength, seasonDateOnly } from '../game/schedule';
import { formatMoney, payroll } from '../game/ratings';
import { acquireRfaRights, assignUserScout, cancelUserScout, proposeTrade, respondOffer, setTradeBlockWants, setTradeFlag, shopTradeBlockNow, useGame } from '../game/state';
import { Button, Empty, Icon, OverallChip, Panel, PosBadge, Tag, TeamLogo, money, useUI } from './ui';
import { cn } from '../utils/cn';

function PlayerList({ ids, selected, onToggle, title, empty, footer, own = false }: { ids: string[]; selected: string[]; onToggle: (id: string) => void; title: React.ReactNode; empty: string; footer?: React.ReactNode; own?: boolean }) {
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
                  const nmc = !!p.nmc;
                  return (
                    <li key={id}>
                      <div
                        className={cn(
                          'flex items-center gap-2 px-3 py-2 sm:py-1.5 text-sm cursor-pointer transition-colors border-l-2',
                          sel ? 'bg-accent/15 border-accent' : 'border-transparent hover:bg-panel2',
                          (p.injury || nmc) && 'opacity-60'
                        )}
                        onClick={() => onToggle(id)}
                        title={nmc ? 'Контракт содержит пункт ЗНО (запрет на обмен)' : undefined}
                      >
                        <span className={cn('w-4 h-4 rounded-sm border text-[10px] inline-flex items-center justify-center shrink-0 font-bold', sel ? 'bg-accent border-accent text-white' : 'border-line text-muted')}>
                          {sel ? '✓' : '+'}
                        </span>
                        <PosBadge pos={p.position} />
                        <span className="flex-1 truncate text-left min-w-0 font-medium">{p.name}</span>
                        {nmc && <span className="text-[9px] font-bold px-1 rounded bg-gold/25 text-gold shrink-0" title="Запрет на обмен (NMC)">ЗНО</span>}
                        {isLegionnaire(p) && <span className="text-[9px] font-bold px-1 rounded bg-gold/20 text-gold shrink-0" title={p.country}>ЛЕГ</span>}
                        <span className="hidden sm:inline text-xs text-muted w-6 tabular">{p.age}</span>
                        {own && p.tradeFlag === 'block' && <span className="text-[9px] font-bold px-1 rounded bg-amber/20 text-amber shrink-0" title="Выставлен на обмен">БЛОК</span>}
                        {own ? <OverallChip value={p.overall} size="sm" /> : <ScoutOvr p={p} />}
                        <span className="text-xs text-muted w-16 sm:w-20 text-right tabular shrink-0">{money(p.contract.salary)}</span>
                        <span className="hidden sm:inline text-xs text-muted w-8 text-right tabular">{p.contract.years} г.</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            ui.openPlayer(id);
                          }}
                          className="px-1.5 py-0.5 text-xs text-muted hover:text-ice rounded border border-line/60 shrink-0"
                          title="Карточка игрока"
                        >
                          ⓘ
                        </button>
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
  const [mobileSide, setMobileSide] = useState<'give' | 'get'>('give');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!preselect) return;
    const pl = s.players[preselect];
    if (!pl || !pl.teamId) return;
    setMsg(null);
    if (pl.teamId === s.userTeamId) {
      setGive([preselect]);
      setMobileSide('give');
    } else {
      // a player of another club: open that club and put him on the "we get" side
      setPartnerId(pl.teamId);
      setGet([preselect]);
      setGive([]);
      setMobileSide('get');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselect]);
  const partner = s.teams[partnerId];
  const gv = give.reduce((a, id) => a + tradeValue(P[id]), 0);
  // Players of other clubs are valued from the scouts' reports, not from hidden true ratings.
  const rv = get.reduce((a, id) => a + tradeValue(asScouted(s, P[id])), 0);
  const afterIds = U.players.filter((id) => !give.includes(id)).concat(get);
  const dead = s.phase === 'offseason' ? 0 : (U.deadCap ?? 0);
  const beforePayroll = payroll(U.players, P) + dead;
  const afterPayroll = payroll(afterIds, P) + dead;
  const salaryDumpOk = beforePayroll > s.league.salaryCap && afterPayroll <= beforePayroll - 5_000_000;
  const capBlocked = afterPayroll > s.league.salaryCap && !salaryDumpOk;
  const fl = teamForeignLimit(U, s.league.foreignLimit);
  const beforeLegs = countRosterLegionnaires(U.players, P);
  const afterLegs = countRosterLegionnaires(afterIds, P);
  const legBlocked = fl !== null && afterLegs > fl && (afterLegs > beforeLegs || get.some((id) => isLegionnaire(P[id])));
  const win = tradeWindow(s);
  const windows = useMemo(() => getTradeWindowsSchedule(s), [s]);
  const regLen = regularSeasonLength(s.schedule);
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

      {/* Trade Windows Visual Schedule (horizontal swipe strip on phones) */}
      <div className="flex overflow-x-auto no-scrollbar sm:grid sm:grid-cols-2 lg:grid-cols-5 gap-2 pb-0.5" data-trades-windows>
        {windows.map((w) => {
          const active = w.status === 'active';
          const range = w.id === 'offseason' ? 'Межсезонье' : `${seasonDateOnly(w.startDay, regLen, s.league.season)} — ${seasonDateOnly(w.endDay, regLen, s.league.season)}`;
          return (
            <div
              key={w.id}
              className={cn(
                'rounded-md border px-2.5 py-2 text-xs min-w-[205px] sm:min-w-0 shrink-0',
                active ? (w.open ? 'border-ok/60 bg-ok/10' : 'border-amber/60 bg-amber/10') : 'border-line/70 bg-panel/70 opacity-80'
              )}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="font-display font-bold uppercase tracking-wide truncate">{w.title}</span>
                <span className={cn('text-[10px] font-bold uppercase px-1 rounded', w.open ? 'bg-ok/20 text-ok' : 'bg-accent/20 text-accent')}>
                  {w.open ? 'Открыто' : 'Стоп'}
                </span>
              </div>
              <div className="text-[11px] text-ice mt-0.5">{range}</div>
            </div>
          );
        })}
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
                        <button key={id} className="text-amber hover:underline inline-flex items-center gap-1 mr-1.5" onClick={() => ui.openPlayer(id)}>
                          {P[id].name} <span className="text-muted">({P[id].position}, {P[id].age} л.)</span> <ScoutOvr p={P[id]} />
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

      <TradeBlockPanel onPick={(id) => { const pl = P[id]; if (!pl?.teamId) return; setPartnerId(pl.teamId); setGet([id]); setGive([]); setMobileSide('get'); setMsg(null); }} />
      <ScoutingPanel partnerId={partnerId} selected={get} />

      {/* Mobile 2-Club Switcher (prevents scrolling past 30 players on phones) */}
      <div className="xl:hidden grid grid-cols-2 gap-1 rounded-md border border-line bg-panel p-1 sticky top-[49px] z-20">
        <button
          type="button"
          onClick={() => setMobileSide('give')}
          className={cn(
            'py-2 px-2 rounded-sm text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors',
            mobileSide === 'give' ? 'bg-accent text-white' : 'bg-panel2/50 text-muted'
          )}
        >
          <TeamLogo team={U} size={18} />
          <span className="truncate">Отдаём ({give.length})</span>
        </button>
        <button
          type="button"
          onClick={() => setMobileSide('get')}
          className={cn(
            'py-2 px-2 rounded-sm text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors',
            mobileSide === 'get' ? 'bg-ok text-bg' : 'bg-panel2/50 text-muted'
          )}
        >
          <TeamLogo team={partner} size={18} />
          <span className="truncate">Получаем: {partner.short} ({get.length})</span>
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_320px] gap-4">
        <div className={cn(mobileSide !== 'give' && 'hidden xl:block')}>
          <PlayerList own ids={U.players} selected={give} onToggle={(id) => toggle(id, give, setGive, get)} title={<span className="flex items-center gap-2"><TeamLogo team={U} size={20} /> Отдаём: {U.short}</span>} empty="Нет игроков" footer="Нажмите игрока — добавить/убрать из обмена (до 3 с каждой стороны)." />
        </div>
        <div className={cn(mobileSide !== 'get' && 'hidden xl:block')}>
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
        </div>

        <div className="space-y-4 xl:col-span-2 2xl:col-span-1">
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
                <span className={cn('tabular', capBlocked ? 'text-accent' : salaryDumpOk ? 'text-amber' : 'text-text')}>{formatMoney(afterPayroll)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Потолок КХЛ</span>
                <span className="tabular">{formatMoney(s.league.salaryCap)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Легионеры после обмена</span>
                <span className={cn('tabular', legBlocked ? 'text-accent font-semibold' : 'text-ice')}>
                  {fl !== null ? `${afterLegs} / ${fl}` : `${afterLegs} (без лим.)`}
                </span>
              </div>
            </div>
            {msg && (
              <div className={cn('mt-3 text-xs rounded-sm border px-2.5 py-2', msg.ok ? 'border-ok/50 text-ok bg-ok/10' : 'border-accent/50 text-accent bg-accent/10')}>{msg.text}</div>
            )}
            <Button variant="primary" className="w-full mt-3" disabled={!give.length || !get.length || capBlocked || legBlocked || !win.open} onClick={propose}>
              Предложить обмен
            </Button>
            {capBlocked && <div className="text-[11px] text-accent mt-1">Обмен превышает потолок зарплат</div>}
            {salaryDumpOk && <div className="text-[11px] text-amber mt-1">Разгрузка ФОТ: сделка разрешена для снижения превышения потолка</div>}
            {legBlocked && <div className="text-[11px] text-accent mt-1">Обмен превышает лимит легионеров КХЛ ({fl})</div>}
          </Panel>
          {(() => {
            const rfaPool = s.freeAgents
              .map((id) => P[id])
              .filter((p) => p && p.rightsTeamId && p.rightsTeamId !== U.id && isRfaEligibleAge(p.age));
            if (!rfaPool.length) return null;
            return (
              <Panel title="Выкуп спортивных прав ОСА" right={<Tag tone="accent">{rfaPool.length}</Tag>}>
                <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1 text-xs">
                  {rfaPool.slice(0, 8).map((rp) => {
                    const price = Math.round(offerSheetCompensation(rp.contract.salary || 25_000_000, rp.overall) * 0.75);
                    const holder = s.teams[rp.rightsTeamId!];
                    return (
                      <div key={rp.id} className="flex items-center justify-between gap-2 py-1 border-b border-line/50">
                        <div className="min-w-0">
                          <button onClick={() => ui.openPlayer(rp.id)} className="font-semibold hover:text-ice truncate block text-left">
                            {rp.name} ({rp.age} л., OVR {rp.overall})
                          </button>
                          <span className="text-[10px] text-muted">Права: {holder?.short} · {formatMoney(price)}</span>
                        </div>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!win.open || U.budget < price}
                          onClick={() => {
                            const res = acquireRfaRights(rp.id, price);
                            setMsg({ ok: res.ok, text: res.reason });
                          }}
                        >
                          Выкупить права
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </Panel>
            );
          })()}
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

      {/* Floating Sticky Mobile Trade Summary Bar when players are selected */}
      {(give.length > 0 || get.length > 0) && (
        <div className="2xl:hidden sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] xl:bottom-3 z-20 rounded-md border border-ice/50 bg-panel/95 backdrop-blur p-3 shadow-2xl space-y-2 text-xs">
          <div className="flex items-center justify-between gap-2 tabular">
            <span>
              Отдаём ({give.length}): <b className="text-accent">{gv.toFixed(1)}</b>
            </span>
            <span>
              Получаем ({get.length}): <b className="text-ok">{rv.toFixed(1)}</b>
            </span>
            <span className={cn(capBlocked ? 'text-accent font-semibold' : 'text-muted')}>
              ФОТ: {formatMoney(afterPayroll)}
            </span>
          </div>
          {msg && (
            <div className={cn('rounded-sm border px-2 py-1', msg.ok ? 'border-ok/50 text-ok bg-ok/10' : 'border-accent/50 text-accent bg-accent/10')}>
              {msg.text}
            </div>
          )}
          <div className="flex gap-2">
            {give.length > 0 && get.length === 0 ? (
              <Button size="sm" variant="ice" className="flex-1" onClick={() => setMobileSide('get')}>
                Выбрать кого получаем ({partner.short}) →
              </Button>
            ) : get.length > 0 && give.length === 0 ? (
              <Button size="sm" variant="ice" className="flex-1" onClick={() => setMobileSide('give')}>
                ← Выбрать кого отдаём ({U.short})
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                className="flex-1"
                disabled={!give.length || !get.length || capBlocked || legBlocked || !win.open}
                onClick={propose}
              >
                Предложить обмен
              </Button>
            )}
            <Button size="sm" variant="ghost" className="border border-line" onClick={() => { setGive([]); setGet([]); setMsg(null); }}>
              Сброс
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const POSITIONS: [PosCode, string][] = [['C', 'Ц'], ['LW', 'ЛН'], ['RW', 'ПН'], ['D', 'З'], ['G', 'В']];
const SALARY_STEPS = [0, 20_000_000, 40_000_000, 60_000_000, 90_000_000, 130_000_000];

/** "Блок обменов": what we look for and whom we are ready to move; AI clubs build offers around it. */
function TradeBlockPanel({ onPick }: { onPick: (id: string) => void }) {
  const s = useGame()!;
  const ui = useUI();
  const P = s.players;
  const U = s.teams[s.userTeamId];
  const w = s.tradeBlock?.wants ?? { positions: [], minOvr: 0, maxAge: 40, maxSalary: 0 };
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [showOwn, setShowOwn] = useState(false);
  const block = U.players.filter((id) => P[id]?.tradeFlag === 'block');
  const win = tradeWindow(s);
  const active = hasWants(w);
  // League players matching the wish list, judged by our scouts' reports.
  const matches = active
    ? s.teamOrder
        .filter((id) => id !== U.id)
        .flatMap((id) => s.teams[id].players)
        .map((id) => P[id])
        .filter((p) => p && matchesWants(w, asScouted(s, p)))
        .sort((a, b) => asScouted(s, b).overall - asScouted(s, a).overall)
        .slice(0, 8)
    : [];
  const togglePos = (pos: PosCode) => setTradeBlockWants({ positions: w.positions.includes(pos) ? w.positions.filter((x) => x !== pos) : [...w.positions, pos] });
  const cooldown = s.tradeBlock?.lastShopDay != null && s.phase !== 'offseason' ? Math.max(0, 7 - (s.day - s.tradeBlock.lastShopDay)) : 0;
  return (
    <Panel title="Блок обменов" right={<span className="text-xs text-muted">{block.length} на обмен · {active ? 'запрос задан' : 'запрос не задан'}</span>} data-trade-block>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
        <div className="space-y-2.5" data-trade-wants>
          <div className="text-[11px] uppercase tracking-wider text-muted">Кого мы ищем</div>
          <div className="flex items-center gap-1 flex-wrap">
            <span className="text-muted w-20">Позиции</span>
            {POSITIONS.map(([pos, lbl]) => (
              <button key={pos} type="button" data-want-pos={pos} onClick={() => togglePos(pos)} className={cn('px-2 py-1 rounded-sm border font-semibold', w.positions.includes(pos) ? 'bg-ice text-bg border-ice' : 'bg-panel2 border-line text-muted')}>
                {lbl}
              </button>
            ))}
            {w.positions.length === 0 && <span className="text-muted">любые</span>}
          </div>
          <label className="flex items-center gap-2">
            <span className="text-muted w-20">Рейтинг от</span>
            <input type="range" min={0} max={85} step={1} value={w.minOvr} onChange={(e) => setTradeBlockWants({ minOvr: Number(e.target.value) })} className="flex-1 accent-[#8FD8F0]" data-want-ovr />
            <span className="tabular w-10 text-right">{w.minOvr || 'любой'}</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-muted w-20">Возраст до</span>
            <input type="range" min={20} max={40} step={1} value={w.maxAge} onChange={(e) => setTradeBlockWants({ maxAge: Number(e.target.value) })} className="flex-1 accent-[#8FD8F0]" data-want-age />
            <span className="tabular w-10 text-right">{w.maxAge >= 40 ? 'любой' : w.maxAge}</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-muted w-20">Зарплата до</span>
            <select value={w.maxSalary} onChange={(e) => setTradeBlockWants({ maxSalary: Number(e.target.value) })} className="flex-1 bg-panel2 border border-line rounded-sm px-2 py-1 text-text">
              {SALARY_STEPS.map((v) => (
                <option key={v} value={v}>{v ? formatMoney(v) : 'любая'}</option>
              ))}
            </select>
          </label>
          {active && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Подходят по отчётам скаутов</div>
              <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                {matches.length === 0 && <div className="text-muted">Никто в лиге не подходит — ослабьте требования.</div>}
                {matches.map((p) => (
                  <div key={p.id} className="flex items-center gap-2">
                    <PosBadge pos={p.position} />
                    <button type="button" className="flex-1 truncate text-left hover:text-ice" onClick={() => ui.openPlayer(p.id)}>{p.name}</button>
                    <span className="text-muted">{s.teams[p.teamId!]?.short} · {p.age} л.</span>
                    <ScoutOvr p={p} />
                    <button type="button" className="px-1.5 py-0.5 rounded border border-line text-muted hover:text-ice" onClick={() => onPick(p.id)} title="Открыть обмен с этим клубом">⇄</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="space-y-2" data-trade-offered>
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-muted">Кого мы готовы отдать</span>
            <button type="button" className="text-ice hover:underline" onClick={() => setShowOwn((v) => !v)}>{showOwn ? 'Готово' : '+ Добавить игроков'}</button>
          </div>
          {!showOwn && block.length === 0 && <div className="text-muted">Пока никого. Добавьте игроков — клубы будут строить предложения вокруг них.</div>}
          <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
            {(showOwn ? [...U.players].sort((a, b) => P[b].overall - P[a].overall) : block).map((id) => {
              const p = P[id];
              const on = p.tradeFlag === 'block';
              return (
                <div key={id} className={cn('flex items-center gap-2 rounded-sm px-1.5 py-1', on && 'bg-amber/10')}>
                  <PosBadge pos={p.position} />
                  <button type="button" className="flex-1 truncate text-left hover:text-ice" onClick={() => ui.openPlayer(id)}>{p.name}</button>
                  <span className="text-muted">{p.age} л. · {money(p.contract.salary)}</span>
                  <OverallChip value={p.overall} size="sm" />
                  <button
                    type="button"
                    data-block-toggle={id}
                    disabled={p.tradeFlag === 'keep' || !!p.nmc}
                    onClick={() => setTradeFlag(id, on ? null : 'block')}
                    className={cn('px-1.5 py-0.5 rounded border font-semibold disabled:opacity-40', on ? 'border-amber text-amber' : 'border-line text-muted hover:text-text')}
                    title={p.nmc ? 'Запрет на обмен (ЗНО)' : p.tradeFlag === 'keep' ? 'Неприкосновенный' : undefined}
                  >
                    {on ? 'убрать' : 'в блок'}
                  </button>
                </div>
              );
            })}
          </div>
          <div className="pt-2 border-t border-line/60 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={!win.open || cooldown > 0 || (!block.length && !active)}
              onClick={() => setNote(shopTradeBlockNow())}
              data-shop-block
            >
              Опросить клубы лиги
            </Button>
            <span className="text-muted">{!win.open ? 'окно обменов закрыто' : cooldown > 0 ? `повторно через ${cooldown} дн.` : 'до 3 предложений, раз в неделю'}</span>
          </div>
          {note && <div className={cn('rounded-sm border px-2 py-1.5', note.ok ? 'border-ok/50 text-ok bg-ok/10' : 'border-accent/50 text-accent bg-accent/10')}>{note.text}</div>}
          <div className="text-[11px] text-muted">Клубы, которым нужны игроки из вашего блока, чаще присылают предложения и платят игроками из вашего запроса.</div>
        </div>
      </div>
    </Panel>
  );
}

/** Scouting assignments: who is being watched, and quick buttons for the current trade partner. */
function ScoutingPanel({ partnerId, selected }: { partnerId: string; selected: string[] }) {
  const s = useGame()!;
  const ui = useUI();
  const [err, setErr] = useState<string | null>(null);
  const sc = s.scouting ?? { knowledge: {}, assignments: [] };
  const slots = scoutSlots(s);
  const partner = s.teams[partnerId];
  const run = (kind: 'player' | 'team', target: string) => setErr(assignUserScout(kind, target));
  return (
    <Panel title="Скауты" right={<span className="text-xs text-muted">{sc.assignments.length} / {slots} заданий</span>} data-scouting>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {sc.assignments.length === 0 && <span className="text-muted">Скауты свободны.</span>}
        {sc.assignments.map((a) => {
          const label = a.kind === 'team' ? `Клуб «${s.teams[a.target]?.short ?? a.target}»` : s.players[a.target]?.name ?? a.target;
          return (
            <span key={a.kind + a.target} className="inline-flex items-center gap-1 rounded-sm border border-ice/40 bg-ice/10 px-2 py-0.5">
              <Icon name="scout" className="w-3 h-3" />
              <button type="button" className="hover:underline" onClick={() => (a.kind === 'player' ? ui.openPlayer(a.target) : undefined)}>{label}</button>
              <span className="text-muted">с дня {a.since + 1}</span>
              <button type="button" className="text-muted hover:text-text" onClick={() => cancelUserScout(a.kind, a.target)} title="Отозвать">×</button>
            </span>
          );
        })}
        <span className="flex-1" />
        <Button size="sm" variant="secondary" onClick={() => run('team', partnerId)}>Изучить «{partner.short}»</Button>
        {selected.length > 0 && (
          <Button size="sm" variant="secondary" onClick={() => selected.forEach((id) => run('player', id))}>
            Скаута на выбранных ({selected.length})
          </Button>
        )}
      </div>
      {err && <div className="text-[11px] text-accent mt-1.5">{err}</div>}
      <div className="text-[11px] text-muted mt-1.5">Рейтинги чужих игроков — оценка скаутов («78 ±6»). Точность растёт от заданий, матчей против клуба и уровня скаутского бюро (Инфраструктура).</div>
    </Panel>
  );
}
