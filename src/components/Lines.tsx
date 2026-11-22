import { useState } from 'react';
import type { Lineup, Player } from '../types';
import { autoLineup, lineupConstraintsFor } from '../game/ai';
import { attackRating, defenseRating, isForward, isGoalie, POS_RU } from '../game/ratings';
import { autoFillLineup, setUserLineup, setUserTactics, swapStarterBackup, useGame } from '../game/state';
import { countLineupLegionnaires, isLegionnaire, teamForeignLimit } from '../game/legionnaires';
import { getCapSummary } from '../game/cap';
import { nextUserGame } from '../game/schedule';
import { ATTACK_STYLE_INFO, calcDefenseChemistry, calcForwardChemistry, FORECHECK_INFO, freshnessTone, getArchetype, getTeamTactics, goalieFreshness, playerCaptainRole, PULL_GOALIE_INFO } from '../game/chemistry';
import { isU20DefenseLimiter, isU20ForwardLimiter, isU20Limiter } from '../game/dynasty';
import { Bar, Button, Empty, Panel, OverallChip, PosBadge, Tag, useUI } from './ui';
import { LineupPreview } from './LineupPreview';
import { cn } from '../utils/cn';

function clone(L: Lineup): Lineup {
  return {
    F: L.F.map((l) => [...l]),
    D: L.D.map((l) => [...l]),
    pp1: [...L.pp1],
    pp2: [...L.pp2],
    pk1: [...L.pk1],
    pk2: [...L.pk2],
    starterG: L.starterG,
    backupG: L.backupG,
    u20F: L.u20F ?? null,
    u20D: L.u20D ?? null,
  };
}

function dedupeLineup(L: Lineup) {
  const seen = new Set<string>();
  const unique = (ids: (string | null)[]) =>
    ids.map((id) => {
      if (!id || seen.has(id)) return null;
      seen.add(id);
      return id;
    });
  const even = unique([...L.F.flat(), ...L.D.flat(), L.starterG, L.backupG]);
  let n = 0;
  L.F = L.F.map((line) => line.map(() => even[n++] ?? null));
  L.D = L.D.map((line) => line.map(() => even[n++] ?? null));
  L.starterG = even[n++] ?? null;
  L.backupG = even[n++] ?? null;
  if (L.u20F && seen.has(L.u20F)) L.u20F = null;
  else if (L.u20F) seen.add(L.u20F);
  if (L.u20D && seen.has(L.u20D)) L.u20D = null;
  else if (L.u20D) seen.add(L.u20D);

  const uniqueSpecial = (ids: (string | null)[]) => {
    const sp = new Set<string>();
    return ids.map((id) => {
      if (!id || sp.has(id)) return null;
      sp.add(id);
      return id;
    });
  };
  const pp = uniqueSpecial([...L.pp1, ...L.pp2]);
  L.pp1 = pp.slice(0, 5);
  L.pp2 = [...pp.slice(5, 10), ...Array(Math.max(0, 5 - pp.slice(5, 10).length)).fill(null)];
  const pk = uniqueSpecial([...L.pk1, ...L.pk2]);
  L.pk1 = pk.slice(0, 4);
  L.pk2 = [...pk.slice(4, 8), ...Array(Math.max(0, 4 - pk.slice(4, 8).length)).fill(null)];
}

