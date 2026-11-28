// After the final siren (3D): the plan of the post-match scene — the winners' mob at the goalie (most hop the boards,
// some use the gate), the losers' slump and walk off down the tunnel, the handshake line after a series, the salute
// and the star's bow, and for the Cup: the table, the lift, the lap of honour, the hand-off and the champions' photo.
// Run: npx tsx scripts/match-outro-test.ts
import assert from 'node:assert/strict';
import { outroSpecOf, planOutro, outroPoses, outroCamera, outroCup, outroShow, outroOfficials, outroChapter, type OutroSkater, type OutroKind } from '../src/components/matchOutro';
import { benchSeat } from '../src/components/arenaBenches';
import { RINK } from '../src/game/rinkGeometry';

let pass = 0;
const test = (name: string, fn: () => void) => { fn(); pass++; console.log('✓', name); };
const HW = RINK.width / 2, HL = RINK.length / 2;

/** Two dressed teams of 20 skaters + 2 goalies: 5 skaters and the starting goalie on the ice, the rest on the bench. */
function teams(seed = 1): OutroSkater[] {
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const out: OutroSkater[] = [];
  for (const side of [0, 1] as const) for (let i = 0; i < 22; i++) {
    const goalie = i >= 20, onIce = i < 5 || i === 20, seat = benchSeat(side, i);
    out.push({
      id: `${side}-${i}`, side, goalie, onIce, starter: i === 20, captain: i === 2, rating: 60 + ((i * 7) % 30),
      x: onIce ? (goalie ? (side ? 24.6 : -24.6) : (rnd() - .5) * 44) : seat.x,
      z: onIce ? (goalie ? 0 : (rnd() - .5) * 22) : seat.z,
      heading: onIce ? rnd() * 6.28 : undefined,
    });
  }
  return out;
}
const NETS: [number, number] = [-26, 26];
const plans = (kind: OutroKind, winner: 0 | 1 = 1, seed = 1) => planOutro({ winner, kind, score: winner ? [2, 3] : [4, 1], star: `${winner}-3`, series: [3, 4], cup: 'Кубок Гагарина', season: '2026/27' }, teams(seed), NETS);

for (const kind of ['win', 'series', 'cup'] as const) for (const winner of [0, 1] as const) {
  test(`${kind}, winner ${winner}: finite poses and camera, nobody skates faster than 8.5 m/s, everyone stays in the arena`, () => {
    const plan = plans(kind, winner);
    assert.ok(plan.t.length > 20 && plan.t.length < 100, `length ${plan.t.length}`);
    const offs = [{ x: 0, z: 0 }, { x: 3, z: 2 }, { x: -8, z: 5 }, { x: 10, z: -4 }];
    for (let t = 0; t <= plan.t.length; t += .05) {
      const P = outroPoses(plan, t);
      assert.equal(P.size, 44);
      for (const [id, p] of P) {
        assert.ok([p.x, p.y, p.z, p.heading, p.speed, p.cheer, p.shake, p.kneel, p.trophy].every(Number.isFinite), `${id} @${t}`);
        if (p.visible && p.walk < .5) assert.ok(p.speed <= 8.5, `${id} @${t.toFixed(2)}: ${p.speed.toFixed(1)} m/s`);
        assert.ok(Math.abs(p.x) <= HL + .5 && p.z <= HW + 1 && p.z >= -(HW + 6), `${id} @${t}: ${p.x}, ${p.z}`);
        assert.ok(p.y >= 0 && p.y < 1.3);
      }
      const c = outroCamera(plan, t, P);
      assert.ok([c.pos.x, c.pos.y, c.pos.z, c.look.x, c.look.y, c.look.z, c.fov].every(Number.isFinite), `camera @${t}`);
      assert.ok(c.pos.y > .5 && c.fov > 20 && c.fov < 60);
      const s = outroShow(plan, t), cup = outroCup(plan, t);
      assert.ok([s.level, s.burst, s.confetti, cup.table, cup.carpet].every(v => Number.isFinite(v) && v >= 0 && v <= 1.01));
      for (const o of outroOfficials(plan, t, offs)) assert.ok(Number.isFinite(o.x + o.z + o.heading));
      assert.ok(outroChapter(plan, t).title.length > 0);
    }
  });
}

