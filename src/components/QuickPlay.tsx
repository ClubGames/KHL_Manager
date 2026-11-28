// The menu's games of one's own (no career, saved nowhere): «Буллиты» — a shootout series played on the ice, the
// manager shooting for his club against the computer's goalie and shooters — and «Товарищеский матч», a whole
// played match. Two clubs from any installed mod (the online lobby's club picker), then the play screen.
import { useEffect, useState } from 'react';
import { listMods, type ModEntry } from '../game/mods';
import { GameSim } from '../game/engine';
import { matchTeam } from '../net/teamPack';
import type { TeamPack } from '../net/wire';
import type { Player, Team } from '../types';
import { cn } from '../utils/cn';
import { Button, Icon } from './ui';
import { FullscreenButton } from './FullscreenButton';
import { ClubCard, ClubPicker } from './online/OnlineScreen';
import { ShooterPicker } from './Shootout';
import { PlayMatchCore } from './PlayMatch';

export type QuickKind = 'so' | 'match';

interface Built { sim: GameSim; H: Team; A: Team; P: Record<string, Player>; userIdx: 0 | 1 }

/** The books of a game between two packs: the manager's club on side `userIdx`; a shootout starts in status 'so'. */
export function quickSim(mine: TeamPack, theirs: TeamPack, userIdx: 0 | 1, kind: QuickKind, shooters?: string[]): Built {
  const packs = userIdx === 0 ? [mine, theirs] : [theirs, mine];
  const [h, a] = [matchTeam(packs[0], 0), matchTeam(packs[1], 1)];
  const P = { ...h.players, ...a.players };
  const sim = new GameSim({ id: h.team.id, lineup: h.lineup, name: h.team.name }, { id: a.team.id, lineup: a.lineup, name: a.team.name }, P, false, null);
  if (kind === 'so') {
    // straight to the shootout after a goalless regulation and overtime
    sim.status = 'so';
    sim.period = 4;
    if (shooters?.length) sim.soOrder[userIdx] = shooters.map((id) => `${userIdx}~${id}`);
  }
  return { sim, H: h.team, A: a.team, P, userIdx };
}

