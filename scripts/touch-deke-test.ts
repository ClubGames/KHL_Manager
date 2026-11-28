// The phone's deke button: which way the thumb goes across it picks the deke (up a spin-o-rama, down between the
// legs, left / right a toe drag that way, a tap the usual deke) — the swipe → kind mapping, the merge of the touch
// pad with the others, and the rink acting the kind (and the side, in the picture's terms also in mirrored periods).
// Run: npx tsx scripts/touch-deke-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { NO_PAD, PlayRink, type PadState } from '../src/game/playRink';
import { emptyTouch, keyboardPad, mergePads, swipeDeke, swipeDir, SWIPE_PX } from '../src/components/playInput';
import type { Team } from '../src/types';

const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
const P = r.players, teams = r.teams;
let pass = 0;
const test = (name: string, fn: () => void) => { fn(); pass++; console.log('✓', name); };
/* eslint-disable @typescript-eslint/no-explicit-any */
const priv = (k: PlayRink) => k as any;
const pair = (g: number): [Team, Team] => { const H = teams[g % teams.length]; let A = teams[(g * 5 + 3) % teams.length]; if (A.id === H.id) A = teams[(g + 1) % teams.length]; return [H, A]; };
const make = (g: number, flip = false) => { const [H, A] = pair(g); return new PlayRink({ home: H, away: A, players: P, lineups: [H.lineup, A.lineup], userSide: 0, kind: 'reg', periodMinutes: 20, seed: 4100 + g, autoSwitch: false, flip }); };
function toPlay(k: PlayRink) { for (let i = 0; i < 600 && k.mode !== 'play'; i++) k.advance(1 / 60); for (let i = 0; i < 30; i++) k.advance(1 / 60); }
function clear(k: PlayRink, keep: any[]) { for (const a of priv(k).onIce()) if (!keep.includes(a) && !a.goalie) { a.x = a.side ? 52 : 8; a.y = a.side ? 27 : 3; a.vx = 0; a.vy = 0; a.act = null; } }
function withPuck(g: number, flip = false) {
  const k = make(g, flip), p = priv(k);
  toPlay(k); p.mode = 'play';
  const me = p.skaters(0).find((a: any) => !a.kindD) ?? p.skaters(0)[0];
  p.ctl = me.id; clear(k, [me]);
  // skating up the ice in sim terms (+x); facing +x, y down: his right is +y
  Object.assign(me, { x: 30, y: 15, vx: 2, vy: 0, fa: 0, act: null, cool: 0, stun: 0 });
  p.puck.carrier = me; p.puck.dead = false; p.puck.shot = null; p.puck.passTo = null;
  p.prevPad = NO_PAD;
  return { k, p, me };
}
/** The touch button's pad: the deke pressed with the swipe's kind. */
const touchPad = (dir: ReturnType<typeof swipeDir>): PadState => { const t = { ...emptyTouch(), deke: true }; const d = swipeDeke(dir); t.dekeKind = d.kind; t.dekeSide = d.side; return mergePads(keyboardPad(new Set()), t); };

test('a swipe across the button: its main direction, a short move is a tap', () => {
  assert.equal(swipeDir(0, -30), 'up');
  assert.equal(swipeDir(0, 30), 'down');
  assert.equal(swipeDir(-30, 8), 'left');
  assert.equal(swipeDir(30, -10), 'right');
  assert.equal(swipeDir(5, 5), null);
  assert.equal(swipeDir(SWIPE_PX - 1, 0), null);
});

test('the kinds: up a spin-o-rama, down between the legs, left / right a toe drag that way, a tap the usual deke', () => {
  assert.deepEqual(swipeDeke('up'), { kind: 'spin' });
  assert.deepEqual(swipeDeke('down'), { kind: 'between' });
  assert.deepEqual(swipeDeke('left'), { kind: 'toe', side: -1 });
  assert.deepEqual(swipeDeke('right'), { kind: 'toe', side: 1 });
  assert.deepEqual(swipeDeke(null), {});
});

test('the merged pad carries the swipe only with the deke pressed', () => {
  const t = { ...emptyTouch(), dekeKind: 'spin' as const };
  assert.equal(mergePads(t).dekeKind, undefined, 'no press, no kind');
  assert.equal(touchPad('up').dekeKind, 'spin');
  assert.equal(touchPad('left').dekeSide, -1);
  assert.equal(touchPad(null).dekeKind, undefined);
});

test('the rink acts the swiped kind (a spin-o-rama even standing still, where the button alone would not)', () => {
  for (const [dir, kind] of [['up', 'spin'], ['down', 'between'], ['left', 'toe'], ['right', 'toe']] as const) {
    const { p, me } = withPuck(1);
    p.step(touchPad(dir));
    assert.equal(me.act?.k, 'deke', `${dir}: a deke`);
    assert.equal(me.act.kind, kind, `${dir}: ${kind}`);
  }
  const { p, me } = withPuck(1);
  p.step(touchPad(null));
  assert.equal(me.act?.kind, 'side', 'a tap: the usual deke');
});

test('left / right are his left / right as the picture shows him, also in the periods the picture is mirrored', () => {
  for (const flip of [false, true]) {
    for (const dir of ['left', 'right'] as const) {
      const { p, me } = withPuck(2, flip);
      p.step(touchPad(dir));
      // sim s = 1: his right in the simulation's frame; the mirrored picture swaps it
      const want = (dir === 'right' ? 1 : -1) * (flip ? -1 : 1);
      assert.equal(me.act?.s, want, `${dir}${flip ? ' (mirrored)' : ''}`);
    }
  }
});

console.log(`\n${pass} tests passed`);
