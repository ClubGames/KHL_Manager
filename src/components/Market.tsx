import { useState } from 'react';
import { groupOf } from '../game/ai';
import { askingSalary, talksLeft } from '../game/contracts';
import { playerInterest, REFUSE_BELOW } from '../game/negotiation';
import { getCapSummary } from '../game/cap';
import { countRosterLegionnaires, countryCode, isLegionnaire, teamForeignLimit } from '../game/legionnaires';
import { activeKhlCount, isRfaEligibleAge, offerSheetCompensation, vhlCount } from '../game/khlRules';
import { formatMoney } from '../game/ratings';
import { claimFromWaivers, useGame } from '../game/state';
import { Button, Panel, PlayerFace, PosBadge, Tag, TeamLogo, useUI } from './ui';
import { ScoutOvr } from './Scout';
import { cn } from '../utils/cn';
import { FL, LG } from '../brand';

export function Market() {
  const s = useGame()!;
  const ui = useUI();
  const P = s.players;
  const U = s.teams[s.userTeamId];
  const [pos, setPos] = useState<'ALL' | 'F' | 'D' | 'G'>('ALL');
  const [natFilter, setNatFilter] = useState<'ALL' | 'EAEU' | 'LEG'>('ALL');
  const [faFilter, setFaFilter] = useState<'ALL' | 'UFA' | 'RFA'>('ALL');
  const [waiverMsg, setWaiverMsg] = useState<string | null>(null);
  const fl = teamForeignLimit(U, s.league.foreignLimit);
  const curLegs = countRosterLegionnaires(U.players, P);
  const capInfo = getCapSummary(s, U.id);
  const fol = capInfo.totalPayroll;
  const cap = s.league.salaryCap;
  const khlRosterCount = activeKhlCount(U.players, P);
  const farmRosterCount = vhlCount(U.players, P);
  const activeWaivers = (s.waivers ?? []).filter((w) => w.expiresDay > s.day && P[w.playerId]);

  const list = s.freeAgents
    .map((id) => P[id])
    .filter((p) => {
      if (!p) return false;
      if (pos !== 'ALL' && groupOf(p) !== pos) return false;
      if (natFilter === 'EAEU' && isLegionnaire(p)) return false;
      if (natFilter === 'LEG' && !isLegionnaire(p)) return false;
      const isRfa = !!p.rightsTeamId && isRfaEligibleAge(p.age);
      if (faFilter === 'UFA' && isRfa) return false;
      if (faFilter === 'RFA' && !isRfa) return false;
      return true;
    })
    .sort((a, b) => b.overall - a.overall);

  return (
    <div className="space-y-4 fade-in">
      {waiverMsg && (
        <div className="rounded-md border border-ice/40 bg-ice/10 px-3 py-2 text-xs text-ice">{waiverMsg}</div>
      )}
      {activeWaivers.length > 0 && (
        <Panel title={`Драфт отказов ${LG()} (Waiver Wire · ${activeWaivers.length})`} right={<Tag tone="warn">48 часов · бесплатно</Tag>}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {activeWaivers.map((w) => {
              const wp = P[w.playerId];
              const fromT = s.teams[w.fromTeamId];
              if (!wp) return null;
              return (
                <div key={w.playerId} className="rounded-sm border border-line bg-panel2/60 p-2.5 flex items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    {fromT && <TeamLogo team={fromT} size={24} />}
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <PosBadge pos={wp.position} />
                        <button onClick={() => ui.openPlayer(wp.id)} className="font-semibold text-sm hover:text-ice truncate">
                          {wp.name}
                        </button>
                        <ScoutOvr p={wp} />
                      </div>
                      <div className="text-[11px] text-muted">
                        Из {fromT?.short ?? LG()} · {wp.age} л. · оклад {formatMoney(wp.contract.salary)} × {wp.contract.years} г.
                      </div>
                    </div>
                  </div>
                  {w.fromTeamId !== U.id ? (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        const err = claimFromWaivers(wp.id);
                        setWaiverMsg(err ?? `${wp.name} забран со списка отказов ${LG()}!`);
                      }}
                    >
                      Забрать с отказов
                    </Button>
                  ) : (
                    <Tag>Ваш игрок</Tag>
                  )}
                </div>
              );
            })}
          </div>
        </Panel>
      )}
      <Panel
        title="Рынок свободных агентов (НСА и ОСА)"
        noPad
      >
        {/* Clean scrollable filter toolbar (never crushes header on narrow phones) */}
        <div className="px-3 sm:px-4 py-2.5 border-b border-line/60 bg-panel2/30 space-y-2">
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
            {(['ALL', 'F', 'D', 'G'] as const).map((k) => (
              <button key={k} onClick={() => setPos(k)} className={cn('text-xs px-2.5 py-1.5 sm:py-1 rounded-sm font-semibold whitespace-nowrap shrink-0', pos === k ? 'bg-accent text-white' : 'text-muted hover:text-text bg-panel2')}>
                {k === 'ALL' ? 'Все позиции' : k === 'F' ? 'Нападающие' : k === 'D' ? 'Защитники' : 'Вратари'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
            <div className="flex items-center gap-1 shrink-0">
              {([
                ['ALL', 'НСА + ОСА'],
                ['UFA', 'НСА (28+)'],
                ['RFA', 'ОСА (<28)'],
              ] as const).map(([k, lbl]) => (
                <button
                  key={k}
                  onClick={() => setFaFilter(k)}
                  className={cn('text-[11px] px-2 py-1 rounded-sm font-semibold cursor-pointer whitespace-nowrap', faFilter === k ? 'bg-gold text-bg' : 'text-muted hover:text-text bg-bg/60')}
                >
                  {lbl}
                </button>
              ))}
            </div>
            <span className="w-px h-4 bg-line shrink-0" />
            <div className="flex items-center gap-1 shrink-0">
              {([
                ['ALL', 'Все паспорта'],
                ['EAEU', 'ЕАЭС'],
                ['LEG', 'Легионеры'],
              ] as const).map(([k, lbl]) => (
                <button
                  key={k}
                  onClick={() => setNatFilter(k)}
                  className={cn('text-[11px] px-2 py-1 rounded-sm font-semibold whitespace-nowrap', natFilter === k ? 'bg-ice text-bg' : 'text-muted hover:text-text bg-bg/60')}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="px-3 sm:px-4 py-2 text-xs text-muted flex gap-x-3 gap-y-1 flex-wrap border-b border-line/60">
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
            Легионеры в клубе:{' '}
            <b className={fl !== null && curLegs >= fl ? 'text-gold' : 'text-ice'}>
              {fl !== null ? `${curLegs} / ${fl}` : `${curLegs} (без лим.)`}
            </b>
          </span>
          <span>
            Бюджет: <b className="text-text">{formatMoney(U.budget)}</b>
          </span>
          <span>
            Заявка {LG()}: <b className={khlRosterCount >= 30 ? 'text-accent' : 'text-text'}>{khlRosterCount} / 30</b>
            {farmRosterCount > 0 ? <span className="text-ice"> (+{farmRosterCount} в {FL()})</span> : null}
          </span>
        </div>
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm tabular" data-market>
            <thead className="text-[11px] uppercase tracking-wider text-muted">
              <tr>
                <th className="text-left pl-4 py-2 font-semibold">Игрок</th>
                <th className="text-left py-2 font-semibold">Поз</th>
                <th className="text-left py-2 font-semibold">Возр</th>
                <th className="text-left py-2 font-semibold">ОВР</th>
                <th className="text-left py-2 font-semibold">Пот</th>
                <th className="text-left py-2 font-semibold">Интерес</th>
                <th className="text-right py-2 font-semibold">Запрос за сезон</th>
                <th className="text-right py-2 font-semibold pr-4">Контракт</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-muted">
                    Свободных агентов по этому фильтру нет
                  </td>
                </tr>
              )}
              {list.map((p) => {
                const ask = askingSalary(s, p, 1, U.id);
                const left = talksLeft(s, p);
                const interest = playerInterest(s, p, U.id);
                const noRoom = fol + ask * 0.87 > cap;
                const leg = isLegionnaire(p);
                const legFull = leg && fl !== null && curLegs >= fl;
                return (
                  <tr key={p.id} className="border-t border-line/60 hover:bg-panel2 transition-colors">
                    <td className="pl-4 py-2 font-medium whitespace-nowrap">
                      <button className="hover:text-ice text-left inline-flex items-center gap-2" onClick={() => ui.openPlayer(p.id)}>
                        <PlayerFace face={p.face} name={p.name} number={p.number} size={26} />
                        {p.name}
                      </button>
                      <span className="ml-1.5 text-[10px] text-muted">{countryCode(p.country)}</span>
                      {p.rightsTeamId && isRfaEligibleAge(p.age) ? (
                        <span
                          className="ml-1.5"
                          title={
                            p.rightsTeamId === U.id
                              ? 'Спортивные права ОСА принадлежат вашему клубу'
                              : `Оффершит ОСА: компенсация ${formatMoney(offerSheetCompensation(ask, p.overall))} клубу ${s.teams[p.rightsTeamId]?.short ?? ''}`
                          }
                        >
                          <Tag tone={p.rightsTeamId === U.id ? 'good' : 'accent'}>
                            ОСА ({s.teams[p.rightsTeamId]?.short ?? LG()})
                          </Tag>
                        </span>
                      ) : (
                        <span className="ml-1.5 text-[10px] text-muted">НСА</span>
                      )}
                      {leg && <Tag tone={legFull ? 'bad' : 'warn'} className="ml-1.5">ЛЕГ</Tag>}
                    </td>
                    <td className="py-2">
                      <PosBadge pos={p.position} />
                    </td>
                    <td className="py-2 text-muted">{p.age}</td>
                    <td className="py-2">
                      <ScoutOvr p={p} />
                    </td>
                    <td className="py-2 text-muted">{p.age <= 25 ? <ScoutOvr p={p} potential /> : '—'}</td>
                    <td className="py-2"><InterestBadge score={interest.score} /></td>
                    <td className={cn('py-2 text-right whitespace-nowrap', noRoom && 'text-muted')} title={noRoom ? 'Не помещается под потолок зарплат' : undefined}>
                      {formatMoney(ask)}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      <Button size="sm" variant={left > 0 ? 'secondary' : 'ghost'} disabled={left <= 0 || khlRosterCount >= 30} onClick={() => ui.negotiate(p.id)} title={left <= 0 ? 'Игрок прервал переговоры с вашим клубом' : khlRosterCount >= 30 ? `В основе ${LG()} 30/30 игроков — отправьте игрока в ${FL()} или освободите место` : undefined}>
                        {left <= 0 ? 'Отказ' : 'Переговоры'}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Mobile Free-Agent Cards */}
        <div className="md:hidden divide-y divide-line/60">
          {list.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted">Свободных агентов по этому фильтру нет</div>
          ) : (
            list.map((p) => {
              const ask = askingSalary(s, p, 1, U.id);
              const left = talksLeft(s, p);
              const interest = playerInterest(s, p, U.id);
              const noRoom = fol + ask * 0.87 > cap;
              const leg = isLegionnaire(p);
              const legFull = leg && fl !== null && curLegs >= fl;
              return (
                <div key={p.id} className="p-3 flex items-center justify-between gap-2.5">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <PlayerFace face={p.face} name={p.name} number={p.number} size={28} />
                      <PosBadge pos={p.position} />
                      <button type="button" className="font-semibold text-sm truncate hover:text-ice text-left" onClick={() => ui.openPlayer(p.id)}>
                        {p.name}
                      </button>
                      <ScoutOvr p={p} />
                      {p.age <= 25 && p.potential > p.overall && (
                        <span className="text-[10px] font-display text-ice tabular shrink-0">→<ScoutOvr p={p} potential /></span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-muted tabular">
                      <span>{p.age} л. · {countryCode(p.country)}</span>
                      {p.rightsTeamId && isRfaEligibleAge(p.age) ? (
                        <Tag tone={p.rightsTeamId === U.id ? 'good' : 'accent'}>ОСА ({s.teams[p.rightsTeamId]?.short ?? LG()})</Tag>
                      ) : (
                        <Tag>НСА</Tag>
                      )}
                      {leg && <Tag tone={legFull ? 'bad' : 'warn'}>ЛЕГ</Tag>}
                      <span className={cn('font-semibold', noRoom ? 'text-muted' : 'text-text')}>{formatMoney(ask)}/г.</span>
                      <InterestBadge score={interest.score} />
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={left > 0 ? 'primary' : 'ghost'}
                    disabled={left <= 0 || khlRosterCount >= 30}
                    onClick={() => ui.negotiate(p.id)}
                    className="shrink-0"
                  >
                    {left <= 0 ? 'Отказ' : 'Переговоры'}
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </Panel>
      <Panel title="Правила подписания">
        <ul className="text-xs text-text/80 space-y-1.5">
          <li>• Запрос показан для контракта на один сезон и зависит от интереса игрока к клубу: сила состава, будущая роль, тренер, личные обстоятельства.</li>
          <li>• В переговорах можно предложить любой оклад, подъёмные и бонусы за достижения, а также заинтересовать игрока (обещание роли, звонок тренера, помощь с переездом). Если интерес слишком низкий, игрок откажется от переговоров.</li>
          <li>• Подписание невозможно, если ФОТ превысит потолок зарплат или в бюджете меньше годового оклада игрока.</li>
          <li>• В межсезонье клубы лиги тоже подписывают свободных агентов, чтобы закрыть позиции.</li>
          <li>• Все условия своих игроков — в разделе «Контракты».</li>
        </ul>
      </Panel>
    </div>
  );
}

function InterestBadge({ score }: { score: number }) {
  const color = score < REFUSE_BELOW ? '#E5323E' : score < 45 ? '#F2B544' : score < 70 ? '#8FD8F0' : '#3FCF8E';
  const text = score < REFUSE_BELOW ? 'отказ' : score < 45 ? 'слабый' : score < 70 ? 'средний' : 'высокий';
  return <span title={`Интерес к вашему клубу: ${score} / 100`} data-fa-interest={score}><Tag color={color}>{text}</Tag></span>;
}
