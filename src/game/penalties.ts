// The kinds of penalties of the KHL rule book (Section 10 and the summary table of the KHL rules: малый, малый
// скамеечный, двойной малый, большой — in the KHL with an automatic game misconduct for the dangerous fouls —,
// дисциплинарный, дисциплинарный до конца матча, матч-штраф, штрафной бросок) and the infractions they are given
// for, in the KHL's own wording. Shared by the season simulation (engine.ts) and the played match (playRink.ts).

export type PenKind = 'minor' | 'bench' | 'double' | 'major' | 'misconduct' | 'game' | 'match';
/** A call: its kind, the infraction, and what comes with it — a 10-minute misconduct (2+10) or the automatic game
 *  misconduct of a major (5 + ДдКМ). */
export interface PenaltyCall { kind: PenKind; reason: string; plus?: 'misconduct' | 'game' }

/** The kind's name in the KHL's wording. */
export const PEN_KIND_LABEL: Record<PenKind, string> = {
  minor: 'малый штраф', bench: 'малый скамеечный штраф', double: 'двойной малый штраф', major: 'большой штраф',
  misconduct: 'дисциплинарный штраф', game: 'дисциплинарный штраф до конца матча', match: 'матч-штраф',
};
/** Minutes the team plays short-handed (a misconduct leaves it at full strength; a match penalty: five minutes). */
export const SHORT_MIN: Record<PenKind, 0 | 2 | 4 | 5> = { minor: 2, bench: 2, double: 4, major: 5, misconduct: 0, game: 0, match: 5 };
/** Penalty minutes in the score sheet, KHL style: ДдКМ 20, match penalty 25. */
const PIM: Record<PenKind, number> = { minor: 2, bench: 2, double: 4, major: 5, misconduct: 10, game: 20, match: 25 };
/** "Game misconduct" is far too long a name for a score sheet: the KHL writes ДдКМ. */
export const GM_SHORT = 'ДдКМ';
/** A game second no match reaches: an ejected player's "end" of his penalty. */
export const EJECT_END = 1e7;

export function pimOf(c: Pick<PenaltyCall, 'kind' | 'plus'>): number {
  return PIM[c.kind] + (c.plus === 'misconduct' ? 10 : c.plus === 'game' ? 20 : 0);
}
/** He takes no further part in the match (ДдКМ, a match penalty, a major with its automatic ДдКМ). */
export function ejects(c: Pick<PenaltyCall, 'kind' | 'plus'>): boolean {
  return c.kind === 'game' || c.kind === 'match' || c.plus === 'game';
}
/** The length as the scoreboard puts it: "2 мин", "2+2 мин", "5 мин + ДдКМ", "2+10 мин", "10 мин", "ДдКМ", "матч-штраф". */
export function penLength(c: Pick<PenaltyCall, 'kind' | 'plus'>): string {
  const base = c.kind === 'double' ? '2+2' : c.kind === 'misconduct' ? '10' : String(SHORT_MIN[c.kind]);
  if (c.kind === 'game') return GM_SHORT;
  if (c.kind === 'match') return 'матч-штраф';
  if (c.plus === 'game') return `${base} мин + ${GM_SHORT}`;
  if (c.plus === 'misconduct') return `${base}+10 мин`;
  return `${base} мин`;
}
/** One line for the play-by-play: "Двойной малый штраф (2+2 мин): Иванов — игра высоко поднятой клюшкой". */
export function penHeadline(c: PenaltyCall): string {
  const head = c.kind === 'game' || c.kind === 'match' ? PEN_KIND_LABEL[c.kind] : `${PEN_KIND_LABEL[c.kind]} (${penLength(c)})`;
  return head[0].toUpperCase() + head.slice(1);
}

type Opt = [PenKind, PenaltyCall['plus'] | undefined, number];
/** An infraction: its weight among all calls (KHL seasons: trips, hooks and holds lead) and the kinds it may draw. */
interface Infraction { reason: string; w: number; kinds: Opt[]; /** a foul on a breakaway: may be a penalty shot instead */ breakaway?: boolean }