test('the winners mob their goalie (everyone near the crease), the bench comes over the boards and through the gate', () => {
  const plan = plans('win');
  const P = outroPoses(plan, plan.t.mob - .2);
  const crease = { x: NETS[1] - 1.7, z: 0 };
  const near = [...P].filter(([id, p]) => id.startsWith('1-') && Math.hypot(p.x - crease.x, p.z - crease.z) < 4.2);
  assert.ok(near.length >= 20, `${near.length} at the crease`);
  const segs = [...plan.tracks].filter(([id]) => id.startsWith('1-')).flatMap(([, tr]) => tr.segs);
  const hops = segs.filter(s => s.step === 'hop').length;
  assert.ok(hops >= 8, `${hops} hop the boards`);
  // the hop rises above the boards
  let top = 0;
  for (let t = 0; t < 4; t += .02) for (const [id, p] of outroPoses(plan, t)) if (id.startsWith('1-')) top = Math.max(top, p.y);
  assert.ok(top > .8, `hop height ${top}`);
  // the backup goalie walks out through the gate (not over the boards)
  assert.ok(!plan.tracks.get('1-21')!.segs.some(s => s.step === 'hop'));
});

test('the losers slump, their goalie goes down on a knee, and they all walk off down the tunnel', () => {
  const plan = plans('win');
  let kneel = 0, slump = 0;
  for (let t = 0; t < 4; t += .1) { const p = outroPoses(plan, t).get('0-20')!; kneel = Math.max(kneel, p.kneel); slump = Math.max(slump, p.slump); }
  assert.ok(kneel > .4 && slump > .9);
  const end = outroPoses(plan, plan.t.length + 15);
  assert.equal([...end].filter(([id, p]) => id.startsWith('0-') && p.visible).length, 0);
  // the winners are gone too (through their gate)
  assert.equal([...end].filter(([, p]) => p.visible).length, 0);
});

test('the salute: the winners in a line facing the cameras, sticks up; the star steps out', () => {
  const plan = plans('win');
  const P = outroPoses(plan, plan.t.salute + 1.5);
  const w = [...P].filter(([id]) => id.startsWith('1-')).map(([, p]) => p);
  assert.ok(w.every(p => Math.abs(p.z - 1.6) < .3 && Math.abs(Math.sin(p.heading) + 1) < .05), 'in line facing +z');
  assert.ok(w.filter(p => p.cheer > .8).length >= 20);
  const star = outroPoses(plan, plan.t.star + 3).get('1-3')!;
  assert.ok(star.z > 4, `star at z=${star.z}`);
  assert.ok(plan.chapters.some(c => c.title === 'Звезда матча' && c.who === '1-3'));
});

test('a series won: the handshake line — every man shakes hands with the other team', () => {
  const plan = plans('series');
  assert.ok(plan.line);
  const shook = new Set<string>();
  for (let t = plan.line!.t0; t < plan.line!.t1; t += .05) for (const [id, p] of outroPoses(plan, t)) if (p.shake > .9) shook.add(id);
  assert.equal(shook.size, 44, `${shook.size} shook hands`);
  assert.ok(plan.chapters.some(c => c.title === 'Рукопожатия'));
  assert.ok(plan.chapters[0].title === 'Серия выиграна' && /4–3 в серии/.test(plan.chapters[0].sub ?? ''));
  // a plain win has none
  assert.equal(plans('win').line, null);
});

