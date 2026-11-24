import { useState } from 'react';
import { isIOS, isStandalone, useFullscreen } from '../fullscreen';
import { cn } from '../utils/cn';
import { Button, Icon, Modal } from './ui';

/** Whole-game fullscreen toggle (header / start screen). iPhone Safari gets the home-screen instructions instead. */
export function FullscreenButton({ className, label = false }: { className?: string; label?: boolean }) {
  const fs = useFullscreen();
  const [help, setHelp] = useState(false);
  if (isStandalone() && !fs.supported) return null;
  const title = fs.active ? 'Выйти из полноэкранного режима' : 'Во весь экран';
  return (
    <>
      <button
        type="button"
        onClick={() => (fs.supported ? void fs.toggle() : setHelp(true))}
        className={cn('inline-flex items-center gap-1.5 px-2 py-1 rounded-sm border text-xs', fs.active ? 'border-ice text-ice' : 'border-line text-muted hover:text-text', className)}
        title={title}
        aria-label={title}
        aria-pressed={fs.active}
        data-fullscreen-toggle
      >
        <Icon name={fs.active ? 'shrink' : 'expand'} />
        {label && <span>{fs.active ? 'Обычный режим' : 'Во весь экран'}</span>}
      </button>
      <Modal open={help} onClose={() => setHelp(false)} title="Полноэкранный режим" width="max-w-md">
        <div className="p-4 space-y-3 text-sm" data-fullscreen-help>
          {isIOS() ? (
            <>
              <p>Safari на iPhone не разрешает сайтам скрывать свои панели. Чтобы играть во весь экран, добавьте игру на экран «Домой»:</p>
              <ol className="list-decimal pl-5 space-y-1 text-muted">
                <li>нажмите «Поделиться» (квадрат со стрелкой);</li>
                <li>выберите «На экран „Домой“»;</li>
                <li>запускайте игру с появившейся иконки — она откроется без адресной строки, сохранения останутся теми же.</li>
              </ol>
              <p className="text-muted">3D-повтор гола можно развернуть кнопкой ⛶ прямо в окне повтора.</p>
            </>
          ) : (
            <p>Этот браузер не поддерживает полноэкранный режим для сайтов. Попробуйте Chrome, Edge, Firefox или Safari на компьютере.</p>
          )}
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setHelp(false)}>
              Понятно
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
