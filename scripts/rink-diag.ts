// Diagnostics of the agent rink (not a test): line counts, roles, defensive gap, possession rhythm.
// Run: npx tsx scripts/rink-diag.ts [games]
import { readFileSync } from 'node:fs';
import { parseRosterText } from '../src/game/roster';
import { GameSim } from '../src/game/engine';
import { RinkAI } from '../src/game/rinkAI';

const r = parseRosterText(readFileSync('scripts/fixtures/test-roster.json', 'utf8'));
const H = r.teams.find(t => t.id === 'ska')!, A = r.teams.find(t => t.id === 'avangard')!;
type Ag = { id: string; side: 0 | 1; on: string; goalie: boolean; leave: null | 'bench' | 'box'; role: string; x: number; y: number; vx: number; vy: number };
type Probe = { agents: Map<string, Ag>; mode: string; baseSkaters: [number, number]; lastGoalie: [string | null, string | null]; puck: { carrier: Ag | null; x: number; y: number }; g: number; players: typeof r.players; stop: unknown };
const proto = RinkAI.prototype as unknown as { record: (this: Probe) => void };
const rec0 = proto.record;
const BENCH = [{ x: 24, y: 0.8 }, { x: 36, y: 0.8 }], BOX = [{ x: 27, y: 29.2 }, { x: 33, y: 29.2 }];
const d2 = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const st = { frames: 0, over: 0, under: 0, underLong: 0, underNoChange: 0, ppFrames: 0, ozN: 0, ozGap: 0, roleBad: 0, fwdAsD: 0, dAsFwd: 0, gapN: 0, gapSum: 0, goalSide: 0, defSpeedSum: 0, defSpeedN: 0, turnovers: 0, playSec: 0, stall: 0, holdSum: 0, holds: 0 };
let underRun = [0, 0], lastCarrier: Ag | null = null, holdStart = 0, stallRun = 0, lastAI: unknown = null, lastSide = -1;
proto.record = function (this: Probe) {
  rec0.call(this);
  if (lastAI !== this) { lastAI = this; lastCarrier = null; lastSide = -1; }
  if (this.mode !== 'play') { underRun = [0, 0]; return; }
  st.frames++; st.playSec += 0.1;
  for (const s of [0, 1] as const) {
    const all = [...this.agents.values()].filter(a => a.side === s && a.on === 'ice' && !a.goalie);
    const vis = all.filter(a => !a.leave || d2(a, a.leave === 'box' ? BOX[s] : BENCH[s]) > 3).length;
    const act = all.filter(a => !a.leave);
    const allowed = this.baseSkaters[s] + (this.lastGoalie[s] === null ? 1 : 0);
    if (vis > allowed) st.over++;
    if (act.length < this.baseSkaters[s]) { underRun[s]++; st.under++; if (underRun[s] === 30) st.underLong++; if (all.length === act.length) st.underNoChange++; } else underRun[s] = 0;
    if (this.baseSkaters[0] !== this.baseSkaters[1] || this.lastGoalie[0] === null || this.lastGoalie[1] === null) { st.ppFrames++; continue; }
    for (const a of act) {
      const pos = this.players[a.id]?.position;
      const dRole = a.role === 'LD' || a.role === 'RD';
      const T = s ? A : H, ppIds = [...T.lineup.pp1, ...T.lineup.pp2];
      if (dRole && pos !== 'D' && !act.every(b => ppIds.includes(b.id))) st.fwdAsD++;
      if (!dRole && pos === 'D' && act.filter(b => b.role === 'LD' || b.role === 'RD').length < 2) st.dAsFwd++;
    }
  }
  const c = this.puck.carrier;
  if (c !== lastCarrier) {
    if (lastCarrier) { st.holdSum += this.g - holdStart; st.holds++; }
    if (c && lastSide >= 0 && c.side !== lastSide) st.turnovers++;
    if (c) lastSide = c.side;
    holdStart = this.g; lastCarrier = c; stallRun = 0;
  }
  if (c) {
    const sp = Math.hypot(c.vx, c.vy);
    stallRun = sp < 1.5 ? stallRun + 1 : 0;
    if (stallRun > 20) st.stall++;
    const s = (1 - c.side) as 0 | 1;
    const net = s === 0 ? { x: 4, y: 15 } : { x: 56, y: 15 };
    const lxC = c.side === 0 ? c.x : 60 - c.x;
    const defs = [...this.agents.values()].filter(a => a.side === s && a.on === 'ice' && !a.goalie && !a.leave);
    if (lxC > 22 && lxC < 45 && defs.length) {
      const near = defs.reduce((p, q) => (d2(p, c) < d2(q, c) ? p : q));
      st.gapN++; st.gapSum += d2(near, c);
      if (d2(near, net) < d2(c, net)) st.goalSide++;
    }
    if (lxC > 37.2 && defs.length) { const near = defs.reduce((p, q) => (d2(p, c) < d2(q, c) ? p : q)); st.ozN++; st.ozGap += d2(near, c); }
    if (lxC > 30) for (const a of defs) { st.defSpeedSum += Math.hypot(a.vx, a.vy); st.defSpeedN++; }
  }
};
const games = Number(process.argv[2] ?? 4);
for (let g = 0; g < games; g++) {
  const sim = new GameSim(H, A, r.players);
  for (let k = 0; k < 3; k++) { const start = sim.sec, evs = sim.simPeriod(); new RinkAI(evs, H, A, r.players, start, sim.sec).runToEnd(); }
}
proto.record = rec0;
const pct = (n: number) => ((100 * n) / st.frames).toFixed(2) + '%';
console.log({
  playMin: (st.playSec / 60).toFixed(1),
  overAllowedFrames: pct(st.over), underFrames: pct(st.under), underLongRuns: st.underLong, underNoChange: pct(st.underNoChange),
  forwardInDRole: pct(st.fwdAsD), dInForwardRole: pct(st.dAsFwd),
  nzGapToCarrier: (st.gapSum / st.gapN).toFixed(2), nzGoalSide: ((100 * st.goalSide) / st.gapN).toFixed(1) + '%',
  dzPressure: (st.ozGap / st.ozN).toFixed(2),
  defSpeed: (st.defSpeedSum / st.defSpeedN).toFixed(2),
  turnoversPerMin: (st.turnovers / (st.playSec / 60)).toFixed(2), avgHold: (st.holdSum / st.holds).toFixed(2), stallFrames: pct(st.stall),
});
