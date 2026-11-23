import type { Coach, CoachProfile, CoachRole } from '../types';

// Verified reference snapshot for 2026/27 as of 23 November 2026; not a live feed.
// Names/appointments are sourced; attributes, specialisations and pay are game design.
export const STAFF_SNAPSHOT = '2026/27 · 23.11.2026';
export const COACH_PROFILES: Record<CoachProfile, { label: string; attack: number; defense: number; special: number; development: number; motivation: number }> = {
  balanced: { label: 'Системный', attack: 72, defense: 72, special: 72, development: 72, motivation: 72 },
  attack: { label: 'Атакующий', attack: 88, defense: 60, special: 80, development: 65, motivation: 67 },
  defense: { label: 'Оборонительный', attack: 60, defense: 88, special: 80, development: 65, motivation: 67 },
  development: { label: 'Наставник', attack: 66, defense: 66, special: 65, development: 92, motivation: 78 },
  motivator: { label: 'Мотиватор', attack: 68, defense: 68, special: 65, development: 68, motivation: 92 },
};
export const COACH_ROLE_LABEL: Record<CoachRole, string> = { head: 'Главный тренер', assistant: 'Ассистент' };

// One head and one representative assistant per club; not an exhaustive real-life staff list.
export const REAL_STAFF: Record<string, [head: string, assistant: string, source: string, headSource?: string]> = {
  'avangard': ['Ги Буше', 'Дэйв Барр', 'https://www.hawk.ru/news/55558/'],
  'avtomobilist': ['Алексей Кудашов', 'Андрей Скопинцев', 'https://sport24.ru/hockey/news-866089-obyavlen-trenerskiy-shtab-kudashova-v-avtomobiliste'],
  'admiral': ['Олег Браташ', 'Дмитрий Кокорев', 'https://www.championat.com/hockey/news-6502256-admiral-predstavil-trenerskij-shtab-na-sezon-2026-2027.html'],
  'akbars': ['Анвар Гатиятулин', 'Александр Макрицкий', 'https://www.ak-bars.ru/uploads/843/programs/pdf/19be8d85d0d301b7b7326dfeb5e33386.pdf'],
  'amur': ['Александр Андриевский', 'Павел Десятков', 'https://hcamur.ru/coaches/amur/'],
  'barys': ['Михаил Кравец', 'Талгат Жайлауов', 'https://ru.hcbarys.kz/team/trainers/'],
  'dinamo-mn': ['Сергей Брылин', 'Андрей Ковалёв', 'https://hcdinamo.by/team/staff/'],
  'dinamo-msk': ['Олег Ореховский', 'Геннадий Столяров', 'https://dynamo.ru/coach'],
  'lada': ['Игорь Горбенко', 'Владимир Чебатуркин', 'https://belarushockey.com/khl/news/2026/06/08/dva-byvshih-trenera-minskogo-dinamo-voshli-v-trenerskij-shtab-lady/', 'https://www.sport-interfax.ru/1126573'],
  'lokomotiv': ['Дмитрий Квартальнов', 'Юрий Бабенко', 'https://metaratings.ru/news/lokomotiv-predstavil-trenerskij-shtab-na-sezon-2026-27-vo-glave-s-kvartalnovym-640908/'],
  'metallurg-mg': ['Константин Шафранов', 'Александр Завьялов', 'https://metaratings.ru/news/zavyalov-voshel-v-trenerskiy-shtab-metallurga-665460/'],
  'neftekhimik': ['Игорь Гришин', 'Алексей Пепеляев', 'https://metaratings.ru/news/stal-izvesten-trenerskii-shtab-neftekhimika-na-sezon-kkhl-2026-2027-636003/'],
  'salavat': ['Виктор Козлов', 'Николай Цулыгин', 'https://www.tatar-inform.ru/news/salavat-yulaev-obyavil-trenerskii-stab-na-sezon20262027-6035783'],
  'ska': ['Андрей Разин', 'Владимир Воробьёв', 'https://saint-petersburg.ru/news/2026/11/21/53269'],
  'severstal': ['Андрей Козырев', 'Евгений Ставровский', 'https://severstalclub.ru/coaches-staff/'],
  'sibir': ['Ярослав Люзенков', 'Алексей Кривченков', 'https://www.championat.com/hockey/news-6500794-sibir-predstavila-trenerskij-shtab-na-sezon-2026-2027.html'],
  'sochi': ['Андрей Миронов', 'Алексей Ковалёв', 'https://metaratings.ru/news/sformirovan-novyi-trenerskii-shtab-kluba-kkhl-sochi-na-sezon-2026-2027-639578/'],
  'spartak': ['Алексей Жамнов', 'Евгений Корешков', 'https://www.championat.com/hockey/news-6500148-hk-spartak-predstavil-trenerskij-shtab-na-sezon-2026-2027-khl.html'],
  'torpedo': ['Алексей Исаков', 'Дмитрий Гоголев', 'https://hctorpedo.ru/coaches/'],
  'traktor': ['Скотт Гордон', 'Брэндон Деннис', 'https://hctraktor.org/media/news/90983-trenerskiy-shtab-traktora-2026-2027/'],
  'cska': ['Игорь Никитин', 'Дмитрий Юшкевич', 'https://cska-hockey.ru/news/general/predstavlyaem_trenerskiy_shtab/'],
  'shanghai-dragons': ['Митч Лав', 'Вячеслав Козлов', 'https://www.championat.com/hockey/news-6562158-shanhajskie-drakony-predstavili-trenerskij-shtab-na-sezon-2026-2027.html'],
};

export function makeCoach(id: string, name: string, role: CoachRole, profile: CoachProfile, source?: string): Coach {
  return { id, name, role, profile, ...COACH_PROFILES[profile], salary: role === 'head' ? 18_000_000 : 8_000_000, fictional: !source, ...(source ? { source, snapshot: STAFF_SNAPSHOT } : {}) };
}

export function defaultStaff(clubId: string): Coach[] {
  const real = REAL_STAFF[clubId];
  const profiles = Object.keys(COACH_PROFILES) as CoachProfile[];
  const index = Math.max(0, Object.keys(REAL_STAFF).indexOf(clubId));
  return (['head', 'assistant'] as const).map((role, i) => makeCoach(
    `${clubId}-${role}`, real?.[i] ?? (i ? 'Клубный ассистент' : 'Клубный тренер'), role,
    profiles[(index + i * 2) % profiles.length], role === 'head' ? real?.[3] ?? real?.[2] : real?.[2]
  )).map((c) => clubId === 'dinamo-msk' && c.role === 'head' ? { ...c, acting: true } : c);
}

export function defaultCoachMarket(): Coach[] {
  const names = ['Артём Ветров', 'Михаил Северин', 'Олег Ледов', 'Денис Берегов', 'Павел Зорин', 'Роман Озеров', 'Никита Речной', 'Илья Морозов', 'Антон Лесной', 'Кирилл Горин'];
  return (['head', 'assistant'] as const).flatMap((role, r) => (Object.keys(COACH_PROFILES) as CoachProfile[])
    .map((profile, i) => makeCoach(`generated-${role}-${profile}`, names[r * 5 + i], role, profile)));
}
