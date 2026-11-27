// Online over the local network: the frames on the wire, the clubs that travel with the match (a guest without
// the host's mod), two humans on one rink, and a whole host ↔ guest match over an in-memory link — the guest's
// copy shows the host's rink, his pad skates his player, periods / intermissions / pause follow both players.
// Run: npx tsx scripts/online-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { NO_PAD, PlayRink, type PadState } from '../src/game/playRink';
import { memoryPair } from '../src/net/lan';
import { buildCtx, GuestMatch, HostMatch, outToast } from '../src/net/match';
import { compareMods, matchTeam, packTeam, validPack } from '../src/net/teamPack';
import { OnlineSession } from '../src/net/session';
import { DEFAULT_SETTINGS, packFrame, packPad, PROTO, unpackFrame, type MatchView, type NetMsg } from '../src/net/wire';

const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
let pass = 0;
const test = async (name: string, fn: () => void | Promise<void>) => { const t = Date.now(); await fn(); pass++; console.log('✓', name, `(${((Date.now() - t) / 1000).toFixed(1)} s)`); };
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
const [T1, T2] = [r.teams[0], r.teams[1]];
const modA = { id: 'HL_2627', name: 'ХЛ', version: '3' }, modB = { id: 'MyLeague', name: 'Моя лига' };

await test('the wire: a frame packed and unpacked is the same frame (to a millimetre), a third of the size', () => {
  const k = new PlayRink({ home: T1, away: T2, players: r.players, lineups: [T1.lineup, T2.lineup], userSide: null, kind: 'reg', periodMinutes: 20, seed: 3 });
  k.advance(20, NO_PAD);
  const ids = k.agentIds(), index = new Map(ids.map((id, i) => [id, i]));
  const f = k.frames[k.frames.length - 1], back = unpackFrame(JSON.parse(JSON.stringify(packFrame(f, index))), ids);
  assert.equal(back.ids.join(), f.ids.join());
  assert.equal(back.carrier, f.carrier);
  for (let i = 0; i < f.sk.length; i++) {
    const a = f.sk[i], b = back.sk[i];
    assert.equal(b.id, a.id); assert.equal(b.side, a.side); assert.equal(b.ctrl, a.ctrl); assert.equal(b.mv, a.mv); assert.equal(b.st, a.st);
    assert.ok(Math.abs(b.x - a.x) < 1e-3 && Math.abs(b.y - a.y) < 1e-3 && Math.abs(b.fa - a.fa) < 1e-3);
  }
  const raw = JSON.stringify(f).length, packed = JSON.stringify(packFrame(f, index)).length;
  console.log(`   frame ${raw} → ${packed} bytes`);
  assert.ok(packed < raw * 0.6, 'packed is much smaller');
  const pad: PadState = { ...NO_PAD, mx: 0.123456, shoot: true };
  assert.deepEqual(packPad(pad), { ...NO_PAD, mx: 0.123, shoot: true });
});

await test('mods: the lobby tells common mods, mods only one player has, and the same mod in two versions', () => {
  const c = compareMods([modA, modB], [{ ...modA, version: '2' }, { id: 'Other', name: 'Другая' }]);
  assert.deepEqual(c.mine.map(m => m.id), ['MyLeague']);
  assert.deepEqual(c.theirs.map(m => m.id), ['Other']);
  assert.equal(c.versions.length, 1);
  assert.equal(compareMods([modA], [modA]).common.length, 1);
});

await test('clubs travel with the match: a pack is all the guest needs; the same club on both sides never mixes up', async () => {
  const pack = await packTeam(r, T1.id, modB);
  assert.ok(validPack(JSON.parse(JSON.stringify(pack))), 'a valid pack after the wire');
  assert.ok(pack.players.length >= 18 && pack.lineup.starterG, 'players and a goalie');
  assert.ok(pack.players.every(p => !p.face), 'no photo files from the mod');
  assert.ok(!validPack({ team: { id: 'x', short: 'X' }, players: [], lineup: { F: [] } }), 'an empty club is refused');
  // the same club for both sides: separate people
  const h = matchTeam(pack, 0), a = matchTeam(pack, 1);
  assert.notEqual(h.team.id, a.team.id);
  const hid = new Set(Object.keys(h.players));
  assert.ok(Object.keys(a.players).every(id => !hid.has(id)), 'no shared ids');
  assert.ok(h.lineup.F.flat().every(id => !id || h.players[id]), 'the lines point at the side\'s own players');
  assert.equal(pack.hash, (await packTeam(r, T1.id, modB)).hash, 'the same club → the same fingerprint');
  assert.notEqual(pack.hash, (await packTeam(r, T2.id, modB)).hash);
});

