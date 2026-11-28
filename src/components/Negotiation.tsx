import { useEffect, useState } from 'react';
import type { BonusKind, CoachPitch, CoachRole, ContractBonus, GameState, Player } from '../types';
import { askingSalary, commitments, maxYears, offerWorth, TALKS, talksLeft } from '../game/contracts';
import { getCapSummary } from '../game/cap';
import { countRosterLegionnaires, countryCode, isLegionnaire, teamForeignLimit } from '../game/legionnaires';
import { canHaveNmc, canSignTwoWay, hasTwoWayContract, isRfaEligibleAge, offerSheetCompensation } from '../game/khlRules';
import { BONUS_DEFS, bonusChance, bonusKindsFor, bonusTargets, bonusText } from '../game/bonuses';
import { COACH_MAX_YEARS, COACH_PITCHES, coachAsk, coachInterest, coachPitchAvailable, coachTalks, extrasValue, INTEREST_LABEL, MAX_BONUS_SHARE, MAX_SIGNING_SHARE, pitchAvailable, PLAYER_PITCHES, playerInterest, playerTalks, PRIORITY_LABEL, type Interest } from '../game/negotiation';
import { outgoingSeverance } from '../game/coaching';
import { formatMoney } from '../game/ratings';
import { offerCoachContract, offerContract, pitchToCoach, pitchToPlayer, useGame } from '../game/state';
import type { CoachAnswer, ContractAnswer } from '../game/state';
import type { PlayerPitch } from '../types';
import { Button, Modal, OverallChip, PosBadge, Stat, Tag } from './ui';
import { cn } from '../utils/cn';
import { FL, LG } from '../brand';

