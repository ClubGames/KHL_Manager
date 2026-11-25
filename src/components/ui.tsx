import { createContext, useContext, useEffect, useState } from 'react';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { cn } from '../utils/cn';
import type { PosCode, Team } from '../types';
import { overallColor, POS_RU } from '../game/ratings';
import { getClubLogoSources, getOfficialClubPalette, hexLuminance } from '../game/clubColors';

export type View = 'inbox' | 'dashboard' | 'roster' | 'lines' | 'schedule' | 'standings' | 'stats' | 'trades' | 'market' | 'contracts' | 'club' | 'management' | 'format' | 'offseason';

export interface UIApi {
  openPlayer: (id: string) => void;
  /** club card: standings, staff, leaders, finances */
  openTeam: (id: string) => void;
  openGame: (id: number) => void;
  confirm: (opts: { title: string; text?: string; confirmLabel?: string; danger?: boolean; onYes: () => void }) => void;
  nav: (v: View) => void;
  tradeWith: (playerId: string) => void;
  /** open contract talks with a free agent or an own player */
  negotiate: (playerId: string) => void;
  /** the settings window (replays, video, match, simulation) */
  openSettings: () => void;
}
export const UIContext = createContext<UIApi>({
  openPlayer: () => {},
  openTeam: () => {},
  openGame: () => {},
  confirm: () => {},
  nav: () => {},
  tradeWith: () => {},
  negotiate: () => {},
  openSettings: () => {},
});
export const useUI = () => useContext(UIContext);

export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}

export function Panel({ title, right, children, className, noPad, ...rest }: Omit<HTMLAttributes<HTMLElement>, 'title'> & { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; noPad?: boolean }) {
  return (
    <section {...rest} className={cn('bg-panel border border-line rounded-md overflow-hidden', className)}>
      {title && (
        <header className="flex flex-wrap items-center justify-between gap-2 px-3 sm:px-4 py-2 sm:py-2.5 border-b border-line bg-panel2/60 min-h-[42px]">
          <h3 className="font-display uppercase tracking-wide text-sm text-text flex items-center gap-2 m-0 min-w-0">
            <span className="w-1.5 h-4 bg-accent slash shrink-0" />
            <span className="min-w-0">{title}</span>
          </h3>
          {right && <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">{right}</div>}
        </header>
      )}
      <div className={cn(!noPad && 'p-3 sm:p-4')}>{children}</div>
    </section>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'ice'; size?: 'sm' | 'md' | 'lg' };
export function Button({ variant = 'secondary', size = 'md', className, ...props }: BtnProps) {
  return (
    <button
      {...props}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 font-semibold rounded-sm transition-all duration-150 active:scale-[0.97] select-none whitespace-nowrap disabled:opacity-45 disabled:active:scale-100',
        variant === 'primary' && 'bg-accent text-white hover:bg-accent-dark slash pl-4 pr-5 shadow-[0_2px_0_0_#7a1119]',
        variant === 'ice' && 'bg-ice text-bg hover:brightness-110 slash pl-4 pr-5',
        variant === 'secondary' && 'bg-panel2 border border-line text-text hover:border-muted hover:bg-line/40',
        variant === 'ghost' && 'text-muted hover:text-text hover:bg-panel2',
        variant === 'danger' && 'border border-accent/50 text-accent hover:bg-accent/10',
        size === 'sm' && 'text-xs px-2.5 py-1.5 sm:py-1 min-h-[34px] sm:min-h-0',
        size === 'md' && 'text-sm px-3.5 py-2 min-h-[40px] sm:min-h-0',
        size === 'lg' && 'text-sm sm:text-base px-4 sm:px-5 py-2.5 min-h-[44px]',
        className
      )}
    />
  );
}

export function OverallChip({ value, size = 'md' }: { value: number; size?: 'sm' | 'md' | 'lg' }) {
  const c = overallColor(value);
  return (
    <span
      className={cn('font-display font-bold tabular inline-flex items-center justify-center rounded-sm border', size === 'sm' && 'text-xs w-8 h-5', size === 'md' && 'text-sm w-9 h-6', size === 'lg' && 'text-2xl w-14 h-10')}
      style={{ color: c, background: `${c}1f`, borderColor: `${c}66` }}
    >
      {value}
    </span>
  );
}