test('the Cup: sticks thrown, the table and carpet, the captain lifts it, the lap of honour, the hand-off, the photo', () => {
  const plan = plans('cup');
  const T = plan.t;
  assert.ok(T.setup < T.lift && T.lift < T.lap && T.lap < T.photo && T.photo < T.length);
  assert.ok(plan.throws.length >= 5);
  assert.ok(outroPoses(plan, 1.5).get('1-0')!.noStick);
  const capt = '1-2';
  assert.equal(outroCup(plan, T.lift + 1.5).holder, capt);
  assert.ok(outroPoses(plan, T.lift + 2.2).get(capt)!.trophy > .9, 'over his head');
  assert.ok(outroCup(plan, T.lift - 2).onTable && outroCup(plan, T.lift - 2).table > .9);
  assert.ok(outroShow(plan, T.lift + .5).burst > .5 && outroShow(plan, T.lift + 1).confetti > .9);
  // the lap: he goes all the way round (both ends of the rink)
  let minX = 0, maxX = 0;
  for (let t = T.lap; t < T.photo; t += .1) { const p = outroPoses(plan, t).get(capt)!; minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); }
  assert.ok(minX < -10 && maxX > 10, `lap ${minX}…${maxX}`);
  // the hand-off to the goalie
  assert.ok(plan.holders.some(h => h.id === '1-20'));
  // the photo: everyone near centre ice facing the cameras, the front row kneeling, the captain holds the Cup
  const P = outroPoses(plan, T.length - 2);
  const w = [...P].filter(([id]) => id.startsWith('1-')).map(([, p]) => p);
  assert.ok(w.every(p => Math.abs(p.x) < 6 && Math.abs(p.z - 1) < 1.2), 'grouped for the photo');
  assert.ok(w.filter(p => p.kneel > .9).length >= 10);
  assert.equal(outroCup(plan, T.length - 2).holder, capt);
  assert.deepEqual(plan.chapters.map(c => c.title).filter(t => /Чемпион|Вручение|Круг|Фото/.test(t)), ['Чемпион!', 'Вручение: Кубок Гагарина', 'Круг почёта', 'Фото чемпионов']);
  // the losers have left before the photo
  assert.equal(w.length, 22);
  assert.equal([...P].filter(([id, p]) => id.startsWith('0-') && p.visible).length, 0);
});

test('works with a light preset (no bench), a missing goalie and other seeds', () => {
  const few = teams(3).filter(s => s.onIce);
  for (const kind of ['win', 'series', 'cup'] as const) {
    const plan = planOutro({ winner: 0, kind, score: [3, 2] }, few, NETS);
    for (let t = 0; t < plan.t.length; t += .25) for (const p of outroPoses(plan, t).values()) assert.ok(Number.isFinite(p.x + p.z));
    const noG = planOutro({ winner: 1, kind, score: [1, 2], end: 'ot' }, teams(5).filter(s => !s.goalie), NETS);
    assert.ok(noG.t.length > 10 && / в овертайме/.test(noG.chapters[0].sub ?? ''));
  }
  for (const seed of [7, 11, 13, 17]) { const p = plans('cup', 0, seed); assert.ok(Number.isFinite(p.t.length)); }
});

test('outroSpecOf: a plain win, a series clinched, the final clinched (the Cup), the star from the winners', () => {
  const teamOf = (id: string) => (id.startsWith('h') ? 'H' : 'A');
  const base = { home: 'H', away: 'A', teamOf };
  const w = outroSpecOf({ homeScore: 2, awayScore: 3, ot: true, stars: ['h1', 'a7'] }, base);
  assert.deepEqual([w.winner, w.kind, w.end, w.star], [1, 'win', 'ot', 'a7']);
  // a series 3–2 for the away team (the low seed), it wins game 6
  const s = outroSpecOf({ homeScore: 1, awayScore: 4, stars: ['a1'] }, { ...base, series: { high: 'H', low: 'A', wins: [2, 3], final: false } });
  assert.deepEqual([s.kind, s.series], ['series', [2, 4]]);
  // not clinched yet: a plain win
  assert.equal(outroSpecOf({ homeScore: 3, awayScore: 1 }, { ...base, series: { high: 'A', low: 'H', wins: [1, 2], final: true } }).kind, 'win');
  const c = outroSpecOf({ homeScore: 3, awayScore: 2, so: true }, { ...base, series: { high: 'A', low: 'H', wins: [3, 3], final: true }, cup: 'Кубок Гагарина', season: '2026/27' });
  assert.deepEqual([c.kind, c.winner, c.series, c.end, c.cup], ['cup', 0, [4, 3], 'so', 'Кубок Гагарина']);
});

console.log(`\n${pass} passed`);
