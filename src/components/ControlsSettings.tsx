import { useEffect, useRef, useState } from 'react';
import { setSettings, useSettings } from '../game/settings';
import { suspendPadNav } from '../gamepadNav';
import { cn } from '../utils/cn';
import { Button } from './ui';
import {
  anyGamepad, bindButton, bindKey, KEY_SLOTS, keyBindsOf, keyLabel, PAD_SLOTS, padBindsOf, padLabel, RESERVED_KEYS, resetControls,
  type KeyBind, type PadBind,
} from './playInput';

/** A binding's name and what it does (short: the full story is in the match's «Управление» help). */
export const BIND_INFO: Record<KeyBind | 'poke', [string, string]> = {
  up: ['Вперёд / вверх', ''], down: ['Назад / вниз', ''], left: ['Влево', ''], right: ['Вправо', ''],
  shoot: ['Бросок', 'держать — сильнее; в обороне — силовой приём'],
  pass: ['Пас', 'держать — верхом; в обороне — смена игрока'],
  deke: ['Финт', 'в обороне — отбор клюшкой'],
  sprint: ['Рывок', 'тратит силы'],
  swap: ['Сменить игрока', ''],
  faceoff: ['Вбрасывание', 'в момент, когда судья бросает шайбу'],
  mod: ['Модификатор (LB)', 'в обороне — блок броска; с шайбой — пас верхом и особые финты'],
  lift: ['Подбить клюшку', 'с шайбой (держать) — прикрыть шайбу'],
  pin: ['К борту', 'с шайбой у борта — игра в коньках'],
  push: ['Толчок', 'в обороне'],
  vision: ['Контроль обзора', 'держать: лицом к шайбе'],
  hustle: ['Ускорение', 'держится, пока катитесь'],
  r3: ['Конёк / бедро (R3)', 'пнуть шайбу коньком; в обороне — силовой бедром'],
  fight: ['Драка', ''],
  o: ['Празднование ○', 'после гола'], sq: ['Празднование □', 'после гола'],
  poke: ['Отбор клюшкой (RB)', 'держать — клюшкой по льду; с шайбой + правый стик — вброс'],
  change: ['Смена звена', ''], changeF: ['Смена звена нападения', ''], changeD: ['Смена пары защитников', ''],
  pull: ['Снять / вернуть вратаря', ''], timeout: ['Тайм-аут', '30 с, один на матч'],
  forecheck: ['Форчекинг', 'тактика: переключение'], breakout: ['Выход из зоны', 'тактика: переключение'],
  replay: ['Повтор последнего гола', ''], pause: ['Пауза', ''],
};
const KEY_GROUPS: [string, KeyBind[]][] = [
  ['Движение', ['up', 'down', 'left', 'right']],
  ['Основное', ['shoot', 'pass', 'deke', 'sprint', 'swap', 'faceoff']],
  ['Как кнопки геймпада', ['mod', 'lift', 'pin', 'push', 'vision', 'hustle', 'r3', 'fight', 'o', 'sq']],
  ['Команды скамейки', ['change', 'changeF', 'changeD', 'pull', 'timeout', 'forecheck', 'breakout', 'replay', 'pause']],
];
const PAD_GROUPS: [string, PadBind[]][] = [
  ['Основное', ['pass', 'poke', 'shoot', 'faceoff']],
  ['Дополнительно', ['mod', 'lift', 'pin', 'vision', 'hustle', 'r3', 'push', 'fight', 'o', 'sq']],
  ['Команды скамейки', ['change', 'changeF', 'changeD', 'pull', 'timeout', 'forecheck', 'breakout', 'replay', 'pause']],
];

type Wait = { device: 'keyboard' | 'gamepad'; bind: KeyBind | PadBind; slot: number };

/**
 * The «Управление» tab: every key and gamepad button of a played match can be rebound. A slot is clicked, then the
 * key / button pressed (Esc cancels, Backspace / Delete clear it). A key does one thing — taken from another binding
 * it moves, with a notice; a pad button may serve several (RB pokes and wins the draw by default).
 */
