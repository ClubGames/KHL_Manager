import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { APP_DOWNLOADS, APP_RELEASE, appVersion, gpuInfo, platform } from '../platform';
import { UpdateCheckRow } from './UpdateBanner';
import { ControlsSettings } from './ControlsSettings';
import { CAMERAS, LIVE_CAMERAS } from './replayCameras';
import { Button } from './ui';
import { defaultSettings, REPLAY_SPEEDS, resetSettings, setSettings, useSettings, type Settings } from '../game/settings';
import { cn } from '../utils/cn';

/** The tabs of the window (a search looks through all of them). */
export type SettingsTab = 'match' | 'play' | 'controls' | 'replays' | 'sound' | 'other';
const TABS: [SettingsTab, string][] = [['match', 'Матч'], ['play', 'Игра за хоккеиста'], ['controls', 'Управление'], ['replays', 'Повторы и видео'], ['sound', 'Звук'], ['other', 'Прочее']];
const TAB_KEY = 'khl.settingsTab';

/**
 * Where the settings are open: everywhere else ('all'), or during a match ('match') — then without what the match
 * already runs with (the period length, the difficulty, the clock of the penalties, the watched match's start
 * speed) and without the simulation and the app.
 */
export type SettingsScope = 'all' | 'match';
/** The settings a match starts with and keeps to its end: not offered in it. */
export const FIXED_IN_MATCH: (keyof Settings)[] = ['playPeriod', 'playDifficulty', 'playPenaltyClock', 'matchSpeed'];
const MATCH_TABS: SettingsTab[] = ['match', 'play', 'controls', 'replays', 'sound'];
/** A setting not at its default (the controls are an object: compared by content). */
const differs = (a: unknown, b: unknown) => a !== b && JSON.stringify(a) !== JSON.stringify(b);

/** What the window shows now: the tab, or a search across all tabs. */
type View = { tab: SettingsTab; query: string; scope: SettingsScope };
const ViewCtx = createContext<View>({ tab: 'match', query: '', scope: 'all' });

/** Lower case, «ё» as «е»: the search ignores both. */
const norm = (t: string) => t.toLowerCase().replace(/ё/g, 'е');
export function settingMatches(query: string, ...texts: (string | undefined)[]): boolean {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = norm(texts.filter(Boolean).join(' '));
  return words.every(w => hay.includes(w));
}
/** A hint's first sentence (always shown) and the rest (behind «ещё»). */
export function splitHint(hint: string): [string, string] {
  const m = hint.match(/^(.+?[.!?»])\s+(\S[\s\S]*)$/);
  if (!m || m[1].length < 24) return [hint, ''];
  return [m[1], m[2]];
}

function Section({ title, hint, tab, children }: { title: string; hint?: string; tab: SettingsTab; children: ReactNode }) {
  const view = useContext(ViewCtx);
  const searching = !!view.query.trim();
  if (!searching && view.tab !== tab) return null;
  if (view.scope === 'match' && !MATCH_TABS.includes(tab)) return null;
  return (
    // in a search a section none of whose rows match is hidden
    <section className={cn('rounded-md border border-line bg-panel2/40', searching && '[&:not(:has([data-setting-row]))]:hidden')} data-settings-section={title} data-settings-tab={tab}>
      <header className="px-3 py-2 border-b border-line">
        <h3 className="font-display uppercase tracking-wide text-sm">{title}</h3>
        {hint && !searching && <p className="text-[11px] text-muted mt-0.5">{hint}</p>}
      </header>
      <div className="divide-y divide-line/60">{children}</div>
    </section>
  );
}

