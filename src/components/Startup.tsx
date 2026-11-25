import { APP_RELEASE, canOpenModsFolder, MOD_SUBMIT_URL, openModsFolder, platform, USER_MODS_DIR } from '../platform';
import { useEffect, useRef, useState } from 'react';
// served next to index.html instead of being inlined into the script
const arena = './arena.jpg';
const gameLogo = './icon-game.png';
import { downloadExampleRoster, readLocalFile, ROSTER_EXAMPLE, rosterWithContracts, saveRosterFile } from '../game/roster';
import { lastModId, listMods, loadMod, rememberMod } from '../game/mods';
import type { ModEntry } from '../game/mods';
import { DEFAULT_LEAGUE_FULL_NAME, DEFAULT_LEAGUE_NAME, GAME_NAME_EN, GAME_NAME_RU } from '../brand';
import type { NormalizedRoster } from '../game/roster';
import { effectivePayroll } from '../game/cap';
import { formatMoney, isGoalie, isSkater } from '../game/ratings';
import { cn } from '../utils/cn';
import { Button, Icon, OverallChip, Panel, Spinner, TeamLogo, useUI } from './ui';
import { ClubOverview } from './TeamInfo';
import type { Team } from '../types';
import { FullscreenButton } from './FullscreenButton';
import { SavesList } from './Saves';

