import { useState } from 'react';
import type { Player } from '../types';
import { askingSalary, buyoutCost, commitments, TALKS, talksLeft } from '../game/contracts';
import { buyoutDeadCap, CAP_GAMES_PER_POINT_DEDUCTION, dailyCapFine, getCapSummary } from '../game/cap';
import { countRosterLegionnaires, isLegionnaire, teamForeignLimit } from '../game/legionnaires';
import { hasTwoWayContract, isRfaEligibleAge, playerStatusTag, qualifyingOfferSalary, vhlPlayerCapRelief } from '../game/khlRules';
import { formatMoney } from '../game/ratings';
import { bonusText } from '../game/bonuses';
import { letGo, releasePlayer, respondRfaOfferSheet, tenderQualifyingOffer, useGame } from '../game/state';
import { Button, OverallChip, Panel, PosBadge, Stat, Tag, useUI } from './ui';
import { cn } from '../utils/cn';
import { LG } from '../brand';

const seasonLabel = (s: string, plus: number) => {
  const m = /^(\d{4})\/(\d{2})$/.exec(s);
  if (!m) return plus === 0 ? s : `+${plus}`;
  const y = parseInt(m[1], 10) + plus;
  return `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
};
const yearsWord = (n: number) => (n === 1 ? 'год' : n < 5 ? 'года' : 'лет');

export { NegotiationModal } from './Negotiation';

export function Contracts() {
  const s = useGame()!;
  const ui = useUI();
  const P = s.players;
  const U = s.teams[s.userTeamId];
  const [msg, setMsg] = useState<string | null>(null);
  const [onlyExpiring, setOnlyExpiring] = useState(false);
  const rows = U.players.map((id) => P[id]).sort((a, b) => b.contract.salary - a.contract.salary);
  const plan = commitments(U.players, P, 4);
  const cap = s.league.salaryCap;
  const off = s.phase === 'offseason';
  const capInfo = getCapSummary(s, U.id);
  const suspendedSet = new Set(capInfo.suspendedIds);
  const fl = teamForeignLimit(U, s.league.foreignLimit);
  const legCount = countRosterLegionnaires(U.players, P);
  const now = capInfo.totalPayroll;
  const ending = rows.filter((p) => p.contract.years <= 1 && !p.contract.next);
  const terminate = (p: Player) => {
    const cost = buyoutCost(s, p);
    const dead = !off ? buyoutDeadCap(p.contract.salary) : 0;
    ui.confirm({
      title: 'Расторгнуть контракт?',
      text: `${p.name} станет свободным агентом. ${cost > 0 ? `Клуб выплатит компенсацию ${formatMoney(cost)} из бюджета.` : 'Компенсация не потребуется.'} ${dead > 0 ? `Внимание: ${formatMoney(dead)} (20% оклада) останется «мёртвыми деньгами» под потолком зарплат до конца сезона!` : `ФОТ уменьшится на ${formatMoney(p.contract.salary)}.`}`,
      danger: true,
      confirmLabel: cost > 0 ? `Расторгнуть за ${formatMoney(cost)}` : 'Расторгнуть',
      onYes: () => setMsg(releasePlayer(p.id)),
    });
  };
  return (
    <div className="space-y-4 fade-in">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <Stat
          label="ФОТ (с выкупами)"
          value={formatMoney(now)}
          sub={
            [
              capInfo.ltirRelief > 0 ? `ДСБТ: −${formatMoney(capInfo.ltirRelief)}` : null,
              capInfo.vhlRelief > 0 ? `ВХЛ: −${formatMoney(capInfo.vhlRelief)}` : null,
              capInfo.deadCap > 0 ? `выкупы: +${formatMoney(capInfo.deadCap)}` : null,
              `потолок ${formatMoney(cap)}`,
            ]
              .filter(Boolean)
              .join(' · ')
          }
          color={now > cap ? '#E5323E' : '#E8EEF5'}
        />
        <Stat label="Свободно под потолком" value={formatMoney(cap - now)} sub={cap - now < 0 ? 'превышение лимита!' : 'резерв на сезон'} color={cap - now < 0 ? '#E5323E' : '#3FCF8E'} />
        <Stat
          label="Лимит легионеров"
          value={fl !== null ? `${legCount} / ${fl}` : `${legCount} (без лим.)`}
          sub={fl !== null ? `клуб России · норма ${LG()}` : `иностранный клуб ${LG()}`}
          color={fl !== null && legCount > fl ? '#E5323E' : '#8FD8F0'}
        />
        <Stat label="Бюджет клуба" value={formatMoney(U.budget)} sub={capInfo.finesTotal > 0 ? `штрафы потолка: −${formatMoney(capInfo.finesTotal)}` : 'зарплаты в конце сезона'} />
        <Stat label="Истекают в сезоне" value={ending.length} sub={off ? 'решите до старта сезона' : 'можно продлить заранее'} color={ending.length ? '#F2B544' : '#E8EEF5'} />
      </div>

      {/* Salary Cap Enforcement & Harsh Consequences Banner */}
      {capInfo.over && (
        <div
          data-cap-sanctions
          className={cn(
            'rounded-md border p-3.5 text-xs space-y-1.5',
            capInfo.sanctionsActive ? 'border-accent bg-accent/12 text-text' : 'border-gold/60 bg-gold/10 text-text'
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={cn('font-display text-sm uppercase tracking-wider font-bold', capInfo.sanctionsActive ? 'text-accent' : 'text-gold')}>
              {capInfo.sanctionsActive
                ? `⛔ Жёсткие санкции ${LG()} за превышение потолка зарплат активны!`
                : `⚠ Превышение потолка зарплат на ${formatMoney(capInfo.excess)} — льготный срок: ещё ${capInfo.graceDaysLeft} дн.`}
            </span>
            {capInfo.pointsDeducted > 0 && <Tag tone="bad">Снято очков: −{capInfo.pointsDeducted}</Tag>}
          </div>
          {capInfo.sanctionsActive ? (
            <div className="text-text/90 space-y-1">
              <div>
                • <b>Заблокированы контракты и отстранены от матчей:</b>{' '}
                {capInfo.suspendedIds.map((id) => P[id]?.name).filter(Boolean).join(', ') || '—'}
              </div>
              <div>
                • <b>Ежедневный штраф лиги (300%):</b> {formatMoney(capInfo.dailyFine)} / день · Выплачено штрафов: {formatMoney(capInfo.finesTotal)}
              </div>
              <div>
                • <b>Турнирные санкции:</b> сыграно {capInfo.violationGames} штрафных матчей (−2 очка за каждые {CAP_GAMES_PER_POINT_DEDUCTION} игр) · Регистрация новичков закрыта.
              </div>
            </div>
          ) : (
            <div className="text-text/85">
              Разгрузите платёжную ведомость через обмен (клубу с превышением разрешены сделки со сбросом зарплаты от 5 млн ₽) или расторжение контракта. Иначе через {capInfo.graceDaysLeft} дн. лига отстранит самых высокооплачиваемых игроков, введёт штраф {formatMoney(dailyCapFine(capInfo.excess))}/день и начнёт снимать очки!
            </div>
          )}
        </div>
      )}

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

      <Panel
        title={`Контракты · ${U.name}`}
        right={
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setOnlyExpiring(false)}
              className={cn('text-xs px-2.5 py-1 rounded-sm font-semibold', !onlyExpiring ? 'bg-accent text-white' : 'bg-panel2 text-muted hover:text-text')}
            >
              Все ({rows.length})
            </button>
            <button
              type="button"
              onClick={() => setOnlyExpiring(true)}
              className={cn('text-xs px-2.5 py-1 rounded-sm font-semibold', onlyExpiring ? 'bg-amber text-bg' : 'bg-panel2 text-muted hover:text-text')}
            >
              Истекают ({ending.length})
            </button>
          </div>
        }
        noPad
      >
        {(s.rfaOffers ?? []).length > 0 && (
          <div className="p-3 border-b border-gold/40 bg-gold/10 space-y-2" data-rfa-offersheets>
            <div className="text-xs font-display uppercase tracking-wider text-gold font-bold">
              ⚡ Входящие оффершиты {LG()} по вашим ограниченно свободным агентам (ОСА)
            </div>
            {(s.rfaOffers ?? []).map((os) => {
              const op = P[os.playerId];
              const fromT = s.teams[os.fromTeamId];
              if (!op) return null;
              return (
                <div key={os.id} className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-line bg-panel px-3 py-2 text-xs">
                  <div>
                    <b>{fromT?.name}</b> предложил вашему ОСА <b>{op.name}</b> ({op.age} л., OVR {op.overall}) контракт{' '}
                    <b className="text-gold">{formatMoney(os.salary)} × {os.years} г.</b> Компенсация при отказе:{' '}
                    <b className="text-ok">+{formatMoney(os.compensation)}</b>.
                  </div>
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        const err = respondRfaOfferSheet(os.id, true);
                        setMsg(err ?? `Оффершит повторён — ${op.name} остаётся в клубе!`);
                      }}
                    >
                      Повторить контракт
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        const err = respondRfaOfferSheet(os.id, false);
                        setMsg(err ?? `Получена денежная компенсация ${formatMoney(os.compensation)} за права ОСА ${op.name}.`);
                      }}
                    >
                      Взять {formatMoney(os.compensation)}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="hidden md:block overflow-x-auto">
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
              {(onlyExpiring ? ending : rows).map((p) => {
                const c = p.contract;
                const canTalk = c.years <= 1 && !c.next;
                const left = talksLeft(s, p);
                return (
                  <tr key={p.id} className="border-t border-line/60 hover:bg-panel2/60 transition-colors">
                    <td className="pl-4 px-2 py-1.5 font-medium whitespace-nowrap">
                      <button className="hover:text-ice text-left" onClick={() => ui.openPlayer(p.id)}>
                        {p.name}
                      </button>
                      <span className="ml-1.5 text-[10px] text-muted">{playerStatusTag(p)}</span>
                      {hasTwoWayContract(p) && (
                        <span title={`Двусторонний контракт ${LG()}/ВХЛ: переводы в ВХЛ без отказов и 100% снятие с потолка ${LG()} в ВХЛ`}>
                          <Tag tone="good" className="ml-1.5">2-СТОР</Tag>
                        </span>
                      )}
                      {p.nmc && <Tag tone="warn" className="ml-1.5">ЗНО</Tag>}
                      {!!(c.bonuses?.length || c.next?.bonuses?.length) && (
                        <span title={[...(c.bonuses ?? []), ...(c.next?.bonuses ?? [])].map((b) => `${bonusText(b)}: ${formatMoney(b.amount)}`).join('\n')} data-contract-bonuses>
                          <Tag color="#8FD8F0" className="ml-1.5">бонусы</Tag>
                        </span>
                      )}
                      {p.promise && <span title="Игроку обещана ведущая роль: проверка в конце регулярного чемпионата"><Tag color="#F2B544" className="ml-1.5">обещание</Tag></span>}
                      {p.inVhl && (
                        <span title={`В потолке ${LG()} учитывается ${formatMoney(c.salary - vhlPlayerCapRelief(p))}`}>
                          <Tag tone="accent" className="ml-1.5">ВХЛ</Tag>
                        </span>
                      )}
                      {isLegionnaire(p) && <Tag tone="warn" className="ml-1.5">ЛЕГ</Tag>}
                      {suspendedSet.has(p.id) && <Tag tone="bad" className="ml-1.5">блок потолка</Tag>}
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
                        {c.years === 0 && isRfaEligibleAge(p.age) && (
                          <Button
                            size="sm"
                            variant="secondary"
                            title={`Квалификационное предложение ОСА на 1 год (${formatMoney(qualifyingOfferSalary(p))}) или закрепление прав`}
                            onClick={() => {
                              const err = tenderQualifyingOffer(p.id);
                              setMsg(err ?? `Квалификационное предложение сделано — права ОСА на ${p.name} закреплены за клубом!`);
                            }}
                          >
                            КП (ОСА)
                          </Button>
                        )}
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

        {/* Mobile Contract Cards (Zero Horizontal Scroll) */}
        <div className="md:hidden divide-y divide-line/60">
          {(onlyExpiring ? ending : rows).map((p) => {
            const c = p.contract;
            const canTalk = c.years <= 1 && !c.next;
            const left = talksLeft(s, p);
            return (
              <div key={p.id} className="p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <PosBadge pos={p.position} />
                    <button type="button" className="font-semibold text-sm truncate hover:text-ice text-left" onClick={() => ui.openPlayer(p.id)}>
                      {p.name}
                    </button>
                    <span className="text-[11px] text-muted shrink-0">{p.age} л.</span>
                  </div>
                  <OverallChip value={p.overall} size="sm" />
                </div>

                <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
                  <Tag>{playerStatusTag(p)}</Tag>
                  {hasTwoWayContract(p) && <Tag tone="good">2-СТОР</Tag>}
                  {p.nmc && <Tag tone="warn">ЗНО</Tag>}
                  {p.inVhl && <Tag tone="accent">ВХЛ</Tag>}
                  {isLegionnaire(p) && <Tag tone="warn">ЛЕГ</Tag>}
                  {suspendedSet.has(p.id) && <Tag tone="bad">Блок потолка</Tag>}
                </div>

                <div className="flex items-center justify-between gap-2 text-xs tabular">
                  <div>
                    <span className="font-semibold text-text">{formatMoney(c.salary)}</span>
                    <span className="text-muted"> · </span>
                    {c.years === 0 ? (
                      <span className="text-accent font-semibold">истёк</span>
                    ) : c.years === 1 ? (
                      <span className={c.next ? 'text-text' : 'text-amber'}>последний год</span>
                    ) : (
                      <span className="text-muted">ещё {c.years} {yearsWord(c.years)}</span>
                    )}
                    {c.next && <span className="text-ok"> → {formatMoney(c.next.salary)} × {c.next.years} г.</span>}
                  </div>
                  {canTalk && (
                    <span className="text-[11px] text-ice shrink-0">запрос {formatMoney(askingSalary(s, p, 1, U.id))}</span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 flex-wrap pt-1">
                  {c.years === 0 && isRfaEligibleAge(p.age) && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="flex-1"
                      onClick={() => {
                        const err = tenderQualifyingOffer(p.id);
                        setMsg(err ?? `Квалификационное предложение сделано — права ОСА на ${p.name} закреплены за клубом!`);
                      }}
                    >
                      КП (ОСА)
                    </Button>
                  )}
                  {canTalk && (
                    <Button
                      size="sm"
                      variant={c.years === 0 ? 'primary' : 'secondary'}
                      className="flex-1"
                      disabled={left <= 0}
                      onClick={() => ui.negotiate(p.id)}
                    >
                      {left <= 0 ? 'Отказ' : c.years === 0 ? 'Переговоры' : 'Продлить'}
                    </Button>
                  )}
                  {c.years === 0 ? (
                    <Button size="sm" variant="ghost" className="border border-line" onClick={() => letGo(p.id)}>
                      Отпустить
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" className="border border-line" onClick={() => terminate(p)}>
                      Расторгнуть
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel title="Как устроены контракты">
        <ul className="text-xs text-text/80 space-y-1.5">
          <li>• У контракта есть оклад за сезон и срок. Зарплаты выплачиваются в конце сезона из доходов клуба; ФОТ не может превышать потолок.</li>
          <li>• В последний год контракт можно продлить заранее: новые условия начнут действовать со следующего сезона. Непродлённые контракты истекают в межсезонье.</li>
          <li>• Переговоры: игрок называет запрос, но готов уступить 3–13% — где именно его предел, неизвестно. На попытки сбить цену у вас {TALKS} попытки; слишком низкое предложение сжигает сразу две.</li>
          <li>• Запрос зависит от рейтинга, возраста и потенциала, срока (молодые берут дороже за длинный контракт, ветераны дешевле), морали и положения команды в таблице.</li>
          <li>• Максимальный срок: до 30 лет — 5 лет, 30–31 — 3 года, 32–34 — 2 года, с 35 — 1 год.</li>
          <li>• Расторжение контракта в сезоне требует выплаты 1/3 оставшейся суммы из бюджета и оставляет 20% годового оклада «мёртвыми деньгами» под потолком зарплат до конца сезона.</li>
          <li>• Превышение жёсткого потолка зарплат свыше 7 льготных дней приводит к блокировке контрактов самых дорогих игроков, ежедневному штрафу (300% превышения), падению морали и снятию 2 очков за каждые 5 штрафных матчей.</li>
        </ul>
      </Panel>
    </div>
  );
}
