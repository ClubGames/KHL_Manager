// The first screen of the game: «Играть» (the career and the other modes of one's own), «Онлайн» (a match with a
// friend over Wi-Fi), the settings — and «Продолжить» straight into the latest career when there is one. Keyboard
// (↑ ↓, Enter, Esc), a gamepad (the app-wide pad navigation) and touch all work; Esc / B / Android «Back» on the
// second level go back to the first.
import { useEffect, useRef, useState } from 'react';
import { listSaves, loadCareer, type SaveMeta } from '../game/state';
import { APP_RELEASE, platform } from '../platform';
import { GAME_NAME_EN, GAME_NAME_RU } from '../brand';
import { cn } from '../utils/cn';
import { FullscreenButton } from './FullscreenButton';
import { Icon, Spinner, TeamLogo, useUI } from './ui';

const arena = './arena.jpg';
const gameLogo = './icon-game.png';

/** The modes behind «Играть». */
export type PlayMode = 'career' | 'shootout' | 'friendly';
type Level = 'main' | 'play';

function progress(m: SaveMeta): string {
  if (m.phase === 'offseason') return `сезон ${m.season} · межсезонье`;
  if (m.phase === 'playoffs') return `сезон ${m.season} · плей-офф`;
  return `сезон ${m.season} · матч ${Math.min(m.gp + 1, m.gamesPerTeam)} из ${m.gamesPerTeam}`;
}

/** One line of the menu: a big title, a short line under it, an icon on the left, an arrow on the right. */
function Tile({ title, sub, icon, onClick, tone = 'line', busy, id, badge }: {
  title: string; sub?: React.ReactNode; icon: React.ReactNode; onClick: () => void; tone?: 'accent' | 'ice' | 'line'; busy?: boolean; id: string; badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      data-menu-item={id}
      className={cn(
        'group relative w-full overflow-hidden rounded-md border bg-panel/85 backdrop-blur-sm text-left px-4 py-3.5 sm:py-4 land:py-2.5 flex items-center gap-4 transition-[border-color,transform,background-color] duration-150',
        'hover:bg-panel focus-visible:bg-panel hover:translate-x-1 focus-visible:translate-x-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ice/70',
        tone === 'accent' ? 'border-accent/55 hover:border-accent' : tone === 'ice' ? 'border-ice/45 hover:border-ice/80' : 'border-line hover:border-text/40',
      )}
    >
      <span className={cn('absolute left-0 top-0 bottom-0 w-1 slash', tone === 'accent' ? 'bg-accent' : tone === 'ice' ? 'bg-ice' : 'bg-line')} />
      <span className={cn('relative w-11 h-11 shrink-0 rounded-full flex items-center justify-center text-xl',
        tone === 'accent' ? 'bg-accent/15 text-accent' : tone === 'ice' ? 'bg-ice/15 text-ice' : 'bg-panel2 text-text/80')}>{busy ? <Spinner /> : icon}</span>
      <span className="relative min-w-0 flex-1">
        <span className="block font-display uppercase tracking-wide text-xl sm:text-2xl land:text-xl leading-none">
          {title}
          {badge && <span className="text-[10px] align-middle ml-2 rounded-sm bg-accent text-white px-1.5 py-0.5 tracking-widest">{badge}</span>}
        </span>
        {sub && <span className="block text-xs text-muted mt-1 truncate">{sub}</span>}
      </span>
      <span className="relative text-muted group-hover:text-text group-focus-visible:text-text text-lg transition-transform group-hover:translate-x-0.5" aria-hidden>›</span>
    </button>
  );
}