const POS_COLOR: Record<PosCode, string> = { C: '#8FD8F0', LW: '#8FD8F0', RW: '#8FD8F0', D: '#F2B544', G: '#3FCF8E' };
export function PosBadge({ pos }: { pos: PosCode }) {
  const c = POS_COLOR[pos];
  return (
    <span className="inline-flex items-center justify-center text-[11px] font-bold w-6 h-5 rounded-sm" style={{ color: c, background: `${c}22` }}>
      {POS_RU[pos]}
    </span>
  );
}

/**
 * Player (or coach) photo from roster.json `face`. Without a photo — or if it fails to load — shows the
 * initials (or the sweater number) on the club colours, so lists keep their rhythm.
 */
export function PlayerFace({
  face,
  name,
  number,
  team,
  size = 32,
  className,
  rounded = 'full',
}: {
  face?: string | null;
  name: string;
  number?: number;
  team?: Pick<Team, 'primaryColor' | 'secondaryColor'> | null;
  size?: number;
  className?: string;
  rounded?: 'full' | 'md';
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const bg = team?.primaryColor ?? '#22324A';
  const fg = team ? (hexLuminance(bg) > 0.55 ? '#0B1220' : team.secondaryColor && hexLuminance(team.secondaryColor) > 0.35 ? team.secondaryColor : '#FFFFFF') : '#C9D6E8';
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
  const shape = rounded === 'full' ? 'rounded-full' : 'rounded-md';
  const showImg = !!face && failed !== face;
  return (
    <span
      className={cn('relative inline-flex items-center justify-center shrink-0 overflow-hidden select-none border border-line/80', shape, className)}
      style={{ width: size, height: size, background: showImg ? '#0F1A2A' : bg }}
      data-face={showImg ? 'photo' : 'initials'}
      title={name}
    >
      {showImg ? (
        <img
          src={face!}
          alt={name}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailed(face!)}
          className="w-full h-full object-cover object-top"
        />
      ) : (
        <span className="font-display font-bold leading-none tabular" style={{ color: fg, fontSize: Math.max(9, Math.round(size * 0.38)) }}>
          {initials || (number != null ? number : '?')}
        </span>
      )}
    </span>
  );
}

export function TeamLogo({
  team,
  size = 32,
  className,
  fill = false,
}: {
  team: Pick<Team, 'short' | 'primaryColor' | 'secondaryColor'> & Partial<Pick<Team, 'id' | 'name' | 'logo'>>;
  size?: number;
  className?: string;
  /** stretch to the parent box (100% × 100%); `size` then only scales the lettering of the fallback badge */
  fill?: boolean;
}) {
  const box = fill ? { width: '100%', height: '100%' } : { width: size, height: size };
  const [failedUrls, setFailedUrls] = useState<Record<string, true>>({});
  const sources = getClubLogoSources(team);
  const activeSrc = sources.find((u) => !failedUrls[u]);

  if (activeSrc) {
    return (
      <span
        className={cn('inline-flex items-center justify-center shrink-0 select-none', className)}
        style={box}
        title={team.name ?? team.short}
      >
        <img
          src={activeSrc}
          alt={team.short}
          referrerPolicy="no-referrer"
          decoding="async"
          draggable={false}
          onError={() => setFailedUrls((prev) => (prev[activeSrc] ? prev : { ...prev, [activeSrc]: true }))}
          className="w-full h-full object-contain drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)]"
        />
      </span>
    );
  }

  const letters = team.short.length <= 4 ? team.short : team.short.slice(0, 3);
  const official = getOfficialClubPalette(team);
  const accent = official?.accentColor;
  const stripeH = Math.max(3, Math.round(size * 0.13));
  const secLum = hexLuminance(team.secondaryColor);
  const borderColor = secLum < 45 ? `${accent && hexLuminance(accent) >= 60 ? accent : '#FFFFFF'}66` : `${team.secondaryColor}66`;
  const fontSize = Math.max(9, Math.round(size * (letters.length >= 4 ? 0.27 : 0.34)));
  const boxShadow = accent
    ? `inset 0 -${stripeH}px 0 ${accent}`
    : `inset 0 -${stripeH}px 0 rgba(0,0,0,.28)`;
  return (
    <span
      className={cn('inline-flex items-center justify-center font-display font-bold uppercase shrink-0 rounded-sm slash select-none', className)}
      style={{
        ...box,
        background: team.primaryColor,
        color: team.secondaryColor,
        fontSize,
        lineHeight: 1,
        paddingBottom: Math.max(1, Math.round(stripeH * 0.45)),
        border: `1.5px solid ${borderColor}`,
        boxShadow,
      }}
      title={team.name ?? team.short}
    >
      {letters}
    </span>
  );
}

