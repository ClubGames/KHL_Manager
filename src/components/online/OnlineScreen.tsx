import { useEffect, useMemo, useRef, useState } from 'react';
import { listMods, loadMod, type ModEntry } from '../../game/mods';
import type { NormalizedRoster } from '../../game/roster';
import { isGoalie, isSkater } from '../../game/ratings';
import { platform } from '../../platform';
import { buildLabel, currentBuild } from '../../update';
import { cn } from '../../utils/cn';
import { Button, Icon, Panel, Spinner, TeamLogo, useUI } from '../ui';
import { FullscreenButton } from '../FullscreenButton';
import { loopLan, nativeLan, type Lan, type Room } from '../../net/lan';
import { modInfo, packTeam } from '../../net/teamPack';
import { OnlineSession, type LobbyState } from '../../net/session';
import { LAN_PORT, PROTO, type MatchSettings, type ModInfo, type TeamPack } from '../../net/wire';
import type { PenaltyClock } from '../../game/playRink';
import { OnlineMatch } from './OnlineMatch';

/**
 * «Сетевая игра» — a match against a friend on the same network, outside the career: one creates the game, the other
 * finds it in the list (or types its address), each picks a club from his own mods — a club the other has no mod for
 * comes over whole — the host sets the match, both press «Готов», and they play. After the final: a rematch.
 */
const NAME_KEY = 'khl-online-name';
const PLATFORM_LABEL: Record<string, string> = { android: 'Android', windows: 'Windows', web: 'браузер' };
const PERIODS = [3, 5, 8, 12, 20] as const;
const PEN_CLOCKS: [PenaltyClock, string][] = [['period', 'Как период'], ['real', 'Реальные 2 мин'], [2, '2× быстрее'], [4, '4× быстрее']];

