export type PosCode = 'C' | 'LW' | 'RW' | 'D' | 'G';
export type Conference = 'Запад' | 'Восток';
export type Strength = 'EV' | 'PP' | 'SH' | 'EN' | '4v4' | 'SO';
export type ShotZone = 'crease' | 'slot' | 'circles' | 'point' | 'perimeter';
export type YouthTrainingPlan = 'balanced' | 'sniper' | 'playmaker' | 'twoway' | 'intensive' | 'goalie_reflex' | 'goalie_pos';
export type ForecheckStyle = 'aggressive' | 'balanced' | 'trap';
export type AttackStyle = 'shoot' | 'balanced' | 'cycle';
export type PullGoaliePolicy = 'early' | 'normal' | 'never';

export type CoachRole = 'head' | 'assistant';
export type CoachProfile = 'balanced' | 'attack' | 'defense' | 'development' | 'motivator';
/** Achievement bonus written into a contract: paid from the club budget (outside the cap) when reached. */
export type BonusKind = 'goals' | 'points' | 'games' | 'wins' | 'svpct' | 'shutouts' | 'playoffs' | 'round2' | 'confFinal' | 'final' | 'cup';
export interface ContractBonus { kind: BonusKind; target: number; amount: number }
/** What was agreed beyond the salary (kept for display and bonus payouts). */
export interface CoachContract { years: number; bonuses?: ContractBonus[]; signingBonus?: number; /** guaranteed powers: dismissal costs more */ guarantee?: boolean }
export type PlayerPitch = 'role' | 'ambition' | 'coach' | 'development' | 'relocation';
export type CoachPitch = 'ambition' | 'authority' | 'project' | 'staff';
export interface Coach {
  id: string;
  name: string;
  role: CoachRole;
  profile: CoachProfile;
  attack: number;
  defense: number;
  special: number;
  development: number;
  motivation: number;
  salary: number;
  fictional: boolean;
  source?: string;
  snapshot?: string;
  /** Specialisation caption from roster.json (e.g. «Плей-офф»); defaults to the profile label. */
  label?: string;
  /** photo URL from roster.json `face` */
  face?: string;
  contract?: CoachContract;
  acting?: boolean; // Interim head, including an assistant promoted in the career.
  actingFromAssistant?: boolean;
}
export type TeamFocus = 'balanced' | 'attack' | 'defense' | 'special' | 'recovery';
export type TeamIntervention = 'support' | 'demand' | 'bonding';
export interface TeamManagement {
  staffVersion?: number; // v2 preserves intentional vacancies and interim appointments.
  focus: TeamFocus;
  focusDays: number;
  load: number;
  cohesion: number;
  trust: number;
  familiarity: number;
  meetingCooldown: number;
  staffCooldown: Record<CoachRole, number>;
  disciplineDays: number;
  lastAction?: string;
}

export interface TeamTactics {
  forecheck: ForecheckStyle;
  style: AttackStyle;
  pullGoalie: PullGoaliePolicy;
  /** a tired starting goalie sits the game out and the fresh backup starts (undefined = on) */
  autoGoalie?: boolean;
}

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

export type InjurySeverity = 'minor' | 'moderate' | 'severe';

