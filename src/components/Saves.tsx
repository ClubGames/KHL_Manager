import { useCallback, useEffect, useRef, useState } from 'react';
import { copyCareer, deleteCareer, exportCareer, getBackend, importCareer, listSaves, loadCareer, renameCareer, saveNow, useGame, useSaveStatus } from '../game/state';
import type { SaveMeta, SaveStatus } from '../game/state';
import { Button, Spinner, Tag, TeamLogo, useUI } from './ui';
import { cn } from '../utils/cn';

const fmtTime = (ts: number) => new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtClock = (ts: number) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

function progress(m: SaveMeta): string {
  if (m.phase === 'offseason') return 'Межсезонье';
  if (m.phase === 'playoffs') return 'Плей-офф';
  return `Матч ${Math.min(m.gp + 1, m.gamesPerTeam)} из ${m.gamesPerTeam}`;
}

export function statusText(st: SaveStatus): { text: string; color: string; title: string } {
  switch (st.state) {
    case 'saving':
      return { text: 'Сохранение…', color: '#93A4BC', title: 'Идёт запись карьеры' };
    case 'saved':
      return { text: `Сохранено в ${fmtClock(st.at)}`, color: '#3FCF8E', title: 'Карьера сохраняется автоматически после каждого действия' };
    case 'error':
      return { text: 'Не сохранено', color: '#E5323E', title: st.error ?? 'Ошибка сохранения' };
    default:
      return { text: 'Автосохранение', color: '#93A4BC', title: 'Карьера сохраняется автоматически после каждого действия' };
  }
}

type SaveAction = 'load' | 'save' | 'copy' | 'export' | 'delete';

function SaveCard({ meta, current, busy, onAct, onRenamed }: { meta: SaveMeta; current: boolean; busy: boolean; onAct: (action: SaveAction, meta: SaveMeta) => void; onRenamed: (error: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(meta.name);
  const [renaming, setRenaming] = useState(false);
  const commit = async () => {
    setRenaming(true);
    const err = await renameCareer(meta, name);
    setRenaming(false);
    setEditing(false);
    onRenamed(err);
  };
  const disabled = busy || renaming;
  return (
    <li data-save-card={meta.id} className={cn('rounded-md border p-3 transition-colors', current ? 'border-ice/60 bg-ice/5' : 'border-line bg-panel2/50 hover:border-muted/60')}>
      <div className="flex items-start gap-3">
        <TeamLogo team={{ id: meta.teamId, name: meta.teamName, short: meta.teamShort, primaryColor: meta.primaryColor, secondaryColor: meta.secondaryColor, logo: meta.logo }} size={46} />
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void commit();
              }}
            >
              <input autoFocus value={name} maxLength={48} onChange={(e) => setName(e.target.value)} aria-label="Название сохранения" className="flex-1 min-w-0 bg-bg border border-line rounded-sm px-2 py-1 text-sm text-text focus:border-ice outline-none" />
              <Button size="sm" variant="ice" type="submit" disabled={disabled || !name.trim()}>
                ОК
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => { setEditing(false); setName(meta.name); }}>
                Отмена
              </Button>
            </form>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-display text-lg uppercase leading-tight truncate" data-save-name>{meta.name}</span>
              {current && <Tag color="#8FD8F0">открыта сейчас</Tag>}
              {meta.trophies > 0 && <Tag color="#F2B544">трофеев: {meta.trophies}</Tag>}
            </div>
          )}
          <div className="text-xs text-muted mt-0.5 truncate">
            {meta.teamName}
            {meta.city ? ` · ${meta.city}` : ''} · сезон {meta.season}
            {meta.seasonNumber > 1 ? ` (${meta.seasonNumber}-й сезон карьеры)` : ''}
            {meta.mod ? <span data-save-mod> · мод «{meta.mod}»</span> : null}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm mt-1.5 tabular">
            <span>{progress(meta)}</span>
            <span>
              <span className="text-muted">Баланс</span> {meta.wins}−{meta.losses}
            </span>
            <span>
              <span className="text-muted">Очки</span> <b className="text-ice">{meta.points}</b>
            </span>
            {meta.place > 0 && (
              <span>
                <span className="text-muted">Место</span> {meta.place} ({meta.conference})
              </span>
            )}
          </div>
          <div className="text-[11px] text-muted mt-1">Сохранено {fmtTime(meta.updatedAt)}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-line/60">
        {current ? (
          <Button size="sm" variant="ice" disabled={disabled} onClick={() => onAct('save', meta)}>
            Сохранить сейчас
          </Button>
        ) : (
          <Button size="sm" variant="primary" disabled={disabled} onClick={() => onAct('load', meta)}>
            {busy ? 'Загрузка…' : 'Продолжить'}
          </Button>
        )}
        <Button size="sm" disabled={disabled} onClick={() => onAct('copy', meta)} title="Создать отдельную копию этого сохранения — контрольную точку, к которой можно вернуться">
          Сделать копию
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => { setName(meta.name); setEditing(true); }}>
          Переименовать
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onAct('export', meta)} title="Скачать сохранение файлом">
          В файл
        </Button>
        {!current && (
          <Button size="sm" variant="danger" className="ml-auto" disabled={disabled} onClick={() => onAct('delete', meta)}>
            Удалить
          </Button>
        )}
      </div>
    </li>
  );
}

