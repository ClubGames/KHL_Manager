// KHL penalty types (minor, bench minor, double minor, major, misconduct, game misconduct, match penalty, penalty
// shot) in the books of the season simulation and of the played rink, and the stick play that decides a poke check
// by where the sticks really meet (the puck, the blade, the shaft — or the carrier's skates: a trip).
// Run: npx tsx scripts/khl-penalties-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { GameSim } from '../src/game/engine';
import { EJECT_END, INFRACTIONS, SHORT_MIN, drawCall, ejects, penHeadline, penLength, pimOf, type PenaltyCall } from '../src/game/penalties';
import { PlayRink } from '../src/game/playRink';
import { foulMove } from '../src/game/rinkPlayback';
import { penaltyGesture } from '../src/components/officialCrew';

const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
const P = r.players, teams = r.teams;
let pass = 0;
const test = (name: string, fn: () => void) => { const t = Date.now(); fn(); pass++; console.log('✓', name, `(${((Date.now() - t) / 1000).toFixed(1)} s)`); };
/* eslint-disable @typescript-eslint/no-explicit-any */
const H = teams.find(t => t.id === 'ska')!, A = teams.find(t => t.id === 'avangard')!;

test('the KHL table: minutes in the box, penalty minutes, who leaves the game, how the scoreboard writes it', () => {
  const c = (kind: PenaltyCall['kind'], plus?: PenaltyCall['plus']): PenaltyCall => ({ kind, reason: 'x', ...(plus ? { plus } : {}) });
  // short-handed: a misconduct and a game misconduct leave the team at full strength; a match penalty is 5 (a substitute serves it)
  assert.deepEqual(SHORT_MIN, { minor: 2, bench: 2, double: 4, major: 5, misconduct: 0, game: 0, match: 5 });
  assert.deepEqual([c('minor'), c('bench'), c('double'), c('major'), c('misconduct'), c('game'), c('match')].map(pimOf), [2, 2, 4, 5, 10, 20, 25]);
  assert.equal(pimOf(c('minor', 'misconduct')), 12, '2+10');
  assert.equal(pimOf(c('major', 'game')), 25, '5 + ДдКМ');
  assert.deepEqual([c('minor'), c('misconduct'), c('minor', 'misconduct'), c('game'), c('match'), c('major', 'game')].map(ejects), [false, false, false, true, true, true]);
  assert.equal(penLength(c('double')), '2+2 мин');
  assert.equal(penLength(c('major', 'game')), '5 мин + ДдКМ');
  assert.equal(penLength(c('minor', 'misconduct')), '2+10 мин');
  assert.equal(penHeadline(c('bench')), 'Малый скамеечный штраф (2 мин)');
  assert.equal(penHeadline(c('match')), 'Матч-штраф');
  // every infraction is acted out or signalled: no reason falls through to the plain fist (roughing is the fist itself; bench calls, abuse, embellishment share it)
  for (const inf of INFRACTIONS) {
    const g = penaltyGesture(inf.reason);
    if (!/грубость|удар головой|скамейк|численного|оскорблен|сломанной|бросок клюшки|симуляц|неспортивн/.test(inf.reason)) assert.notEqual(g, 'fist', inf.reason);
  }
  assert.equal(foulMove('отсечение'), 'fTrip');
  assert.equal(foulMove('колющий удар'), 'fCross');
  // drawn as in a season: mostly minors, every kind turns up
  let x = 7;
  const rnd = () => { x = (x * 16807) % 2147483647; return x / 2147483647; };
  const kinds: Record<string, number> = {};
  for (let i = 0; i < 20000; i++) { const k = drawCall(rnd).kind; kinds[k] = (kinds[k] ?? 0) + 1; }
  console.log('   20000 calls:', JSON.stringify(kinds));
  assert.ok(kinds.minor / 20000 > 0.75, 'most calls are minors');
  for (const k of ['bench', 'double', 'major', 'misconduct', 'game', 'match']) assert.ok(kinds[k] > 0, k);
});