export function QuickPlay({ kind, onClose }: { kind: QuickKind; onClose: () => void }) {
  const [entries, setEntries] = useState<ModEntry[] | null>(null);
  const [mine, setMine] = useState<TeamPack | null>(null);
  const [theirs, setTheirs] = useState<TeamPack | null>(null);
  const [tab, setTab] = useState<'mine' | 'theirs'>('mine');
  /** the manager's side: home shoots first in the shootout */
  const [side, setSide] = useState<0 | 1>(0);
  const [shooters, setShooters] = useState<string[]>([]);
  const [game, setGame] = useState<{ built: Built; n: number } | null>(null);
  useEffect(() => { listMods().then(setEntries, () => setEntries([])); }, []);

  // Esc / the pad's B / Android «Back» on the setup: back to the menu (the play screen has its own pause)
  useEffect(() => {
    if (game) return;
    const overlay = () => !!document.querySelector('div.fixed.inset-0, [role="dialog"], [aria-modal="true"]');
    const back = (e: Event) => { if (!overlay()) { e.preventDefault(); onClose(); } };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== 'Escape' || e.defaultPrevented || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      back(e);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('khl-back', back);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('khl-back', back); };
  }, [game, onClose]);

  // the club picked: the shooters are its best (the manager may change them), the opponent's tab comes next
  const pickMine = (p: TeamPack) => { setMine(p); setShooters([]); if (!theirs) setTab('theirs'); };
  const pickTheirs = (p: TeamPack) => { setTheirs(p); };
  const probe = mine && theirs ? quickSim(mine, theirs, side, kind) : null;
  const cands = probe ? probe.sim.shootoutCandidates(side).map((id) => id.slice(2)) : [];
  const pickPlayers = mine ? Object.fromEntries(mine.players.map((p) => [p.id, p])) as Record<string, Player> : {};
  const value = [...shooters.filter((id) => cands.includes(id)), ...cands.filter((id) => !shooters.includes(id))].slice(0, 3);

  const start = () => { if (mine && theirs) setGame((g) => ({ built: quickSim(mine, theirs, side, kind, kind === 'so' ? value : undefined), n: (g?.n ?? 0) + 1 })); };

  if (game) {
    const { built } = game;
    return (
      <PlayMatchCore key={game.n} sim={built.sim} H={built.H} A={built.A} P={built.P} userIdx={built.userIdx} onDone={() => setGame(null)}
        standalone={{ kind, onAgain: start, onQuit: () => setGame(null) }} />
    );
  }

  const title = kind === 'so' ? <>Серия <span className="text-accent">буллитов</span></> : <>Товарищеский <span className="text-accent">матч</span></>;
  return (
    <div className="relative min-h-screen rink-lines overflow-x-hidden" data-quick-play={kind}>
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse at 50% -10%, rgba(143,216,240,.13), transparent 55%)' }} />
      <div className="relative max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-8 pt-[max(1rem,env(safe-area-inset-top))]">
        <header className="flex items-center gap-3 mb-5">
          <button type="button" onClick={onClose} className="rounded-sm border border-line px-2.5 py-1.5 text-sm text-muted hover:text-text bg-bg/70" data-quick-back>← Меню</button>
          <div className="min-w-0">
            <p className="text-ice font-display uppercase tracking-[0.25em] text-[11px]">Вне карьеры · без сохранения</p>
            <h1 className="font-display text-2xl sm:text-4xl uppercase leading-none">{title}</h1>
          </div>
          <div className="ml-auto"><FullscreenButton className="bg-bg/70" /></div>
        </header>

        <p className="text-sm text-muted mb-4 max-w-3xl">
          {kind === 'so'
            ? 'Вы бьёте за свой клуб — один на один с вратарём, от центральной линии. Вратари и бьющие соперника — за компьютером. По три броска, при равенстве — по одному до первого промаха.'
            : 'Целый матч между любыми двумя клубами из установленных модов — вы управляете хоккеистом своей команды. Результат никуда не записывается.'}
        </p>

        <div className="grid grid-cols-2 gap-2 sm:gap-3 mb-3">
          <button type="button" className={cn('text-left rounded-md', tab === 'mine' && 'ring-2 ring-ice')} onClick={() => setTab('mine')} data-quick-tab="mine">
            <ClubCard title="Ваш клуб" pack={mine} ready={!!mine} mine side={side} />
          </button>
          <button type="button" className={cn('text-left rounded-md', tab === 'theirs' && 'ring-2 ring-ice')} onClick={() => setTab('theirs')} data-quick-tab="theirs">
            <ClubCard title="Соперник" pack={theirs} ready={!!theirs} side={1 - side} />
          </button>
        </div>

        <div className="mb-3" data-quick-picker={tab}>
          {tab === 'mine'
            ? <ClubPicker key="mine" title="Ваш клуб" entries={entries} pack={mine} onPick={pickMine} />
            : <ClubPicker key="theirs" title="Соперник" entries={entries} pack={theirs} onPick={pickTheirs} />}
        </div>

        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="inline-flex rounded-sm border border-line overflow-hidden text-sm" role="group" aria-label="Площадка">
            {([0, 1] as const).map((sd) => (
              <button key={sd} type="button" onClick={() => setSide(sd)} aria-pressed={side === sd}
                className={cn('px-3 py-1.5', side === sd ? 'bg-ice/15 text-ice' : 'text-muted hover:text-text bg-bg/60')} data-quick-side={sd}>
                {sd === 0 ? (kind === 'so' ? 'Вы бьёте первыми' : 'Вы дома') : (kind === 'so' ? 'Первым бьёт соперник' : 'Вы в гостях')}
              </button>
            ))}
          </div>
        </div>

        {kind === 'so' && mine && cands.length > 0 && (
          <div className="mb-4"><ShooterPicker candidates={cands} value={value} players={pickPlayers} onChange={setShooters} /></div>
        )}

        <Button variant="primary" size="lg" onClick={start} disabled={!mine || !theirs} data-quick-start>
          <Icon name="play" /> {kind === 'so' ? 'На лёд — к буллитам' : 'На лёд'}
        </Button>
        {(!mine || !theirs) && <span className="ml-3 text-xs text-muted">{!mine ? 'Выберите свой клуб' : 'Выберите соперника'}</span>}
      </div>
    </div>
  );
}
