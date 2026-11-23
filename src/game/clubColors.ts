import type { Team } from '../types';

export interface ClubPalette {
  primaryColor: string;
  secondaryColor: string;
  /** Third signature color from the real club logo (bottom jersey/shield bar & dark-UI accent). */
  accentColor: string;
}

/**
 * Official current KHL club logo palettes (2025/26–2026/27 brand identities),
 * plus classic KHL clubs for custom/historical rosters.
 */
export const OFFICIAL_KHL_PALETTES: Record<string, ClubPalette> = {
  // === Current 22 KHL clubs ===
  avangard: {
    // Омский «Авангард» — ястреб: алый, золотой и чёрный
    primaryColor: '#C41E24',
    secondaryColor: '#FFE066',
    accentColor: '#141414',
  },
  avtomobilist: {
    // «Автомобилист» Екатеринбург — крылатая «А»: красно-бело-чёрные
    primaryColor: '#CE1126',
    secondaryColor: '#FFFFFF',
    accentColor: '#141414',
  },
  admiral: {
    // «Адмирал» Владивосток — якорь: глубокий морской тёмно-синий, золото и белый
    primaryColor: '#0C2340',
    secondaryColor: '#E0B85C',
    accentColor: '#FFFFFF',
  },
  akbars: {
    // «Ак Барс» Казань — снежный барс: зелёный, белый и красный
    primaryColor: '#00693E',
    secondaryColor: '#FFFFFF',
    accentColor: '#DA291C',
  },
  amur: {
    // «Амур» Хабаровск — амурский тигр: огненно-оранжевый, чёрный и белый
    primaryColor: '#F37021',
    secondaryColor: '#14181F',
    accentColor: '#FFFFFF',
  },
  barys: {
    // «Барыс» Астана — снежный барс: насыщенный синий, казахстанское золото и небесно-голубой
    primaryColor: '#0055A4',
    secondaryColor: '#FFD100',
    accentColor: '#00AEEF',
  },
  'dinamo-mn': {
    // «Динамо» Минск — зубр: антрацитово-чёрный, фирменный голубой циан и белый
    primaryColor: '#141B24',
    secondaryColor: '#00B5E2',
    accentColor: '#FFFFFF',
  },
  'dinamo-msk': {
    // «Динамо» Москва — классическая литера «Д»: динамовский синий и белый
    primaryColor: '#004B9B',
    secondaryColor: '#FFFFFF',
    accentColor: '#8BB8E8',
  },
  lada: {
    // «Лада» Тольятти — ладья: тёмно-синий, белый и серебристо-голубой
    primaryColor: '#003366',
    secondaryColor: '#FFFFFF',
    accentColor: '#6CA6CD',
  },
  lokomotiv: {
    // «Локомотив» Ярославль — крылатая «Л»: карминно-красный, белый и тёмно-синий
    primaryColor: '#B5121B',
    secondaryColor: '#FFFFFF',
    accentColor: '#002F6C',
  },
  'metallurg-mg': {
    // «Металлург» Магнитогорск — лис: магнитогорский синий, белый и красный
    primaryColor: '#003087',
    secondaryColor: '#FFFFFF',
    accentColor: '#E31E24',
  },
  neftekhimik: {
    // «Нефтехимик» Нижнекамск — волк: тёмно-синий, белый и красный
    primaryColor: '#0A2240',
    secondaryColor: '#FFFFFF',
    accentColor: '#E31E24',
  },
  salavat: {
    // «Салават Юлаев» Уфа — изумрудно-зелёный, белый и башкирский синий
    primaryColor: '#00873E',
    secondaryColor: '#FFFFFF',
    accentColor: '#005BBB',
  },
  ska: {
    // СКА Санкт-Петербург — армейский синий, белый и красный
    primaryColor: '#00468B',
    secondaryColor: '#FFFFFF',
    accentColor: '#E30613',
  },
  severstal: {
    // «Северсталь» Череповец — стальная искра: жёлто-золотой, чёрный и белый
    primaryColor: '#FFD100',
    secondaryColor: '#141414',
    accentColor: '#FFFFFF',
  },
  sibir: {
    // «Сибирь» Новосибирск — снежинка: глубокий сибирский синий, белый и морозно-голубой
    primaryColor: '#0B2D5C',
    secondaryColor: '#FFFFFF',
    accentColor: '#4AC1E8',
  },
  sochi: {
    // ХК «Сочи» — леопард: черноморский тёмно-синий, солнечно-жёлтый и бирюзовый
    primaryColor: '#092C5C',
    secondaryColor: '#FFD100',
    accentColor: '#00B2A9',
  },
  spartak: {
    // «Спартак» Москва — классический красно-белый ромб
    primaryColor: '#D50032',
    secondaryColor: '#FFFFFF',
    accentColor: '#FFFFFF',
  },
  torpedo: {
    // «Торпедо» Нижний Новгород — олень: нижегородский синий, белый и красный
    primaryColor: '#003882',
    secondaryColor: '#FFFFFF',
    accentColor: '#D52B1E',
  },
  traktor: {
    // «Трактор» Челябинск — белый медведь: графитово-чёрный, белый и красный акцент
    primaryColor: '#181B20',
    secondaryColor: '#FFFFFF',
    accentColor: '#E31E24',
  },
  cska: {
    // ЦСКА Москва — красная звезда на красно-синем щите: армейский красный, белый и синий
    primaryColor: '#CE1126',
    secondaryColor: '#FFFFFF',
    accentColor: '#0033A0',
  },
  'shanghai-dragons': {
    // «Шанхайские Драконы» — императорский багряный, золотой и нефритово-бирюзовый
    primaryColor: '#B80F28',
    secondaryColor: '#FFD100',
    accentColor: '#00A39B',
  },

  // === Additional / historical KHL clubs & alternate IDs ===
  vityaz: {
    primaryColor: '#D50032',
    secondaryColor: '#FFFFFF',
    accentColor: '#D4AF37',
  },
  kunlun: {
    primaryColor: '#C8102E',
    secondaryColor: '#FFD100',
    accentColor: '#141414',
  },
  'dynamo-riga': {
    primaryColor: '#7A1C24',
    secondaryColor: '#FFFFFF',
    accentColor: '#C5B358',
  },
};

