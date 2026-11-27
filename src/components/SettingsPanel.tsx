import { useEffect, useState, type ReactNode } from 'react';
import { APP_DOWNLOADS, APP_RELEASE, appVersion, gpuInfo, platform } from '../platform';
import { UpdateCheckRow } from './UpdateBanner';
import { CAMERAS, LIVE_CAMERAS } from './replayCameras';
import { Button } from './ui';
import { REPLAY_SPEEDS, resetSettings, setSettings, useSettings, type Settings } from '../game/settings';
import { cn } from '../utils/cn';

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-md border border-line bg-panel2/40" data-settings-section={title}>
      <header className="px-3 py-2 border-b border-line">
        <h3 className="font-display uppercase tracking-wide text-sm">{title}</h3>
        {hint && <p className="text-[11px] text-muted mt-0.5">{hint}</p>}
      </header>
      <div className="divide-y divide-line/60">{children}</div>
    </section>
  );
}

function Row({ label, hint, children, disabled }: { label: string; hint?: string; children: ReactNode; disabled?: boolean }) {
  return (
    <div className={cn('flex flex-wrap sm:flex-nowrap items-center justify-between gap-x-4 gap-y-1.5 px-3 py-2.5', disabled && 'opacity-50')}>
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-[11px] text-muted leading-snug">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
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

/** Device settings: replays, video, live match, fast simulation. Changes apply at once and are remembered. */
export function SettingsPanel({ onClose }: { onClose?: () => void }) {
  const s = useSettings();
  const set = (patch: Partial<Settings>) => setSettings(patch);
  const off3d = !s.replay3d;
  return (
    <div className="space-y-3" data-settings>
      <Section title="Повторы голов" hint="Повтор открывается после гола в матче, из ленты событий, из итогов и протокола матча.">
        <Row label="3D-повторы" hint="Объёмная реконструкция с камерами и игроками. Если выключить, повторы показываются на 2D-схеме площадки: это легко для слабых устройств и экономит батарею.">
          <Toggle id="replay3d" value={s.replay3d} onChange={(v) => set({ replay3d: v })} />
        </Row>
        <Row label="Автоповтор голов в матче" hint="Какие голы сами открывают повтор во время матча. Посмотреть любой гол всегда можно кнопкой «Повтор».">
          <Choice id="autoReplay" value={s.autoReplay} onChange={(v) => set({ autoReplay: v })} options={[['all', 'Все голы'], ['mine', 'Только мои'], ['off', 'Выкл.']]} />
        </Row>
        <Row label="Качество 3D" hint="«Авто»: «Высокое» на компьютере, «Стандарт» на телефоне. «Ультра» — для мощной видеокарты." disabled={off3d}>
          <Choice id="replayQuality" value={s.replayQuality} disabled={off3d} onChange={(v) => set({ replayQuality: v })} options={[['auto', 'Авто'], ['standard', 'Стандарт'], ['high', 'Высокое'], ['ultra', 'Ультра']]} />
        </Row>
        <Row label="Камера по умолчанию" disabled={off3d}>
          <select aria-label="Камера по умолчанию" data-setting="replayCamera" disabled={off3d} value={s.replayCamera} onChange={(e) => set({ replayCamera: e.target.value as Settings['replayCamera'] })} className="bg-bg border border-line rounded-sm px-2 py-1.5 text-xs">
            {CAMERAS.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
          </select>
        </Row>
        <Row label="Скорость воспроизведения">
          <select aria-label="Скорость повтора по умолчанию" data-setting="replaySpeed" value={s.replaySpeed} onChange={(e) => set({ replaySpeed: Number(e.target.value) })} className="bg-bg border border-line rounded-sm px-2 py-1.5 text-xs">
            {REPLAY_SPEEDS.map((v) => <option key={v} value={v}>×{v}</option>)}
          </select>
        </Row>
        <Row label="Готовить 3D заранее" hint="При начале матча и при открытии протокола арена и игроки собираются в фоне, и первый повтор открывается сразу." disabled={off3d}>
          <Toggle id="replayPrewarm" value={s.replayPrewarm} disabled={off3d} onChange={(v) => set({ replayPrewarm: v })} />
        </Row>
      </Section>

      <Section title="Скачивание видео" hint="Кнопка «⤓ Скачать видео» в 3D-повторе сохраняет ролик MP4.">
        <Row label="Разрешение">
          <Choice id="videoHeight" value={s.videoHeight} onChange={(v) => set({ videoHeight: v })} options={[[720, '720p'], [1080, '1080p']]} />
        </Row>
        <Row label="Частота кадров" hint="60 кадров/с — плавнее, но видео готовится вдвое дольше.">
          <Choice id="videoFps" value={s.videoFps} onChange={(v) => set({ videoFps: v })} options={[[30, '30'], [60, '60']]} />
        </Row>
        <Row label="Качество рендера" hint="«Быстро»: без отражений на льду и с упрощёнными тенями. Видео готовится заметно быстрее.">
          <Choice id="videoQuality" value={s.videoQuality} onChange={(v) => set({ videoQuality: v })} options={[['fast', 'Быстро'], ['view', 'Как в повторе']]} />
        </Row>
        <Row label="Замедленный повтор" hint="После эпизода в реальном времени бросок и гол показываются ещё раз в замедлении с другой камеры. Если выключить, ролик будет короче и сохранится быстрее.">
          <Toggle id="videoSlowmo" value={s.videoSlowmo} onChange={(v) => set({ videoSlowmo: v })} />
        </Row>
        <Row label="Графика трансляции" hint="Табло со счётом, плашка «ГОЛ» с автором и передачами.">
          <Toggle id="videoGraphics" value={s.videoGraphics} onChange={(v) => set({ videoGraphics: v })} />
        </Row>
      </Section>

      <Section title="Матч">
        <Row label="Скорость матча при старте">
          <Choice id="matchSpeed" value={s.matchSpeed} onChange={(v) => set({ matchSpeed: v })} options={[[1, '×1'], [2, '×2'], [4, '×4']]} />
        </Row>
        <Row label="Площадка под матч-центром" hint="На широком экране, под картой бросков.">
          <Toggle id="matchRink2d" value={s.matchRink2d} onChange={(v) => set({ matchRink2d: v })} />
        </Row>
        <Row label="Матч в 3D" hint="Весь матч в 3D: те же игроки, шайба, смены и вбрасывания, что на 2D-площадке, кадр в кадр. Если устройство не тянет 3D, показывается 2D. Переключается и прямо на площадке.">
          <Choice id="matchView" value={s.matchView} onChange={(v) => set({ matchView: v })} options={[['3d', '3D'], ['2d', '2D']]} />
        </Row>
        <Row label="Камера 3D-матча">
          <Choice id="matchCamera" value={s.matchCamera} onChange={(v) => set({ matchCamera: v })} options={LIVE_CAMERAS} />
        </Row>
        <Row label="Зум камеры в матче" hint="Насколько близко камера 3D-матча (в том числе когда играете сами): крупнее — игроки больше, дальше — видно больше площадки. Колесо мыши и щипок двумя пальцами по-прежнему меняют зум на ходу.">
          <Choice id="matchZoom" value={s.matchZoom} onChange={(v) => set({ matchZoom: v })} options={[[.7, 'Крупно'], [.85, 'Ближе'], [1, 'Обычно'], [1.2, 'Дальше'], [1.45, 'Общий план']]} />
        </Row>
        <Row label="Мини-карта 2D поверх 3D" hint="Маленькая площадка сверху в углу 3D-картинки.">
          <Toggle id="matchMinimap" value={s.matchMinimap} onChange={(v) => set({ matchMinimap: v })} />
        </Row>
        <Row label="Выход команд и лазерное шоу" hint="Перед первым периодом в 3D: свет гаснет, идёт лазерное шоу, на лёд выезжают все игроки — сначала гости, потом хозяева; крупные планы вратарей, капитанов и лидеров, рукопожатия капитанов с судьями. Можно пропустить кнопкой на картинке.">
          <Toggle id="matchIntro" value={s.matchIntro} onChange={(v) => set({ matchIntro: v })} />
        </Row>
        <Row label="Празднования и повторы в 3D-матче" hint="После гола — празднование автора крупным планом и повтор гола, на остановках — повторы опасных моментов. Матч в это время стоит, всё можно пропустить кнопкой на картинке.">
          <Toggle id="matchReplays" value={s.matchReplays} onChange={(v) => set({ matchReplays: v })} />
        </Row>
        <Row label="Подсказки тренерского штаба на остановках" hint="Когда нужен тайм-аут, замена вратаря или игра без вратаря, матч встаёт на паузу при свистке и предлагает решение, а потом продолжается сам.">
          <Toggle id="matchAdvice" value={s.matchAdvice} onChange={(v) => set({ matchAdvice: v })} />
        </Row>
      </Section>

      <Section title="Игра за хоккеиста">
        <Row label="Длина периода" hint="Сколько реальных минут длится 20-минутный период, когда вы играете сами. Игровые часы идут быстрее и стоят при свистках.">
          <Choice id="playPeriod" value={s.playPeriod} onChange={(v) => set({ playPeriod: v })} options={[[3, '3 мин'], [5, '5 мин'], [8, '8 мин'], [12, '12 мин'], [20, '20 мин']]} />
        </Row>
        <Row label="Сложность" hint="Насколько сильны соперники: как быстро они читают игру, точность их бросков и передач, игра вратарей.">
          <Choice id="playDifficulty" value={s.playDifficulty} onChange={(v) => set({ playDifficulty: v })} options={[['rookie', 'Новичок'], ['pro', 'Профи'], ['star', 'Звезда']]} />
        </Row>
        <Row label="Автосмена игрока" hint="Управление само переходит к игроку с шайбой, а в обороне — к ближайшему к шайбе защитнику. Вручную — кнопкой «Смена».">
          <Toggle id="playAutoSwitch" value={s.playAutoSwitch} onChange={(v) => set({ playAutoSwitch: v })} />
        </Row>
        <Row label="Экранное управление" hint="Виртуальный стик и кнопки на сенсорном экране. «Авто»: на телефонах и планшетах.">
          <Choice id="playTouch" value={s.playTouch} onChange={(v) => set({ playTouch: v })} options={[['auto', 'Авто'], ['on', 'Вкл'], ['off', 'Выкл']]} />
        </Row>
        <Row label="Время в большинстве и меньшинстве" hint="Как идут часы, пока одна из команд играет в неполном составе. «Как период» — с той же скоростью, что и весь период. «Реальное» — штраф отыгрывается полностью: 2 минуты удаления — 2 настоящие минуты. «×2» и «×4» — реальное время, ускоренное в 2 или 4 раза (но не быстрее, чем идёт период).">
          <Choice id="playPenaltyClock" value={s.playPenaltyClock} onChange={(v) => set({ playPenaltyClock: v })} options={[['period', 'Как период'], ['real', 'Реальное'], [2, '×2'], [4, '×4']]} />
        </Row>
      </Section>

      <Section title="Звук" hint="Все звуки созданы прямо в игре синтезатором (без записанных сэмплов и чужих аудиофайлов), так что никаких авторских прав. Звучат матчи — и тот, что вы смотрите, и тот, где играете сами.">
        <Row label="Звук в матчах" hint="Клюшки и шайба, борт и стекло, штанга, силовые приёмы, сейвы, свисток судьи, сирена и гудок после гола, болельщики и органист. Быстро выключить можно и кнопкой «Звук» на площадке.">
          <Toggle id="sound" value={s.sound} onChange={(v) => set({ sound: v })} />
        </Row>
        <Row label="Громкость" disabled={!s.sound}>
          <Choice id="soundVolume" value={s.soundVolume} onChange={(v) => set({ soundVolume: v })} options={[[.25, '25%'], [.5, '50%'], [.75, '75%'], [1, '100%']]} disabled={!s.sound} />
        </Row>
        <Row label="Болельщики" hint="Гул трибун, который нарастает у ворот соперника, рёв после гола хозяев, «у-у-у» после штанги, аплодисменты." disabled={!s.sound}>
          <Choice id="soundCrowd" value={s.soundCrowd} onChange={(v) => set({ soundCrowd: v })} options={[['off', 'Выкл'], ['quiet', 'Тихо'], ['normal', 'Обычно'], ['loud', 'Громко']]} disabled={!s.sound} />
        </Row>
        <Row label="Органист" hint="Короткие мелодии органа на остановках и после гола хозяев; на некоторые трибуны отвечают хлопками." disabled={!s.sound}>
          <Toggle id="soundOrgan" value={s.soundOrgan} onChange={(v) => set({ soundOrgan: v })} disabled={!s.sound} />
        </Row>
      </Section>

      <Section title="Симуляция">
        <Row label="Открывать протокол после симуляции матча" hint="Если симуляция сыграла один матч вашей команды, сразу открывается его протокол с повторами голов.">
          <Toggle id="simOpenReport" value={s.simOpenReport} onChange={(v) => set({ simOpenReport: v })} />
        </Row>
        <Row label="Подтверждать быструю симуляцию" hint="Предупреждение о нерешённых задачах во входящих и вопрос перед симуляцией матча без просмотра.">
          <Toggle id="simConfirm" value={s.simConfirm} onChange={(v) => set({ simConfirm: v })} />
        </Row>
      </Section>

      <AppSection />

      <div className="flex flex-wrap justify-between gap-2 pt-1">
        <Button variant="ghost" onClick={() => resetSettings()} data-settings-reset>Сбросить настройки</Button>
        {onClose && <Button variant="primary" onClick={onClose}>Готово</Button>}
      </div>
      <p className="text-[11px] text-muted">Настройки хранятся {platform() === 'web' ? 'в этом браузере' : 'в приложении'} и не зависят от карьеры.</p>
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
    <Section title="Приложение и графика" hint="Игра одинаково работает в браузере и в приложениях. Сохранения у каждого варианта свои; перенести карьеру можно через «Сохранения» → экспорт/импорт файла.">
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
