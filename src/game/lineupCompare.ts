import type { GameState, Lineup, Player } from '../types';
import { autoLineup, lineupConstraintsFor, sanitizeLineup } from './ai';
import { clamp, goalieSavePct, isGoalie, lineAttack, lineDefense, mean, pairAttack, pairDefense, unitAttack, unitDefense } from './ratings';

export interface PPSlotPreview {
  player: Player | null;
  role: string;
  /** offensive half-rink coordinates (x: 0..100 from blue line to goal line, y: 0..100 across width) */
  rx: number;
  ry: number;
  autoFilled: boolean;
  replacedNote?: string;
  oneTimerOptimal?: boolean;
}

export interface PPUnitPreview {
  unitNumber: 1 | 2;
  sharePct: number;
  slots: PPSlotPreview[];
  attack: number;
  shooting: number;
  passing: number;
  expectedPpPct: number;
  oneTimers: number;
}

export interface LineComparisonRow {
  label: string;
  shareLabel?: string;
  leftIds: (string | null)[];
  rightIds: (string | null)[];
  leftAtt: number;
  leftDef: number;
  leftOvr: number;
  leftMorale: number;
  rightAtt: number;
  rightDef: number;
  rightOvr: number;
  rightMorale: number;
  /** positive = advantage left team */
  edge: number;
}

export interface LineupComparison {
  leftTeamId: string;
  rightTeamId: string;
  leftLineup: Lineup;
  rightLineup: Lineup;
  forwards: LineComparisonRow[];
  defense: LineComparisonRow[];
  ppUnitsLeft: [PPUnitPreview, PPUnitPreview];
  ppUnitsRight: [PPUnitPreview, PPUnitPreview];
  pkLeftDef: [number, number];
  pkRightDef: [number, number];
  goalieLeft: Player | null;
  goalieRight: Player | null;
  goalieEdge: number;
  totalEdge: number;
}

const PP_FORMATION: { role: string; rx: number; ry: number; idealHand?: 'L' | 'R' }[] = [
  { role: 'Левый круг · Бросок сходу', rx: 64, ry: 22, idealHand: 'R' },
  { role: 'Правый круг · Диспетчер', rx: 64, ry: 78, idealHand: 'L' },
  { role: 'Пятак · Трафик и добивание', rx: 83, ry: 50 },
  { role: 'Синяя линия · Разыгрывающий З', rx: 28, ry: 50 },
  { role: 'Слот / Бампер', rx: 56, ry: 50 },
];

function effectiveUnitIds(sanitized: Lineup, kind: 'pp1' | 'pp2', P: Record<string, Player>): (string | null)[] {
  const chosen = kind === 'pp1' ? sanitized.pp1 : sanitized.pp2;
  const out: (string | null)[] = [];
  for (const id of chosen) {
    if (id && P[id] && !isGoalie(P[id]) && !out.includes(id)) out.push(id);
  }
  const fb = [...(sanitized.F[0] ?? []), ...(sanitized.F[1] ?? []), ...(sanitized.D[0] ?? []), ...(sanitized.D[1] ?? []), ...(sanitized.F[2] ?? [])];
  for (const id of fb) {
    if (out.length >= 5) break;
    if (id && P[id] && !isGoalie(P[id]) && !out.includes(id)) out.push(id);
  }
  while (out.length < 5) out.push(null);
  return out;
}