export function Lines() {
  const s = useGame()!;
  const ui = useUI();
  const P = s.players;
  const U = s.teams[s.userTeamId];
  const L = U.lineup;
  const [sel, setSel] = useState<{ id: string; set?: (c: Lineup, v: string | null) => void } | null>(null);
  const [ruleErr, setRuleErr] = useState<string | null>(null);

  const fl = teamForeignLimit(U, s.league.foreignLimit);
  const dressedLegs = countLineupLegionnaires(L, P);
  const capSummary = getCapSummary(s, U.id);
  const suspendedSet = new Set(capSummary.suspendedIds);
  const nextG = nextUserGame(s, U.id);
  const nextOppId = nextG ? (nextG.home === U.id ? nextG.away : nextG.home) : undefined;

  const used = new Set<string>(
    [...L.F.flat(), ...L.D.flat(), ...L.pp1, ...L.pp2, ...L.pk1, ...L.pk2, L.starterG, L.backupG, L.u20F, L.u20D].filter((x): x is string => !!x)
  );
  const bench = U.players
    .filter((id) => !used.has(id) && P[id] && !P[id].inVhl)
    .map((id) => P[id])
    .sort((a, b) => b.overall - a.overall);
  const tactics = getTeamTactics(U);

  const place = (setter: (c: Lineup) => void) => {
    const c = clone(L);
    setter(c);
    dedupeLineup(c);
    if (c.u20F && !isU20ForwardLimiter(P[c.u20F])) {
      setRuleErr('В слот 13-го нападающего («лимитчик» U20) можно заявить только нападающего ЕАЭС не старше 20 лет!');
      return;
    }
    if (c.u20D && !isU20DefenseLimiter(P[c.u20D])) {
      setRuleErr('В слот 7-го защитника («лимитчик» U20) можно заявить только защитника ЕАЭС не старше 20 лет!');
      return;
    }
    if (fl !== null && countLineupLegionnaires(c, P) > fl) {
      setRuleErr(`Превышен лимит легионеров КХЛ в заявке на матч (максимум ${fl} иностранцев). Замените одного из легионеров.`);
      return;
    }
    const afterUsed = new Set<string>(
      [...c.F.flat(), ...c.D.flat(), ...c.pp1, ...c.pp2, ...c.pk1, ...c.pk2, c.starterG, c.backupG, c.u20F, c.u20D].filter((x): x is string => !!x)
    );
    for (const sid of suspendedSet) {
      if (afterUsed.has(sid)) {
        setRuleErr(`Игрок ${P[sid]?.name ?? ''} заблокирован лигой из-за превышения потолка зарплат!`);
        return;
      }
    }
    setRuleErr(null);
    setUserLineup(c);
    setSel(null);
  };
  const slotClick = (get: (c: Lineup) => string | null | undefined, set: (c: Lineup, v: string | null) => void) => {
    const cur = get(L) ?? null;
    if (!sel) {
      if (cur) setSel({ id: cur, set });
      return;
    }
    if (cur === sel.id) {
      setSel(null);
      return;
    }
    place((c) => {
      if (sel.set) sel.set(c, cur);
      set(c, sel.id);
    });
  };
  const removeSel = () => {
    if (!sel) return;
    if (sel.set) place((c) => sel.set!(c, null));
    else setSel(null);
  };

  const skater = (id: string | null) => (id ? P[id] : null);
  const slotCls = (id: string | null, pref: 'C' | 'LW' | 'RW' | 'D' | 'G') => {
    const p = skater(id);
    const oop = p && !isGoalie(p) && pref !== 'G' && p.position !== pref && !(pref !== 'C' && isForward(p)) ;
    return cn('flex items-center gap-2 rounded-sm border h-11 px-2 transition-all duration-150 text-sm min-w-0', !id && 'border-dashed border-line/80 text-muted hover:border-muted bg-transparent', id && 'bg-panel2 border-line hover:border-muted', sel && id === sel.id && 'ring-2 ring-accent border-accent', oop && 'border-amber/60');
  };

  const Slot = ({ id, pref, onClick, label }: { id: string | null | undefined; pref: 'C' | 'LW' | 'RW' | 'D' | 'G'; onClick: () => void; label?: string }) => {
    const p = skater(id ?? null);
    const capRole = p ? playerCaptainRole(U, p.id) : null;
    const arch = p ? getArchetype(p) : null;
    return (
      <button
        onClick={onClick}
        className={slotCls(id ?? null, pref)}
        title={p ? `${p.name} · ${arch?.label ?? ''} · OVR ${p.overall} · ${p.country}` : 'Пустой слот'}
      >
        <span className="text-[10px] uppercase text-muted w-5">{label ?? POS_RU[pref]}</span>
        {p ? (
          <>
            <span className="font-medium truncate flex-1 text-left">{p.name}</span>
            {capRole && (
              <span className={cn('text-[9px] font-bold px-1 rounded', capRole === 'C' ? 'bg-gold/25 text-gold' : 'bg-ice/20 text-ice')}>
                {capRole === 'C' ? 'К' : 'А'}
              </span>
            )}
            {arch && !isGoalie(p) && (
              <span className="hidden sm:inline text-[9px] px-1 rounded bg-bg/70 text-muted" style={{ color: arch.color }}>
                {arch.short}
              </span>
            )}
            {isLegionnaire(p) && <span className="text-[9px] font-bold px-1 rounded bg-gold/20 text-gold">ЛЕГ</span>}
            <PosBadge pos={p.position} />
            <OverallChip value={p.overall} size="sm" />
          </>
        ) : (
          <span className="flex-1 text-left">пусто</span>
        )}
      </button>
    );
  };

  const lineStats = (ids: (string | null)[]) => {
    const ps = ids.map(skater).filter((p): p is Player => !!p);
    if (!ps.length) return null;
    const att = Math.round(ps.reduce((a, p) => a + attackRating(p), 0) / ps.length);
    const def = Math.round(ps.reduce((a, p) => a + defenseRating(p), 0) / ps.length);
    return { att, def };
  };
  const Info = ({ ids, chemKind }: { ids: (string | null)[]; chemKind?: 'F' | 'D' }) => {
    const v = lineStats(ids);
    const chem = chemKind === 'F' ? calcForwardChemistry(ids, P, U.chemGP) : chemKind === 'D' ? calcDefenseChemistry(ids, P, U.chemGP) : null;
    return v ? (
      <span className="flex items-center gap-1 text-[11px] tabular flex-wrap justify-end">
        {chem && (
          <span
            title={`Химия: ${chem.summary}`}
            className={cn(
              'px-1.5 py-0.5 rounded font-semibold text-[10px]',
              chem.score >= 2 ? 'bg-ok/20 text-ok' : chem.score <= -1 ? 'bg-accent/20 text-accent' : 'bg-panel2 text-ice'
            )}
          >
            ХИМ {chem.score > 0 ? `+${chem.score}` : chem.score}
          </span>
        )}
        <Tag color="#8FD8F0">АТК {v.att}</Tag>
        <Tag color="#F2B544">ЗАЩ {v.def}</Tag>
      </span>
    ) : null;
  };

  const dressedF = L.F.flat().filter(Boolean).length;
  const dressedD = L.D.flat().filter(Boolean).length;
  const dressedG = [L.starterG, L.backupG].filter(Boolean).length;
  const problems: string[] = [];
  if (dressedF < 12) problems.push(`Нападающих в составе: ${dressedF} из 12`);
  if (dressedD < 6) problems.push(`Защитников: ${dressedD} из 6`);
  if (dressedG < 2) problems.push(`Вратарей: ${dressedG} из 2`);
  const injuredDressed = [...used].filter((id) => P[id]?.injury);

  return (
    <div className="space-y-4 fade-in">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 flex-wrap text-sm text-muted">
          <span>Кликните игрока, затем слот — игрок встанет на место (swap при занятом слоте).</span>
          <span data-lineup-legionnaires>
            {fl !== null ? (
              <Tag tone={dressedLegs > fl ? 'bad' : dressedLegs === fl ? 'warn' : 'accent'}>
                Легионеры в заявке: {dressedLegs} / {fl}
              </Tag>
            ) : (
              <Tag tone="good">Иностранный клуб КХЛ · без лимита легионеров ({dressedLegs})</Tag>
            )}
          </span>
        </div>
        <div className="flex gap-2">
          {sel && (
            <Button variant="danger" size="sm" onClick={removeSel}>
              Снять со слота
            </Button>
          )}
          <Button size="sm" onClick={() => { setUserLineup(autoLineup(U.players, P, lineupConstraintsFor(s, U.id))); setSel(null); setRuleErr(null); }}>
            Автосостав
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { autoFillLineup(); setSel(null); setRuleErr(null); }}>
            Сбросить
          </Button>
        </div>
      </div>
      {ruleErr && (
        <div className="rounded-md border border-red/50 bg-red/15 px-3 py-2 text-xs text-ice flex items-center justify-between gap-2">
          <span>⛔ {ruleErr}</span>
          <button type="button" onClick={() => setRuleErr(null)} className="text-muted hover:text-ice cursor-pointer">✕</button>
        </div>
      )}
      {sel && (
        <div className="rounded-md border border-accent/60 bg-accent/10 px-3 py-2 text-sm flex flex-wrap items-center gap-3">
          Выбран игрок: <b>{P[sel.id]?.name}</b>
          <Button size="sm" variant="danger" onClick={removeSel}>
            Снять
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSel(null)}>
            Отмена
          </Button>
        </div>
      )}
      {(problems.length > 0 || injuredDressed.length > 0) && (
        <div className="rounded-md border border-amber/40 bg-amber/10 p-3 text-sm text-amber">
          {problems.map((p) => (
            <div key={p}>⚠ {p} — пустые слоты будут заменены заменой (рейтинг 50) перед матчем.</div>
          ))}
          {injuredDressed.length > 0 && <div>⚠ Травмированные: {injuredDressed.map((id) => P[id].name).join(', ')} — перед матчем их заменит здоровый игрок.</div>}
        </div>
      )}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-4">
        <div className="space-y-4">
          <Panel title="Звенья нападения">
            <div className="space-y-3">
              {L.F.map((line, i) => (
                <div key={i} className="grid grid-cols-[36px_1fr_auto] items-center gap-2">
                  <div className="font-display text-lg text-muted">{i + 1}</div>
                  <div className="grid grid-cols-3 gap-2">
                    <Slot id={line[0]} pref="C" onClick={() => slotClick((c) => c.F[i][0], (c, v) => (c.F[i][0] = v))} />
                    <Slot id={line[1]} pref="LW" onClick={() => slotClick((c) => c.F[i][1], (c, v) => (c.F[i][1] = v))} />
                    <Slot id={line[2]} pref="RW" onClick={() => slotClick((c) => c.F[i][2], (c, v) => (c.F[i][2] = v))} />
                  </div>
                  <Info ids={line} chemKind="F" />
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Пары защитников">
            <div className="space-y-3">
              {L.D.map((pair, i) => (
                <div key={i} className="grid grid-cols-[36px_1fr_auto] items-center gap-2">
                  <div className="font-display text-lg text-muted">{i + 1}</div>
                  <div className="grid grid-cols-2 gap-2">
                    <Slot id={pair[0]} pref="D" onClick={() => slotClick((c) => c.D[i][0], (c, v) => (c.D[i][0] = v))} label="З" />
                    <Slot id={pair[1]} pref="D" onClick={() => slotClick((c) => c.D[i][1], (c, v) => (c.D[i][1] = v))} label="З" />
                  </div>
                  <Info ids={pair} chemKind="D" />
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Большинство">
            <div className="space-y-3">
              {(['pp1', 'pp2'] as const).map((k, i) => (
                <div key={k} className="grid grid-cols-[36px_1fr_auto] items-center gap-2">
                  <div className="font-display text-lg text-muted">{i + 1}</div>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    {L[k].map((id, j) => (
                      <Slot key={j} id={id} pref={j < 3 ? 'C' : 'D'} onClick={() => slotClick((c) => c[k][j], (c, v) => (c[k][j] = v))} label={j < 3 ? 'Н' : 'З'} />
                    ))}
                  </div>
                  <Info ids={L[k]} />
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Меньшинство">
            <div className="space-y-3">
              {(['pk1', 'pk2'] as const).map((k, i) => (
                <div key={k} className="grid grid-cols-[36px_1fr_auto] items-center gap-2">
                  <div className="font-display text-lg text-muted">{i + 1}</div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {L[k].map((id, j) => (
                      <Slot key={j} id={id} pref={j < 2 ? 'C' : 'D'} onClick={() => slotClick((c) => c[k][j], (c, v) => (c[k][j] = v))} label={j < 2 ? 'Н' : 'З'} />
                    ))}
                  </div>
                  <Info ids={L[k]} />
                </div>
              ))}
            </div>
          </Panel>
          <Panel
            title="Вратари и свежесть"
            right={
              L.backupG ? (
                <Button size="sm" variant="secondary" onClick={() => swapStarterBackup()}>
                  ⇄ Поменять стартера и бэкапа
                </Button>
              ) : null
            }
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {([
                ['Стартовый вратарь', L.starterG, (c: Lineup) => c.starterG, (c: Lineup, v: string | null) => (c.starterG = v)],
                ['Запасной вратарь', L.backupG, (c: Lineup) => c.backupG, (c: Lineup, v: string | null) => (c.backupG = v)],
              ] as const).map(([lbl, gid, getter, setter]) => {
                const gp = gid ? P[gid] : null;
                const fr = goalieFreshness(gp);
                const ft = freshnessTone(fr);
                return (
                  <div key={lbl}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-muted">{lbl}</span>
                      {gp && (
                        <span className="text-[11px] font-semibold tabular" style={{ color: ft.color }}>
                          Свежесть {fr}% · {ft.label}
                        </span>
                      )}
                    </div>
                    <Slot id={gid} pref="G" onClick={() => slotClick(getter, setter)} label="В" />
                    {gp && <Bar value={fr} color={ft.color} height={5} className="mt-1.5" />}
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel title="Лимитчики КХЛ (молодые игроки до 20 лет · ЕАЭС)" data-u20-limiters>
            <div className="text-xs text-muted mb-2">
              По регламенту КХЛ в заявку на матч сверх 18 полевых можно включить 13-го нападающего и 7-го защитника не старше 20 лет (паспорт ЕАЭС) — они получают сменную практику и бонус к опыту U23.
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <div className="text-xs text-muted mb-1">13-й нападающий (U20)</div>
                <Slot id={L.u20F} pref="RW" onClick={() => slotClick((c) => c.u20F, (c, v) => (c.u20F = v))} label="13Н" />
              </div>
              <div>
                <div className="text-xs text-muted mb-1">7-й защитник (U20)</div>
                <Slot id={L.u20D} pref="D" onClick={() => slotClick((c) => c.u20D, (c, v) => (c.u20D = v))} label="7З" />
              </div>
            </div>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Базовая тактика команды" data-team-tactics>
            <div className="space-y-2.5 text-xs">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Система форчекинга</div>
                <div className="grid grid-cols-3 gap-1">
                  {(['aggressive', 'balanced', 'trap'] as const).map((fc) => (
                    <button
                      key={fc}
                      type="button"
                      onClick={() => setUserTactics({ forecheck: fc })}
                      title={FORECHECK_INFO[fc].desc}
                      className={cn(
                        'px-1.5 py-1.5 rounded-sm font-semibold text-[11px] border transition cursor-pointer',
                        tactics.forecheck === fc ? 'bg-accent text-white border-accent' : 'bg-panel2 border-line text-muted hover:text-text'
                      )}
                    >
                      {FORECHECK_INFO[fc].short}
                    </button>
                  ))}
                </div>
                <div className="text-[11px] text-muted mt-1">{FORECHECK_INFO[tactics.forecheck].desc}</div>
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Акцент в атаке</div>
                <div className="grid grid-cols-3 gap-1">
                  {(['shoot', 'balanced', 'cycle'] as const).map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => setUserTactics({ style: st })}
                      title={ATTACK_STYLE_INFO[st].desc}
                      className={cn(
                        'px-1.5 py-1.5 rounded-sm font-semibold text-[11px] border transition cursor-pointer',
                        tactics.style === st ? 'bg-ice text-bg border-ice' : 'bg-panel2 border-line text-muted hover:text-text'
                      )}
                    >
                      {ATTACK_STYLE_INFO[st].short}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Снятие вратаря в концовке</div>
                <div className="grid grid-cols-3 gap-1">
                  {(['early', 'normal', 'never'] as const).map((pl) => (
                    <button
                      key={pl}
                      type="button"
                      onClick={() => setUserTactics({ pullGoalie: pl })}
                      className={cn(
                        'px-1.5 py-1 rounded-sm font-semibold text-[11px] border transition cursor-pointer',
                        tactics.pullGoalie === pl ? 'bg-gold/25 border-gold text-gold' : 'bg-panel2 border-line text-muted hover:text-text'
                      )}
                    >
                      {PULL_GOALIE_INFO[pl].short}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </Panel>

          <Panel title="Запас и свободные слоты" right={<Tag color="#93A4BC">{bench.length} игроков</Tag>}>
            {bench.length === 0 ? (
              <Empty text="Все игроки основы уже в заявке" />
            ) : (
              <ul className="space-y-1 max-h-[460px] overflow-y-auto pr-1">
                {bench.map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => {
                        if (suspendedSet.has(p.id)) {
                          setRuleErr(`Контракт ${p.name} заблокирован КХЛ из-за превышения потолка зарплат!`);
                          return;
                        }
                        setSel(sel?.id === p.id ? null : { id: p.id });
                      }}
                      onDoubleClick={() => ui.openPlayer(p.id)}
                      className={cn(
                        'w-full flex items-center gap-2 px-2 py-1.5 rounded-sm border text-sm transition-colors',
                        sel?.id === p.id ? 'border-accent bg-accent/15 ring-1 ring-accent/50' : 'border-transparent hover:bg-panel2',
                        (p.injury || suspendedSet.has(p.id)) && 'opacity-60'
                      )}
                      title="Двойной клик — карточка игрока"
                    >
                      <PosBadge pos={p.position} />
                      <span className="flex-1 truncate text-left">{p.name}</span>
                      {isU20Limiter(p) && <span className="text-[9px] font-bold px-1 rounded bg-ice/20 text-ice">U20</span>}
                      {isLegionnaire(p) && <span className="text-[9px] font-bold px-1 rounded bg-gold/20 text-gold">ЛЕГ</span>}
                      {suspendedSet.has(p.id) && <span className="text-[9px] font-bold px-1 rounded bg-red/25 text-red">БЛОК ФОТ</span>}
                      <span className="text-xs text-muted">{p.age} л.</span>
                      <OverallChip value={p.overall} size="sm" />
                      {p.injury && <span className="text-[10px] text-accent uppercase">{p.injury.games} мат.</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Как это работает">
            <ul className="text-xs text-text/80 space-y-1.5">
              <li>• Сила звена складывается из атакующих и оборонительных навыков игроков; топ-звено получает больше минут.</li>
              <li>• В меньшинстве играют четвёрки PK, в большинстве — пятерки PP; их навыки влияют на реализацию и надёжность.</li>
              <li>• Стартовый вратарь играет матч целиком; запасной нужен на случай травмы.</li>
              <li>• Перед матчем травмированные заменяются на лучших здоровых игроков.</li>
            </ul>
          </Panel>
        </div>
      </div>

      {/* Live Pre-Match Power Play Preview & Lineup Comparison */}
      <LineupPreview
        state={s}
        leftTeamId={U.id}
        initialOpponentId={nextOppId}
        overrideLeftLineup={L}
        onPlayer={(id) => ui.openPlayer(id)}
      />
    </div>
  );
}
