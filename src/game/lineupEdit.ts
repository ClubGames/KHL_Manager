// Lineup editing rules shared by the lines screen and its tests.
// Special teams are *copies* of dressed skaters: putting a player on the PP / PK never touches the 5-on-5 lines,
// a player can be on one PP unit and one PK unit at the same time, and moving inside a kind swaps the two slots.
import type { Lineup, Player } from '../types';
import { buildSpecialUnits } from './ai';

export type SpecialKind = 'pp' | 'pk';
export type SlotKind = 'ev' | SpecialKind;
export type SpecialUnit = 'pp1' | 'pp2' | 'pk1' | 'pk2';

export const SPECIAL_SIZE: Record<SpecialKind, number> = { pp: 5, pk: 4 };
export const unitsOf = (kind: SpecialKind): [SpecialUnit, SpecialUnit] => (kind === 'pp' ? ['pp1', 'pp2'] : ['pk1', 'pk2']);

export function cloneLineup(L: Lineup): Lineup {
  return {
    F: L.F.map((l) => [...l]),
    D: L.D.map((l) => [...l]),
    pp1: [...L.pp1],
    pp2: [...L.pp2],
    pk1: [...L.pk1],
    pk2: [...L.pk2],
    starterG: L.starterG,
    backupG: L.backupG,
    u20F: L.u20F ?? null,
    u20D: L.u20D ?? null,
  };
}

const pad = (ids: (string | null)[], n: number) => [...ids, ...Array(Math.max(0, n - ids.length)).fill(null)].slice(0, n) as (string | null)[];

/** Skaters dressed in the 5-on-5 lines (the only ones the engine sends out on special teams). */
export const dressedSkaters = (L: Lineup) => new Set([...L.F.flat(), ...L.D.flat()].filter((x): x is string => !!x));

/**
 * One player per slot in the even-strength lines + goalies + U20 slots; inside PP (both units) and inside PK
 * (both units) each player at most once. Special-team slots of players who are no longer dressed go to the player
 * who took their 5-on-5 spot (`prev` = the lineup before the edit), otherwise they are emptied.
 */
export function dedupeLineup(L: Lineup, prev?: Lineup) {
  const seen = new Set<string>();
  const unique = (ids: (string | null)[]) =>
    ids.map((id) => {
      if (!id || seen.has(id)) return null;
      seen.add(id);
      return id;
    });
  const even = unique([...L.F.flat(), ...L.D.flat(), L.starterG, L.backupG]);
  let n = 0;
  L.F = L.F.map((line) => line.map(() => even[n++] ?? null));
  L.D = L.D.map((line) => line.map(() => even[n++] ?? null));
  L.starterG = even[n++] ?? null;
  L.backupG = even[n++] ?? null;
  if (L.u20F && seen.has(L.u20F)) L.u20F = null;
  else if (L.u20F) seen.add(L.u20F);
  if (L.u20D && seen.has(L.u20D)) L.u20D = null;
  else if (L.u20D) seen.add(L.u20D);

  const dressed = dressedSkaters(L);
  // A skater who left the lines hands his PP / PK slots to whoever took his 5-on-5 spot (when known).
  const successor = (id: string): string | null => {
    if (!prev) return null;
    for (const k of ['F', 'D'] as const)
      for (let i = 0; i < prev[k].length; i++) {
        const j = prev[k][i].indexOf(id);
        if (j >= 0) return L[k][i]?.[j] ?? null;
      }
    return null;
  };
  for (const kind of ['pp', 'pk'] as const) {
    const all = unitsOf(kind).flatMap((u) => L[u]);
    const sp = new Set<string>();
    for (const u of unitsOf(kind)) {
      L[u] = pad(L[u], SPECIAL_SIZE[kind]).map((id) => {
        if (id && !dressed.has(id)) {
          const next = successor(id);
          id = next && dressed.has(next) && !all.includes(next) ? next : null;
        }
        if (!id || sp.has(id)) return null;
        sp.add(id);
        return id;
      });
    }
  }
}

/** Where a player sits on the PP / PK (first match), e.g. { unit: 'pp2', idx: 3 }. */
export function findSpecial(L: Lineup, kind: SpecialKind, id: string): { unit: SpecialUnit; idx: number } | null {
  for (const unit of unitsOf(kind)) {
    const idx = L[unit].indexOf(id);
    if (idx >= 0) return { unit, idx };
  }
  return null;
}

/**
 * Put `id` into a special-team slot. If he already plays in another slot of the same kind, the two slots swap;
 * the 5-on-5 lines, goalies and the other kind are never touched.
 */
export function assignSpecial(L: Lineup, unit: SpecialUnit, idx: number, id: string | null) {
  const kind: SpecialKind = unit.startsWith('pp') ? 'pp' : 'pk';
  for (const u of unitsOf(kind)) L[u] = pad(L[u], SPECIAL_SIZE[kind]);
  const cur = L[unit][idx] ?? null;
  if (id) {
    const at = findSpecial(L, kind, id);
    if (at && !(at.unit === unit && at.idx === idx)) L[at.unit][at.idx] = cur;
  }
  L[unit][idx] = id;
}

/** Rebuild the PP and/or PK units from the dressed skaters (the AI logic), keeping the 5-on-5 lines as they are. */
export function autoSpecialTeams(L: Lineup, P: Record<string, Player>, kind?: SpecialKind) {
  const u = buildSpecialUnits(L, P);
  if (kind !== 'pk') { L.pp1 = u.pp1; L.pp2 = u.pp2; }
  if (kind !== 'pp') { L.pk1 = u.pk1; L.pk2 = u.pk2; }
}

/** Which line a dressed skater plays on at 5-on-5, e.g. "2-е звено" / "1-я пара". */
export function evenStrengthSpot(L: Lineup, id: string): string | null {
  for (let i = 0; i < L.F.length; i++) if (L.F[i].includes(id)) return `${i + 1}-е звено`;
  for (let i = 0; i < L.D.length; i++) if (L.D[i].includes(id)) return `${i + 1}-я пара`;
  return null;
}