const ALIAS_TO_KEY: Record<string, string> = {
  // Alternate slugs
  loko: 'lokomotiv',
  'dynamo-m': 'dinamo-msk',
  'dynamo-msk': 'dinamo-msk',
  'dynamo-minsk': 'dinamo-mn',
  metallurg: 'metallurg-mg',
  'ak-bars': 'akbars',
  shanghai: 'shanghai-dragons',
  'kunlun-red-star': 'kunlun',

  // Normalized Russian club names
  авангард: 'avangard',
  автомобилист: 'avtomobilist',
  адмирал: 'admiral',
  'ак барс': 'akbars',
  амур: 'amur',
  барыс: 'barys',
  'динамо минск': 'dinamo-mn',
  'динамо мн': 'dinamo-mn',
  'динамо москва': 'dinamo-msk',
  'динамо м': 'dinamo-msk',
  лада: 'lada',
  локомотив: 'lokomotiv',
  'металлург мг': 'metallurg-mg',
  'металлург магнитогорск': 'metallurg-mg',
  металлург: 'metallurg-mg',
  нефтехимик: 'neftekhimik',
  'салават юлаев': 'salavat',
  ска: 'ska',
  северсталь: 'severstal',
  сибирь: 'sibir',
  сочи: 'sochi',
  'хк сочи': 'sochi',
  спартак: 'spartak',
  'спартак москва': 'spartak',
  торпедо: 'torpedo',
  'торпедо нн': 'torpedo',
  трактор: 'traktor',
  цска: 'cska',
  'шанхайские драконы': 'shanghai-dragons',
  витязь: 'vityaz',
  'куньлунь ред стар': 'kunlun',
  'динамо рига': 'dynamo-riga',

  // Short codes
  ава: 'avangard',
  авт: 'avtomobilist',
  адм: 'admiral',
  акб: 'akbars',
  аму: 'amur',
  бар: 'barys',
  дмн: 'dinamo-mn',
  дм: 'dinamo-msk',
  лад: 'lada',
  лок: 'lokomotiv',
  ммг: 'metallurg-mg',
  неф: 'neftekhimik',
  сал: 'salavat',
  сев: 'severstal',
  сиб: 'sibir',
  соч: 'sochi',
  спа: 'spartak',
  тор: 'torpedo',
  тра: 'traktor',
  шхд: 'shanghai-dragons',
  шан: 'shanghai-dragons',
  вит: 'vityaz',
  крс: 'kunlun',
  дри: 'dynamo-riga',
};