function appLabel() { const b = currentBuild(); return b ? buildLabel(b) : 'dev'; }
function defaultName() {
  try { const s = localStorage.getItem(NAME_KEY); if (s?.trim()) return s.trim().slice(0, 24); } catch { /* private mode */ }
  return platform() === 'android' ? 'Игрок с телефона' : platform() === 'windows' ? 'Игрок с ПК' : 'Игрок';
}
/** «192.168.1.5» or «192.168.1.5:47811» → host and port (null: not an address). */
export function parseAddress(s: string): { host: string; port: number } | null {
  const t = s.trim().replace(/^\w+:\/\//, '').replace(/\/.*$/, '');
  const m = /^([a-zA-Z0-9.\-]+)(?::(\d{2,5}))?$/.exec(t);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : LAN_PORT;
  if (port < 1 || port > 65535) return null;
  return { host: m[1], port };
}
export function packStrength(p: Pick<TeamPack, 'players'>): number {
  const sk = p.players.filter(isSkater).sort((a, b) => b.overall - a.overall).slice(0, 12);
  const g = p.players.filter(isGoalie).sort((a, b) => b.overall - a.overall)[0];
  const all = g ? [...sk, g] : sk;
  return all.length ? Math.round(all.reduce((s, x) => s + x.overall, 0) / all.length) : 0;
}

export function OnlineScreen({ onClose }: { onClose: () => void }) {
  const ui = useUI();
  const native = useMemo(() => nativeLan(), []);
  const loop = useMemo(() => loopLan(), []);
  const lan: Lan | null = native ?? loop;
  const [name, setName] = useState(defaultName);
  const [entries, setEntries] = useState<ModEntry[] | null>(null);
  const [phase, setPhase] = useState<'menu' | 'host' | 'joining'>('menu');
  const [hostInfo, setHostInfo] = useState<{ port: number; addresses: string[] } | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [addr, setAddr] = useState('');
  const [notice, setNotice] = useState<{ text: string; tone: 'bad' | 'info' } | null>(null);
  const [session, setSession] = useState<OnlineSession | null>(null);
  const [st, setSt] = useState<LobbyState | null>(null);
  const [myAddr, setMyAddr] = useState<string[]>([]);
  const sessionRef = useRef<OnlineSession | null>(null);
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const mods: ModInfo[] = useMemo(() => (entries ?? []).map(modInfo), [entries]);
  const me = () => ({ name: name.trim().slice(0, 24) || 'Игрок', mods, platform: platform(), app: appLabel() });
  const beaconOf = (busy = false, team?: string) => ({ name: me().name, team, app: appLabel(), v: PROTO, busy });

  useEffect(() => { listMods().then(setEntries, () => setEntries([])); }, []);
  useEffect(() => { try { localStorage.setItem(NAME_KEY, name.trim()); } catch { /* private mode */ } }, [name]);
  useEffect(() => { if (native) void native.addresses().then(setMyAddr); }, [native]);
  // the network's games, while looking for one
  useEffect(() => {
    if (!lan || phase !== 'menu' || session) return;
    return lan.scan(setRooms);
  }, [lan, phase, session]);
  // leaving the screen: the game and the connection go
  useEffect(() => () => { sessionRef.current?.leave('вышел из сетевой игры'); sessionRef.current?.dispose(); void lan?.stopHost(); if (lan) lan.onGuest = null; }, [lan]);

  const attach = (s: OnlineSession) => {
    sessionRef.current = s;
    setSession(s); setSt(s.state);
    s.subscribe((x) => {
      setSt(x);
      if (x.stage === 'closed') {
        s.dispose();
        if (sessionRef.current === s) { sessionRef.current = null; setSession(null); setSt(null); }
        setNotice({ text: x.closed ?? 'соединение закрыто', tone: 'bad' });
        // the host goes on waiting for a guest; the guest is back at the list
        if (phaseRef.current === 'host' && lan) lan.beacon(beaconOf(false));
        else setPhase('menu');
      }
    });
  };

  const host = async () => {
    if (!lan) return;
    setNotice(null);
    lan.onGuest = (link) => {
      if (sessionRef.current) { link.send({ t: 'busy' }); link.close(); return; }
      attach(new OnlineSession(link, 'host', me()));
      lan.beacon(beaconOf(true));
    };
    try {
      const r = await lan.host(beaconOf(false));
      setHostInfo(r); setPhase('host');
    } catch (e) {
      setNotice({ text: `Не удалось создать игру: ${(e as Error).message || e}. Возможно, порт ${LAN_PORT} занят другой программой или сеть запрещает входящие соединения.`, tone: 'bad' });
    }
  };
  const stopHosting = () => { void lan?.stopHost(); if (lan) lan.onGuest = null; setPhase('menu'); setHostInfo(null); };
  const join = async (h: string, port?: number) => {
    if (!lan) return;
    setNotice(null); setPhase('joining');
    try {
      const link = await lan.join(h, port);
      attach(new OnlineSession(link, 'guest', me()));
    } catch (e) {
      setPhase('menu');
      setNotice({ text: `Не удалось подключиться: ${(e as Error).message || e}`, tone: 'bad' });
    }
  };
  const leave = () => {
    const s = sessionRef.current;
    const go = () => { s?.leave(); };
    if (s?.state.stage === 'match') ui.confirm({ title: 'Выйти из сетевого матча?', text: 'Матч прервётся для обоих игроков.', confirmLabel: 'Выйти', danger: true, onYes: go });
    else go();
  };
  const exit = () => {
    if (sessionRef.current) ui.confirm({ title: 'Выйти из сетевой игры?', text: 'Соединение с соперником закроется.', confirmLabel: 'Выйти', danger: true, onYes: () => { sessionRef.current?.leave(); stopHosting(); onClose(); } });
    else { stopHosting(); onClose(); }
  };

  // the match fills the screen
  if (session && st?.stage === 'match' && st.packs) {
    return <OnlineMatch key={st.matchNo} session={session} packs={st.packs} onLobby={() => session.backToLobby()} onLeave={leave} />;
  }

  const modeLabel = lan?.kind === 'android' ? 'Wi-Fi · Android' : lan?.kind === 'windows' ? 'локальная сеть · Windows' : 'две вкладки браузера';
  return (
    <div className="relative min-h-screen rink-lines overflow-x-hidden" data-online-screen>
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse at 50% -10%, rgba(143,216,240,.13), transparent 55%)' }} />
      <div className="relative max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-8 pt-[max(1rem,env(safe-area-inset-top))]">
        <header className="flex items-center gap-3 mb-5">
          <button type="button" onClick={exit} className="rounded-sm border border-line px-2.5 py-1.5 text-sm text-muted hover:text-text bg-bg/70" data-online-back>← Назад</button>
          <div className="min-w-0">
            <p className="text-ice font-display uppercase tracking-[0.25em] text-[11px]">Вне карьеры</p>
            <h1 className="font-display text-2xl sm:text-4xl uppercase leading-none">Сетевая <span className="text-accent">игра</span></h1>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {lan && <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-muted border border-line rounded-sm px-2 py-1 bg-bg/70"><span className="w-1.5 h-1.5 rounded-full bg-ok" />{modeLabel}</span>}
            <FullscreenButton className="bg-bg/70" />
          </div>
        </header>

        {notice && (
          <div className={cn('mb-4 rounded-md border px-3 py-2 text-sm flex items-start gap-2', notice.tone === 'bad' ? 'border-accent/50 bg-accent/10' : 'border-ice/40 bg-ice/10')} data-online-notice>
            <Icon name={notice.tone === 'bad' ? 'alert' : 'info'} className="mt-0.5 shrink-0" />
            <span className="flex-1">{notice.text}</span>
            <button type="button" className="text-muted hover:text-text" onClick={() => setNotice(null)} aria-label="Скрыть">✕</button>
          </div>
        )}

        {session && st ? (
          <Lobby session={session} st={st} entries={entries} onLeave={leave} />
        ) : (
          <>
            {!native && (
              <div className="mb-4 rounded-md border border-amber/40 bg-amber/10 px-3 py-2.5 text-sm" data-online-browser>
                <b className="text-amber">В браузере сеть недоступна.</b> Страница не может принимать соединения, поэтому по Wi-Fi играют
                приложения для <b>Android</b> и <b>Windows</b> (телефон с компьютером тоже). Здесь можно попробовать режим — откройте игру во
                второй вкладке этого браузера: вкладки увидят друг друга как два устройства.
              </div>
            )}
            <div className="grid md:grid-cols-[1fr_1.25fr] gap-4">
              <Panel title="Вы">
                <label className="block text-xs text-muted mb-1" htmlFor="online-name">Имя в сети</label>
                <input id="online-name" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} disabled={phase !== 'menu'}
                  className="w-full bg-panel2 border border-line rounded-sm px-3 py-2 text-sm focus:outline-none focus:border-ice" data-online-name />
                <div className="mt-4">
                  {phase === 'host' && hostInfo ? (
                    <div className="rounded-md border border-ice/40 bg-ice/5 p-3" data-online-hosting>
                      <div className="flex items-center gap-2 font-semibold"><Spinner className="w-4 h-4" /> Ждём соперника…</div>
                      {lan?.kind === 'loop' ? (
                        <p className="text-xs text-muted mt-2">Откройте игру во второй вкладке → «Сетевая игра» — эта игра появится в её списке.</p>
                      ) : (
                        <>
                          <p className="text-xs text-muted mt-2">Игра видна всем в вашей сети. Если соперник её не видит — пусть введёт адрес вручную:</p>
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {hostInfo.addresses.length ? hostInfo.addresses.map((a) => (
                              <code key={a} className="bg-panel2 border border-line rounded-sm px-2 py-1 text-ice text-sm tabular" data-online-address>{a}{hostInfo.port !== LAN_PORT ? `:${hostInfo.port}` : ''}</code>
                            )) : <span className="text-xs text-muted">нет подключения к сети</span>}
                          </div>
                        </>
                      )}
                      <Button variant="ghost" size="sm" className="mt-3" onClick={stopHosting}>Отменить</Button>
                    </div>
                  ) : (
                    <Button variant="primary" size="lg" className="w-full" disabled={!lan || phase !== 'menu' || !entries} onClick={() => void host()} data-online-host>
                      <Icon name="plus" /> Создать игру
                    </Button>
                  )}
                </div>
                <p className="text-[11px] text-muted mt-3 leading-relaxed">
                  Матч идёт на устройстве того, кто создал игру; второе показывает его и передаёт управление. Карьера и сохранения не затрагиваются.
                </p>
              </Panel>

              <Panel title="Найти игру" right={lan && phase === 'menu' ? <span className="inline-flex items-center gap-1.5 text-[11px] text-muted"><Spinner className="w-3 h-3" /> поиск в сети</span> : undefined}>
                {phase === 'joining' ? (
                  <div className="flex items-center gap-2 py-6 justify-center text-sm"><Spinner className="w-4 h-4" /> Подключаемся…</div>
                ) : (
                  <>
                    <div className="space-y-1.5 min-h-[96px]" data-online-rooms>
                      {rooms.length === 0 && (
                        <div className="text-sm text-muted text-center py-6 border border-dashed border-line rounded-md">
                          {phase === 'host' ? 'Вы ждёте соперника — поиск остановлен' : 'Пока никого. Попросите друга нажать «Создать игру».'}
                        </div>
                      )}
                      {rooms.map((r) => {
                        const other = r.v !== PROTO;
                        return (
                          <button key={`${r.host}:${r.port}`} type="button" disabled={phase !== 'menu' || r.busy || other} onClick={() => void join(r.host, r.port || undefined)}
                            className="w-full flex items-center gap-3 rounded-md border border-line bg-panel2 hover:border-ice/60 px-3 py-2 text-left disabled:opacity-55 disabled:hover:border-line" data-online-room>
                            <span className="w-9 h-9 rounded-full bg-ice/15 text-ice flex items-center justify-center font-display">{r.name.slice(0, 1).toUpperCase()}</span>
                            <span className="min-w-0 flex-1">
                              <span className="block font-semibold truncate">{r.name}</span>
                              <span className="block text-[11px] text-muted truncate">{r.team ? `${r.team} · ` : ''}{lan?.kind === 'loop' ? 'другая вкладка' : r.host}{r.app ? ` · ${r.app}` : ''}</span>
                            </span>
                            {r.busy ? <span className="text-[11px] text-amber">идёт матч</span> : other ? <span className="text-[11px] text-accent">другая версия</span> : <span className="text-xs font-semibold text-ice">Играть →</span>}
                          </button>
                        );
                      })}
                    </div>
                    {native && (
                      <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); const a = parseAddress(addr); if (a) void join(a.host, a.port); else setNotice({ text: 'Адрес выглядит так: 192.168.1.5 (можно с портом: 192.168.1.5:47810)', tone: 'info' }); }}>
                        <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Адрес вручную: 192.168.1.5" inputMode="decimal" disabled={phase !== 'menu'}
                          className="flex-1 min-w-0 bg-panel2 border border-line rounded-sm px-3 py-2 text-sm tabular focus:outline-none focus:border-ice" data-online-addr />
                        <Button type="submit" disabled={phase !== 'menu' || !addr.trim()}>Подключиться</Button>
                      </form>
                    )}
                    {native && myAddr.length > 0 && <p className="text-[11px] text-muted mt-2">Адрес этого устройства: {myAddr.join(', ')}</p>}
                  </>
                )}
              </Panel>
            </div>
            <Tips native={!!native} />
          </>
        )}
      </div>
    </div>
  );
}

