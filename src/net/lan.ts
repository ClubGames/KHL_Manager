// The local network under the online match. The game a host creates is a TCP server on his device (port 47810)
// that says «a game is here» to the whole network with a UDP broadcast once a second (port 47811); the guest's
// device hears it and lists the game, or connects to an address typed by hand (a phone sharing its hotspot, a VPN
// like Radmin VPN / ZeroTier / Tailscale that makes two distant computers one network). One JSON message per line.
//
// The sockets are native: the Android app's LanNet plugin (android/…/LanNetPlugin.java) and the Windows app's main
// process (desktop/lan.cjs) — a page in a browser can neither listen nor broadcast. Both speak the same protocol,
// so a phone plays a computer. In a browser there is only the «two tabs» loop (BroadcastChannel): the same game
// in two tabs of one browser, to try the online mode out (and for the tests).
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { BEACON_PORT, LAN_PORT, parseMsg, PROTO, type NetMsg } from './wire';

export type LanKind = 'android' | 'windows' | 'loop' | 'memory';

/** One connection to the other player. */
export interface Link {
  readonly kind: LanKind;
  send(m: NetMsg): void;
  close(reason?: string): void;
  onMessage: ((m: NetMsg) => void) | null;
  onClose: ((reason: string) => void) | null;
}

/** What a host says about his game in the beacon. */
export interface Beacon { name: string; team?: string; app: string; v: number; busy?: boolean }
/** A game found on the network. */
export interface Room extends Beacon { host: string; port: number; seen: number }

export interface Lan {
  readonly kind: LanKind;
  /** Opens the game: listens for a guest and tells the network about it. Resolves the port and this device's addresses. */
  host(beacon: Beacon): Promise<{ port: number; addresses: string[] }>;
  /** A guest connected (one at a time: the next ones are told the game is busy). */
  onGuest: ((link: Link) => void) | null;
  /** What the beacon says now (the club picked, busy once a guest is in). */
  beacon(b: Beacon): void;
  stopHost(): Promise<void>;
  join(host: string, port?: number): Promise<Link>;
  /** Listens for games on the network; returns the stop function. */
  scan(onRooms: (rooms: Room[]) => void): () => void;
  /** This device's IPv4 addresses on the local networks. */
  addresses(): Promise<string[]>;
}

/* ---------------- the native sockets: the same calls on Android and on Windows ---------------- */
type NetEvent = { type: 'peer' } | { type: 'message'; data: string } | { type: 'closed'; reason?: string } | { type: 'found'; host: string; data: string };
interface NativeNet {
  host(o: { port: number; beaconPort: number; beacon: string }): Promise<{ port: number; addresses: string[] }>;
  beacon(o: { beacon: string }): Promise<void>;
  stopHost(): Promise<void>;
  join(o: { host: string; port: number }): Promise<void>;
  send(o: { data: string }): Promise<void> | void;
  close(): Promise<void>;
  scan(o: { port: number }): Promise<void>;
  stopScan(): Promise<void>;
  addresses(): Promise<{ addresses: string[] }>;
}
interface AndroidNet extends NativeNet { addListener(ev: 'net', cb: (e: NetEvent) => void): Promise<PluginListenerHandle> }
/** The Windows app's bridge (desktop/preload.cjs). */
export interface DesktopNet extends NativeNet { on(cb: (e: NetEvent) => void): () => void }

const LanNet = registerPlugin<AndroidNet>('LanNet');

function androidApp(): boolean {
  try { return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('LanNet'); } catch { return false; }
}
function desktopNet(): DesktopNet | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { khlDesktop?: { lan?: DesktopNet } }).khlDesktop?.lan ?? null;
}

