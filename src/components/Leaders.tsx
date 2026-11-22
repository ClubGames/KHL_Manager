import { useMemo, useState } from 'react';
import type { Player } from '../types';
import { isDefense, isForward, isGoalie } from '../game/ratings';
import { useGame } from '../game/state';
import { Empty, Panel, PosBadge, Tag, TeamLogo, useUI } from './ui';
import { cn } from '../utils/cn';

type Scope = 'all' | 'Запад' | 'Восток' | 'mine';
type SkKey = 'points' | 'goals' | 'assists' | 'plusMinus' | 'pim' | 'shots' | 'pct' | 'ppg' | 'gp';
type GKey = 'sv' | 'gaa' | 'wins' | 'shutouts' | 'gp' | 'saves';

const pts = (p: Player) => p.stats.goals + p.stats.assists;
const svPct = (p: Player) => (p.stats.shotsAgainst ? p.stats.saves / p.stats.shotsAgainst : 0);
const gaa = (p: Player) => (p.stats.minutes ? ((p.stats.shotsAgainst - p.stats.saves) * 60) / p.stats.minutes : 99);

const SK_VAL: Record<SkKey, (p: Player) => number> = {
  points: pts,
  goals: (p) => p.stats.goals,
  assists: (p) => p.stats.assists,
  plusMinus: (p) => p.stats.plusMinus,
  pim: (p) => p.stats.pim,
  shots: (p) => p.stats.shots,
  pct: (p) => (p.stats.shots >= 20 ? p.stats.goals / p.stats.shots : -1),
  ppg: (p) => (p.stats.gp >= 5 ? pts(p) / p.stats.gp : -1),
  gp: (p) => p.stats.gp,
};
const SK_COLS: { k: SkKey; label: string; title: string }[] = [
  { k: 'gp', label: 'И', title: 'Игры' },
  { k: 'goals', label: 'Ш', title: 'Шайбы' },
  { k: 'assists', label: 'П', title: 'Передачи' },
  { k: 'points', label: 'О', title: 'Очки (шайбы + передачи)' },
  { k: 'plusMinus', label: '+/−', title: 'Показатель полезности' },
  { k: 'pim', label: 'Штр', title: 'Штрафные минуты' },
  { k: 'shots', label: 'Бр', title: 'Броски в створ' },
  { k: 'pct', label: '%Бр', title: 'Реализация бросков (от 20 бросков)' },
  { k: 'ppg', label: 'О/И', title: 'Очки за игру (от 5 игр)' },
];
const G_COLS: { k: GKey; label: string; title: string }[] = [
  { k: 'gp', label: 'И', title: 'Игры' },
  { k: 'wins', label: 'В', title: 'Победы' },
  { k: 'shutouts', label: 'СО', title: 'Сухие матчи' },
  { k: 'saves', label: 'Сейвы', title: 'Отражённые броски' },
  { k: 'sv', label: '%ОБ', title: 'Процент отражённых бросков' },
  { k: 'gaa', label: 'КН', title: 'Коэффициент надёжности — пропущено за 60 минут' },
];

const TOP = 40;

