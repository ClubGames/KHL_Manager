import type { Lineup, Player, Team } from '../types';

export const DEFAULT_FOREIGN_LIMIT = 5;

/** Citizens of Russia and EAEU countries are not counted as legionnaires in Russian KHL clubs. */
const EAEU_COUNTRIES = new Set([
  '',
  '-',
  '—',
  'россия',
  'рф',
  'rus',
  'russia',
  'беларусь',
  'белоруссия',
  'blr',
  'belarus',
  'казахстан',
  'kaz',
  'kazakhstan',
  'армения',
  'arm',
  'armenia',
  'кыргызстан',
  'киргизия',
  'kgz',
  'kyrgyzstan',
]);

/** Non-Russian KHL clubs are not bound by the Russian Ministry of Sport 5-legionnaire cap. */
const FOREIGN_CLUB_CITIES = [
  'минск',
  'minsk',
  'астана',
  'astana',
  'нур-султан',
  'алматы',
  'шанхай',
  'shanghai',
  'пекин',
  'beijing',
  'рига',
  'riga',
  'хельсинки',
  'helsinki',
  'братислава',
  'прага',
  'загреб',
  'таллин',
  'ташкент',
];

const FOREIGN_CLUB_IDS = new Set([
  'barys',
  'dinamo-mn',
  'dynamo-minsk',
  'dynamo-riga',
  'kunlun',
  'shanghai-dragons',
  'zubry',
]);

const COUNTRY_SHORT: Record<string, string> = {
  канада: 'КАН',
  canada: 'КАН',
  can: 'КАН',
  сша: 'США',
  usa: 'США',
  швеция: 'ШВЕ',
  sweden: 'ШВЕ',
  swe: 'ШВЕ',
  финляндия: 'ФИН',
  finland: 'ФИН',
  fin: 'ФИН',
  чехия: 'ЧЕХ',
  czechia: 'ЧЕХ',
  cze: 'ЧЕХ',
  словакия: 'СВК',
  slovakia: 'СВК',
  svk: 'СВК',
  франция: 'ФРА',
  france: 'ФРА',
  нидерланды: 'НИД',
  китай: 'КИТ',
  china: 'КИТ',
  германия: 'ГЕР',
  латвия: 'ЛАТ',
  швейцария: 'ШВЦ',
  россия: 'РОС',
  беларусь: 'БЕЛ',
  казахстан: 'КАЗ',
};

export function isLegionnaire(p: Pick<Player, 'country'> | null | undefined): boolean {
  if (!p) return false;
  const c = String(p.country ?? '').trim().toLowerCase();
  return !EAEU_COUNTRIES.has(c);
}

export function countryCode(country: string | undefined): string {
  const raw = String(country ?? '').trim();
  if (!raw || raw === '—' || raw === '-') return '—';
  const low = raw.toLowerCase();
  return COUNTRY_SHORT[low] ?? raw.slice(0, 3).toUpperCase();
}

/**
 * Maximum number of legionnaires allowed for this club, or `null` if the club is a non-Russian KHL member
 * exempt from the Russian legionnaire limit.
 */
export function teamForeignLimit(
  team: Pick<Team, 'id' | 'city' | 'name'> | null | undefined,
  leagueLimit = DEFAULT_FOREIGN_LIMIT
): number | null {
  if (!team) return leagueLimit;
  if (FOREIGN_CLUB_IDS.has(team.id.toLowerCase())) return null;
  const city = String(team.city ?? '').trim().toLowerCase();
  const name = String(team.name ?? '').trim().toLowerCase();
  if (FOREIGN_CLUB_CITIES.some((x) => city.includes(x) || name.includes(x))) return null;
  return leagueLimit;
}

export function countRosterLegionnaires(ids: string[], P: Record<string, Player>): number {
  let n = 0;
  for (const id of ids) {
    const p = P[id];
    if (p && !p.inVhl && !p.inLtir && isLegionnaire(p)) n++;
  }
  return n;
}

export function dressedPlayerIds(L: Lineup): string[] {
  const seen = new Set<string>();
  for (const id of [...L.F.flat(), ...L.D.flat(), L.starterG, L.backupG]) {
    if (id) seen.add(id);
  }
  return [...seen];
}

export function countLineupLegionnaires(L: Lineup, P: Record<string, Player>): number {
  return countRosterLegionnaires(dressedPlayerIds(L), P);
}