class NativeLan implements Lan {
  onGuest: ((link: Link) => void) | null = null;
  private link: (Link & { _closed?: boolean }) | null = null;
  private rooms = new Map<string, Room>();
  private roomCb: ((rooms: Room[]) => void) | null = null;
  private listening: Promise<void> | null = null;
  constructor(readonly kind: 'android' | 'windows', private net: NativeNet, private listen: (cb: (e: NetEvent) => void) => Promise<unknown> | unknown) {}
  private ensure() {
    this.listening ??= Promise.resolve(this.listen(e => this.event(e))).then(() => undefined);
    return this.listening;
  }
  private event(e: NetEvent) {
    if (e.type === 'peer') { const l = this.newLink(); this.onGuest?.(l); }
    else if (e.type === 'message') { const m = parseMsg(e.data); if (m && this.link) this.link.onMessage?.(m); }
    else if (e.type === 'closed') { const l = this.link; this.link = null; if (l && !l._closed) { l._closed = true; l.onClose?.(e.reason || 'соединение закрыто'); } }
    else if (e.type === 'found') {
      try {
        const b = JSON.parse(e.data) as Beacon & { khl?: string; port?: number };
        if (b.khl !== 'lan') return;
        const port = Number(b.port) || LAN_PORT;
        this.rooms.set(`${e.host}:${port}`, { name: String(b.name ?? 'Игрок'), team: b.team, app: String(b.app ?? ''), v: Number(b.v) || 0, busy: !!b.busy, host: e.host, port, seen: Date.now() });
        this.pushRooms();
      } catch { /* not ours */ }
    }
  }
  private pushRooms() {
    const now = Date.now();
    for (const [k, r] of this.rooms) if (now - r.seen > 4500) this.rooms.delete(k);
    this.roomCb?.([...this.rooms.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }
  private newLink(): Link {
    const net = this.net;
    const l: Link & { _closed?: boolean } = {
      kind: this.kind,
      send: (m) => { if (!l._closed) void Promise.resolve(net.send({ data: JSON.stringify(m) })).catch(() => {}); },
      close: (reason) => {
        if (l._closed) return;
        try { net.send({ data: JSON.stringify({ t: 'bye', reason } satisfies NetMsg) }); } catch { /* gone */ }
        l._closed = true; this.link = null;
        window.setTimeout(() => void net.close().catch(() => {}), 60);
      },
      onMessage: null, onClose: null,
    };
    this.link = l;
    return l;
  }
  private beaconText(b: Beacon, port: number) { return JSON.stringify({ khl: 'lan', port, ...b }); }
  async host(b: Beacon) {
    await this.ensure();
    const r = await this.net.host({ port: LAN_PORT, beaconPort: BEACON_PORT, beacon: this.beaconText(b, LAN_PORT) });
    this.port = r.port;
    if (r.port !== LAN_PORT) this.beacon(b); // the next free port was taken: the beacon says which
    return r;
  }
  private port = LAN_PORT;
  beacon(b: Beacon) { void this.net.beacon({ beacon: this.beaconText(b, this.port) }).catch(() => {}); }
  async stopHost() { await this.net.stopHost().catch(() => {}); }
  async join(host: string, port = LAN_PORT) {
    await this.ensure();
    const l = this.newLink();
    try { await this.net.join({ host: host.trim(), port }); } catch (e) { this.link = null; throw new Error(netError(e)); }
    return l;
  }
  scan(onRooms: (rooms: Room[]) => void) {
    this.roomCb = onRooms;
    void this.ensure().then(() => this.net.scan({ port: BEACON_PORT })).catch(() => {});
    const id = window.setInterval(() => this.pushRooms(), 1000);
    return () => { window.clearInterval(id); this.roomCb = null; this.rooms.clear(); void this.net.stopScan().catch(() => {}); };
  }
  async addresses() { try { return (await this.net.addresses()).addresses; } catch { return []; } }
}

function netError(e: unknown): string {
  const s = String((e as Error)?.message ?? e);
  if (/refused|ECONNREFUSED/i.test(s)) return 'никто не ждёт игру по этому адресу (хозяин ещё не создал игру?)';
  if (/timed? ?out|ETIMEDOUT|EHOSTUNREACH|unreachable/i.test(s)) return 'устройство не отвечает: проверьте, что оба в одной сети Wi-Fi и адрес верный';
  if (/ENOTFOUND|unknown host|UnknownHost/i.test(s)) return 'адрес не найден';
  return s;
}

/* ---------------- two tabs of one browser ---------------- */
type LoopPkt = { k: 'beacon'; room: string; b: Beacon } | { k: 'join'; room: string; from: string } | { k: 'accept' | 'busy'; to: string; room: string }
  | { k: 'msg'; to: string; data: string } | { k: 'close'; to: string; reason?: string };
const LOOP_CHANNEL = 'khl-lan-v' + PROTO;
const rid = () => Math.random().toString(36).slice(2, 10);

class LoopLan implements Lan {
  readonly kind = 'loop' as const;
  onGuest: ((link: Link) => void) | null = null;
  private ch: BroadcastChannel | null = null;
  private me = rid();
  private hosting: { room: string; b: Beacon; timer: number; guest: string | null } | null = null;
  private links = new Map<string, Link & { _closed?: boolean }>();
  private rooms = new Map<string, Room>();
  private roomCb: ((rooms: Room[]) => void) | null = null;
  private joining: { room: string; resolve: (l: Link) => void; reject: (e: Error) => void } | null = null;
  private chan() {
    if (this.ch) return this.ch;
    const ch = new BroadcastChannel(LOOP_CHANNEL);
    ch.onmessage = (e: MessageEvent<LoopPkt>) => this.on(e.data);
    window.addEventListener('pagehide', () => { for (const [to] of this.links) this.post({ k: 'close', to, reason: 'вкладка закрыта' }); });
    return (this.ch = ch);
  }
  private post(p: LoopPkt) { this.chan().postMessage(p); }
  private on(p: LoopPkt) {
    if (p.k === 'beacon') {
      if (this.hosting?.room === p.room) return;
      this.rooms.set(p.room, { ...p.b, host: p.room, port: 0, seen: Date.now() });
      this.pushRooms();
    } else if (p.k === 'join' && this.hosting?.room === p.room) {
      if (this.hosting.guest && this.links.has(this.hosting.guest)) { this.post({ k: 'busy', to: p.from, room: p.room }); return; }
      this.hosting.guest = p.from;
      this.post({ k: 'accept', to: p.from, room: p.room });
      this.onGuest?.(this.link(p.from));
    } else if ((p.k === 'accept' || p.k === 'busy') && p.to === this.me && this.joining?.room === p.room) {
      const j = this.joining; this.joining = null;
      if (p.k === 'busy') j.reject(new Error('в этой игре уже есть соперник'));
      else j.resolve(this.link(p.room));
    } else if (p.k === 'msg' && p.to === this.me) {
      const m = parseMsg(p.data);
      // the host's links are keyed by the guest, the guest's by the room: the message came from whichever is open
      const l = [...this.links.values()][0];
      if (m && l) l.onMessage?.(m);
    } else if (p.k === 'close' && p.to === this.me) {
      for (const [k, l] of this.links) { this.links.delete(k); if (!l._closed) { l._closed = true; l.onClose?.(p.reason || 'соединение закрыто'); } }
      if (this.hosting) this.hosting.guest = null;
    }
  }
  private link(peer: string): Link {
    // the host addresses the guest by its id, the guest the host by the room (which is the host's id)
    const l: Link & { _closed?: boolean } = {
      kind: 'loop',
      send: (m) => { if (!l._closed) this.post({ k: 'msg', to: peer, data: JSON.stringify(m) }); },
      close: (reason) => { if (l._closed) return; l._closed = true; this.links.delete(peer); if (this.hosting) this.hosting.guest = null; this.post({ k: 'close', to: peer, reason }); },
      onMessage: null, onClose: null,
    };
    this.links.set(peer, l);
    return l;
  }
  private pushRooms() {
    const now = Date.now();
    for (const [k, r] of this.rooms) if (now - r.seen > 4500) this.rooms.delete(k);
    this.roomCb?.([...this.rooms.values()]);
  }
  async host(b: Beacon) {
    this.chan();
    if (this.hosting) window.clearInterval(this.hosting.timer);
    const room = this.me;
    const timer = window.setInterval(() => this.hosting && this.post({ k: 'beacon', room, b: this.hosting.b }), 1000);
    this.hosting = { room, b, timer, guest: null };
    this.post({ k: 'beacon', room, b });
    return { port: 0, addresses: ['эта вкладка'] };
  }
  beacon(b: Beacon) { if (this.hosting) { this.hosting.b = b; this.post({ k: 'beacon', room: this.hosting.room, b }); } }
  async stopHost() { if (this.hosting) { window.clearInterval(this.hosting.timer); this.hosting = null; } }
  join(host: string) {
    this.chan();
    return new Promise<Link>((resolve, reject) => {
      this.joining = { room: host, resolve, reject };
      this.post({ k: 'join', room: host, from: this.me });
      window.setTimeout(() => { if (this.joining?.room === host) { this.joining = null; reject(new Error('вкладка с игрой не отвечает')); } }, 4000);
    });
  }
  scan(onRooms: (rooms: Room[]) => void) {
    this.chan();
    this.roomCb = onRooms;
    const id = window.setInterval(() => this.pushRooms(), 1000);
    return () => { window.clearInterval(id); this.roomCb = null; };
  }
  async addresses() { return []; }
}

/* ---------------- tests: two ends in one process ---------------- */
export function memoryPair(delayMs = 0): [Link, Link] {
  const mk = (): Link & { peer?: Link & { _closed?: boolean }; _closed?: boolean } => ({ kind: 'memory', onMessage: null, onClose: null, send: () => {}, close: () => {} });
  const a = mk(), b = mk();
  const wire = (x: typeof a, y: typeof b) => {
    x.send = (m) => { if (x._closed) return; const s = JSON.stringify(m); setTimeout(() => { if (!y._closed) { const p = parseMsg(s); if (p) y.onMessage?.(p); } }, delayMs); };
    x.close = (reason) => { if (x._closed) return; x._closed = true; setTimeout(() => { if (!y._closed) { y._closed = true; y.onClose?.(reason ?? 'закрыто'); } }, delayMs); };
  };
  wire(a, b); wire(b, a);
  return [a, b];
}

let native: Lan | null | undefined;
/** The device's LAN (the Android or the Windows app); null in a browser. */
export function nativeLan(): Lan | null {
  if (native !== undefined) return native;
  const d = desktopNet();
  if (d) return (native = new NativeLan('windows', d, (cb) => d.on(cb)));
  if (androidApp()) return (native = new NativeLan('android', LanNet, (cb) => LanNet.addListener('net', cb)));
  return (native = null);
}
let loop: Lan | null = null;
/** The «two tabs» loop (any browser with BroadcastChannel). */
export function loopLan(): Lan | null {
  if (typeof BroadcastChannel === 'undefined' || typeof window === 'undefined') return null;
  return (loop ??= new LoopLan());
}
