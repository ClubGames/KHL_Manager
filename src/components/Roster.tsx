import { StaffSummary } from './Coaching';
import { useEffect, useMemo, useState } from 'react';
import type { Player } from '../types';
import { formatMoney, isDefense, isForward, isGoalie, POS_NAME, salaryDemand, SKILL_LABELS, skillList } from '../game/ratings';
import {
  activatePlayerFromLtir,
  autoAssignYouthPlans,
  claimFromWaivers,
  placePlayerInLtir,
  recallFromVhl,
  releasePlayer,
  sendToVhlOrWaivers,
  setTeamRole,
  setTradeFlag,
  setTrainingPlan,
  toggleHallOfFameJersey,
  togglePlayThroughInjury,
  useGame,
} from '../game/state';
import { buyoutCost } from '../game/contracts';
import { buyoutDeadCap, getCapSummary } from '../game/cap';
import { countRosterLegionnaires, countryCode, isLegionnaire, teamForeignLimit } from '../game/legionnaires';
import { getPlayerPlan, isYouthPlayer, playerIceRole, plansForPlayer } from '../game/training';
import { freshnessTone, getArchetype, goalieFreshness, playerCaptainRole } from '../game/chemistry';
import { isU20Limiter } from '../game/dynasty';
import { activeKhlCount, hasTwoWayContract, isWaiverExempt, MAX_VHL_PLAYERS, playerStatusTag, teamVhlCapRelief, vhlPlayerCapRelief } from '../game/khlRules';
import { canPlaceInLtir, canPlayThroughInjury, formatInjuryDays, injuryReturnDate, isPlayingHurt, LTIR_MIN_DAYS } from '../game/medical';
import { regularSeasonLength } from '../game/schedule';
import { Bar, Button, Empty, Modal, OverallChip, Panel, PosBadge, Tag, TeamLogo, useUI } from './ui';
import { cn } from '../utils/cn';

type SortKey = 'number' | 'name' | 'age' | 'overall' | 'potential' | 'salary' | 'years' | 'gp' | 'goals' | 'assists' | 'points' | 'plusMinus' | 'pim' | 'wins' | 'shutouts' | 'sv' | 'gaa';

function val(p: Player, k: SortKey): number | string {
  const st = p.stats;
  switch (k) {
    case 'number':
      return p.number;
    case 'name':
      return p.name;
    case 'age':
      return p.age;
    case 'overall':
      return p.overall;
    case 'potential':
      return p.potential;
    case 'salary':
      return p.contract.salary;
    case 'years':
      return p.contract.years;
    case 'gp':
      return st.gp;
    case 'goals':
      return st.goals;
    case 'assists':
      return st.assists;
    case 'points':
      return st.goals + st.assists;
    case 'plusMinus':
      return st.plusMinus;
    case 'pim':
      return st.pim;
    case 'wins':
      return st.wins;
    case 'shutouts':
      return st.shutouts;
    case 'sv':
      return st.shotsAgainst ? st.saves / st.shotsAgainst : 0;
    case 'gaa':
      return st.minutes ? ((st.shotsAgainst - st.saves) * 60) / st.minutes : 0;
  }
  return 0;
}

const gaa = (p: Player) => (p.stats.minutes ? ((p.stats.shotsAgainst - p.stats.saves) * 60) / p.stats.minutes : 0);

