// Name of the game and of the league when a mod's roster doesn't name one.
// Storage keys (khl.*), the save format id, IndexedDB names, the Windows profile folder (%APPDATA%\KHL-GM) and the
// Android package id are deliberately left as they were: renaming them would orphan existing careers and stop new
// versions from installing over old ones. Everything the player sees (downloads, the .exe, shortcuts, exported
// files) carries the game's name.

export const GAME_NAME_RU = 'Хоккейный Симулятор Менеджера';
export const GAME_NAME_EN = 'Hockey Simulator Manager';
export const GAME_NAME = `${GAME_NAME_RU} – ${GAME_NAME_EN}`;

/** League name used when the roster has no `league.name`. */
export const DEFAULT_LEAGUE_NAME = 'ХЛ';
export const DEFAULT_LEAGUE_FULL_NAME = 'Хоккейная Лига';

/** League name of a career or roster: `league.name` from the mod's roster, otherwise «ХЛ». */
export function leagueName(s?: { league?: { name?: string } | null } | null): string {
  const n = s?.league?.name;
  return (typeof n === 'string' && n.trim()) || DEFAULT_LEAGUE_NAME;
}

/**
 * The second (farm) league, where the clubs send players on two-way contracts: `league.farm` in the mod's roster
 * (a mod is expected to name it; without it the roster gets a warning and this name is used).
 */
export const DEFAULT_FARM_NAME = 'ВХЛ';

/** Farm league name of a career or roster: `league.farm` from the mod's roster, otherwise «ВХЛ». */
export function farmName(s?: { league?: { farm?: string } | null } | null): string {
  const n = s?.league?.farm;
  return (typeof n === 'string' && n.trim()) || DEFAULT_FARM_NAME;
}

let currentLeague: string | null = null;
let currentFarm: string | null = null;
/** Remember the leagues of the open career (called by the game store; null when back in the main menu). */
export function setCurrentLeague(name?: string | null, farm?: string | null): void {
  currentLeague = (typeof name === 'string' && name.trim()) || null;
  currentFarm = (typeof farm === 'string' && farm.trim()) || null;
}
/** Farm league name of the open career, for texts built where the state isn't at hand («ВХЛ» when none). */
export function FL(): string {
  return currentFarm || DEFAULT_FARM_NAME;
}
/** League name of the open career, for texts built where the state isn't at hand («ХЛ» when none). */
export function LG(): string {
  return currentLeague || DEFAULT_LEAGUE_NAME;
}
