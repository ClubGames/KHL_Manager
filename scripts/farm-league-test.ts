// The second (farm) league is named by the mod: roster.json "league": { "farm": "…" }. Without it the roster warns and
// the game falls back to «ВХЛ»; players marked with the farm league's name start in the farm club; a career keeps the
// name, and every text the player sees follows it (FL()).
// Run: npx tsx scripts/farm-league-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeRoster, parseRosterText } from '../src/game/roster';
import { DEFAULT_FARM_NAME, FL, farmName, setCurrentLeague } from '../src/brand';
import * as G from '../src/game/state';
import { FACILITY_META } from '../src/game/medical';

let pass = 0;
const test = (name: string, fn: () => void) => { fn(); pass++; console.log('✓', name); };
const fixture = JSON.parse(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
const WARN = /второй \(фарм\) лиги/;
const withLeague = (league: Record<string, unknown>) => ({ ...fixture, league: { ...fixture.league, ...league } });

test('a roster without league.farm warns and falls back to «ВХЛ»', () => {
  const r = normalizeRoster(withLeague({ farm: undefined }));
  assert.equal(r.farmName, DEFAULT_FARM_NAME);
  assert.equal(DEFAULT_FARM_NAME, 'ВХЛ');
  assert.equal(r.warnings.filter((w) => WARN.test(w)).length, 1, r.warnings.join(' | '));
});

test('league.farm names the second league, no warning', () => {
  const r = normalizeRoster(withLeague({ farm: '  Высшая лига  ' }));
  assert.equal(r.farmName, 'Высшая лига');
  assert.ok(!r.warnings.some((w) => WARN.test(w)));
  // other spellings a mod author may use
  assert.equal(normalizeRoster(withLeague({ farmLeague: 'ВЛ' })).farmName, 'ВЛ');
  assert.equal(normalizeRoster(withLeague({ farm: { name: 'Б-лига' } })).farmName, 'Б-лига');
  assert.equal(normalizeRoster({ ...fixture, farmLeague: 'Резерв' }).farmName, 'Резерв');
  // an empty name counts as missing
  const empty = normalizeRoster(withLeague({ farm: '   ' }));
  assert.equal(empty.farmName, DEFAULT_FARM_NAME);
  assert.ok(empty.warnings.some((w) => WARN.test(w)));
});

test('"league": <the farm league\'s name> on a player starts him in the farm club', () => {
  const raw = structuredClone(withLeague({ farm: 'ВЛ' }));
  const team = raw.teams[0];
  const [a, b, c] = team.players;
  a.league = 'ВЛ';
  b.league = 'вхл'; // the old alias keeps working
  c.status = 'фарм';
  const r = normalizeRoster(raw);
  const P = Object.values(r.players);
  const find = (x: { name: string }) => P.find((p) => p.name === x.name)!;
  assert.equal(find(a).inVhl, true, 'by the farm league name');
  assert.equal(find(b).inVhl, true, 'by «ВХЛ»');
  assert.equal(find(c).inVhl, true, 'by «фарм»');
  assert.equal(P.filter((p) => p.inVhl).length >= 3, true);
});

test('FL() follows the open career; old careers without a name show «ВХЛ»', () => {
  setCurrentLeague('ХЛ', 'ВЛ');
  assert.equal(FL(), 'ВЛ');
  assert.match(FACILITY_META.find((m) => m.key === 'scouting')!.subtitle, /МХЛ\/ВЛ/, 'read when shown, not at import');
  setCurrentLeague('ХЛ');
  assert.equal(FL(), 'ВХЛ');
  assert.equal(farmName({ league: { farm: 'Б-лига' } }), 'Б-лига');
  assert.equal(farmName({ league: {} }), 'ВХЛ');
  assert.equal(farmName(null), 'ВХЛ');
});

test('a career keeps the mod\'s farm league and its texts use it', () => {
  const r = parseRosterText(JSON.stringify(withLeague({ farm: 'ВЛ' })));
  const uid = r.teams[0].id;
  const s = G.createGameState(r, uid);
  assert.equal(s.league.farm, 'ВЛ');
  G.store.set(s);
  assert.equal(FL(), 'ВЛ');
  // a young player goes down without waivers: the news names the mod's farm league
  const st = G.store.get()!;
  const young = st.teams[uid].players.map((id) => st.players[id]).find((p) => !p.inVhl && p.age <= 22 && !p.nmc && p.pos !== 'G');
  assert.ok(young, 'a player of 22 or younger');
  const err = G.sendToVhlOrWaivers(young!.id);
  assert.equal(err, null, String(err));
  const news = G.store.get()!.news.slice(0, 5).map((n) => n.text).join(' | ');
  assert.match(news, /фарм-клуб ВЛ/, news);
  assert.doesNotMatch(news, /ВХЛ/);
  // closing the career returns the default
  G.store.set(null);
  assert.equal(FL(), 'ВХЛ');
});

console.log(`farm league: ${pass} passed`);
