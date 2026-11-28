/**
 * Настройки → Управление → «Сенсорный экран»: the phone controls of a played match made the player's own — the
 * buttons' size, how see-through they are, the left-handed mirror, a floating or fixed skating stick, the skill stick
 * on / off, vibration — and where the buttons sit: the cluster is dragged in the phone-shaped preview (or nudged with
 * the arrows), the same layout the match draws (touchLayout.ts).
 */
import { useRef, useState } from 'react';
import { defaultSettings, setSettings, TOUCH_KEYS, TOUCH_SHIFT, TOUCH_SIZES, useSettings, type Settings } from '../game/settings';
import { cn } from '../utils/cn';
import { Button } from './ui';
import { maxShiftY, touchLayout, TOUCH_ALPHA, type Spot } from './touchLayout';

/** The phone the preview stands for (a landscape phone, CSS px). */
const PHONE = { w: 844, h: 390 };

function Pick<V extends string | number | boolean>({ id, value, options, onChange }: { id: keyof Settings; value: V; options: [V, string][]; onChange: (v: V) => void }) {
  return (
    <div className="flex flex-wrap rounded-sm border border-line overflow-hidden text-xs" role="radiogroup" data-setting={id}>
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className={cn('px-2.5 py-1.5 border-r border-line last:border-r-0', value === v ? 'bg-ice text-bg font-semibold' : 'text-muted hover:text-text')}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function TouchSettings({ query, matches }: { query: string; matches: (q: string, ...t: (string | undefined)[]) => boolean }) {
  const s = useSettings();
  const searching = !!query.trim();
  const d = defaultSettings();
  const changed = TOUCH_KEYS.some(k => s[k] !== d[k]);
  const rows: { k: keyof Settings; label: string; hint: string; el: React.ReactNode }[] = [
    { k: 'touchSize', label: 'Размер кнопок', hint: 'Крупнее — легче попасть большим пальцем, мельче — больше видно льда.',
      el: <Pick id="touchSize" value={s.touchSize} options={TOUCH_SIZES.map(v => [v, `${Math.round(v * 100)}%`] as [Settings['touchSize'], string])} onChange={v => setSettings({ touchSize: v })} /> },
    { k: 'touchAlpha', label: 'Прозрачность', hint: 'Насколько кнопки и стик видны поверх площадки.',
      el: <Pick id="touchAlpha" value={s.touchAlpha} options={[['faint', 'Еле видно'], ['normal', 'Обычно'], ['solid', 'Плотно']]} onChange={v => setSettings({ touchAlpha: v })} /> },
    { k: 'touchLefty', label: 'Рука', hint: '«Левша»: кнопки слева, стик катания справа — всё зеркально.',
      el: <Pick id="touchLefty" value={s.touchLefty} options={[[false, 'Правша'], [true, 'Левша']]} onChange={v => setSettings({ touchLefty: v })} /> },
    { k: 'touchStick', label: 'Стик катания', hint: '«Плавающий» появляется там, где коснулись; «закреплённый» всегда в одном месте у края экрана.',
      el: <Pick id="touchStick" value={s.touchStick} options={[['float', 'Плавающий'], ['fixed', 'Закреплённый']]} onChange={v => setSettings({ touchStick: v })} /> },
    { k: 'touchSkill', label: 'Стик клюшки', hint: 'Свайпы между стиком и кнопками: назад и вперёд — щелчок, рывок — кистевой, вбок — финт. Выключите, если задеваете его случайно: бросок, пас и финт остаются на кнопках.',
      el: <Pick id="touchSkill" value={s.touchSkill} options={[[true, 'Вкл'], [false, 'Выкл']]} onChange={v => setSettings({ touchSkill: v })} /> },
    { k: 'touchHaptics', label: 'Вибрация', hint: 'Короткий отклик на каждое нажатие (если телефон умеет).',
      el: <Pick id="touchHaptics" value={s.touchHaptics} options={[[true, 'Вкл'], [false, 'Выкл']]} onChange={v => setSettings({ touchHaptics: v })} /> },
  ];
  const words = 'сенсорный экран телефон планшет кнопки стик управление тач';
  const shown = rows.filter(r => matches(query, r.label, r.hint, words));
  const showPreview = !searching || matches(query, 'Положение кнопок', 'перетащите кнопки', words);
  if (searching && !shown.length && !showPreview) return null;
  return (
    <div data-touch-settings>
      {!searching && <p className="px-3 py-2 text-[11px] text-muted border-b border-line">
        Экранные кнопки и стик в сыгранном матче. Они появляются на телефонах и планшетах (или всегда — «Экранное управление: Вкл» во вкладке «Игра»).
      </p>}
      <div className="divide-y divide-line/60">
        {shown.map(r => (
          <div key={r.k} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-3 py-2" data-setting-row={r.k} data-changed={s[r.k] !== d[r.k] ? true : undefined}>
            <div className="min-w-[10rem] flex-1">
              <div className="text-sm">{r.label}</div>
              <div className="text-[11px] text-muted leading-snug">{r.hint}</div>
            </div>
            {r.el}
          </div>
        ))}
        {showPreview && <div className="px-3 py-2" data-setting-row="touchShiftX touchShiftY">
          <div className="text-sm">Положение кнопок</div>
          <div className="text-[11px] text-muted leading-snug mb-2">Перетащите кнопки на макете телефона (или двигайте стрелками) — так они встанут в матче.</div>
          <TouchPreview />
        </div>}
      </div>
      {!searching && (
        <div className="px-3 py-2 border-t border-line flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted">{changed ? 'Своя раскладка' : 'Раскладка по умолчанию'}</span>
          <Button size="sm" variant="ghost" disabled={!changed} onClick={() => setSettings(Object.fromEntries(TOUCH_KEYS.map(k => [k, d[k]])) as Partial<Settings>)} data-touch-reset>
            Вернуть по умолчанию
          </Button>
        </div>
      )}
    </div>
  );
}

/** The phone-shaped preview: the cluster as the match draws it, dragged to move it in from its corner. */
function TouchPreview() {
  const s = useSettings();
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; sx: number; sy: number } | null>(null);
  const [moving, setMoving] = useState(false);
  const L = touchLayout(s, PHONE.h), side = L.side;
  const scale = () => (box.current?.clientWidth ?? 420) / PHONE.w;
  const put = (x: number, y: number) => setSettings({ touchShiftX: Math.round(Math.min(TOUCH_SHIFT.x, Math.max(0, x))), touchShiftY: Math.round(Math.min(TOUCH_SHIFT.y, maxShiftY(s.touchSize, PHONE.h), Math.max(0, y))) });
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault(); try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* not an active pointer */ }
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: s.touchShiftX, sy: s.touchShiftY }; setMoving(true);
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = drag.current; if (!g || g.id !== e.pointerId) return;
    const k = scale(), dx = (e.clientX - g.x) / k, dy = (e.clientY - g.y) / k;
    // inward from the corner: to the left for the right-hand cluster, to the right when mirrored; up is positive
    put(g.sx + (side === 'right' ? -dx : dx), g.sy - dy);
  };
  const onUp = () => { drag.current = null; setMoving(false); };
  const nudge = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 20 : 6, inward = side === 'right' ? 'ArrowLeft' : 'ArrowRight', outward = side === 'right' ? 'ArrowRight' : 'ArrowLeft';
    const m: Record<string, [number, number]> = { [inward]: [step, 0], [outward]: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const v = m[e.key]; if (!v) return;
    e.preventDefault(); put(s.touchShiftX + v[0], s.touchShiftY + v[1]);
  };
  const look = TOUCH_ALPHA[s.touchAlpha];
  // a button in the preview: % of the phone, from the cluster's corner (the safe 8 px margin included)
  const pos = (p: Spot | { x: number; y: number; w: number; h: number }) => ({ [side]: `${(8 + p.x) / PHONE.w * 100}%`, bottom: `${(8 + p.y) / PHONE.h * 100}%`, width: `${('size' in p ? p.size : p.w) / PHONE.w * 100}%`, height: `${('size' in p ? p.size : p.h) / PHONE.h * 100}%` });
  const dot = 'absolute rounded-full border border-white/40 bg-black/25 text-white/90 flex items-center justify-center text-[clamp(5px,1.15vw,8px)] font-semibold leading-none whitespace-nowrap overflow-hidden [text-shadow:0_1px_2px_rgba(0,0,0,.85)]';
  const other = side === 'right' ? 'left' : 'right';
  const outer = ['Смена', 'Верхом', 'Прикрыть', 'У борта', 'Конёк', 'Ускор.'];
  return (
    <div className="flex flex-col gap-2">
      <div ref={box} className="relative w-full max-w-[440px] rounded-[14px] border-4 border-panel2 overflow-hidden select-none touch-none bg-[linear-gradient(180deg,#9fb6c9_0%,#dfe9f1_38%,#eef4f8_100%)]" style={{ aspectRatio: `${PHONE.w} / ${PHONE.h}` }} data-touch-preview={side}>
        {/* the rink, roughly: centre line and blue lines */}
        <div className="absolute inset-y-[30%] left-1/2 w-[3px] -translate-x-1/2 bg-accent/50" />
        <div className="absolute inset-y-[30%] left-[33%] w-[3px] bg-ice/50" /><div className="absolute inset-y-[30%] right-[33%] w-[3px] bg-ice/50" />
        {/* the skating stick */}
        <div className="absolute rounded-full border border-dashed border-black/40 flex items-center justify-center text-[9px] text-black/50" style={{ [other]: `${(20 + 8) / PHONE.w * 100}%`, bottom: `${(24 + 8) / PHONE.h * 100}%`, width: `${112 / PHONE.w * 100}%`, aspectRatio: '1', opacity: look.opacity }}>стик</div>
        {s.touchSkill && <div className="absolute top-[16%] bottom-0 border-x border-dashed border-ice/50 bg-ice/[.07] flex items-end justify-center pb-1 text-[8px] text-ice/80" style={{ [other]: '44%', [side]: `${(8 + L.skillGap) / PHONE.w * 100}%` }}>клюшка</div>}
        {/* the cluster: one piece, dragged */}
        <div className={cn('absolute inset-0 cursor-grab', moving && 'cursor-grabbing')} style={{ opacity: look.opacity }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          tabIndex={0} role="slider" aria-label="Положение кнопок (стрелки — сдвиг)" aria-valuetext={`${s.touchShiftX} × ${s.touchShiftY}`} onKeyDown={nudge} data-touch-drag>
          <div className={cn(dot, look.cls, 'bg-accent/50 border-accent/80')} style={pos(L.shoot)}>Бросок</div>
          <div className={cn(dot, look.cls)} style={pos(L.pass)}>Пас</div>
          <div className={cn(dot, look.cls)} style={pos(L.deke)}>Финт</div>
          <div className={cn(dot, look.cls)} style={pos(L.sprint)}>Рывок</div>
          {outer.map((t, i) => <div key={t} className={cn(dot, look.cls, 'bg-black/35')} style={pos(L.ring(i, outer.length))}>{t}</div>)}
          <div className={cn(dot, look.cls, 'rounded-xl bg-ice/40 border-ice/70 opacity-60')} style={pos(L.faceoff)}>Вбрасывание</div>
        </div>
        {moving && <div className="absolute top-1 left-1/2 -translate-x-1/2 rounded-sm bg-black/60 px-1.5 py-0.5 text-[10px] text-ice tabular" data-touch-shift>{s.touchShiftX} × {s.touchShiftY}</div>}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted">
        <span className="tabular" data-touch-shift-value>Сдвиг: {s.touchShiftX ? `${s.touchShiftX} px ${side === 'right' ? 'влево' : 'вправо'}` : 'у края'}, {s.touchShiftY ? `${s.touchShiftY} px вверх` : 'внизу'}</span>
        {(s.touchShiftX || s.touchShiftY) ? <button type="button" className="underline hover:text-text" onClick={() => setSettings({ touchShiftX: 0, touchShiftY: 0 })} data-touch-shift-reset>в угол</button> : null}
      </div>
    </div>
  );
}
