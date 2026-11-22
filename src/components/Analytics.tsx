import { useEffect, useMemo, useRef, useState } from 'react';
import { Chart, registerables, type ChartConfiguration } from 'chart.js';
import { useGame } from '../game/state';
import { Panel, Stat, TeamLogo, Tag } from './ui';
import { cn } from '../utils/cn';

Chart.register(...registerables);

const GRID = 'rgba(36,53,79,0.75)';
const TEXT = '#E8EEF5';
const MUTED = '#93A4BC';

function ChartBox({ config, className }: { config: ChartConfiguration; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let chart: Chart | null = null;
    try {
      if (typeof el.getContext !== 'function' || !el.getContext('2d')) throw new Error('canvas 2d unavailable');
      chart = new Chart(el, config);
      setFailed(false);
    } catch {
      setFailed(true);
    }
    return () => {
      chart?.destroy();
    };
  }, [config]);
  return (
    <div className={cn('relative', className)}>
      <canvas ref={ref} className={cn(failed && 'invisible')} />
      {failed && <div className="absolute inset-0 flex items-center justify-center text-xs text-muted">График недоступен в этом окружении (нет 2D canvas).</div>}
    </div>
  );
}

function baseOptions(unit: string): ChartConfiguration['options'] {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    animation: { duration: 550, easing: 'easeOutQuart' },
    plugins: {
      legend: { labels: { color: TEXT, font: { family: 'Oswald, sans-serif', size: 13 }, boxWidth: 12, usePointStyle: true, pointStyle: 'rectRounded' } },
      tooltip: {
        backgroundColor: '#0B1420',
        borderColor: '#24354F',
        borderWidth: 1,
        titleColor: TEXT,
        bodyColor: TEXT,
        padding: 9,
        callbacks: { label: (c) => ` ${c.dataset.label}: ${c.formattedValue}${unit}` },
      },
    },
    scales: {
      x: { ticks: { color: MUTED, maxRotation: 0, autoSkipPadding: 14 }, grid: { color: GRID } },
      y: { ticks: { color: MUTED }, grid: { color: GRID }, beginAtZero: true },
    },
  };
}

