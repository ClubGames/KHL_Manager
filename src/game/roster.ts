import type { Conference, Player, PosCode, Skills, Team } from '../types';
import { computeOverall, isGoalie } from './ratings';
import { autoLineup } from './ai';
import { emptyLineup, emptyRecord, emptyStats } from './defaults';
import { generateContract } from './contracts';
import type { ContractTerms } from './contracts';
import { DEFAULT_FOREIGN_LIMIT, teamForeignLimit } from './legionnaires';
import { isYouthPlayer, recommendYouthPlan } from './training';

export interface NormalizedRoster {
  leagueName: string;
  season: string;
  gamesPerTeam: number;
  salaryCap: number;
  foreignLimit: number;
  teams: Team[];
  players: Record<string, Player>;
  freeAgents: string[];
  warnings: string[];
  /** the parsed file as it was read */
  raw: unknown;
  /** contracts invented for players that had none in the file: [team index, player index] */
  filled: { team: number; player: number; contract: ContractTerms }[];
}

export const POS_MAP: Record<string, PosCode> = {
  C: 'C', Ц: 'C', CENTER: 'C', 'ЦН': 'C',
  LW: 'LW', ЛК: 'LW', ЛН: 'LW', LEFT: 'LW',
  RW: 'RW', ПК: 'RW', ПН: 'RW', RIGHT: 'RW',
  D: 'D', З: 'D', ЗАЩ: 'D', DEF: 'D', LD: 'D', RD: 'D', ЛЗ: 'D', ПЗ: 'D',
  G: 'G', В: 'G', ВР: 'G', GOALIE: 'G', ВРАТАРЬ: 'G',
};

const SHORT_MAP: Record<string, string> = {
  'СКА': 'СКА', 'ЦСКА': 'ЦСКА', 'Динамо Москва': 'ДМ', 'Динамо М': 'ДМ', 'Спартак': 'СПА', 'Спартак Москва': 'СПА',
  'Локомотив': 'ЛОК', 'Северсталь': 'СЕВ', 'Витязь': 'ВИТ', 'Торпедо': 'ТОР', 'Торпедо НН': 'ТОР', 'ХК Сочи': 'СОЧ',
  'Динамо Минск': 'ДМН', 'Динамо Рига': 'ДРИ', 'Ак Барс': 'АКБ', 'Салават Юлаев': 'САЛ', 'Металлург Магнитогорск': 'ММГ',
  'Металлург Мг': 'ММГ', 'Авангард': 'АВА', 'Барыс': 'БАР', 'Автомобилист': 'АВТ', 'Сибирь': 'СИБ', 'Нефтехимик': 'НЕФ',
  'Амур': 'АМУ', 'Лада': 'ЛАД', 'Куньлунь Ред Стар': 'КРС', 'Адмирал': 'АДМ', 'ХК Москва': 'МСК', 'Минские Зубры': 'МЗБ',
};

const PALETTE = ['#0A4FA3', '#C8102E', '#1E7A46', '#E8B23C', '#2E6DB4', '#1D8A4E', '#1F6FC2', '#2C73C4', '#1B5FB0', '#D12D3A', '#1C5BA8', '#4CAF50'];

const DEFAULT_CAP = 900_000_000;
const DEFAULT_BUDGET = 1_500_000_000;
const DEFAULT_GAMES = 68;

function slug(s: string): string {
  const map: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  return s.toLowerCase().split('').map((ch) => map[ch] ?? ch).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'team';
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function num(v: unknown, def: number): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : def;
}
function clampNum(v: unknown, def: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, num(v, def)));
}

function deriveSkills(pos: PosCode, ovr: number, seed: number): Skills {
  const r = (k: number) => ((Math.imul(seed + k * 7919, 2654435761) >>> 0) % 11) - 5;
  if (pos === 'G') return { reflexes: ovr + r(1), positioning: ovr + r(2), reboundControl: ovr + r(3), puckHandling: ovr - 6 + r(4), endurance: ovr + r(5) };
  const tilt: Record<string, number> = pos === 'D' ? { shooting: -8, defense: 7, checking: 6 } : pos === 'C' ? { passing: 4, defense: 2, shooting: -1 } : { shooting: 5, defense: -5 };
  return {
    skating: ovr + r(1),
    shooting: ovr + r(2) + (tilt.shooting ?? 0),
    passing: ovr + r(3) + (tilt.passing ?? 0),
    puckControl: ovr + r(4),
    checking: ovr + r(5) + (tilt.checking ?? 0),
    defense: ovr + r(6) + (tilt.defense ?? 0),
  };
}