function buildPPUnit(
  unitNumber: 1 | 2,
  rawIds: (string | null)[],
  effIds: (string | null)[],
  P: Record<string, Player>,
  suspended: Set<string>,
  oppPkDef: number,
  oppGoalieOvr: number
): PPUnitPreview {
  const rawClean = rawIds.filter((x): x is string => !!x);
  // Arrange the 5 skaters into tactical 1-3-1 slots: shooter, playmaker, net-front, point QB, bumper
  const players = effIds.map((id) => (id ? P[id] ?? null : null));
  const valid = players.filter((p): p is Player => !!p);
  const pointD = [...valid].sort((a, b) => (b.position === 'D' ? 20 : 0) + (b.skills.passing ?? 65) - ((a.position === 'D' ? 20 : 0) + (a.skills.passing ?? 65)))[0] ?? null;
  const rest1 = valid.filter((p) => p.id !== pointD?.id);
  const flankShooter = [...rest1].sort((a, b) => (b.skills.shooting ?? 65) + (b.hand === 'R' ? 4 : 0) - ((a.skills.shooting ?? 65) + (a.hand === 'R' ? 4 : 0)))[0] ?? null;
  const rest2 = rest1.filter((p) => p.id !== flankShooter?.id);
  const playmaker = [...rest2].sort((a, b) => (b.skills.passing ?? 65) + (b.hand === 'L' ? 4 : 0) - ((a.skills.passing ?? 65) + (a.hand === 'L' ? 4 : 0)))[0] ?? null;
  const rest3 = rest2.filter((p) => p.id !== playmaker?.id);
  const netFront = [...rest3].sort((a, b) => (b.skills.checking ?? 65) + b.weight * 0.3 - ((a.skills.checking ?? 65) + a.weight * 0.3))[0] ?? null;
  const bumper = rest3.find((p) => p.id !== netFront?.id) ?? null;
  const ordered: (Player | null)[] = [flankShooter, playmaker, netFront, pointD, bumper];

  // Identify any configured player who had to be replaced
  const missingReasons: string[] = [];
  for (const rid of rawClean) {
    if (!effIds.includes(rid) && P[rid]) {
      const rp = P[rid];
      if (rp.injury) missingReasons.push(`${rp.name} (травма)`);
      else if (suspended.has(rid)) missingReasons.push(`${rp.name} (блок потолка)`);
      else missingReasons.push(`${rp.name} (вне заявки)`);
    }
  }

  let oneTimers = 0;
  const slots: PPSlotPreview[] = PP_FORMATION.map((f, idx) => {
    const pl = ordered[idx] ?? null;
    const autoFilled = !!pl && !rawClean.includes(pl.id);
    const oneTimerOptimal = !!pl && !!f.idealHand && pl.hand === f.idealHand;
    if (oneTimerOptimal) oneTimers++;
    return {
      player: pl,
      role: f.role,
      rx: f.rx,
      ry: f.ry,
      autoFilled,
      replacedNote: autoFilled && missingReasons.length ? `вместо: ${missingReasons[0]}` : autoFilled ? 'автодобор из основы' : undefined,
      oneTimerOptimal,
    };
  });

  const att = Math.round(unitAttack(effIds, 5, P));
  const shooting = valid.length ? Math.round(mean(valid.map((p) => p.skills.shooting ?? 65))) : 50;
  const passing = valid.length ? Math.round(mean(valid.map((p) => p.skills.passing ?? 65))) : 50;
  const goalieFactor = (oppGoalieOvr - 77) * 0.35;
  const expectedPpPct = clamp(+(20.0 + (att - oppPkDef) * 0.42 + oneTimers * 0.8 - goalieFactor).toFixed(1), 8.5, 36.0);

  return {
    unitNumber,
    sharePct: unitNumber === 1 ? 58 : 42,
    slots,
    attack: att,
    shooting,
    passing,
    expectedPpPct,
    oneTimers,
  };
}

export function previewPowerPlay(
  state: GameState,
  teamId: string,
  oppTeamId?: string,
  overrideLineup?: Lineup
): [PPUnitPreview, PPUnitPreview] {
  const P = state.players;
  const team = state.teams[teamId];
  const opts = lineupConstraintsFor(state, teamId);
  const raw = overrideLineup ?? team.lineup;
  const san = teamId === state.userTeamId || overrideLineup
    ? sanitizeLineup(raw, team.players, P, opts)
    : autoLineup(team.players, P, opts);

  let oppPk1 = 74;
  let oppPk2 = 71;
  let oppGoalieOvr = 78;
  if (oppTeamId && state.teams[oppTeamId]) {
    const opp = state.teams[oppTeamId];
    const oppOpts = lineupConstraintsFor(state, oppTeamId);
    const oppL = oppTeamId === state.userTeamId
      ? sanitizeLineup(opp.lineup, opp.players, P, oppOpts)
      : autoLineup(opp.players, P, oppOpts);
    oppPk1 = unitDefense(oppL.pk1, 4, P);
    oppPk2 = unitDefense(oppL.pk2, 4, P);
    oppGoalieOvr = oppL.starterG && P[oppL.starterG] ? P[oppL.starterG].overall : 75;
  }

  const eff1 = effectiveUnitIds(san, 'pp1', P);
  const eff2 = effectiveUnitIds(san, 'pp2', P);
  const susp = opts.excluded ?? new Set<string>();
  return [
    buildPPUnit(1, raw.pp1, eff1, P, susp, oppPk1, oppGoalieOvr),
    buildPPUnit(2, raw.pp2, eff2, P, susp, oppPk2, oppGoalieOvr),
  ];
}

function rowStats(ids: (string | null)[], n: number, isPair: boolean, P: Record<string, Player>) {
  const ps = ids.slice(0, n).map((id) => (id ? P[id] ?? null : null)).filter((p): p is Player => !!p);
  const att = isPair ? pairAttack(ids, P) : lineAttack(ids, P);
  const def = isPair ? pairDefense(ids, P) : lineDefense(ids, P);
  const ovr = ps.length ? Math.round(mean(ps.map((p) => p.overall))) : 50;
  const morale = ps.length ? Math.round(mean(ps.map((p) => p.morale))) : 70;
  return { att: Math.round(att), def: Math.round(def), ovr, morale };
}

