import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Coach, Game, Player, Team } from '../types';
import { COACH_PROFILES } from '../game/coachData';
import { clubLeaders, clubProfile } from '../game/teamInfo';
import { formatMoney, isDefense, isForward, isGoalie } from '../game/ratings';
import { rankConference, useGame } from '../game/state';
import { regularSeasonLength, seasonDateOnly } from '../game/schedule';
import { tradeWindow } from '../game/ai';
import { Bar, Button, Modal, OverallChip, PlayerFace, PosBadge, Tag, TeamLogo, useUI } from './ui';
import { ScoutOvr } from './Scout';
import { cn } from '../utils/cn';

const FACILITY_LABEL: [keyof NonNullable<Team['facilities']>, string][] = [
  ['arena', 'Арена'],
  ['medical', 'Медцентр'],
  ['academy', 'Академия'],
  ['scouting', 'Скаутинг'],
];

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="text-[11px] uppercase tracking-wider text-muted">{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

function CoachRow({ c }: { c: Coach }) {
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <PlayerFace face={c.face} name={c.name} size={34} />
      <div className="min-w-0 flex-1">
        <div className="text-sm truncate">{c.name}</div>
        <div className="text-[11px] text-muted truncate">
          {c.role === 'head' ? (c.acting ? 'И.о. главного тренера' : 'Главный тренер') : 'Ассистент'} · {c.label ?? COACH_PROFILES[c.profile]?.label ?? c.profile}
        </div>
      </div>
    </div>
  );
}

/**
 * Club overview shared by the club selection screen and the in-game club card: staff, strength by unit,
 * squad facts and the best players. `chip` renders a player's rating (exact or as the scouts see it).
 */