export function normalizePlayer(raw: any, teamId: string | null, idx: number, prefix: string, warnings: string[], onGenerated?: (c: ContractTerms) => void): Player {
  const name = String(raw?.name ?? '').trim() || `Игрок ${idx + 1}`;
  const posKey = String(raw?.position ?? raw?.pos ?? 'C').trim().toUpperCase();
  let position = POS_MAP[posKey];
  if (!position) {
    warnings.push(`Игрок «${name}»: неизвестная позиция «${raw?.position}», поставлена Ц`);
    position = 'C';
  }
  const age = Math.round(clampNum(raw?.age, 26, 18, 45));
  const explicitOvr = typeof raw?.overall === 'number' ? clampNum(raw.overall, 0, 1, 99) : 0;
  let skills: Skills = {};
  if (raw?.skills && typeof raw.skills === 'object') {
    for (const k of Object.keys(raw.skills)) {
      const v = num((raw.skills as Record<string, unknown>)[k], NaN);
      if (Number.isFinite(v)) (skills as Record<string, number>)[k] = Math.round(clampNum(v, 65, 1, 99));
    }
    if (!Object.keys(skills).length) skills = deriveSkills(position, explicitOvr || 65, hashStr(name));
  } else {
    skills = deriveSkills(position, explicitOvr || 65, hashStr(name));
  }
  const id = String(raw?.id ?? `${prefix}-p${idx + 1}`);
  const player: Player = {
    id,
    name,
    position,
    age,
    height: Math.round(clampNum(raw?.height, position === 'G' ? 186 : 185, 160, 210)),
    weight: Math.round(clampNum(raw?.weight, 88, 60, 120)),
    number: Math.round(num(raw?.number, idx + 1)),
    country: String(raw?.country ?? raw?.nationality ?? '—'),
    hand: String(raw?.hand ?? raw?.catch ?? 'L').toUpperCase().startsWith('R') ? 'R' : 'L',
    overall: 0,
    potential: Math.round(clampNum(raw?.potential, 0, 1, 99)),
    skills,
    contract: {
      salary: Math.max(0, Math.round(num(raw?.contract?.salary ?? raw?.salary, 0))),
      years: Math.round(clampNum(raw?.contract?.years ?? raw?.years, 0, 0, 6)),
    },
    injury: raw?.injury && typeof raw.injury === 'object' ? { name: String(raw.injury.name ?? 'Травма'), games: Math.round(clampNum(raw.injury.games, 3, 1, 60)) } : null,
    morale: Math.round(clampNum(raw?.morale, 72, 20, 99)),
    teamId,
    stats: emptyStats(),
    history: [],
  };
  player.overall = computeOverall(player);
  if (!player.potential) player.potential = age <= 25 ? Math.min(99, Math.max(player.overall, player.overall + Math.round((26 - age) * 1.6))) : player.overall;
  if (isYouthPlayer(player)) player.trainingPlan = recommendYouthPlan(player);
  // A club player without a (complete) contract in the file gets one; it is the same on every launch.
  if (teamId && (!player.contract.salary || !player.contract.years)) {
    const g = generateContract(player);
    if (!player.contract.salary) player.contract.salary = g.salary;
    if (!player.contract.years) player.contract.years = g.years;
    onGenerated?.({ salary: player.contract.salary, years: player.contract.years });
  }
  return player;
}

const WEST_DIVISIONS = ['бобров', 'тарасов', 'bobrov', 'tarasov'];
const EAST_DIVISIONS = ['харламов', 'чернышёв', 'чернышев', 'kharlamov', 'chernyshev', 'chernyshov'];

