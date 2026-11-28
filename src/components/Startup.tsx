import { APP_RELEASE, canInstallMods, canOpenModsFolder, desktopModInstall, installModArchive, MOD_SUBMIT_URL, modInstallPlace, openModsFolder, platform, USER_MODS_DIR, userModsDir } from '../platform';
import { removeStoredMod } from '../game/modStore';
import type { ModInstallResult } from '../platform';
import { useEffect, useMemo, useRef, useState } from 'react';
// served next to index.html instead of being inlined into the script
const arena = './arena.jpg';
const gameLogo = './icon-game.png';
import { downloadExampleRoster, readLocalFile, ROSTER_EXAMPLE, rosterWithContracts, saveRosterFile } from '../game/roster';
import { DEFAULT_MOD_ID, lastModId, listMods, loadMod, rememberMod } from '../game/mods';
import type { ModEntry } from '../game/mods';
import { DEFAULT_FARM_NAME, DEFAULT_LEAGUE_FULL_NAME, DEFAULT_LEAGUE_NAME, GAME_NAME_EN, GAME_NAME_RU } from '../brand';
import type { NormalizedRoster } from '../game/roster';
import { effectivePayroll } from '../game/cap';
import { formatMoney, isGoalie, isSkater } from '../game/ratings';
import { cn } from '../utils/cn';
import { Button, Icon, Modal, OverallChip, Panel, Spinner, TeamLogo, useUI } from './ui';
import { ClubOverview } from './TeamInfo';
import type { Team } from '../types';
import { FullscreenButton } from './FullscreenButton';
import { SavesList } from './Saves';