await test('two humans on one rink: each skates a player of his own side, each takes his own draws', () => {
  const k = new PlayRink({ home: T1, away: T2, players: r.players, lineups: [T1.lineup, T2.lineup], userSide: 0, humans: [1, 0], kind: 'reg', periodMinutes: 20, seed: 9 });
  const side = (id: string | null) => (id ? (T1.players.includes(id) ? 0 : 1) : -1);
  let both = 0, frames = 0, fwdA = 0;
  for (let i = 0; i < 60 * 40; i++) {
    // seat 0 (the away side) skates up, seat 1 (home) holds still
    k.advance(1 / 60, [{ ...NO_PAD, mx: -1, faceoff: i % 90 < 2 }, { ...NO_PAD, faceoff: i % 90 < 2 }]);
    const h0 = k.hud(0), h1 = k.hud(1);
    if (k.mode === 'play') {
      frames++;
      if (h0.ctl && h1.ctl) { both++; assert.equal(side(h0.ctl), 1, 'seat 0 plays the away side'); assert.equal(side(h1.ctl), 0, 'seat 1 the home side'); }
      const f = k.frames[k.frames.length - 1];
      assert.ok(f.sk.filter(s => s.ctrl).length <= 2, 'at most two controlled men');
      if (h0.ctl && f.sk.find(s => s.id === h0.ctl)!.ctrl) fwdA++;
    }
  }
  assert.ok(frames > 600 && both / frames > 0.9, `both seats skate a man (${both}/${frames})`);
  assert.ok(fwdA / frames > 0.9, 'their men are marked in the frames');
  assert.equal(k.attack, -1, 'seat 0 is the away side: its attack is toward −x');
});

/** Host and guest over a link with a delay, driven like the screens drive them. */
async function session(delay = 3) {
  const [hl, gl] = memoryPair(delay);
  const packs = [await packTeam(r, T1.id, modA), await packTeam(r, T2.id, null)] as const;
  const settings = { ...DEFAULT_SETTINGS, periodMinutes: 1, hostSide: 1 as const };
  const hv: MatchView[] = [], gv: MatchView[] = [], bytes = { host: 0, ticks: 0 };
  const toasts: string[] = [];
  const hctx = buildCtx([packs[0], packs[1]], settings, 'host'), gctx = buildCtx([JSON.parse(JSON.stringify(packs[0])), JSON.parse(JSON.stringify(packs[1]))], settings, 'guest');
  const host = new HostMatch(hctx, (m: NetMsg) => { const s = JSON.stringify(m); if (m.t === 'tick') { bytes.host += s.length; bytes.ticks++; } hl.send(m); }, { view: v => hv.push(v), rink: () => {}, out: () => {}, toast: t => toasts.push('host:' + t) });
  const guest = new GuestMatch(gctx, m => gl.send(m), { view: v => gv.push(v), rink: () => {}, out: o => { for (const x of o) { const t = outToast(x, gctx.mySide, gctx.players); if (t) toasts.push('guest:' + t.text); } }, toast: t => toasts.push('guest:' + t) });
  hl.onMessage = m => host.onMessage(m);
  gl.onMessage = m => guest.onMessage(m);
  return { host, guest, hctx, gctx, hv, gv, bytes, toasts };
}

