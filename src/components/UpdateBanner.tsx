import { useState } from 'react';
import { applyUpdate, buildLabel, checkForUpdate, currentBuild, useUpdateCheck, type UpdateInfo } from '../update';
import { Button, Icon } from './ui';

const HOW: Record<UpdateInfo['platform'], string> = {
  web: 'Страница перезагрузится с новой версией. Карьера сохранена — продолжите с того же места.',
  windows: 'Скачается новая версия — запустите файл, она установится поверх старой. Карьеры сохранятся.',
  android: 'Скачается новый APK — откройте его и нажмите «Обновить». Карьеры сохранятся.',
};

/** «Вышла новая версия» — a card at the bottom of the screen (never blocks a match). */
export function UpdateBanner() {
  const { info, later } = useUpdateCheck();
  const [busy, setBusy] = useState(false);
  if (!info) return null;
  return (
    <div
      role="status"
      data-update-banner={info.platform}
      className="fixed z-[70] bottom-[calc(4.5rem+env(safe-area-inset-bottom))] lg:bottom-4 left-1/2 -translate-x-1/2 w-[min(92vw,30rem)] rounded-md border border-ice/50 bg-panel shadow-2xl p-3 fade-in"
    >
      <div className="flex items-start gap-2.5">
        <span className="text-ice mt-0.5 shrink-0"><Icon name="info" /></span>
        <div className="min-w-0 flex-1">
          <div className="font-display uppercase tracking-wide text-sm">Доступна новая версия</div>
          <div className="text-xs text-muted mt-0.5">
            У вас <b className="text-text/90">{buildLabel(info.current)}</b>, актуальная — <b className="text-ice">{buildLabel(info.latest)}</b>.
          </div>
          <div className="text-xs text-text/80 mt-1">{HOW[info.platform]}</div>
          <div className="flex gap-2 mt-2.5">
            <Button size="sm" variant="primary" data-update-now disabled={busy} onClick={() => { setBusy(true); applyUpdate(info); if (info.action === 'download') setTimeout(() => setBusy(false), 3000); }}>
              {info.action === 'reload' ? 'Обновить' : 'Скачать обновление'}
            </Button>
            <Button size="sm" variant="ghost" data-update-later onClick={later}>Позже</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Settings row: this build and a «check now» button. */
export function UpdateCheckRow() {
  const cur = currentBuild();
  const [state, setState] = useState<'idle' | 'checking' | 'latest' | 'error' | UpdateInfo>('idle');
  if (!cur) return null;
  const check = () => {
    setState('checking');
    void checkForUpdate().then((u) => setState(u ?? 'latest')).catch(() => setState('error'));
  };
  return (
    <div className="flex flex-col items-end gap-1" data-update-check>
      <span className="text-[11px] text-muted tabular">{buildLabel(cur)}</span>
      {typeof state === 'object' ? (
        <Button size="sm" variant="primary" onClick={() => applyUpdate(state)}>
          {state.action === 'reload' ? 'Обновить' : 'Скачать'} {buildLabel(state.latest)}
        </Button>
      ) : (
        <Button size="sm" onClick={check} disabled={state === 'checking'}>
          {state === 'checking' ? 'Проверяю…' : 'Проверить обновления'}
        </Button>
      )}
      {state === 'latest' && <span className="text-[11px] text-good">У вас последняя версия</span>}
    </div>
  );
}
