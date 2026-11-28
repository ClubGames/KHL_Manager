// Faceoff line-ups (faceoffFormation.ts, used by RinkAI and PlayRink): at every dot and every strength, each man of
// both teams has a place of his own (at least 1.2 m from anybody else, goalies included), the centre is at the dot,
// and the played rink lines up so too (4-on-4 used to send both defencemen to the same spot).
// Run: npx tsx scripts/faceoff-formation-test.ts
import assert from 'node:assert/strict';
import { boardsSide, foPlaces, foSpot } from '../src/game/faceoffFormation';
import { FACEOFF_SPOTS, RINK } from '../src/game/rinkGeometry';

let n = 0;
const ok = (m: string) => { n++; console.log('✓', m); };
const L = RINK.length, W = RINK.width, GOAL = RINK.goalLine;
type V2 = { x: number; y: number };
const loc = (s: 0 | 1, p: V2): V2 => (s ? { x: L - p.x, y: W - p.y } : { x: p.x, y: p.y });
const dots: V2[] = [{ x: L / 2, y: W / 2 }, ...FACEOFF_SPOTS.end, ...FACEOFF_SPOTS.neutral];
// strengths: [forwards, defence] — 5 on 5, 4 on 4, 3 on 3, PK (2F+2D, 1F+2D, 2F+1D, 3F+1D), PP (4F+1D, 3F+2D), extra attacker (4F+2D), all-D, no-D
const units: [number, number][] = [[3, 2], [2, 2], [2, 1], [1, 2], [3, 1], [4, 1], [4, 2], [0, 3], [3, 0], [1, 1], [5, 1]];

let worst = Infinity, worstAt = '';
for (const dot of dots) for (const u0 of units) for (const u1 of units) {
  const all: { p: V2; who: string }[] = [];
  for (const s of [0, 1] as const) {
    const [nF, nD] = s ? u1 : u0, d = loc(s, dot);
    const pl = foPlaces(nF, nD, boardsSide(d));
    assert.equal(new Set([...pl.F, ...pl.D]).size, nF + nD, `distinct places ${nF}F+${nD}D`);
    if (nF + nD) assert.ok(pl.F[0] === 'C' || (nF === 0 && pl.D[0] === 'C'), 'somebody takes the draw');
    [...pl.F, ...pl.D].forEach((q, i) => all.push({ p: loc(s, foSpot(d, q)), who: `${s}:${q}${i}` }));
    all.push({ p: loc(s, { x: GOAL + 1.0, y: W / 2 }), who: `${s}:G` });
  }
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const dd = Math.hypot(all[i].p.x - all[j].p.x, all[i].p.y - all[j].p.y);
    if (dd < worst) { worst = dd; worstAt = `${all[i].who}/${all[j].who} at ${dot.x},${dot.y} ${u0}|${u1}`; }
  }
  for (const a of all) assert.ok(a.p.x > 0.5 && a.p.x < L - 0.5 && a.p.y >= 1 && a.p.y <= W - 1, 'on the ice');
}
assert.ok(worst >= 1.2, `two men too close: ${worst.toFixed(2)} m (${worstAt})`);
ok(`every dot, every strength: a place of his own for everybody (closest pair ${worst.toFixed(2)} m)`);

const p = foPlaces(2, 2, -1);
assert.deepEqual(p.D, ['LD', 'RD']); assert.deepEqual(p.F, ['C', 'LW']);
assert.deepEqual(foPlaces(2, 2, 1).F, ['C', 'RW']);
assert.deepEqual(foPlaces(2, 1).D, ['D']);
ok('4-on-4: two points and a winger on the boards side; 3-on-3: the lone defenceman in the middle');
console.log(`\n${n} faceoff formation tests passed`);