test('the season simulation keeps the books: penalty minutes add up, a misconduct leaves nobody short, an ejected man is gone', () => {
  let pens = 0, mis = 0, eject = 0, shots = 0, shotGoals = 0, badPim = 0, misShort = 0;
  for (let g = 0; g < 160; g++) {
    const [h, a] = g % 2 ? [H, A] : [A, H];
    const sim = new GameSim({ id: h.id, lineup: h.lineup, name: h.name }, { id: a.id, lineup: a.lineup, name: a.name }, P);
    while (sim.status !== 'done') { if (sim.status === 'ot') sim.simOT(); else if (sim.status === 'so') sim.simShootout(); else sim.simPeriod(); }
    const res = sim.result();
    const pimSum = [0, 0];
    for (const e of res.events) {
      if (e.type === 'penalty') {
        pens++;
        pimSum[e.team === h.id ? 0 : 1] += e.pim ?? 0;
        if (e.penKind === 'misconduct') { mis++; if (e.pp) misShort++; }
        if (e.ejected) eject++;
      }
      if (e.text?.startsWith('Штрафной бросок!')) shots++;
      if (e.type === 'goal' && e.text.includes('штрафной бросок')) shotGoals++;
    }
    if (pimSum[0] !== res.homeStats.pim || pimSum[1] !== res.awayStats.pim) badPim++;
  }
  console.log(`   160 games: ${pens} penalties, ${mis} misconducts, ${eject} ejections, ${shots} penalty shots (${shotGoals} goals)`);
  assert.equal(badPim, 0, 'the penalty minutes in the box score are the sum of the calls');
  assert.equal(misShort, 0, 'a misconduct gives no power play');
  assert.ok(mis > 0 && eject > 0, 'misconducts and ejections happen');
  assert.ok(shots > 0 && shots / 160 < 0.12, 'penalty shots are rare (a few a season per club)');
  assert.ok(pens / 160 > 3.5 && pens / 160 < 14, `about as many calls as in the KHL (${(pens / 160).toFixed(1)} a game)`);
});

/** A rink in play with one carrier and one defender placed by hand; the others far away. */
function duel(seed: number) {
  const k = new PlayRink({ home: H, away: A, players: P, lineups: [H.lineup, A.lineup], userSide: null, kind: 'reg', periodMinutes: 20, seed });
  for (let i = 0; i < 900 && k.mode !== 'play'; i++) k.advance(1 / 60);
  const p = k as any;
  const c = p.skaters(0)[0], d = p.skaters(1)[0];
  for (const a of [...p.skaters(0), ...p.skaters(1)]) if (a !== c && a !== d) { a.x = 5; a.y = 2 + (a.side ? 26 : 0); a.vx = a.vy = 0; }
  c.x = 30; c.y = 15; c.vx = c.vy = 0; c.fa = 0; c.stagger = 0; c.down = 0; c.act = null; c.protect = false; c.boardPlay = false;
  d.vx = d.vy = 0; d.act = null; d.cool = 0;
  p.puck.carrier = c; p.puck.dead = false; p.puck.shot = null; p.puck.passTo = null; p.puck.h = 0;
  const putPuck = () => { const b = p.blade(c); p.puck.x = b.x; p.puck.y = b.y; };
  putPuck();
  return { k, p, c, d, putPuck };
}