/** The KHL's calls for the season simulation, weighted roughly as in a KHL season. */
export const INFRACTIONS: Infraction[] = [
  { reason: 'подножка', w: 14, kinds: [['minor', undefined, 1]], breakaway: true },
  { reason: 'задержка клюшкой', w: 13, kinds: [['minor', undefined, 1]], breakaway: true },
  { reason: 'задержка соперника', w: 9, kinds: [['minor', undefined, 1]], breakaway: true },
  { reason: 'удар клюшкой', w: 8, kinds: [['minor', undefined, .93], ['major', 'game', .07]], breakaway: true },
  { reason: 'игра высоко поднятой клюшкой', w: 8, kinds: [['minor', undefined, .8], ['double', undefined, .18], ['major', 'game', .02]] },
  { reason: 'атака игрока, не владеющего шайбой', w: 7, kinds: [['minor', undefined, 1]] },
  { reason: 'грубость', w: 7, kinds: [['minor', undefined, .82], ['double', undefined, .08], ['minor', 'misconduct', .1]] },
  { reason: 'толчок клюшкой', w: 4, kinds: [['minor', undefined, .92], ['major', 'game', .08]] },
  { reason: 'выброс шайбы за пределы площадки', w: 3, kinds: [['minor', undefined, 1]] },
  { reason: 'задержка игры', w: 1.5, kinds: [['minor', undefined, 1]] },
  { reason: 'помеха вратарю', w: 2.5, kinds: [['minor', undefined, 1]] },
  { reason: 'неправильная атака', w: 2.5, kinds: [['minor', undefined, .85], ['major', 'game', .15]] },
  { reason: 'атака с разбега', w: 1.2, kinds: [['minor', undefined, .8], ['major', 'game', .2]] },
  { reason: 'толчок на борт', w: 2.5, kinds: [['minor', undefined, .75], ['major', 'game', .25]] },
  { reason: 'атака сзади', w: 1.2, kinds: [['minor', 'misconduct', .45], ['major', 'game', .5], ['match', undefined, .05]] },
  { reason: 'атака в голову или шею', w: 1.5, kinds: [['minor', undefined, .4], ['major', 'game', .55], ['match', undefined, .05]] },
  { reason: 'удар локтем', w: 1.2, kinds: [['minor', undefined, .8], ['major', 'game', .2]] },
  { reason: 'удар коленом', w: .6, kinds: [['minor', undefined, .8], ['major', 'game', .2]] },
  { reason: 'симуляция', w: 1.2, kinds: [['minor', undefined, 1]] },
  { reason: 'неспортивное поведение', w: 1.6, kinds: [['minor', undefined, .45], ['misconduct', undefined, .45], ['game', undefined, .1]] },
  { reason: 'оскорбление судей', w: .4, kinds: [['misconduct', undefined, .7], ['game', undefined, .3]] },
  { reason: 'колющий удар', w: .2, kinds: [['double', 'misconduct', .7], ['major', 'game', .3]] },
  { reason: 'удар концом клюшки', w: .15, kinds: [['double', 'misconduct', .7], ['major', 'game', .3]] },
  { reason: 'удар головой', w: .08, kinds: [['double', 'misconduct', .6], ['match', undefined, .4]] },
  { reason: 'удар ногой', w: .05, kinds: [['major', 'game', .5], ['match', undefined, .5]] },
  { reason: 'бросок клюшки', w: .25, kinds: [['minor', undefined, 1]] },
  { reason: 'отсечение', w: .3, kinds: [['minor', undefined, .8], ['major', 'game', .2]] },
  { reason: 'игра сломанной клюшкой', w: .5, kinds: [['minor', undefined, 1]] },
  // bench minors: served by a player the coach names
  { reason: 'нарушение численного состава', w: 2.6, kinds: [['bench', undefined, 1]] },
  { reason: 'задержка игры (скамейка)', w: .3, kinds: [['bench', undefined, 1]] },
  { reason: 'неспортивное поведение (скамейка)', w: .3, kinds: [['bench', undefined, 1]] },
];

/** One call drawn as in a KHL season (`rnd` 0…1). */
export function drawCall(rnd: () => number = Math.random): PenaltyCall & { breakaway: boolean } {
  const total = INFRACTIONS.reduce((s, x) => s + x.w, 0);
  let r = rnd() * total, inf = INFRACTIONS[0];
  for (const x of INFRACTIONS) { r -= x.w; if (r <= 0) { inf = x; break; } }
  let q = rnd(), opt = inf.kinds[0];
  for (const o of inf.kinds) { q -= o[2]; if (q <= 0) { opt = o; break; } }
  return { kind: opt[0], reason: inf.reason, ...(opt[1] ? { plus: opt[1] } : {}), breakaway: !!inf.breakaway };
}

/** KHL penalty shots end in a goal about a third of the time. */
export const PENALTY_SHOT_GOAL = 0.33;
