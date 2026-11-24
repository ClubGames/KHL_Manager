import type { ReactNode } from 'react';
import { CAMERAS } from './replayCameras';
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
        <Row label="Площадка 2D под матч-центром" hint="На широком экране, под картой бросков.">
          <Toggle id="matchRink2d" value={s.matchRink2d} onChange={(v) => set({ matchRink2d: v })} />
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

      <div className="flex flex-wrap justify-between gap-2 pt-1">
        <Button variant="ghost" onClick={() => resetSettings()} data-settings-reset>Сбросить настройки</Button>
        {onClose && <Button variant="primary" onClick={onClose}>Готово</Button>}
      </div>
      <p className="text-[11px] text-muted">Настройки хранятся в этом браузере и не зависят от карьеры.</p>
    </div>
  );
}