export function MainMenu({ onPlay, onOnline }: { onPlay: (mode: PlayMode) => void; onOnline: () => void }) {
  const ui = useUI();
  const [level, setLevel] = useState<Level>('main');
  const [latest, setLatest] = useState<SaveMeta | null>(null);
  const [saves, setSaves] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    listSaves().then((l) => { if (!alive) return; setSaves(l.length); setLatest([...l].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null); }).catch(() => alive && setSaves(0));
    return () => { alive = false; };
  }, []);

  // a level opens with its first line focused (the keyboard and the pad start there; the mouse sees no ring)
  useEffect(() => {
    const first = list.current?.querySelector<HTMLButtonElement>('[data-menu-item]');
    if (first && (document.activeElement === document.body || !document.activeElement || list.current?.contains(document.activeElement) || level === 'play')) first.focus({ preventScroll: true });
  }, [level, latest]);

  // ↑ ↓ walk the lines, Esc / «Back» go up a level
  useEffect(() => {
    const overlay = () => !!document.querySelector('div.fixed.inset-0, [role="dialog"], [aria-modal="true"]');
    const onKey = (e: KeyboardEvent) => {
      if (overlay() || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === 'Escape' && level !== 'main') { e.preventDefault(); setLevel('main'); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = [...(list.current?.querySelectorAll<HTMLButtonElement>('[data-menu-item]:not(:disabled)') ?? [])];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      const n = i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[n].focus();
      e.preventDefault();
    };
    const onBack = (e: Event) => { if (level !== 'main' && !overlay()) { e.preventDefault(); setLevel('main'); } };
    window.addEventListener('keydown', onKey);
    window.addEventListener('khl-back', onBack);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('khl-back', onBack); };
  }, [level]);

  const resume = async () => {
    if (!latest) return;
    setLoading(true);
    setErr('');
    const e = await loadCareer(latest.id);
    setLoading(false);
    if (e) setErr(e);
  };

  return (
    <div className="relative min-h-[100dvh] overflow-hidden bg-bg text-text" data-main-menu={level}>
      {/* the arena under the menu, dimmed towards the menu side; a slow light drifting over the ice */}
      <div className="absolute inset-0 bg-cover menu-pan" style={{ backgroundImage: `url(${arena})`, backgroundPosition: 'center 55%' }} />
      <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/75 to-bg/30 md:bg-gradient-to-r md:from-bg/40 md:via-bg/80 md:to-bg" />
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse at 20% 0%, rgba(229,50,62,.16), transparent 55%), radial-gradient(ellipse at 90% 100%, rgba(143,216,240,.12), transparent 50%)' }} />
      <div className="absolute inset-0 pointer-events-none menu-glint" />

      <div className="absolute top-3 right-3 z-10 flex gap-2">
        {platform() === 'web' && (
          <a href={APP_RELEASE} target="_blank" rel="noopener" title={`${GAME_NAME_RU} для Windows и Android: отдельное окно, видеокарта всегда включена`} className="hidden sm:inline-flex items-center gap-1.5 px-2 py-1 rounded-sm border border-line text-xs text-muted hover:text-text bg-bg/70 backdrop-blur" data-startup-apps>
            ⤓ Приложения
          </a>
        )}
        <FullscreenButton label className="bg-bg/70 backdrop-blur" />
      </div>

      <div className="relative max-w-6xl mx-auto px-4 sm:px-6 min-h-[100dvh] grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(340px,430px)] land:grid-cols-[minmax(0,1fr)_minmax(320px,400px)] gap-6 md:gap-10 land:gap-6 content-center py-14 md:py-10 land:py-3">
        <div className="min-w-0 flex items-center md:items-start md:flex-col land:flex-col land:items-start gap-4 md:gap-5 land:gap-2 fade-in">
          <img src={gameLogo} alt="" className="w-20 h-20 sm:w-28 sm:h-28 md:w-40 md:h-40 land:w-16 land:h-16 object-contain shrink-0 drop-shadow-[0_6px_24px_rgba(0,0,0,0.65)]" data-game-logo />
          <div className="min-w-0">
            <p className="text-ice font-display uppercase tracking-[0.25em] text-[11px] sm:text-xs">{GAME_NAME_EN}</p>
            <h1 className="font-display text-3xl sm:text-5xl md:text-6xl land:text-3xl font-bold uppercase leading-[0.95] mt-1.5 break-words">
              Хоккейный симулятор <span className="text-accent">менеджера</span>
            </h1>
            <p className="hidden md:block land:hidden text-muted mt-4 max-w-md text-sm">Ведите клуб через сезон и плей-офф, выходите на лёд сами, играйте с другом по сети.</p>
          </div>
        </div>

        <nav ref={list} aria-label="Главное меню" className="min-w-0 flex flex-col gap-2.5 land:gap-2 fade-in" key={level}>
          {level === 'main' ? (
            <>
              {latest && (
                <Tile id="continue" tone="accent" onClick={() => void resume()} busy={loading}
                  icon={<TeamLogo team={{ id: latest.teamId, name: latest.teamName, short: latest.teamShort, primaryColor: latest.primaryColor, secondaryColor: latest.secondaryColor, logo: latest.logo }} size={30} />}
                  title="Продолжить" sub={<><b className="text-text/90 font-semibold">{latest.teamName}</b> · {progress(latest)}</>} />
              )}
              <Tile id="play" tone={latest ? 'line' : 'accent'} icon={<Icon name="play" className="w-5 h-5" />} onClick={() => setLevel('play')}
                title="Играть" sub="Карьера, буллиты, товарищеский матч" />
              <Tile id="online" tone="ice" icon="⇄" onClick={onOnline} title="Онлайн" sub="Матч с другом по Wi-Fi — телефон или компьютер" />
              <Tile id="settings" icon={<Icon name="settings" className="w-5 h-5" />} onClick={() => ui.openSettings()} title="Настройки" sub="Графика, звук, управление" />
              {err && <div className="text-xs text-accent px-1" role="alert">{err}</div>}
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-1">
                <button type="button" onClick={() => setLevel('main')} className="px-2 py-1 rounded-sm border border-line text-xs text-muted hover:text-text bg-bg/70 backdrop-blur" data-menu-back>← Назад</button>
                <h2 className="font-display uppercase tracking-wide text-lg m-0 flex items-center gap-2"><span className="w-1.5 h-4 bg-accent slash" />Играть</h2>
              </div>
              <Tile id="career" tone="accent" icon={<Icon name="trophy" className="w-5 h-5" />} onClick={() => onPlay('career')}
                title="Карьера" sub={saves ? `Новая карьера или сохранения (${saves}) — клуб, звенья, обмены, плей-офф` : 'Возьмите клуб: звенья, обмены, контракты, плей-офф'} />
              <Tile id="shootout" tone="ice" icon={<span className="font-display text-lg leading-none">1:1</span>} onClick={() => onPlay('shootout')}
                title="Буллиты" sub="Серия буллитов: вы бьёте, вратарь соперника — компьютер" />
              <Tile id="friendly" icon={<Icon name="play" className="w-5 h-5" />} onClick={() => onPlay('friendly')}
                title="Товарищеский матч" sub="Любые два клуба, вы на льду — без сохранения" />
            </>
          )}
        </nav>
      </div>
      <div className="absolute bottom-2 left-0 right-0 text-center text-[10px] text-muted/70 pointer-events-none land:hidden">{GAME_NAME_RU}</div>
    </div>
  );
}
