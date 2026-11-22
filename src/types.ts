export type PosCode = 'C' | 'LW' | 'RW' | 'D' | 'G';
export type Conference = 'Запад' | 'Восток';
export type Strength = 'EV' | 'PP' | 'SH' | 'EN' | '4v4' | 'SO';
export type ShotZone = 'crease' | 'slot' | 'circles' | 'point' | 'perimeter';
export type YouthTrainingPlan = 'balanced' | 'sniper' | 'playmaker' | 'twoway' | 'intensive' | 'goalie_reflex' | 'goalie_pos';

export interface Skills {
  skating?: number;
  shooting?: number;
  passing?: number;
  puckControl?: number;
  checking?: number;
  defense?: number;
  reflexes?: number;
  positioning?: number;
  reboundControl?: number;
  puckHandling?: number;
  endurance?: number;
}

export interface Injury {
  name: string;
  games: number;
}

export interface PlayerStats {
  gp: number;
  goals: number;
  assists: number;
  plusMinus: number;
  pim: number;
  shots: number;
  wins: number;
  losses: number;
  otl: number;
  shutouts: number;
  saves: number;
  shotsAgainst: number;
  minutes: number;
}

export interface SeasonHistory {
  season: string;
  teamId: string | null;
  overall: number;
  gp: number;
  goals: number;
  assists: number;
  wins: number;
  shutouts: number;
}

export interface Player {
  id: string;
  name: string;
  position: PosCode;
  age: number;
  height: number;
  weight: number;
  number: number;
  country: string;
  hand: 'L' | 'R';
  overall: number;
  potential: number;
  skills: Skills;
  /** years = seasons left including the current one; next = extension that starts when this deal runs out */
  contract: { salary: number; years: number; next?: { salary: number; years: number } };
  /** negotiation patience for the current window */
  talks?: { key: string; left: number };
  /** manager's trade note: on the block / not for sale */
  tradeFlag?: 'block' | 'keep';
  /** youth development training focus (for players aged <= 23) */
  trainingPlan?: YouthTrainingPlan;
  /** accumulated in-season youth development progress (0..100) */
  trainingXp?: number;
  /** skill increases gained during the current season */
  seasonGrowth?: Record<string, number>;
  injury: Injury | null;
  morale: number;
  teamId: string | null;
  stats: PlayerStats;
  history: SeasonHistory[];
}

export interface Lineup {
  F: (string | null)[][]; // 4 lines × [C, LW, RW]
  D: (string | null)[][]; // 3 pairs × [D, D]
  pp1: (string | null)[];
  pp2: (string | null)[];
  pk1: (string | null)[];
  pk2: (string | null)[];
  starterG: string | null;
  backupG: string | null;
}

export interface TeamRecord {
  gp: number;
  w: number;
  otw: number;
  sow: number;
  otl: number;
  sol: number;
  l: number;
  gf: number;
  ga: number;
  points: number;
  streak: number;
  streakType: 'W' | 'L' | null;
  last: string[];
  /** standings points deducted by the league for salary cap violations */
  capPenaltyPoints?: number;
}

export interface Team {
  id: string;
  name: string;
  short: string;
  city: string;
  conference: Conference;
  division: string;
  primaryColor: string;
  secondaryColor: string;
  budget: number;
  players: string[];
  lineup: Lineup;
  record: TeamRecord;
  seed: number | null;
  /** buyout dead-money penalty counted against this season's salary cap */
  deadCap?: number;
  /** days spent above the salary cap this season */
  capViolationDays?: number;
  /** matches played while above the salary cap */
  capViolationGames?: number;
  /** total league fines paid this season for cap violations */
  capFinesTotal?: number;
}

export type GameKind = 'regular' | 'playoff';

export interface Game {
  id: number;
  day: number;
  home: string;
  away: string;
  played: boolean;
  result: GameResult | null;
  kind: GameKind;
  seriesId: number | null;
}

export type EventType = 'period_start' | 'period_end' | 'goal' | 'shot' | 'miss' | 'penalty' | 'hit' | 'so_goal' | 'so_miss' | 'info';

export interface GameEvent {
  sec: number;
  period: number;
  time: string;
  type: EventType;
  team: string | null;
  player?: string;
  players?: string[];
  text: string;
  strength?: Strength;
  score?: [number, number];
  lines?: [number, number];
  /** goalie who faced the shot (null = empty net) */
  goalie?: string | null;
  /** penalty minutes of this penalty */
  pim?: number;
  /** how the puck went in — classified by the engine from the shooter's context (visual variety for the 3D replay) */
  shotType?: 'wrist' | 'slap' | 'snap' | 'backhand' | 'tip' | 'rebound';
  /** penalty: it gives the opponent a power play; goal: it was scored on the power play (also into an empty net) */
  pp?: boolean;
  /** absolute game second until which each team [home, away] is short-handed, as of this event */
  penUntil?: [number, number];
  /** skaters on the ice [home, away] at the moment of a shot */
  ice?: [(string | null)[], (string | null)[]];
  /** shootout result, on the event that ends the shootout */
  so?: [number, number];
  /** rink shot coordinates 0..100 (away attacks left net x=7, home attacks right net x=93) */
  x?: number;
  y?: number;
  /** expected goal probability of this shot (0..1) */
  xg?: number;
  /** rink zone of the shot */
  zone?: ShotZone;
}