function norm(s: string | undefined | null): string {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}

export function getOfficialClubPalette(ref: {
  id?: string;
  name?: string;
  short?: string;
}): ClubPalette | null {
  const byId = norm(ref.id);
  if (byId && OFFICIAL_KHL_PALETTES[byId]) return OFFICIAL_KHL_PALETTES[byId];
  if (byId && ALIAS_TO_KEY[byId]) return OFFICIAL_KHL_PALETTES[ALIAS_TO_KEY[byId]];

  const byName = norm(ref.name);
  if (byName && ALIAS_TO_KEY[byName]) return OFFICIAL_KHL_PALETTES[ALIAS_TO_KEY[byName]];

  const byShort = norm(ref.short);
  if (byShort && OFFICIAL_KHL_PALETTES[byShort]) return OFFICIAL_KHL_PALETTES[byShort];
  if (byShort && ALIAS_TO_KEY[byShort]) return OFFICIAL_KHL_PALETTES[ALIAS_TO_KEY[byShort]];

  return null;
}

export function hexLuminance(hex: string): number {
  const c = (hex || '').trim().replace('#', '');
  if (c.length !== 6) return 128;
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return 128;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Returns a club color guaranteed to be clearly visible against dark (#0b1420 / #07121e)
 * charts, shot maps, power-play diagrams, and ticker dots.
 */
export function visibleClubColor(
  team: Pick<Team, 'primaryColor' | 'secondaryColor'> & Partial<Pick<Team, 'id' | 'name' | 'short'>>,
  fallback = '#38BDF8',
): string {
  if (hexLuminance(team.primaryColor) >= 52) return team.primaryColor;
  const official = getOfficialClubPalette(team);
  if (official && hexLuminance(official.accentColor) >= 52 && official.accentColor.toUpperCase() !== '#FFFFFF') {
    return official.accentColor;
  }
  if (hexLuminance(team.secondaryColor) >= 52 && team.secondaryColor.toUpperCase() !== '#FFFFFF') {
    return team.secondaryColor;
  }
  if (official && hexLuminance(official.accentColor) >= 52) return official.accentColor;
  if (hexLuminance(team.secondaryColor) >= 52) return team.secondaryColor;
  return fallback;
}

/** Old placeholder hex colors shipped in earlier roster.json / generator builds. */
const LEGACY_PRIMARY_SET = new Set([
  '#D52B1E', '#D11F2F', '#003E7E', '#006B3F', '#00A0E3', '#0038A8', '#C8102E',
  '#D22630', '#E31E24', '#008752', '#003DA5', '#0A4FA3', '#FFD700', '#005A9C',
  '#000000', '#005BAA', '#1D5FB5', '#D42E2E', '#2A7FC1', '#1B7A4A', '#2E6DB4',
  '#1E8ED0', '#1D4F91', '#2A5DA8', '#0E4C9A', '#1E7A46', '#10254A', '#1F8A4C',
  '#2C73C4', '#1B5FB0', '#1E6FC2', '#1D8A4E', '#1C5BA8', '#2B6CB0', '#1F6FC2',
]);

/**
 * Upgrades pre-update placeholder colors in existing saves to official KHL logo colors,
 * while leaving custom user-defined club colors untouched.
 */
export function upgradeLegacyClubColors<
  T extends { id?: string; name?: string; short?: string; primaryColor: string; secondaryColor: string },
>(club: T): T {
  const official = getOfficialClubPalette(club);
  if (!official) return club;
  const curP = (club.primaryColor || '').trim().toUpperCase();
  if (!curP || LEGACY_PRIMARY_SET.has(curP)) {
    club.primaryColor = official.primaryColor;
    club.secondaryColor = official.secondaryColor;
  }
  return club;
}