/** Conference from the roster file: accepts «Восток», «Восточная конференция», "East", "E"…; falls back to the KHL division name. */
export function detectConference(raw: unknown, division: unknown): Conference | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s.includes('вост') || s.includes('east') || s === 'e' || s === 'в') return 'Восток';
  if (s.includes('зап') || s.includes('west') || s === 'w' || s === 'з') return 'Запад';
  const d = String(division ?? '').trim().toLowerCase();
  if (d) {
    if (EAST_DIVISIONS.some((x) => d.includes(x))) return 'Восток';
    if (WEST_DIVISIONS.some((x) => d.includes(x))) return 'Запад';
  }
  return null;
}

export function normalizeRoster(json: unknown): NormalizedRoster {
  const warnings: string[] = [];
  const root = json as any;
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('Файл должен быть JSON-объектом с полем "teams"');
  const rawTeams: any[] = Array.isArray(root.teams) ? root.teams : [];
  if (rawTeams.length < 2) throw new Error('В файле должно быть как минимум две команды в массиве "teams"');
  const league = root.league ?? {};
  const foreignLimit = Math.round(clampNum(league.foreignLimit ?? root.foreignLimit, DEFAULT_FOREIGN_LIMIT, 0, 25));
  const players: Record<string, Player> = {};
  const teams: Team[] = [];
  const filled: NormalizedRoster['filled'] = [];
  const seenIds = new Set<string>();
  // Conferences: take what the file says; teams without a recognizable value are spread so that both conferences stay even.
  const detected = rawTeams.map((t) => detectConference(t?.conference ?? t?.conf ?? t?.['конференция'], t?.division ?? t?.['дивизион']));
  let west = detected.filter((c) => c === 'Запад').length;
  let east = detected.filter((c) => c === 'Восток').length;
  const conferences: Conference[] = detected.map((c, i) => {
    if (c) return c;
    const given = rawTeams[i]?.conference ?? rawTeams[i]?.conf;
    const pick: Conference = west <= east ? 'Запад' : 'Восток';
    if (pick === 'Запад') west++;
    else east++;
    const tn = String(rawTeams[i]?.name ?? `Команда ${i + 1}`);
    warnings.push(given != null && String(given).trim() ? `«${tn}»: конференция «${given}» не распознана (нужно «Запад» или «Восток») — команда отнесена к конференции «${pick}»` : `«${tn}»: конференция не указана — команда отнесена к конференции «${pick}»`);
    return pick;
  });
  rawTeams.forEach((t, i) => {
    const name = String(t?.name ?? `Команда ${i + 1}`).trim();
    let id = String(t?.id ?? slug(name));
    while (seenIds.has(id)) id = id + '-2';
    seenIds.add(id);
    const rawPlayers: any[] = Array.isArray(t?.players) ? t.players : [];
    const ids: string[] = [];
    rawPlayers.forEach((p, j) => {
      const pl = normalizePlayer(p, id, j, id, warnings, (c) => filled.push({ team: i, player: j, contract: c }));
      let pid = pl.id;
      let k = 2;
      while (players[pid]) pid = `${pl.id}-${k++}`;
      pl.id = pid;
      players[pid] = pl;
      ids.push(pid);
    });
    if (rawPlayers.length < 15) warnings.push(`«${name}»: всего ${rawPlayers.length} игроков — рекомендуется 20–28 (12 нападающих, 6–8 защитников, 2 вратаря)`);
    const team: Team = {
      id,
      name,
      short: String(t?.short ?? SHORT_MAP[name] ?? name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 3).toUpperCase()),
      city: String(t?.city ?? ''),
      conference: conferences[i],
      division: String(t?.division ?? ''),
      primaryColor: String(t?.primaryColor ?? t?.color ?? PALETTE[i % PALETTE.length]),
      secondaryColor: String(t?.secondaryColor ?? '#FFFFFF'),
      budget: Math.max(0, num(t?.budget, DEFAULT_BUDGET)),
      players: ids,
      lineup: emptyLineup(),
      record: emptyRecord(),
      seed: null,
      deadCap: 0,
      capViolationDays: 0,
      capViolationGames: 0,
      capFinesTotal: 0,
    };
    team.lineup = autoLineup(ids, players, { foreignLimit: teamForeignLimit(team, foreignLimit) });
    teams.push(team);
  });
  const fas: string[] = [];
  const rawFA: any[] = Array.isArray(root.freeAgents) ? root.freeAgents : [];
  rawFA.forEach((p, j) => {
    const pl = normalizePlayer(p, null, j, 'fa', warnings);
    let pid = pl.id;
    let k = 2;
    while (players[pid]) pid = `${pl.id}-${k++}`;
    pl.id = pid;
    pl.contract = { salary: 0, years: 0 };
    players[pid] = pl;
    fas.push(pid);
  });
  const noGoalies = teams.filter((t) => t.players.filter((id) => isGoalie(players[id])).length === 0);
  if (noGoalies.length) warnings.push(`Нет вратарей: ${noGoalies.map((t) => t.name).join(', ')} — в матчах будет играть «замена» (рейтинг 55)`);
  return {
    leagueName: String(league.name ?? root.name ?? 'КХЛ'),
    season: String(league.season ?? root.season ?? '2025/26'),
    gamesPerTeam: Math.round(clampNum(league.gamesPerTeam ?? root.gamesPerTeam, DEFAULT_GAMES, 2, 120)),
    salaryCap: Math.max(1, num(league.salaryCap ?? root.salaryCap, DEFAULT_CAP)),
    foreignLimit,
    teams,
    players,
    freeAgents: fas,
    warnings,
    raw: root,
    filled,
  };
}

