// The shootout's rules, shared by the engine's simulated series (GameSim.simSO) and the one played on the ice
// (PlayRink kind 'so'): `rounds` shooters a side taking turns (the home side first), stopped as soon as one side can no
// longer catch up; still level after them, one pair at a time until a round is won. KHL: three rounds, three different
// shooters; in the sudden death anybody may shoot again.

export type SoSide = 0 | 1;
/** One attempt of the series. */
export interface SoAttempt { side: SoSide; shooter: string; goalie: string | null; goal: boolean; round: number }

/** Goals of each side so far. */
export function soTally(att: readonly Pick<SoAttempt, 'side' | 'goal'>[]): [number, number] {
  const t: [number, number] = [0, 0];
  for (const a of att) if (a.goal) t[a.side]++;
  return t;
}

/** Who shoots next and in which round — or null: the series is decided. */
export function soNext(att: readonly Pick<SoAttempt, 'side' | 'goal'>[], first: SoSide = 0, rounds = 3): { side: SoSide; round: number } | null {
  const taken: [number, number] = [0, 0];
  for (const a of att) taken[a.side]++;
  const [g0, g1] = soTally(att);
  const second = (1 - first) as SoSide;
  const n = taken[0] + taken[1];
  if (n < 2 * rounds) {
    // the regular rounds: over as soon as the trailing side cannot catch up even scoring all it has left
    if (g0 > g1 + (rounds - taken[1]) || g1 > g0 + (rounds - taken[0])) return null;
    return { side: n % 2 === 0 ? first : second, round: Math.floor(n / 2) + 1 };
  }
  // sudden death: a round is played out in full (the second shooter may answer), then a leader wins
  if (taken[0] === taken[1]) return g0 !== g1 ? null : { side: first, round: taken[0] + 1 };
  return { side: taken[first] > taken[second] ? second : first, round: Math.max(taken[0], taken[1]) };
}

/** The shooter of `side` in `round`: the order's first `rounds` are different men, after that the list comes round again. */
export function soShooter(order: readonly string[], round: number): string | null {
  return order.length ? order[(round - 1) % order.length] : null;
}
