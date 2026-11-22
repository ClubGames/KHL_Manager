import { talksLeft, askingSalary } from '../game/contracts';
import { formatMoney } from '../game/ratings';
import { TRAINING_PLANS } from '../game/training';
import { letGo, startNewSeason, useGame } from '../game/state';
import { Button, Empty, OverallChip, Panel, PosBadge, Tag, TeamLogo, useUI } from './ui';
import { cn } from '../utils/cn';

function nextLabel(s: string): string {
  const m = /^(\d{4})\/(\d{2})$/.exec(s);
  if (!m) return '';
  const y = parseInt(m[1], 10) + 1;
  return `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
}

export function Offseason() {
  const s = useGame()!;
  const ui = useUI();
  const P = s.players;
  const U = s.teams[s.userTeamId];
  const plan = s.offseason;
  const summary = s.summaries[s.summaries.length - 1];
  if (!plan) {
    return (
      <Panel>
        <Empty text="Межсезонье ещё не началось" />
      </Panel>
    );
  }
  const expiring = plan.expiring.map((id) => P[id]).filter(Boolean);
  const progressions = plan.progressions.filter((x) => P[x.id] && P[x.id].teamId === U.id);
  const ups = progressions.filter((x) => x.to > x.from);
  const downs = progressions.filter((x) => x.to < x.from);
  const begin = () => {
    const go = () => {
      startNewSeason();
      ui.nav('dashboard');
    };
    if (expiring.length) ui.confirm({ title: 'Начать новый сезон?', text: `Игроки с истёкшими контрактами (${expiring.length}) без нового соглашения уйдут на рынок свободных агентов.`, confirmLabel: 'Начать сезон', onYes: go });
    else go();
  };
  const net = (summary?.revenue ?? 0) - (summary?.payroll ?? 0) + (summary?.boardBonus ?? 0);
  return (
    <div className="space-y-4 fade-in">
      {summary && (
        <Panel title={`Итоги сезона ${summary.season}`} right={<Tag color="#F2B544">{summary.userResult}</Tag>}>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="bg-panel2/70 border border-line/70 rounded-sm p-3">
              <div className="text-[11px] uppercase tracking-wider text-muted">Обладатель Кубка Гагарина</div>
              <div className="flex items-center gap-2 mt-1">
                <TeamLogo team={s.teams[summary.champion]} size={30} />
                <span className="font-display text-lg">{s.teams[summary.champion].name}</span>
              </div>
              {s.playoffs?.mvp && <div className="text-xs text-amber mt-1">MVP плей-офф: {P[s.playoffs.mvp]?.name}</div>}
            </div>
            <div className="bg-panel2/70 border border-line/70 rounded-sm p-3">
              <div className="text-[11px] uppercase tracking-wider text-muted">Ваш результат</div>
              <div className="font-display text-lg mt-1">
                {summary.userPoints} очков · {summary.userPlace}-е место
              </div>
              {summary.board && <div className={cn('text-xs mt-1', s.board.last?.verdict === 'failed' ? 'text-accent' : 'text-ok')}>{summary.board}</div>}
              <div className="text-[11px] text-muted mt-1">Доверие руководства: {s.board.confidence} из 100</div>
            </div>
            <div className="bg-panel2/70 border border-line/70 rounded-sm p-3 text-sm">
              <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Финансы сезона</div>
              {summary.revenue != null ? (
                <div className="space-y-0.5 tabular">
                  <div className="flex justify-between">
                    <span className="text-muted">Доходы</span>
                    <span className="text-ok">+{formatMoney(summary.revenue)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Зарплаты</span>
                    <span className="text-accent">−{formatMoney(summary.payroll ?? 0)}</span>
                  </div>
                  {!!summary.boardBonus && (
                    <div className="flex justify-between">
                      <span className="text-muted">{summary.boardBonus > 0 ? 'Премия от руководства' : 'Урезание бюджета'}</span>
                      <span className={summary.boardBonus > 0 ? 'text-ok' : 'text-accent'}>{summary.boardBonus > 0 ? '+' : '−'}{formatMoney(Math.abs(summary.boardBonus))}</span>
                    </div>
                  )}
                  <div className="flex justify-between border-t border-line/60 pt-1 mt-1 font-semibold">
                    <span>Итог</span>
                    <span className={net >= 0 ? 'text-ok' : 'text-accent'}>{net >= 0 ? '+' : '−'}{formatMoney(Math.abs(net))}</span>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-muted">Доход по итогам сезона зачислен в бюджет.</div>
              )}
            </div>
          </div>
          {summary.awards.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-3">
              {summary.awards.map((a) => (
                <div key={a.title} className="bg-panel2/70 border border-line/70 rounded-sm p-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted">{a.title}</div>
                  <div className="text-sm font-semibold truncate">{P[a.player]?.name}</div>
                  <div className="text-xs text-muted">
                    {s.teams[a.team]?.short} · <span className="text-amber tabular">{a.value}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel title="Изменение рейтинга игроков" right={<span className="text-xs text-muted">↑ {ups.length} · ↓ {downs.length}</span>}>
          {progressions.length === 0 ? (
            <Empty text="Без изменений" />
          ) : (
            <ul className="divide-y divide-line/60 text-sm max-h-[420px] overflow-y-auto">
              {[...progressions]
                .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))
                .map((x) => {
                  const p = P[x.id];
                  const d = x.to - x.from;
                  return (
                    <li key={x.id} className="flex items-center gap-2 py-1.5">
                      <PosBadge pos={p.position} />
                      <button className="flex-1 truncate text-left hover:text-ice" onClick={() => ui.openPlayer(x.id)}>
                        {p.name}
                      </button>
                      {x.plan && TRAINING_PLANS[x.plan] && (
                        <Tag tone="accent">{TRAINING_PLANS[x.plan].short}</Tag>
                      )}
                      <span className="text-xs text-muted">{p.age} л.</span>
                      <span className="font-display tabular">
                        {x.from} → <span className={d > 0 ? 'text-ok' : 'text-accent'}>{x.to}</span>
                      </span>
                      <span className={cn('text-xs tabular', d > 0 ? 'text-ok' : 'text-accent')}>{d > 0 ? `+${d}` : d}</span>
                    </li>
                  );
                })}
            </ul>
          )}
        </Panel>

        <Panel title="Истёкшие контракты" right={<Tag color="#F2B544">{expiring.length}</Tag>}>
          {expiring.length === 0 ? (
            <Empty text="Все игроки состава под контрактом" />
          ) : (
            <ul className="divide-y divide-line/60 text-sm max-h-[420px] overflow-y-auto" data-expiring>
              {expiring.map((p) => {
                const left = talksLeft(s, p);
                return (
                  <li key={p.id} className="py-2 flex items-center gap-2 flex-wrap">
                    <PosBadge pos={p.position} />
                    <button className="flex-1 min-w-[120px] truncate text-left hover:text-ice" onClick={() => ui.openPlayer(p.id)}>
                      {p.name}
                    </button>
                    <span className="text-xs text-muted">{p.age} л.</span>
                    <OverallChip value={p.overall} size="sm" />
                    <span className="text-xs text-muted tabular whitespace-nowrap">запрос {formatMoney(askingSalary(s, p, 1, U.id))}</span>
                    <Button size="sm" variant="primary" disabled={left <= 0} onClick={() => ui.negotiate(p.id)}>
                      {left <= 0 ? 'Отказ' : 'Переговоры'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => letGo(p.id)}>
                      Отпустить
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="text-[11px] text-muted mt-3">Все условия и продления — в разделе «Контракты». Окно обменов в межсезонье открыто.</div>
        </Panel>
      </div>

      <Panel title="Трофеи клуба">
        {s.trophies.length === 0 ? (
          <div className="text-sm text-muted">Пока пусто. Кубок Гагарина и Кубок Континента ждут.</div>
        ) : (
          <div className="flex gap-2 flex-wrap">
            {s.trophies.map((t, i) => (
              <Tag key={i} color="#F2B544">
                {t.title} · {t.season}
              </Tag>
            ))}
          </div>
        )}
      </Panel>

      <div className="sticky bottom-16 lg:bottom-4 z-10">
        <div className="bg-panel2/95 backdrop-blur border border-line rounded-md p-3 flex items-center justify-between gap-4 shadow-xl flex-wrap">
          <div className="text-sm text-muted flex-1 min-w-[220px]">
            Сезон {s.league.season} завершён. {expiring.length ? `Осталось решить судьбу ${expiring.length} игроков с истёкшими контрактами.` : 'Состав готов к новому сезону.'} Свободные агенты — в разделе «Рынок».
          </div>
          <Button variant="primary" size="lg" onClick={begin}>
            Начать сезон {nextLabel(s.league.season)}
          </Button>
        </div>
      </div>
    </div>
  );
}