test('a poke check is decided by where the sticks meet: on the puck it is taken, through his skates it is a trip', () => {
  // in front of him, at the puck: the poke meets the puck first
  let took = 0, tries = 0;
  for (let s = 0; s < 30; s++) {
    const { k, p, c, d } = duel(100 + s);
    const pk = p.puck;
    d.x = pk.x + 1.1; d.y = pk.y; d.fa = Math.PI; d.manual = false;
    d.act = { k: 'poke', t0: p.tau, done: false, lift: false };
    const line = p.pokeLine(d, false, false), hit = p.stickContact(line.pts, c);
    void k;
    assert.equal(hit?.what, 'puck', 'from in front the stick meets the puck');
    tries++;
    p.resolvePoke(d);
    if (p.puck.carrier !== c) took++;
  }
  console.log(`   from in front: ${took}/${tries} pokes win the puck (soft hands cushion some)`);
  assert.ok(took >= tries * 0.6, 'a poke that meets the puck mostly wins it');
  // from straight behind him, at the puck: his body is in the way — the stick finds his skates
  let legs = 0, falls = 0, trips = 0;
  for (let s = 0; s < 40; s++) {
    const { p, c, d } = duel(300 + s);
    c.vx = 5; // skating up ice
    d.x = c.x - 1.2; d.y = c.y; d.fa = 0; d.manual = true; // the manager's man pokes the way he faces
    d.act = { k: 'poke', t0: p.tau, done: false, lift: false };
    const hit = p.stickContact(p.pokePath(d, 0), c);
    if (hit?.what !== 'legs') continue;
    legs++;
    const before = p.out.length;
    p.resolvePoke(d);
    if (c.down > 0 || c.fall) falls++;
    if (p.pending.some((x: any) => x.reason === 'подножка') || p.out.slice(before).some((o: any) => o.type === 'penalty' && o.reason === 'подножка')) trips++;
    p.pending = [];
  }
  console.log(`   from behind into his skates: ${legs} contacts, ${falls} falls, ${trips} trips called`);
  assert.ok(legs >= 30, 'from straight behind a poke at the puck goes through his skates');
  assert.ok(trips > 0 && trips <= falls + 2, 'a fall from the stick in his skates is a trip');
});

test('a stick lift goes for his stick (round his hip from behind), and the AI does not stab blindly at his skates', () => {
  let found = 0;
  for (let s = 0; s < 20; s++) {
    const { p, c, d } = duel(500 + s);
    d.x = c.x - 1.0; d.y = c.y + 0.35; d.fa = 0; d.manual = false;
    const line = p.pokeLine(d, true, false);
    if (line) { const hit = p.stickContact(line.pts, c); assert.notEqual(hit?.what, 'legs'); assert.ok(hit, 'it reaches his stick'); found++; }
  }
  assert.ok(found >= 15, `a lift from behind and a little to the side finds his stick (${found}/20)`);
  // AI periods: few sticks in skates, trips stay a fraction of the calls
  let pokes = 0, legs = 0;
  for (let g = 0; g < 2; g++) {
    const k = new PlayRink({ home: H, away: A, players: P, lineups: [H.lineup, A.lineup], userSide: null, kind: 'reg', periodMinutes: 20, seed: 900 + g });
    const p = k as any, sl = p.stickInLegs.bind(p), rp = p.resolvePoke.bind(p);
    p.stickInLegs = (...a: any[]) => { legs++; return sl(...a); };
    p.resolvePoke = (...a: any[]) => { pokes++; return rp(...a); };
    for (let i = 0; i < 2400 * 60 && !k.ended; i++) { k.advance(1 / 60); k.drain(); }
  }
  console.log(`   2 AI periods: ${pokes} pokes, ${legs} in the skates`);
  assert.ok(pokes > 100 && legs < pokes * 0.15, 'the AI reads the play: its pokes rarely end in a man\'s skates');
});

test('a game misconduct in the rink: he leaves for the dressing room and his team is not short-handed; a double minor is 4', () => {
  const { k, p, d } = duel(42);
  const men0 = p.manpower(1);
  p.assess({ side: 1, player: d, reason: 'неспортивное поведение', min: 2, kind: 'game' });
  const o: any = k.drain().find((x: any) => x.type === 'penalty');
  assert.equal(o.kind, 'game');
  assert.equal(o.min, 20, '20 penalty minutes in the books');
  assert.equal(d.ejected, true, 'he is out of the game');
  assert.equal(d.coin, true, 'his team plays at full strength');
  assert.equal(p.manpower(1), men0, 'still full strength');
  const { k: k2, p: p2 } = duel(43);
  const e = p2.skaters(1)[1];
  p2.assess({ side: 1, player: e, reason: 'игра высоко поднятой клюшкой', min: 4 });
  const o2: any = k2.drain().find((x: any) => x.type === 'penalty');
  assert.equal(o2.kind, 'double'); assert.equal(o2.min, 4); assert.equal(e.boxMin, 4);
  assert.ok(!e.coin, 'a double minor leaves his team short');
});

console.log(`${pass} KHL penalty / stick-contact tests passed`);