const yearsWord = (n: number) => (n === 1 ? 'год' : n < 5 ? 'года' : 'лет');
const seasonLabel = (s: string, plus: number) => {
  const m = /^(\d{4})\/(\d{2})$/.exec(s);
  if (!m) return plus === 0 ? s : `+${plus}`;
  const y = parseInt(m[1], 10) + plus;
  return `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
};
const toMln = (v: number) => (Math.round(v / 100_000) / 10).toString().replace('.', ',');
const roundTo = (v: number, step = 100_000) => Math.max(0, Math.round(v / step) * step);

/** Money input in millions of roubles: any amount, comma or dot, 0.1 M steps. */
export function MoneyField({ label, value, onChange, hint, testId, min = 0, compact = false }: { label: string; value: number; onChange: (rub: number) => void; hint?: string; testId?: string; min?: number; compact?: boolean }) {
  const [text, setText] = useState(toMln(value));
  useEffect(() => { setText((cur) => (Math.round(parseFloat(cur.replace(',', '.')) * 1e6) === roundTo(value) ? cur : toMln(value))); }, [value]);
  return (
    <label className="block min-w-0">
      <span className={compact ? 'sr-only' : 'text-[11px] uppercase tracking-wider text-muted'}>{label}</span>
      <span className={cn(compact ? '' : 'mt-1', 'flex items-center rounded-sm border border-line bg-bg/60 focus-within:border-ice')}>
        <input
          type="text"
          inputMode="decimal"
          value={text}
          data-testid={testId}
          aria-label={label}
          onChange={(e) => {
            const t = e.target.value.replace(/[^\d.,]/g, '');
            setText(t);
            const v = parseFloat(t.replace(',', '.'));
            onChange(Number.isFinite(v) ? Math.max(min, roundTo(v * 1e6)) : min);
          }}
          className="w-full min-w-0 bg-transparent px-2.5 py-1.5 text-sm tabular text-text outline-none"
        />
        <span className="pr-2.5 text-xs text-muted whitespace-nowrap">млн ₽</span>
      </span>
      {hint && <span className="block mt-1 text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export function InterestCard({ interest, who }: { interest: Interest; who: 'player' | 'coach' }) {
  const color = interest.level === 'high' ? '#3FCF8E' : interest.level === 'mid' ? '#8FD8F0' : interest.level === 'low' ? '#F2B544' : '#E5323E';
  return (
    <div className="rounded-sm border border-line bg-panel2/50 p-3" data-interest={interest.score}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-semibold" style={{ color }}>{INTEREST_LABEL[interest.level]}</span>
        <span className="tabular text-muted">{interest.score} / 100</span>
      </div>
      <div className="relative h-2 mt-1.5 rounded-full bg-line overflow-hidden">
        <div className="absolute inset-y-0 left-0 rounded-full transition-all" style={{ width: `${interest.score}%`, background: color }} />
        <div className="absolute inset-y-0 w-px bg-accent" style={{ left: '25%' }} title="Ниже — отказ от переговоров" />
      </div>
      {who === 'player' && <div className="mt-2 text-[11px] text-muted">Главное для игрока: <b className="text-text">{PRIORITY_LABEL[interest.priority]}</b></div>}
      <ul className="mt-1.5 grid sm:grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
        {interest.factors.map((f) => (
          <li key={f.label} className="flex justify-between gap-2"><span className="text-muted truncate" title={f.label}>{f.label}</span><span className={cn('tabular shrink-0', f.value > 0 ? 'text-ok' : 'text-accent')}>{f.value > 0 ? `+${f.value}` : f.value}</span></li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-muted">Интерес снижает или повышает запрос (до ±20%). {who === 'player' ? 'Игрок' : 'Тренер'} с интересом ниже 25 отказывается от переговоров.</p>
    </div>
  );
}

export function PitchList<T extends string>({ items, notes, onPitch, disabled }: { items: { id: T; label: string; hint: string; cost?: number; why: string | null }[]; notes?: string[]; onPitch: (id: T) => void; disabled?: boolean }) {
  return (
    <div data-pitches>
      <div className="text-[11px] uppercase tracking-wider text-muted mb-1.5">Заинтересовать</div>
      <div className="grid sm:grid-cols-2 gap-1.5">
        {items.map((it) => (
          <button key={it.id} type="button" disabled={disabled || !!it.why} onClick={() => onPitch(it.id)} title={it.why ?? it.hint} data-pitch={it.id}
            className="text-left rounded-sm border border-line bg-panel2/60 px-2.5 py-1.5 hover:border-ice disabled:opacity-45 disabled:hover:border-line">
            <div className="text-xs font-semibold">{it.label}{it.cost ? <span className="text-gold font-normal"> · {formatMoney(it.cost)}</span> : null}</div>
            <div className="text-[10px] text-muted leading-snug">{it.why ?? it.hint}</div>
          </button>
        ))}
      </div>
      {!!notes?.length && <ul className="mt-1.5 space-y-0.5 text-[11px] text-ice">{notes.map((n, i) => <li key={i}>• {n}</li>)}</ul>}
    </div>
  );
}

/** Achievement bonuses: pick the kind, the target and any amount; the realistic chance is shown next to it. */
export function BonusEditor({ state, kinds, bonuses, onChange, salary, chance }: { state: GameState; kinds: BonusKind[]; bonuses: ContractBonus[]; onChange: (b: ContractBonus[]) => void; salary: number; chance: (b: ContractBonus) => number }) {
  const total = bonuses.reduce((s, b) => s + b.amount, 0);
  const limit = salary * MAX_BONUS_SHARE;
  const set = (kind: BonusKind, patch: Partial<ContractBonus> | null) => {
    const rest = bonuses.filter((b) => b.kind !== kind);
    if (!patch) return onChange(rest);
    const cur = bonuses.find((b) => b.kind === kind) ?? { kind, target: bonusTargets(state, kind)[Math.floor(bonusTargets(state, kind).length / 2)] ?? 0, amount: Math.max(500_000, roundTo(salary * 0.1, 500_000)) };
    onChange([...rest, { ...cur, ...patch }].sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind)));
  };
  return (
    <fieldset data-bonuses>
      <legend className="text-[11px] uppercase tracking-wider text-muted mb-1.5">Бонусы за достижения</legend>
      <div className="space-y-1">
        {kinds.map((kind) => {
          const b = bonuses.find((x) => x.kind === kind);
          const targets = bonusTargets(state, kind);
          return (
            <div key={kind} className={cn('rounded-sm border px-2 py-1.5 text-xs', b ? 'border-ice/60 bg-ice/5' : 'border-line bg-panel2/40')} data-bonus={kind}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-[150px]">
                  <input type="checkbox" checked={!!b} onChange={(e) => set(kind, e.target.checked ? {} : null)} className="accent-sky-300" />
                  <span>{BONUS_DEFS[kind].label}</span>
                </label>
                {b && targets.length > 1 && (
                  <select aria-label={`Цель: ${BONUS_DEFS[kind].label}`} value={b.target} onChange={(e) => set(kind, { target: Number(e.target.value) })} className="bg-bg/70 border border-line rounded-sm px-1.5 py-1 text-xs">
                    {targets.map((t) => <option key={t} value={t}>{bonusText({ kind, target: t })}</option>)}
                  </select>
                )}
                {b && <span className="w-28"><MoneyField compact label={`Сумма: ${BONUS_DEFS[kind].label}`} value={b.amount} onChange={(v) => set(kind, { amount: v })} /></span>}
                {b && <span className="text-[11px] text-muted tabular w-full sm:w-auto">шанс ≈ {Math.round(chance(b) * 100)}%</span>}
              </div>
            </div>
          );
        })}
      </div>
      <div className={cn('mt-1 text-[11px]', total > limit + 1 ? 'text-accent' : 'text-muted')}>
        Сумма бонусов {formatMoney(total)} из {formatMoney(limit)} (не больше 50% оклада). Выплачиваются из бюджета, вне потолка зарплат: индивидуальные и выход в плей-офф — после регулярки, остальные — после финала.
      </div>
    </fieldset>
  );
}

/** Negotiation with a free agent or with an own player whose contract is ending. */
export function NegotiationModal({ id, onClose }: { id: string; onClose: () => void }) {
  const s = useGame()!;
  const p: Player | undefined = s.players[id];
  const U = s.teams[s.userTeamId];
  const maxY = p ? maxYears(p.age) : 1;
  const [years, setYears] = useState(Math.min(2, maxY));
  const [salaryInput, setSalaryInput] = useState<number | null>(null);
  const [signing, setSigning] = useState(0);
  const [bonuses, setBonuses] = useState<ContractBonus[]>([]);
  const [nmc, setNmc] = useState<boolean>(!!p?.nmc);
  const [twoWay, setTwoWay] = useState<boolean>(() => (p ? hasTwoWayContract(p) && canSignTwoWay(p) : false));
  const [answer, setAnswer] = useState<ContractAnswer | null>(null);
  const [pitchMsg, setPitchMsg] = useState<string | null>(null);
  if (!p || (p.teamId && p.teamId !== U.id)) return null;
  const free = !p.teamId;
  const extension = !free && p.contract.years === 1;
  const allowNmc = canHaveNmc(p);
  const allowTwoWay = canSignTwoWay(p);
  const effectiveNmc = allowNmc && nmc && !twoWay;
  const effectiveTwoWay = allowTwoWay && twoWay && !effectiveNmc;
  const ask = askingSalary(s, p, years, U.id, effectiveNmc, effectiveTwoWay);
  const salary = salaryInput ?? ask;
  const interest = playerInterest(s, p, U.id);
  const talks = playerTalks(s, p);
  const isForeignRfa = free && !!p.rightsTeamId && p.rightsTeamId !== U.id && isRfaEligibleAge(p.age);
  const rfaCompCash = isForeignRfa ? offerSheetCompensation(salary, p.overall) : 0;
  const left = talksLeft(s, p);
  const signed = !!answer?.ok;
  const cap = s.league.salaryCap;
  const capInfo = getCapSummary(s, U.id);
  const fl = teamForeignLimit(U, s.league.foreignLimit);
  const curLegs = countRosterLegionnaires(U.players, s.players);
  const legBlocked = free && isLegionnaire(p) && fl !== null && curLegs >= fl;
  const committed = extension ? commitments(U.players, s.players, 2)[1] : capInfo.totalPayroll;
  const after = committed + salary;
  const extras = { signingBonus: signing, bonuses };
  const worth = offerWorth(s, p, salary, years, U.id, extras);
  const worthPct = Math.round((worth.total / Math.max(1, ask)) * 100);
  const change = () => { setAnswer(null); setPitchMsg(null); };
  const offer = (value: number, plain = false) => setAnswer(offerContract(p.id, value, years, effectiveNmc, effectiveTwoWay, plain ? undefined : extras));
  const pitch = (k: PlayerPitch) => { setAnswer(null); setPitchMsg(pitchToPlayer(p.id, k).text); };
  const tone = !answer ? '' : answer.ok ? 'border-ok/50 text-ok bg-ok/10' : 'border-accent/50 text-accent bg-accent/10';
  const blocked = left <= 0 || interest.refuses;
  return (
    <Modal open onClose={onClose} width="max-w-2xl" title={<span className="font-display uppercase tracking-wide">{free ? 'Переговоры со свободным агентом' : extension ? 'Продление контракта' : 'Новый контракт'}</span>}>
      <div className="flex items-center gap-3 flex-wrap">
        <PosBadge pos={p.position} />
        <div className="flex-1 min-w-[160px]">
          <div className="font-display text-xl uppercase leading-none flex items-center gap-2">
            <span>{p.name}</span>
            {isLegionnaire(p) && <Tag tone="warn">Легионер ({countryCode(p.country)})</Tag>}
          </div>
          <div className="text-xs text-muted mt-1">
            {p.age} лет{p.age <= 25 ? ` · потенциал ${p.potential}` : ''} · мораль {p.morale}
            {!free && ` · сейчас ${formatMoney(p.contract.salary)}${p.contract.years ? `, осталось ${p.contract.years} ${yearsWord(p.contract.years)}` : ', контракт истёк'}`}
          </div>
        </div>
        <OverallChip value={p.overall} size="lg" />
      </div>
      {legBlocked && (
        <div className="mt-3 rounded-sm border border-gold/50 bg-gold/10 px-3 py-2 text-xs text-gold">
          ⛔ В составе уже {curLegs} из {fl} легионеров — освободите легионерскую вакансию перед подписанием иностранца.
        </div>
      )}
      {isForeignRfa && rfaCompCash > 0 && (
        <div className="mt-3 rounded-sm border border-ice/50 bg-ice/10 px-3 py-2 text-xs text-ice">
          📋 <b>Оффершит ОСА (до 28 лет):</b> спортивные права принадлежат клубу <b>{s.teams[p.rightsTeamId!]?.name}</b>. Если тот не повторит ваше предложение, вы выплатите денежную компенсацию <b>{formatMoney(rfaCompCash)}</b>.
        </div>
      )}

      {signed ? (
        <div className={cn('mt-4 text-sm rounded-sm border px-3 py-3', tone)} data-neg-result>
          {answer!.text}
        </div>
      ) : (
        <>
          <div className="mt-4 grid gap-3">
            <InterestCard interest={interest} who="player" />
            <PitchList<PlayerPitch>
              items={(Object.keys(PLAYER_PITCHES) as PlayerPitch[]).map((k) => ({ id: k, ...PLAYER_PITCHES[k], why: pitchAvailable(s, p, k, U.id) }))}
              notes={talks.notes}
              onPitch={pitch}
              disabled={left <= 0}
            />
            {pitchMsg && <div className="text-xs text-ice" role="status">{pitchMsg}</div>}
          </div>
          {interest.refuses && <div className="mt-3 text-sm rounded-sm border border-accent/50 text-accent bg-accent/10 px-3 py-2" data-neg-refuse>{p.name} не рассматривает ваш клуб. Повысьте интерес, чтобы начать обсуждать условия.</div>}

          <div className="mt-4">
            <div className="text-[11px] uppercase tracking-wider text-muted mb-1.5">Срок контракта{extension ? ' (начнётся со следующего сезона)' : ''}</div>
            <div className="flex gap-1.5 flex-wrap">
              {[1, 2, 3, 4, 5].map((y) => (
                <button key={y} disabled={y > maxY} onClick={() => { setYears(y); change(); }} className={cn('text-sm px-3 py-1.5 rounded-sm font-semibold transition-colors disabled:opacity-35 disabled:cursor-not-allowed', years === y ? 'bg-ice text-bg' : 'bg-panel2 text-muted hover:text-text')} title={y > maxY ? `В ${p.age} лет игрок не подпишет контракт дольше ${maxY} ${yearsWord(maxY)}` : undefined}>
                  {y} {yearsWord(y)}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-4">
            <Stat label="Запрос игрока" value={formatMoney(ask)} sub={`за сезон, на ${years} ${yearsWord(years)}`} color="#F2B544" />
            <Stat label="Ваше предложение" value={<span data-neg-salary>{formatMoney(salary)}</span>} sub={`${Math.round((salary / Math.max(1, ask)) * 100)}% от запроса`} color={salary >= ask ? '#3FCF8E' : '#E8EEF5'} />
          </div>
          <div className="grid sm:grid-cols-2 gap-3 mt-3">
            <div>
              <MoneyField label="Оклад за сезон" testId="neg-salary-input" value={salary} min={500_000} onChange={(v) => { setSalaryInput(v); change(); }} />
              <div className="flex gap-1 mt-1.5">
                {([[-0.05, '−5%'], [-0.01, '−1%'], [0, 'Запрос'], [0.01, '+1%'], [0.05, '+5%']] as const).map(([d, lbl]) => (
                  <button key={lbl} type="button" onClick={() => { setSalaryInput(d === 0 ? null : Math.max(500_000, roundTo(salary * (1 + d)))); change(); }}
                    className={cn('flex-1 py-1 rounded-sm border text-[11px] font-semibold tabular', d === 0 && salaryInput === null ? 'border-ice bg-ice/15 text-ice' : 'border-line bg-panel2 text-muted hover:text-text')}>{lbl}</button>
                ))}
              </div>
            </div>
            <MoneyField label="Подъёмные (разово)" testId="neg-signing" value={signing} onChange={(v) => { setSigning(v); change(); }} hint={`Сразу из бюджета, вне потолка; до ${formatMoney(salary * MAX_SIGNING_SHARE)}. Игрок делит их на срок контракта.`} />
          </div>
          <div className="mt-4">
            <BonusEditor state={s} kinds={bonusKindsFor(p)} bonuses={bonuses} salary={salary} onChange={(b) => { setBonuses(b); change(); }} chance={(b) => bonusChance(s, b, U.id, p)} />
          </div>
          <div className="mt-3 rounded-sm border border-line bg-panel2/50 px-3 py-2 text-xs flex flex-wrap justify-between gap-2" data-neg-worth={worth.total}>
            <span className="text-muted">Как игрок оценивает предложение за сезон: оклад{worth.signing ? ` + подъёмные ${formatMoney(worth.signing)}` : ''}{worth.bonuses ? ` + бонусы ${formatMoney(worth.bonuses)} (с учётом шансов)` : ''}</span>
            <b className={cn('tabular', worthPct >= 100 ? 'text-ok' : worthPct >= 90 ? 'text-gold' : 'text-accent')}>{formatMoney(worth.total)} · {worthPct}% от запроса</b>
          </div>
          <fieldset className="mt-4" data-contract-type>
            <legend className="text-[11px] uppercase tracking-wider text-muted mb-2">Тип контракта</legend>
            <div className="grid grid-cols-2 gap-2">
              {[false, true].map(value => <label key={String(value)} className={cn('rounded border px-3 py-2 text-sm cursor-pointer', effectiveTwoWay === value ? 'border-ice bg-ice/10' : 'border-line bg-panel2', value && !allowTwoWay && 'opacity-50')}>
                <input type="radio" name="contract-type" value={value ? 'two-way' : 'one-way'} checked={effectiveTwoWay === value} disabled={value && !allowTwoWay} onChange={() => { setTwoWay(value); if (value) setNmc(false); change(); }} className="mr-2 accent-sky-300" />
                {value ? 'Двусторонний' : 'Односторонний'}
              </label>)}
            </div>
            <p className="mt-2 text-xs text-muted">{!allowTwoWay ? 'Игрок не согласен на двусторонний контракт: доступен молодым и игрокам ротации (до 76 OVR).' : effectiveTwoWay ? `${LG()} / ${FL()}: свободные переводы, в ${FL()} оклад не учитывается в потолке${p.age > 22 ? ' · +6% к запросу' : ''}.` : `${LG()}: перевод в ${FL()} по общим правилам.`}</p>
          </fieldset>
          {allowNmc && (
            <label className="mt-3 flex items-center justify-between gap-2 rounded-sm border border-line bg-panel2/60 px-3 py-2 text-xs cursor-pointer">
              <div>
                <div className="font-semibold text-gold">Пункт о запрете на обмен и {FL()} (ЗНО / NMC)</div>
                <div className="text-[11px] text-muted">Игрок снижает зарплатные ожидания на 7%, но его нельзя обменять или отправить на отказы.</div>
              </div>
              <input type="checkbox" checked={effectiveNmc} onChange={(e) => { setNmc(e.target.checked); if (e.target.checked) setTwoWay(false); change(); }} className="w-4 h-4 accent-[#F2B544]" />
            </label>
          )}
          <div className="mt-3 text-xs space-y-1">
            <div className="flex justify-between gap-2">
              <span className="text-muted">{extension ? `ФОТ сезона ${seasonLabel(s.league.season, 1)} с этим контрактом` : 'ФОТ с этим контрактом'}</span>
              <span className={cn('tabular', after > cap ? 'text-accent' : 'text-text')}>{formatMoney(after)} / {formatMoney(cap)}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted">Бюджет клуба (резерв: годовой оклад{signing ? ' + подъёмные' : ''})</span>
              <span className={cn('tabular', U.budget < salary + signing ? 'text-accent' : 'text-text')}>{formatMoney(U.budget)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted">Терпение игрока</span>
              <span className="flex gap-1" title={`Осталось попыток: ${left}`} data-neg-left={left}>
                {Array.from({ length: TALKS }, (_, i) => <span key={i} className={cn('w-2.5 h-2.5 rounded-full', i < left ? 'bg-ok' : 'bg-line')} />)}
              </span>
            </div>
          </div>
          {answer && (
            <div className={cn('mt-3 text-sm rounded-sm border px-3 py-2', tone)} data-neg-result>
              {answer.text}
              {answer.counter && left > 0 && (
                <div className="mt-2"><Button size="sm" variant="ice" onClick={() => { setSalaryInput(answer.counter!); offer(answer.counter!); }} data-neg-counter>Согласиться на встречное: {formatMoney(answer.counter)}</Button></div>
              )}
            </div>
          )}
          {left <= 0 && !answer && <div className="mt-3 text-sm rounded-sm border border-accent/50 text-accent bg-accent/10 px-3 py-2">Игрок прервал переговоры. Вернуться к ним можно {s.phase === 'offseason' ? 'в следующем сезоне' : 'в межсезонье'}.</div>}
        </>
      )}
      <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end mt-5 pt-4 border-t border-line">
        {signed ? (
          <Button variant="primary" className="w-full sm:w-auto" onClick={onClose}>Готово</Button>
        ) : (
          <>
            <Button variant="ghost" className="w-full sm:w-auto" onClick={onClose}>Закрыть</Button>
            <Button className="w-full sm:w-auto" disabled={blocked} onClick={() => offer(ask, true)} title="Оклад по запросу, без подъёмных и бонусов — игрок гарантированно согласится">Принять запрос игрока</Button>
            <Button variant="primary" className="w-full sm:w-auto" disabled={blocked} onClick={() => offer(salary)}>Сделать предложение</Button>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Talks with a free coach for the chosen post; on agreement he is appointed at once. */
export function CoachNegotiationModal({ coachId, role, onClose, onSigned }: { coachId: string; role: CoachRole; onClose: () => void; onSigned?: (text: string) => void }) {
  const s = useGame()!;
  const t = s.teams[s.userTeamId];
  const c = s.coachMarket?.find((x) => x.id === coachId);
  const [years, setYears] = useState(2);
  const [salaryInput, setSalaryInput] = useState<number | null>(null);
  const [signing, setSigning] = useState(0);
  const [bonuses, setBonuses] = useState<ContractBonus[]>([]);
  const [answer, setAnswer] = useState<CoachAnswer | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pitchMsg, setPitchMsg] = useState<string | null>(null);
  if (done) return (
    <Modal open onClose={onClose} width="max-w-xl" title={<span className="font-display uppercase tracking-wide">Тренер назначен</span>}>
      <div className="text-sm rounded-sm border border-ok/50 text-ok bg-ok/10 px-3 py-3" data-coach-neg-result>{done}</div>
      <div className="flex justify-end mt-4"><Button variant="primary" onClick={onClose}>Готово</Button></div>
    </Modal>
  );
  if (!c) return null;
  const ask = coachAsk(s, c, role, years);
  const salary = salaryInput ?? ask;
  const interest = coachInterest(s, c, t.id, role);
  const talks = coachTalks(s, c);
  const left = talks.left;
  const severance = outgoingSeverance(t, role);
  const terms = { salary, years, signingBonus: signing, bonuses };
  const extra = extrasValue(s, null, t.id, years, terms, 'winning');
  const worth = salary + extra.signing + extra.bonuses;
  const worthPct = Math.round((worth / Math.max(1, ask)) * 100);
  const guarantee = !!talks.pitched?.includes('authority');
  const change = () => { setAnswer(null); setPitchMsg(null); };
  const offer = (value: number, plain = false) => {
    const r = offerCoachContract(c.id, role, plain ? { salary: value, years, signingBonus: 0, bonuses: [] } : { ...terms, salary: value });
    if (r.ok) { setDone(r.text); onSigned?.(r.text); } else setAnswer(r);
  };
  const blocked = left <= 0 || interest.refuses;
  return (
    <Modal open onClose={onClose} width="max-w-2xl" title={<span className="font-display uppercase tracking-wide">Переговоры с тренером</span>}>
      <div data-coach-negotiation={c.id}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><div className="text-[11px] text-muted uppercase">Должность: {role === 'head' ? 'главный тренер' : 'ассистент'}{c.role !== role ? ` (сейчас ищет работу ${c.role === 'head' ? 'главным' : 'ассистентом'})` : ''}</div><div className="font-display text-xl">{c.name}</div></div>
          <div className="text-xs text-muted">Атака {c.attack} · Оборона {c.defense} · Спецбр. {c.special} · Развитие {c.development} · Мотивация {c.motivation}</div>
        </div>
        <div className="mt-3 grid gap-3">
          <InterestCard interest={interest} who="coach" />
          <PitchList<CoachPitch> items={(Object.keys(COACH_PITCHES) as CoachPitch[]).map((k) => ({ id: k, ...COACH_PITCHES[k], why: coachPitchAvailable(s, c, k, t.id) }))} notes={talks.notes} disabled={left <= 0}
            onPitch={(k) => { setAnswer(null); setPitchMsg(pitchToCoach(c.id, k, years).text); }} />
          {pitchMsg && <div className="text-xs text-ice" role="status">{pitchMsg}</div>}
        </div>
        {interest.refuses && <div className="mt-3 text-sm rounded-sm border border-accent/50 text-accent bg-accent/10 px-3 py-2" data-neg-refuse>{c.name} не рассматривает предложение. Повысьте интерес{c.role === 'head' && role === 'assistant' ? ' или предложите пост главного тренера' : ''}.</div>}
        <div className="mt-4">
          <div className="text-[11px] uppercase tracking-wider text-muted mb-1.5">Срок контракта</div>
          <div className="flex gap-1.5">{Array.from({ length: COACH_MAX_YEARS }, (_, i) => i + 1).map((y) => (
            <button key={y} onClick={() => { setYears(y); change(); }} className={cn('text-sm px-3 py-1.5 rounded-sm font-semibold', years === y ? 'bg-ice text-bg' : 'bg-panel2 text-muted hover:text-text')}>{y} {yearsWord(y)}</button>
          ))}</div>
        </div>
        <div className="grid grid-cols-2 gap-2 mt-3">
          <Stat label="Запрос тренера" value={formatMoney(ask)} sub={`за сезон, на ${years} ${yearsWord(years)}`} color="#F2B544" />
          <Stat label="Оценка вашего предложения" value={formatMoney(worth)} sub={`${worthPct}% от запроса`} color={worthPct >= 100 ? '#3FCF8E' : '#E8EEF5'} />
        </div>
        <div className="grid sm:grid-cols-2 gap-3 mt-3">
          <MoneyField label="Зарплата за сезон" testId="coach-salary" value={salary} min={500_000} onChange={(v) => { setSalaryInput(v); change(); }} />
          <MoneyField label="Подъёмные (разово)" testId="coach-signing" value={signing} onChange={(v) => { setSigning(v); change(); }} hint={`До ${formatMoney(salary * MAX_SIGNING_SHARE)}; тренер делит их на срок контракта.`} />
        </div>
        <div className="mt-4"><BonusEditor state={s} kinds={bonusKindsFor(null)} bonuses={bonuses} salary={salary} onChange={(b) => { setBonuses(b); change(); }} chance={(b) => bonusChance(s, b, t.id, null)} /></div>
        <div className="mt-3 text-xs space-y-1">
          <div className="flex justify-between gap-2"><span className="text-muted">Компенсация уходящему тренеру</span><span className="tabular">{formatMoney(severance)}</span></div>
          <div className="flex justify-between gap-2"><span className="text-muted">Списание при назначении (компенсация + подъёмные)</span><span className={cn('tabular', t.budget < severance + signing ? 'text-accent' : 'text-text')}>{formatMoney(severance + signing)} · бюджет {formatMoney(t.budget)}</span></div>
          {guarantee && <div className="text-gold">Гарантия полномочий: компенсация при увольнении ×1,5.</div>}
          <div className="text-muted">Компенсация при будущем увольнении: половина зарплаты за каждый оставшийся год контракта.</div>
          <div className="flex justify-between items-center"><span className="text-muted">Терпение тренера</span><span className="flex gap-1" data-neg-left={left}>{Array.from({ length: TALKS }, (_, i) => <span key={i} className={cn('w-2.5 h-2.5 rounded-full', i < left ? 'bg-ok' : 'bg-line')} />)}</span></div>
        </div>
        {answer && (
          <div className="mt-3 text-sm rounded-sm border px-3 py-2 border-accent/50 text-accent bg-accent/10" data-neg-result>
            {answer.text}
            {answer.counter && answer.left > 0 && <div className="mt-2"><Button size="sm" variant="ice" onClick={() => { setSalaryInput(answer.counter!); offer(answer.counter!); }} data-neg-counter>Согласиться на встречное: {formatMoney(answer.counter)}</Button></div>}
          </div>
        )}
        <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end mt-5 pt-4 border-t border-line">
          <Button variant="ghost" className="w-full sm:w-auto" onClick={onClose}>Закрыть</Button>
          <Button className="w-full sm:w-auto" disabled={blocked} onClick={() => offer(ask, true)} title="Зарплата по запросу, без подъёмных и бонусов">Принять условия тренера</Button>
          <Button variant="primary" className="w-full sm:w-auto" disabled={blocked} onClick={() => offer(salary)}>Сделать предложение</Button>
        </div>
      </div>
    </Modal>
  );
}