export function FormatDoc({ compact }: { compact?: boolean }) {
  const rows: [string, string, string][] = [
    ['league.name', 'string', `Название лиги, показывается в игре (по умолчанию «${DEFAULT_LEAGUE_NAME}» — ${DEFAULT_LEAGUE_FULL_NAME})`],
    ['league.season', 'string', 'Подпись сезона, например "2025/26"'],
    ['league.gamesPerTeam', 'number', 'Матчей в регулярном чемпионате на команду (по умолчанию 68)'],
    ['league.salaryCap', 'number', 'Потолок зарплат, ₽ за сезон (по умолчанию 900 000 000)'],
    ['teams[].id', 'string', 'Уникальный идентификатор клуба (латиница)'],
    ['teams[].name / short / city', 'string', 'Название, аббревиатура (3–4 знака), город'],
    ['teams[].conference', 'string', '«Запад» или «Восток» (понимаются также «Восточная конференция», East / West). Если не указано — определяется по дивизиону'],
    ['teams[].division', 'string', 'Необязательное название дивизиона'],
    ['teams[].primaryColor / secondaryColor', 'string', 'Цвета клуба (#RRGGBB) для формы, графиков и резервной эмблемы'],
    ['teams[].logo', 'string', 'Эмблема клуба: путь внутри папки мода (например "logos/ska.png") или URL. Без эмблемы рисуется щит в цветах клуба'],
    ['teams[].budget', 'number', 'Бюджет клуба, ₽ (по умолчанию 1,5 млрд)'],
    ['players[].id', 'string', 'Уникальный идентификатор игрока (если нет — сгенерируется)'],
    ['players[].name', 'string', 'ФИО игрока — единственное обязательное поле'],
    ['players[].position', 'string', 'Ц / ЛК / ПК / З / В (или C / LW / RW / D / G)'],
    ['players[].age', 'number', 'Возраст (18–45)'],
    ['players[].height / weight / number', 'number', 'Рост (см), вес (кг), игровой номер'],
    ['players[].country / hand', 'string', 'Гражданство; хват клюшки L / R (у вратаря — рука с ловушкой; по умолчанию L). Хват виден в 3D-повторах'],
    ['players[].face', 'string', 'Необязательно: ссылка на фото игрока (http/https или путь внутри папки мода). Без фото показываются инициалы в цветах клуба. То же поле понимается у тренеров'],
    ['players[].overall', 'number', 'Общий рейтинг 1–99. Необязателен: считается из skills'],
    ['players[].potential', 'number', 'Потолок развития 1–99 (для игроков до 25 лет)'],
    ['players[].skills', 'object', 'Полевые: skating, shooting, passing, puckControl, checking, defense. Вратари: reflexes, positioning, reboundControl, puckHandling, endurance (1–99)'],
    ['players[].contract', 'object', '{ salary: оклад ₽, years: сезонов, twoWay?: true }. twoWay: true (или type: "двухсторонний") — двусторонний контракт (основа/фарм-клуб ВХЛ) без отказов'],
    ['players[].twoWay', 'boolean', 'true — двусторонний контракт основа/ВХЛ (можно указать прямо у игрока или внутри contract.twoWay); у игроков ≤22 лет по умолчанию true'],
    ['players[].inVhl', 'boolean', 'true — игрок начинает сезон в фарм-клубе ВХЛ (также понимаются "vhl": true или "league": "ВХЛ")'],
    ['players[].nmc', 'boolean', 'true — пункт ЗНО (запрет на обмен и отправку в список отказов)'],
    ['players[].role', 'string', '"C" / "К" — капитан клуба, "A" / "А" — ассистент капитана (необязательно)'],
    ['players[].injury', 'object|null', '{ name: "Травма плеча", days: 14 } или null (поддерживается и старое games)'],
    ['players[].morale', 'number', 'Мораль 20–99 (по умолчанию 72)'],
    ['freeAgents[]', 'array', 'Игроки без контракта — тот же формат, что players[]'],
  ];
  return (
    <div className="space-y-4">
      {!compact && (
        <div className="rounded-md border border-ice/30 bg-ice/5 p-4 text-sm leading-relaxed">
          <b className="text-ice">Лиги подключаются модами: каждая папка в <code className="bg-panel2 px-1 rounded">mods/</code> рядом с <code className="bg-panel2 px-1 rounded">index.html</code> — отдельная лига.</b> Скопируйте папку <code className="bg-panel2 px-1 rounded">mods/KHL_2627</code> под новым именем, поменяйте файлы и добавьте имя папки в <code className="bg-panel2 px-1 rounded">mods/index.json</code> — мод появится в главном меню. Можно и просто выбрать файл ростера вручную на экране загрузки. Рекомендуемый состав клуба: 12–14 нападающих, 6–8 защитников, 2–3 вратаря. Игроки с любым количеством навыков будут дополнены средними значениями.
          <br />
          <b className="text-ice">Версия для Windows:</b> свои моды кладите в <code className="bg-panel2 px-1 rounded">{USER_MODS_DIR}</code> (кнопка «Папка моих модов» под списком модов) — index.json там не нужен, а обновления и переустановка игры эту папку не трогают. Готовым модом можно поделиться: «Предложить свой мод» — архив .zip через форму на GitHub.
        </div>
      )}
      {!compact && <ModFormatDoc />}
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

const MOD_TREE = `mods/
├─ index.json          { "mods": ["KHL_2627", "MyLeague"] }
├─ KHL_2627/
│  ├─ mod.json         название и описание мода
│  ├─ roster.json      лига, клубы, игроки, тренеры
│  ├─ schedule.json    общий календарь регулярного чемпионата
│  └─ logos/           эмблемы клубов (teams[].logo = "logos/ska.png")
└─ MyLeague/ …`;
const SCHEDULE_EXAMPLE = `{
  "season": "2026/27",
  "days": 201,
  "games": [
    { "date": "2026-09-05", "home": "sibir", "away": "cska" },
    { "date": "2026-09-05", "home": "ska", "away": "lokomotiv" }
  ]
}`;

/** How a mod folder is laid out (the «Формат JSON» page). */
function ModFormatDoc() {
  const rows: [string, string][] = [
    ['mod.json', 'Необязательно. { "name", "description", "author", "version", "roster": "roster.json", "schedule": "schedule.json" }. Без него мод называется по имени папки'],
    ['roster.json', 'Лига, клубы, игроки и свободные тренеры — поля описаны ниже. Название лиги берётся из league.name'],
    ['schedule.json', 'Один календарь на всю лигу: games[] с датой (ГГГГ-ММ-ДД), id хозяев и гостей. Сезон начинается 1 сентября; days — длина регулярки в днях (с паузами). Клуб не может играть дважды в день. Нет файла — календарь составит игра. Плей-офф и следующие сезоны игра строит сама'],
    ['logos/', 'Эмблемы клубов (PNG с прозрачностью, лучше 160×160 и больше). Пути в roster.json — относительно папки мода'],
    ['index.json', 'Список папок модов. Браузер не умеет читать содержимое папки, поэтому новый мод нужно вписать сюда (при сборке игры список обновляется сам; в версии для Windows папки из «Документы\\Hockey Simulator Manager\\mods» находятся без него)'],
  ];
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" data-mod-format>
      <Panel title="Папка мода">
        <pre className="text-[11.5px] leading-relaxed overflow-x-auto text-ice/90 font-mono -mt-1">{MOD_TREE}</pre>
        <ul className="text-xs space-y-1.5 mt-3">
          {rows.map(([f, d]) => (
            <li key={f}>
              <code className="font-mono text-ice">{f}</code> — <span className="text-text/90">{d}</span>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Календарь schedule.json" noPad>
        <pre className="text-[11.5px] leading-relaxed p-4 overflow-x-auto text-ice/90 font-mono">{SCHEDULE_EXAMPLE}</pre>
      </Panel>
    </div>
  );
}

/** Mods found in mods/: pick the league to start a career in. */
function ModPicker({ mods, current, busy, onPick, onFile, onReload }: { mods: ModEntry[]; current: string; busy: boolean; onPick: (m: ModEntry) => void; onFile: () => void; onReload: () => void }) {
  const desktop = canOpenModsFolder();
  return (
    <div className="mb-4" data-mod-picker>
      <div className="text-[11px] uppercase tracking-wider text-muted mb-1.5">Мод (лига)</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {mods.map((m) => (
          <button
            key={m.id}
            type="button"
            disabled={busy}
            onClick={() => onPick(m)}
            data-mod={m.id}
            className={cn('flex items-start gap-3 p-3 rounded-md border text-left transition-all duration-150 hover:bg-panel2 disabled:opacity-60', current === m.id ? 'border-accent bg-accent/10 ring-1 ring-accent/50' : 'border-line bg-panel2/40')}
          >
            {m.cover ? (
              <img src={m.cover} alt="" className="w-10 h-10 object-contain shrink-0" />
            ) : (
              <span className="w-10 h-10 shrink-0 rounded-sm bg-panel border border-line flex items-center justify-center font-display text-sm text-ice uppercase">{m.name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 3)}</span>
            )}
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <b className="truncate">{m.name}</b>
                {current === m.id && <Icon name="check" className="text-accent shrink-0" />}
              </span>
              {m.description && <span className="block text-xs text-muted mt-0.5">{m.description}</span>}
              <span className="block text-[10.5px] text-muted/80 mt-1 font-mono truncate">
                {m.legacy ? 'roster.json' : `mods/${m.id}`}
                {m.author ? ` · ${m.author}` : ''}
                {m.version ? ` · v${m.version}` : ''}
              </span>
            </span>
          </button>
        ))}
        <button
          type="button"
          disabled={busy}
          onClick={onFile}
          data-mod="file"
          className={cn('flex items-center gap-3 p-3 rounded-md border border-dashed text-left transition-all duration-150 hover:bg-panel2 disabled:opacity-60', current === '' ? 'border-accent bg-accent/10' : 'border-line')}
        >
          <span className="w-10 h-10 shrink-0 rounded-sm border border-line flex items-center justify-center text-muted text-lg">⤒</span>
          <span className="min-w-0">
            <b>Свой файл ростера…</b>
            <span className="block text-xs text-muted mt-0.5">roster.json с компьютера, без установки мода</span>
          </span>
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-2 text-xs" data-mod-links>
        <a href={MOD_SUBMIT_URL} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-ice hover:underline" data-mod-submit title="Форма на GitHub: прикрепите архив .zip с папкой мода — после проверки мод может войти в игру (нужен аккаунт GitHub)">
          <Icon name="plus" /> Предложить свой мод ↗
        </a>
        {desktop && (
          <>
            <button type="button" className="inline-flex items-center gap-1 text-ice hover:underline" onClick={() => void openModsFolder()} data-mod-folder title={`Свои моды кладите в ${USER_MODS_DIR}: обновления игры эту папку не трогают`}>
              <Icon name="folder" /> Папка моих модов
            </button>
            <button type="button" className="inline-flex items-center gap-1 text-muted hover:text-text hover:underline" onClick={onReload} disabled={busy} data-mod-reload>
              Обновить список
            </button>
          </>
        )}
        <span className="text-muted/80">
          {desktop ? <>Свои моды: <code className="font-mono">{USER_MODS_DIR}</code> — при обновлении игры не удаляются.</> : 'Архив .zip с папкой мода — разработчик проверит и добавит его в игру.'}
        </span>
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

/** Shown under the club list once a club is picked: staff, units, stars with photos. */
function ClubPreview({ roster, team }: { roster: NormalizedRoster; team: Team }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  }, [team.id]);
  return (
    <div ref={ref}>
      <Panel
        title={
          <span className="flex items-center gap-2 min-w-0">
            <TeamLogo team={team} size={22} />
            <span className="truncate">{team.name}</span>
          </span>
        }
        right={<span className="text-xs text-muted">{team.city} · {team.conference}{team.division ? ` · ${team.division}` : ''}</span>}
        data-club-preview={team.id}
      >
        <ClubOverview team={team} P={roster.players} teams={roster.teams} chip={(p) => <OverallChip value={p.overall} size="sm" />} salaryCap={roster.salaryCap} />
      </Panel>
    </div>
  );
}

function TeamSelect({ roster, onStart }: { roster: NormalizedRoster; onStart: (teamId: string) => void }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [confFilter, setConfFilter] = useState<'Все' | 'Запад' | 'Восток'>('Все');
  const confs = (['Запад', 'Восток'] as const).filter((c) => confFilter === 'Все' || confFilter === c);
  const team = chosen ? roster.teams.find((t) => t.id === chosen) : null;
  return (
    <div className="space-y-4">
      <div className="md:hidden inline-flex rounded-sm border border-line bg-panel p-0.5 w-full">
        {(['Все', 'Запад', 'Восток'] as const).map((cf) => (
          <button
            key={cf}
            type="button"
            onClick={() => setConfFilter(cf)}
            className={cn(
              'flex-1 py-1.5 text-xs font-semibold rounded-sm transition-colors',
              confFilter === cf ? 'bg-accent text-white' : 'text-muted hover:text-text'
            )}
          >
            {cf === 'Все' ? 'Обе конференции' : cf}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {confs.map((c) => (
          <Panel key={c} title={`Конференция «${c}»`} noPad>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-2.5 sm:p-3">
              {roster.teams
                .filter((t) => t.conference === c)
                .map((t) => {
                  const s = strength(roster, t.id);
                  return (
                    <button
                      key={t.id}
                      onClick={() => setChosen(t.id)}
                      className={cn('flex items-center gap-2.5 sm:gap-3 p-2.5 sm:p-3 rounded-md border text-left transition-all duration-150 hover:bg-panel2', chosen === t.id ? 'border-accent bg-accent/10 ring-1 ring-accent/50' : 'border-line bg-panel2/40')}
                    >
                      <TeamLogo team={t} size={40} />
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold truncate">{t.name}</div>
                        <div className="text-xs text-muted truncate">{t.city}</div>
                        <div className="text-[11px] text-muted mt-0.5 truncate">
                          {t.players.length} игр.
                          {t.players.some((pid) => roster.players[pid]?.inVhl) ? ` (ВХЛ ${t.players.filter((pid) => roster.players[pid]?.inVhl).length})` : ''} · ФОТ{' '}
                          {formatMoney(effectivePayroll(t, roster.players, 'season'))}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
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
      {team && <ClubPreview roster={roster} team={team} />}
      {roster.warnings.length > 0 && (
        <Panel title={`Предупреждения ростера (${roster.warnings.length})`}>
          <ul className="text-xs text-amber/90 space-y-1 max-h-32 overflow-y-auto">
            {roster.warnings.map((w, i) => (
              <li key={i}>• {w}</li>
            ))}
          </ul>
        </Panel>
      )}
      <div className="sticky bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-10">
        <div className="bg-panel2/95 backdrop-blur border border-line rounded-md p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 sm:gap-4 shadow-xl">
          <div className="text-xs sm:text-sm text-muted">{team ? <>Выбран клуб: <b className="text-text">{team.name}</b>. Сезон {roster.season}, {roster.gamesPerTeam} матчей.</> : 'Выберите клуб, которым будете управлять'}</div>
          <Button variant="primary" size="lg" className="w-full sm:w-auto" disabled={!team} onClick={() => team && onStart(team.id)}>
            Начать карьеру
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Startup({ onStart }: { onStart: (r: NormalizedRoster, teamId: string) => void }) {
  const ui = useUI();
  const [saveCount, setSaveCount] = useState<number | null>(null);
  const [stage, setStage] = useState<'loading' | 'error' | 'select' | 'format'>('loading');
  const [roster, setRoster] = useState<NormalizedRoster | null>(null);
  const [err, setErr] = useState('');
  const [fileErr, setFileErr] = useState('');
  const [contractMsg, setContractMsg] = useState('');
  const [mods, setMods] = useState<ModEntry[] | null>(null);
  /** id of the mod on screen; '' — a roster file picked by hand */
  const [modId, setModId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const loadSeq = useRef(0);

  const openMod = (m: ModEntry) => {
    const seq = ++loadSeq.current;
    setModId(m.id);
    setStage('loading');
    setErr('');
    setFileErr('');
    setContractMsg('');
    loadMod(m)
      .then((r) => {
        if (seq !== loadSeq.current) return;
        rememberMod(m.id);
        setRoster(r);
        setStage('select');
      })
      .catch((e: Error) => {
        if (seq !== loadSeq.current) return;
        setRoster(null);
        setErr(e?.message ?? String(e));
        setStage('error');
      });
  };
  const load = () => {
    setStage('loading');
    setErr('');
    listMods()
      .then((list) => {
        setMods(list);
        const want = modId || lastModId();
        const m = list.find((x) => x.id === want) ?? list[0];
        if (m) openMod(m);
        else {
          setErr('в папке mods не найдено ни одного мода');
          setStage('error');
        }
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
      ++loadSeq.current;
      setRoster(r);
      setModId('');
      setFileErr('');
      setContractMsg('');
      setStage('select');
    } catch (e) {
      setFileErr((e as Error).message);
    }
  };
  const currentMod = mods?.find((m) => m.id === modId);
  const rosterFileName = currentMod ? (currentMod.legacy ? 'roster.json' : `mods/${currentMod.id}/${currentMod.roster}`) : 'roster.json';

  return (
    <div className="relative min-h-screen rink-lines overflow-hidden">
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse at 50% -10%, rgba(229,50,62,.14), transparent 55%)' }} />
      <div className="relative max-w-6xl mx-auto px-3 sm:px-4 py-5 sm:py-8 md:py-12">
        <header className="relative -mx-3 sm:-mx-4 md:mx-0 mb-6 sm:mb-8 md:rounded-md overflow-hidden border-0 md:border border-line bg-cover bg-center" style={{ backgroundImage: `url(${arena})`, backgroundPosition: 'center 55%' }}>
          <div className="absolute inset-0 bg-gradient-to-r from-bg via-bg/85 to-bg/25" />
          <div className="absolute top-3 right-3 z-10 flex gap-2">
            {platform() === 'web' && (
              <a href={APP_RELEASE} target="_blank" rel="noopener" title={`${GAME_NAME_RU} для Windows и Android: отдельное окно, видеокарта всегда включена`} className="hidden sm:inline-flex items-center gap-1.5 px-2 py-1 rounded-sm border border-line text-xs text-muted hover:text-text bg-bg/70 backdrop-blur" data-startup-apps>
                ⤓ Приложения
              </a>
            )}
            <button type="button" onClick={() => ui.openSettings()} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-sm border border-line text-xs text-muted hover:text-text bg-bg/70 backdrop-blur" data-startup-settings>
              <Icon name="settings" /> Настройки
            </button>
            <FullscreenButton label className="bg-bg/70 backdrop-blur" />
          </div>
          <div className="relative px-4 sm:px-6 md:px-10 pt-14 pb-6 sm:py-8 md:py-10">
            <div className="flex items-center gap-3 sm:gap-5">
              <img src={gameLogo} alt="" className="w-16 h-16 sm:w-24 sm:h-24 md:w-32 md:h-32 object-contain shrink-0 drop-shadow-[0_4px_18px_rgba(0,0,0,0.6)]" data-game-logo />
              <div className="min-w-0">
                <p className="text-ice font-display uppercase tracking-[0.2em] sm:tracking-[0.3em] text-[11px] sm:text-xs">{GAME_NAME_EN}</p>
                <h1 className="font-display text-3xl sm:text-4xl md:text-6xl font-bold uppercase leading-[0.95] mt-1 sm:mt-1.5">
                  Хоккейный симулятор <span className="text-accent">менеджера</span>
                </h1>
              </div>
            </div>
            <p className="text-muted mt-3 sm:mt-4 max-w-2xl text-xs sm:text-sm md:text-base">Возьмите под управление хоккейный клуб: собирайте звенья, проводите обмены, ведите команду через регулярный чемпионат и плей-офф. Лиги подключаются модами из папки <code className="bg-panel2 px-1.5 py-0.5 rounded text-ice">mods</code> — выберите мод и клуб ниже.</p>
            <div className="flex flex-wrap gap-1.5 sm:gap-2 mt-4 sm:mt-5">
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
              <p className="text-sm text-muted mt-1.5">Выберите мод и клуб — новая карьера займёт отдельный слот и не затронет существующие сохранения.</p>
            </div>
            {mods && <ModPicker mods={mods} current={modId ?? ''} busy={stage === 'loading'} onPick={openMod} onFile={() => fileRef.current?.click()} onReload={load} />}
            <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { if (e.target.files?.[0]) void onFile(e.target.files[0]); e.target.value = ''; }} />
          </>
        )}

        {stage === 'loading' && (
          <Panel>
            <div className="flex items-center gap-3 py-6 justify-center text-muted">
              <Spinner />
              {currentMod ? `Загрузка мода «${currentMod.name}»…` : 'Загрузка модов…'}
            </div>
          </Panel>
        )}

        {stage === 'error' && (
          <Panel title={currentMod ? `Мод «${currentMod.name}» не загрузился` : 'Моды не найдены'}>
            <div className="space-y-4 text-sm">
              <div className="rounded-md bg-accent/10 border border-accent/30 p-3 text-text">
                <b>Ошибка:</b> <span className="font-mono text-xs">{err}</span>
              </div>
              <ol className="list-decimal pl-5 space-y-1.5 text-text/90">
                <li>
                  Проверьте, что в папке <code className="bg-panel2 px-1.5 py-0.5 rounded text-ice">mods</code> рядом с <code className="bg-panel2 px-1.5 py-0.5 rounded text-ice">index.html</code> есть папка мода с файлом <code className="bg-panel2 px-1.5 py-0.5 rounded text-ice">roster.json</code> и что она указана в <code className="bg-panel2 px-1.5 py-0.5 rounded text-ice">mods/index.json</code>, затем нажмите «Повторить».
                </li>
                <li>Или выберите другой мод выше либо файл ростера вручную — он будет загружен прямо в браузере.</li>
                <li>Устройство мода и полей файла смотрите на вкладке «Формат JSON»; там же можно скачать пример.</li>
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
                Лига «{roster.leagueName}» · сезон {roster.season} · {roster.teams.length} команд · {Object.keys(roster.players).length} игроков · {roster.schedule ? 'календарь из мода' : 'календарь составлен игрой'}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setStage('format')}>
                  Формат JSON
                </Button>
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
                      setContractMsg(res === 'saved' ? `Файл записан. Если вы сохранили его поверх ${rosterFileName}, контракты уже в ростере.` : res === 'downloaded' ? `Файл roster.json скачан — замените им ${rosterFileName} в папке с игрой.` : '');
                    }}
                  >
                    Сохранить roster.json с контрактами
                  </Button>
                  <span className="text-xs text-muted flex-1 min-w-[220px]">Браузер не даёт странице молча изменить файл на диске, поэтому он попросит указать, куда сохранить: выберите {rosterFileName} в папке с игрой. Остальные данные файла не меняются.</span>
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