export function ClubOverview({
  team,
  P,
  teams,
  chip,
  onPlayer,
  salaryCap,
}: {
  team: Team;
  P: Record<string, Player>;
  teams: Team[];
  chip: (p: Player) => ReactNode;
  onPlayer?: (id: string) => void;
  salaryCap?: number;
}) {
  const pr = useMemo(() => clubProfile(P, team, teams), [P, team, teams]);
  const coaches = [...(team.coaches ?? [])].sort((a, b) => Number(b.role === 'head') - Number(a.role === 'head'));
  const captain = team.captainId ? P[team.captainId] : null;
  const unit = (label: string, v: number) => (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-16 text-muted">{label}</span>
      <Bar value={Math.max(0, (v - 55) * 2.5)} className="flex-1" height={7} color={v >= 80 ? '#E5323E' : v >= 76 ? '#8FD8F0' : '#93A4BC'} />
      <span className="w-7 text-right tabular">{v || '—'}</span>
    </div>
  );
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-club-overview={team.id}>
      <div className="space-y-4 min-w-0">
        <Section title={`Сила состава · №${pr.rank} в лиге`}>
          <div className="space-y-1.5">
            {unit('Атака', pr.attack)}
            {unit('Оборона', pr.defense)}
            {unit('Вратарь', pr.goalie)}
          </div>
        </Section>
        <Section title="Тренерский штаб">
          <div className="space-y-2">
            {coaches.length ? coaches.map((c) => <CoachRow key={c.id} c={c} />) : <div className="text-xs text-muted">Вакансия</div>}
          </div>
        </Section>
        <Section title="Клуб">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <span className="text-muted">Игроков</span>
            <span className="tabular text-right">
              {pr.khl}
              {pr.vhl ? <span className="text-muted"> + {pr.vhl} ВХЛ</span> : null}
            </span>
            <span className="text-muted">Средний возраст</span>
            <span className="tabular text-right">{pr.avgAge}</span>
            <span className="text-muted">Молодёжь U23</span>
            <span className="tabular text-right">{pr.u23}</span>
            <span className="text-muted">Легионеры</span>
            <span className="tabular text-right">{pr.legionnaires}</span>
            <span className="text-muted">ФОТ</span>
            <span className={cn('tabular text-right', salaryCap && pr.payroll > salaryCap && 'text-accent')}>
              {formatMoney(pr.payroll)}
              {salaryCap ? <span className="text-muted"> / {formatMoney(salaryCap)}</span> : null}
            </span>
            <span className="text-muted">Бюджет</span>
            <span className="tabular text-right">{formatMoney(team.budget)}</span>
            {captain && (
              <>
                <span className="text-muted">Капитан</span>
                <span className="text-right truncate">{captain.name}</span>
              </>
            )}
          </div>
          {team.facilities && (
            <div className="flex flex-wrap gap-1 mt-2">
              {FACILITY_LABEL.map(([k, l]) => (
                <span key={k} className="text-[10px] px-1.5 py-0.5 rounded-sm bg-panel2 border border-line text-muted">
                  {l} <b className="text-text tabular">{team.facilities![k]}</b>/5
                </span>
              ))}
            </div>
          )}
        </Section>
      </div>
      <Section title="Лучшие игроки">
        <div className="space-y-1.5">
          {pr.stars.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={!onPlayer}
              onClick={() => onPlayer?.(p.id)}
              className={cn('w-full flex items-center gap-2.5 rounded-sm px-1.5 py-1 text-left', onPlayer && 'hover:bg-panel2')}
            >
              <PlayerFace face={p.face} name={p.name} number={p.number} team={team} size={40} />
              <div className="min-w-0 flex-1">
                <div className="text-sm truncate">{p.name}</div>
                <div className="text-[11px] text-muted truncate">
                  №{p.number} · {p.age} л. · {p.country}
                </div>
              </div>
              <PosBadge pos={p.position} />
              {chip(p)}
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}

/** В / ВОТ / ВБ — wins, П — regulation loss, ПОТ / ПБ — loss beyond regulation (a point). */
const formColor = (r: string) => (r.startsWith('В') ? 'bg-ok/80' : r === 'П' ? 'bg-accent/80' : 'bg-amber/80');

/** In-game club card, opened by clicking a club anywhere in the game. */
export function TeamModal({ id, onClose }: { id: string; onClose: () => void }) {
  const s = useGame()!;
  const ui = useUI();
  const [tab, setTab] = useState<'overview' | 'roster'>('overview');
  const team = s.teams[id];
  const teams = useMemo(() => s.teamOrder.map((t) => s.teams[t]), [s.teamOrder, s.teams]);
  if (!team) return null;
  const P = s.players;
  const isUser = id === s.userTeamId;
  const r = team.record;
  const conf = rankConference(s, team.conference);
  const place = conf.findIndex((t) => t.id === id) + 1;
  const regLen = regularSeasonLength(s.schedule);
  const dateOf = (g: Game) => seasonDateOnly(g.day, regLen, s.league.season);
  const games = s.schedule.flat().filter((g) => g.home === id || g.away === id);
  const next = games.find((g) => !g.played && g.day >= s.day);
  const vsUser = isUser ? [] : games.filter((g) => g.home === s.userTeamId || g.away === s.userTeamId);
  const { scorers, goalies } = clubLeaders(P, team);
  const chip = (p: Player) => (isUser ? <OverallChip value={p.overall} size="sm" /> : <ScoutOvr p={p} />);
  const open = (pid: string) => ui.openPlayer(pid);
  const groups: [string, Player[]][] = [
    ['Нападающие', team.players.map((x) => P[x]).filter((p) => p && isForward(p))],
    ['Защитники', team.players.map((x) => P[x]).filter((p) => p && isDefense(p))],
    ['Вратари', team.players.map((x) => P[x]).filter((p) => p && isGoalie(p))],
  ];
  const opp = (g: Game) => s.teams[g.home === id ? g.away : g.home];
  return (
    <Modal open onClose={onClose} width="max-w-3xl">
      <div data-team-modal={id}>
        <div className="flex items-start gap-3 sm:gap-4 flex-wrap">
          <TeamLogo team={team} size={64} />
          <div className="flex-1 min-w-[180px]">
            <h2 className="font-display text-2xl uppercase leading-none m-0">{team.name}</h2>
            <div className="text-xs text-muted mt-1">
              {team.city} · конференция «{team.conference}»{team.division ? ` · дивизион ${team.division}` : ''}
            </div>
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              {isUser && <Tag tone="good">Ваш клуб</Tag>}
              <Tag>
                {place}-е место · {r.points} очк.
              </Tag>
              {r.gp > 0 && (
                <span className="flex gap-0.5 items-center" title="Последние матчи">
                  {r.last.slice(-5).map((x, i) => (
                    <span key={i} title={x} className={cn('w-2.5 h-2.5 rounded-[2px]', formColor(x))} />
                  ))}
                </span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-4 gap-1.5 text-center text-xs">
            {[
              ['И', r.gp],
              ['В', r.w + r.otw + r.sow],
              ['П', r.l + r.otl + r.sol],
              ['Ш', `${r.gf}:${r.ga}`],
            ].map(([l, v]) => (
              <div key={l} className="rounded-sm bg-panel2 border border-line px-2 py-1 min-w-[44px]">
                <div className="font-display text-base tabular leading-tight">{v}</div>
                <div className="text-[10px] text-muted">{l}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex gap-1 mt-4 border-b border-line">
          {(
            [
              ['overview', 'Обзор'],
              ['roster', `Состав (${team.players.length})`],
            ] as const
          ).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={cn('px-3 py-1.5 text-xs font-semibold border-b-2 -mb-px', tab === k ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text')}>
              {l}
            </button>
          ))}
        </div>

        {tab === 'overview' ? (
          <div className="space-y-4 mt-3">
            <ClubOverview team={team} P={P} teams={teams} chip={chip} onPlayer={open} salaryCap={s.league.salaryCap} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Section title="Лидеры сезона">
                {scorers.length === 0 ? (
                  <div className="text-xs text-muted">Сезон ещё не начался.</div>
                ) : (
                  <div className="space-y-1 text-xs">
                    {scorers.map((p) => (
                      <button key={p.id} type="button" onClick={() => open(p.id)} className="w-full flex items-center gap-2 hover:bg-panel2 rounded-sm px-1 py-0.5 text-left">
                        <PlayerFace face={p.face} name={p.name} number={p.number} team={team} size={24} />
                        <span className="flex-1 truncate">{p.name}</span>
                        <span className="tabular text-muted">
                          {p.stats.goals}+{p.stats.assists}
                        </span>
                        <b className="tabular w-6 text-right">{p.stats.goals + p.stats.assists}</b>
                      </button>
                    ))}
                    {goalies.map((p) => (
                      <button key={p.id} type="button" onClick={() => open(p.id)} className="w-full flex items-center gap-2 hover:bg-panel2 rounded-sm px-1 py-0.5 text-left">
                        <PlayerFace face={p.face} name={p.name} number={p.number} team={team} size={24} />
                        <span className="flex-1 truncate">{p.name}</span>
                        <span className="tabular text-muted">{p.stats.gp} и.</span>
                        <b className="tabular w-12 text-right">{((p.stats.saves / p.stats.shotsAgainst) * 100).toFixed(1)}%</b>
                      </button>
                    ))}
                  </div>
                )}
              </Section>
              <Section title={isUser ? 'Календарь' : 'Встречи с вашим клубом'}>
                <div className="space-y-1 text-xs">
                  {next && (
                    <div className="flex items-center gap-2">
                      <span className="text-muted w-24 shrink-0 whitespace-nowrap">След. матч</span>
                      <TeamLogo team={opp(next)} size={18} />
                      <span className="flex-1 truncate">
                        {next.home === id ? 'дома' : 'в гостях'} · {opp(next).short}
                      </span>
                      <span className="text-muted">{dateOf(next)}</span>
                    </div>
                  )}
                  {vsUser.map((g) => {
                    const res = g.result;
                    const userHome = g.home === s.userTeamId;
                    const us = res ? (userHome ? res.homeScore : res.awayScore) : 0;
                    const them = res ? (userHome ? res.awayScore : res.homeScore) : 0;
                    return (
                      <button key={g.id} type="button" disabled={!g.played} onClick={() => ui.openGame(g.id)} className="w-full flex items-center gap-2 text-left rounded-sm px-1 py-0.5 enabled:hover:bg-panel2">
                        <span className="text-muted w-24 shrink-0">{dateOf(g)}</span>
                        <span className="flex-1 truncate">
                          {s.teams[g.home].short} — {s.teams[g.away].short}
                        </span>
                        {res ? (
                          <b className={cn('tabular', us > them ? 'text-ok' : 'text-accent')}>
                            {us}:{them}
                            {res.so ? ' Б' : res.ot ? ' ОТ' : ''}
                          </b>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </button>
                    );
                  })}
                  {!next && vsUser.length === 0 && <div className="text-muted">Матчей нет.</div>}
                </div>
              </Section>
            </div>
          </div>
        ) : (
          <div className="mt-3 space-y-3" data-team-roster>
            {groups.map(([title, list]) => (
              <Section key={title} title={title}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                  {[...list]
                    .sort((a, b) => Number(!!a.inVhl) - Number(!!b.inVhl) || b.overall - a.overall)
                    .map((p) => (
                      <button key={p.id} type="button" onClick={() => open(p.id)} className={cn('flex items-center gap-2 rounded-sm px-1.5 py-1 hover:bg-panel2 text-left text-xs', p.inVhl && 'opacity-60')}>
                        <PlayerFace face={p.face} name={p.name} number={p.number} team={team} size={28} />
                        <span className="flex-1 min-w-0">
                          <span className="block truncate text-sm">{p.name}</span>
                          <span className="text-muted">
                            №{p.number} · {p.age} л.{p.inVhl ? ' · ВХЛ' : ''}
                            {p.injury ? ' · травма' : ''}
                          </span>
                        </span>
                        <PosBadge pos={p.position} />
                        {chip(p)}
                      </button>
                    ))}
                </div>
              </Section>
            ))}
          </div>
        )}

        <div className="flex gap-2 mt-4 pt-3 border-t border-line flex-wrap">
          {!isUser && (
            <Button
              variant="primary"
              disabled={!tradeWindow(s).open}
              onClick={() => {
                onClose();
                ui.tradeWith(`team:${id}`);
              }}
            >
              ⇄ Обмен с клубом
            </Button>
          )}
          <Button
            onClick={() => {
              onClose();
              ui.nav('standings');
            }}
          >
            Таблица
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Закрыть
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** A club name (with logo) that opens the club card. Use inside non-button containers. */
export function TeamLink({ team, size = 18, label, className }: { team: Team; size?: number; label?: ReactNode; className?: string }) {
  const ui = useUI();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        ui.openTeam(team.id);
      }}
      className={cn('inline-flex items-center gap-1.5 min-w-0 text-left hover:text-ice hover:underline underline-offset-2', className)}
      title={`О клубе «${team.name}»`}
      data-team-link={team.id}
    >
      {size > 0 && <TeamLogo team={team} size={size} />}
      <span className="truncate">{label ?? team.short}</span>
    </button>
  );
}