export function compareTeamLineups(
  state: GameState,
  leftTeamId: string,
  rightTeamId: string,
  overrideLeftLineup?: Lineup
): LineupComparison {
  const P = state.players;
  const lt = state.teams[leftTeamId];
  const rt = state.teams[rightTeamId];
  const lOpts = lineupConstraintsFor(state, leftTeamId);
  const rOpts = lineupConstraintsFor(state, rightTeamId);

  const leftLineup = leftTeamId === state.userTeamId || overrideLeftLineup
    ? sanitizeLineup(overrideLeftLineup ?? lt.lineup, lt.players, P, lOpts)
    : autoLineup(lt.players, P, lOpts);
  const rightLineup = rightTeamId === state.userTeamId
    ? sanitizeLineup(rt.lineup, rt.players, P, rOpts)
    : autoLineup(rt.players, P, rOpts);

  const shares = ['~33% льда', '~27% льда', '~22% льда', '~18% льда'];
  const fWeights = [0.33, 0.27, 0.22, 0.18];
  const forwards: LineComparisonRow[] = [0, 1, 2, 3].map((i) => {
    const l = rowStats(leftLineup.F[i] ?? [], 3, false, P);
    const r = rowStats(rightLineup.F[i] ?? [], 3, false, P);
    const edge = +(0.6 * (l.att - r.att) + 0.4 * (l.def - r.def)).toFixed(1);
    return {
      label: `${i + 1}-е звено`,
      shareLabel: shares[i],
      leftIds: leftLineup.F[i] ?? [null, null, null],
      rightIds: rightLineup.F[i] ?? [null, null, null],
      leftAtt: l.att,
      leftDef: l.def,
      leftOvr: l.ovr,
      leftMorale: l.morale,
      rightAtt: r.att,
      rightDef: r.def,
      rightOvr: r.ovr,
      rightMorale: r.morale,
      edge,
    };
  });

  const dShares = ['~40% льда', '~34% льда', '~26% льда'];
  const dWeights = [0.4, 0.34, 0.26];
  const defense: LineComparisonRow[] = [0, 1, 2].map((i) => {
    const l = rowStats(leftLineup.D[i] ?? [], 2, true, P);
    const r = rowStats(rightLineup.D[i] ?? [], 2, true, P);
    const edge = +(0.4 * (l.att - r.att) + 0.6 * (l.def - r.def)).toFixed(1);
    return {
      label: `${i + 1}-я пара`,
      shareLabel: dShares[i],
      leftIds: leftLineup.D[i] ?? [null, null],
      rightIds: rightLineup.D[i] ?? [null, null],
      leftAtt: l.att,
      leftDef: l.def,
      leftOvr: l.ovr,
      leftMorale: l.morale,
      rightAtt: r.att,
      rightDef: r.def,
      rightOvr: r.ovr,
      rightMorale: r.morale,
      edge,
    };
  });

  const ppUnitsLeft = previewPowerPlay(state, leftTeamId, rightTeamId, overrideLeftLineup);
  const ppUnitsRight = previewPowerPlay(state, rightTeamId, leftTeamId);
  const pkLeftDef: [number, number] = [Math.round(unitDefense(leftLineup.pk1, 4, P)), Math.round(unitDefense(leftLineup.pk2, 4, P))];
  const pkRightDef: [number, number] = [Math.round(unitDefense(rightLineup.pk1, 4, P)), Math.round(unitDefense(rightLineup.pk2, 4, P))];

  const goalieLeft = leftLineup.starterG ? P[leftLineup.starterG] ?? null : null;
  const goalieRight = rightLineup.starterG ? P[rightLineup.starterG] ?? null : null;
  const glOvr = goalieLeft?.overall ?? 55;
  const grOvr = goalieRight?.overall ?? 55;
  const goalieEdge = +((goalieSavePct(glOvr) - goalieSavePct(grOvr)) * 450).toFixed(1);

  const fEdge = forwards.reduce((s, r, i) => s + r.edge * fWeights[i], 0);
  const dEdge = defense.reduce((s, r, i) => s + r.edge * dWeights[i], 0);
  const stEdge = (ppUnitsLeft[0].expectedPpPct - ppUnitsRight[0].expectedPpPct) * 0.25;
  const totalEdge = +(fEdge * 0.45 + dEdge * 0.3 + goalieEdge * 0.2 + stEdge * 0.05).toFixed(1);

  return {
    leftTeamId,
    rightTeamId,
    leftLineup,
    rightLineup,
    forwards,
    defense,
    ppUnitsLeft,
    ppUnitsRight,
    pkLeftDef,
    pkRightDef,
    goalieLeft,
    goalieRight,
    goalieEdge,
    totalEdge,
  };
}