function Row({ label, hint, children, disabled, k }: { label: string; hint?: string; children: ReactNode; disabled?: boolean; /** the setting(s) of the row: a «↺» puts them back to the default */ k?: keyof Settings | (keyof Settings)[] }) {
  const view = useContext(ViewCtx);
  const s = useSettings();
  const [more, setMore] = useState(false);
  const keys = k === undefined ? [] : Array.isArray(k) ? k : [k];
  if (view.scope === 'match' && keys.some(x => FIXED_IN_MATCH.includes(x))) return null;
  if (!settingMatches(view.query, label, hint)) return null;
  const d = defaultSettings();
  const changed = keys.filter(x => differs(s[x], d[x]));
  const [first, rest] = hint ? splitHint(hint) : ['', ''];
  return (
    // a wide control (the camera list) goes under the label instead of squeezing it
    <div className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-3 py-2.5', disabled && 'opacity-50')} data-setting-row={keys.join(' ') || label} data-changed={changed.length ? true : undefined}>
      <div className="min-w-[min(100%,14rem)] flex-1 basis-56">
        <div className="text-sm flex items-center gap-1.5">
          {label}
          {changed.length > 0 && (
            <button type="button" onClick={() => setSettings(Object.fromEntries(changed.map(x => [x, d[x]])) as Partial<Settings>)}
              className="text-[11px] leading-none text-ice/80 hover:text-ice px-1 py-0.5 rounded-sm hover:bg-panel2" title="Вернуть как было по умолчанию" aria-label={`${label}: по умолчанию`} data-setting-default>↺</button>
          )}
        </div>
        {hint && (
          <div className="text-[11px] text-muted leading-snug">
            {first}
            {rest && (more || view.query.trim()
              ? <> {rest}</>
              : <> <button type="button" className="text-ice/80 hover:text-ice underline-offset-2 hover:underline" onClick={() => setMore(true)} data-setting-more>ещё</button></>)}
          </div>
        )}
      </div>
      <div className="max-w-full">{children}</div>
    </div>
  );
}

function Toggle({ id, value, onChange, disabled }: { id: keyof Settings; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={value} disabled={disabled} data-setting={id} onClick={() => onChange(!value)}
      className={cn('relative w-11 h-6 rounded-full transition-colors border', value ? 'bg-ice border-ice' : 'bg-bg border-line')}>
      <span className={cn('absolute top-0.5 w-[18px] h-[18px] rounded-full transition-all', value ? 'left-[22px] bg-bg' : 'left-0.5 bg-muted')} />
      <span className="sr-only">{value ? 'Вкл.' : 'Выкл.'}</span>
    </button>
  );
}

function Choice<V extends string | number>({ id, value, options, onChange, disabled }: { id: keyof Settings; value: V; options: [V, string][]; onChange: (v: V) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap rounded-sm border border-line overflow-hidden text-xs" role="radiogroup" data-setting={id}>
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} disabled={disabled} onClick={() => onChange(v)}
          className={cn('px-2.5 py-1.5 border-r border-line last:border-r-0', value === v ? 'bg-ice text-bg font-semibold' : 'text-muted hover:text-text')}>
          {text}
        </button>
      ))}
    </div>
  );
}

/**
 * Quick profiles for the graphics: everything the 3D can show, the defaults, or the light 2D for a weak device /
 * the battery. The one the settings match now is lit; touching a single setting afterwards leaves «свои».
 */
export const PROFILES: { id: string; label: string; hint: string; set: Partial<Settings> }[] = [
  { id: 'max', label: 'Максимум', hint: 'всё в 3D, высокое качество', set: { replay3d: true, replayQuality: 'high', replayPrewarm: true, matchView: '3d', matchIntro: true, matchReplays: true, matchMinimap: true, videoQuality: 'view' } },
  { id: 'balance', label: 'Баланс', hint: 'как по умолчанию', set: { replay3d: true, replayQuality: 'auto', replayPrewarm: true, matchView: '3d', matchIntro: true, matchReplays: true, matchMinimap: true, videoQuality: 'view' } },
  { id: 'saver', label: 'Экономия', hint: '2D, для слабых устройств и батареи', set: { replay3d: false, replayQuality: 'standard', replayPrewarm: false, matchView: '2d', matchIntro: false, matchReplays: false, matchMinimap: false, videoQuality: 'fast' } },
];
export function activeProfile(s: Settings): string | null {
  return PROFILES.find(p => Object.entries(p.set).every(([k, v]) => s[k as keyof Settings] === v))?.id ?? null;
}

