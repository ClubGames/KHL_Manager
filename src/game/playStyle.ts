import type { Player } from '../types';

/**
 * A skater's way of playing, read off his skills (and size): it shapes how he skates and carries the stick in 3D
 * (skateGait.ts → playerModel.ts) and which dekes and shots are his own in the played match (playRink.ts).
 */
export type Archetype = 'sniper' | 'dangler' | 'power' | 'speed' | 'twoWay' | 'stayHome' | 'offD';

export const ARCH_NAME: Record<Archetype, string> = {
  sniper: 'Снайпер', dangler: 'Технарь', power: 'Силовой форвард', speed: 'Скоростной', twoWay: 'Универсал',
  stayHome: 'Защитник-домосед', offD: 'Атакующий защитник',
};

type StyleSource = Pick<Player, 'position' | 'skills'> & Partial<Pick<Player, 'height' | 'weight' | 'overall'>>;

/** His archetype: whatever stands out most against his own average (a forward with nothing that stands out: a two-way man). */
export function archetypeOf(p?: StyleSource | null): Archetype {
  if (!p || p.position === 'G') return 'twoWay';
  const s = p.skills ?? {}, v = (x: number | undefined, d = 62) => x ?? d;
  const skate = v(s.skating), shoot = v(s.shooting), hands = v(s.puckControl, v(s.puckHandling)), check = v(s.checking), def = v(s.defense), pass = v(s.passing);
  // (a big man plays bigger: up to +4 on the physical side from height and weight)
  const size = Math.max(0, Math.min(4, ((p.height ?? 185) - 185) * 0.2 + ((p.weight ?? 88) - 88) * 0.12));
  if (p.position === 'D') {
    // (a defenceman's defending skills run some 8 points above his attacking ones: measured against that)
    const lean = (skate + hands + shoot + pass) / 4 - (def + check + size) / 2 + 8;
    return lean > 3.5 ? 'offD' : lean < -2.5 ? 'stayHome' : 'twoWay';
  }
  const mean = (skate + shoot + hands + check + def + pass) / 6;
  // (against how a forward's skills usually lie: shooting a few points above his average, checking a few below)
  const cand: [Archetype, number][] = [['sniper', shoot - mean - 3], ['dangler', hands - mean - 0.5], ['speed', skate - mean - 0.5], ['power', check + size - mean + 3.5]];
  const best = cand.reduce((b, c) => (c[1] > b[1] ? c : b));
  return best[1] > 2 ? best[0] : 'twoWay';
}

/** How strongly his style shows: a star (85+) all the way, an ordinary man (72 and under) only a hint of it. */
export const starOf = (p?: { overall?: number } | null) => Math.max(0, Math.min(1, ((p?.overall ?? 70) - 72) / 13));
