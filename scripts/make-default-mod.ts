// Builds the league that ships with the game: «ХЛ — Хоккейная Лига», 24 invented clubs in invented cities with
// invented players, coaches and emblems. Output: public/mods/HL_2627/{mod.json, roster.json, cover.svg, logos/*.svg}.
// Deterministic: the same script always writes the same files.
// Run: npx tsx scripts/make-default-mod.ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { COACH_PROFILES } from '../src/game/coachData';
import { generateContract } from '../src/game/contracts';
import { computeOverall } from '../src/game/ratings';
import { COUNTRY_NAMES } from '../src/game/fictionalNames';
import type { CoachProfile, Player, PosCode } from '../src/types';

const MOD_ID = 'HL_2627';
const OUT = `public/mods/${MOD_ID}`;

/* ---------------- deterministic randomness ---------------- */
let seed = 0x48_4c_26_27;
function rnd() {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const R = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const jitter = (sd: number) => Math.round((rnd() + rnd() + rnd() - 1.5) * 1.6 * sd);

/* ---------------- clubs ---------------- */
type Motif =
  | 'snowflake' | 'anchor' | 'falcon' | 'star' | 'helmet' | 'lighthouse' | 'bolt' | 'sticks' | 'bison' | 'comet' | 'axe'
  | 'pike' | 'eagle' | 'gem' | 'anvil' | 'claws' | 'volcano' | 'sunrise' | 'paw' | 'cedar' | 'wind' | 'seal' | 'wave' | 'sable';
type Shape = 'circle' | 'shield' | 'crest' | 'hex';
interface Club { id: string; name: string; city: string; short: string; conference: 'Запад' | 'Восток'; division: string; primary: string; secondary: string; motif: Motif; shape: Shape; tier: number }

const N = 'Северный', RV = 'Речной', G = 'Горный', TG = 'Таёжный';
const CLUBS: Club[] = [
  { id: 'vyuga', name: 'Вьюга', city: 'Северогорск', short: 'ВЮГ', conference: 'Запад', division: N, primary: '#1F4E8C', secondary: '#E8F1FA', motif: 'snowflake', shape: 'circle', tier: 2 },
  { id: 'ledokoly', name: 'Ледоколы', city: 'Мореград', short: 'ЛДК', conference: 'Запад', division: N, primary: '#0E2A47', secondary: '#F2B33D', motif: 'anchor', shape: 'shield', tier: 1 },
  { id: 'sapsany', name: 'Сапсаны', city: 'Верхнеозёрск', short: 'САП', conference: 'Запад', division: N, primary: '#454B55', secondary: '#F4C430', motif: 'falcon', shape: 'crest', tier: 0 },
  { id: 'polyarniki', name: 'Полярники', city: 'Полярноград', short: 'ПОЛ', conference: 'Запад', division: N, primary: '#12355B', secondary: '#7FD3F7', motif: 'star', shape: 'hex', tier: -1 },
  { id: 'varyagi', name: 'Варяги', city: 'Варяжск', short: 'ВАР', conference: 'Запад', division: N, primary: '#7A1F1F', secondary: '#D9B26F', motif: 'helmet', shape: 'shield', tier: 1 },
  { id: 'mayak', name: 'Маяк', city: 'Светлая Гавань', short: 'МАЯ', conference: 'Запад', division: N, primary: '#C8102E', secondary: '#FFFFFF', motif: 'lighthouse', shape: 'circle', tier: -2 },
  { id: 'groza', name: 'Гроза', city: 'Громовск', short: 'ГРЗ', conference: 'Запад', division: RV, primary: '#3B2A6B', secondary: '#FFD23F', motif: 'bolt', shape: 'crest', tier: 3 },
  { id: 'shturm', name: 'Штурм', city: 'Стальград', short: 'ШТМ', conference: 'Запад', division: RV, primary: '#1C1C1C', secondary: '#E03A3E', motif: 'sticks', shape: 'hex', tier: 1 },
  { id: 'tury', name: 'Туры', city: 'Пущанск', short: 'ТУР', conference: 'Запад', division: RV, primary: '#5B3A1E', secondary: '#E2B85C', motif: 'bison', shape: 'shield', tier: 0 },
  { id: 'komety', name: 'Кометы', city: 'Звёздный Бор', short: 'КОМ', conference: 'Запад', division: RV, primary: '#0B1F4B', secondary: '#FF8C42', motif: 'comet', shape: 'circle', tier: -1 },
  { id: 'sekira', name: 'Секира', city: 'Ратнинск', short: 'СЕК', conference: 'Запад', division: RV, primary: '#2E4A3F', secondary: '#D5DADF', motif: 'axe', shape: 'crest', tier: -2 },
  { id: 'shchuki', name: 'Щуки', city: 'Новоречинск', short: 'ЩУК', conference: 'Запад', division: RV, primary: '#1E6B52', secondary: '#F1E9C9', motif: 'pike', shape: 'hex', tier: 0 },
  { id: 'berkuty', name: 'Беркуты', city: 'Орлиногорск', short: 'БРК', conference: 'Восток', division: G, primary: '#6B3E1D', secondary: '#F3C14B', motif: 'eagle', shape: 'shield', tier: 2 },
  { id: 'samotsvety', name: 'Самоцветы', city: 'Самоцветск', short: 'СМЦ', conference: 'Восток', division: G, primary: '#0F6E6E', secondary: '#E6F7F5', motif: 'gem', shape: 'hex', tier: 1 },
  { id: 'liteyshchiki', name: 'Литейщики', city: 'Чугунград', short: 'ЛИТ', conference: 'Восток', division: G, primary: '#2B2D42', secondary: '#F28C28', motif: 'anvil', shape: 'shield', tier: 3 },
  { id: 'rosomakhi', name: 'Росомахи', city: 'Кедровогорск', short: 'РОС', conference: 'Восток', division: G, primary: '#3A2F2A', secondary: '#D4A373', motif: 'claws', shape: 'circle', tier: -1 },
  { id: 'vulkan', name: 'Вулкан', city: 'Огнегорск', short: 'ВУЛ', conference: 'Восток', division: G, primary: '#B22222', secondary: '#FFB000', motif: 'volcano', shape: 'crest', tier: 0 },
  { id: 'gorizont', name: 'Горизонт', city: 'Ветрогорск', short: 'ГОР', conference: 'Восток', division: G, primary: '#E8601C', secondary: '#1B2A49', motif: 'sunrise', shape: 'circle', tier: -2 },
  { id: 'shatuny', name: 'Шатуны', city: 'Таёжинск', short: 'ШАТ', conference: 'Восток', division: TG, primary: '#4B1E2F', secondary: '#F0C987', motif: 'paw', shape: 'shield', tier: 2 },
  { id: 'kedry', name: 'Кедры', city: 'Кедроград', short: 'КЕД', conference: 'Восток', division: TG, primary: '#1F5132', secondary: '#F5F0E1', motif: 'cedar', shape: 'crest', tier: 0 },
  { id: 'purga', name: 'Пурга', city: 'Тундровск', short: 'ПУР', conference: 'Восток', division: TG, primary: '#4F6F95', secondary: '#FFFFFF', motif: 'wind', shape: 'circle', tier: -1 },
  { id: 'nerpy', name: 'Нерпы', city: 'Глубокоозёрск', short: 'НРП', conference: 'Восток', division: TG, primary: '#2C6E91', secondary: '#DDEEF7', motif: 'seal', shape: 'hex', tier: -3 },
  { id: 'tsunami', name: 'Цунами', city: 'Тихоокеанск', short: 'ЦУН', conference: 'Восток', division: TG, primary: '#003B5C', secondary: '#33C3D6', motif: 'wave', shape: 'circle', tier: 1 },
  { id: 'soboli', name: 'Соболи', city: 'Соболинск', short: 'СОБ', conference: 'Восток', division: TG, primary: '#151515', secondary: '#D4AF37', motif: 'sable', shape: 'crest', tier: 1 },
];

/* ---------------- emblems ---------------- */
const lum = (hex: string) => {
  const c = hex.replace('#', '');
  return 0.299 * parseInt(c.slice(0, 2), 16) + 0.587 * parseInt(c.slice(2, 4), 16) + 0.114 * parseInt(c.slice(4, 6), 16);
};
/** outline of the badge in a 100×100 box, scaled about the centre */
function shapePath(shape: Shape, k = 1): string {
  const s = (x: number, y: number) => `${(50 + (x - 50) * k).toFixed(2)} ${(50 + (y - 50) * k).toFixed(2)}`;
  switch (shape) {
    case 'circle': return `M${s(50, 3)} A${47 * k} ${47 * k} 0 1 1 ${s(49.99, 3)} Z`;
    case 'shield': return `M${s(50, 3)} L${s(91, 13)} L${s(91, 46)} C${s(91, 72)} ${s(74, 88)} ${s(50, 97)} C${s(26, 88)} ${s(9, 72)} ${s(9, 46)} L${s(9, 13)} Z`;
    case 'crest': return `M${s(50, 3)} L${s(93, 20)} L${s(86, 68)} L${s(50, 97)} L${s(14, 68)} L${s(7, 20)} Z`;
    case 'hex': return `M${s(50, 3)} L${s(91, 26)} L${s(91, 74)} L${s(50, 97)} L${s(9, 74)} L${s(9, 26)} Z`;
  }
}
/** motif drawn in `f` on the club colour `p` (used for cut-outs) */
function motif(m: Motif, f: string, p: string): string {
  const st = (w: number, c = f) => `fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
  switch (m) {
    case 'snowflake': {
      const arm = `<path d="M50 50 V20 M50 30 L41 23 M50 30 L59 23 M50 40 L43 35 M50 40 L57 35" ${st(4.5)}/>`;
      return [0, 60, 120, 180, 240, 300].map((a) => `<g transform="rotate(${a} 50 50)">${arm}</g>`).join('') + `<circle cx="50" cy="50" r="5" fill="${f}"/>`;
    }
    case 'anchor':
      return `<circle cx="50" cy="23" r="6.5" ${st(5)}/><path d="M50 30 V79 M37 39 H63 M26 58 Q30 80 50 80 Q70 80 74 58" ${st(5.5)}/>`
        + `<path d="M19 63 L26 51 L33 63 Z M67 63 L74 51 L81 63 Z" fill="${f}"/>`;
    case 'falcon':
      return `<path d="M27 80 C24 56 32 33 54 26 C67 22 78 29 82 40 L73 44 L78 51 C71 54 65 52 60 47 C60 60 53 71 42 80 Z" fill="${f}"/>`
        + `<circle cx="63" cy="36" r="3.6" fill="${p}"/><path d="M57 41 C55 50 52 57 46 62" ${st(3.5, p)}/>`;
    case 'star': {
      const pts: string[] = [];
      for (let i = 0; i < 16; i++) {
        const a = (i * Math.PI) / 8 - Math.PI / 2, r = i % 4 === 0 ? 31 : i % 2 === 0 ? 17 : 7.5;
        pts.push(`${(50 + r * Math.cos(a)).toFixed(1)},${(44 + r * Math.sin(a)).toFixed(1)}`);
      }
      return `<polygon points="${pts.join(' ')}" fill="${f}"/><path d="M22 80 Q50 64 78 80" ${st(4)}/><path d="M30 88 Q50 78 70 88" ${st(3)} opacity=".7"/>`;
    }
    case 'helmet':
      return `<path d="M33 46 C22 42 17 31 19 19 C25 28 30 32 37 35 Z M67 46 C78 42 83 31 81 19 C75 28 70 32 63 35 Z" fill="${f}"/>`
        + `<path d="M28 62 C28 40 38 30 50 30 C62 30 72 40 72 62 Z" fill="${f}"/><rect x="25" y="58" width="50" height="9" rx="2" fill="${f}"/>`
        + `<rect x="46.5" y="62" width="7" height="18" rx="2" fill="${f}"/><path d="M28 61.5 H72" ${st(2, p)}/><path d="M50 32 V57" ${st(2, p)}/>`
        + `<circle cx="33" cy="62.5" r="1.6" fill="${p}"/><circle cx="41" cy="62.5" r="1.6" fill="${p}"/><circle cx="59" cy="62.5" r="1.6" fill="${p}"/><circle cx="67" cy="62.5" r="1.6" fill="${p}"/>`;
    case 'lighthouse':
      return `<path d="M58 30 L86 20 L86 40 Z M42 30 L14 20 L14 40 Z" fill="${f}" opacity=".55"/>`
        + `<path d="M41 25 L50 16 L59 25 Z" fill="${f}"/><rect x="43" y="25" width="14" height="10" fill="${f}"/><rect x="46" y="27" width="8" height="6" fill="${p}"/>`
        + `<path d="M42 36 H58 L62 80 H38 Z" fill="${f}"/><path d="M40.6 51 H59.4 L60 57 H40 Z M39.2 66 H60.8 L61.4 72 H38.6 Z" fill="${p}"/><rect x="31" y="80" width="38" height="5" rx="1.5" fill="${f}"/>`;
    case 'bolt':
      return `<path d="M58 13 L28 55 H46 L38 88 L72 43 H54 L64 13 Z" fill="${f}"/>`;
    case 'sticks':
      return `<path d="M27 16 L61 70 Q64 76 71 76 H81" ${st(6.5)}/><path d="M73 16 L39 70 Q36 76 29 76 H19" ${st(6.5)}/>`
        + `<ellipse cx="50" cy="31" rx="10" ry="4" fill="${f}"/><rect x="40" y="27" width="20" height="4" fill="${f}"/><ellipse cx="50" cy="27" rx="10" ry="4" fill="${f}" stroke="${p}" stroke-width="1.5"/>`;
    case 'bison':
      return `<path d="M37 44 C24 45 17 36 19 23 C24 32 31 35 40 36 Z M63 44 C76 45 83 36 81 23 C76 32 69 35 60 36 Z" fill="${f}"/>`
        + `<path d="M36 40 C36 30 64 30 64 40 L62 66 C60 79 40 79 38 66 Z" fill="${f}"/>`
        + `<path d="M40 33 C44 26 56 26 60 33 C56 30 44 30 40 33 Z" fill="${p}"/><circle cx="44" cy="50" r="2.8" fill="${p}"/><circle cx="56" cy="50" r="2.8" fill="${p}"/>`
        + `<ellipse cx="45.5" cy="69" rx="2.4" ry="3" fill="${p}"/><ellipse cx="54.5" cy="69" rx="2.4" ry="3" fill="${p}"/>`;
    case 'comet':
      return `<path d="M55 47 L18 82 L26 85 L60 52 Z" fill="${f}" opacity=".9"/><path d="M52 40 L16 64 L20 70 L56 46 Z" fill="${f}" opacity=".6"/><path d="M61 54 L40 88 L46 90 L65 57 Z" fill="${f}" opacity=".6"/>`
        + `<circle cx="63" cy="38" r="14" fill="${f}"/><circle cx="58" cy="34" r="4" fill="${p}" opacity=".35"/>`
        + `<path d="M30 22 L32 27 L37 29 L32 31 L30 36 L28 31 L23 29 L28 27 Z" fill="${f}"/>`;
    case 'axe':
      return `<path d="M36 84 L62 22" ${st(6)}/><path d="M55 30 L60 18 C68 22 76 22 83 17 C86 34 82 50 70 61 C69 50 64 42 56 40 Z" fill="${f}"/>`
        + `<path d="M58 34 C64 36 69 40 72 46" ${st(2.2, p)}/><path d="M34 84 L39 86" ${st(7)}/>`;
    case 'pike':
      return `<g transform="rotate(-18 50 50)"><path d="M14 50 C26 35 58 33 72 44 L87 34 L82 50 L87 66 L72 56 C58 67 26 65 14 50 Z" fill="${f}"/>`
        + `<path d="M44 38 L52 27 L58 38 Z M46 62 L52 72 L57 62 Z" fill="${f}"/><circle cx="26" cy="46" r="3" fill="${p}"/>`
        + `<path d="M15 51 L29 53" ${st(2, p)}/><path d="M36 42 C40 46 40 54 36 58" ${st(2, p)}/><path d="M48 46 L50 48 M54 46 L56 48 M60 47 L62 49 M50 53 L52 55 M56 53 L58 55" ${st(1.6, p)}/></g>`;
    case 'eagle':
      return `<path d="M50 34 C47 34 45 37 45 41 L20 30 L25 39 L15 41 L25 47 L18 52 L30 53 L41 57 L44 72 L50 84 L56 72 L59 57 L70 53 L82 52 L75 47 L85 41 L75 39 L80 30 L55 41 C55 37 53 34 50 34 Z" fill="${f}"/>`
        + `<circle cx="50" cy="27" r="7" fill="${f}"/><path d="M53 26 L60 29 L54 31 Z" fill="${f}"/><circle cx="51.5" cy="26" r="1.6" fill="${p}"/>`
        + `<path d="M50 44 V68 M45 50 L50 55 L55 50 M45 58 L50 63 L55 58" ${st(1.8, p)}/>`;
    case 'gem':
      return `<path d="M27 40 L39 25 H61 L73 40 L50 81 Z" fill="${f}"/><path d="M27 40 H73 M39 25 L45 40 L50 81 M61 25 L55 40 L50 81 M45 40 L50 25 L55 40" ${st(2, p)}/>`
        + `<path d="M20 22 L22 27 L27 29 L22 31 L20 36 L18 31 L13 29 L18 27 Z" fill="${f}"/>`;
    case 'anvil':
      return `<path d="M30 48 H78 V56 C70 56 65 60 63 67 L67 76 H37 L41 67 C39 60 34 56 30 56 Z M30 48 H14 C16 54 22 56 30 56 Z" fill="${f}"/><rect x="33" y="76" width="38" height="6" rx="1.5" fill="${f}"/>`
        + `<path d="M38 14 L60 40" ${st(5)}/><rect x="49" y="17" width="22" height="11" rx="2" transform="rotate(40 60 22.5)" fill="${f}"/>`
        + `<path d="M28 34 L22 30 M30 28 L28 21 M36 30 L38 24" ${st(2.5)}/>`;
    case 'claws':
      return [0, 15, 30].map((dx) => `<path d="M${22 + dx} 20 C${36 + dx} 38 ${38 + dx} 58 ${32 + dx} 82 L${39 + dx} 82 C${46 + dx} 58 ${44 + dx} 36 ${30 + dx} 20 Z" fill="${f}"/>`).join('');
    case 'volcano':
      return `<path d="M44 36 L39 15 L47 28 L50 10 L54 28 L62 15 L57 36 Z" fill="${f}"/>`
        + `<path d="M14 82 L39 42 H61 L86 82 Z" fill="${f}"/><path d="M39 42 L44 50 L48 45 L50 58 L53 46 L57 52 L61 42 Z" fill="${p}"/>`
        + `<path d="M28 82 L36 68 M72 82 L65 70" ${st(2, p)}/>`;
    case 'sunrise': {
      const rays = [180, 150, 120, 90, 60, 30, 0].map((d) => {
        const a = (d * Math.PI) / 180;
        return `M${(50 + 25 * Math.cos(a)).toFixed(1)} ${(60 - 25 * Math.sin(a)).toFixed(1)} L${(50 + 35 * Math.cos(a)).toFixed(1)} ${(60 - 35 * Math.sin(a)).toFixed(1)}`;
      }).join(' ');
      return `<path d="M30 60 A20 20 0 0 1 70 60 Z" fill="${f}"/><path d="${rays}" ${st(4)}/><rect x="14" y="61" width="72" height="5" rx="2.5" fill="${f}"/>`
        + `<path d="M24 73 H76 M33 81 H67" ${st(3.5)}/>`;
    }
    case 'paw':
      return `<path d="M32 64 C32 50 68 50 68 64 C68 77 59 81 50 76 C41 81 32 77 32 64 Z" fill="${f}"/>`
        + `<ellipse cx="27" cy="46" rx="6.5" ry="8.5" transform="rotate(-25 27 46)" fill="${f}"/><ellipse cx="41" cy="35" rx="6.5" ry="9" transform="rotate(-8 41 35)" fill="${f}"/>`
        + `<ellipse cx="59" cy="35" rx="6.5" ry="9" transform="rotate(8 59 35)" fill="${f}"/><ellipse cx="73" cy="46" rx="6.5" ry="8.5" transform="rotate(25 73 46)" fill="${f}"/>`
        + `<path d="M22 37 L21 28 L26 35 Z M38 25 L39 16 L43 24 Z M57 24 L61 16 L62 25 Z M74 35 L79 28 L78 37 Z" fill="${f}"/>`;
    case 'cedar':
      return `<path d="M50 13 L63 32 H56 L69 49 H59 L76 68 H24 L41 49 H31 L44 32 H37 Z" fill="${f}"/><rect x="46" y="68" width="8" height="15" rx="1.5" fill="${f}"/>`
        + `<path d="M50 24 V64" ${st(1.8, p)}/>`;
    case 'wind':
      return `<path d="M18 38 H58 C69 38 72 28 66 23 C60 18 51 23 55 30" ${st(5)}/><path d="M14 53 H72 C83 53 86 65 78 70 C72 74 64 69 68 62" ${st(5)}/>`
        + `<path d="M24 68 H50 C58 68 61 77 55 81 C51 84 46 81 48 77" ${st(4.5)}/><circle cx="80" cy="34" r="2.5" fill="${f}"/><circle cx="20" cy="80" r="2.5" fill="${f}"/><circle cx="84" cy="44" r="1.8" fill="${f}"/>`;
    case 'seal':
      return `<ellipse cx="50" cy="53" rx="24" ry="22" fill="${f}"/><circle cx="41" cy="48" r="5" fill="${p}"/><circle cx="59" cy="48" r="5" fill="${p}"/>`
        + `<circle cx="42.5" cy="46.5" r="1.6" fill="${f}"/><circle cx="60.5" cy="46.5" r="1.6" fill="${f}"/><path d="M46 58 H54 L50 63 Z" fill="${p}"/>`
        + `<path d="M50 63 V66 M44 61 L31 58 M44 64 L31 66 M56 61 L69 58 M56 64 L69 66" ${st(1.6, p)}/><path d="M30 80 Q50 90 70 80" ${st(3.5)}/>`;
    case 'wave':
      return `<path d="M14 76 C22 62 28 40 50 33 C67 28 82 39 80 54 C78 65 65 68 60 60 C56 53 62 46 67 50 C64 41 52 41 46 50 C40 60 42 70 52 76 Z" fill="${f}"/>`
        + `<path d="M14 84 Q24 78 34 84 T54 84 T74 84 T88 84" ${st(3.5)}/><circle cx="76" cy="30" r="3" fill="${f}"/><circle cx="84" cy="38" r="2" fill="${f}"/>`;
    case 'sable':
      return `<path d="M50 80 L31 52 L26 22 L41 36 L50 33 L59 36 L74 22 L69 52 Z" fill="${f}"/><path d="M30 28 L39 37 L33 41 Z M70 28 L61 37 L67 41 Z" fill="${p}"/>`
        + `<path d="M38 50 L46 53 L40 56 Z M62 50 L54 53 L60 56 Z" fill="${p}"/><path d="M46 70 H54 L50 75 Z" fill="${p}"/><path d="M50 58 V70" ${st(1.6, p)}/>`;
  }
}

function emblem(c: Club): string {
  const light = lum(c.secondary) > 150;
  const edge = light ? '#0E1621' : '#FFFFFF';
  const fg = Math.abs(lum(c.secondary) - lum(c.primary)) > 60 ? c.secondary : light ? '#0E1621' : '#FFFFFF';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 100 100">`
    + `<path d="${shapePath(c.shape)}" fill="${c.secondary}" stroke="${edge}" stroke-width="1.2" stroke-linejoin="round"/>`
    + `<path d="${shapePath(c.shape, 0.86)}" fill="${c.primary}"/>`
    + `<path d="${shapePath(c.shape, 0.8)}" fill="none" stroke="${c.secondary}" stroke-width=".8" opacity=".55"/>`
    + `<clipPath id="in"><path d="${shapePath(c.shape, 0.86)}"/></clipPath>`
    + `<g clip-path="url(#in)"><g transform="translate(50 50) scale(.8) translate(-50 -50)">${motif(c.motif, fg, c.primary)}</g></g>`
    + `</svg>\n`;
}

/** league emblem: «ХЛ» drawn as strokes (no font needed) under a puck and two crossed sticks */
function cover(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 100 100">`
    + `<path d="${shapePath('shield')}" fill="#E5323E" stroke="#0B1420" stroke-width="1.2"/>`
    + `<path d="${shapePath('shield', 0.88)}" fill="#0B1420"/>`
    + `<path d="M24 24 L76 24" stroke="#E5323E" stroke-width="2.5"/>`
    + `<g fill="none" stroke="#FFFFFF" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">`
    + `<path d="M22 36 L44 68 M44 36 L22 68"/><path d="M54 68 C58 60 60 48 60 36 H76 V68"/></g>`
    + `<path d="M26 79 H74" stroke="#E5323E" stroke-width="2.5"/>`
    + `<path d="M50 9.5 L51.6 13.4 L55.8 13.7 L52.6 16.4 L53.6 20.5 L50 18.3 L46.4 20.5 L47.4 16.4 L44.2 13.7 L48.4 13.4 Z" fill="#FFFFFF"/>`
    + `</svg>\n`;
}

/* ---------------- people ---------------- */
const usedNames = new Set<string>();
function personName(country: string): string {
  const pool = COUNTRY_NAMES[country] ?? COUNTRY_NAMES['Россия'];
  for (let i = 0; i < 400; i++) {
    const n = `${pick(pool.first)} ${pick(pool.last)}`;
    if (!usedNames.has(n)) { usedNames.add(n); return n; }
  }
  throw new Error(`names exhausted for ${country}`);
}
const ABROAD = ['Канада', 'Канада', 'Канада', 'США', 'США', 'Швеция', 'Финляндия', 'Чехия', 'Словакия', 'Латвия'];
const NEIGHBOURS = ['Беларусь', 'Казахстан'];

function skillsFor(pos: PosCode, ovr: number): Record<string, number> {
  const v = (d = 0, sd = 3) => clamp(ovr + d + jitter(sd), 40, 95);
  if (pos === 'G') return { reflexes: v(1), positioning: v(1), reboundControl: v(0), puckHandling: v(-6, 4), endurance: v(-1) };
  const style = rnd();
  if (pos === 'D') {
    const off = style < 0.35;
    return { skating: v(off ? 1 : -1), shooting: v(off ? -2 : -8), passing: v(off ? 3 : -1), puckControl: v(off ? 1 : -3), checking: v(off ? 0 : 5), defense: v(off ? 2 : 5) };
  }
  const sniper = style < 0.4, playmaker = style >= 0.4 && style < 0.7;
  return {
    skating: v(1), shooting: v(sniper ? 4 : pos === 'C' ? -1 : 1), passing: v(playmaker ? 4 : pos === 'C' ? 2 : -1), puckControl: v(playmaker ? 2 : 0),
    checking: v(pos === 'C' ? -4 : -6, 5), defense: v(pos === 'C' ? -2 : -7, 5),
  };
}

/** search the skill sheet whose computed overall is the target */
function makeSkills(pos: PosCode, target: number) {
  let best: Record<string, number> = {}, err = 99, base = target;
  for (let i = 0; i < 12 && err > 0; i++) {
    const s = skillsFor(pos, base);
    const o = computeOverall({ position: pos, skills: s } as unknown as Player);
    if (Math.abs(o - target) < err) { best = s; err = Math.abs(o - target); }
    base += Math.sign(target - o);
  }
  return best;
}

const POS_RU: Record<PosCode, string> = { C: 'Ц', LW: 'ЛК', RW: 'ПК', D: 'З', G: 'В' };
interface Raw { id: string; name: string; position: string; age: number; height: number; weight: number; number: number; country: string; hand: 'L' | 'R'; overall: number; potential: number; skills: Record<string, number>; contract?: { salary: number; years: number }; morale: number; inVhl?: boolean }

function makePlayer(id: string, pos: PosCode, target: number, age: number, country: string, number: number, withContract: boolean, farm = false): Raw {
  const skills = makeSkills(pos, target);
  const overall = computeOverall({ position: pos, skills } as unknown as Player);
  const potential = age <= 24 ? clamp(overall + Math.round((25 - age) * 1.7) + R(0, 6), overall, 92) : age >= 33 ? overall : clamp(overall + R(0, 2), overall, 92);
  const tall = pos === 'D' ? [183, 199] : pos === 'G' ? [182, 197] : [176, 193];
  const height = R(tall[0], tall[1]);
  const weight = clamp(Math.round((height - 100) * 0.98 + jitter(5) + (pos === 'D' ? 3 : 0)), 72, 112);
  const hand: 'L' | 'R' = pos === 'G' ? (rnd() < 0.86 ? 'L' : 'R') : pos === 'RW' ? (rnd() < 0.55 ? 'R' : 'L') : rnd() < (pos === 'D' ? 0.66 : 0.72) ? 'L' : 'R';
  const name = personName(country);
  const p: Raw = { id, name, position: POS_RU[pos], age, height, weight, number, country, hand, overall, potential, skills, morale: R(68, 82) };
  if (withContract) {
    const c = generateContract({ id, name, age, overall, potential });
    p.contract = { salary: c.salary, years: c.years };
  }
  if (farm) p.inVhl = true;
  return p;
}

function coach(id: string, role: 'head' | 'assistant', level: number, country = 'Россия') {
  const profile = pick(Object.keys(COACH_PROFILES) as CoachProfile[]);
  const base = COACH_PROFILES[profile];
  const sk = (v: number) => clamp(v + level + jitter(3), 45, 95);
  const pool = COUNTRY_NAMES[country];
  let name = '';
  do name = `${pick(pool.first)} ${pick(pool.last)}`; while (usedNames.has(name));
  usedNames.add(name);
  return {
    id, name, role, profile, label: base.label,
    attack: sk(base.attack), defense: sk(base.defense), special: sk(base.special), development: sk(base.development), motivation: sk(base.motivation),
    salary: Math.round((role === 'head' ? 14_000_000 + level * 1_800_000 + R(0, 4) * 1_000_000 : 5_000_000 + level * 500_000 + R(0, 3) * 500_000) / 500_000) * 500_000,
    fictional: true,
  };
}

/* ---------------- build ---------------- */
function buildTeam(c: Club) {
  const T = c.tier;
  const numbers = new Set<number>();
  const num = (goalie: boolean) => {
    const pref = goalie ? [1, 30, 31, 35, 33, 40, 50, 60, 72, 80] : [];
    for (const n of pref) if (!numbers.has(n)) { numbers.add(n); return n; }
    for (;;) { const n = R(2, 98); if (!numbers.has(n) && ![1, 30, 31, 35].includes(n)) { numbers.add(n); return n; } }
  };
  // legionnaires go to the best slots; a few neighbours (not counted as legionnaires) anywhere
  let foreign = clamp(R(1, 3) + (T > 1 ? 1 : 0), 0, 5);
  const country = (slotQuality: number) => {
    if (foreign > 0 && slotQuality > 0.55 && rnd() < 0.55) { foreign--; return pick(ABROAD); }
    return rnd() < 0.07 ? pick(NEIGHBOURS) : 'Россия';
  };
  const players: Raw[] = [];
  let k = 0;
  const add = (pos: PosCode, target: number, age: number, quality: number, farm = false) => {
    k++;
    players.push(makePlayer(`${c.id}-${String(k).padStart(2, '0')}`, pos, Math.round(target), age, country(quality), num(pos === 'G'), true, farm));
  };
  const vetAge = () => (rnd() < 0.15 ? R(32, 36) : R(24, 31));
  // forwards: 4 lines of C/LW/RW + 2 spares + 2 prospects
  const fwd: PosCode[] = ['C', 'LW', 'RW'];
  const lineBase = [81, 77, 73, 70];
  for (let line = 0; line < 4; line++) for (const pos of fwd) add(pos, lineBase[line] + T * 0.9 + jitter(2), vetAge(), 1 - line * 0.3);
  add('C', 69 + T * 0.6 + jitter(2), vetAge(), 0);
  add(pick(['LW', 'RW'] as PosCode[]), 68 + T * 0.6 + jitter(2), vetAge(), 0);
  add(pick(fwd), 64 + jitter(2), R(18, 20), 0, true);
  add(pick(fwd), 65 + jitter(2), R(19, 21), 0);
  // defence: 3 pairs + 1 spare + 1 prospect
  const pairBase = [79, 75, 71];
  for (let pair = 0; pair < 3; pair++) for (let i = 0; i < 2; i++) add('D', pairBase[pair] + T * 0.9 + jitter(2), vetAge(), 1 - pair * 0.35);
  add('D', 68 + T * 0.5 + jitter(2), vetAge(), 0);
  add('D', 64 + jitter(2), R(18, 20), 0, true);
  // goalies: starter, backup, young third
  add('G', 81 + T + jitter(2), R(25, 32), 0.9);
  add('G', 74 + T * 0.5 + jitter(2), R(22, 34), 0.2);
  add('G', 65 + jitter(2), R(19, 21), 0, true);

  const skaters = players.filter((p) => p.position !== 'В' && !p.inVhl && p.age >= 25).sort((a, b) => b.overall + b.age * 0.3 - (a.overall + a.age * 0.3));
  const payroll = players.reduce((s, p) => s + (p.contract?.salary ?? 0), 0);
  const level = Math.round(T * 1.5);
  return {
    id: c.id, name: c.name, short: c.short, city: c.city, conference: c.conference, division: c.division,
    primaryColor: c.primary, secondaryColor: c.secondary,
    budget: Math.round((payroll * 1.25 + 250_000_000 + T * 60_000_000) / 50_000_000) * 50_000_000,
    logo: `logos/${c.id}.svg`,
    captainId: skaters[0].id, assistantIds: [skaters[1].id, skaters[2].id],
    coaches: [coach(`${c.id}-head`, 'head', level, T >= 2 && rnd() < 0.4 ? pick(['Канада', 'Финляндия', 'Чехия']) : 'Россия'), coach(`${c.id}-assistant`, 'assistant', level)],
    players,
  };
}

const teams = CLUBS.map(buildTeam);
const freeAgents: Raw[] = [];
const faPos: PosCode[] = ['C', 'LW', 'RW', 'D', 'D', 'C', 'RW', 'LW', 'D', 'G'];
for (let i = 0; i < 26; i++) {
  const young = i % 6 === 5;
  const pos = faPos[i % faPos.length];
  const age = young ? R(20, 22) : R(29, 36);
  const ovr = young ? 63 + R(0, 4) : 68 + R(0, 10) - (age > 34 ? 2 : 0);
  freeAgents.push(makePlayer(`fa-${String(i + 1).padStart(2, '0')}`, pos, ovr, age, rnd() < 0.2 ? pick(ABROAD) : rnd() < 0.08 ? pick(NEIGHBOURS) : 'Россия', R(2, 98), false));
}
const freeCoaches = [
  ...Array.from({ length: 8 }, (_, i) => coach(`free-coach-${String(i + 1).padStart(2, '0')}`, 'head', R(-2, 4), i === 3 ? 'Канада' : i === 6 ? 'Финляндия' : 'Россия')),
  ...Array.from({ length: 5 }, (_, i) => coach(`free-assistant-${String(i + 1).padStart(2, '0')}`, 'assistant', R(-2, 3))),
];

const roster = {
  // farm: the second league the clubs send players to on two-way contracts (invented like the rest of the league)
  league: { name: 'ХЛ', farm: 'ВЛ', season: '2026/27', gamesPerTeam: 68, salaryCap: 950_000_000, foreignLimit: 5 },
  teams,
  freeAgents,
  freeCoaches,
};
const mod = {
  name: 'ХЛ — Хоккейная Лига 2026/27',
  description: 'Стандартная лига игры: 24 вымышленных клуба из вымышленных городов в двух конференциях и четырёх дивизионах, вымышленные игроки и тренеры, собственные эмблемы. Календарь на 68 матчей составляется автоматически.',
  author: 'ClubGames',
  version: '1.0',
  cover: 'cover.svg',
  roster: 'roster.json',
  schedule: null,
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/logos`, { recursive: true });
writeFileSync(`${OUT}/mod.json`, JSON.stringify(mod, null, 2) + '\n');
writeFileSync(`${OUT}/roster.json`, JSON.stringify(roster, null, 1) + '\n');
writeFileSync(`${OUT}/cover.svg`, cover());
for (const c of CLUBS) writeFileSync(`${OUT}/logos/${c.id}.svg`, emblem(c));

const all = teams.flatMap((t) => t.players);
const payrolls = teams.map((t) => Math.round(t.players.reduce((s, p) => s + (p.contract?.salary ?? 0), 0) / 1e6));
console.log(`${OUT}: ${teams.length} clubs, ${all.length} players, ${freeAgents.length} free agents, ${freeCoaches.length} free coaches`);
console.log(`overall ${Math.min(...all.map((p) => p.overall))}–${Math.max(...all.map((p) => p.overall))}, mean ${(all.reduce((s, p) => s + p.overall, 0) / all.length).toFixed(1)}; payroll ${Math.min(...payrolls)}–${Math.max(...payrolls)} M`);