export function parseRosterText(text: string): NormalizedRoster {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error('Ошибка разбора JSON: ' + (e as Error).message);
  }
  return normalizeRoster(json);
}

export async function fetchRoster(url = './roster.json'): Promise<NormalizedRoster> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) throw new Error('Файл не похож на JSON (возможно, сервер вернул index.html вместо roster.json)');
  return parseRosterText(t);
}

export function readLocalFile(file: File): Promise<NormalizedRoster> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      try {
        resolve(parseRosterText(String(r.result)));
      } catch (e) {
        reject(e);
      }
    };
    r.onerror = () => reject(new Error('Не удалось прочитать файл'));
    r.readAsText(file);
  });
}

/** The roster file with the generated contracts written into it (everything else is left exactly as it was). */
export function rosterWithContracts(r: NormalizedRoster): string {
  const copy = JSON.parse(JSON.stringify(r.raw));
  for (const f of r.filled) {
    const p = copy?.teams?.[f.team]?.players?.[f.player];
    if (p && typeof p === 'object') p.contract = { ...(typeof p.contract === 'object' && p.contract ? p.contract : {}), salary: f.contract.salary, years: f.contract.years };
  }
  return JSON.stringify(copy, null, 2);
}

/** Write text to a file chosen by the user (overwriting roster.json in the game folder) or download it. */
export async function saveRosterFile(text: string): Promise<'saved' | 'downloaded' | 'cancelled'> {
  const w = window as unknown as { showSaveFilePicker?: (o: object) => Promise<{ createWritable: () => Promise<{ write: (t: string) => Promise<void>; close: () => Promise<void> }> }> };
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName: 'roster.json', types: [{ description: 'Ростер (JSON)', accept: { 'application/json': ['.json'] } }] });
      const out = await handle.createWritable();
      await out.write(text);
      await out.close();
      return 'saved';
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return 'cancelled';
      // not allowed in this context — fall back to a download
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = 'roster.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return 'downloaded';
}

export const ROSTER_EXAMPLE = `{
  "league": { "name": "КХЛ", "season": "2025/26", "gamesPerTeam": 68, "salaryCap": 900000000 },
  "teams": [
    {
      "id": "ska",
      "name": "СКА",
      "city": "Санкт-Петербург",
      "conference": "Запад",
      "division": "Боброва",
      "primaryColor": "#0A4FA3",
      "secondaryColor": "#FFFFFF",
      "budget": 1500000000,
      "players": [
        {
          "id": "ska-c01",
          "name": "Иван Примеров",
          "position": "Ц",            // Ц / ЛК / ПК / З / В  (или C / LW / RW / D / G)
          "age": 27,
          "height": 185,
          "weight": 92,
          "number": 17,
          "country": "Россия",
          "overall": 82,               // необязательно: если нет — считается из skills
          "potential": 84,             // необязательно, потолок развития (1–99)
          "skills": {                  // для полевых игроков
            "skating": 84, "shooting": 78, "passing": 88, "puckControl": 85, "checking": 62, "defense": 74
          },
          "contract": { "salary": 65000000, "years": 2 },
          "injury": null,              // или { "name": "Травма плеча", "games": 6 }
          "morale": 78
        },
        {
          "id": "ska-g01",
          "name": "Вратарей Голстоппер",
          "position": "В",
          "age": 29,
          "height": 190,
          "weight": 90,
          "number": 31,
          "overall": 83,
          "skills": {                  // для вратарей
            "reflexes": 86, "positioning": 84, "reboundControl": 80, "puckHandling": 65, "endurance": 82
          },
          "contract": { "salary": 80000000, "years": 1 }
        }
      ]
    },
    { "id": "cska", "name": "ЦСКА", "city": "Москва", "conference": "Запад", "players": [ ... ] }
  ],
  "freeAgents": [ { "id": "fa-01", "name": "...", "position": "З", "age": 31, "overall": 74, "skills": { ... } } ]
}`;