export interface ShotPoint {
  /** 0 = home, 1 = away */
  t: 0 | 1;
  x: number;
  y: number;
  xg: number;
  zone: ShotZone;
  outcome: 'goal' | 'save' | 'miss';
  period: number;
  time: string;
  player?: string;
  shotType?: GameEvent['shotType'];
  strength?: Strength;
}

export interface TeamGameStats {
  shots: number;
  ppGoals: number;
  ppChances: number;
  pim: number;
  hits: number;
  xg?: number;
  dangerShots?: number;
}

export interface PlayerGameLine {
  id: string;
  goals: number;
  assists: number;
  plusMinus: number;
  pim: number;
  shots: number;
  saves: number;
  shotsAgainst: number;
  goalsAgainst: number;
  minutes: number;
}

export interface ScoringPlay {
  period: number;
  time: string;
  team: string;
  scorer: string;
  assists: string[];
  strength: Strength;
}

export interface GameResult {
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
  ot: boolean;
  so: boolean;
  periods: number;
  periodScores: [number, number][];
  homeStats: TeamGameStats;
  awayStats: TeamGameStats;
  events: GameEvent[];
  scorers: ScoringPlay[];
  lines: Record<string, PlayerGameLine>;
  homeGoalie: string | null;
  awayGoalie: string | null;
  homeDressed: string[];
  awayDressed: string[];
  stars: string[];
  /** shot coordinates and xG for the mini-map and heatmap */
  shotMap?: ShotPoint[];
}

export type NewsType = 'result' | 'injury' | 'trade' | 'offer' | 'info' | 'milestone' | 'playoff';

export interface NewsItem {
  id: number;
  day: number;
  type: NewsType;
  text: string;
  team?: string;
  game?: number;
}

export interface TradeOffer {
  id: number;
  from: string;
  give: string[];
  get: string[];
  expires: number;
  day: number;
  /** why the club makes the offer */
  reason?: string;
}

export interface Series {
  id: number;
  round: number; // 0 = 1/8, 1 = 1/4, 2 = conf final, 3 = final
  conf: Conference | 'Финал';
  high: string;
  low: string;
  wins: [number, number];
  games: number[];
  done: boolean;
  winner: string | null;
}

export interface Playoffs {
  round: number;
  series: Series[];
  champion: string | null;
  mvp: string | null;
  awards: Award[];
}

export interface Award {
  title: string;
  player: string;
  team: string;
  value: string;
}

export type BoardGoal = 'semis' | 'round2' | 'playoffs' | 'top10';
export interface Board {
  goal: BoardGoal;
  text: string;
  /** strength rank of the roster when the objective was set */
  rank: number;
  confidence: number;
  last?: { season: string; verdict: 'exceeded' | 'met' | 'failed'; text: string; bonus: number };
}

export interface SeasonSummary {
  season: string;
  champion: string;
  regularWinner: string;
  userResult: string;
  userPoints: number;
  userPlace: number;
  awards: Award[];
  revenue?: number;
  payroll?: number;
  board?: string;
  boardBonus?: number;
}

export interface OffseasonPlan {
  expiring: string[];
  progressions: { id: string; from: number; to: number; plan?: YouthTrainingPlan }[];
  revenue: number;
}

export interface LeagueInfo {
  name: string;
  season: string;
  gamesPerTeam: number;
  salaryCap: number;
  /** max foreign (non-EAEU) players for Russian KHL clubs (default 5) */
  foreignLimit?: number;
}

export type Phase = 'season' | 'playoffs' | 'offseason';

export interface GameState {
  version: number;
  saveId: string;
  saveName: string;
  createdAt: number;
  league: LeagueInfo;
  seasonNumber: number;
  teams: Record<string, Team>;
  teamOrder: string[];
  players: Record<string, Player>;
  freeAgents: string[];
  schedule: Game[][];
  day: number;
  nextGameId: number;
  userTeamId: string;
  phase: Phase;
  news: NewsItem[];
  offers: TradeOffer[];
  playoffs: Playoffs | null;
  trophies: { season: string; title: string }[];
  summaries: SeasonSummary[];
  offseason: OffseasonPlan | null;
  board: Board;
  /** the trade deadline of the current season has been announced */
  deadlinePassed?: boolean;
  /** announced trade window transitions during the current season */
  announcedWindows?: string[];
}