export function TeamName({ team, size = 24, className, short }: { team: Team; size?: number; className?: string; short?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2 min-w-0', className)}>
      <TeamLogo team={team} size={size} />
      <span className="truncate">{short ? team.short : team.name}</span>
    </span>
  );
}

export function Stat({ label, value, sub, color }: { label: string; value: ReactNode; sub?: ReactNode; color?: string }) {
  return (
    <div className="bg-panel2/70 border border-line/70 rounded-sm px-2.5 sm:px-3 py-2 min-w-0">
      <div className="text-[10px] sm:text-[11px] uppercase tracking-wider text-muted truncate">{label}</div>
      <div className="font-display text-lg sm:text-xl tabular leading-tight truncate" style={{ color: color ?? '#E8EEF5' }}>
        {value}
      </div>
      {sub && <div className="text-[11px] sm:text-xs text-muted truncate">{sub}</div>}
    </div>
  );
}

/** Open modals, newest last: Escape closes only the top one (a player card opened from a club card). */
const modalStack: object[] = [];

export function Modal({ open, onClose, title, children, width = 'max-w-2xl' }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const token = {};
    modalStack.push(token);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && modalStack[modalStack.length - 1] === token) {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', h);
    return () => {
      const i = modalStack.indexOf(token);
      if (i >= 0) modalStack.splice(i, 1);
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', h);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/70 backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cn('w-full bg-panel border-t sm:border border-line rounded-t-xl sm:rounded-md shadow-2xl max-h-[92dvh] flex flex-col fade-in pb-[env(safe-area-inset-bottom)] sm:pb-0', width)}>
        <div className="sm:hidden flex justify-center pt-2 pb-0.5">
          <span className="w-10 h-1 rounded-full bg-line" />
        </div>
        {title ? (
          <header className="flex items-center justify-between gap-3 px-4 py-2.5 sm:py-3 border-b border-line bg-panel2/60">
            <div className="min-w-0 font-semibold">{title}</div>
            <button onClick={onClose} className="w-9 h-9 -mr-1.5 inline-flex items-center justify-center rounded-sm text-muted hover:text-text hover:bg-panel2 text-2xl leading-none shrink-0" aria-label="Закрыть">
              ×
            </button>
          </header>
        ) : (
          <div className="sm:hidden flex justify-end px-3 pt-1">
            <button onClick={onClose} className="w-8 h-8 inline-flex items-center justify-center rounded-sm text-muted hover:text-text bg-panel2/70 text-xl leading-none" aria-label="Закрыть">
              ×
            </button>
          </div>
        )}
        <div className="overflow-y-auto overscroll-contain p-3.5 sm:p-4">{children}</div>
      </div>
    </div>
  );
}