await test('a host ↔ guest match: the guest sees the host\'s rink, skates his own man, the periods follow both players', async () => {
  const { host, guest, hctx, gctx, gv, bytes, toasts } = await session();
  assert.equal(hctx.mySide, 1); assert.equal(gctx.mySide, 0, 'the host chose to be the visitors');
  assert.equal(hctx.home.name, gctx.home.name);
  host.begin();
  await sleep(20);
  assert.equal(guest.view.phase, 'loading');
  assert.ok(guest.rink?.mirror, 'the guest has the copy of the period');
  host.loaded(); await sleep(10);
  assert.equal(host.view.phase, 'loading', 'waits for the guest\'s picture');
  guest.loaded(); await sleep(15);
  assert.equal(host.view.phase, 'playing'); assert.equal(guest.view.phase, 'playing');
  // the guest pushes his stick toward the host's net and shoots now and then; the host stands
  let i = 0, guestCtl = 0, steps = 0, lagMax = 0, rings = 0;
  const t0 = Date.now();
  while (host.rink && !host.rink.ended && i < 60 * 200) {
    const gp: PadState = { ...NO_PAD, mx: 1, my: Math.sin(i / 40) * 0.5, shoot: i % 50 < 20, faceoff: i % 70 < 3 };
    guest.pad(gp, i * 16.7);
    host.advance(1 / 60, { ...NO_PAD, faceoff: i % 70 < 3 });
    if (i % 4 === 0) await sleep(0);
    const hud = guest.rink?.hud();
    if (host.rink?.mode === 'play') { steps++; if (hud?.ctl && gctx.players[hud.ctl]?.teamId === gctx.home.id) guestCtl++; }
    if (guest.rink && host.rink) lagMax = Math.max(lagMax, host.rink.tau - guest.rink.tau);
    // the yellow ring: each screen marks its own man only (both seats are humans on the host's rink)
    if (i % 30 === 0 && host.rink && guest.rink?.frames.length) {
      const hc = host.rink.frameAt(host.rink.lastTau).skaters.filter(x => x.ctrl), gc = guest.rink.frameAt(guest.rink.frames[guest.rink.frames.length - 1].tau).skaters.filter(x => x.ctrl);
      assert.ok(hc.length <= 1 && hc.every(x => x.side === hctx.mySide), `the host's ring on his own man (${hc.map(x => x.side)})`);
      assert.ok(gc.length <= 1 && gc.every(x => x.side === gctx.mySide), `the guest's ring on his own man (${gc.map(x => x.side)})`);
      rings += hc.length + gc.length;
    }
    i++;
  }
  await sleep(30);
  const secs = i / 60;
  console.log(`   ${secs.toFixed(0)} s of play in ${((Date.now() - t0) / 1000).toFixed(1)} s · ${bytes.ticks} ticks · ${(bytes.host / secs / 1024).toFixed(1)} KB/s host → guest · lag ≤ ${lagMax.toFixed(2)} s · score ${host.view.score.join(':')} shots ${host.view.shots.join(':')}`);
  assert.ok(bytes.ticks / secs > 25 && bytes.ticks / secs < 34, '~30 ticks a second');
  assert.ok(bytes.host / secs < 140 * 1024, 'well inside a home Wi-Fi');
  assert.ok(steps > 0 && guestCtl / steps > 0.85, `the guest's HUD shows his own man (${guestCtl}/${steps})`);
  assert.ok(lagMax < 0.4, 'the copy keeps up');
  assert.ok(rings > 50, `the rings are there (${rings})`);
  assert.equal(host.view.phase, 'break', 'the period ended');
  assert.equal(guest.view.phase, 'break');
  assert.deepEqual(guest.view.score, host.view.score);
  assert.deepEqual(guest.rink!.score, host.view.score, 'the copy\'s scoreboard');
  assert.equal(guest.view.goals.length, host.view.goals.length);
  const gr = guest.rink!;
  assert.ok(gr.frames.length > 300, 'the copy keeps the frames (goal replays are cut from them)');
  for (const g of guest.view.goals) if (g.tau > gr.frames[0].tau + 7) assert.ok(gr.goalClip(g.tau), 'the guest cuts his own goal clips');
  const goalToasts = toasts.filter(t => t.startsWith('guest:ГОЛ') || t.startsWith('guest:Гол соперника')).length;
  assert.equal(goalToasts, host.view.goals.length, 'a toast for every goal on the guest');
  // intermission: both press «ready»
  host.next(); await sleep(15);
  assert.deepEqual(guest.view.ready, [false, true], 'the host (visitors) is ready');
  assert.equal(guest.view.phase, 'break');
  guest.next(); await sleep(20);
  assert.equal(host.view.phase, 'loading'); assert.equal(guest.view.period, 2);
  assert.ok(guest.rink?.flipped, 'second period: ends switched on the guest\'s copy too');
  host.loaded(); guest.loaded(); await sleep(15);
  // the guest's menu does not stop the match: his team is the AI's meanwhile
  guest.pause(true); await sleep(15);
  assert.equal(host.view.paused, null, 'online a menu never pauses the match');
  assert.deepEqual(host.view.away?.[gctx.mySide], true, 'the guest is marked as in his menu');
  assert.deepEqual(guest.view.away?.[gctx.mySide], true, 'and his screen knows it');
  const run = (sec: number) => { for (let j = 0; j < sec * 60; j++) host.advance(1 / 60, NO_PAD); };
  const tau = host.rink!.tau;
  run(0.5);
  assert.ok(host.rink!.tau > tau + 0.4, 'the menu: the rink plays on');
  guest.pause(false); await sleep(15);
  assert.deepEqual(guest.view.away, [false, false]);
  // a screen holding the play (the entrance, a replay): the host waits for it, then plays on
  guest.hold(true); await sleep(15);
  const t2 = host.rink!.tau;
  run(0.5);
  assert.equal(host.rink!.tau, t2, 'the guest\'s replay holds the host');
  await sleep(15);
  assert.equal(guest.view.held, true, 'the guest is told the host waits');
  assert.ok(Math.abs(guest.rink!.tau - host.rink!.tau) < 1e-6, `every frame up to the stop reached the guest (${guest.rink!.tau} / ${host.rink!.tau})`);
  guest.hold(false); await sleep(15);
  run(0.5);
  assert.ok(host.rink!.tau > t2 + 0.4, 'and lets it go');
  // the guest's timeout: at once at a stoppage or at the next whistle; one per match
  const rk = host.rink!;
  guest.command('timeout'); await sleep(15);
  assert.equal(rk.timeoutLeft[gctx.mySide], false, 'the guest took his timeout');
  for (let j = 0; j < 60 * 120 && !rk.timeoutNow(); j++) host.advance(1 / 60, NO_PAD);
  assert.equal(rk.timeoutNow()?.side, gctx.mySide, 'the timeout is under way (at a whistle)');
  run(0.2); await sleep(30);
  assert.equal(guest.rink!.timeoutNow()?.side, gctx.mySide, 'the guest\'s copy shows it');
  const c0 = rk.clock; run(2);
  assert.equal(rk.clock, c0, 'the clock stands in a timeout');
  guest.command('timeout'); await sleep(15);
  host.advance(1 / 30, NO_PAD);
  assert.equal(rk.timeoutNow(), null, 'the caller ends his timeout early');
  // a guest's command: his own side's goalie
  for (let j = 0; j < 400 && host.rink!.mode !== 'play'; j++) host.advance(1 / 60, NO_PAD);
  guest.command('pull'); await sleep(15);
  assert.equal(host.rink!.pulled[gctx.mySide], true, 'the guest pulled his own goalie');
  assert.equal(host.rink!.pulled[hctx.mySide], false);
  assert.ok(toasts.includes('guest:Вратарь уходит — шестой полевой'), 'and was told so');
});