function Profiles() {
  const s = useSettings();
  const view = useContext(ViewCtx);
  if (view.query.trim() || view.tab !== 'match') return null;
  const on = activeProfile(s);
  return (
    <div className="rounded-md border border-line bg-panel2/40 px-3 py-2.5" data-settings-profiles>
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <h3 className="font-display uppercase tracking-wide text-sm">Быстрая настройка графики</h3>
        {!on && <span className="text-[11px] text-muted" data-profile-custom>сейчас — свои</span>}
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {PROFILES.map(p => (
          <button key={p.id} type="button" onClick={() => setSettings(p.set)} aria-pressed={on === p.id} data-profile={p.id}
            className={cn('rounded-sm border px-2 py-1.5 text-left', on === p.id ? 'border-ice bg-ice/15' : 'border-line hover:border-muted')}>
            <div className={cn('text-xs font-semibold', on === p.id && 'text-ice')}>{p.label}</div>
            <div className="text-[10px] text-muted leading-tight">{p.hint}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function readTab(scope: SettingsScope): SettingsTab {
  try { const t = sessionStorage.getItem(TAB_KEY) as SettingsTab | null; if (t && TABS.some(([x]) => x === t) && (scope === 'all' || MATCH_TABS.includes(t))) return t; } catch { /* private mode */ }
  return 'match';
}

/**
 * Device settings: replays, video, live match, fast simulation. Changes apply at once and are remembered. The
 * settings are split into tabs (the last one opened comes back), a search finds a setting in any of them; a changed
 * setting has a «↺» back to its default, long explanations open on «ещё».
 */
export function SettingsPanel({ onClose, scope = 'all', closeLabel = 'Готово', pad = 'modal', title }: { onClose?: () => void; /** a heading pinned above the search (the window has none of its own) */ title?: ReactNode; scope?: SettingsScope; closeLabel?: string; /** the padding of the scroller it sits in (the pinned search bar reaches its edges) */ pad?: 'modal' | 'sheet' }) {
  const s = useSettings();
  const set = (patch: Partial<Settings>) => setSettings(patch);
  const off3d = !s.replay3d;
  const [tab, setTabState] = useState<SettingsTab>(() => readTab(scope));
  const setTab = (t: SettingsTab) => { setTabState(t); try { sessionStorage.setItem(TAB_KEY, t); } catch { /* private mode */ } };
  const [query, setQuery] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const view = useMemo(() => ({ tab, query, scope }), [tab, query, scope]);
  const tabs = scope === 'match' ? TABS.filter(([t]) => MATCH_TABS.includes(t)) : TABS;
  const searching = !!query.trim();
  const d = defaultSettings();
  // «nothing found»: the rows hide themselves, so the DOM tells after the render
  const root = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(false);
  useLayoutEffect(() => { setEmpty(searching && !root.current?.querySelector('[data-setting-row]')); });
  const changedIn = (keys: (keyof Settings)[]) => keys.filter(k => differs(s[k], d[k])).length;
  return (
    <ViewCtx.Provider value={view}>
    <div ref={root} className="space-y-3 text-left" data-settings data-settings-view={searching ? 'search' : tab} data-settings-scope={scope}>
      <div className={cn('sticky z-10 pt-3 pb-2 bg-panel/95 backdrop-blur border-b border-line space-y-2', pad === 'sheet' ? '-top-4 sm:-top-5 -mx-4 sm:-mx-5 -mt-4 sm:-mt-5 px-4 sm:px-5' : '-top-3.5 sm:-top-4 -mx-3.5 sm:-mx-4 -mt-3.5 sm:-mt-4 px-3.5 sm:px-4')}>
        {title}
        <div className="relative">
          <input type="text" enterKeyHint="search" value={query} onChange={(e) => setQuery(e.target.value)}
            // Esc: clears the search, then leaves the field (the next Esc closes the window / goes back to the match)
            onKeyDown={(e) => { if (e.key !== 'Escape' || (!query && !e.currentTarget.value)) { if (e.key === 'Escape') e.currentTarget.blur(); return; } e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); setQuery(''); }} placeholder="Поиск настройки: звук, камера, повтор…" aria-label="Поиск настройки"
            className="w-full bg-bg border border-line rounded-sm pl-8 pr-8 py-1.5 text-sm placeholder:text-muted/70 focus:border-ice outline-none" data-settings-search />
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted text-sm pointer-events-none" aria-hidden>⌕</span>
          {query && <button type="button" onClick={() => setQuery('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 text-muted hover:text-text" aria-label="Очистить поиск">×</button>}
        </div>
        <div className={cn('flex gap-1 overflow-x-auto no-scrollbar -mx-1 px-1', searching && 'opacity-50')} role="tablist" aria-label="Разделы настроек">
          {tabs.map(([id, label]) => {
            const n = changedIn(TAB_KEYS[id].filter(x => scope === 'all' || !FIXED_IN_MATCH.includes(x)));
            return (
              <button key={id} type="button" role="tab" aria-selected={!searching && tab === id} onClick={() => { setQuery(''); setTab(id); }} data-settings-tab-btn={id}
                className={cn('shrink-0 rounded-sm px-2.5 py-1 text-xs border whitespace-nowrap', !searching && tab === id ? 'bg-ice text-bg border-ice font-semibold' : 'border-line text-muted hover:text-text')}
                title={n ? `Изменено настроек: ${n}` : undefined}>
                {label}{n > 0 && <span className={cn('ml-1 inline-block w-1.5 h-1.5 rounded-full align-middle', !searching && tab === id ? 'bg-bg' : 'bg-ice')} aria-hidden />}
              </button>
            );
          })}
        </div>
      </div>

      {scope === 'match' && !searching && tab === 'play' && (
        <p className="text-[11px] text-muted rounded-md border border-line/60 px-3 py-2" data-settings-fixed-note>Длина периода, сложность и время в большинстве остаются такими, с какими начался матч, — их можно изменить в настройках вне матча.</p>
      )}

      <Profiles />

      <Section tab="match" title="Матч">
        <Row k="matchView" label="Матч в 3D" hint="Весь матч в 3D: те же игроки, шайба, смены и вбрасывания, что на 2D-площадке, кадр в кадр. Если устройство не тянет 3D, показывается 2D. Переключается и прямо на площадке.">
          <Choice id="matchView" value={s.matchView} onChange={(v) => set({ matchView: v })} options={[['3d', '3D'], ['2d', '2D']]} />
        </Row>
        <Row k="matchCamera" label="Камера 3D-матча">
          <Choice id="matchCamera" value={s.matchCamera} onChange={(v) => set({ matchCamera: v })} options={LIVE_CAMERAS} />
        </Row>
        <Row k="matchZoom" label="Зум камеры в матче" hint="Насколько близко камера 3D-матча (в том числе когда играете сами). Крупнее — игроки больше, дальше — видно больше площадки. Колесо мыши и щипок двумя пальцами по-прежнему меняют зум на ходу.">
          <Choice id="matchZoom" value={s.matchZoom} onChange={(v) => set({ matchZoom: v })} options={[[.7, 'Крупно'], [.85, 'Ближе'], [1, 'Обычно'], [1.2, 'Дальше'], [1.45, 'Общий план']]} />
        </Row>
        <Row k="matchMinimap" label="Мини-карта 2D поверх 3D" hint="Маленькая площадка сверху в углу 3D-картинки.">
          <Toggle id="matchMinimap" value={s.matchMinimap} onChange={(v) => set({ matchMinimap: v })} />
        </Row>
        <Row k="matchIntro" label="Выход команд и лазерное шоу" hint="Перед первым периодом в 3D гаснет свет и идёт лазерное шоу. На лёд выезжают все игроки — сначала гости, потом хозяева; крупные планы вратарей, капитанов и лидеров, рукопожатия капитанов с судьями. Можно пропустить кнопкой на картинке.">
          <Toggle id="matchIntro" value={s.matchIntro} onChange={(v) => set({ matchIntro: v })} />
        </Row>
        <Row k="matchReplays" label="Празднования и повторы в 3D-матче" hint="После гола — празднование автора крупным планом и повтор гола, на остановках — повторы опасных моментов. Матч в это время стоит, всё можно пропустить кнопкой на картинке.">
          <Toggle id="matchReplays" value={s.matchReplays} onChange={(v) => set({ matchReplays: v })} />
        </Row>
        <Row k="matchSpeed" label="Скорость матча при старте" hint="С какой скоростью начинается матч, который вы смотрите. Во время матча её меняют кнопки ×1 / ×2 / ×4.">
          <Choice id="matchSpeed" value={s.matchSpeed} onChange={(v) => set({ matchSpeed: v })} options={[[1, '×1'], [2, '×2'], [4, '×4']]} />
        </Row>
        <Row k="matchRink2d" label="Площадка под матч-центром" hint="На широком экране, под картой бросков.">
          <Toggle id="matchRink2d" value={s.matchRink2d} onChange={(v) => set({ matchRink2d: v })} />
        </Row>
        <Row k="matchAdvice" label="Подсказки тренерского штаба на остановках" hint="Когда нужен тайм-аут, замена вратаря или игра без вратаря, матч встаёт на паузу при свистке и предлагает решение. Потом матч продолжается сам.">
          <Toggle id="matchAdvice" value={s.matchAdvice} onChange={(v) => set({ matchAdvice: v })} />
        </Row>
      </Section>

      <Section tab="play" title="Игра за хоккеиста" hint="Матч, в котором вы сами управляете хоккеистом.">
        <Row k="playPeriod" label="Длина периода" hint="Сколько реальных минут длится 20-минутный период, когда вы играете сами. Игровые часы идут быстрее и стоят при свистках.">
          <Choice id="playPeriod" value={s.playPeriod} onChange={(v) => set({ playPeriod: v })} options={[[3, '3 мин'], [5, '5 мин'], [8, '8 мин'], [12, '12 мин'], [20, '20 мин']]} />
        </Row>
        <Row k="playDifficulty" label="Сложность" hint="Насколько сильны соперники: как быстро они читают игру, точность их бросков и передач, игра вратарей.">
          <Choice id="playDifficulty" value={s.playDifficulty} onChange={(v) => set({ playDifficulty: v })} options={[['rookie', 'Новичок'], ['pro', 'Профи'], ['star', 'Звезда']]} />
        </Row>
        <Row k="playPenaltyClock" label="Время в большинстве и меньшинстве" hint="Как идут часы, пока одна из команд играет в неполном составе. «Как период» — с той же скоростью, что и весь период. «Реальное» — штраф отыгрывается полностью: 2 минуты удаления — 2 настоящие минуты. «×2» и «×4» — реальное время, ускоренное в 2 или 4 раза (но не быстрее, чем идёт период).">
          <Choice id="playPenaltyClock" value={s.playPenaltyClock} onChange={(v) => set({ playPenaltyClock: v })} options={[['period', 'Как период'], ['real', 'Реальное'], [2, '×2'], [4, '×4']]} />
        </Row>
        <Row k="playAutoSwitch" label="Автосмена игрока" hint="Управление само переходит к игроку с шайбой, а в обороне — к ближайшему к шайбе защитнику. Вручную — кнопкой «Смена».">
          <Toggle id="playAutoSwitch" value={s.playAutoSwitch} onChange={(v) => set({ playAutoSwitch: v })} />
        </Row>
        <Row k="playTouch" label="Экранное управление" hint="Виртуальный стик и кнопки на сенсорном экране. «Авто»: на телефонах и планшетах.">
          <Choice id="playTouch" value={s.playTouch} onChange={(v) => set({ playTouch: v })} options={[['auto', 'Авто'], ['on', 'Вкл'], ['off', 'Выкл']]} />
        </Row>
      </Section>

      {(searching || tab === 'controls') && <ControlsSettings query={query} matches={settingMatches} />}

      <Section tab="replays" title="Повторы голов" hint="Повтор открывается после гола в матче, из ленты событий, из итогов и протокола матча.">
        <Row k="replay3d" label="3D-повторы" hint="Объёмная реконструкция с камерами и игроками. Если выключить, повторы показываются на 2D-схеме площадки: это легко для слабых устройств и экономит батарею.">
          <Toggle id="replay3d" value={s.replay3d} onChange={(v) => set({ replay3d: v })} />
        </Row>
        <Row k="autoReplay" label="Автоповтор голов в матче" hint="Какие голы сами открывают повтор во время матча. Посмотреть любой гол всегда можно кнопкой «Повтор».">
          <Choice id="autoReplay" value={s.autoReplay} onChange={(v) => set({ autoReplay: v })} options={[['all', 'Все голы'], ['mine', 'Только мои'], ['off', 'Выкл.']]} />
        </Row>
        <Row k="replayQuality" label="Качество 3D" hint="«Авто»: «Высокое» на компьютере, «Стандарт» на телефоне. «Ультра» — для мощной видеокарты." disabled={off3d}>
          <Choice id="replayQuality" value={s.replayQuality} disabled={off3d} onChange={(v) => set({ replayQuality: v })} options={[['auto', 'Авто'], ['standard', 'Стандарт'], ['high', 'Высокое'], ['ultra', 'Ультра']]} />
        </Row>
        <Row k="replayCamera" label="Камера по умолчанию" disabled={off3d}>
          <select aria-label="Камера по умолчанию" data-setting="replayCamera" disabled={off3d} value={s.replayCamera} onChange={(e) => set({ replayCamera: e.target.value as Settings['replayCamera'] })} className="bg-bg border border-line rounded-sm px-2 py-1.5 text-xs">
            {CAMERAS.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
          </select>
        </Row>
        <Row k="replaySpeed" label="Скорость воспроизведения">
          <select aria-label="Скорость повтора по умолчанию" data-setting="replaySpeed" value={s.replaySpeed} onChange={(e) => set({ replaySpeed: Number(e.target.value) })} className="bg-bg border border-line rounded-sm px-2 py-1.5 text-xs">
            {REPLAY_SPEEDS.map((v) => <option key={v} value={v}>×{v}</option>)}
          </select>
        </Row>
        <Row k="replayPrewarm" label="Готовить 3D заранее" hint="При начале матча и при открытии протокола арена и игроки собираются в фоне. Первый повтор тогда открывается сразу." disabled={off3d}>
          <Toggle id="replayPrewarm" value={s.replayPrewarm} disabled={off3d} onChange={(v) => set({ replayPrewarm: v })} />
        </Row>
      </Section>

      <Section tab="replays" title="Скачивание видео" hint="Кнопка «⤓ Скачать видео» в 3D-повторе сохраняет ролик MP4.">
        <Row k="videoHeight" label="Разрешение">
          <Choice id="videoHeight" value={s.videoHeight} onChange={(v) => set({ videoHeight: v })} options={[[720, '720p'], [1080, '1080p']]} />
        </Row>
        <Row k="videoFps" label="Частота кадров" hint="60 кадров/с — плавнее, но видео готовится вдвое дольше.">
          <Choice id="videoFps" value={s.videoFps} onChange={(v) => set({ videoFps: v })} options={[[30, '30'], [60, '60']]} />
        </Row>
        <Row k="videoQuality" label="Качество рендера" hint="«Быстро»: без отражений на льду и с упрощёнными тенями. Видео готовится заметно быстрее.">
          <Choice id="videoQuality" value={s.videoQuality} onChange={(v) => set({ videoQuality: v })} options={[['fast', 'Быстро'], ['view', 'Как в повторе']]} />
        </Row>
        <Row k="videoSlowmo" label="Замедленный повтор" hint="После эпизода в реальном времени бросок и гол показываются ещё раз в замедлении с другой камеры. Если выключить, ролик будет короче и сохранится быстрее.">
          <Toggle id="videoSlowmo" value={s.videoSlowmo} onChange={(v) => set({ videoSlowmo: v })} />
        </Row>
        <Row k="videoGraphics" label="Графика трансляции" hint="Табло со счётом, плашка «ГОЛ» с автором и передачами.">
          <Toggle id="videoGraphics" value={s.videoGraphics} onChange={(v) => set({ videoGraphics: v })} />
        </Row>
      </Section>

      <Section tab="sound" title="Звук" hint="Звучат матчи — и тот, что вы смотрите, и тот, где играете сами.">
        <Row k="sound" label="Звук в матчах" hint="Клюшки и шайба, борт и стекло, штанга, силовые приёмы, сейвы, свисток судьи, сирена и гудок после гола, болельщики и органист. Быстро выключить можно и кнопкой «Звук» на площадке.">
          <Toggle id="sound" value={s.sound} onChange={(v) => set({ sound: v })} />
        </Row>
        <Row k="soundVolume" label="Громкость" disabled={!s.sound}>
          <Choice id="soundVolume" value={s.soundVolume} onChange={(v) => set({ soundVolume: v })} options={[[.25, '25%'], [.5, '50%'], [.75, '75%'], [1, '100%']]} disabled={!s.sound} />
        </Row>
        <Row k="soundCrowd" label="Болельщики" hint="Гул трибун, который нарастает у ворот соперника, рёв после гола хозяев, «у-у-у» после штанги, аплодисменты." disabled={!s.sound}>
          <Choice id="soundCrowd" value={s.soundCrowd} onChange={(v) => set({ soundCrowd: v })} options={[['off', 'Выкл'], ['quiet', 'Тихо'], ['normal', 'Обычно'], ['loud', 'Громко']]} disabled={!s.sound} />
        </Row>
        <Row k="soundOrgan" label="Органист" hint="Короткие мелодии органа на остановках и после гола хозяев. На некоторые трибуны отвечают хлопками." disabled={!s.sound}>
          <Toggle id="soundOrgan" value={s.soundOrgan} onChange={(v) => set({ soundOrgan: v })} disabled={!s.sound} />
        </Row>
      </Section>

      <Section tab="other" title="Симуляция">
        <Row k="simOpenReport" label="Открывать протокол после симуляции матча" hint="Если симуляция сыграла один матч вашей команды, сразу открывается его протокол с повторами голов.">
          <Toggle id="simOpenReport" value={s.simOpenReport} onChange={(v) => set({ simOpenReport: v })} />
        </Row>
        <Row k="simConfirm" label="Подтверждать быструю симуляцию" hint="Предупреждение о нерешённых задачах во входящих и вопрос перед симуляцией матча без просмотра.">
          <Toggle id="simConfirm" value={s.simConfirm} onChange={(v) => set({ simConfirm: v })} />
        </Row>
      </Section>

      <AppSection />

      {empty && <NothingFound query={query} />}

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        {scope === 'match' ? <span /> : confirmReset
          ? <span className="flex items-center gap-1.5 text-xs" data-settings-reset-confirm>
              Сбросить все настройки?
              <Button size="sm" variant="ghost" onClick={() => { resetSettings(); setConfirmReset(false); }} data-settings-reset-yes>Да, сбросить</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>Нет</Button>
            </span>
          : <Button variant="ghost" onClick={() => setConfirmReset(true)} disabled={!changedIn(Object.keys(d) as (keyof Settings)[])} data-settings-reset>Сбросить настройки</Button>}
        {onClose && <Button variant="primary" onClick={onClose} data-settings-close>{closeLabel}</Button>}
      </div>
      <p className="text-[11px] text-muted">{scope === 'match' ? 'Изменения применяются сразу, прямо в этом матче. ' : ''}Настройки хранятся {platform() === 'web' ? 'в этом браузере' : 'в приложении'} и не зависят от карьеры. Изменённые отмечены «↺» — нажмите, чтобы вернуть как было.</p>
    </div>
    </ViewCtx.Provider>
  );
}

/** The settings each tab holds (its «changed» dot). */
const TAB_KEYS: Record<SettingsTab, (keyof Settings)[]> = {
  match: ['matchView', 'matchCamera', 'matchZoom', 'matchMinimap', 'matchIntro', 'matchReplays', 'matchSpeed', 'matchRink2d', 'matchAdvice'],
  play: ['playPeriod', 'playDifficulty', 'playPenaltyClock', 'playAutoSwitch', 'playTouch'],
  controls: ['controls'],
  replays: ['replay3d', 'autoReplay', 'replayQuality', 'replayCamera', 'replaySpeed', 'replayPrewarm', 'videoHeight', 'videoFps', 'videoQuality', 'videoSlowmo', 'videoGraphics'],
  sound: ['sound', 'soundVolume', 'soundCrowd', 'soundOrgan'],
  other: ['simOpenReport', 'simConfirm'],
};

/** «Nothing found» for a search that left no row. */
function NothingFound({ query }: { query: string }) {
  return <p className="text-sm text-muted text-center py-4" data-settings-nothing>Ничего не найдено по запросу «{query.trim()}».</p>;
}

/** The settings inside a match (over its pause menu): a title and the panel without what the match runs with. */
export function MatchSettings({ onBack }: { onBack: () => void }) {
  return (
    <div className="w-full" data-match-settings-panel>
      <SettingsPanel scope="match" pad="sheet" onClose={onBack} closeLabel="Назад к матчу"
        title={<div className="flex items-center justify-between gap-2"><h2 className="font-display text-xl">Настройки</h2><button type="button" onClick={onBack} className="text-xs text-muted hover:text-text" data-settings-back>← к матчу</button></div>} />
    </div>
  );
}

const PLATFORM_NAME = { web: 'Браузер', windows: 'Приложение для Windows', android: 'Приложение для Android' } as const;

/** Where the game runs, the graphics adapter in use (software rendering explains slow 3D) and the app downloads. */
function AppSection() {
  const p = platform();
  const [version, setVersion] = useState<string | null>(null);
  const [gpu] = useState(gpuInfo);
  useEffect(() => { void appVersion().then(setVersion); }, []);
  const link = 'inline-flex items-center gap-1.5 rounded-sm border border-line bg-panel2 px-2.5 py-1.5 text-xs font-semibold hover:border-ice';
  return (
    <Section tab="other" title="Приложение и графика" hint="Игра одинаково работает в браузере и в приложениях. Сохранения у каждого варианта свои; перенести карьеру можно через «Сохранения» → экспорт/импорт файла.">
      <Row label="Версия игры">
        <span className="text-sm tabular" data-app-platform={p}>{PLATFORM_NAME[p]}{version ? ` · ${version}` : ''}</span>
      </Row>
      <Row label="Обновления" hint={p === 'web' ? 'Игра сама проверяет обновления при запуске и предлагает перезагрузить страницу.' : 'Игра сама проверяет обновления при запуске и предлагает скачать новую версию — она ставится поверх старой, карьеры сохраняются.'}>
        <UpdateCheckRow />
      </Row>
      <Row label="Графика" hint={gpu.software
        ? (p === 'web'
          ? 'Браузер рисует 3D без видеокарты — отсюда лаги в повторах. Включите «Аппаратное ускорение» в настройках браузера или установите приложение для Windows: оно всегда использует видеокарту.'
          : 'Видеокарта недоступна, 3D рисуется программно. Обновите драйвер видеокарты; повторы можно смотреть в 2D.')
        : 'Видеокарта используется для 3D-повторов и видео.'}>
        <span className={cn('text-xs max-w-[16rem] inline-block text-right break-words', gpu.software ? 'text-accent' : 'text-good')} data-gpu={gpu.software ? 'software' : 'hardware'} title={gpu.renderer}>
          {gpu.software ? '⚠ Программная · ' : '✓ '}{gpu.renderer}
        </span>
      </Row>
      {p === 'web' && (
        <Row label="Скачать приложение" hint="Отдельное окно без браузера, принудительно включённая видеокарта, сохранение видео и карьер в файлы. Windows 10/11 и Android 7+.">
          <div className="flex flex-wrap justify-end gap-1.5" data-app-downloads>
            <a className={link} href={APP_DOWNLOADS.windowsSetup} target="_blank" rel="noopener" data-download="windows">⊞ Windows</a>
            <a className={link} href={APP_DOWNLOADS.android} target="_blank" rel="noopener" data-download="android">▶ Android (APK)</a>
            <a className={cn(link, 'font-normal text-muted')} href={APP_RELEASE} target="_blank" rel="noopener">Все файлы</a>
          </div>
        </Row>
      )}
    </Section>
  );
}