/** List of every saved career with all slot actions. Used on the main menu and in the in-game saves window. */
export function SavesList({ onLoaded, onCount }: { onLoaded?: () => void; onCount?: (n: number) => void }) {
  const ui = useUI();
  const game = useGame();
  const currentId = game?.saveId ?? null;
  const [list, setList] = useState<SaveMeta[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [backend, setBackend] = useState<string>('');
  const fileRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const l = await listSaves();
      if (!alive.current) return;
      setList(l);
      onCount?.(l.length);
    } catch (e) {
      if (!alive.current) return;
      setList([]);
      setMsg({ ok: false, text: (e as Error)?.message ?? 'Не удалось прочитать сохранения' });
    }
  }, [onCount]);

  useEffect(() => {
    void refresh();
    void getBackend().then((b) => alive.current && setBackend(b));
  }, [refresh]);

  const renamed = async (err: string | null) => {
    if (!alive.current) return;
    if (err) setMsg({ ok: false, text: err });
    await refresh();
  };

  const act = async (action: SaveAction, meta: SaveMeta) => {
    if (action === 'delete') {
      ui.confirm({
        title: 'Удалить сохранение?',
        text: `«${meta.name}» (${meta.teamName}, сезон ${meta.season}) будет удалено без возможности восстановления.`,
        danger: true,
        confirmLabel: 'Удалить',
        onYes: async () => {
          setBusy(meta.id);
          const err = await deleteCareer(meta.id);
          if (!alive.current) return;
          setBusy(null);
          setMsg(err ? { ok: false, text: err } : { ok: true, text: `Сохранение «${meta.name}» удалено` });
          await refresh();
        },
      });
      return;
    }
    setBusy(meta.id);
    setMsg(null);
    let err: string | null = null;
    let ok = '';
    if (action === 'load') {
      err = await loadCareer(meta.id);
      if (!err) {
        onLoaded?.();
        if (!alive.current) return;
      }
    } else if (action === 'save') {
      err = (await saveNow()) ? null : 'Не удалось сохранить — см. статус в шапке';
      ok = 'Карьера сохранена';
    } else if (action === 'copy') {
      err = await copyCareer(meta.id);
      ok = `Создана копия «${meta.name}» — отдельное сохранение в списке`;
    } else if (action === 'export') {
      err = await exportCareer(meta.id);
      ok = 'Файл сохранения скачан';
    }
    if (!alive.current) return;
    setBusy(null);
    if (err) setMsg({ ok: false, text: err });
    else if (ok) setMsg({ ok: true, text: ok });
    await refresh();
  };

  const onImport = async (file: File) => {
    setMsg(null);
    let err: string | null;
    try {
      err = await importCareer(await file.text());
    } catch {
      err = 'Не удалось прочитать файл';
    }
    if (!alive.current) return;
    setMsg(err ? { ok: false, text: err } : { ok: true, text: 'Сохранение добавлено из файла' });
    await refresh();
  };

  return (
    <div>
      {msg && (
        <div role="status" className={cn('mb-3 text-xs rounded-sm border px-2.5 py-2', msg.ok ? 'border-ok/50 text-ok bg-ok/10' : 'border-accent/50 text-accent bg-accent/10')}>
          {msg.text}
        </div>
      )}
      {list === null ? (
        <div className="flex items-center gap-3 py-4 text-muted text-sm">
          <Spinner /> Чтение сохранений…
        </div>
      ) : list.length === 0 ? (
        <div className="text-sm text-muted py-2">Сохранённых карьер пока нет. Начните новую карьеру — она будет сохраняться автоматически и появится в этом списке.</div>
      ) : (
        <ul className="grid grid-cols-1 lg:grid-cols-2 gap-3" data-save-list>
          {list.map((m) => (
            <SaveCard key={m.id + m.name} meta={m} current={m.id === currentId} busy={busy === m.id} onAct={act} onRenamed={renamed} />
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3 flex-wrap mt-3 text-[11px] text-muted">
        <Button size="sm" onClick={() => fileRef.current?.click()}>
          Загрузить сохранение из файла…
        </Button>
        <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void onImport(f); }} />
        <span>
          {backend === 'none'
            ? 'Хранилище браузера недоступно: карьеры не сохранятся между запусками. Используйте кнопку «В файл».'
            : `Сохранения хранятся в этом браузере${backend === 'localStorage' ? ' (место ограничено — держите не больше 2–3 карьер)' : ''}. Для переноса на другое устройство используйте «В файл».`}
        </span>
      </div>
    </div>
  );
}

/** Compact save indicator for the top bar. */
export function SaveIndicator({ onClick }: { onClick: () => void }) {
  const st = useSaveStatus();
  const t = statusText(st);
  return (
    <button onClick={onClick} title={`${t.title}. Нажмите, чтобы открыть сохранения.`} className={cn('flex items-center gap-2 text-xs rounded-sm border px-2.5 py-1.5 transition-colors bg-panel2 hover:border-muted', st.state === 'error' ? 'border-accent text-accent' : 'border-line text-text')}>
      <span className={cn('w-2 h-2 rounded-full shrink-0', st.state === 'saving' && 'animate-pulse')} style={{ background: t.color }} />
      <span className="font-semibold">Сохранения</span>
      <span className="hidden sm:inline text-muted" data-save-status>
        {t.text}
      </span>
    </button>
  );
}
