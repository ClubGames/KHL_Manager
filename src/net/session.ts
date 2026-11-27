// The online lobby: two players connected over a Link — who they are, which clubs they picked (from their own mods:
// the clubs travel to the other device, see teamPack.ts), the match settings the host sets, «ready» on both sides,
// then the match (match.ts) and back to the lobby for a rematch. Pings keep an eye on the connection: nothing heard
// for 12 seconds is a lost connection.
import type { Link } from './lan';
import { compareMods, validPack, type ModCompare } from './teamPack';
import { DEFAULT_SETTINGS, PROTO, type MatchSettings, type ModInfo, type NetMsg, type TeamPack } from './wire';

export type Role = 'host' | 'guest';
export interface PeerInfo { name: string; platform: string; app: string; mods: ModInfo[] }
export interface LobbyState {
  stage: 'hello' | 'lobby' | 'match' | 'closed';
  role: Role;
  name: string;
  myPack: TeamPack | null;
  myReady: boolean;
  peer: PeerInfo | null;
  peerPack: TeamPack | null;
  peerReady: boolean;
  settings: MatchSettings;
  mods: ModCompare | null;
  /** round trip, ms */
  rtt: number | null;
  /** why the connection ended */
  closed: string | null;
  /** [the host's club, the guest's club] of the match being played */
  packs: [TeamPack, TeamPack] | null;
  /** counts the matches of this session (a rematch is a new one) */
  matchNo: number;
}

const LOBBY_MSGS = new Set(['hello', 'busy', 'lobby', 'team', 'ready', 'start', 'lobbyAgain', 'ping', 'pong', 'bye']);
const TIMEOUT_MS = 12000;