export function Analytics() {
  const s = useGame()!;
  const U = s.teams[s.userTeamId];
  const P = s.players;

  const data = useMemo(() => {
    const conf = s.teamOrder.map((id) => s.teams[id]).filter((t) => t.conference === U.conference);
    const pts: Record<string, number> = {};
    const gp: Record<string, number> = {};
    for (const t of conf) {
      pts[t.id] = 0;
      gp[t.id] = 0;
    }
    const race: { gp: number; user: number; eighth: number; leader: number; leaderName: string }[] = [];
    const games: { gp: number; gf: number; ga: number; f: number; a: number }[] = [];
    const perPeriod = [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ];
    let ppG = 0;
    let ppC = 0;
    let pkGA = 0;
    let pkOPP = 0;
    let lPPG = 0;
    let lPPC = 0;
    let userGP = 0;
    let scored = 0;

    for (const day of s.schedule) {
      for (const g of day) {
        if (!g.played || !g.result || g.kind !== 'regular') continue;
        const r = g.result;
        const beyond = r.ot || r.so;
        const hw = r.homeScore > r.awayScore;
        const give = (id: string, win: boolean) => {
          if (pts[id] === undefined) return;
          gp[id]++;
          pts[id] += win ? 2 : beyond ? 1 : 0;
        };
        give(g.home, hw);
        give(g.away, !hw);
        lPPG += r.homeStats.ppGoals + r.awayStats.ppGoals;
        lPPC += r.homeStats.ppChances + r.awayStats.ppChances;
        if (g.home === U.id || g.away === U.id) {
          const mine: 'home' | 'away' = g.home === U.id ? 'home' : 'away';
          const st = mine === 'home' ? r.homeStats : r.awayStats;
          const opp = mine === 'home' ? r.awayStats : r.homeStats;
          const gf = mine === 'home' ? r.homeScore : r.awayScore;
          const ga = mine === 'home' ? r.awayScore : r.homeScore;
          userGP++;
          scored += gf;
          ppG += st.ppGoals;
          ppC += st.ppChances;
          pkGA += opp.ppGoals;
          pkOPP += opp.ppChances;
          games.push({ gp: userGP, gf, ga, f: st.shots, a: opp.shots });
          r.periodScores.forEach((sc, i) => {
            const b = Math.min(3, i);
            perPeriod[b][0] += sc[mine === 'home' ? 0 : 1];
            perPeriod[b][1] += sc[mine === 'home' ? 1 : 0];
          });
        }
      }
      if (gp[U.id] > 0 && (!race.length || race[race.length - 1].gp !== gp[U.id])) {
        const sorted = [...conf].sort((a, b) => pts[b.id] - pts[a.id] || b.record.gf - a.record.gf);
        race.push({
          gp: gp[U.id],
          user: pts[U.id],
          eighth: pts[sorted[7]?.id ?? ''] ?? 0,
          leader: pts[sorted[0]?.id ?? ''] ?? 0,
          leaderName: sorted[0]?.short ?? '—',
        });
      }
    }

    const roll = (arr: number[], n = 5) => arr.map((_, i) => +(arr.slice(Math.max(0, i - n + 1), i + 1).reduce((a, b) => a + b, 0) / Math.min(n, i + 1)).toFixed(2));
    const lines = U.lineup.F.map((l) => {
      const ps = l.map((id) => (id ? P[id] : null)).filter(Boolean) as typeof P[string][];
      const morale = ps.length ? Math.round(ps.reduce((a, p) => a + p.morale, 0) / ps.length) : 0;
      return { morale, count: ps.length };
    });

    return {
      race,
      games,
      perPeriod,
      ppPct: ppC ? (ppG / ppC) * 100 : 0,
      pkPct: pkOPP ? (1 - pkGA / pkOPP) * 100 : 0,
      leaguePP: lPPC ? (lPPG / lPPC) * 100 : 0,
      userGP,
      scored,
      rollF: roll(games.map((g) => g.f)),
      rollA: roll(games.map((g) => g.a)),
      lines,
    };
  }, [s, U, P]);

  const race = useMemo<ChartConfiguration>(
    () => ({
      type: 'line',
      data: {
        labels: data.race.map((r) => r.gp),
        datasets: [
          { label: U.name, data: data.race.map((r) => r.user), borderColor: U.primaryColor === '#0b1420' ? '#8FD8F0' : U.primaryColor, backgroundColor: `${U.primaryColor}33`, fill: true, tension: 0.25, pointRadius: 0, borderWidth: 3 },
          { label: `8-е место (${data.race[data.race.length - 1]?.leaderName ?? ''})`, data: data.race.map((r) => r.eighth), borderColor: '#3FCF8E', borderDash: [5, 4], pointRadius: 0, borderWidth: 2, fill: false, tension: 0.25 },
          { label: 'Лидер конференции', data: data.race.map((r) => r.leader), borderColor: '#F2B544', pointRadius: 0, borderWidth: 2, fill: false, tension: 0.25 },
        ],
      },
      options: { ...baseOptions(' очк.'), scales: { ...baseOptions(' очк.')?.scales, x: { ...baseOptions(' очк.')?.scales?.x, title: { display: true, text: 'Матчей сыграно', color: MUTED } } } } as ChartConfiguration['options'],
    }),
    [data, U]
  );

  const periods = useMemo<ChartConfiguration>(
    () => ({
      type: 'bar',
      data: {
        labels: ['1-й период', '2-й период', '3-й период', 'ОТ / буллиты'],
        datasets: [
          { label: 'Забито', data: data.perPeriod.map((p) => p[0]), backgroundColor: '#8FD8F0', borderRadius: 3, barPercentage: 0.7 },
          { label: 'Пропущено', data: data.perPeriod.map((p) => p[1]), backgroundColor: '#E5323E', borderRadius: 3, barPercentage: 0.7 },
        ],
      },
      options: baseOptions('') as ChartConfiguration['options'],
    }),
    [data]
  );

  const shooting = useMemo<ChartConfiguration>(
    () => ({
      type: 'line',
      data: {
        labels: data.games.map((g) => g.gp),
        datasets: [
          { label: 'Броски своей команды (5 матчей)', data: data.rollF, borderColor: '#8FD8F0', backgroundColor: 'rgba(143,216,240,.15)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 },
          { label: 'Броски соперника (5 матчей)', data: data.rollA, borderColor: '#E5323E', backgroundColor: 'rgba(229,50,62,.12)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 },
        ],
      },
      options: baseOptions('') as ChartConfiguration['options'],
    }),
    [data]
  );

  const special = useMemo<ChartConfiguration>(
    () => ({
      type: 'bar',
      data: {
        labels: ['Большинство, %', 'Меньшинство, %'],
        datasets: [
          { label: U.short, data: [+data.ppPct.toFixed(1), +data.pkPct.toFixed(1)], backgroundColor: U.primaryColor === '#0b1420' ? '#8FD8F0' : U.primaryColor, borderRadius: 3, barPercentage: 0.55 },
          { label: 'Среднее по лиге', data: [+data.leaguePP.toFixed(1), +(100 - data.leaguePP).toFixed(1)], backgroundColor: '#5C7292', borderRadius: 3, barPercentage: 0.55 },
        ],
      },
      options: { ...baseOptions('%'), indexAxis: 'y', scales: { x: { ticks: { color: MUTED }, grid: { color: GRID }, suggestedMax: 100, beginAtZero: true }, y: { ticks: { color: TEXT }, grid: { display: false } } } } as ChartConfiguration['options'],
    }),
    [data, U]
  );

  const ppDiff = data.ppPct - data.leaguePP;
  const pkDiff = data.pkPct - (100 - data.leaguePP);
  const diffAll = data.games.reduce((a, g) => a + g.gf - g.ga, 0);
  const pace = data.userGP ? (data.race[data.race.length - 1]?.user ?? 0) / data.userGP : 0;

  return (
    <div className="space-y-4 fade-in">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <Stat label="Очков за матч" value={pace.toFixed(2)} sub={`проект темпа: ${(pace * data.userGP).toFixed(0)}`} color={pace >= 1.5 ? '#3FCF8E' : pace >= 1.15 ? '#8FD8F0' : '#E5323E'} />
        <Stat label="Разница голов" value={`${diffAll > 0 ? '+' : ''}${diffAll}`} sub={`забито ${data.scored}`} color={diffAll >= 0 ? '#3FCF8E' : '#E5323E'} />
        <Stat label="Большинство" value={`${data.ppPct.toFixed(1)}%`} sub={`${ppDiff >= 0 ? '+' : ''}${ppDiff.toFixed(1)} к лиге`} color={ppDiff >= 0 ? '#3FCF8E' : '#F2B544'} />
        <Stat label="Меньшинство" value={`${data.pkPct.toFixed(1)}%`} sub={`${pkDiff >= 0 ? '+' : ''}${pkDiff.toFixed(1)} к лиге`} color={pkDiff >= 0 ? '#3FCF8E' : '#E5323E'} />
        <Stat label="Матчей в выборке" value={data.userGP} sub="регулярный чемпионат" />
      </div>

      <Panel
        title="Гонка за плей-офф"
        right={
          <span className="text-xs text-muted">
            накопленные очки · конференция «{U.conference}»
          </span>
        }
      >
        {data.race.length > 1 ? (
          <ChartBox config={race} className="h-[280px]" />
        ) : (
          <div className="text-sm text-muted py-8 text-center">Нужно несколько сыгранных матчей, чтобы построить динамику.</div>
        )}
      </Panel>

      <div className="grid grid-cols-1 xl:grid-cols-[1.35fr_1fr] gap-4">
        <Panel title="Броски по матчам" right={<Tag color="#93A4BC">скользящее среднее, 5 игр</Tag>}>
          {data.games.length > 2 ? <ChartBox config={shooting} className="h-[240px]" /> : <div className="text-sm text-muted py-8 text-center">Мало данных.</div>}
        </Panel>
        <Panel title="Спецбригады">
          <ChartBox config={special} className="h-[240px]" />
        </Panel>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_1.35fr] gap-4">
        <Panel title="Шайбы по периодам">
          <ChartBox config={periods} className="h-[240px]" />
        </Panel>
        <Panel title="Микроклимат в звеньях" right={<span className="text-xs text-muted">влияет на силу линии в матче</span>}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {data.lines.map((l, i) => {
              const f = (1 + (l.morale - 70) * 0.0022 - 1) * 100;
              const color = l.morale >= 78 ? '#3FCF8E' : l.morale >= 62 ? '#8FD8F0' : l.morale >= 50 ? '#F2B544' : '#E5323E';
              const ids = U.lineup.F[i] ?? [];
              return (
                <div key={i} className="bg-panel2/70 border border-line/70 rounded-sm p-2.5">
                  <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-muted">
                    <span>Звено {i + 1}</span>
                    <span className="tabular" style={{ color }}>
                      {f >= 0 ? '+' : ''}
                      {f.toFixed(1)}%
                    </span>
                  </div>
                  <div className="font-display text-2xl tabular" style={{ color }}>
                    {l.count ? l.morale : '—'}
                  </div>
                  <div className="text-[11px] text-muted truncate mt-0.5">{ids.filter(Boolean).map((id) => P[id!]?.name.split(' ').slice(-1)[0]).join(' · ') || 'пусто'}</div>
                  <div className="h-1 rounded-full bg-line overflow-hidden mt-1.5">
                    <div className="h-full rounded-full transition-all duration-500" style={{ width: `${l.morale}%`, background: color }} />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="text-[11px] text-muted mt-3 flex items-start gap-2">
            <TeamLogo team={U} size={20} />
            <span>Победы поднимают мораль, поражения её снижают, дубли и шайбы — дополнительно. Линия со средней моралью выше 78 играет примерно на 2% сильнее своих цифр, звено с недовольными хоккеистами — на 2–4% слабее. Продления контрактов и обмены тоже влияют на атмосферу в раздевалке.</span>
          </div>
        </Panel>
      </div>
    </div>
  );
}