export function FormatDoc({ compact }: { compact?: boolean }) {
  const rows: [string, string, string][] = [
    ['league.name', 'string', `Название лиги, показывается в игре (по умолчанию «${DEFAULT_LEAGUE_NAME}» — ${DEFAULT_LEAGUE_FULL_NAME})`],
    ['league.farm', 'string', `Обязательно: название второй (фарм) лиги, куда клубы командируют игроков по двусторонним контрактам, например "farm": "ВХЛ". Без него ростер получит предупреждение, а в игре будет «${DEFAULT_FARM_NAME}»`],
    ['league.season', 'string', 'Подпись сезона, например "2025/26"'],
    ['league.gamesPerTeam', 'number', 'Матчей в регулярном чемпионате на команду (по умолчанию 68)'],
    ['league.salaryCap', 'number', 'Потолок зарплат, ₽ за сезон (по умолчанию 900 000 000)'],
    ['teams[].id', 'string', 'Уникальный идентификатор клуба (латиница)'],
    ['teams[].name / short / city', 'string', 'Название, аббревиатура (3–4 знака), город'],
    ['teams[].conference', 'string', '«Запад» или «Восток» (понимаются также «Восточная конференция», East / West). Если не указано — определяется по дивизиону'],
    ['teams[].division', 'string', 'Необязательное название дивизиона'],
    ['teams[].primaryColor / secondaryColor', 'string', 'Цвета клуба (#RRGGBB) для формы, графиков и резервной эмблемы'],
    ['teams[].logo', 'string', 'Эмблема клуба: путь внутри папки мода (например "logos/vyuga.svg") или URL. Без эмблемы рисуется щит в цветах клуба'],
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
    ['players[].contract', 'object', '{ salary: оклад ₽, years: сезонов, twoWay?: true }. twoWay: true (или type: "двухсторонний") — двусторонний контракт (основа/фарм-клуб второй лиги) без отказов'],
    ['players[].twoWay', 'boolean', 'true — двусторонний контракт основа/фарм (можно указать прямо у игрока или внутри contract.twoWay); у игроков ≤22 лет по умолчанию true'],
    ['players[].inVhl', 'boolean', 'true — игрок начинает сезон в фарм-клубе второй лиги (также понимаются "farm": true, "vhl": true или "league": название второй лиги)'],
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
          <b className="text-ice">Лиги подключаются модами: каждая папка в <code className="bg-panel2 px-1 rounded">mods/</code> рядом с <code className="bg-panel2 px-1 rounded">index.html</code> — отдельная лига.</b> Встроенной лиги в игре нет: создайте папку мода (например, <code className="bg-panel2 px-1 rounded">mods/MyLeague</code>) с файлом roster.json или скопируйте папку готового мода под новым именем, поменяйте файлы и добавьте имя папки в <code className="bg-panel2 px-1 rounded">mods/index.json</code> — мод появится в главном меню. Можно и просто выбрать файл ростера вручную на экране загрузки. Рекомендуемый состав клуба: 12–14 нападающих, 6–8 защитников, 2–3 вратаря. Игроки с любым количеством навыков будут дополнены средними значениями.
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
├─ index.json          { "mods": ["MyLeague", "OtherLeague"] }
├─ MyLeague/
│  ├─ mod.json         название и описание мода
│  ├─ roster.json      лига, клубы, игроки, тренеры
│  ├─ schedule.json    общий календарь регулярного чемпионата
│  └─ logos/           эмблемы клубов (teams[].logo = "logos/vyuga.svg")
└─ OtherLeague/ …`;
const SCHEDULE_EXAMPLE = `{
  "season": "2026/27",
  "days": 201,
  "games": [
    { "date": "2026-09-05", "home": "kedry", "away": "groza" },
    { "date": "2026-09-05", "home": "vyuga", "away": "tsunami" }
  ]
}`;

/** How a mod folder is laid out (the «Формат JSON» page). */
function ModFormatDoc() {
  const rows: [string, string][] = [
    ['mod.json', 'Необязательно. { "name", "description", "author", "version", "roster": "roster.json", "schedule": "schedule.json" }. Без него мод называется по имени папки'],
    ['roster.json', 'Лига, клубы, игроки и свободные тренеры — поля описаны ниже. Названия лиг берутся из league.name и league.farm (вторая, фарм-лига — обязательно)'],
    ['schedule.json', 'Один календарь на всю лигу: games[] с датой (ГГГГ-ММ-ДД), id хозяев и гостей. Сезон начинается 1 сентября; days — длина регулярки в днях (с паузами). Клуб не может играть дважды в день. Нет файла — календарь составит игра. Плей-офф и следующие сезоны игра строит сама'],
    ['logos/', 'Эмблемы клубов (PNG с прозрачностью, лучше 160×160 и больше). Пути в roster.json — относительно папки мода'],
    ['index.json', 'Список папок модов. Браузер не умеет читать содержимое папки, поэтому новый мод нужно вписать сюда (при сборке игры список обновляется сам; в версии для Windows папки из «mods» рядом с игрой находятся без него — туда же распаковывает архив кнопка «Установить мод»)'],
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

/** Mods found in mods/: pick the league to start a career in. Install a mod from a .zip (button or drag-and-drop): into the mods folder in the Windows app, into the game's storage in the browser and on Android. */
function ModPicker({ mods, current, busy, onPick, onFile, onReload, onInstalled }: { mods: ModEntry[]; current: string; busy: boolean; onPick: (m: ModEntry) => void; onFile: () => void; onReload: () => void; onInstalled: (id: string) => void }) {
  const desktop = canOpenModsFolder();
  const installer = canInstallMods();
  const [dir, setDir] = useState(USER_MODS_DIR);
  const [drag, setDrag] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<ModInstallResult | null>(null);
  const place = modInstallPlace();
  // the browser / Android pick the archive with a file input (the Windows app opens its own dialog)
  const zipRef = useRef<HTMLInputElement>(null);
  const viaInput = installer && !desktopModInstall();
  const remove = async (m: ModEntry) => {
    if (!window.confirm(`Удалить мод «${m.name}» с этого устройства? Карьеры на нём останутся, но без логотипов и фото, пока мод не будет установлен снова.`)) return;
    try { await removeStoredMod(m.id); } catch (e) { setResult({ installed: [], errors: [String((e as Error)?.message ?? e)], dir: '' }); }
    onReload();
  };
  useEffect(() => {
    if (desktop) void userModsDir().then((d) => d && setDir(d));
  }, [desktop]);
  const install = async (files?: File[]) => {
    if (!installer || installing) return;
    setInstalling(true);
    setResult(null);
    try {
      const all: ModInstallResult = { installed: [], errors: [], dir: viaInput ? '' : dir };
      for (const f of files?.length ? files : [undefined]) {
        const r = await installModArchive(f);
        if (!r) continue;
        all.installed.push(...r.installed);
        all.errors.push(...r.errors);
        if (r.dir) all.dir = r.dir;
      }
      if (all.installed.length || all.errors.length) setResult(all);
      if (all.dir) setDir(all.dir);
      if (all.installed.length) onInstalled(all.installed[all.installed.length - 1].id);
    } finally {
      setInstalling(false);
    }
  };
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  return (
    <div
      className={cn('mb-4 relative rounded-md', drag && 'ring-2 ring-ice ring-offset-4 ring-offset-bg')}
      data-mod-picker
      onDragOver={installer ? (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDrag(true); } : undefined}
      onDragLeave={installer ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false); } : undefined}
      onDrop={installer ? (e) => { if (!hasFiles(e)) return; e.preventDefault(); setDrag(false); void install(Array.from(e.dataTransfer.files)); } : undefined}
    >
      {drag && (
        <div className="absolute inset-0 z-10 rounded-md bg-bg/85 border-2 border-dashed border-ice flex flex-col items-center justify-center gap-1 pointer-events-none" data-mod-dropzone>
          <span className="text-3xl text-ice">⤓</span>
          <b className="text-ice">Отпустите архив .zip — мод установится {place}</b>
        </div>
      )}
      <div className="text-[11px] uppercase tracking-wider text-muted mb-1.5">Мод (лига)</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {mods.map((m) => (
          <div key={m.id} className="relative flex">
          <button
            type="button"
            disabled={busy}
            onClick={() => onPick(m)}
            data-mod={m.id}
            className={cn('flex-1 min-w-0 flex items-start gap-3 p-3 rounded-md border text-left transition-all duration-150 hover:bg-panel2 disabled:opacity-60', m.stored && 'pr-9', current === m.id ? 'border-accent bg-accent/10 ring-1 ring-accent/50' : 'border-line bg-panel2/40')}
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
                {m.legacy ? 'roster.json' : m.stored ? `${platform() === 'android' ? 'в приложении' : 'в браузере'} · ${m.id}` : `mods/${m.id}`}
                {m.author ? ` · ${m.author}` : ''}
                {m.version ? ` · v${m.version}` : ''}
              </span>
            </span>
          </button>
          {m.stored && (
            <button type="button" disabled={busy} onClick={() => void remove(m)} className="absolute top-1.5 right-1.5 w-7 h-7 rounded-sm text-muted hover:text-red hover:bg-red/10 disabled:opacity-50 flex items-center justify-center" title="Удалить мод с этого устройства" aria-label={`Удалить мод ${m.name}`} data-mod-remove={m.id}>
              ✕
            </button>
          )}
          </div>
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
        {installer && (
          <button
            type="button"
            disabled={busy || installing}
            onClick={() => (viaInput ? zipRef.current?.click() : void install())}
            data-mod-install
            title={`Выберите архив .zip с модом (или перетащите его сюда) — игра распакует его ${place}`}
            className="flex items-center gap-3 p-3 rounded-md border border-dashed border-ice/50 text-left transition-all duration-150 hover:bg-panel2 hover:border-ice disabled:opacity-60"
          >
            <span className="w-10 h-10 shrink-0 rounded-sm border border-ice/50 flex items-center justify-center text-ice text-lg">{installing ? <Spinner /> : '⤓'}</span>
            <span className="min-w-0">
              <b>{installing ? 'Устанавливаю мод…' : 'Установить мод…'}</b>
              <span className="block text-xs text-muted mt-0.5">{platform() === 'android' ? 'архив .zip из «Загрузок» или любой папки телефона' : 'архив .zip — кнопкой или перетащите на этот список'}</span>
            </span>
          </button>
        )}
      </div>
      {viaInput && <input ref={zipRef} type="file" accept={platform() === 'android' ? undefined : '.zip,application/zip,application/x-zip-compressed'} className="hidden" data-mod-install-file onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void install([f]); }} />}
      {result && (
        <div className={cn('mt-2 rounded-sm border px-3 py-2 text-xs flex items-start justify-between gap-2', result.errors.length ? 'border-red/50 bg-red/10' : 'border-ok/50 bg-ok/10')} data-mod-install-result>
          <div className="space-y-0.5 min-w-0">
            {result.installed.map((m) => (
              <div key={m.id}>
                ✓ {m.replaced ? 'Обновлён' : 'Установлен'} мод <b className="text-text">{m.name}</b> → {result.dir ? <code className="font-mono break-all">{`mods\\${m.id}`}</code> : place}
              </div>
            ))}
            {result.errors.map((e, i) => (
              <div key={i} className="text-red">⛔ {e}</div>
            ))}
          </div>
          <button type="button" onClick={() => setResult(null)} className="text-muted hover:text-text px-1 shrink-0" aria-label="Закрыть">✕</button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-2 text-xs" data-mod-links>
        <a href={MOD_SUBMIT_URL} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-ice hover:underline" data-mod-submit title="Форма на GitHub: прикрепите архив .zip с папкой мода — после проверки мод может войти в игру (нужен аккаунт GitHub)">
          <Icon name="plus" /> Предложить свой мод ↗
        </a>
        {desktop && (
          <>
            <button type="button" className="inline-flex items-center gap-1 text-ice hover:underline" onClick={() => void openModsFolder()} data-mod-folder title={`Свои моды: ${dir} — обновления игры эту папку не трогают`}>
              <Icon name="folder" /> Папка моих модов
            </button>
            <button type="button" className="inline-flex items-center gap-1 text-muted hover:text-text hover:underline" onClick={onReload} disabled={busy} data-mod-reload>
              Обновить список
            </button>
          </>
        )}
        <span className="text-muted/80">
          {desktop ? <>Свои моды: <code className="font-mono break-all" data-mod-dir>{dir}</code> — при обновлении игры не удаляются.</> : 'Архив .zip с папкой мода — разработчик проверит и добавит его в игру.'}
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

/** Strength rank → how hard the club is to manage: the top third are favourites, the bottom third underdogs. */
function tierOf(rank: number, n: number): { label: string; hint: string; color: string } {
  if (rank <= Math.ceil(n / 3)) return { label: 'Фаворит', hint: 'борьба за кубок с первого сезона', color: '#E5323E' };
  if (rank <= Math.ceil((2 * n) / 3)) return { label: 'Середняк', hint: 'плей-офф — реальная цель', color: '#8FD8F0' };
  return { label: 'Аутсайдер', hint: 'трудный старт: строить команду с нуля', color: '#93A4BC' };
}

type TeamSort = 'conf' | 'strength' | 'name' | 'budget';
const SORTS: [TeamSort, string][] = [['conf', 'По конференциям'], ['strength', 'По силе'], ['name', 'А–Я'], ['budget', 'По бюджету']];

/** The picked club: staff, units, stars with photos (one column — the side panel or a sheet on a phone). */
function ClubPreview({ roster, team, rank, n, compact }: { roster: NormalizedRoster; team: Team; rank: number; n: number; compact?: boolean }) {
  const tier = tierOf(rank, n);
  return (
    <div data-club-preview={team.id}>
      <div className="flex items-center gap-3 mb-3">
        <TeamLogo team={team} size={56} />
        <div className="min-w-0 flex-1">
          <div className="font-display text-2xl uppercase leading-none truncate">{team.name}</div>
          <div className="text-xs text-muted mt-1 truncate">{team.city} · {team.conference}{team.division ? ` · ${team.division}` : ''}</div>
          <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded-sm border" style={{ color: tier.color, borderColor: `${tier.color}66`, background: `${tier.color}14` }}>{tier.label}</span>
            <span className="text-[11px] text-muted">{tier.hint}</span>
          </div>
        </div>
      </div>
      <ClubOverview team={team} P={roster.players} teams={roster.teams} chip={(p) => <OverallChip value={p.overall} size="sm" />} salaryCap={roster.salaryCap} compact={compact} />
    </div>
  );
}

function TeamSelect({ roster, onStart }: { roster: NormalizedRoster; onStart: (teamId: string) => void }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [conf, setConf] = useState<string>('');
  const [sort, setSort] = useState<TeamSort>('conf');
  const [query, setQuery] = useState('');
  const [sheet, setSheet] = useState(false);
  const confs = useMemo(() => [...new Set(roster.teams.map((t) => t.conference))].filter(Boolean), [roster]);
  const power = useMemo(() => {
    const m = new Map(roster.teams.map((t) => [t.id, strength(roster, t.id)]));
    const order = [...roster.teams].sort((a, b) => m.get(b.id)! - m.get(a.id)!);
    return { of: (id: string) => m.get(id) ?? 0, rank: (id: string) => order.findIndex((t) => t.id === id) + 1 };
  }, [roster]);
  const n = roster.teams.length;
  const payroll = (t: Team) => effectivePayroll(t, roster.players, 'season');
  const q = query.trim().toLowerCase();
  const shown = roster.teams
    .filter((t) => !conf || t.conference === conf)
    .filter((t) => !q || [t.name, t.city, t.short].some((x) => x?.toLowerCase().includes(q)));
  const sorted = [...shown].sort((a, b) =>
    sort === 'name' ? a.name.localeCompare(b.name, 'ru') : sort === 'budget' ? b.budget - a.budget : sort === 'strength' ? power.of(b.id) - power.of(a.id) : 0
  );
  const groups: { title: string | null; teams: Team[] }[] =
    sort === 'conf' && !conf && confs.length > 1 ? confs.map((c) => ({ title: `Конференция «${c}»`, teams: sorted.filter((t) => t.conference === c) })).filter((g) => g.teams.length) : [{ title: null, teams: sorted }];
  const team = chosen ? roster.teams.find((t) => t.id === chosen) ?? null : null;
  const pickRandom = () => {
    const pool = shown.length ? shown : roster.teams;
    const t = pool[Math.floor(Math.random() * pool.length)];
    if (t) setChosen(t.id);
  };
  const seg = (on: boolean) => cn('px-2.5 py-1.5 text-xs font-semibold rounded-sm transition-colors whitespace-nowrap', on ? 'bg-accent text-white' : 'text-muted hover:text-text');
  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-4 lg:items-start" data-team-select>
      <div className="space-y-3 min-w-0">
        <div className="flex flex-wrap items-center gap-2" data-team-tools>
          <label className="relative flex-1 min-w-[180px]">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"><Icon name="search" /></span>
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Клуб или город" className="w-full bg-panel border border-line rounded-sm pl-8 pr-2.5 py-2 text-sm placeholder:text-muted/70 focus:outline-none focus:border-ice" data-team-search aria-label="Поиск клуба" />
          </label>
          {confs.length > 1 && (
            <div className="inline-flex rounded-sm border border-line bg-panel p-0.5" role="group" aria-label="Конференция">
              {['', ...confs].map((c) => (
                <button key={c || 'all'} type="button" onClick={() => setConf(c)} className={seg(conf === c)} aria-pressed={conf === c}>
                  {c || 'Все'}
                </button>
              ))}
            </div>
          )}
          <select value={sort} onChange={(e) => setSort(e.target.value as TeamSort)} className="bg-panel border border-line rounded-sm px-2 py-2 text-xs text-text focus:outline-none focus:border-ice" aria-label="Сортировка" data-team-sort>
            {SORTS.map(([id, l]) => <option key={id} value={id}>{l}</option>)}
          </select>
          <button type="button" onClick={pickRandom} className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-sm border border-line bg-panel text-xs text-muted hover:text-text" title="Выбрать случайный клуб" data-team-random>
            <Icon name="dice" /> Случайный
          </button>
        </div>
        {groups.map((g) => (
          <section key={g.title ?? 'all'}>
            {g.title && <h3 className="text-[11px] uppercase tracking-[0.18em] text-muted font-semibold mb-1.5 mt-1">{g.title}</h3>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {g.teams.map((t) => {
                const st = power.of(t.id), rank = power.rank(t.id), tier = tierOf(rank, n), farm = t.players.filter((pid) => roster.players[pid]?.inVhl).length;
                const on = chosen === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setChosen(t.id)}
                    onDoubleClick={() => onStart(t.id)}
                    aria-pressed={on}
                    data-team-card={t.id}
                    className={cn('group flex items-center gap-2.5 p-2.5 rounded-md border text-left transition-all duration-150 hover:bg-panel2', on ? 'border-accent bg-accent/10 ring-1 ring-accent/50' : 'border-line bg-panel/70')}
                  >
                    <TeamLogo team={t} size={40} />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold truncate">{t.name}</div>
                      <div className="text-xs text-muted truncate">{t.city}</div>
                      <div className="text-[11px] text-muted mt-0.5 truncate">
                        <span style={{ color: tier.color }}>{tier.label}</span> · {t.players.length - farm} игр.{farm ? ` + ${farm} ${roster.farmName}` : ''} · ФОТ {formatMoney(payroll(t))}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-display text-xl tabular leading-none" style={{ color: st >= 80 ? '#E5323E' : st >= 77 ? '#8FD8F0' : '#E8EEF5' }}>{st}</div>
                      <div className="text-[10px] uppercase tracking-wider text-muted mt-0.5">№{rank}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        {!shown.length && <div className="rounded-md border border-dashed border-line p-6 text-center text-sm text-muted">Ничего не найдено{q ? ` по запросу «${query.trim()}»` : ''}.</div>}
        {roster.warnings.length > 0 && (
          <Panel title={`Предупреждения ростера (${roster.warnings.length})`}>
            <ul className="text-xs text-amber/90 space-y-1 max-h-32 overflow-y-auto">
              {roster.warnings.map((w, i) => (
                <li key={i}>• {w}</li>
              ))}
            </ul>
          </Panel>
        )}
      </div>

      {/* wide screens: the picked club stays in view next to the list, with the start button */}
      <aside className="hidden lg:flex flex-col sticky top-4 max-h-[calc(100vh-2rem)] rounded-md border border-line bg-panel/90 backdrop-blur overflow-hidden" data-club-side>
        {team ? (
          <>
            <div className="flex-1 min-h-0 overflow-y-auto p-4">
              <ClubPreview roster={roster} team={team} rank={power.rank(team.id)} n={n} compact />
            </div>
          </>
        ) : (
          <div className="p-6 text-center">
            <div className="mx-auto w-14 h-14 rounded-full border border-dashed border-line flex items-center justify-center text-muted mb-3"><Icon name="trophy" className="w-6 h-6" /></div>
            <div className="font-display uppercase text-lg">Выберите клуб</div>
            <p className="text-xs text-muted mt-1.5">Нажмите на клуб в списке — здесь появятся его состав, штаб и финансы. Двойной щелчок — сразу начать карьеру.</p>
            <p className="text-xs text-muted mt-3"><b style={{ color: '#E5323E' }}>Фаворит</b> — проще, <b style={{ color: '#93A4BC' }}>аутсайдер</b> — интереснее строить команду.</p>
          </div>
        )}
        <div className="border-t border-line p-3 bg-panel2/80">
          <div className="text-[11px] text-muted mb-2">{team ? <>Сезон {roster.season} · {roster.gamesPerTeam} матчей · бюджет {formatMoney(team.budget)}</> : <>Сезон {roster.season} · {roster.gamesPerTeam} матчей</>}</div>
          <Button variant="primary" size="lg" className="w-full" disabled={!team} onClick={() => team && onStart(team.id)}>
            Начать карьеру
          </Button>
        </div>
      </aside>

      {/* phones and tablets: the picked club in a bar at the bottom — details in a sheet, the start right there */}
      <div className="lg:hidden sticky bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-10 mt-4">
        <div className="bg-panel2/95 backdrop-blur border border-line rounded-md p-2.5 flex flex-wrap sm:flex-nowrap items-center gap-2 sm:gap-2.5 shadow-xl">
          {team ? (
            <button type="button" onClick={() => setSheet(true)} className="flex items-center gap-2.5 min-w-0 flex-1 basis-full sm:basis-auto text-left" data-club-details title="Подробнее о клубе">
              <TeamLogo team={team} size={34} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold truncate">{team.name}</span>
                <span className="block text-[11px] text-muted truncate">сила {power.of(team.id)} · №{power.rank(team.id)} · {tierOf(power.rank(team.id), n).label}</span>
              </span>
              <span className="shrink-0 inline-flex items-center gap-1 text-xs text-ice px-2 py-1 rounded-sm border border-line"><Icon name="info" /> Подробнее</span>
            </button>
          ) : (
            <div className="flex-1 basis-full sm:basis-auto text-xs text-muted">Выберите клуб, которым будете управлять</div>
          )}
          <Button variant="primary" className="w-full sm:w-auto shrink-0" disabled={!team} onClick={() => team && onStart(team.id)}>
            Начать карьеру
          </Button>
        </div>
      </div>
      {team && (
        <Modal open={sheet} onClose={() => setSheet(false)} width="max-w-2xl" title={<span className="font-display uppercase tracking-wide">Клуб</span>}>
          <ClubPreview roster={roster} team={team} rank={power.rank(team.id)} n={n} />
          <div className="mt-4 pt-3 border-t border-line flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setSheet(false)}>Назад к списку</Button>
            <Button variant="primary" onClick={() => { setSheet(false); onStart(team.id); }}>Начать карьеру за «{team.name}»</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** One-time flag set by the boot watchdog's «Безопасный запуск» (index.html). */
function takeSafeStart(): boolean {
  try {
    if (localStorage.getItem('khl.safe') !== '1') return false;
    localStorage.removeItem('khl.safe');
    return true;
  } catch {
    return false;
  }
}

/** This launch is a safe start: the start screen opens no league by itself (read once per page load). */
export const SAFE_START = takeSafeStart();

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export function Startup({ onStart, onBack }: { onStart: (r: NormalizedRoster, teamId: string) => void; /** back to the main menu */ onBack?: () => void }) {
  const ui = useUI();
  const [saveCount, setSaveCount] = useState<number | null>(null);
  const [stage, setStage] = useState<'loading' | 'error' | 'empty' | 'select' | 'format' | 'pick'>('loading');
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
    withTimeout(loadMod(m), 30000, `лига «${m.name}» не загрузилась за 30 секунд`)
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
  /** A mod was just installed from an archive: refresh the list and open it. */
  const afterInstall = (id: string) => {
    rememberMod(id);
    listMods()
      .then((list) => {
        setMods(list);
        const m = list.find((x) => x.id === id);
        if (m) openMod(m);
      })
      .catch(() => load());
  };
  const load = () => {
    setStage('loading');
    setErr('');
    listMods()
      .then((list) => {
        setMods(list);
        // «Безопасный запуск» from the boot screen: no league is opened by itself this time, the player picks one
        if (SAFE_START) { setModId(null); setRoster(null); setStage(list.length ? 'pick' : 'empty'); return; }
        const want = modId || lastModId();
        const m = list.find((x) => x.id === want) ?? list.find((x) => x.id === DEFAULT_MOD_ID) ?? list[0];
        if (m) openMod(m);
        else {
          // no mod found at all (a build without public/mods): the player installs a mod or picks a roster file
          setModId(null);
          setRoster(null);
          setStage('empty');
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
    <div className="relative min-h-screen rink-lines overflow-x-clip">
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse at 50% -10%, rgba(229,50,62,.14), transparent 55%)' }} />
      <div className="relative max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6 md:py-8">
        <header className="relative -mx-3 sm:-mx-4 md:mx-0 mb-4 sm:mb-6 md:rounded-md overflow-hidden border-0 md:border border-line bg-cover bg-center" style={{ backgroundImage: `url(${arena})`, backgroundPosition: 'center 55%' }}>
          <div className="absolute inset-0 bg-gradient-to-r from-bg via-bg/85 to-bg/25" />
          {onBack && (
            <button type="button" onClick={onBack} className="absolute top-3 left-3 z-10 inline-flex items-center gap-1.5 px-2 py-1 rounded-sm border border-line text-xs text-muted hover:text-text bg-bg/70 backdrop-blur" data-startup-back title="Главное меню (Esc)">
              ← Меню
            </button>
          )}
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
          {/* compact: the club list is what this screen is for — it starts high on the page */}
          <div className="relative px-4 sm:px-6 md:px-8 pt-14 pb-4 sm:pt-12 sm:pb-5 md:py-6">
            <div className="flex items-center gap-3 sm:gap-4">
              <img src={gameLogo} alt="" className="w-12 h-12 sm:w-16 sm:h-16 md:w-20 md:h-20 object-contain shrink-0 drop-shadow-[0_4px_18px_rgba(0,0,0,0.6)]" data-game-logo />
              <div className="min-w-0">
                <p className="text-ice font-display uppercase tracking-[0.2em] sm:tracking-[0.3em] text-[10px] sm:text-xs">{GAME_NAME_EN} · карьера</p>
                <h1 className="font-display text-2xl sm:text-3xl md:text-4xl font-bold uppercase leading-[0.95] mt-1">
                  Хоккейный симулятор <span className="text-accent">менеджера</span>
                </h1>
                <p className="hidden sm:block text-muted mt-1.5 max-w-2xl text-xs md:text-sm">Продолжите сохранённую карьеру или выберите лигу и клуб — звенья, обмены, контракты, чемпионат и плей-офф.</p>
              </div>
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
            {mods && <ModPicker mods={mods} current={modId ?? '\u0000'} busy={stage === 'loading'} onPick={openMod} onFile={() => fileRef.current?.click()} onReload={load} onInstalled={afterInstall} />}
            <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { if (e.target.files?.[0]) void onFile(e.target.files[0]); e.target.value = ''; }} />
          </>
        )}

        {stage === 'pick' && (
          <Panel className="border-ice/40">
            <div className="text-sm text-text/90 py-2" data-safe-start>Безопасный запуск: лига не открыта автоматически. Выберите мод выше — или продолжите сохранённую карьеру.</div>
          </Panel>
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

        {stage === 'empty' && (
          <Panel title="Лига не выбрана: моды не установлены" className="border-ice/40">
            <div className="space-y-4 text-sm" data-mods-empty>
              <p className="text-text/90 m-0">Лиги не найдены: в этой сборке нет папки mods со стандартной лигой ХЛ, а клубы, игроки и календарь приходят из модов. Чтобы начать карьеру:</p>
              <ol className="list-decimal pl-5 space-y-1.5 text-text/90">
                {canInstallMods() ? (
                  <li>
                    Нажмите «Установить мод…» выше и выберите архив .zip с модом (или перетащите архив на список) — мод распакуется {modInstallPlace()} и сразу откроется.
                  </li>
                ) : (
                  <li>
                    Положите папку мода в <code className="bg-panel2 px-1.5 py-0.5 rounded text-ice">mods</code> рядом с <code className="bg-panel2 px-1.5 py-0.5 rounded text-ice">index.html</code>, впишите её имя в <code className="bg-panel2 px-1.5 py-0.5 rounded text-ice">mods/index.json</code> и нажмите «Обновить список».
                  </li>
                )}
                <li>Или выберите файл ростера (roster.json) с устройства — он загрузится прямо в игре, без установки мода.</li>
                <li>Своя лига: устройство мода и полей файла — на вкладке «Формат JSON», там же пример ростера.</li>
              </ol>
              {fileErr && <div className="text-accent text-xs">{fileErr}</div>}
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => fileRef.current?.click()} data-mods-empty-file>
                  Выбрать файл ростера…
                </Button>
                <Button onClick={load}>Обновить список</Button>
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
            <Button onClick={() => setStage(roster ? 'select' : mods && !mods.length ? 'empty' : 'error')}>← Назад</Button>
            <FormatDoc />
          </div>
        )}

        {stage === 'select' && roster && (
          <>
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <div className="text-sm text-muted">
                Лига «{roster.leagueName}» · фарм-лига «{roster.farmName}» · сезон {roster.season} · {roster.teams.length} команд · {Object.keys(roster.players).length} игроков · {roster.schedule ? 'календарь из мода' : 'календарь составлен игрой'}
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