function Tips({ native }: { native: boolean }) {
  return (
    <details className="mt-4 rounded-md border border-line bg-panel/70 px-3 py-2 text-sm" data-online-tips>
      <summary className="cursor-pointer font-semibold">Как сыграть {native ? 'по сети' : 'с другом'}: советы</summary>
      <ul className="mt-2 space-y-1.5 text-muted text-xs leading-relaxed list-disc pl-4">
        <li>Оба устройства — в одной сети Wi-Fi (или одно раздаёт точку доступа, а второе к ней подключено). Телефон с компьютером играть могут.</li>
        <li>Игра не видна в списке? Роутеры с «изоляцией клиентов» (гостевые сети) блокируют поиск — введите адрес хозяина вручную. Windows при первом запуске спросит разрешение брандмауэра — разрешите для частных сетей.</li>
        <li>Далеко друг от друга? Программы вроде Radmin VPN, ZeroTier или Tailscale (бесплатные) объединяют два компьютера в одну «локальную сеть» — затем подключение по адресу из этой программы.</li>
        <li>Моды у игроков могут быть разными: каждый выбирает клуб из своих модов, и клуб передаётся сопернику целиком — составы, рейтинги, цвета и логотип. Ничего устанавливать не нужно.</li>
        <li>Обе копии игры должны быть одной версии сетевого протокола — если в списке написано «другая версия», обновите игру.</li>
      </ul>
    </details>
  );
}