export class OnlineSession {
  state: LobbyState;
  /** the match's messages: the match screen takes them (kept until it is there — it mounts a moment after «start») */
  private onMatch: ((m: NetMsg) => void) | null = null;
  private early: NetMsg[] = [];
  setMatchHandler(f: ((m: NetMsg) => void) | null) {
    this.onMatch = f;
    if (f) { const q = this.early; this.early = []; for (const m of q) f(m); }
  }
  private subs = new Set<(s: LobbyState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private heard = Date.now();
  constructor(readonly link: Link, role: Role, me: { name: string; mods: ModInfo[]; platform: string; app: string }, private now: () => number = () => Date.now()) {
    this.state = { stage: 'hello', role, name: me.name, myPack: null, myReady: false, peer: null, peerPack: null, peerReady: false, settings: { ...DEFAULT_SETTINGS }, mods: null, rtt: null, closed: null, packs: null, matchNo: 0 };
    this.mine = me.mods;
    link.onMessage = (m) => this.receive(m);
    link.onClose = (reason) => this.end(`связь с соперником прервалась (${reason})`);
    link.send({ t: 'hello', v: PROTO, app: me.app, name: me.name, platform: me.platform, mods: me.mods });
    this.heard = this.now();
    this.timer = setInterval(() => this.beat(), 2000);
  }
  private mine: ModInfo[];
  subscribe(f: (s: LobbyState) => void) { this.subs.add(f); return () => { this.subs.delete(f); }; }
  private set(patch: Partial<LobbyState>) { this.state = { ...this.state, ...patch }; for (const f of this.subs) f(this.state); }
  get host() { return this.state.role === 'host'; }
  send(m: NetMsg) { if (this.state.stage !== 'closed') this.link.send(m); }

  private beat() {
    if (this.state.stage === 'closed') return;
    if (this.now() - this.heard > TIMEOUT_MS) { this.link.close('нет связи'); this.end('нет связи с соперником (12 секунд без ответа)'); return; }
    this.link.send({ t: 'ping', at: this.now() });
  }
  private receive(m: NetMsg) {
    this.heard = this.now();
    if (!LOBBY_MSGS.has(m.t)) {
      if (this.onMatch) this.onMatch(m);
      else if (this.state.stage === 'match' && this.early.length < 400) this.early.push(m);
      return;
    }
    const s = this.state;
    switch (m.t) {
      case 'ping': this.link.send({ t: 'pong', at: m.at }); return;
      case 'pong': this.set({ rtt: Math.max(0, Math.round(this.now() - m.at)) }); return;
      case 'busy': this.link.close(); this.end('в этой игре уже есть соперник'); return;
      case 'bye': this.end(m.reason ? `соперник вышел: ${m.reason}` : 'соперник вышел из игры'); return;
      case 'hello': {
        if (m.v !== PROTO) {
          const newer = m.v > PROTO;
          this.link.close('разные версии игры');
          this.end(newer ? 'у соперника более новая версия игры — обновите свою' : 'у соперника старая версия игры — ему нужно обновиться');
          return;
        }
        this.set({ stage: s.stage === 'hello' ? 'lobby' : s.stage, peer: { name: String(m.name || 'Соперник').slice(0, 24), platform: m.platform, app: m.app, mods: m.mods ?? [] }, mods: compareMods(this.mine, m.mods ?? []) });
        // the host tells the guest the lobby; each sends the club already picked
        if (this.host) this.pushLobby();
        if (s.myPack) this.link.send({ t: 'team', pack: s.myPack });
        return;
      }
      case 'lobby': if (!this.host) this.set({ settings: m.settings, myReady: m.ready[1], peerReady: m.ready[0] }); return;
      case 'team': {
        const pack = m.pack && validPack(m.pack) ? m.pack : null;
        this.set({ peerPack: pack, peerReady: false });
        if (this.host) { this.set({ myReady: false }); this.pushLobby(); }
        return;
      }
      case 'ready': if (this.host) { this.set({ peerReady: m.on && !!s.peerPack }); this.pushLobby(); this.maybeStart(); } return;
      case 'start':
        if (!this.host && validPack(m.packs[0]) && validPack(m.packs[1])) { this.early = []; this.set({ stage: 'match', settings: m.settings, packs: m.packs, matchNo: s.matchNo + 1, myReady: false, peerReady: false }); }
        return;
      case 'lobbyAgain': if (!this.host) this.set({ stage: 'lobby', packs: null, myReady: false, peerReady: false }); return;
    }
  }
  private pushLobby() { if (this.host) this.link.send({ t: 'lobby', settings: this.state.settings, ready: [this.state.myReady, this.state.peerReady] }); }
  private maybeStart() {
    const s = this.state;
    if (!this.host || s.stage !== 'lobby' || !s.myReady || !s.peerReady || !s.myPack || !s.peerPack) return;
    const packs: [TeamPack, TeamPack] = [s.myPack, s.peerPack];
    this.link.send({ t: 'start', settings: s.settings, packs });
    this.set({ stage: 'match', packs, matchNo: s.matchNo + 1, myReady: false, peerReady: false });
  }

  /** This player's club (null: none picked). Picking another takes back «ready» on both sides. */
  pickTeam(pack: TeamPack | null) {
    this.set({ myPack: pack, myReady: false });
    this.send({ t: 'team', pack });
    if (this.host) { this.set({ peerReady: false }); this.pushLobby(); }
  }
  setReady(on: boolean) {
    const s = this.state;
    if (s.stage !== 'lobby' || (on && !s.myPack)) return;
    this.set({ myReady: on });
    if (this.host) { this.pushLobby(); this.maybeStart(); }
    else this.send({ t: 'ready', on });
  }
  /** The host's match settings (both players' «ready» is taken back: the match changed). */
  setSettings(patch: Partial<MatchSettings>) {
    if (!this.host || this.state.stage !== 'lobby') return;
    this.set({ settings: { ...this.state.settings, ...patch }, myReady: false, peerReady: false });
    this.pushLobby();
  }
  /** After the match: both back to the lobby (the host decides; the clubs stay picked). */
  backToLobby() {
    if (this.state.stage !== 'match') return;
    if (this.host) this.send({ t: 'lobbyAgain' });
    this.set({ stage: 'lobby', packs: null, myReady: false, peerReady: false });
  }
  leave(reason?: string) {
    if (this.state.stage !== 'closed') this.link.send({ t: 'bye', reason });
    this.link.close(reason);
    this.end('вы вышли из игры');
  }
  private end(reason: string) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.state.stage === 'closed') return;
    this.set({ stage: 'closed', closed: reason });
  }
  dispose() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