await test('a quick tap on the guest\'s pad is not lost when two pads arrive in one host frame', async () => {
  const { host, guest } = await session(0);
  host.begin(); await sleep(5); host.loaded(); guest.loaded(); await sleep(5);
  const k = host.rink!;
  for (let j = 0; j < 600 && k.mode !== 'play'; j++) host.advance(1 / 60, NO_PAD);
  // press and release between two host frames
  const pressAt = (k as unknown as { seats(): { pressAt: { shoot: number } }[] }).seats()[1].pressAt;
  const before = pressAt.shoot;
  guest.pad({ ...NO_PAD, shoot: true }, 1000); guest.pad({ ...NO_PAD }, 1001);
  await sleep(5);
  host.advance(1 / 60, NO_PAD); host.advance(1 / 60, NO_PAD);
  assert.ok(pressAt.shoot > before, 'the press reached the guest\'s seat');
});

await test('the lobby: hello, mods compared, clubs picked, the host\'s settings, both ready → the match; a rematch; leaving', async () => {
  const [a, b] = memoryPair(1);
  const ha = new OnlineSession(a, 'host', { name: 'Хозяин', mods: [modA, modB], platform: 'windows', app: 't' });
  const gb = new OnlineSession(b, 'guest', { name: 'Гость', mods: [{ ...modA, version: '2' }], platform: 'android', app: 't' });
  await sleep(20);
  assert.equal(ha.state.stage, 'lobby'); assert.equal(gb.state.stage, 'lobby');
  assert.equal(ha.state.peer?.name, 'Гость'); assert.equal(gb.state.peer?.platform, 'windows');
  assert.deepEqual(ha.state.mods?.mine.map(m => m.id), ['MyLeague']);
  assert.equal(ha.state.mods?.versions.length, 1);
  assert.deepEqual(gb.state.mods?.theirs.map(m => m.id), ['MyLeague']);
  const p1 = await packTeam(r, T1.id, modB), p2 = await packTeam(r, T2.id, { ...modA, version: '2' });
  ha.setReady(true); assert.equal(ha.state.myReady, false, 'no club — no ready');
  ha.pickTeam(p1); gb.pickTeam(p2);
  ha.setSettings({ periodMinutes: 3, hostSide: 1 });
  await sleep(20);
  assert.equal(gb.state.peerPack?.team.id, T1.id, 'the host\'s club (a mod the guest has not) came whole');
  assert.equal(gb.state.settings.periodMinutes, 3);
  ha.setReady(true); await sleep(20);
  assert.equal(gb.state.peerReady, true);
  gb.pickTeam(p2); await sleep(20);
  assert.equal(ha.state.myReady, false, 'a club changed: ready is taken back');
  ha.setReady(true); gb.setReady(true); await sleep(20);
  assert.equal(ha.state.stage, 'match'); assert.equal(gb.state.stage, 'match');
  assert.equal(gb.state.packs?.[0].team.id, T1.id); assert.equal(gb.state.settings.hostSide, 1);
  // a match message before the screen is there is kept for it
  const got: string[] = [];
  a.send({ t: 'view', v: { phase: 'loading' } as MatchView }); await sleep(10);
  gb.setMatchHandler(m => got.push(m.t));
  assert.deepEqual(got, ['view']);
  ha.backToLobby(); await sleep(20);
  assert.equal(gb.state.stage, 'lobby'); assert.equal(gb.state.myPack?.team.id, T2.id, 'the clubs stay for the rematch');
  gb.leave(); await sleep(20);
  assert.equal(ha.state.stage, 'closed'); assert.match(ha.state.closed ?? '', /вышел/);
  ha.dispose(); gb.dispose();
});