/* ------------------------------------------------ the lobby ------------------------------------------------ */
function Lobby({ session, st, entries, onLeave }: { session: OnlineSession; st: LobbyState; entries: ModEntry[] | null; onLeave: () => void }) {
  const host = st.role === 'host';
  if (st.stage === 'hello') {
    return <Panel><div className="flex items-center gap-2 justify-center py-8"><Spinner className="w-5 h-5" /> Соединяемся с соперником…</div></Panel>;
  }
  const peer = st.peer;
  const s = st.settings;
  const canReady = !!st.myPack;
  const both = !!st.myPack && !!st.peerPack;
  return (
    <div className="space-y-4" data-online-lobby={st.role}>
      <div className="flex items-center gap-3 rounded-md border border-line bg-panel px-3 py-2">
        <span className="w-2 h-2 rounded-full bg-ok" />
        <span className="text-sm">Соперник: <b data-online-peer>{peer?.name ?? '—'}</b> <span className="text-muted text-xs">· {PLATFORM_LABEL[peer?.platform ?? ''] ?? peer?.platform}{peer?.app ? ` · ${peer.app}` : ''}</span></span>
        <span className={cn('ml-auto text-xs tabular', st.rtt === null ? 'text-muted' : st.rtt < 60 ? 'text-ok' : st.rtt < 150 ? 'text-amber' : 'text-accent')} title="Задержка связи">{st.rtt === null ? '…' : `${st.rtt} мс`}</span>
        <Button variant="ghost" size="sm" onClick={onLeave} data-online-leave-lobby>Выйти</Button>
      </div>

      {/* the match-up */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-2 sm:gap-4">
        <ClubCard title={host ? `${st.name} · хозяин` : st.name} pack={st.myPack} ready={st.myReady} mine side={host ? s.hostSide : 1 - s.hostSide} />
        <div className="flex items-center font-display text-xl sm:text-3xl text-muted">VS</div>
        <ClubCard title={peer?.name ?? 'Соперник'} pack={st.peerPack} ready={st.peerReady} side={host ? 1 - s.hostSide : s.hostSide} hint={st.peerPack ? peerModHint(st.peerPack, entries) : undefined} />
      </div>

      <div className="grid lg:grid-cols-[1.4fr_1fr] gap-4">
        <ClubPicker entries={entries} pack={st.myPack} onPick={(p) => session.pickTeam(p)} />
        <div className="space-y-4">
          <Panel title="Настройки матча" right={!host ? <span className="text-[11px] text-muted">задаёт хозяин игры</span> : undefined}>
            <Setting label="Период" hint="реальных минут на 20 игровых">
              {PERIODS.map((m) => <Chip key={m} on={s.periodMinutes === m} disabled={!host} onClick={() => session.setSettings({ periodMinutes: m })}>{m} мин</Chip>)}
            </Setting>
            <Setting label="Штрафное время">
              {PEN_CLOCKS.map(([v, l]) => <Chip key={String(v)} on={s.penaltyClock === v} disabled={!host} onClick={() => session.setSettings({ penaltyClock: v } as Partial<MatchSettings>)}>{l}</Chip>)}
            </Setting>
            <Setting label="Хозяева площадки">
              <Chip on={s.hostSide === 0} disabled={!host} onClick={() => session.setSettings({ hostSide: 0 })}>{host ? 'Вы' : peer?.name ?? 'Соперник'}</Chip>
              <Chip on={s.hostSide === 1} disabled={!host} onClick={() => session.setSettings({ hostSide: 1 })}>{host ? peer?.name ?? 'Соперник' : 'Вы'}</Chip>
            </Setting>
          </Panel>
          {st.mods && <ModsPanel cmp={st.mods} peer={peer?.name ?? 'соперник'} />}
        </div>
      </div>

      {/* ready */}
      <div className="sticky bottom-0 -mx-3 sm:mx-0 px-3 py-3 bg-bg/90 backdrop-blur border-t border-line sm:border sm:rounded-md flex flex-wrap items-center gap-3 pb-[max(.75rem,env(safe-area-inset-bottom))]" data-online-readybar>
        <div className="flex gap-2 flex-wrap text-xs">
          <ReadyChip name="Вы" on={st.myReady} />
          <ReadyChip name={peer?.name ?? 'Соперник'} on={st.peerReady} />
        </div>
        <span className="text-xs text-muted hidden sm:block">
          {!st.myPack ? 'Выберите клуб' : !st.peerPack ? 'Соперник выбирает клуб…' : st.myReady && !st.peerReady ? 'Ждём готовности соперника…' : !st.myReady ? 'Матч начнётся, когда оба нажмут «Готов»' : 'Начинаем!'}
        </span>
        <Button variant={st.myReady ? 'secondary' : 'primary'} size="lg" className="ml-auto" disabled={!canReady} onClick={() => session.setReady(!st.myReady)} data-online-ready>
          {st.myReady ? 'Не готов' : both ? 'Готов — в матч!' : 'Готов'}
        </Button>
      </div>
    </div>
  );
}

function peerModHint(p: TeamPack, entries: ModEntry[] | null): { text: string; tone: 'ok' | 'ice' | 'amber' } {
  if (!p.mod) return { text: 'свой ростер соперника — клуб передан целиком', tone: 'ice' };
  const mine = entries?.find((e) => e.id === p.mod!.id);
  if (!mine) return { text: `мод «${p.mod.name}» есть только у соперника — клуб передан целиком`, tone: 'ice' };
  if ((mine.version ?? '') !== (p.mod.version ?? '')) return { text: `мод «${p.mod.name}» у вас другой версии — играем составом соперника`, tone: 'amber' };
  return { text: `мод «${p.mod.name}» есть и у вас`, tone: 'ok' };
}

function ClubCard({ title, pack, ready, mine = false, side, hint }: { title: string; pack: TeamPack | null; ready: boolean; mine?: boolean; side: number; hint?: { text: string; tone: 'ok' | 'ice' | 'amber' } }) {
  const color = pack?.team.primaryColor ?? '#24354f';
  return (
    <div className={cn('relative rounded-md border overflow-hidden bg-panel min-h-[150px] flex flex-col', ready ? 'border-ok/60' : 'border-line')} data-online-club={mine ? 'mine' : 'peer'}>
      <div className="absolute inset-0 opacity-25 pointer-events-none" style={{ background: `radial-gradient(circle at 50% 0%, ${color}, transparent 70%)` }} />
      <div className="relative px-3 pt-2 flex items-center gap-2 text-[11px] uppercase tracking-wider">
        <span className={cn('truncate', mine ? 'text-ice' : 'text-muted')}>{title}</span>
        <span className="ml-auto text-muted shrink-0">{side === 0 ? 'дома' : 'в гостях'}</span>
      </div>
      {pack ? (
        <div className="relative flex-1 flex flex-col items-center justify-center text-center px-2 pb-3 pt-1">
          <TeamLogo team={pack.team} size={64} />
          <div className="font-display text-lg sm:text-xl mt-1 leading-tight">{pack.team.name}</div>
          <div className="text-[11px] text-muted">{pack.mod?.name ?? 'свой ростер'} · сила {packStrength(pack)}</div>
          {hint && <div className={cn('text-[10px] mt-1.5 rounded-sm px-1.5 py-0.5', hint.tone === 'ok' ? 'text-ok bg-ok/10' : hint.tone === 'amber' ? 'text-amber bg-amber/10' : 'text-ice bg-ice/10')} data-online-mod-hint={hint.tone}>{hint.text}</div>}
        </div>
      ) : (
        <div className="relative flex-1 flex items-center justify-center text-sm text-muted px-3 text-center">{mine ? 'Выберите клуб ниже' : 'выбирает клуб…'}</div>
      )}
      {ready && <div className="absolute top-2 left-1/2 -translate-x-1/2 mt-5 text-[10px] font-bold uppercase tracking-widest text-ok bg-ok/15 rounded-sm px-2 py-0.5">готов</div>}
    </div>
  );
}

function ClubPicker({ entries, pack, onPick }: { entries: ModEntry[] | null; pack: TeamPack | null; onPick: (p: TeamPack) => void }) {
  const [modId, setModId] = useState<string | null>(pack?.mod?.id ?? null);
  const [roster, setRoster] = useState<NormalizedRoster | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const cache = useRef(new Map<string, NormalizedRoster>());
  const usable = (entries ?? []).filter((e) => e.roster);
  const mod = usable.find((e) => e.id === modId) ?? usable[0];
  useEffect(() => {
    if (!mod) return;
    const hit = cache.current.get(mod.id);
    if (hit) { setRoster(hit); return; }
    let live = true;
    setRoster(null); setErr('');
    loadMod(mod).then((r) => { cache.current.set(mod.id, r); if (live) setRoster(r); }, (e) => { if (live) setErr(String((e as Error)?.message ?? e)); });
    return () => { live = false; };
  }, [mod]);
  const pick = async (teamId: string) => {
    if (!roster || !mod) return;
    setBusy(teamId);
    try { onPick(await packTeam(roster, teamId, modInfo(mod))); } catch (e) { setErr(String((e as Error)?.message ?? e)); } finally { setBusy(null); }
  };
  const strength = (id: string) => {
    if (!roster) return 0;
    const t = roster.teams.find((x) => x.id === id)!;
    return packStrength({ players: t.players.map((p) => roster.players[p]).filter(Boolean) });
  };
  return (
    <Panel title="Ваш клуб" noPad right={usable.length > 1 ? (
      <select value={mod?.id ?? ''} onChange={(e) => setModId(e.target.value)} className="bg-panel2 border border-line rounded-sm px-2 py-1 text-xs max-w-[200px]" data-online-mod>
        {usable.map((m) => <option key={m.id} value={m.id}>{m.name}{m.version ? ` · ${m.version}` : ''}</option>)}
      </select>
    ) : undefined}>
      {!entries ? <div className="p-6 flex justify-center"><Spinner className="w-5 h-5" /></div>
        : !usable.length ? <div className="p-4 text-sm text-muted">Нет ни одного мода с лигой — установите мод на стартовом экране.</div>
        : err ? <div className="p-4 text-sm text-accent">Мод не загрузился: {err}</div>
        : !roster ? <div className="p-6 flex items-center justify-center gap-2 text-sm text-muted"><Spinner className="w-4 h-4" /> Загружаем «{mod?.name}»…</div>
        : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 p-2 max-h-[380px] overflow-y-auto" data-online-teams>
            {[...roster.teams].sort((a, b) => a.name.localeCompare(b.name, 'ru')).map((t) => {
              const on = pack?.team.id === t.id && pack?.mod?.id === mod?.id;
              return (
                <button key={t.id} type="button" disabled={!!busy} onClick={() => void pick(t.id)}
                  className={cn('flex items-center gap-2 rounded-sm border px-2 py-1.5 text-left transition-colors', on ? 'border-ice bg-ice/10' : 'border-line bg-panel2 hover:border-muted')} data-online-team={t.id}>
                  <TeamLogo team={t} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold truncate">{t.short}</span>
                    <span className="block text-[10px] text-muted truncate">{t.city}</span>
                  </span>
                  {busy === t.id ? <Spinner className="w-3.5 h-3.5" /> : <span className="text-[11px] tabular text-muted">{strength(t.id)}</span>}
                </button>
              );
            })}
          </div>
        )}
    </Panel>
  );
}

