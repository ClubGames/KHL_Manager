// Run with: npx tsx scripts/lineup-test.ts
// Lineup editor rules: special-team slots are copies of dressed skaters and never touch the 5-on-5 lines.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { autoLineup, sanitizeLineup } from '../src/game/ai';
import { assignSpecial, autoSpecialTeams, cloneLineup, dedupeLineup, dressedSkaters, evenStrengthSpot, findSpecial } from '../src/game/lineupEdit';

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log('PASS', name);
};

const r = parseRosterText(readFileSync('public/mods/KHL_2627/roster.json', 'utf8'));
const P = r.players;
const team = r.teams[0];
const base = autoLineup(team.players, P);
const even = (L: typeof base) => JSON.stringify([L.F, L.D, L.starterG, L.backupG]);

ok('autoLineup fills full PP (5+5) and PK (4+4) units from dressed skaters', () => {
  assert.equal(base.pp1.length, 5);
  assert.equal(base.pp2.length, 5);
  assert.equal(base.pk1.length, 4);
  assert.equal(base.pk2.length, 4);
  const dressed = dressedSkaters(base);
  for (const id of [...base.pp1, ...base.pp2, ...base.pk1, ...base.pk2]) assert.ok(id && dressed.has(id));
});

ok('putting a 4th-line forward on PP1 keeps him (and everyone else) in the 5-on-5 lines', () => {
  const L = cloneLineup(base);
  const fourth = L.F[3][0]!;
  const before = even(L);
  assignSpecial(L, 'pp1', 0, fourth);
  dedupeLineup(L);
  assert.equal(L.pp1[0], fourth);
  assert.equal(even(L), before);
  assert.equal(evenStrengthSpot(L, fourth), '4-е звено');
});

ok('moving a player from PP2 to PP1 swaps the two slots', () => {
  const L = cloneLineup(base);
  const a = L.pp1[1]!, b = L.pp2[2]!;
  assignSpecial(L, 'pp1', 1, b);
  dedupeLineup(L);
  assert.equal(L.pp1[1], b);
  assert.equal(L.pp2[2], a);
  assert.deepEqual(findSpecial(L, 'pp', a), { unit: 'pp2', idx: 2 });
});

ok('the same player can be on the PP and the PK at once', () => {
  const L = cloneLineup(base);
  const star = L.pp1[0]!;
  assignSpecial(L, 'pk1', 0, star);
  dedupeLineup(L);
  assert.equal(L.pk1[0], star);
  assert.equal(L.pp1[0], star);
});

ok('clearing a special slot leaves it empty, the 5-on-5 lines untouched', () => {
  const L = cloneLineup(base);
  const before = even(L);
  assignSpecial(L, 'pk2', 3, null);
  dedupeLineup(L);
  assert.equal(L.pk2[3], null);
  assert.equal(L.pk2.length, 4);
  assert.equal(even(L), before);
});

ok('a player removed from the lines drops out of the special teams', () => {
  const L = cloneLineup(base);
  const star = L.pp1[0]!;
  for (const line of [...L.F, ...L.D]) for (let i = 0; i < line.length; i++) if (line[i] === star) line[i] = null;
  dedupeLineup(L);
  assert.equal(findSpecial(L, 'pp', star), null);
  assert.equal(findSpecial(L, 'pk', star), null);
});

ok('"Авто ЧБ" rebuilds only the PP, "Авто ЧМ" only the PK; sanitizeLineup keeps the user units', () => {
  const L = cloneLineup(base);
  L.pp1 = [null, null, null, null, null];
  L.pk1 = [L.F[3][0], L.F[3][1], L.D[2][0], L.D[2][1]];
  const pk = [...L.pk1];
  autoSpecialTeams(L, P, 'pp');
  assert.deepEqual(L.pp1, base.pp1);
  assert.deepEqual(L.pk1, pk);
  const s = sanitizeLineup(L, team.players, P);
  assert.deepEqual(s.pk1, pk);
  autoSpecialTeams(L, P, 'pk');
  assert.deepEqual(L.pk1, base.pk1);
});

ok('a bench player who replaces a PP/PK skater in the lines inherits his special-team slots', () => {
  const L = cloneLineup(base);
  const star = L.pp1[0]!;
  const used = new Set([...L.F.flat(), ...L.D.flat(), L.starterG, L.backupG]);
  const benchF = team.players.find((id) => !used.has(id) && P[id] && P[id].position !== 'G' && P[id].position !== 'D')!;
  assert.ok(benchF, 'team has a spare forward');
  const prev = cloneLineup(L);
  const isD = P[star].position === 'D';
  const lines = isD ? L.D : L.F;
  for (const line of lines) for (let i = 0; i < line.length; i++) if (line[i] === star) line[i] = benchF;
  dedupeLineup(L, prev);
  assert.equal(L.pp1[0], benchF);
  assert.equal(findSpecial(L, 'pp', star), null);
});

console.log(`\n${passed} passed`);