export function Leaders() {
  const s = useGame()!;
  const ui = useUI();
  const U = s.userTeamId;
  const [tab, setTab] = useState<'skaters' | 'goalies'>('skaters');
  const [scope, setScope] = useState<Scope>('all');
  const [pos, setPos] = useState<'ALL' | 'F' | 'D'>('ALL');
  const [sk, setSk] = useState<SkKey>('points');
  const [gk, setGk] = useState<GKey>('sv');

  const inScope = (p: Player) => {
    if (!p.teamId) return false;
    if (scope === 'all') return true;
    if (scope === 'mine') return p.teamId === U;
    return s.teams[p.teamId]?.conference === scope;
  };
  const maxGp = Math.max(0, ...s.teamOrder.map((id) => s.teams[id].record.gp));
  const minGoalieGames = Math.max(1, Math.ceil(maxGp * 0.25));

  const { skaters, goalies, anyGames } = useMemo(() => {
    const all = Object.values(s.players).filter((p) => p.teamId && p.stats.gp > 0);
    return { skaters: all.filter((p) => !isGoalie(p)), goalies: all.filter(isGoalie), anyGames: all.length > 0 };
    // players are mutated in place; the state object identity changes after every simulated day
  }, [s]);

  const skRows = useMemo(() => {
    const f = skaters.filter((p) => inScope(p) && (pos === 'ALL' || (pos === 'D' ? isDefense(p) : isForward(p))));
    const v = SK_VAL[sk];
    return f.sort((a, b) => v(b) - v(a) || pts(b) - pts(a) || b.stats.goals - a.stats.goals || a.stats.gp - b.stats.gp).slice(0, TOP);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skaters, scope, pos, sk]);

  const gRows = useMemo(() => {
    const f = goalies.filter(inScope);
    const qualified = (p: Player) => p.stats.gp >= minGoalieGames;
    const v = (p: Player) => (gk === 'sv' ? svPct(p) : gk === 'gaa' ? -gaa(p) : gk === 'wins' ? p.stats.wins : gk === 'shutouts' ? p.stats.shutouts : gk === 'saves' ? p.stats.saves : p.stats.gp);
    const rate = gk === 'sv' || gk === 'gaa';
    return f.sort((a, b) => (rate ? Number(qualified(b)) - Number(qualified(a)) : 0) || v(b) - v(a) || b.stats.wins - a.stats.wins).slice(0, TOP);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalies, scope, gk, minGoalieGames]);

  const best = (list: Player[], v: (p: Player) => number) => [...list].sort((a, b) => v(b) - v(a))[0];
  const scoped = skaters.filter(inScope);
  const cards: { title: string; p: Player | undefined; value: string }[] = [
    { title: 'Лучший бомбардир', p: best(scoped, pts), value: '' },
    { title: 'Лучший снайпер', p: best(scoped, (p) => p.stats.goals), value: '' },
    { title: 'Лучший ассистент', p: best(scoped, (p) => p.stats.assists), value: '' },
    { title: 'Лучший защитник', p: best(scoped.filter(isDefense), pts), value: '' },
    { title: 'Лучший вратарь', p: best(goalies.filter((p) => inScope(p) && p.stats.gp >= minGoalieGames), svPct), value: '' },
  ];
  cards[0].value = cards[0].p ? `${pts(cards[0].p)} очк. (${cards[0].p.stats.goals}+${cards[0].p.stats.assists})` : '';
  cards[1].value = cards[1].p ? `${cards[1].p.stats.goals} шайб` : '';
  cards[2].value = cards[2].p ? `${cards[2].p.stats.assists} передач` : '';
  cards[3].value = cards[3].p ? `${pts(cards[3].p)} очк. (${cards[3].p.stats.goals}+${cards[3].p.stats.assists})` : '';
  cards[4].value = cards[4].p ? `${(svPct(cards[4].p) * 100).toFixed(1)}% · КН ${gaa(cards[4].p).toFixed(2)}` : '';

  const pill = (active: boolean) => cn('text-xs px-2.5 py-1 rounded-sm font-semibold transition-colors', active ? 'bg-accent text-white' : 'text-muted hover:text-text bg-panel2');
  const th = (active: boolean) => cn('px-2 py-2 text-right text-[11px] uppercase tracking-wider font-semibold select-none cursor-pointer hover:text-text whitespace-nowrap', active ? 'text-text' : 'text-muted');
  const teamCell = (p: Player) => {
    const t = s.teams[p.teamId!];
    return (
      <span className="flex items-center gap-1.5">
        <TeamLogo team={t} size={18} />
        <span className="text-muted">{t.short}</span>
      </span>
    );
  };

  if (!anyGames) {
    return (
      <Panel title="Статистика лиги">
        <Empty text="Статистика появится после первых сыгранных матчей." />
      </Panel>
    );
  }

  return (
    <div className="space-y-4 fade-in">
      <div className="flex items-center gap-2 flex-wrap">
        {(['all', 'Запад', 'Восток', 'mine'] as Scope[]).map((x) => (
          <button key={x} onClick={() => setScope(x)} className={pill(scope === x)}>
            {x === 'all' ? 'Вся лига' : x === 'mine' ? s.teams[U].name : x}
          </button>
        ))}
        <span className="text-xs text-muted ml-auto">Сезон {s.league.season}{s.phase !== 'season' ? ' · регулярный чемпионат и плей-офф' : ''}</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {cards.map((c) => (
          <button key={c.title} disabled={!c.p} onClick={() => c.p && ui.openPlayer(c.p.id)} className={cn('text-left bg-panel border rounded-md p-3 transition-colors', c.p ? 'hover:border-muted' : 'opacity-60', c.p?.teamId === U ? 'border-ice/60' : 'border-line')}>
            <div className="text-[10px] uppercase tracking-wider text-muted">{c.title}</div>
            {c.p ? (
              <>
                <div className="flex items-center gap-2 mt-1.5">
                  <TeamLogo team={s.teams[c.p.teamId!]} size={26} />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">{c.p.name}</div>
                    <div className="text-[11px] text-muted truncate">{s.teams[c.p.teamId!].name}</div>
                  </div>
                </div>
                <div className="font-display text-base text-amber tabular mt-1.5">{c.value}</div>
              </>
            ) : (
              <div className="text-xs text-muted mt-2">нет данных</div>
            )}
          </button>
        ))}
      </div>

      <Panel
        noPad
        title={tab === 'skaters' ? `Полевые игроки · топ-${Math.min(TOP, skRows.length)}` : `Вратари · топ-${Math.min(TOP, gRows.length)}`}
        right={
          <div className="flex gap-1 flex-wrap justify-end">
            <button onClick={() => setTab('skaters')} className={pill(tab === 'skaters')}>
              Полевые
            </button>
            <button onClick={() => setTab('goalies')} className={pill(tab === 'goalies')}>
              Вратари
            </button>
            {tab === 'skaters' && (
              <>
                <span className="w-px bg-line mx-1" />
                {(['ALL', 'F', 'D'] as const).map((x) => (
                  <button key={x} onClick={() => setPos(x)} className={pill(pos === x)}>
                    {x === 'ALL' ? 'Все' : x === 'F' ? 'Нападающие' : 'Защитники'}
                  </button>
                ))}
              </>
            )}
          </div>
        }
      >
        <div className="overflow-x-auto">
          {tab === 'skaters' ? (
            <table className="w-full text-sm tabular" data-leaders="skaters">
              <thead className="bg-panel2/40">
                <tr>
                  <th className="pl-4 pr-2 py-2 text-right text-[11px] uppercase tracking-wider font-semibold text-muted w-10">#</th>
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wider font-semibold text-muted">Игрок</th>
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wider font-semibold text-muted">Клуб</th>
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wider font-semibold text-muted">Поз</th>
                  {SK_COLS.map((c) => (
                    <th key={c.k} title={c.title} onClick={() => setSk(c.k)} className={cn(th(sk === c.k), c.k === 'ppg' && 'pr-4')}>
                      {c.label}
                      {sk === c.k && <span className="text-accent ml-0.5">▼</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {skRows.map((p, i) => (
                  <tr key={p.id} onClick={() => ui.openPlayer(p.id)} className={cn('border-t border-line/60 cursor-pointer transition-colors hover:bg-panel2', p.teamId === U && 'bg-ice/10')}>
                    <td className="pl-4 pr-2 py-1.5 text-right text-muted">{i + 1}</td>
                    <td className="px-2 py-1.5 font-medium whitespace-nowrap">
                      {p.name}
                      {p.teamId === U && <Tag color="#8FD8F0" className="ml-2">ваш</Tag>}
                    </td>
                    <td className="px-2 py-1.5">{teamCell(p)}</td>
                    <td className="px-2 py-1.5">
                      <PosBadge pos={p.position} />
                    </td>
                    <td className="px-2 py-1.5 text-right text-muted">{p.stats.gp}</td>
                    <td className={cn('px-2 py-1.5 text-right', sk === 'goals' && 'font-semibold text-text')}>{p.stats.goals}</td>
                    <td className={cn('px-2 py-1.5 text-right', sk === 'assists' && 'font-semibold text-text')}>{p.stats.assists}</td>
                    <td className="px-2 py-1.5 text-right font-display text-base">{pts(p)}</td>
                    <td className={cn('px-2 py-1.5 text-right', p.stats.plusMinus > 0 ? 'text-ok' : p.stats.plusMinus < 0 ? 'text-accent' : 'text-muted')}>
                      {p.stats.plusMinus > 0 ? '+' : ''}
                      {p.stats.plusMinus}
                    </td>
                    <td className="px-2 py-1.5 text-right text-muted">{p.stats.pim}</td>
                    <td className="px-2 py-1.5 text-right text-muted">{p.stats.shots}</td>
                    <td className="px-2 py-1.5 text-right text-muted">{p.stats.shots ? ((p.stats.goals / p.stats.shots) * 100).toFixed(1) : '—'}</td>
                    <td className="px-2 py-1.5 pr-4 text-right text-muted">{(pts(p) / Math.max(1, p.stats.gp)).toFixed(2)}</td>
                  </tr>
                ))}
                {skRows.length === 0 && (
                  <tr>
                    <td colSpan={13} className="py-6 text-center text-muted">
                      Нет игроков по этому фильтру
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-sm tabular" data-leaders="goalies">
              <thead className="bg-panel2/40">
                <tr>
                  <th className="pl-4 pr-2 py-2 text-right text-[11px] uppercase tracking-wider font-semibold text-muted w-10">#</th>
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wider font-semibold text-muted">Вратарь</th>
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wider font-semibold text-muted">Клуб</th>
                  {G_COLS.map((c) => (
                    <th key={c.k} title={c.title} onClick={() => setGk(c.k)} className={cn(th(gk === c.k), c.k === 'gaa' && 'pr-4')}>
                      {c.label}
                      {gk === c.k && <span className="text-accent ml-0.5">{c.k === 'gaa' ? '▲' : '▼'}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {gRows.map((p, i) => {
                  const q = p.stats.gp >= minGoalieGames;
                  return (
                    <tr key={p.id} onClick={() => ui.openPlayer(p.id)} className={cn('border-t border-line/60 cursor-pointer transition-colors hover:bg-panel2', p.teamId === U && 'bg-ice/10', !q && (gk === 'sv' || gk === 'gaa') && 'opacity-55')}>
                      <td className="pl-4 pr-2 py-1.5 text-right text-muted">{i + 1}</td>
                      <td className="px-2 py-1.5 font-medium whitespace-nowrap">
                        {p.name}
                        {p.teamId === U && <Tag color="#8FD8F0" className="ml-2">ваш</Tag>}
                      </td>
                      <td className="px-2 py-1.5">{teamCell(p)}</td>
                      <td className="px-2 py-1.5 text-right text-muted">{p.stats.gp}</td>
                      <td className="px-2 py-1.5 text-right">
                        {p.stats.wins}−{p.stats.losses}−{p.stats.otl}
                      </td>
                      <td className="px-2 py-1.5 text-right">{p.stats.shutouts}</td>
                      <td className="px-2 py-1.5 text-right text-muted">{p.stats.saves}</td>
                      <td className="px-2 py-1.5 text-right font-display text-base">{p.stats.shotsAgainst ? (svPct(p) * 100).toFixed(1) : '—'}</td>
                      <td className="px-2 py-1.5 pr-4 text-right">{p.stats.minutes ? gaa(p).toFixed(2) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="px-4 py-2 border-t border-line/60 text-[11px] text-muted">
          {tab === 'skaters'
            ? 'Нажмите на заголовок столбца, чтобы отсортировать. Строка — карточка игрока.'
            : `В рейтинге по %ОБ и КН сначала идут вратари, сыгравшие не менее ${minGoalieGames} матчей; остальные показаны бледнее. В — победы−поражения−поражения в ОТ/по буллитам.`}
        </div>
      </Panel>
    </div>
  );
}