function ModsPanel({ cmp, peer }: { cmp: NonNullable<LobbyState['mods']>; peer: string }) {
  const same = !cmp.mine.length && !cmp.theirs.length && !cmp.versions.length;
  const list = (ms: ModInfo[]) => ms.map((m) => m.name + (m.version ? ` ${m.version}` : '')).join(', ');
  return (
    <Panel title="Моды" data-online-mods>
      {same ? (
        <p className="text-sm flex items-center gap-2"><Icon name="check" className="text-ok" /> Одинаковые моды у обоих</p>
      ) : (
        <div className="space-y-1.5 text-xs">
          {cmp.common.length > 0 && <p><span className="text-ok font-semibold">У обоих:</span> {list(cmp.common)}</p>}
          {cmp.mine.length > 0 && <p data-online-mods-mine><span className="text-ice font-semibold">Только у вас:</span> {list(cmp.mine)}</p>}
          {cmp.theirs.length > 0 && <p data-online-mods-theirs><span className="text-ice font-semibold">Только у {peer}:</span> {list(cmp.theirs)}</p>}
          {cmp.versions.map((v) => <p key={v.mine.id}><span className="text-amber font-semibold">Разные версии:</span> {v.mine.name} — у вас {v.mine.version ?? 'без версии'}, у соперника {v.theirs.version ?? 'без версии'}</p>)}
          <p className="text-muted pt-1 leading-relaxed">Не страшно: клуб каждого игрока передаётся на другое устройство целиком, поэтому мод сопернику не нужен.</p>
        </div>
      )}
    </Panel>
  );
}

function Setting({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="text-xs text-muted mb-1">{label}{hint && <span className="opacity-70"> · {hint}</span>}</div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}
function Chip({ on, disabled, onClick, children }: { on: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} aria-pressed={on}
      className={cn('rounded-sm border px-2.5 py-1 text-xs font-semibold transition-colors', on ? 'border-ice bg-ice/15 text-ice' : 'border-line bg-panel2 text-muted', !disabled && !on && 'hover:text-text hover:border-muted', disabled && !on && 'opacity-50')}>
      {children}
    </button>
  );
}
function ReadyChip({ name, on }: { name: string; on: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-sm border px-2 py-1', on ? 'border-ok/50 text-ok bg-ok/10' : 'border-line text-muted')} data-online-ready-chip={on ? 'on' : 'off'}>
      <span className={cn('w-1.5 h-1.5 rounded-full', on ? 'bg-ok' : 'bg-muted/60')} />{name}: {on ? 'готов' : 'не готов'}
    </span>
  );
}
