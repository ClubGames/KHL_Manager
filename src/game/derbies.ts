import type { Team } from '../types';
import { LG } from '../brand';

export interface DerbyInfo {
  id: string;
  title: string;
  subtitle: string;
  /** 2 = regional derby, 3 = iconic league blockbuster */
  intensity: 2 | 3;
  /** bonus home ticket revenue in rubles */
  gateBonus: number;
  /** hit frequency multiplier */
  hitMult: number;
  /** penalty fire multiplier */
  penMult: number;
  /** morale & board swing multiplier */
  moraleMult: number;
}

interface DerbyRule {
  id: string;
  title: string;
  subtitle: string;
  intensity: 2 | 3;
  match: (a: Team, b: Team) => boolean;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е');
}

function isClub(t: Team, keys: string[]): boolean {
  const id = norm(t.id);
  const nm = norm(t.name);
  const ct = norm(t.city);
  return keys.some((k) => id === k || nm.includes(k) || ct.includes(k));
}

function pair(a: Team, b: Team, k1: string[], k2: string[]): boolean {
  return (isClub(a, k1) && isClub(b, k2)) || (isClub(b, k1) && isClub(a, k2));
}

const DERBY_RULES: DerbyRule[] = [
  {
    id: 'green',
    title: 'Зелёное дерби',
    subtitle: 'Казань против Уфы — главное противостояние Востока',
    intensity: 3,
    match: (a, b) => pair(a, b, ['akbars', 'ак барс', 'казань'], ['salavat', 'салават', 'уфа']),
  },
  {
    id: 'army',
    title: 'Армейское дерби',
    subtitle: `Битва двух армейских столиц ${LG()}`,
    intensity: 3,
    match: (a, b) => pair(a, b, ['cska', 'цска'], ['ska', 'санкт-петербург']) && !isClub(a, ['spartak', 'спартак']) && !isClub(b, ['spartak', 'спартак']),
  },
  {
    id: 'siberian',
    title: 'Сибирское дерби',
    subtitle: 'Новосибирск против Омска — битва за Сибирь',
    intensity: 3,
    match: (a, b) => pair(a, b, ['sibir', 'сибирь', 'новосибирск'], ['avangard', 'авангард', 'омск']),
  },
  {
    id: 'ural-classic',
    title: 'Уральское дерби',
    subtitle: 'Южноуральская классика Магнитогорска и Челябинска',
    intensity: 3,
    match: (a, b) => pair(a, b, ['metallurg', 'металлург', 'магнитогорск'], ['traktor', 'трактор', 'челябинск']),
  },
  {
    id: 'fareast',
    title: 'Дальневосточное дерби',
    subtitle: 'Хабаровск против Владивостока — битва за Тихий океан',
    intensity: 3,
    match: (a, b) => pair(a, b, ['amur', 'амур', 'хабаровск'], ['admiral', 'адмирал', 'владивосток']),
  },
  {
    id: 'moscow',
    title: 'Столичное дерби',
    subtitle: 'Принципиальная битва московских клубов',
    intensity: 3,
    match: (a, b) => a.id !== b.id && norm(a.city) === 'москва' && norm(b.city) === 'москва',
  },
  {
    id: 'ural-big',
    title: 'Большое уральское дерби',
    subtitle: 'Соперничество лидеров Урала',
    intensity: 2,
    match: (a, b) =>
      pair(a, b, ['avtomobilist', 'автомобилист', 'екатеринбург'], ['metallurg', 'металлург', 'трактор', 'traktor']),
  },
  {
    id: 'tatar',
    title: 'Татарстанское дерби',
    subtitle: 'Республиканское противостояние Казани и Нижнекамска',
    intensity: 2,
    match: (a, b) => pair(a, b, ['akbars', 'ак барс'], ['neftekhimik', 'нефтехимик', 'нижнекамск']),
  },
  {
    id: 'two-capitals',
    title: 'Дерби двух столиц',
    subtitle: 'Санкт-Петербург против Москвы',
    intensity: 2,
    match: (a, b) =>
      pair(a, b, ['ska', 'санкт-петербург'], ['spartak', 'спартак', 'dinamo-msk', 'динамо москва']),
  },
  {
    id: 'volga',
    title: 'Волжское дерби',
    subtitle: 'Противостояние клубов Поволжья',
    intensity: 2,
    match: (a, b) =>
      pair(a, b, ['torpedo', 'торпедо', 'нижний новгород'], ['lokomotiv', 'локомотив', 'lada', 'лада']) ||
      pair(a, b, ['lada', 'лада', 'тольятти'], ['akbars', 'ак барс']),
  },
];

export function getDerby(home: Team | undefined, away: Team | undefined): DerbyInfo | null {
  if (!home || !away || home.id === away.id) return null;
  for (const r of DERBY_RULES) {
    if (r.match(home, away)) {
      const top = r.intensity === 3;
      return {
        id: r.id,
        title: r.title,
        subtitle: r.subtitle,
        intensity: r.intensity,
        gateBonus: top ? 4_500_000 : 2_800_000,
        hitMult: top ? 1.38 : 1.24,
        penMult: top ? 1.12 : 1.07,
        moraleMult: top ? 1.8 : 1.45,
      };
    }
  }
  return null;
}

export function isFarEastClub(team: Team | undefined): boolean {
  if (!team) return false;
  return isClub(team, ['admiral', 'адмирал', 'владивосток', 'amur', 'амур', 'хабаровск', 'shanghai', 'шанхай', 'kunlun', 'куньлунь']);
}