export function downloadExampleRoster() {
  const example = {
    league: { name: 'КХЛ', season: '2025/26', gamesPerTeam: 68, salaryCap: 900000000 },
    teams: [
      { id: 'ska', name: 'СКА', city: 'Санкт-Петербург', conference: 'Запад', division: 'Боброва', primaryColor: '#0A4FA3', secondaryColor: '#FFFFFF', budget: 1500000000, players: [
        { id: 'ska-c01', name: 'Иван Примеров', position: 'Ц', age: 27, height: 185, weight: 92, number: 17, country: 'Россия', overall: 82, potential: 84, skills: { skating: 84, shooting: 78, passing: 88, puckControl: 85, checking: 62, defense: 74 }, contract: { salary: 65000000, years: 2 }, injury: null, morale: 78 },
        { id: 'ska-g01', name: 'Вратарей Голстоппер', position: 'В', age: 29, height: 190, weight: 90, number: 31, country: 'Россия', overall: 83, potential: 83, skills: { reflexes: 86, positioning: 84, reboundControl: 80, puckHandling: 65, endurance: 82 }, contract: { salary: 80000000, years: 1 } },
        { id: 'ska-d01', name: 'Защитей Блюлайн', position: 'З', age: 25, height: 189, weight: 95, number: 7, country: 'Россия', overall: 79, potential: 82, skills: { skating: 80, shooting: 72, passing: 78, puckControl: 76, checking: 84, defense: 85 }, contract: { salary: 40000000, years: 3 } },
        { id: 'ska-lw01', name: 'Крайний Снайперов', position: 'ЛК', age: 23, height: 183, weight: 88, number: 91, country: 'Россия', overall: 78, potential: 86, skills: { skating: 85, shooting: 86, passing: 70, puckControl: 80, checking: 55, defense: 60 }, contract: { salary: 25000000, years: 2 } },
      ] },
      { id: 'cska', name: 'ЦСКА', city: 'Москва', conference: 'Запад', division: 'Боброва', primaryColor: '#D11F2F', secondaryColor: '#FFFFFF', budget: 1500000000, players: [
        { id: 'cska-c01', name: 'Центр Примерцев', position: 'Ц', age: 30, height: 186, weight: 93, number: 10, country: 'Россия', overall: 80, potential: 80, skills: { skating: 80, shooting: 80, passing: 84, puckControl: 82, checking: 65, defense: 76 }, contract: { salary: 55000000, years: 1 } },
        { id: 'cska-g01', name: 'Вратарь Второй', position: 'G', age: 26, height: 188, weight: 89, number: 30, country: 'Россия', overall: 79, potential: 82, skills: { reflexes: 82, positioning: 80, reboundControl: 77, puckHandling: 60, endurance: 78 }, contract: { salary: 35000000, years: 2 } },
      ] },
    ],
    freeAgents: [
      { id: 'fa-01', name: 'Свободный Агентов', position: 'ПК', age: 31, height: 184, weight: 90, number: 15, country: 'Россия', overall: 74, potential: 74, skills: { skating: 74, shooting: 78, passing: 70, puckControl: 72, checking: 68, defense: 64 } },
    ],
  };
  const blob = new Blob([JSON.stringify(example, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'roster.example.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