export function Bar({ value, color, height = 6, className }: { value: number; color?: string; height?: number; className?: string }) {
  return (
    <div className={cn('w-full bg-line/70 rounded-full overflow-hidden', className)} style={{ height }}>
      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.max(2, Math.min(100, value))}%`, background: color ?? overallColor(value) }} />
    </div>
  );
}

const TONE_COLOR: Record<'accent' | 'good' | 'warn' | 'bad' | 'muted', string> = {
  accent: '#8FD8F0',
  good: '#3FCF8E',
  warn: '#F2B544',
  bad: '#E5323E',
  muted: '#93A4BC',
};

export function Tag({ children, color, tone, className }: { children: ReactNode; color?: string; tone?: 'accent' | 'good' | 'warn' | 'bad' | 'muted'; className?: string }) {
  const c = color ?? (tone ? TONE_COLOR[tone] : '#93A4BC');
  return (
    <span className={cn('inline-flex items-center text-[11px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-sm', className)} style={{ color: c, background: `${c}1f` }}>
      {children}
    </span>
  );
}

export function Empty({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="text-center py-8 text-muted text-sm">
      <div className="mb-2 text-2xl opacity-40">⌁</div>
      {text}
      {children}
    </div>
  );
}

export const money = (v: number) => {
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (a >= 1_000_000_000) return `${sign}${(a / 1_000_000_000).toFixed(2).replace('.', ',')} млрд ₽`;
  if (a >= 1_000_000) return `${sign}${(a / 1_000_000).toFixed(1).replace('.', ',')} млн ₽`;
  if (a >= 1_000) return `${sign}${Math.round(a / 1_000)} тыс. ₽`;
  return `${sign}${a} ₽`;
};

export function ResultPill({ code }: { code: string }) {
  const win = code.startsWith('В');
  const loss = code === 'П';
  const c = win ? '#3FCF8E' : loss ? '#E5323E' : '#F2B544';
  return (
    <span className="inline-flex items-center justify-center text-[10px] font-bold w-7 h-5 rounded-sm" style={{ color: c, background: `${c}22` }}>
      {code}
    </span>
  );
}

const ICONS: Record<string, ReactNode> = {
  dashboard: <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" /><rect x="13" y="10" width="8" height="11" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /></>,
  roster: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.7-3.6 3.3-5.5 6.5-5.5s5.8 1.9 6.5 5.5" /><circle cx="17" cy="9" r="2.5" /><path d="M16 14.6c3 .2 5 2 5.5 4.9" /></>,
  lines: <><path d="M4 6h16M4 12h16M4 18h10" /><circle cx="4" cy="6" r="1" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  table: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10M15 10v10" /></>,
  trade: <><path d="M4 8h14l-3-3M20 16H6l3 3" /></>,
  market: <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18" /></>,
  code: <><path d="M8 6l-5 6 5 6M16 6l5 6-5 6M13 4l-2 16" /></>,
  play: <><path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" /></>,
  fast: <><path d="M3 5v14l9-7zM12 5v14l9-7z" fill="currentColor" stroke="none" /></>,
  injury: <><path d="M12 5v14M5 12h14" /></>,
  news: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
  logout: <><path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9" /></>,
  pause: <><path d="M8 5v14M16 5v14" strokeWidth={3} /></>,
  chart: <><path d="M4 20V10M10 20V4M16 20v-7M21 20H3" /></>,
  more: <><circle cx="5" cy="12" r="1.6" fill="currentColor" /><circle cx="12" cy="12" r="1.6" fill="currentColor" /><circle cx="19" cy="12" r="1.6" fill="currentColor" /></>,
  contract: <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M9 13h7M9 17h4" /></>,
  save: <><path d="M5 3h11l4 4v14H5z" /><path d="M8 3v6h7V3M8 21v-7h9v7" /></>,
  trophy: <><path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M9 20h6" /></>,
  puck: <><ellipse cx="12" cy="7" rx="8" ry="3" /><path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7" /></>,
  check: <><path d="M5 12l5 5L20 7" /></>,
  close: <><path d="M6 6l12 12M18 6L6 18" /></>,
  swap: <><path d="M7 4v16M7 4L4 7M7 4l3 3M17 20V4M17 20l-3-3M17 20l3-3" /></>,
  bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 0 0 4 0" /></>,
  scout: <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
  alert: <><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18h.01" /></>,
  expand: <><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5h.01" strokeWidth={2.4} /></>,
  shrink: <><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></>,
};
export function Icon({ name, className }: { name: keyof typeof ICONS | string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('w-4 h-4 shrink-0', className)} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <div className={cn('w-6 h-6 border-2 border-line border-t-accent rounded-full animate-spin', className)} />;
}