export interface Injury {
  name: string;
  /** remaining calendar days out */
  days: number;
  /** original duration in calendar days when sustained */
  totalDays?: number;
  severity?: InjurySeverity;
  /** schedule day index on which the injury occurred */
  daySustained?: number;
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

/**
 * One row of a player's career table: a season at one club in one stage (regular season / playoffs).
 * Rows written before per-club splits existed have no `kind` and cover the whole season (regular season + playoffs)
 * at the club the player finished it with; the detailed counters are optional for the same reason.
 */
export interface SeasonHistory {
  season: string;
  teamId: string | null;
  overall: number;
  gp: number;
  goals: number;
  assists: number;
  wins: number;
  shutouts: number;
  kind?: GameKind;
  plusMinus?: number;
  pim?: number;
  shots?: number;
  losses?: number;
  otl?: number;
  saves?: number;
  shotsAgainst?: number;
  minutes?: number;
}

/** Current-season statistics of a player at one club in one stage; summed over all splits they equal `Player.stats`. */
export interface StatSplit extends PlayerStats {
  teamId: string;
  kind: GameKind;
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
  /** photo URL from roster.json `face` (optional; an initials badge is shown without it) */
  face?: string;
  overall: number;
  potential: number;
  skills: Skills;
  /** years = seasons left including the current one; twoWay = KHL/VHL two-way deal (free VHL moves without waivers); next = extension */
  contract: { salary: number; years: number; twoWay?: boolean; bonuses?: ContractBonus[]; next?: { salary: number; years: number; twoWay?: boolean; bonuses?: ContractBonus[] } };
  /** negotiation state for the current window: patience, interest won by pitches, pitches already used */
  talks?: { key: string; left: number; boost?: number; pitched?: PlayerPitch[]; promise?: boolean; notes?: string[] };
  /** a role promised at signing (first two lines / pairs, starting goalie); checked at the end of the regular season */
  promise?: { season: number };
  /** manager's trade note: on the block / not for sale */
  tradeFlag?: 'block' | 'keep';
  /** youth development training focus (for players aged <= 23) */
  trainingPlan?: YouthTrainingPlan;
  /** accumulated in-season youth development progress (0..100) */
  trainingXp?: number;
  /** skill increases gained during the current season */
  seasonGrowth?: Record<string, number>;
  /** goalie / travel fatigue (0 = 100% fresh, 100 = exhausted) */
  fatigue?: number;
  /** assigned to the club's VHL farm team */
  inVhl?: boolean;
  /** No-Move Clause (запрет на обмен и драфт отказов) */
  nmc?: boolean;
  /** KHL club holding RFA sports rights (for players < 28) */
  rightsTeamId?: string | null;
  /** placed in KHL Long-Term Injured Reserve (ДСБТ — 14+ day injury, 100% cap relief) */
  inLtir?: boolean;
  /** cleared to play «на уколах» in playoffs despite a minor (<=6 day) injury */
  playingThroughInjury?: boolean;
  injury: Injury | null;
  morale: number;
  teamId: string | null;
  stats: PlayerStats;
  /** current season by club and stage (filled as games are committed; rebuilt from the schedule for older saves) */
  seasonSplits?: StatSplit[];
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
  /** KHL U20 young-player extra match slot: 13th forward */
  u20F?: string | null;
  /** KHL U20 young-player extra match slot: 7th defenseman */
  u20D?: string | null;
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

export type FacilityKey = 'medical' | 'academy' | 'arena' | 'scouting';

export interface ClubFacilities {
  /** Medical & rehab center level (1..5): shorter injuries & faster goalie recovery */
  medical: number;
  /** MHL academy & player development staff (1..5): faster U23 growth & better draft prospects */
  academy: number;
  /** Home arena & commercial department (1..5): live gate revenue on every home game */
  arena: number;
  /** Scouting & analytics hub (1..5): tighter draft potential intel & softer FA talks */
  scouting: number;
}

export interface AllStarResult {
  season: string;
  day: number;
  westScore: number;
  eastScore: number;
  mvpId: string;
  fastestSkaterId: string;
  hardestShotId: string;
  westRoster: string[];
  eastRoster: string[];
  userSelectedIds: string[];
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
  /** Optional custom logo URL or relative path (KHL clubs use built-in logos automatically). */
  logo?: string;
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
  /** team captain player ID */
  captainId?: string | null;
  /** up to two assistant captains */
  assistantIds?: string[];
  /** bench & tactical preset */
  tactics?: TeamTactics;
  /** games played together by forward trios and D pairs */
  chemGP?: Record<string, number>;
  /** consecutive away matches played */
  roadStreak?: number;
  /** club infrastructure & staff levels (1..5) */
  facilities?: ClubFacilities;
  /** Persistent staff and team-wide preparation; optional for legacy saves. */
  coaches?: Coach[];
  management?: TeamManagement;
  /** cumulative live home-gate revenue earned during the current season */
  seasonGateRevenue?: number;
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
  /** the KHL kind of the penalty (minor, bench minor, double minor, major, misconduct, game misconduct, match penalty) */
  penKind?: 'minor' | 'bench' | 'double' | 'major' | 'misconduct' | 'game' | 'match';
  /** the penalized player takes no further part in the match */
  ejected?: boolean;
  /** the penalty's length as the scoreboard writes it ("2 мин", "2+2 мин", "5 мин + ДдКМ", "2+10 мин", "ДдКМ") */
  penLen?: string;
  /** how the puck went in — classified by the engine from the shooter's context (visual variety for the 3D replay) */
  shotType?: 'wrist' | 'slap' | 'snap' | 'backhand' | 'tip' | 'rebound';
  /** penalty: it gives the opponent a power play; goal: it was scored on the power play (also into an empty net) */
  pp?: boolean;
  /** absolute game second until which each team [home, away] is short-handed, as of this event */
  penUntil?: [number, number];
  /** penalty box after this event: [start, end] (absolute seconds) of every pending penalty per team */
  box?: [[number, number][], [number, number][]];
  /** penalty events: absolute second at which this player's penalty ends */
  boxUntil?: number;
  /** skaters on the ice [home, away] at the moment of a shot */
  ice?: [(string | null)[], (string | null)[]];
  /** shootout tally [home, away] after this attempt (and the final one on the event that ends the shootout) */
  so?: [number, number];
  /** shootout round of the attempt (1-3 regular, 4+ sudden death) */
  round?: number;
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

export interface HallOfFameEntry {
  id: string;
  name: string;
  position: PosCode;
  number: number;
  teamId: string | null;
  teamName: string;
  retiredSeason: string;
  age: number;
  peakOverall: number;
  gp: number;
  goals: number;
  assists: number;
  wins: number;
  shutouts: number;
  jerseyRetired: boolean;
}

export interface DraftProspectMeta {
  id: string;
  /** «Готов к КХЛ» is the stored value (saves keep it); the UI shows it with the career's league name. */
  tag: 'Топ-проспект' | 'Готов к КХЛ' | 'Выпускник МХЛ' | 'Тёмная лошадка';
  grade: string;
  potRange: [number, number];
  school: string;
}

export interface DraftPickRecord {
  overallPick: number;
  round: number;
  teamId: string;
  playerId: string;
}

export interface JuniorDraftState {
  rounds: number;
  pickIndex: number;
  order: string[];
  prospects: DraftProspectMeta[];
  picks: DraftPickRecord[];
  completed: boolean;
}

export interface WaiverItem {
  playerId: string;
  fromTeamId: string;
  postedDay: number;
  expiresDay: number;
}

export interface RfaOfferSheet {
  id: number;
  playerId: string;
  fromTeamId: string;
  rightsTeamId: string;
  salary: number;
  years: number;
  compensation: number;
  day: number;
}

export interface OffseasonPlan {
  expiring: string[];
  progressions: { id: string; from: number; to: number; plan?: YouthTrainingPlan }[];
  revenue: number;
  retired?: HallOfFameEntry[];
  draft?: JuniorDraftState;
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

/** The mod (folder in `mods/`) a career was started from. */
export interface ModRef {
  /** folder name in `mods/` */
  id: string;
  /** name shown to the player */
  name: string;
  /** folder the mod's relative paths (logos, photos) are resolved against, e.g. `./mods/KHL_2627` */
  base: string;
  /** roster file re-read when the career is opened (names, numbers, photos); null — no file to follow */
  roster: string | null;
}

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
  /** league & club Hall of Fame of retired legends */
  hallOfFame?: HallOfFameEntry[];
  /** active 48-hour KHL waiver wire entries */
  waivers?: WaiverItem[];
  /** incoming RFA offer sheets awaiting the user's decision */
  rfaOffers?: RfaOfferSheet[];
  /** Free coaches persist across seasons, including dismissed real specialists. */
  coachMarket?: Coach[];
  /** negotiation windows with free coaches (by coach id) */
  coachTalks?: Record<string, { key: string; left: number; boost?: number; pitched?: CoachPitch[]; notes?: string[] }>;
  coachMarketVersion?: number;
  /** 'roster': free coaches came from roster.json `freeCoaches`; otherwise the built-in fallback list. */
  coachMarketSource?: 'roster' | 'builtin';
  /** Mod the career was started from. Careers saved before mods existed have none: they follow mods/KHL_2627. */
  mod?: ModRef;
  /** photos (`face`) were copied from roster.json into this career (older saves predate the field) */
  facesSynced?: boolean;
  /** season whose `Player.seasonSplits` are being kept (older saves lack it and get the splits rebuilt) */
  splitsSeason?: string;
  /** KHL All-Star Weekend result for the current season */
  allStar?: AllStarResult | null;
  /** fan support 0..100: gate revenue, press reactions */
  fans?: number;
  /** what the user's scouts know about players of other clubs */
  scouting?: ScoutingState;
  /** user's trade block: what we look for and (via tradeFlag) whom we offer */
  tradeBlock?: TradeBlock;
  /** pending post-match press conference */
  press?: PressConference | null;
  /** dressing-room situations waiting for the manager */
  roomEvents?: ClubEvent[];
  /** promises made to players (wishes, conflicts, press) */
  roomPromises?: RoomPromise[];
  roomMemory?: RoomMemory;
  /** August preseason tournament of the current season */
  preseason?: PreseasonState | null;
  /** inbox tasks dismissed by the user: task id -> day */
  inboxDismissed?: Record<string, number>;
}

export interface ScoutAssignment {
  kind: 'player' | 'team';
  /** player id or team id */
  target: string;
  since: number;
}

export interface ScoutingState {
  /** player id -> 0..100 accumulated scouting knowledge */
  knowledge: Record<string, number>;
  assignments: ScoutAssignment[];
}

export interface TradeBlockWants {
  positions: PosCode[];
  minOvr: number;
  maxAge: number;
  /** max salary per season in rubles, 0 = any */
  maxSalary: number;
}

export interface TradeBlock {
  wants: TradeBlockWants;
  /** day of the last "ask the league" round */
  lastShopDay?: number;
}

export interface PressEffect {
  morale: number;
  board: number;
  fans: number;
  playerId?: string;
  playerMorale?: number;
  /** morale changes of other players (id -> delta) */
  players?: Record<string, number>;
  /** club budget change in rubles (fines, team-building, donations) */
  budget?: number;
  /** a promise to `playerId` (checked over the next games / days) */
  promise?: RoomPromiseSpec;
  /** remembered by the media and the dressing room for follow-up questions and consequences */
  tag?: string;
  /** manager's trade note for `playerId` */
  tradeFlag?: 'block' | 'keep' | null;
  /** captaincy for `playerId` */
  role?: 'C' | 'A';
  /** youth development progress for `playerId` (mentoring) */
  trainingXp?: number;
  /** fatigue relief for the whole team (lighter practices) */
  rest?: number;
}

export interface PressOption {
  id: string;
  text: string;
  effects: PressEffect;
  /** short note on what happens next (shown under the answer) */
  hint?: string;
}

export interface PressQuestion {
  topic: string;
  question: string;
  options: PressOption[];
  /** journalist and outlet asking the question */
  reporter?: string;
}

export interface PressConference {
  id: number;
  day: number;
  gameId: number;
  /** current question (older saves have only this one) */
  topic: string;
  question: string;
  options: PressOption[];
  reporter?: string;
  /** post-match (default) or pre-match press conference */
  kind?: 'post' | 'pre';
  /** headline of the whole press conference, e.g. «После матча с «Динамо» (3:2)» */
  title?: string;
  /** questions still to come */
  queue?: PressQuestion[];
  /** number of the current question (1-based) and the total */
  step?: number;
  total?: number;
  /** effects of the answers given so far */
  totals?: { morale: number; board: number; fans: number };
}

/** What a manager can promise a player; checked by the dressing room over the next games or days. */
export type RoomPromiseKind = 'role' | 'pp' | 'starts' | 'dress' | 'rest' | 'scratch' | 'linemate' | 'extend' | 'callup';

export interface RoomPromiseSpec {
  kind: RoomPromiseKind;
  playerId: string;
  /** second player (linemate) */
  otherId?: string;
}

export interface RoomPromise extends RoomPromiseSpec {
  id: number;
  made: number;
  /** day by which the promise must be kept */
  due: number;
  /** games to judge by (0 = judged by a state reached before `due`) */
  target: number;
  /** user games played by the healthy player since the promise / games the promise was honoured in */
  played: number;
  hits: number;
  /** contract snapshot for 'extend' */
  base?: number;
}

export type ClubEventKind = 'wish' | 'conflict' | 'agent' | 'fans' | 'media' | 'team';

/** A dressing-room / club situation that needs the manager's decision. */
export interface ClubEvent {
  id: number;
  /** generator key (cooldowns) */
  key: string;
  day: number;
  /** last day to answer; afterwards `fallback` is applied */
  expires: number;
  kind: ClubEventKind;
  title: string;
  text: string;
  playerIds: string[];
  options: PressOption[];
  /** option applied when the manager does not answer in time */
  fallback: string;
}

export interface RoomMemory {
  /** generator key -> day it last fired */
  cool: Record<string, number>;
  /** remembered answers / incidents -> day */
  tags: Record<string, number>;
  seq: number;
}

export interface PreseasonGame {
  home: string;
  away: string;
  date: string;
  result?: { home: number; away: number; ot?: boolean; so?: boolean; scorers: string[] };
}

export interface PreseasonState {
  season: string;
  name: string;
  host: string;
  city: string;
  teams: string[];
  games: PreseasonGame[];
  done: boolean;
  champion?: string;
  /** players tried out in the user's games */
  tested: string[];
}
