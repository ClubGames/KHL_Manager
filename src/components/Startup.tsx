import { useEffect, useRef, useState } from 'react';
// served next to index.html (like roster.json) instead of being inlined into the script
const arena = './arena.jpg';
import { downloadExampleRoster, fetchRoster, readLocalFile, ROSTER_EXAMPLE, rosterWithContracts, saveRosterFile } from '../game/roster';
import type { NormalizedRoster } from '../game/roster';
import { formatMoney, isGoalie, isSkater, payroll } from '../game/ratings';
import { cn } from '../utils/cn';
import { Button, Panel, Spinner, TeamLogo } from './ui';
import { SavesList } from './Saves';

export function FormatDoc({ compact }: { compact?: boolean }) {
  const rows: [string, string, string][] = [
    ['league.name', 'string', 'Название лиги (по умолчанию «КХЛ»)'],
    ['league.season', 'string', 'Подпись сезона, например "2025/26"'],
    ['league.gamesPerTeam', 'number', 'Матчей в регулярном чемпионате на команду (по умолчанию 68)'],
    ['league.salaryCap', 'number', 'Потолок зарплат, ₽ за сезон (по умолчанию 900 000 000)'],
    ['teams[].id', 'string', 'Уникальный идентификатор клуба (латиница)'],
    ['teams[].name / short / city', 'string', 'Название, аббревиатура (3–4 знака), город'],
    ['teams[].conference', 'string', '«Запад» или «Восток» (понимаются также «Восточная конференция», East / West). Если не указано — определяется по дивизиону'],
    ['teams[].division', 'string', 'Необязательное название дивизиона'],
    ['teams[].primaryColor / secondaryColor', 'string', 'Цвета клуба для эмблемы (#RRGGBB)'],
    ['teams[].budget', 'number', 'Бюджет клуба, ₽ (по умолчанию 1,5 млрд)'],
    ['players[].id', 'string', 'Уникальный идентификатор игрока (если нет — сгенерируется)'],
    ['players[].name', 'string', 'ФИО игрока — единственное обязательное поле'],
    ['players[].position', 'string', 'Ц / ЛК / ПК / З / В (или C / LW / RW / D / G)'],
    ['players[].age', 'number', 'Возраст (18–45)'],
    ['players[].height / weight / number', 'number', 'Рост (см), вес (кг), игровой номер'],
    ['players[].country / hand', 'string', 'Гражданство; хват клюшки L / R'],
    ['players[].overall', 'number', 'Общий рейтинг 1–99. Необязателен: считается из skills'],
    ['players[].potential', 'number', 'Потолок развития 1–99 (для игроков до 25 лет)'],
    ['players[].skills', 'object', 'Полевые: skating, shooting, passing, puckControl, checking, defense. Вратари: reflexes, positioning, reboundControl, puckHandling, endurance (1–99)'],
    ['players[].contract', 'object', '{ salary: оклад за сезон ₽, years: осталось сезонов }. Если не указан — игра назначит контракт сама и предложит записать его в файл'],
    ['players[].injury', 'object|null', '{ name: "Травма плеча", games: 6 } или null'],
    ['players[].morale', 'number', 'Мораль 20–99 (по умолчанию 72)'],
    ['freeAgents[]', 'array', 'Игроки без контракта — тот же формат, что players[]'],
  ];
  return (
    <div className="space-y-4">
      {!compact && (
        <div className="rounded-md border border-ice/30 bg-ice/5 p-4 text-sm leading-relaxed">
          <b className="text-ice">Игра загружает файл <code className="bg-panel2 px-1 rounded">roster.json</code> из папки рядом с <code className="bg-panel2 px-1 rounded">index.html</code>.</b> Положите свой файл с этим именем и обновите страницу — или выберите файл вручную на экране загрузки. Рекомендуемый состав клуба: 12–14 нападающих, 6–8 защитников, 2–3 вратаря. Игроки с любым количеством навыков будут дополнены средними значениями.
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Поля файла">
          <div className="overflow-x-auto -m-4 mt-0">
            <table className="w-full text-xs">
              <thead className="text-muted uppercase tracking-wider text-[10px]">
                <tr>
                  <th className="text-left px-4 py-2 font-semibold">Поле</th>
                  <th className="text-left py-2 font-semibold">Тип</th>
                  <th className="text-left py-2 pr-4 font-semibold">Описание</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([f, t, d]) => (
                  <tr key={f} className="border-t border-line/60">
                    <td className="px-4 py-1.5 font-mono text-ice whitespace-nowrap">{f}</td>
                    <td className="py-1.5 text-muted whitespace-nowrap">{t}</td>
                    <td className="py-1.5 pr-4 text-text/90">{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="Пример структуры" right={<Button size="sm" onClick={downloadExampleRoster}>Скачать пример</Button>} noPad>
          <pre className="text-[11.5px] leading-relaxed p-4 overflow-x-auto text-ice/90 font-mono">{ROSTER_EXAMPLE}</pre>
        </Panel>
      </div>
    </div>
  );
}

function strength(r: NormalizedRoster, teamId: string): number {
  const ids = r.teams.find((t) => t.id === teamId)!.players;
  const sk = ids.map((id) => r.players[id]).filter(isSkater).sort((a, b) => b.overall - a.overall).slice(0, 12);
  const g = ids.map((id) => r.players[id]).filter(isGoalie).sort((a, b) => b.overall - a.overall)[0];
  const all = g ? [...sk, g] : sk;
  return all.length ? Math.round(all.reduce((s, p) => s + p.overall, 0) / all.length) : 0;
}

function TeamSelect({ roster, onStart }: { roster: NormalizedRoster; onStart: (teamId: string) => void }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const confs = ['Запад', 'Восток'];
  const team = chosen ? roster.teams.find((t) => t.id === chosen) : null;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {confs.map((c) => (
          <Panel key={c} title={`Конференция «${c}»`} noPad>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-3">
              {roster.teams
                .filter((t) => t.conference === c)
                .map((t) => {
                  const s = strength(roster, t.id);
                  return (
                    <button
                      key={t.id}
                      onClick={() => setChosen(t.id)}
                      className={cn('flex items-center gap-3 p-3 rounded-md border text-left transition-all duration-150 hover:bg-panel2', chosen === t.id ? 'border-accent bg-accent/10 ring-1 ring-accent/50' : 'border-line bg-panel2/40')}
                    >
                      <TeamLogo team={t} size={44} />
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold truncate">{t.name}</div>
                        <div className="text-xs text-muted truncate">{t.city}</div>
                        <div className="text-[11px] text-muted mt-0.5">{t.players.length} игроков · ФОТ {formatMoney(payroll(t.players, roster.players))}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-display text-xl tabular" style={{ color: s >= 80 ? '#E5323E' : s >= 77 ? '#8FD8F0' : '#E8EEF5' }}>
                          {s}
                        </div>
                        <div className="text-[10px] uppercase tracking-wider text-muted">сила</div>
                      </div>
                    </button>
                  );
                })}
            </div>
          </Panel>
        ))}
      </div>
      {roster.warnings.length > 0 && (
        <Panel title={`Предупреждения ростера (${roster.warnings.length})`}>
          <ul className="text-xs text-amber/90 space-y-1 max-h-32 overflow-y-auto">
            {roster.warnings.map((w, i) => (
              <li key={i}>• {w}</li>
            ))}
          </ul>
        </Panel>
      )}
      <div className="sticky bottom-4 z-10">
        <div className="bg-panel2/95 backdrop-blur border border-line rounded-md p-3 flex items-center justify-between gap-4 shadow-xl">
          <div className="text-sm text-muted">{team ? <>Выбран клуб: <b className="text-text">{team.name}</b>. Сезон {roster.season}, {roster.gamesPerTeam} матчей.</> : 'Выберите клуб, которым будете управлять'}</div>
          <Button variant="primary" size="lg" disabled={!team} onClick={() => team && onStart(team.id)}>
            Начать карьеру
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Startup({ onStart }: { onStart: (r: NormalizedRoster, teamId: string) => void }) {
  const [saveCount, setSaveCount] = useState<number | null>(null);
  const [stage, setStage] = useState<'loading' | 'error' | 'select' | 'format'>('loading');
  const [roster, setRoster] = useState<NormalizedRoster | null>(null);
  const [err, setErr] = useState('');
  const [fileErr, setFileErr] = useState('');
  const [contractMsg, setContractMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    setStage('loading');
    setErr('');
    fetchRoster()
      .then((r) => {
        setRoster(r);
        setStage('select');
      })
      .catch((e: Error) => {
        setErr(e?.message ?? String(e));
        setStage('error');
      });
  };
  useEffect(load, []);

  const onFile = async (f: File) => {
    try {
      const r = await readLocalFile(f);
      setRoster(r);
      setFileErr('');
      setStage('select');
    } catch (e) {
      setFileErr((e as Error).message);
    }
  };

  return (
    <div className="relative min-h-screen rink-lines overflow-hidden">
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse at 50% -10%, rgba(229,50,62,.14), transparent 55%)' }} />
      <div className="relative max-w-6xl mx-auto px-4 py-8 md:py-12">
        <header className="relative -mx-4 md:mx-0 mb-8 md:rounded-md overflow-hidden border-0 md:border border-line bg-cover bg-center" style={{ backgroundImage: `url(${arena})`, backgroundPosition: 'center 55%' }}>
          <div className="absolute inset-0 bg-gradient-to-r from-bg via-bg/85 to-bg/25" />
          <div className="relative px-6 md:px-10 py-8 md:py-10">
            <p className="text-accent font-display uppercase tracking-[0.3em] text-xs">Симулятор генерального менеджера</p>
            <h1 className="font-display text-5xl md:text-7xl font-bold uppercase leading-none mt-2">
              КХЛ <span className="text-accent">ГМ</span>
            </h1>
            <p className="text-muted mt-3 max-w-2xl text-sm md:text-base">Возьмите под управление хоккейный клуб Континентальной лиги: собирайте звенья, проводите обмены, ведите команду через регулярный чемпионат к Кубку Гагарина. Ростер лиги загружается из вашего файла <code className="bg-panel2 px-1.5 py-0.5 rounded text-ice">roster.json</code>.</p>
            <div className="flex flex-wrap gap-2 mt-5">
              {['Регулярный чемпионат и плей-офф', 'Звенья, большинство, меньшинство', 'Обмены, рынок, контракты'].map((t) => (
                <span key={t} className="inline-block text-[11px] uppercase tracking-wider bg-panel/80 border border-line rounded-sm pl-2.5 pr-3.5 py-1 text-text/85 slash">
                  {t}
                </span>
              ))}
            </div>
          </div>
        </header>

        {stage !== 'format' && (
          <>
            <Panel className={saveCount ? 'mb-8 border-ice/40' : 'mb-8'} title={saveCount ? `Продолжить карьеру · сохранений: ${saveCount}` : 'Продолжить карьеру'}>
              <SavesList onCount={setSaveCount} />
            </Panel>
            <div className="mb-4">
              <h2 className="font-display text-2xl uppercase leading-none m-0 flex items-center gap-2">
                <span className="w-1.5 h-5 bg-accent slash" />
                Новая карьера
              </h2>
              <p className="text-sm text-muted mt-1.5">Выберите клуб — новая карьера займёт отдельный слот и не затронет существующие сохранения.</p>
            </div>
          </>
        )}

        {stage === 'loading' && (
          <Panel>
            <div className="flex items-center gap-3 py-6 justify-center text-muted">
              <Spinner />
              Загрузка roster.json…
            </div>
          </Panel>
        )}

        {stage === 'error' && (
          <Panel title="Файл roster.json не найден или повреждён">
            <div className="space-y-4 text-sm">
              <div className="rounded-md bg-accent/10 border border-accent/30 p-3 text-text">
                <b>Ошибка:</b> <span className="font-mono text-xs">{err}</span>
              </div>
              <ol className="list-decimal pl-5 space-y-1.5 text-text/90">
                <li>
                  Положите файл <code className="bg-panel2 px-1.5 py-0.5 rounded text-ice">roster.json</code> в папку рядом с <code className="bg-panel2 px-1.5 py-0.5 rounded text-ice">index.html</code> и нажмите «Повторить».
                </li>
                <li>Или выберите файл вручную — он будет загружен прямо в браузере.</li>
                <li>Структуру файла смотрите на вкладке «Формат JSON»; там же можно скачать пример.</li>
              </ol>
              {fileErr && <div className="text-accent text-xs">{fileErr}</div>}
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={load}>
                  Повторить
                </Button>
                <Button onClick={() => fileRef.current?.click()}>Выбрать файл…</Button>
                <Button onClick={() => setStage('format')}>Формат JSON</Button>
                <Button variant="ghost" onClick={downloadExampleRoster}>
                  Скачать пример
                </Button>
                <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
              </div>
            </div>
          </Panel>
        )}

        {stage === 'format' && (
          <div className="space-y-3">
            <Button onClick={() => setStage(roster ? 'select' : 'error')}>← Назад</Button>
            <FormatDoc />
          </div>
        )}

        {stage === 'select' && roster && (
          <>
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <div className="text-sm text-muted">
                Лига «{roster.leagueName}» · сезон {roster.season} · {roster.teams.length} команд · {Object.keys(roster.players).length} игроков
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => fileRef.current?.click()}>
                  Загрузить другой файл
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setStage('format')}>
                  Формат JSON
                </Button>
                <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
              </div>
            </div>
            {roster.filled.length > 0 && (
              <Panel className="mb-4 border-amber/40" title={`Контракты: назначены ${roster.filled.length} игрокам`}>
                <div className="text-sm text-text/90" data-contracts-notice>
                  В файле ростера у {roster.filled.length} игроков не указан контракт (оклад или срок). Игра назначила их сама — по рейтингу, возрасту и потенциалу, на срок от 1 до 4 лет. Назначенные контракты одинаковы при каждом запуске, но чтобы закрепить их и править вручную, запишите их в файл.
                </div>
                <div className="flex items-center gap-3 flex-wrap mt-3">
                  <Button
                    variant="ice"
                    onClick={async () => {
                      const res = await saveRosterFile(rosterWithContracts(roster));
                      setContractMsg(res === 'saved' ? 'Файл записан. Если вы сохранили его как roster.json в папке с игрой, контракты уже в ростере.' : res === 'downloaded' ? 'Файл roster.json скачан — замените им файл в папке с игрой.' : '');
                    }}
                  >
                    Сохранить roster.json с контрактами
                  </Button>
                  <span className="text-xs text-muted flex-1 min-w-[220px]">Браузер не даёт странице молча изменить файл на диске, поэтому он попросит указать, куда сохранить: выберите roster.json в папке с игрой. Остальные данные файла не меняются.</span>
                </div>
                {contractMsg && <div className="mt-3 text-xs rounded-sm border border-ok/50 text-ok bg-ok/10 px-2.5 py-2">{contractMsg}</div>}
              </Panel>
            )}
            <TeamSelect roster={roster} onStart={(id) => onStart(roster, id)} />
          </>
        )}
      </div>
    </div>
  );
}
