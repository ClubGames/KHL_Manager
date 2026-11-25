// Statistical engine: extra skaters, goalie changes, goalie strength, the special-teams clock and the overtime length.
// Run: npx tsx scripts/match-sim-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { blockLen, GameSim } from '../src/game/engine';
import { restTiredStarter } from '../src/game/ai';
import { isGoalie } from '../src/game/ratings';
import { ppLeftAt } from '../src/components/replayBroadcast';
import type { GameEvent, Team } from '../src/types';

const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
const P = r.players, teams = r.teams;
let pass = 0;
const test = (name: string, fn: () => void) => { fn(); pass++; console.log('✓', name); };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** The team with a 13th forward and a 7th defenceman dressed (the first spare skaters of its roster). */
function withExtras(t: Team): Team {
  const T = clone(t), L = T.lineup;
  const used = new Set([...L.F.flat(), ...L.D.flat(), L.starterG, L.backupG]);
  const spare = T.players.map(id => P[id]).filter(p => p && !isGoalie(p) && !used.has(p.id));
  L.u20F = spare.find(p => p.position !== 'D')?.id ?? null;
  L.u20D = spare.find(p => p.position === 'D')?.id ?? null;
  return T;
}

test('the extra forward and defenceman play real shifts (≈5 minutes a game)', () => {
  const share: Record<'f' | 'd' | 'line4', number[]> = { f: [], d: [], line4: [] };
  for (let g = 0; g < 60; g++) {
    const H = withExtras(teams[g % teams.length]), A = withExtras(teams[(g * 7 + 3) % teams.length]);
    if (H.id === A.id) continue;
    const sim = new GameSim(H, A, P);
    const shifts: Record<string, number> = {};
    let total = 0;
    const seat = (sim as unknown as { seat: (i: 0 | 1, ids: (string | null)[]) => (string | null)[] }).seat.bind(sim);
    (sim as unknown as { seat: typeof seat }).seat = (i, ids) => { const out = seat(i, ids); for (const id of out) if (id) { shifts[id] = (shifts[id] ?? 0) + 1; total++; } return out; };
    sim.runAll();
    const min = (id: string | null) => (id ? ((shifts[id] ?? 0) / (total / 10)) * 60 : 0);
    for (const T of [H, A]) {
      if (T.lineup.u20F) share.f.push(min(T.lineup.u20F));
      if (T.lineup.u20D) share.d.push(min(T.lineup.u20D));
      share.line4.push(min(T.lineup.F[3][0]));
    }
  }
  const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  assert.ok(avg(share.f) > 3.5 && avg(share.f) < 9, `13th forward ${avg(share.f).toFixed(1)} min`);
  assert.ok(avg(share.d) > 3.5 && avg(share.d) < 9, `7th defenceman ${avg(share.d).toFixed(1)} min`);
  assert.ok(avg(share.line4) > avg(share.f), 'the regular 4th line still plays more than the extra forward');
});

test('goalies: save % in the KHL range, blue-line shots rarely go in; a bad night gets the starter pulled', () => {
  let shots = 0, goals = 0, point = 0, pointGoals = 0, games = 0, swaps = 0;
  for (let g = 0; g < 240; g++) {
    const H = teams[g % teams.length], A = teams[(g * 7 + 3) % teams.length];
    if (H === A) continue;
    const sim = new GameSim(H, A, P);
    const res = sim.runAll();
    games++;
    for (const s of sim.shotMap) {
      if (s.outcome === 'miss') continue;
      shots++; if (s.outcome === 'goal') goals++;
      if (s.zone === 'point') { point++; if (s.outcome === 'goal') pointGoals++; }
    }
    for (const T of [H, A]) {
      const st = T.lineup.starterG!, bk = T.lineup.backupG;
      const ms = res.lines[st]?.minutes ?? 0, mb = bk ? res.lines[bk]?.minutes ?? 0 : 0;
      if (mb > 0) {
        swaps++;
        // the starter's and the backup's minutes add up to the game
        const len = res.so ? 65 : Math.min(65, Math.round(sim.sec / 60));
        assert.ok(Math.abs(ms + mb - len) <= 1, `goalie minutes ${ms} + ${mb} vs ${len}`);
        assert.ok(ms >= 20, 'the starter is changed at an intermission');
      }
    }
  }
  const sv = 1 - goals / shots;
  assert.ok(sv > 0.906 && sv < 0.925, `save % ${sv.toFixed(3)}`);
  assert.ok(pointGoals / point < 0.04, `goals from the point ${(100 * pointGoals / point).toFixed(1)}%`);
  assert.ok(swaps > 0 && swaps / (games * 2) < 0.15, `goalie changes in ${swaps} of ${games * 2} team-games`);
});

test('automatic goalie rotation: a worn-out starter sits, a fresh one plays', () => {
  const T = teams[0], s = P[T.lineup.starterG!], b = P[T.lineup.backupG!];
  const L = { starterG: s.id, backupG: b.id };
  const at = (sf: number, bf: number) => { s.fatigue = 100 - sf; b.fatigue = 100 - bf; return restTiredStarter(L, P); };
  assert.equal(at(90, 95), false, 'a fresh starter plays');
  assert.equal(at(55, 90), true, 'a tired starter sits when the backup is fresh');
  assert.equal(at(55, 62), false, 'no point when the backup is tired too');
  s.fatigue = 0; b.fatigue = 0;
});

test('the special-teams clock: time left on the power play at a goal; the overtime clock is 5:00', () => {
  const H = 'h', mk = (e: Partial<GameEvent>): GameEvent => ({ sec: 0, period: 1, time: '', team: null, type: 'info', text: '', ...e } as GameEvent);
  const pen = mk({ sec: 300, type: 'penalty', team: 'a', box: [[], [[300, 420]]] });
  const goal = mk({ sec: 336, type: 'goal', team: H, strength: 'PP' });
  assert.equal(ppLeftAt([pen, goal], goal, H), 84, '2:00 minor taken at 5:00, goal at 5:36 → 1:24 left');
  assert.equal(ppLeftAt([goal], goal, H), null, 'even strength has no clock');
  assert.equal(blockLen('ot3'), 300);
  assert.equal(blockLen('reg'), 1200);
});

console.log(`\n${pass} match simulation tests passed`);