await test('the lobby: another protocol version and a game already busy are told plainly', async () => {
  const [a, b] = memoryPair(1);
  const g = new OnlineSession(b, 'guest', { name: 'Гость', mods: [], platform: 'web', app: 't' });
  a.onMessage = () => {};
  a.send({ t: 'hello', v: PROTO + 1, app: 'new', name: 'Хозяин', platform: 'windows', mods: [] }); await sleep(10);
  assert.equal(g.state.stage, 'closed'); assert.match(g.state.closed ?? '', /новее|новая/);
  const [c, d] = memoryPair(1);
  const g2 = new OnlineSession(d, 'guest', { name: 'Гость', mods: [], platform: 'web', app: 't' });
  c.send({ t: 'busy' }); await sleep(10);
  assert.equal(g2.state.stage, 'closed'); assert.match(g2.state.closed ?? '', /уже есть соперник/);
  g.dispose(); g2.dispose();
});

await test('the lobby: a silent peer is a lost connection after 12 seconds', async () => {
  let now = 0;
  const [a] = memoryPair(0);
  const s = new OnlineSession(a, 'host', { name: 'Х', mods: [], platform: 'web', app: 't' }, () => now);
  now = 13000; await sleep(2100);
  assert.equal(s.state.stage, 'closed'); assert.match(s.state.closed ?? '', /нет связи/);
  s.dispose();
});

console.log(`\n${pass} online tests passed (protocol ${PROTO})`);