export function Roster({ teamId }: { teamId?: string }) {
  const s = useGame()!;
  const ui = useUI();
  const P = s.players;
  const tid = teamId ?? s.userTeamId;
  const team = s.teams[tid];
  const isOwnTeam = tid === s.userTeamId;
  const [tab, setTab] = useState<'F' | 'D' | 'G' | 'U23' | 'VHL' | 'HOF'>('F');
  const [sort, setSort] = useState<{ k: SortKey; d: number }>({ k: 'overall', d: -1 });
  const [vhlNotice, setVhlNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [hofScope, setHofScope] = useState<'club' | 'league'>('club');
  const all = team.players.map((id) => P[id]).filter(Boolean);
  const youthList = useMemo(() => all.filter((p) => isYouthPlayer(p)).sort((a, b) => b.potential - a.potential || b.overall - a.overall), [all]);
  const vhlList = useMemo(() => all.filter((p) => p.inVhl).sort((a, b) => b.overall - a.overall), [all]);
  const activeWaivers = (s.waivers ?? []).filter((w) => w.expiresDay > s.day && P[w.playerId]);
  const hofList = (s.hallOfFame ?? []).filter((e) => (hofScope === 'club' ? e.teamId === tid : true));
  const totalVhlRelief = teamVhlCapRelief(team.players, P);
  const fl = teamForeignLimit(team, s.league.foreignLimit);
  const legCount = countRosterLegionnaires(team.players, P);
  const capInfo = getCapSummary(s, tid);
  const suspendedSet = new Set(capInfo.suspendedIds);
  const capPlayer = team.captainId ? P[team.captainId] : null;
  const altPlayers = (team.assistantIds ?? []).map((id: string) => P[id]).filter(Boolean);
  const regLen = regularSeasonLength(s.schedule);
  const allStarSet = new Set([...(s.allStar?.westRoster ?? []), ...(s.allStar?.eastRoster ?? [])]);

  const list = useMemo(() => {
    const f = all.filter((p) => (tab === 'G' ? isGoalie(p) : tab === 'D' ? isDefense(p) : isForward(p)));
    return [...f].sort((a, b) => {
      const va = val(a, sort.k);
      const vb = val(b, sort.k);
      if (typeof va === 'string' || typeof vb === 'string') return va.toString().localeCompare(vb.toString(), 'ru') * sort.d;
      return (va - vb) * sort.d;
    });
  }, [all, tab, sort]);
  const Th = ({ k, children, className }: { k: SortKey; children: string; className?: string }) => (
    <th className={cn('px-2 py-2 text-left text-[11px] uppercase tracking-wider font-semibold text-muted select-none cursor-pointer hover:text-text', className)} onClick={() => setSort({ k, d: sort.k === k ? -sort.d : k === 'name' ? 1 : -1 })}>
      {children}
      {sort.k === k && <span className="text-accent ml-0.5">{sort.d > 0 ? '▲' : '▼'}</span>}
    </th>
  );
  const counts = { F: all.filter(isForward).length, D: all.filter(isDefense).length, G: all.filter(isGoalie).length };
  return (
    <div className="space-y-4 fade-in">
      <StaffSummary team={team} />
      {/* Legionnaire Limit & Cap Compliance Summary Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel px-4 py-2.5 text-xs" data-roster-limits>
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-muted">Заявка КХЛ:</span>
          <Tag tone={activeKhlCount(team.players, P) >= 30 ? 'warn' : 'good'}>
            {activeKhlCount(team.players, P)} / 30{vhlList.length > 0 ? ` · ВХЛ ${vhlList.length}/${MAX_VHL_PLAYERS}` : ''}
          </Tag>
          <span className="text-muted">Лимит легионеров КХЛ:</span>
          {fl !== null ? (
            <Tag tone={legCount > fl ? 'bad' : legCount === fl ? 'warn' : 'accent'}>
              {legCount} / {fl} легионеров {legCount > fl ? '(лишние вне заявки на матч)' : ''}
            </Tag>
          ) : (
            <Tag tone="good">Иностранный клуб · без лимита ({legCount} лег.)</Tag>
          )}
          <span className="text-muted ml-1">ФОТ под потолком:</span>
          <Tag tone={capInfo.over ? 'bad' : 'good'}>
            {formatMoney(capInfo.totalPayroll)} / {formatMoney(capInfo.cap)}
            {capInfo.deadCap > 0 ? ` (вкл. выкупы ${formatMoney(capInfo.deadCap)})` : ''}
          </Tag>
          {capInfo.sanctionsActive && <Tag tone="bad">Санкции потолка активны (−{capInfo.pointsDeducted} очк.)</Tag>}
          {capPlayer && (
            <span className="text-gold font-semibold">
              К: {capPlayer.name}
              {altPlayers.length > 0 && <span className="text-ice font-normal ml-1.5">· А: {altPlayers.map((a: Player) => a.name).join(', ')}</span>}
            </span>
          )}
        </div>
        {isOwnTeam && (
          <div className="hidden md:flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setTab(tab === 'VHL' ? 'F' : 'VHL')}
              data-vhl-tab
              className={cn(
                'px-2.5 py-1 rounded font-semibold transition cursor-pointer',
                tab === 'VHL' ? 'bg-ice text-bg' : 'bg-ice/15 text-ice border border-ice/40 hover:bg-ice/25'
              )}
            >
              ⇄ Фарм ВХЛ и Отказы ({vhlList.length}/{activeWaivers.length})
            </button>
            <button
              type="button"
              onClick={() => setTab(tab === 'HOF' ? 'F' : 'HOF')}
              data-hof-tab
              className={cn(
                'px-2.5 py-1 rounded font-semibold transition cursor-pointer',
                tab === 'HOF' ? 'bg-gold text-bg' : 'bg-panel2 text-gold border border-gold/40 hover:bg-gold/20'
              )}
            >
              🏆 Зал славы ({(s.hallOfFame ?? []).length})
            </button>
            <button
              type="button"
              onClick={() => setTab(tab === 'U23' ? 'F' : 'U23')}
              className={cn(
                'px-2.5 py-1 rounded font-semibold transition cursor-pointer',
                tab === 'U23' ? 'bg-gold text-bg' : 'bg-gold/15 text-gold border border-gold/40 hover:bg-gold/25'
              )}
            >
              ★ Планы U23 ({youthList.length})
            </button>
          </div>
        )}
      </div>

      {/* Mobile horizontal tab scroller */}
      <div className="md:hidden flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
        {(['F', 'D', 'G'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'text-xs px-3 py-2 rounded-sm font-semibold whitespace-nowrap shrink-0 border transition-colors',
              tab === t ? 'bg-accent text-white border-accent' : 'text-muted bg-panel border-line'
            )}
          >
            {t === 'F' ? `Нап (${counts.F})` : t === 'D' ? `Защ (${counts.D})` : `Вр (${counts.G})`}
          </button>
        ))}
        {isOwnTeam && (
          <>
            <button
              onClick={() => setTab('U23')}
              className={cn(
                'text-xs px-3 py-2 rounded-sm font-semibold whitespace-nowrap shrink-0 border transition-colors',
                tab === 'U23' ? 'bg-gold text-bg border-gold' : 'text-gold bg-panel border-gold/40'
              )}
            >
              U23 ({youthList.length})
            </button>
            <button
              onClick={() => setTab('VHL')}
              className={cn(
                'text-xs px-3 py-2 rounded-sm font-semibold whitespace-nowrap shrink-0 border transition-colors',
                tab === 'VHL' ? 'bg-ice text-bg border-ice' : 'text-ice bg-panel border-ice/40'
              )}
            >
              ВХЛ / Отказы ({vhlList.length}/{activeWaivers.length})
            </button>
            <button
              onClick={() => setTab('HOF')}
              className={cn(
                'text-xs px-3 py-2 rounded-sm font-semibold whitespace-nowrap shrink-0 border transition-colors',
                tab === 'HOF' ? 'bg-gold text-bg border-gold' : 'text-muted bg-panel border-line'
              )}
            >
              Зал славы ({(s.hallOfFame ?? []).length})
            </button>
          </>
        )}
      </div>

      {vhlNotice && (
        <div className={cn('rounded-md border px-3 py-2 text-xs', vhlNotice.ok ? 'border-ok/40 bg-ok/10 text-ok' : 'border-accent/40 bg-accent/10 text-accent')}>
          {vhlNotice.msg}
        </div>
      )}

      <Panel
        title={
          <span className="flex items-center gap-2 min-w-0">
            <TeamLogo team={team} size={22} />{' '}
            <span className="truncate">
              {tab === 'U23'
                ? `Развитие U23 · ${team.short}`
                : tab === 'VHL'
                  ? `ВХЛ и отказы · ${team.short}`
                  : tab === 'HOF'
                    ? `Зал славы · ${team.short}`
                    : `Состав · ${team.name}`}
            </span>
          </span>
        }
        right={
          <div className="hidden md:flex flex-wrap gap-1">
            {(['F', 'D', 'G'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={cn('text-xs px-2.5 py-1 rounded-sm font-semibold transition-colors cursor-pointer', tab === t ? 'bg-accent text-white' : 'text-muted hover:text-text bg-panel2')}>
                {t === 'F' ? `Нападающие ${counts.F}` : t === 'D' ? `Защитники ${counts.D}` : `Вратари ${counts.G}`}
              </button>
            ))}
            {isOwnTeam && (
              <>
                <button
                  onClick={() => setTab('U23')}
                  className={cn('text-xs px-2.5 py-1 rounded-sm font-semibold transition-colors cursor-pointer', tab === 'U23' ? 'bg-gold text-bg' : 'text-gold hover:text-ice bg-panel2')}
                >
                  Планы U23 ({youthList.length})
                </button>
                <button
                  onClick={() => setTab('VHL')}
                  className={cn('text-xs px-2.5 py-1 rounded-sm font-semibold transition-colors cursor-pointer', tab === 'VHL' ? 'bg-ice text-bg' : 'text-ice hover:text-text bg-panel2')}
                >
                  ВХЛ / Отказы
                </button>
                <button
                  onClick={() => setTab('HOF')}
                  className={cn('text-xs px-2.5 py-1 rounded-sm font-semibold transition-colors cursor-pointer', tab === 'HOF' ? 'bg-gold text-bg' : 'text-muted hover:text-text bg-panel2')}
                >
                  Зал славы
                </button>
              </>
            )}
          </div>
        }
        noPad={tab === 'F' || tab === 'D' || tab === 'G'}
      >
        {tab === 'VHL' && isOwnTeam ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" data-vhl-view>
            <div className="space-y-3">
              <div className="rounded-md border border-line bg-bg/50 p-3 text-xs space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-display uppercase tracking-wider text-ice font-semibold">Командированные в ВХЛ ({vhlList.length})</span>
                  <Tag tone="good">Разгрузка потолка: {formatMoney(totalVhlRelief)}</Tag>
                </div>
                <p className="text-muted">
                  До <b>22 лет</b> — прямой перевод в ВХЛ без отказов (+игровая практика). С <b>23 лет</b> — через <b>48-часовой драфт отказов</b> (игроки с пунктом ЗНО защищены). Контракт в ВХЛ облегчает ФОТ под потолком до 15 млн ₽.
                </p>
              </div>
              {vhlList.length === 0 ? (
                <Empty text="В фарм-клубе ВХЛ сейчас нет игроков." />
              ) : (
                <div className="space-y-1.5">
                  {vhlList.map((p) => (
                    <div key={p.id} className="rounded-sm border border-line bg-panel2/60 p-2.5 flex items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <PosBadge pos={p.position} />
                        <button onClick={() => ui.openPlayer(p.id)} className="font-semibold text-sm hover:text-ice truncate">
                          {p.name}
                        </button>
                        <span className="text-muted">{p.age} л.</span>
                        <OverallChip value={p.overall} size="sm" />
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-ok tabular">
                          в ФОТ {formatMoney(p.contract.salary - vhlPlayerCapRelief(p))} <span className="text-muted">/ {formatMoney(p.contract.salary)}</span>
                        </span>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            const err = recallFromVhl(p.id);
                            setVhlNotice({ ok: !err, msg: err ?? `${p.name} вызван из ВХЛ в основу КХЛ.` });
                          }}
                        >
                          Вызвать в КХЛ
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="pt-2 border-t border-line">
                <div className="text-[11px] uppercase tracking-wider text-muted mb-1.5">Отправить из основы КХЛ в ВХЛ</div>
                <div className="max-h-56 overflow-y-auto space-y-1 pr-1">
                  {all
                    .filter((p) => !p.inVhl)
                    .sort((a, b) => a.overall - b.overall)
                    .map((p) => {
                      const exempt = isWaiverExempt(p);
                      const onW = activeWaivers.some((w) => w.playerId === p.id);
                      return (
                        <div key={p.id} className="flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-panel2 text-xs">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <PosBadge pos={p.position} />
                            <span className="truncate font-medium">{p.name}</span>
                            <span className="text-muted">{p.age} л. · {p.overall}</span>
                            {p.nmc && <Tag tone="warn">ЗНО</Tag>}
                            {exempt ? <Tag tone="good">2-стор. напрямую</Tag> : <Tag tone="accent">Отказы 48ч</Tag>}
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!!p.nmc || onW}
                            onClick={() => {
                              const err = sendToVhlOrWaivers(p.id);
                              setVhlNotice({
                                ok: !err,
                                msg: err ?? (exempt ? `${p.name} переведён в фарм-клуб ВХЛ.` : `${p.name} помещён в список отказов КХЛ на 48 часов.`),
                              });
                            }}
                          >
                            {onW ? 'На отказах' : exempt ? 'В ВХЛ' : 'На отказы'}
                          </Button>
                        </div>
                      );
                    })}
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="rounded-md border border-line bg-bg/50 p-3 text-xs flex items-center justify-between">
                <div>
                  <div className="font-display uppercase tracking-wider text-gold font-semibold">Драфт отказов КХЛ (48 часов)</div>
                  <div className="text-muted mt-0.5">Любой клуб с местом под потолком может бесплатно забрать выставленного игрока.</div>
                </div>
                <Tag tone="warn">{activeWaivers.length} лотов</Tag>
              </div>
              {activeWaivers.length === 0 ? (
                <Empty text="На драфте отказов КХЛ сейчас никого нет." />
              ) : (
                <div className="space-y-2">
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
                              <OverallChip value={wp.overall} size="sm" />
                            </div>
                            <div className="text-[11px] text-muted">
                              Из {fromT?.short ?? 'КХЛ'} · {wp.age} л. · {formatMoney(wp.contract.salary)} ({wp.contract.years} г.) · до дня {w.expiresDay + 1}
                            </div>
                          </div>
                        </div>
                        {w.fromTeamId !== s.userTeamId ? (
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => {
                              const err = claimFromWaivers(wp.id);
                              setVhlNotice({ ok: !err, msg: err ?? `${wp.name} забран со списка отказов КХЛ!` });
                            }}
                          >
                            Забрать
                          </Button>
                        ) : (
                          <Tag>Ваш лот</Tag>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : tab === 'HOF' ? (
          <div className="space-y-3" data-hof-view>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-muted">
                Выведенные номера и легенды династии (ветераны 35+ лет с выдающейся статистикой, завершившие карьеру по итогам сезона).
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => setHofScope('club')}
                  className={cn('px-2.5 py-1 rounded-sm font-semibold cursor-pointer', hofScope === 'club' ? 'bg-gold text-bg' : 'bg-panel2 text-muted')}
                >
                  Клуб {team.short}
                </button>
                <button
                  onClick={() => setHofScope('league')}
                  className={cn('px-2.5 py-1 rounded-sm font-semibold cursor-pointer', hofScope === 'league' ? 'bg-gold text-bg' : 'bg-panel2 text-muted')}
                >
                  Вся КХЛ ({(s.hallOfFame ?? []).length})
                </button>
              </div>
            </div>
            {hofList.length === 0 ? (
              <Empty text="Зал славы пока пуст — первые легенды появятся после завершения карьеры заслуженных ветеранов в межсезонье." />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {hofList.map((e, i) => {
                  const ht = e.teamId ? s.teams[e.teamId] : null;
                  return (
                    <div key={`${e.id}_${i}`} className="rounded-md border border-gold/40 bg-panel2/70 p-3 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => e.teamId === s.userTeamId && toggleHallOfFameJersey(e.id)}
                        title={e.teamId === s.userTeamId ? 'Нажмите, чтобы вывести или вернуть номер из обращения' : undefined}
                        className={cn(
                          'w-12 h-14 rounded-sm border bg-bg flex flex-col items-center justify-center shrink-0',
                          e.jerseyRetired ? 'border-gold shadow-sm' : 'border-line',
                          e.teamId === s.userTeamId && 'cursor-pointer hover:border-gold'
                        )}
                      >
                        <span className="text-[9px] text-muted uppercase">{ht?.short ?? e.teamName}</span>
                        <span className={cn('font-display text-xl font-bold leading-none', e.jerseyRetired ? 'text-gold' : 'text-ice')}>
                          #{e.number}
                        </span>
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <PosBadge pos={e.position} />
                          <span className="font-display text-base font-bold truncate">{e.name}</span>
                        </div>
                        <div className="text-[11px] text-muted">
                          Пик OVR {e.peakOverall} · Ушёл в {e.age} л. · Сезон {e.retiredSeason}
                        </div>
                        <div className="text-xs text-ice tabular mt-0.5">
                          {e.position === 'G'
                            ? `${e.gp} И · ${e.wins} побед (${e.shutouts} СО)`
                            : `${e.gp} И · ${e.goals} Ш + ${e.assists} П = ${e.goals + e.assists} О`}
                        </div>
                        <div className="text-[11px] text-gold truncate">
                          {e.jerseyRetired ? '★ Номер выведен из обращения' : 'Член Зала славы'}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : tab === 'U23' && isOwnTeam ? (
          <div className="space-y-3" data-youth-plans>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line/70 bg-bg/50 p-3 text-xs">
              <div className="text-muted max-w-3xl">
                Игроки до <b className="text-ice">23 лет</b> включительно каждую неделю регулярного сезона набирают опыт по выбранному плану и получают профильную прибавку в межсезонье. Практика в топ-звеньях ускоряет рост (<b className="text-good">×1.45</b>), в запасе — замедляет (<b className="text-gold">×0.65</b>). План <b className="text-gold">«Интенсив»</b> даёт +40% к скорости и шанс пробить потолок потенциала, но требует места в составе.
              </div>
              <Button size="sm" variant="secondary" onClick={() => autoAssignYouthPlans()}>
                Автоподбор планов U23
              </Button>
            </div>

            {youthList.length === 0 ? (
              <Empty text="В составе нет молодых игроков до 23 лет" />
            ) : (
              <div className="space-y-2.5">
                {youthList.map((p) => {
                  const curPlan = getPlayerPlan(p);
                  const options = plansForPlayer(p);
                  const role = playerIceRole(team.lineup, p.id);
                  const xp = Math.min(100, Math.round(p.trainingXp ?? 0));
                  const growthEntries = Object.entries(p.seasonGrowth ?? {});
                  return (
                    <div key={p.id} className="rounded-lg border border-line/80 bg-bg/40 p-3 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <PosBadge pos={p.position} />
                          <button type="button" onClick={() => ui.openPlayer(p.id)} className="font-semibold text-sm hover:text-accent cursor-pointer truncate">
                            {p.name}
                          </button>
                          <span className="text-xs text-muted">{p.age} л.</span>
                          <OverallChip value={p.overall} size="sm" />
                          <span className="text-xs text-ice font-display">→ ПОТ {p.potential}</span>
                          <Tag tone={role === 'top' ? 'good' : role === 'depth' ? 'accent' : 'warn'}>
                            {role === 'top' ? 'Топ-звенья ×1.45' : role === 'depth' ? 'Основа ×1.15' : 'Вне основы ×0.65'}
                          </Tag>
                          {growthEntries.length > 0 && (
                            <span className="text-[11px] text-good font-medium">
                              Рост за сезон: {growthEntries.map(([k, v]) => `+${v} ${SKILL_LABELS[k] ?? k}`).join(', ')}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 w-48">
                          <span className="text-[11px] text-muted shrink-0">Опыт:</span>
                          <Bar value={xp} color="#38BDF8" className="flex-1" height={6} />
                          <span className="text-[11px] tabular-nums text-ice w-8 text-right">{xp}%</span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {options.map((pl) => {
                          const active = curPlan.id === pl.id;
                          return (
                            <button
                              key={pl.id}
                              type="button"
                              onClick={() => setTrainingPlan(p.id, pl.id)}
                              title={pl.description}
                              className={cn(
                                'px-2.5 py-1 rounded text-xs font-medium border transition cursor-pointer',
                                active
                                  ? pl.id === 'intensive'
                                    ? 'bg-gold/25 border-gold text-gold font-bold'
                                    : 'bg-accent/20 border-accent text-accent font-bold'
                                  : 'bg-panel2/60 border-line text-muted hover:text-ice'
                              )}
                            >
                              {pl.label}
                            </button>
                          );
                        })}
                      </div>
                      <div className="text-[11px] text-muted">{curPlan.description}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
        <>
          {/* Mobile Sort Bar + Zero-Horizontal-Scroll Player Cards */}
          <div className="md:hidden">
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar px-3 py-2 border-b border-line/70 bg-panel2/30 text-[11px]">
              <span className="text-muted shrink-0 mr-1">Сорт.:</span>
              {(
                tab === 'G'
                  ? ([
                      ['overall', 'ОВР'],
                      ['sv', '%ОБ'],
                      ['wins', 'Победы'],
                      ['salary', 'Оклад'],
                      ['age', 'Возраст'],
                    ] as [SortKey, string][])
                  : ([
                      ['overall', 'ОВР'],
                      ['points', 'Очки'],
                      ['goals', 'Шайбы'],
                      ['salary', 'Оклад'],
                      ['age', 'Возраст'],
                      ['potential', 'Пот'],
                    ] as [SortKey, string][])
              ).map(([k, lbl]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setSort({ k, d: sort.k === k ? -sort.d : -1 })}
                  className={cn(
                    'px-2 py-1 rounded-sm font-semibold shrink-0 transition-colors',
                    sort.k === k ? 'bg-ice text-bg' : 'bg-panel2 text-muted'
                  )}
                >
                  {lbl}
                  {sort.k === k && <span className="ml-0.5">{sort.d > 0 ? '▲' : '▼'}</span>}
                </button>
              ))}
            </div>
            <div className="divide-y divide-line/70">
              {list.map((p) => {
                const sv = p.stats.shotsAgainst ? (p.stats.saves / p.stats.shotsAgainst) * 100 : 0;
                const leg = isLegionnaire(p);
                const susp = suspendedSet.has(p.id);
                const capRole = playerCaptainRole(team, p.id);
                const arch = getArchetype(p);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => ui.openPlayer(p.id)}
                    className={cn(
                      'w-full text-left px-3 py-2.5 hover:bg-panel2 active:bg-panel2/80 transition-colors space-y-1.5',
                      susp && 'bg-red/5',
                      p.inVhl && 'opacity-75'
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-display text-xs text-muted w-5 tabular shrink-0">#{p.number}</span>
                        <PosBadge pos={p.position} />
                        <span className="font-semibold text-sm truncate">{p.name}</span>
                        {capRole && (
                          <span className={cn('text-[9px] font-bold px-1 rounded shrink-0', capRole === 'C' ? 'bg-gold/25 text-gold' : 'bg-ice/20 text-ice')}>
                            {capRole === 'C' ? 'К' : 'А'}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {p.age <= 25 && p.potential > p.overall && (
                          <span className="text-[10px] font-display text-ice tabular">→{p.potential}</span>
                        )}
                        <OverallChip value={p.overall} size="sm" />
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2 text-xs tabular text-muted flex-wrap">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span>{p.age} л. · {countryCode(p.country)}</span>
                        {!isGoalie(p) && (
                          <span className="text-[10px] px-1 rounded bg-panel2" style={{ color: arch.color }}>
                            {arch.short}
                          </span>
                        )}
                        {p.inVhl && <span className="text-[9px] font-bold px-1 rounded bg-ice/20 text-ice">ВХЛ</span>}
                        {hasTwoWayContract(p) && <span className="text-[9px] font-bold px-1 rounded bg-ok/20 text-ok">2-СТОР</span>}
                        {p.inLtir && <span className="text-[9px] font-bold px-1 rounded bg-ice/25 text-ice">ДСБТ</span>}
                        {p.nmc && <span className="text-[9px] font-bold px-1 rounded bg-gold/20 text-gold">ЗНО</span>}
                        {leg && <span className="text-[9px] font-bold px-1 rounded bg-gold/20 text-gold">ЛЕГ</span>}
                        {isU20Limiter(p) && <span className="text-[9px] font-bold px-1 rounded bg-ok/20 text-ok">U20</span>}
                        {p.injury && (
                          <span className="text-[10px] font-semibold text-accent">
                            🏥 {formatInjuryDays(p.injury.days, true)}
                          </span>
                        )}
                      </div>
                      <div className="text-text/90">
                        {tab === 'G' ? (
                          <span>
                            {p.stats.gp}И · {p.stats.wins}В · <b className="text-ice">{sv ? `${sv.toFixed(1)}%` : '—'}</b>
                          </span>
                        ) : (
                          <span>
                            {p.stats.gp}И · {p.stats.goals}+{p.stats.assists}=<b className="text-ice">{p.stats.goals + p.stats.assists}</b> ({p.stats.plusMinus > 0 ? `+${p.stats.plusMinus}` : p.stats.plusMinus})
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-muted tabular">
                      <span>
                        {formatMoney(p.contract.salary)} ·{' '}
                        {p.contract.years === 0 ? <span className="text-amber">истекает</span> : `${p.contract.years} г.`}
                      </span>
                      <span>
                        {susp
                          ? <span className="text-red font-semibold">блок потолка</span>
                          : isGoalie(p)
                            ? <span style={{ color: freshnessTone(goalieFreshness(p)).color }}>свеж. {goalieFreshness(p)}%</span>
                            : p.morale >= 80
                              ? <span className="text-ok">в тонусе</span>
                              : p.morale < 50
                                ? <span className="text-amber">мораль ↓</span>
                                : 'готов'}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm tabular">
            <thead className="bg-panel2/40">
              <tr>
                <Th k="number" className="pl-4">№</Th>
                <Th k="name">Игрок</Th>
                {tab !== 'G' && <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wider font-semibold text-muted">Поз</th>}
                <Th k="age">Возр</Th>
                <Th k="overall">ОВР</Th>
                <Th k="potential">Пот</Th>
                <Th k="salary">Зарплата</Th>
                <Th k="years">Контракт</Th>
                <Th k="gp">И</Th>
                {tab === 'G' ? (
                  <>
                    <Th k="wins">В</Th>
                    <Th k="shutouts">СО</Th>
                    <Th k="sv">%ОБ</Th>
                    <Th k="gaa">КН</Th>
                  </>
                ) : (
                  <>
                    <Th k="goals">Ш</Th>
                    <Th k="assists">П</Th>
                    <Th k="points">О</Th>
                    <Th k="plusMinus">+/−</Th>
                    <Th k="pim">Штр</Th>
                  </>
                )}
                <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wider font-semibold text-muted pr-4">Статус</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => {
                const sv = p.stats.shotsAgainst ? (p.stats.saves / p.stats.shotsAgainst) * 100 : 0;
                const leg = isLegionnaire(p);
                const susp = suspendedSet.has(p.id);
                const capRole = playerCaptainRole(team, p.id);
                const arch = getArchetype(p);
                return (
                  <tr key={p.id} onClick={() => ui.openPlayer(p.id)} className={cn('border-t border-line/70 hover:bg-panel2 cursor-pointer transition-colors', susp && 'bg-red/5', p.inVhl && 'opacity-70')}>
                    <td className="pl-4 px-2 py-1.5 text-muted">{p.number}</td>
                    <td className="px-2 py-1.5 font-medium whitespace-nowrap">
                      {p.name}
                      {capRole && (
                        <span className={cn('ml-1 text-[9px] font-bold px-1 rounded', capRole === 'C' ? 'bg-gold/25 text-gold' : 'bg-ice/20 text-ice')}>
                          {capRole === 'C' ? 'К' : 'А'}
                        </span>
                      )}
                      {!isGoalie(p) && (
                        <span className="ml-1 text-[9px] px-1 rounded bg-panel2" style={{ color: arch.color }} title={arch.label}>
                          {arch.short}
                        </span>
                      )}
                      <span className="ml-1.5 text-[10px] text-muted">{countryCode(p.country)}</span>
                      {p.inVhl && <span className="ml-1 text-[9px] font-bold px-1 rounded bg-ice/20 text-ice">ВХЛ</span>}
                      {hasTwoWayContract(p) && (
                        <span className="ml-1 text-[9px] font-bold px-1 rounded bg-ok/20 text-ok" title="Двусторонний контракт КХЛ/ВХЛ (перевод в ВХЛ без отказов)">
                          2-СТОР
                        </span>
                      )}
                      {p.inLtir && <span className="ml-1 text-[9px] font-bold px-1 rounded bg-ice/25 text-ice" title="Долгосрочный список травмированных КХЛ">ДСБТ</span>}
                      {isPlayingHurt(p, s.phase) && <span className="ml-1 text-[9px] font-bold px-1 rounded bg-gold/25 text-gold" title="Играет на уколах в плей-офф">УКОЛЫ</span>}
                      {allStarSet.has(p.id) && <span className="ml-1 text-[9px] font-bold px-1 rounded bg-gold/20 text-gold" title="Участник Матча Звёзд КХЛ">★ МЗ</span>}
                      {p.nmc && <span className="ml-1 text-[9px] font-bold px-1 rounded bg-gold/20 text-gold" title="Запрет на обмен (ЗНО)">ЗНО</span>}
                      {isU20Limiter(p) && <span className="ml-1 text-[9px] font-bold px-1 rounded bg-ok/20 text-ok">U20</span>}
                      {leg && <span className="ml-1 text-[9px] font-bold px-1 rounded bg-gold/20 text-gold">ЛЕГ</span>}
                      {isYouthPlayer(p) && isOwnTeam && (
                        <span className="ml-1 text-[9px] px-1 rounded bg-accent/15 text-accent">{getPlayerPlan(p).short}</span>
                      )}
                      {susp && <span className="ml-1 text-[9px] font-bold px-1 rounded bg-red/25 text-red">БЛОК ФОТ</span>}
                      {p.injury && <span className="ml-1.5 text-[10px] text-accent uppercase">травма</span>}
                    </td>
                    {tab !== 'G' && (
                      <td className="px-2 py-1.5">
                        <PosBadge pos={p.position} />
                      </td>
                    )}
                    <td className="px-2 py-1.5 text-muted">{p.age}</td>
                    <td className="px-2 py-1.5">
                      <OverallChip value={p.overall} size="sm" />
                    </td>
                    <td className={cn('px-2 py-1.5', p.potential > p.overall ? 'text-ice' : 'text-muted')}>{p.age <= 25 ? p.potential : '—'}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{formatMoney(p.contract.salary)}</td>
                    <td className="px-2 py-1.5 text-muted">{p.contract.years === 0 ? <span className="text-amber">истекает</span> : `${p.contract.years} г.`}</td>
                    <td className="px-2 py-1.5 text-muted">{p.stats.gp}</td>
                    {tab === 'G' ? (
                      <>
                        <td className="px-2 py-1.5">{`${p.stats.wins}−${p.stats.losses}−${p.stats.otl}`}</td>
                        <td className="px-2 py-1.5">{p.stats.shutouts}</td>
                        <td className="px-2 py-1.5">{sv ? sv.toFixed(1) : '—'}</td>
                        <td className="px-2 py-1.5">{p.stats.minutes ? gaa(p).toFixed(2) : '—'}</td>
                      </>
                    ) : (
                      <>
                        <td className="px-2 py-1.5">{p.stats.goals}</td>
                        <td className="px-2 py-1.5">{p.stats.assists}</td>
                        <td className="px-2 py-1.5 font-semibold">{p.stats.goals + p.stats.assists}</td>
                        <td className={cn('px-2 py-1.5', p.stats.plusMinus >= 0 ? 'text-ok' : 'text-accent')}>{p.stats.plusMinus > 0 ? '+' : ''}{p.stats.plusMinus}</td>
                        <td className="px-2 py-1.5 text-muted">{p.stats.pim}</td>
                      </>
                    )}
                    <td className="px-2 py-1.5 pr-4 text-xs text-muted">
                      {susp ? (
                        <span className="text-red font-semibold">блок потолка</span>
                      ) : p.inVhl ? (
                        <span className="text-ice">в ВХЛ</span>
                      ) : p.inLtir && !p.injury ? (
                        <span className="text-ok font-semibold">здоров (в ДСБТ)</span>
                      ) : p.injury ? (
                        <span className="tabular" title={`Ориентировочное возвращение: ${injuryReturnDate(s.day, p.injury.days, regLen, s.league.season)}`}>
                          {formatInjuryDays(p.injury.days, true)} (до {injuryReturnDate(s.day, p.injury.days, regLen, s.league.season)})
                        </span>
                      ) : isGoalie(p) ? (
                        <span style={{ color: freshnessTone(goalieFreshness(p)).color }}>свеж. {goalieFreshness(p)}%</span>
                      ) : p.morale >= 80 ? (
                        'в тонусе'
                      ) : p.morale < 50 ? (
                        'мораль низкая'
                      ) : (
                        'готов'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </>
        )}
      </Panel>
    </div>
  );
}

export function PlayerModal({ id, onClose }: { id: string; onClose: () => void }) {
  const s = useGame()!;
  const ui = useUI();
  const p = s.players[id];
  const [modalNotice, setModalNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!p) onClose();
  }, [p, onClose]);
  if (!p) return null;
  const team = p.teamId ? s.teams[p.teamId] : null;
  const isUser = p.teamId === s.userTeamId;
  const st = p.stats;
  const isG = isGoalie(p);
  const sv = st.shotsAgainst ? (st.saves / st.shotsAgainst) * 100 : 0;
  const demand = salaryDemand(p.overall, p.age, p.potential);
  const arch = getArchetype(p);
  const faTag = playerStatusTag(p);
  const capRole = team ? playerCaptainRole(team, p.id) : null;
  return (
    <Modal open onClose={onClose} width="max-w-3xl">
      <div className="flex items-start gap-4 flex-wrap">
        {team && <TeamLogo team={team} size={56} />}
        <div className="flex-1 min-w-[200px]">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="font-display text-2xl uppercase leading-none m-0">{p.name}</h2>
            <PosBadge pos={p.position} />
            <span className="text-xs px-1.5 py-0.5 rounded bg-panel2 font-semibold" style={{ color: arch.color }}>
              {arch.label}
            </span>
            {capRole && <Tag color="#F2B544">{capRole === 'C' ? 'Капитан (К)' : 'Ассистент (А)'}</Tag>}
            <span className="text-xs text-muted">№{p.number}</span>
          </div>
          <div className="text-xs text-muted mt-1">{POS_NAME[p.position]} · {p.age} лет ({faTag === 'ОСА' ? 'ОСА <28' : 'НСА 28+'}) · {p.height} см · {p.weight} кг · {p.country || '—'} · хват {p.hand === 'L' ? 'левый' : 'правый'}</div>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {team && <span className="text-sm">{team.name}</span>}
            {p.inVhl && <Tag tone="accent">Фарм-клуб ВХЛ</Tag>}
            {hasTwoWayContract(p) ? <Tag tone="good">Двусторонний КХЛ/ВХЛ</Tag> : p.teamId ? <Tag>Односторонний КХЛ</Tag> : null}
            {p.inLtir && <Tag tone="accent">ДСБТ КХЛ (вне потолка)</Tag>}
            {isPlayingHurt(p, s.phase) && <Tag tone="warn">На уколах (−3 навык)</Tag>}
            {p.nmc && <Tag tone="warn">ЗНО (запрет на обмен)</Tag>}
            {p.rightsTeamId && !p.teamId && <Tag tone="warn">Права ОСА: {s.teams[p.rightsTeamId]?.short ?? 'КХЛ'}</Tag>}
            {isLegionnaire(p) ? <Tag tone="warn">Легионер ({p.country})</Tag> : <Tag tone="good">Не легионер · ЕАЭС</Tag>}
            {p.injury && (
              <Tag color="#E5323E">
                Травма: {p.injury.name} · {formatInjuryDays(p.injury.days)} (до {injuryReturnDate(s.day, p.injury.days, regularSeasonLength(s.schedule), s.league.season)})
              </Tag>
            )}
            {!p.teamId && <Tag color="#F2B544">Свободный агент</Tag>}
            {p.contract.years === 0 && p.teamId && <Tag color="#F2B544">Контракт истекает</Tag>}
          </div>
        </div>
        <div className="flex gap-2">
          <div className="text-center">
            <OverallChip value={p.overall} size="lg" />
            <div className="text-[10px] uppercase tracking-wider text-muted mt-1">Рейтинг</div>
          </div>
          {p.age <= 25 && (
            <div className="text-center">
              <div className="font-display text-2xl tabular w-14 h-10 leading-10 rounded-sm border border-ice/40 text-ice bg-ice/10">{p.potential}</div>
              <div className="text-[10px] uppercase tracking-wider text-muted mt-1">Потенциал</div>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-5">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted mb-2">Навыки</div>
          <div className="space-y-1.5">
            {skillList(p).map((sk) => (
              <div key={sk.key} className="flex items-center gap-3 text-xs">
                <span className="w-36 text-text/85 truncate">{sk.label}</span>
                <Bar value={sk.value} className="flex-1" height={7} />
                <span className="w-6 text-right tabular text-muted">{sk.value}</span>
              </div>
            ))}
          </div>
          <div className="text-[11px] uppercase tracking-wider text-muted mt-4 mb-1">Мораль</div>
          <div className="flex items-center gap-3 text-xs">
            <Bar value={p.morale} color={p.morale >= 70 ? '#3FCF8E' : p.morale >= 50 ? '#F2B544' : '#E5323E'} className="flex-1" />
            <span className="tabular text-muted">{p.morale}</span>
          </div>

          {isG && (
            <>
              <div className="text-[11px] uppercase tracking-wider text-muted mt-3 mb-1">
                Свежесть вратаря ({freshnessTone(goalieFreshness(p)).label})
              </div>
              <div className="flex items-center gap-3 text-xs">
                <Bar value={goalieFreshness(p)} color={freshnessTone(goalieFreshness(p)).color} className="flex-1" />
                <span className="tabular font-semibold" style={{ color: freshnessTone(goalieFreshness(p)).color }}>
                  {goalieFreshness(p)}%
                </span>
              </div>
            </>
          )}

          {isUser && !isG && (
            <div className="mt-3 rounded-sm border border-line bg-panel2/60 p-2.5 flex items-center justify-between gap-2 flex-wrap text-xs">
              <span className="text-muted">Нашивка лидера раздевалки:</span>
              <div className="flex gap-1">
                {([
                  ['C', 'Капитан (К)'],
                  ['A', 'Ассистент (А)'],
                  [null, 'Нет'],
                ] as const).map(([role, lbl]) => (
                  <button
                    key={String(role)}
                    type="button"
                    onClick={() => setTeamRole(p.id, role)}
                    className={cn(
                      'px-2 py-0.5 rounded border font-semibold cursor-pointer transition',
                      capRole === role ? 'bg-gold/25 border-gold text-gold' : 'bg-panel border-line text-muted hover:text-text'
                    )}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>
          )}

          {isUser && isYouthPlayer(p) && (
            <div className="mt-4 rounded-sm border border-accent/35 bg-accent/5 p-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-display uppercase tracking-wider text-accent font-semibold">План развития молодёжи (U23)</span>
                <span className="text-muted tabular-nums">Опыт недели: {Math.round(p.trainingXp ?? 0)}%</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {plansForPlayer(p).map((pl) => {
                  const active = getPlayerPlan(p).id === pl.id;
                  return (
                    <button
                      key={pl.id}
                      type="button"
                      onClick={() => setTrainingPlan(p.id, pl.id)}
                      className={cn(
                        'px-2 py-0.5 rounded text-[11px] border cursor-pointer transition',
                        active ? 'bg-accent text-white border-accent font-bold' : 'bg-panel border-line text-muted hover:text-ice'
                      )}
                    >
                      {pl.short}
                    </button>
                  );
                })}
              </div>
              <div className="text-[11px] text-muted">{getPlayerPlan(p).description}</div>
            </div>
          )}
        </div>
        <div className="space-y-3">
          <div className="bg-panel2/70 border border-line/70 rounded-sm p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">Контракт</span>
              <span className="tabular">{p.teamId ? `${formatMoney(p.contract.salary)} · ${p.contract.years === 0 ? 'истёк' : p.contract.years === 1 ? 'последний год' : 'ещё ' + p.contract.years + ' г.'}${p.contract.next ? ` → ${formatMoney(p.contract.next.salary)} × ${p.contract.next.years} г.` : ''}` : 'свободный агент'}</span>
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-muted">Рыночная цена</span>
              <span className="tabular text-ice">{formatMoney(demand)} / сезон</span>
            </div>
          </div>
          <div className="bg-panel2/70 border border-line/70 rounded-sm p-3">
            <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Статистика сезона</div>
            {isG ? (
              <div className="grid grid-cols-4 gap-1 text-center text-sm">
                {[
                  ['И', st.gp],
                  ['В−П−ПО', `${st.wins}−${st.losses}−${st.otl}`],
                  ['СО', st.shutouts],
                  ['%ОБ', sv ? sv.toFixed(1) : '—'],
                  ['КН', st.minutes ? gaa(p).toFixed(2) : '—'],
                  ['Сейвы', st.saves],
                  ['Броски', st.shotsAgainst],
                  ['Мин', st.minutes],
                ].map(([k, v]) => (
                  <div key={String(k)} className="bg-panel rounded-sm py-1">
                    <div className="text-[10px] text-muted uppercase">{k}</div>
                    <div className="font-display tabular">{v}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-4 gap-1 text-center text-sm">
                {[
                  ['И', st.gp],
                  ['Ш', st.goals],
                  ['П', st.assists],
                  ['О', st.goals + st.assists],
                  ['+/−', st.plusMinus],
                  ['Броски', st.shots],
                  ['Штр', st.pim],
                  ['%Бр', st.shots ? Math.round((st.goals / st.shots) * 100) + '%' : '—'],
                ].map(([k, v]) => (
                  <div key={String(k)} className="bg-panel rounded-sm py-1">
                    <div className="text-[10px] text-muted uppercase">{k}</div>
                    <div className="font-display tabular">{v}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
          {p.history.length > 0 && (
            <div className="bg-panel2/70 border border-line/70 rounded-sm p-3 text-xs">
              <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Прошлые сезоны</div>
              <table className="w-full tabular">
                <thead className="text-muted">
                  <tr>
                    <th className="text-left font-semibold">Сезон</th>
                    <th className="text-left font-semibold">ОВР</th>
                    <th className="text-right font-semibold">И</th>
                    <th className="text-right font-semibold">Ш</th>
                    <th className="text-right font-semibold">П</th>
                    <th className="text-right font-semibold">{isG ? 'В' : 'О'}</th>
                  </tr>
                </thead>
                <tbody>
                  {p.history.slice(-4).map((h) => (
                    <tr key={h.season} className="border-t border-line/50">
                      <td>{h.season}</td>
                      <td>{h.overall}</td>
                      <td className="text-right">{h.gp}</td>
                      <td className="text-right">{h.goals}</td>
                      <td className="text-right">{h.assists}</td>
                      <td className="text-right font-semibold">{isG ? h.wins : h.goals + h.assists}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {modalNotice && (
        <div className="mt-3 rounded-sm border border-ice/40 bg-ice/10 px-3 py-1.5 text-xs text-ice">{modalNotice}</div>
      )}
      <div className="grid grid-cols-1 sm:flex sm:flex-wrap gap-2 mt-5 pt-4 border-t border-line sm:justify-end">
        {isUser && canPlaceInLtir(p) && s.phase !== 'offseason' && (
          <Button
            variant="ice"
            onClick={() => {
              const err = placePlayerInLtir(p.id);
              setModalNotice(err ?? `${p.name} переведён в ДСБТ КХЛ — зарплата ${formatMoney(p.contract.salary)} выведена из-под потолка.`);
            }}
            title={`Травма от ${LTIR_MIN_DAYS} дней позволяет временно вывести 100% оклада из-под потолка зарплат КХЛ`}
          >
            🏥 В ДСБТ (разгрузить потолок)
          </Button>
        )}
        {isUser && p.inLtir && !p.injury && (
          <Button
            variant="primary"
            onClick={() => {
              const err = activatePlayerFromLtir(p.id);
              setModalNotice(err ?? `${p.name} выведен из ДСБТ и готов играть.`);
            }}
          >
            ✓ Вывести из ДСБТ
          </Button>
        )}
        {isUser && (canPlayThroughInjury(p, s.phase) || p.playingThroughInjury) && (
          <Button
            variant={p.playingThroughInjury ? 'danger' : 'secondary'}
            onClick={() => {
              const err = togglePlayThroughInjury(p.id);
              setModalNotice(
                err ??
                  (p.playingThroughInjury
                    ? `${p.name} снят с игры «на уколах» и вернётся к лечению.`
                    : `${p.name} допущен к матчам плей-офф «на уколах» (−3 к навыкам, риск рецидива).`)
              );
            }}
          >
            {p.playingThroughInjury ? 'Отменить выход «на уколах»' : '💉 Выпустить на уколах (плей-офф)'}
          </Button>
        )}
        {isUser && (
          p.inVhl ? (
            <Button
              variant="secondary"
              onClick={() => {
                const err = recallFromVhl(p.id);
                setModalNotice(err ?? `${p.name} вызван из ВХЛ в основной состав.`);
              }}
            >
              ↑ Вызвать из ВХЛ
            </Button>
          ) : (
            <Button
              variant="secondary"
              disabled={!!p.nmc}
              onClick={() => {
                const err = sendToVhlOrWaivers(p.id);
                setModalNotice(err ?? (isWaiverExempt(p) ? `${p.name} отправлен в ВХЛ.` : `${p.name} помещён в список отказов КХЛ (48ч).`));
              }}
              title={p.nmc ? 'Пункт ЗНО запрещает перевод в ВХЛ / на отказы' : undefined}
            >
              ↓ {isWaiverExempt(p) ? 'В фарм ВХЛ (2-стор., без отказов)' : 'На отказы (48ч) / ВХЛ'}
            </Button>
          )
        )}
        {p.teamId && (
          <Button
            onClick={() => {
              onClose();
              ui.tradeWith(p.id);
            }}
          >
            ⇄ {isUser ? 'Предложить в обмене' : 'Запросить в обмене'}
          </Button>
        )}
        {isUser && (
          <>
            <Button variant={p.tradeFlag === 'block' ? 'ice' : 'secondary'} onClick={() => setTradeFlag(p.id, p.tradeFlag === 'block' ? null : 'block')} title="Клубы лиги чаще присылают предложения по игрокам, выставленным на обмен">
              {p.tradeFlag === 'block' ? '✓ Выставлен на обмен' : 'Выставить на обмен'}
            </Button>
            <Button variant={p.tradeFlag === 'keep' ? 'ice' : 'secondary'} onClick={() => setTradeFlag(p.id, p.tradeFlag === 'keep' ? null : 'keep')} title="Клубы не будут просить этого игрока в обменах">
              {p.tradeFlag === 'keep' ? '✓ Неприкосновенный' : 'Неприкосновенный'}
            </Button>
          </>
        )}
        {(!p.teamId || (isUser && p.contract.years <= 1 && !p.contract.next)) && (
          <Button
            variant="primary"
            onClick={() => {
              onClose();
              ui.negotiate(p.id);
            }}
          >
            {!p.teamId ? 'Переговоры о контракте' : p.contract.years === 0 ? 'Новый контракт' : 'Продлить контракт'}
          </Button>
        )}
        {isUser && p.contract.years > 0 && (
          <Button
            variant="danger"
            onClick={() => {
              const cost = buyoutCost(s, p);
              const dead = s.phase !== 'offseason' ? buyoutDeadCap(p.contract.salary) : 0;
              ui.confirm({
                title: 'Расторгнуть контракт?',
                text: `${p.name} покинет команду и станет свободным агентом. ${cost > 0 ? `Клуб выплатит компенсацию ${formatMoney(cost)} из бюджета.` : ''} ${dead > 0 ? `Внимание: ${formatMoney(dead)} (20% оклада) останется в «мёртвых деньгах» под потолком зарплат до конца сезона!` : `ФОТ уменьшится на ${formatMoney(p.contract.salary)}.`}`,
                danger: true,
                confirmLabel: cost > 0 ? `Расторгнуть за ${formatMoney(cost)}` : 'Расторгнуть',
                onYes: () => {
                  const err = releasePlayer(p.id);
                  if (err) ui.confirm({ title: 'Контракт не расторгнут', text: err, confirmLabel: 'Понятно', onYes: () => {} });
                  else onClose();
                },
              });
            }}
          >
            Расторгнуть контракт
          </Button>
        )}
      </div>
    </Modal>
  );
}

export function RosterEmpty({ text }: { text: string }) {
  return (
    <Panel>
      <Empty text={text} />
    </Panel>
  );
}
