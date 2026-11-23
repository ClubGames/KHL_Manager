import type { Coach, CoachProfile, CoachRole } from '../types';

// Historical starting snapshot, NOT a live list of current appointments.
// Names/appointments are sourced; attributes, specialisations and pay are game design.
export const STAFF_SNAPSHOT = '2025/26';
export const COACH_PROFILES: Record<CoachProfile, { label: string; attack: number; defense: number; special: number; development: number; motivation: number }> = {
  balanced: { label: 'Системный', attack: 72, defense: 72, special: 72, development: 72, motivation: 72 },
  attack: { label: 'Атакующий', attack: 88, defense: 60, special: 80, development: 65, motivation: 67 },
  defense: { label: 'Оборонительный', attack: 60, defense: 88, special: 80, development: 65, motivation: 67 },
  development: { label: 'Наставник', attack: 66, defense: 66, special: 65, development: 92, motivation: 78 },
  motivator: { label: 'Мотиватор', attack: 68, defense: 68, special: 65, development: 68, motivation: 92 },
};
export const COACH_ROLE_LABEL: Record<CoachRole, string> = { head: 'Главный тренер', assistant: 'Ассистент' };

// One head and one representative assistant per club; not an exhaustive real-life staff list.
export const REAL_STAFF: Record<string, [string, string, string]> = {
  avangard: ['Ги Буше', 'Дэйв Барр', 'https://www.rbc.ru/sport/27/04/2025/680df60a9a794756226fad3a'],
  avtomobilist: ['Николай Заварухин', 'Алексей Заварухин', 'https://www.khl.ru/news/2025/06/17/548147.html'],
  admiral: ['Леонид Тамбиев', 'Виктор Костючёнок', 'https://belarushockey.com/khl/news/2025/09/07/belorusskij-specialist-oficialno-popolnil-trenerskij-shtab-admirala/'],
  akbars: ['Анвар Гатиятулин', 'Александр Макрицкий', 'https://www.ak-bars.ru/uploads/843/programs/pdf/e91777cfa05836052ec4fb14f4648693.pdf'],
  amur: ['Александр Гальченюк', 'Юрий Кузьменков', 'https://allhockey.ru/news/show/560315-Amur_predstavil_obnovlennyj_trenerskij_sostav_na_sezon_2025_26'],
  barys: ['Михаил Кравец', 'Талгат Жайлауов', 'https://www.khl.ru/news/2025/08/04/548966.html'],
  'dinamo-mn': ['Дмитрий Квартальнов', 'Андрей Ковалёв', 'https://hcdinamo.by/news/sobytiya/predstavlyaem-trenerskiy-shtab-minskogo-dinamo-na-sezon-2025-26/'],
  'dinamo-msk': ['Алексей Кудашов', 'Андрей Скопинцев', 'https://dynamo.ru/news/231259-sformirovan_trenerskiy_shtab_moskovskogo___dinamo___na_sezon_2025_2026_'],
  lada: ['Борис Миронов', 'Павел Зубов', 'https://www.livesport.ru/hockey/2025/06/16/lada_coach/'],
  lokomotiv: ['Боб Хартли', 'Дмитрий Рябыкин', 'https://www.championat.com/hockey/news-6106020-lokomotiv-predstavil-trenerskij-shtab-na-sezon-2025-2026.html'],
  'metallurg-mg': ['Андрей Разин', 'Владимир Воробьёв', 'https://magmetall.ru/news/sports/metallurg-usilivaet-shtab/'],
  neftekhimik: ['Игорь Гришин', 'Алексей Пепеляев', 'https://realnoevremya.ru/news/337290-neftehimik-oficialno-predstavil-grishina-novym-glavnym-trenerom'],
  salavat: ['Виктор Козлов', 'Николай Цулыгин', 'https://hcsalavat.ru/news/sformirovan-trenerskiy-shtab-salavata-yulaeva-na-sezon-2025-26/'],
  ska: ['Игорь Ларионов', 'Евгений Кетов', 'https://sportrbc.ru/news/687f5c659a79478f25a93325'],
  severstal: ['Андрей Козырев', 'Евгений Ставровский', 'https://sport24.ru/hockey/news-743540-severstal-obyavila-o-sokhranenii-trenerskogo-shtaba-kozyreva-na-sleduyushchiy-sezon'],
  sibir: ['Вадим Епанчинцев', 'Ярослав Люзенков', 'https://vn.ru/news-khk-sibir-obyavil-sostav-trenerskogo-shtaba-na-sezon-2025-2026/'],
  sochi: ['Владимир Крикунов', 'Дмитрий Михайлов', 'https://www.hcsochi.ru/media/news/utverzhdyen-trenerskiy-shtab-sochi-na-sezon-2025-2026/'],
  spartak: ['Алексей Жамнов', 'Алексей Ковалёв', 'https://bookmaker-ratings.ru/news/spartak-ofitsial-no-ob-yavil-trenerskij-shtab-na-sezon-2025-2026-v-khl/'],
  torpedo: ['Алексей Исаков', 'Дмитрий Гоголев', 'https://www.championat.com/hockey/news-6033944-torpedo-obyavilo-pomoschnikov-glavnogo-trenera-na-sleduyuschij-sezon-khl.html'],
  traktor: ['Бенуа Гру', 'Марио Рише', 'https://www.championat.com/hockey/news-6114700-traktor-predstavil-trenerskij-shtab-na-sezon-2025-2026-khl.html'],
  cska: ['Игорь Никитин', 'Дмитрий Юшкевич', 'https://www.kommersant.ru/doc/7800264'],
  'shanghai-dragons': ['Жерар Галлан', 'Майк Келли', 'https://www.championat.com/hockey/news-6125088-shanhaj-dregons-predstavil-trenerskij-shtab-komandy-na-sezon-2025-2026.html'],
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
    profiles[(index + i * 2) % profiles.length], real?.[2]
  ));
}

export function defaultCoachMarket(): Coach[] {
  const names = ['Артём Ветров', 'Михаил Северин', 'Олег Ледов', 'Денис Берегов', 'Павел Зорин', 'Роман Озеров', 'Никита Речной', 'Илья Морозов', 'Антон Лесной', 'Кирилл Горин'];
  return (['head', 'assistant'] as const).flatMap((role, r) => (Object.keys(COACH_PROFILES) as CoachProfile[])
    .map((profile, i) => makeCoach(`generated-${role}-${profile}`, names[r * 5 + i], role, profile)));
}