export function ControlsSettings({ query, matches }: { query: string; matches: (q: string, ...t: (string | undefined)[]) => boolean }) {
  const s = useSettings();
  const [device, setDevice] = useState<'keyboard' | 'gamepad'>(() => (anyGamepad(typeof navigator !== 'undefined' ? navigator.getGamepads?.() : null) ? 'gamepad' : 'keyboard'));
  const [wait, setWait] = useState<Wait | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const noteT = useRef(0);
  const say = (t: string) => { setNote(t); window.clearTimeout(noteT.current); noteT.current = window.setTimeout(() => setNote(null), 5000); };
  useEffect(() => () => window.clearTimeout(noteT.current), []);
  const searching = !!query.trim();
  const keys = keyBindsOf(s.controls), pads = padBindsOf(s.controls);

  // waiting for a key: caught before anything else (the match's own keys, the window's Esc)
  useEffect(() => {
    if (!wait || wait.device !== 'keyboard') return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.repeat) return;
      const bind = wait.bind as KeyBind;
      if (e.code === 'Escape') { setWait(null); return; }
      if (e.code === 'Backspace' || e.code === 'Delete') { setSettings({ controls: bindKey(s.controls, bind, wait.slot, null).controls }); setWait(null); return; }
      if (RESERVED_KEYS.has(e.code) || !e.code) { say(`Клавишу ${keyLabel(e.code || e.key)} назначить нельзя`); return; }
      const r = bindKey(s.controls, bind, wait.slot, e.code);
      setSettings({ controls: r.controls });
      if (r.moved.length) say(`${keyLabel(e.code)} — теперь «${BIND_INFO[bind][0]}»; снята с «${r.moved.map(b => BIND_INFO[b][0]).join('», «')}»`);
      setWait(null);
    };
    const up = (e: KeyboardEvent) => { e.stopImmediatePropagation(); };
    window.addEventListener('keydown', h, true);
    window.addEventListener('keyup', up, true);
    return () => { window.removeEventListener('keydown', h, true); window.removeEventListener('keyup', up, true); };
  }, [wait, s.controls]);

  // waiting for a pad button: the first one pressed after the click (held ones wait for their release); the menus'
  // pad navigation rests meanwhile
  useEffect(() => {
    if (!wait || wait.device !== 'gamepad') return;
    suspendPadNav(true);
    const read = () => { const gp = navigator.getGamepads?.().find(Boolean); return gp ? gp.buttons.map(b => b.pressed || b.value > 0.5) : []; };
    let held = read(), raf = 0;
    const t0 = performance.now();
    const tick = () => {
      const now = read();
      const i = now.findIndex((p, j) => p && !held[j]);
      held = held.map((h, j) => h && !!now[j]);
      if (i >= 0) {
        const bind = wait.bind as PadBind;
        const r = bindButton(s.controls, bind, wait.slot, i);
        setSettings({ controls: r.controls });
        if (r.shared.length) say(`${padLabel(i)} — «${BIND_INFO[bind][0]}», а также «${r.shared.map(b => BIND_INFO[b][0]).join('», «')}»`);
        setWait(null);
        return;
      }
      if (performance.now() - t0 > 10000) { setWait(null); say('Кнопка не нажата — назначение отменено'); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const esc = (e: KeyboardEvent) => { if (e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); setWait(null); } };
    window.addEventListener('keydown', esc, true);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', esc, true); window.setTimeout(() => suspendPadNav(false), 250); };
  }, [wait, s.controls]);

  const groups = device === 'keyboard' ? KEY_GROUPS : PAD_GROUPS;
  const changed = device === 'keyboard' ? !!s.controls.keys : !!s.controls.pad;
  const slots = device === 'keyboard' ? KEY_SLOTS : PAD_SLOTS;
  const label = (b: KeyBind | PadBind, i: number) => device === 'keyboard' ? keys[b as KeyBind]?.[i] : pads[b as PadBind]?.[i];
  const shown = (b: KeyBind | PadBind) => matches(query, BIND_INFO[b][0], BIND_INFO[b][1], 'управление клавиши кнопки геймпад клавиатура');

  return (
    <section className={cn('rounded-md border border-line bg-panel2/40', searching && '[&:not(:has([data-setting-row]))]:hidden')} data-settings-section="Управление" data-settings-tab="controls" data-controls-device={device}>
      <header className="px-3 py-2 border-b border-line">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="font-display uppercase tracking-wide text-sm">Управление{searching ? ` · ${device === 'keyboard' ? 'клавиатура' : 'геймпад'}` : ''}</h3>
          <span className="flex rounded-sm border border-line overflow-hidden text-xs" role="tablist" aria-label="Устройство">
            {(['keyboard', 'gamepad'] as const).map(d => (
              <button key={d} type="button" role="tab" aria-selected={device === d} onClick={() => { setWait(null); setDevice(d); }} data-controls-tab={d}
                className={cn('px-2.5 py-1 border-r border-line last:border-r-0', device === d ? 'bg-ice text-bg font-semibold' : 'text-muted hover:text-text')}>{d === 'keyboard' ? 'Клавиатура' : 'Геймпад'}</button>
            ))}
          </span>
        </div>
        {!searching && <p className="text-[11px] text-muted mt-1">
          {device === 'keyboard'
            ? 'Нажмите на клавишу в списке, затем новую клавишу. Esc — отмена, Backspace — убрать. Клавиша делает одно дело: если она была занята, она переходит сюда. Мышь не переназначается: ЛКМ — бросок, ПКМ — пас, средняя — финт.'
            : 'Нажмите на кнопку в списке, затем кнопку на геймпаде. Стики не переназначаются: левый — катание и прицел, правый — клюшка (броски, финты, силовые). Одна кнопка может делать несколько дел: так RB по умолчанию и отбирает, и выигрывает вбрасывание.'}
        </p>}
      </header>
      {note && <p className="px-3 py-1.5 text-[11px] text-ice border-b border-line bg-ice/10" role="status" data-controls-note>{note}</p>}
      <div className="divide-y divide-line/60">
        {groups.map(([title, list]) => {
          const rows = list.filter(shown);
          if (!rows.length) return null;
          return (
            <div key={title}>
              {!searching && <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-text/70 font-semibold">{title}</div>}
              {rows.map(b => (
                <div key={b} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-1.5" data-setting-row={`bind-${b}`} data-bind={b}>
                  <div className="min-w-[10rem] flex-1">
                    <div className="text-sm">{BIND_INFO[b][0]}</div>
                    {BIND_INFO[b][1] && <div className="text-[11px] text-muted leading-snug">{BIND_INFO[b][1]}</div>}
                  </div>
                  <div className="flex gap-1.5">
                    {Array.from({ length: slots }, (_, i) => {
                      const v = label(b, i);
                      const on = wait?.bind === b && wait.slot === i && wait.device === device;
                      return (
                        <button key={i} type="button" onClick={() => setWait(on ? null : { device, bind: b, slot: Math.min(i, (device === 'keyboard' ? keys[b as KeyBind] : pads[b as PadBind])?.length ?? 0) })}
                          className={cn('min-w-[4.5rem] px-2 py-1 rounded-sm border text-xs font-mono', on ? 'border-ice bg-ice/20 text-ice animate-pulse' : v !== undefined ? 'border-line bg-bg text-text hover:border-ice' : 'border-dashed border-line text-muted hover:border-ice')}
                          data-bind-slot={i} aria-label={`${BIND_INFO[b][0]}: ${on ? 'ждём' : v !== undefined ? (device === 'keyboard' ? keyLabel(v as string) : padLabel(v as number)) : 'не назначено'}`}>
                          {on ? (device === 'keyboard' ? 'нажмите…' : 'кнопку…') : v !== undefined ? (device === 'keyboard' ? keyLabel(v as string) : padLabel(v as number)) : '+'}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {!searching && (
        <div className="px-3 py-2 border-t border-line flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted">{changed ? 'Есть свои назначения' : 'Назначения по умолчанию'}</span>
          <Button size="sm" variant="ghost" disabled={!changed} onClick={() => { setWait(null); setSettings({ controls: resetControls(s.controls, device) }); }} data-controls-reset>
            Вернуть {device === 'keyboard' ? 'клавиши' : 'кнопки'} по умолчанию
          </Button>
        </div>
      )}
    </section>
  );
}
