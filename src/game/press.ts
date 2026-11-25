import type { Game, GameResult, GameState, Player, PressConference, PressEffect, PressOption, PressQuestion, Team } from '../types';
import { clamp, isGoalie } from './ratings';
import { getDerby } from './derbies';
import { isLegionnaire } from './legionnaires';
import { applyEffects, fx, lastName, promiseLabel, recalled, recalledAll, remember, roomMemory } from './dressingRoom';

/**
 * Press conferences. After every match (and before the big ones) two or three journalists ask about what
 * just happened and about life around the club: streaks, heroes, goalies, the standings, unhappy players,
 * rumours, the owners' patience — and about the manager's own words from earlier press conferences.
 * Every answer moves the dressing room (morale), the owners (board confidence) and the stands (fans).
 */

let pressSeq = 1;
const opt = (id: string, text: string, effects: PressEffect, hint?: string): PressOption => ({ id, text, effects, ...(hint ? { hint } : {}) });
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

type Style = 'sharp' | 'analyst' | 'tv' | 'fan' | 'local';
const REPORTERS: { name: string; outlet: string; style: Style }[] = [
  { name: 'Павел Лаптев', outlet: '«Чемпионат»', style: 'sharp' },
  { name: 'Алексей Гуров', outlet: '«Советский спорт»', style: 'sharp' },
  { name: 'Ирина Ветрова', outlet: '«Спорт-Экспресс»', style: 'analyst' },
  { name: 'Сергей Ким', outlet: '«Р-Спорт»', style: 'analyst' },
  { name: 'Дмитрий Сорокин', outlet: '«Матч ТВ»', style: 'tv' },
  { name: 'Мария Белова', outlet: 'KHL TV', style: 'tv' },
  { name: 'Никита Орлов', outlet: 'Sports.ru', style: 'fan' },
  { name: 'Олег Панов', outlet: '', style: 'local' },
];

interface Ctx {
  s: GameState;
  g: Game;
  T: Team;
  opp: Team;
  P: Record<string, Player>;
  pre: boolean;
  res: GameResult | null;
  us: number;
  them: number;
  won: boolean;
  diff: number;
  score: string;
  streak: number;
  winStreak: number;
  myXg: number;
  oppXg: number;
  my: GameResult['homeStats'] | null;
  goalieId: string | null;
  derby: ReturnType<typeof getDerby>;
  /** score after two periods (us, them) */
  after2: [number, number];
  myIds: string[];
  rank: number;
  oppRank: number;
}

interface Topic {
  key: string;
  /** result topics compete for the first question; context topics fill the rest */
  main: boolean;
  /** first-question priority (main) or pick weight (context) */
  w: number;
  style?: Style;
  q: () => Omit<PressQuestion, 'reporter'> | null;
}

function confRank(s: GameState, t: Team): number {
  const conf = Object.values(s.teams).filter((x) => x.conference === t.conference);
  conf.sort((a, b) => b.record.points - a.record.points || (b.record.gf - b.record.ga) - (a.record.gf - a.record.ga));
  return conf.findIndex((x) => x.id === t.id) + 1;
}

function buildCtx(s: GameState, g: Game, res: GameResult | null): Ctx {
  const U = s.userTeamId, home = g.home === U, P = s.players;
  const T = s.teams[U], opp = s.teams[home ? g.away : g.home];
  const us = res ? (home ? res.homeScore : res.awayScore) : 0, them = res ? (home ? res.awayScore : res.homeScore) : 0;
  const ps = res?.periodScores ?? [];
  const a2 = ps.slice(0, 2).reduce<[number, number]>((a, p) => [a[0] + (home ? p[0] : p[1]), a[1] + (home ? p[1] : p[0])], [0, 0]);
  return {
    s, g, T, opp, P, pre: !res, res, us, them, won: us > them, diff: us - them, score: `${us}:${them}`,
    streak: T.record.streakType === 'L' ? T.record.streak : 0,
    winStreak: T.record.streakType === 'W' ? T.record.streak : 0,
    myXg: res ? ((home ? res.homeStats.xg : res.awayStats.xg) ?? 0) : 0,
    oppXg: res ? ((home ? res.awayStats.xg : res.homeStats.xg) ?? 0) : 0,
    my: res ? (home ? res.homeStats : res.awayStats) : null,
    goalieId: res ? (home ? res.homeGoalie : res.awayGoalie) : null,
    derby: getDerby(s.teams[g.home], s.teams[g.away]),
    after2: a2,
    myIds: res ? (home ? res.homeDressed : res.awayDressed) : [],
    rank: confRank(s, T),
    oppRank: confRank(s, opp),
  };
}

/* ---------------- post-match: result topics ---------------- */
function resultTopics(c: Ctx): Topic[] {
  const { s, T, opp, P, res, score, won, diff } = c;
  if (!res) return [];
  const out: Topic[] = [];
  const line = (id: string) => res.lines[id];
  const gl = c.goalieId ? line(c.goalieId) : null;
  const hero = c.myIds.map((id) => ({ id, l: line(id) })).filter((x) => x.l && P[x.id] && !isGoalie(P[x.id])).sort((a, b) => b.l.goals * 2 + b.l.assists - (a.l.goals * 2 + a.l.assists))[0];
  const heroPts = hero ? hero.l.goals + hero.l.assists : 0;
  const series = c.g.seriesId != null ? s.playoffs?.series.find((x) => x.id === c.g.seriesId) : undefined;
  const sw = series ? (series.high === T.id ? series.wins : [series.wins[1], series.wins[0]]) : null;

  if (series && sw && series.done) {
    const weWon = series.winner === T.id;
    out.push({
      key: weWon ? 'series-won' : 'eliminated', main: true, w: 12, style: weWon ? 'tv' : 'sharp',
      q: () => weWon
        ? {
            topic: 'Серия выиграна',
            question: pick([`Вы прошли «${opp.short}» — ${sw[0]}:${sw[1]} в серии. Что стало ключом?`, `Серия с «${opp.short}» позади (${sw[0]}:${sw[1]}). На что рассчитываете дальше?`]),
            options: [
              opt('character', 'Характер. Эта команда умеет терпеть.', fx({ morale: 3, fans: 2 })),
              opt('next', 'Радоваться будем летом. Впереди следующий раунд.', fx({ morale: 1, board: 2 })),
              opt('fans', 'Наши болельщики — седьмой игрок. Эта серия — их.', fx({ morale: 1, fans: 4 })),
            ],
          }
        : {
            topic: 'Вылет из плей-офф',
            question: pick([`Сезон для «${T.short}» окончен (${sw[0]}:${sw[1]} в серии с «${opp.short}»). Что не получилось?`, `Вы уступили серию «${opp.short}». Останетесь у руля команды?`]),
            options: [
              opt('self', 'Ответственность на мне. Выводы сделаю я первым.', fx({ morale: 2, board: -1, fans: 2 })),
              opt('proud', 'Я горжусь ребятами — они отдали всё.', fx({ morale: 3, board: -1, fans: 1 })),
              opt('changes', 'Этой команде нужны перемены. Летом они будут.', fx({ morale: -3, board: 3, fans: 1 })),
            ],
          },
    });
  } else if (series && sw) {
    const [a, b] = sw;
    out.push({
      key: 'playoff-game', main: true, w: 8, style: 'analyst',
      q: () => ({
        topic: `Плей-офф: ${a}:${b} в серии`,
        question: a > b
          ? pick([`Счёт в серии ${a}:${b}. Чего не хватает, чтобы закрыть «${opp.short}»?`, `Вы ведёте ${a}:${b}. Не боитесь расслабиться?`])
          : a < b
            ? pick([`${a}:${b} в серии — вы на грани. Чем ответите?`, `«${opp.short}» ведёт ${b}:${a}. Будут перестановки?`])
            : `В серии ${a}:${b}. Кто сейчас психологически сильнее?`,
        options: a >= b
          ? [
              opt('focus', 'Ничего не решено. Следующий матч — самый важный.', fx({ morale: 2, board: 1 })),
              opt('confident', 'Мы сильнее и докажем это.', fx({ morale: 3, fans: 2, board: -1, tag: 'press:favorite' })),
              opt('respect', `«${opp.short}» — достойный соперник, будет тяжело.`, fx({ morale: 1, fans: -1, board: 1 })),
            ]
          : [
              opt('believe', 'Мы ещё не сказали последнего слова.', fx({ morale: 3, fans: 2 })),
              opt('changes', 'Перестановки будут. Кто-то не тянет плей-офф.', fx({ morale: -3, board: 2 })),
              opt('calm', 'Серия длинная. Паники нет.', fx({ morale: 1, board: 0, fans: -1 })),
            ],
      }),
    });
  }
  if (!won && c.streak >= 3)
    out.push({
      key: 'lose-streak', main: true, w: 9, style: 'sharp',
      q: () => ({
        topic: 'Серия поражений',
        question: pick([
          `«${T.short}» проиграл ${c.streak} ${plural(c.streak, 'матч', 'матча', 'матчей')} подряд (${score} с «${opp.short}»). Вы чувствуете давление руководства?`,
          `${c.streak} ${plural(c.streak, 'поражение', 'поражения', 'поражений')} подряд. Это кризис?`,
          `Болельщики уже требуют перемен после ${c.streak} поражений подряд. Что скажете им?`,
        ]),
        options: [
          opt('blame-self', 'Вся ответственность на мне. Команду не трогайте.', fx({ morale: 3, board: -2, fans: 1 })),
          opt('blame-players', 'Некоторым игрокам пора вспомнить, за какой клуб они играют.', fx({ morale: -4, board: 2, fans: 2, tag: 'press:blame' })),
          opt('luck', 'По моментам мы не хуже. Цифры на нашей стороне, результат придёт.', fx({ morale: 1, board: -1, fans: -2 })),
        ],
      }),
    });
  if (gl && gl.goalsAgainst >= 5 && c.goalieId) {
    const id = c.goalieId, n = P[id]?.name ?? 'вратарь';
    out.push({
      key: 'goalie-bad', main: true, w: 8, style: 'sharp',
      q: () => ({
        topic: 'Вопрос по вратарю',
        question: pick([`${n} пропустил ${gl.goalsAgainst} шайб. Будут перемены в воротах?`, `${gl.goalsAgainst} ${plural(gl.goalsAgainst, 'гол', 'гола', 'голов')} в ворота ${lastName(P[id])}. Вратарь — главный виноватый?`]),
        options: [
          opt('trust', `Я доверяю ${lastName(P[id])}. Он вытащит нам ещё не один матч.`, fx({ morale: 1, board: -1, fans: -1, playerId: id, playerMorale: 6 })),
          opt('compete', 'Конкуренция открыта: сыграет тот, кто лучше готов.', fx({ board: 2, fans: 1, playerId: id, playerMorale: -6 })),
          opt('team', 'Вратарь не виноват — мы бросили его без защиты.', fx({ morale: 2, playerId: id, playerMorale: 3 })),
        ],
      }),
    });
  }
  if (gl && gl.goalsAgainst === 0 && won && c.goalieId) {
    const id = c.goalieId;
    out.push({
      key: 'shutout', main: true, w: 7, style: 'tv',
      q: () => ({
        topic: 'Сухарь',
        question: pick([`${P[id]?.name} — «сухой» матч (${gl.saves} ${plural(gl.saves, 'сейв', 'сейва', 'сейвов')}). Лучший вратарь лиги?`, `Ноль в графе «пропущено». Чья это заслуга — вратаря или обороны?`]),
        options: [
          opt('goalie', `${lastName(P[id])} сегодня был стеной. Это его вечер.`, fx({ fans: 1, playerId: id, playerMorale: 7 })),
          opt('team', 'Шесть человек играли в обороне. Это командный ноль.', fx({ morale: 3, playerId: id, playerMorale: 1 })),
          opt('calm', 'Ноль — приятно, но завтра он ничего не значит.', fx({ board: 1, playerId: id, playerMorale: -1 })),
        ],
      }),
    });
  }
  if (c.derby)
    out.push({
      key: 'derby', main: true, w: 7, style: 'fan',
      q: () => ({
        topic: c.derby!.title,
        question: won
          ? pick([`Победа в принципиальном матче с «${opp.short}» (${score}). Что скажете болельщикам?`, `${c.derby!.title} за вами (${score}). Город ваш?`])
          : pick([`Поражение в принципиальном матче с «${opp.short}» (${score}). Болельщики разочарованы.`, `${c.derby!.title} проиграно. Как будете смотреть в глаза трибунам?`]),
        options: won
          ? [
              opt('fans', 'Эта победа — для наших трибун. Они нас несли весь вечер!', fx({ morale: 2, board: 1, fans: 4 })),
              opt('provoke', 'Соперник много говорил до игры. Лёд всё расставил по местам.', fx({ morale: 3, board: -2, fans: 5, tag: `press:feud:${opp.id}` })),
              opt('calm', 'Всего два очка. Дерби или нет — завтра новый матч.', fx({ board: 2, fans: -1 })),
            ]
          : [
              opt('sorry', 'Мы подвели болельщиков. Извиняемся и ответим в следующей встрече.', fx({ board: 1, fans: 2 })),
              opt('refs', 'Сегодня с нами играли не только хоккеисты соперника…', fx({ morale: 2, board: -3, fans: 3, tag: 'press:refs' })),
              opt('calm', 'Обычный матч регулярки. Эмоции оставим болельщикам.', fx({ morale: 1, board: 1, fans: -3 })),
            ],
      }),
    });
  if (won && c.after2[0] < c.after2[1])
    out.push({
      key: 'comeback', main: true, w: 7, style: 'tv',
      q: () => ({
        topic: 'Камбэк',
        question: pick([`После двух периодов вы уступали ${c.after2[0]}:${c.after2[1]}, а выиграли ${score}. Что сказали в раздевалке?`, `Отыграться в третьем периоде — это характер или везение?`]),
        options: [
          opt('speech', 'Без крика. Напомнил, кто мы такие.', fx({ morale: 3, fans: 1 })),
          opt('tactics', 'Поменяли схему выхода из зоны — и всё пошло.', fx({ morale: 1, board: 2 })),
          opt('players', 'Это всё ребята. Тренер тут ни при чём.', fx({ morale: 4, board: -1 })),
        ],
      }),
    });
  if (!won && c.after2[0] > c.after2[1])
    out.push({
      key: 'collapse', main: true, w: 7, style: 'sharp',
      q: () => ({
        topic: 'Упущенная победа',
        question: pick([`Вели ${c.after2[0]}:${c.after2[1]} после двух периодов и проиграли. Как такое возможно?`, `Провал в третьем периоде. Команде не хватает физики или головы?`]),
        options: [
          opt('fitness', 'Сели «физически». Добавим объёма в тренировки.', fx({ morale: -2, board: 2 })),
          opt('mental', 'Голова. Начали играть на удержание — это моя ошибка.', fx({ morale: 2, board: -1, fans: 1 })),
          opt('angry', 'Мне стыдно за третий период. Разговор будет жёсткий.', fx({ morale: -3, fans: 3, board: 1, tag: 'press:blame' })),
        ],
      }),
    });
  if (hero && hero.l.goals >= 3) {
    const id = hero.id;
    out.push({
      key: 'hattrick', main: true, w: 8, style: 'tv',
      q: () => ({
        topic: 'Хет-трик',
        question: pick([`${P[id].name} оформил хет-трик! Шляпы ещё летят на лёд. Ваши впечатления?`, `Хет-трик ${lastName(P[id])}. Он лучший снайпер лиги?`]),
        options: [
          opt('praise', `${lastName(P[id])} — снайпер от бога. Я счастлив, что он наш.`, fx({ fans: 2, playerId: id, playerMorale: 8, morale: -1 })),
          opt('line', 'Хет-трик — это ещё и передачи партнёров. Отличная работа звена.', fx({ morale: 3, playerId: id, playerMorale: 2 })),
          opt('more', 'Отлично, но в защите ему ещё работать и работать.', fx({ board: 1, playerId: id, playerMorale: -3 })),
        ],
      }),
    });
  } else if (hero && heroPts >= 3) {
    const id = hero.id;
    out.push({
      key: 'hero', main: true, w: 6, style: 'tv',
      q: () => ({
        topic: 'Герой матча',
        question: pick([`${P[id].name} набрал ${heroPts} ${plural(heroPts, 'очко', 'очка', 'очков')} (${hero.l.goals}+${hero.l.assists}). Это его лучший матч в сезоне?`, `${heroPts} ${plural(heroPts, 'очко', 'очка', 'очков')} ${lastName(P[id])} за вечер. Он заслуживает вызова в сборную?`]),
        options: [
          opt('praise', `${lastName(P[id])} — игрок уровня сборной. Он заслужил все комплименты.`, fx({ morale: -1, fans: 2, playerId: id, playerMorale: 7 })),
          opt('team', 'Его очки — заслуга всего звена и всей команды.', fx({ morale: 3, board: 1, playerId: id, playerMorale: 1 })),
          opt('demand', 'Хорошо, но от него мы ждём такого каждый вечер.', fx({ board: 2, playerId: id, playerMorale: -3 })),
        ],
      }),
    });
  }
  if (won && diff >= 3)
    out.push({
      key: 'rout-win', main: true, w: 5, style: 'fan',
      q: () => ({
        topic: 'Крупная победа',
        question: pick([`Разгром «${opp.short}» — ${score}. Не боитесь звёздной болезни?`, `${score}! Соперник вообще был на льду?`]),
        options: [
          opt('praise', 'Ребята заслужили похвалу. Так и должен играть наш клуб.', fx({ morale: 3, fans: 2 })),
          opt('work', 'Рано расслабляться. Разберём ошибки — их было немало.', fx({ morale: 1, board: 2 })),
          opt('weak', 'Соперник был не в лучшем состоянии, это не показатель.', fx({ morale: -1, board: 1, fans: -1 })),
        ],
      }),
    });
  if (!won && diff <= -3)
    out.push({
      key: 'rout-loss', main: true, w: 6, style: 'sharp',
      q: () => ({
        topic: 'Разгромное поражение',
        question: pick([`${score}. Это худший матч команды при вас?`, `Разгром от «${opp.short}». Игроки сдались?`, `После ${score} кто-то должен ответить. Кто?`]),
        options: [
          opt('shame', 'Стыдно. Мы извиняемся перед каждым, кто был на трибуне.', fx({ fans: 3, morale: -1 })),
          opt('names', 'Некоторые сегодня просто отбывали номер. Сделаю выводы.', fx({ morale: -4, board: 2, fans: 2, tag: 'press:blame' })),
          opt('forget', 'Такие матчи надо быстро забыть. Одно поражение — не трагедия.', fx({ morale: 2, board: -2, fans: -2 })),
        ],
      }),
    });
  if (res.ot || res.so)
    out.push(won
      ? {
          key: 'ot-win', main: true, w: 4, style: 'analyst',
          q: () => ({
            topic: 'Нервная концовка',
            question: pick([`Победа ${res.so ? 'по буллитам' : 'в овертайме'} над «${opp.short}». Почему не удалось дожать соперника в основное время?`, `${res.so ? 'Буллиты' : 'Овертайм'} — лотерея или мастерство?`]),
            options: [
              opt('character', 'Главное — характер. Такие победы сплачивают команду.', fx({ morale: 3, fans: 1 })),
              opt('critical', 'Терять очко в основное время недопустимо, будем работать.', fx({ morale: -1, board: 2 })),
              opt('fans', 'Зрители получили настоящий хоккей — ради этого мы и играем.', fx({ morale: 1, board: -1, fans: 3 })),
            ],
          }),
        }
      : {
          key: 'ot-loss', main: true, w: 4, style: 'analyst',
          q: () => ({
            topic: res.so ? 'Проигрыш по буллитам' : 'Проигрыш в овертайме',
            question: pick([`Одно очко из двух возможных. Довольны или расстроены?`, `${res.so ? 'Серия буллитов' : 'Овертайм'} снова не ваш. Это психология?`]),
            options: [
              opt('point', 'Очко на выезде у такого соперника — нормально.', fx({ morale: 2, board: -1 })),
              opt('angry', 'Расстроен. Мы должны были решить всё в основное время.', fx({ board: 1, fans: 1 })),
              opt('so', res.so ? 'Будем больше тренировать буллиты. Это поправимо.' : 'Три на три — отдельный вид спорта. Будем учиться.', fx({ morale: 1, board: 1 })),
            ],
          }),
        });
  if (!won && (c.my?.pim ?? 0) >= 14)
    out.push({
      key: 'discipline', main: true, w: 5, style: 'analyst',
      q: () => ({
        topic: 'Дисциплина',
        question: pick([`${c.my!.pim} минут штрафа — поражение ${score}. Это проблема дисциплины или судейства?`, `Вы снова проиграли скамейке штрафников. Кто будет наказан?`]),
        options: [
          opt('discipline', 'Наша вина. Глупые удаления — это то, что мы обязаны убрать.', fx({ morale: -1, board: 2 })),
          opt('refs', 'Я посмотрю видео. Часть удалений вызывает вопросы.', fx({ morale: 2, board: -2, fans: 2, tag: 'press:refs' })),
          opt('style', 'Мы играем жёстко и не изменим своему стилю.', fx({ morale: 2, board: -1, fans: 1 })),
        ],
      }),
    });
  if (!won && c.myXg > c.oppXg + 0.8)
    out.push({
      key: 'unlucky', main: true, w: 5, style: 'analyst',
      q: () => ({
        topic: 'Не повезло',
        question: pick([`По моментам вы были лучше (xG ${c.myXg.toFixed(1)}:${c.oppXg.toFixed(1)}), но проиграли ${score}. Что не так с реализацией?`, `${c.my?.shots ?? 0} ${plural(c.my?.shots ?? 0, 'бросок', 'броска', 'бросков')} — и ${c.us} ${plural(c.us, 'гол', 'гола', 'голов')}. Нападающим нужен психолог?`]),
        options: [
          opt('patience', 'Если продолжим так играть — шайбы полетят. Я спокоен.', fx({ morale: 2, fans: -1 })),
          opt('finish', 'Нападающие должны забивать такие моменты. Это их работа.', fx({ morale: -2, board: 2, fans: 1 })),
          opt('goalie', 'Отдадим должное вратарю соперника — он сегодня был стеной.', fx({ morale: 1, board: 1 })),
        ],
      }),
    });
  if (won && c.oppXg > c.myXg + 0.8)
    out.push({
      key: 'lucky', main: true, w: 4, style: 'sharp',
      q: () => ({
        topic: 'Победа вопреки',
        question: pick([`Соперник создал больше (xG ${c.myXg.toFixed(1)}:${c.oppXg.toFixed(1)}), но победили вы. Повезло?`, `Без вратаря вы бы сегодня проиграли крупно. Согласны?`]),
        options: [
          opt('goalie', 'Вратарь выиграл нам этот матч — не стесняюсь это сказать.', fx({ morale: 1, players: c.goalieId ? { [c.goalieId]: 5 } : undefined })),
          opt('efficient', 'Мы были эффективнее. Это тоже мастерство.', fx({ morale: 2, fans: 1, board: -1 })),
          opt('honest', 'Честно — повезло. Так играть дальше нельзя.', fx({ morale: -1, board: 2 })),
        ],
      }),
    });
  if (won && c.winStreak >= 4)
    out.push({
      key: 'win-streak', main: true, w: 5, style: 'tv',
      q: () => ({
        topic: 'Победная серия',
        question: pick([`Уже ${c.winStreak} ${plural(c.winStreak, 'победа', 'победы', 'побед')} подряд. Можно говорить о «${T.short}» как о фаворите?`, `Серия из ${c.winStreak} побед. В чём секрет?`]),
        options: [
          opt('favorite', 'Да, мы хотим выигрывать всё и не прячемся.', fx({ morale: 2, board: 1, fans: 3, tag: 'press:favorite' })),
          opt('modest', 'Фаворитов определяет весна. Мы просто делаем свою работу.', fx({ morale: 1, board: 2 })),
          opt('rest', 'Серия рано или поздно прервётся — важно, как мы на это ответим.', fx({ board: 1, fans: -1 })),
        ],
      }),
    });
  if (c.my && c.my.ppChances >= 4 && c.my.ppGoals === 0 && !won)
    out.push({
      key: 'pp-fail', main: true, w: 4, style: 'analyst',
      q: () => ({
        topic: 'Большинство',
        question: `0 из ${c.my!.ppChances} в большинстве. Что происходит со спецбригадами?`,
        options: [
          opt('change', 'Будем менять составы бригад. Кто-то потеряет место.', fx({ morale: -1, board: 2 })),
          opt('trust', 'Схема рабочая, просто не залетело. Доверяю ребятам.', fx({ morale: 2, fans: -1 })),
          opt('coach', 'Это вопрос к тренеру по спецбригадам. Разберёмся.', fx({ morale: 1, board: 0 })),
        ],
      }),
    });
  if (c.my && c.my.ppGoals >= 2)
    out.push({
      key: 'pp-hot', main: true, w: 3, style: 'tv',
      q: () => ({
        topic: 'Большинство',
        question: `${c.my!.ppGoals} ${plural(c.my!.ppGoals, 'гол', 'гола', 'голов')} в большинстве. Это лучшая бригада лиги?`,
        options: [
          opt('yes', 'Мы много над этим работали — приятно видеть результат.', fx({ morale: 2, fans: 1 })),
          opt('humble', 'Соперник давал нам шансы. В следующий раз так не будет.', fx({ board: 1 })),
          opt('pk', 'Лучше спросите про меньшинство — там работы больше.', fx({ morale: 1, board: 1 })),
        ],
      }),
    });
  // always available
  out.push(won
    ? {
        key: 'win', main: true, w: 1,
        q: () => ({
          topic: 'После победы',
          question: pick([`Победа над «${opp.short}» — ${score}. Довольны игрой команды?`, `${score} с «${opp.short}». Что понравилось больше всего?`, `Два очка в копилке. Какой эпизод стал переломным?`]),
          options: [
            opt('happy', 'Да. План на игру выполнен, ребята молодцы.', fx({ morale: 2, board: 1, fans: 1 })),
            opt('more', 'Результат есть, игры пока нет. Будем прибавлять.', fx({ board: 2 })),
            opt('fans', 'Спасибо болельщикам — с такой поддержкой проигрывать нельзя.', fx({ morale: 1, fans: 3 })),
          ],
        }),
      }
    : {
        key: 'loss', main: true, w: 1,
        q: () => ({
          topic: 'После поражения',
          question: pick([`Поражение от «${opp.short}» — ${score}. В чём причина?`, `${score}. Чего не хватило сегодня?`, `Соперник был быстрее во всём. Согласны?`]),
          options: [
            opt('self', 'Я неправильно подготовил команду. Исправим.', fx({ morale: 2, board: -1, fans: 1 })),
            opt('effort', 'Не хватило самоотдачи. Это недопустимо.', fx({ morale: -3, board: 2, fans: 2 })),
            opt('long', 'Сезон длинный. Сделаем выводы без паники.', fx({ morale: 1, board: 1, fans: -1 })),
          ],
        }),
      });
  return out;
}

/* ---------------- context topics (any press conference) ---------------- */
function contextTopics(c: Ctx): Topic[] {
  const { s, T, P, res, opp } = c;
  const out: Topic[] = [];
  const mine = T.players.map((id) => P[id]).filter((p) => p && !p.inVhl);
  const byOvr = [...mine].filter((p) => !isGoalie(p)).sort((a, b) => b.overall - a.overall);
  const top8 = new Set(byOvr.slice(0, 8).map((p) => p.id));
  const local = REPORTERS.find((r) => r.style === 'local')!;
  local.outlet = `«Вечерний ${T.city}»`;

  // follow-ups: the press remembers what the manager said
  if (recalled(s, 'press:refs', 10) !== null)
    out.push({
      key: 'fu-refs', main: false, w: 6, style: 'sharp',
      q: () => {
        remember(s, 'press:refs-done');
        delete roomMemory(s).tags['press:refs'];
        return {
          topic: 'Слова о судьях',
          question: 'Дисциплинарный комитет КХЛ изучает ваши слова о судействе. Готовы извиниться?',
          options: [
            opt('fine', 'Заплачу штраф, но от слов не откажусь.', fx({ fans: 2, board: -2, budget: -1_000_000 })),
            opt('sorry', 'Сказал на эмоциях. Приношу извинения арбитрам.', fx({ fans: -1, board: 1, budget: -300_000 })),
            opt('silent', 'Комментировать работу комитета не буду.', fx({ board: -1, budget: -600_000 })),
          ],
        };
      },
    });
  if (recalled(s, 'press:favorite', 30) !== null && c.streak >= 2)
    out.push({
      key: 'fu-favorite', main: false, w: 6, style: 'sharp',
      q: () => {
        delete roomMemory(s).tags['press:favorite'];
        return {
          topic: 'Фаворит?',
          question: 'Не так давно вы называли команду фаворитом. Не поторопились?',
          options: [
            opt('stand', 'Не поторопился. Сильные команды тоже проигрывают.', fx({ morale: 2, fans: 1, board: -1 })),
            opt('wrong', 'Признаю, сказал лишнее. Сначала надо играть.', fx({ board: 1, fans: -1 })),
            opt('joke', 'Фаворит — это тот, кто выигрывает в апреле. Ещё не апрель.', fx({ morale: 1, fans: 1 })),
          ],
        };
      },
    });
  if (recalled(s, 'press:blame', 14) !== null)
    out.push({
      key: 'fu-blame', main: false, w: 4, style: 'analyst',
      q: () => {
        delete roomMemory(s).tags['press:blame'];
        return {
          topic: 'Критика игроков',
          question: 'После вашей публичной критики говорят, что раздевалка обиделась. Это так?',
          options: [
            opt('fine', 'Профессионалы умеют слышать критику. Обид нет.', fx({ board: 1, morale: -1 })),
            opt('sorry', 'Может, стоило сказать это в раздевалке, а не здесь.', fx({ morale: 3, board: -1 })),
            opt('more', 'Если кто-то обиделся — значит, я попал в точку.', fx({ morale: -3, board: 1, fans: 2 })),
          ],
        };
      },
    });
  if (recalled(s, 'skip', 10) !== null)
    out.push({
      key: 'fu-skip', main: false, w: 4, style: 'local',
      q: () => {
        delete roomMemory(s).tags['skip'];
        return {
          topic: 'Пропуск пресс-конференции',
          question: 'В прошлый раз вы не вышли к прессе. Болельщики хотят слышать тренера. Почему?',
          options: [
            opt('sorry', 'Был неправ. Такого больше не повторится.', fx({ fans: 2 })),
            opt('busy', 'Был нужнее в раздевалке.', fx({ morale: 2, fans: -1 })),
            opt('rude', 'Я тренер, а не шоумен.', fx({ fans: -3, board: -1, morale: 1 })),
          ],
        };
      },
    });
  for (const t of recalledAll(s, 'press:feud:', 40)) {
    if (t.slice(11) !== opp.id) continue;
    out.push({
      key: 'fu-feud', main: false, w: 5, style: 'fan',
      q: () => ({
        topic: 'Перепалка с соперником',
        question: `После прошлой встречи тренер «${opp.short}» ответил на ваши слова: «Пусть сначала выиграет что-нибудь». Ваш ответ?`,
        options: [
          opt('fire', 'Посмотрим, кто будет смеяться последним.', fx({ morale: 2, fans: 3, board: -2 })),
          opt('peace', 'Уважаю коллегу. Пусть говорит лёд.', fx({ board: 2, fans: -1 })),
          opt('joke', 'Передайте ему привет и пожелания здоровья.', fx({ fans: 2 })),
        ],
      }),
    });
  }
  const broken = recalledAll(s, 'broken:', 20).map((t) => P[t.slice(7)]).find((p) => p && p.teamId === T.id);
  if (broken)
    out.push({
      key: 'fu-broken', main: false, w: 5, style: 'sharp',
      q: () => ({
        topic: 'Невыполненное обещание',
        question: `Говорят, вы обещали ${broken.name} больше, чем дали. Вам можно верить на слово?`,
        options: [
          opt('fix', 'Ситуация изменилась. Я поговорю с игроком и всё исправлю.', fx({ playerId: broken.id, playerMorale: 4, board: -1 })),
          opt('form', 'Я ничего не должен игроку, который не в форме.', fx({ playerId: broken.id, playerMorale: -6, morale: -1, board: 1 })),
          opt('none', 'Разговоры в раздевалке остаются в раздевалке.', fx({ morale: -1 })),
        ],
      }),
    });
  const promise = (s.roomPromises ?? []).find((x) => P[x.playerId]?.teamId === T.id && x.kind !== 'scratch');
  if (promise)
    out.push({
      key: 'fu-promise', main: false, w: 2.5, style: 'analyst',
      q: () => ({
        topic: 'Обещание игроку',
        question: `Ходят слухи о вашем обещании (${promiseLabel(s, promise)}). Подтверждаете?`,
        options: [
          opt('word', 'Слово тренера — закон. Значит, так и будет.', fx({ playerId: promise.playerId, playerMorale: 3, morale: -1 })),
          opt('form', 'Всё решает форма. Обещаний никому не раздаю.', fx({ playerId: promise.playerId, playerMorale: -4, morale: 1, board: 1 })),
          opt('none', 'Наши разговоры с игроками — не для прессы.', fx({})),
        ],
      }),
    });
  const fightDay = roomMemory(s).cool['conflict-fight'];
  if (fightDay !== undefined && s.day - fightDay <= 6)
    out.push({
      key: 'fu-fight', main: false, w: 3, style: 'fan',
      q: () => ({
        topic: 'Слухи из раздевалки',
        question: 'Говорят, на тренировке дело дошло до драки. Что происходит в коллективе?',
        options: [
          opt('work', 'Рабочие моменты. Значит, ребятам не всё равно.', fx({ morale: 1, fans: 1 })),
          opt('punished', 'Виновные наказаны, вопрос закрыт.', fx({ board: 1, morale: -1 })),
          opt('deny', 'Ничего такого не было.', fx({ fans: -1, tag: 'liar' })),
        ],
      }),
    });

  // the club around the match
  if (res) {
    const scorers = new Set(res.scorers.filter((x) => x.team === T.id).map((x) => x.scorer));
    const young = c.myIds.map((id) => P[id]).find((p) => p && p.age <= 21 && scorers.has(p.id));
    if (young)
      out.push({
        key: 'young', main: false, w: 3, style: 'local',
        q: () => ({
          topic: 'Молодёжь',
          question: pick([`${young.name} в ${young.age} забивает в КХЛ. Готовы давать ему больше игрового времени?`, `Гол ${lastName(young)} — праздник для школы клуба. Он уже основной игрок?`]),
          options: [
            opt('more', 'Заслужил — будет играть больше.', fx({ fans: 2, playerId: young.id, playerMorale: 6, morale: -1 }), 'Молодой игрок будет ждать роли.'),
            opt('patience', 'Не будем перехваливать. Путь только начинается.', fx({ board: 1, playerId: young.id, playerMorale: 1 })),
            opt('school', 'Это заслуга тренеров нашей школы.', fx({ fans: 2, board: 1 })),
          ],
        }),
      });
    const ms = c.myIds.map((id) => ({ p: P[id], l: res.lines[id] })).find((x) => x.p && x.l && x.l.goals > 0 && [10, 20, 30, 40].some((m) => x.p.stats.goals >= m && x.p.stats.goals - x.l.goals < m));
    if (ms) {
      const m = [40, 30, 20, 10].find((k) => ms.p.stats.goals >= k)!;
      out.push({
        key: 'milestone', main: false, w: 3, style: 'tv',
        q: () => ({
          topic: 'Юбилейная шайба',
          question: `${ms.p.name} забил ${m}-ю шайбу в сезоне. Где его потолок?`,
          options: [
            opt('sky', 'Потолка нет. Он может стать лучшим снайпером лиги.', fx({ playerId: ms.p.id, playerMorale: 5, fans: 1 })),
            opt('team', 'Его голы — это работа всей пятёрки.', fx({ morale: 2, playerId: ms.p.id, playerMorale: 1 })),
            opt('focus', 'Личная статистика вторична. Важна команда.', fx({ board: 1 })),
          ],
        }),
      });
    }
    const leg = c.myIds.map((id) => P[id]).find((p) => p && isLegionnaire(p) && scorers.has(p.id));
    if (leg)
      out.push({
        key: 'legion', main: false, w: 1.2, style: 'analyst',
        q: () => ({
          topic: 'Легионер',
          question: `${leg.name} забил сегодня. Как он адаптировался в КХЛ?`,
          options: [
            opt('great', 'Отлично: он уже говорит по-русски лучше, чем я по-английски.', fx({ playerId: leg.id, playerMorale: 4, fans: 1 })),
            opt('more', 'Легионер должен решать матчи. От него ждём большего.', fx({ playerId: leg.id, playerMorale: -3, board: 1 })),
            opt('team', 'Для нас нет легионеров — все свои.', fx({ morale: 2, playerId: leg.id, playerMorale: 2 })),
          ],
        }),
      });
    const capId = T.captainId, capLine = capId ? res.lines[capId] : null;
    if (capId && capLine && capLine.goals + capLine.assists >= 2)
      out.push({
        key: 'captain', main: false, w: 1.5, style: 'tv',
        q: () => ({
          topic: 'Капитан',
          question: `Капитан ${P[capId].name} снова среди лучших. Каково его значение для команды?`,
          options: [
            opt('heart', 'Он — сердце этой раздевалки.', fx({ playerId: capId, playerMorale: 5, morale: 1 })),
            opt('example', 'Пример для молодых — и на льду, и вне его.', fx({ morale: 2, playerId: capId, playerMorale: 2 })),
            opt('equal', 'У нас нет незаменимых. Капитан — один из двадцати.', fx({ playerId: capId, playerMorale: -3, board: 1 })),
          ],
        }),
      });
    if ((c.my?.shots ?? 0) >= 40 || (c.my?.shots ?? 99) <= 18) {
      const many = (c.my?.shots ?? 0) >= 40;
      out.push({
        key: 'shots', main: false, w: 1.2, style: 'analyst',
        q: () => ({
          topic: 'Броски',
          question: many ? `${c.my!.shots} бросков в створ. Это ваш стиль — бросать со всех позиций?` : `Всего ${c.my!.shots} бросков в створ. Почему так мало?`,
          options: many
            ? [
                opt('volume', 'Да. Каждый бросок — шанс на добивание.', fx({ morale: 1, fans: 1 })),
                opt('quality', 'Нам нужны не броски, а опасные моменты. Будем работать.', fx({ board: 1 })),
                opt('goalie', 'Спросите лучше у вратаря соперника, как он устал.', fx({ fans: 1 })),
              ]
            : [
                opt('system', 'Соперник закрыл центр. Будем искать решения.', fx({ board: 1 })),
                opt('brave', 'Нападающим не хватает смелости. Это изменится.', fx({ morale: -2, board: 1, fans: 1 })),
                opt('plan', 'Это было частью плана: терпеть и ловить на ошибках.', fx({ morale: 1, fans: -1 })),
              ],
        }),
      });
    }
    if ((c.my?.hits ?? 0) >= 30)
      out.push({
        key: 'hits', main: false, w: 1, style: 'fan',
        q: () => ({
          topic: 'Силовая борьба',
          question: `${c.my!.hits} силовых приёмов. Хоккей «${T.short}» стал жёстче?`,
          options: [
            opt('tough', 'Мы показываем характер. С нами будут считаться.', fx({ morale: 2, fans: 2, board: -1 })),
            opt('clean', 'Жёстко, но в рамках правил.', fx({ board: 1 })),
            opt('careful', 'Нужно беречь силы на сезон — будем аккуратнее.', fx({ morale: -1, board: 1 })),
          ],
        }),
      });
  }
  const block = mine.find((p) => p.tradeFlag === 'block' && top8.has(p.id));
  if (block)
    out.push({
      key: 'trade-block', main: false, w: 2.5, style: 'sharp',
      q: () => ({
        topic: 'Слухи об обмене',
        question: `Правда, что ${block.name} выставлен на обмен?`,
        options: [
          opt('deny', 'Неправда. Он важен для команды.', fx({ playerId: block.id, playerMorale: 4, tag: 'liar' }), 'Если обмен всё же случится — пресса это припомнит.'),
          opt('confirm', 'Мы рассматриваем варианты, это нормальная практика.', fx({ playerId: block.id, playerMorale: -6, board: 1 })),
          opt('none', 'Трансферы не комментирую.', fx({ playerId: block.id, playerMorale: -1 })),
        ],
      }),
    });
  const expiring = byOvr.find((p) => p.contract.years <= 1 && !p.contract.next && p.overall >= 72);
  if (expiring && s.phase === 'season')
    out.push({
      key: 'expiring', main: false, w: 1.5, style: 'analyst',
      q: () => ({
        topic: 'Контракт',
        question: `У ${expiring.name} истекает контракт. Клуб будет его продлевать?`,
        options: [
          opt('yes', 'Хотим видеть его в команде долгие годы.', fx({ playerId: expiring.id, playerMorale: 5, fans: 1 })),
          opt('talks', 'Переговоры идут — подробности позже.', fx({ playerId: expiring.id, playerMorale: 1 })),
          opt('open', 'Всё зависит от его игры до конца сезона.', fx({ playerId: expiring.id, playerMorale: -4, board: 1 })),
        ],
      }),
    });
  const unhappy = mine.find((p) => p.morale < 45 && top8.has(p.id) && !p.injury);
  if (unhappy)
    out.push({
      key: 'unhappy', main: false, w: 3, style: 'sharp',
      q: () => ({
        topic: 'Недовольный игрок',
        question: pick([`Ходят слухи, что ${unhappy.name} недоволен своей ролью. Это так?`, `Окружение ${lastName(unhappy)} говорит о желании сменить клуб. Ваша реакция?`]),
        options: [
          opt('talk', 'Мы с ним поговорим. Проблем нет, есть рабочие вопросы.', fx({ playerId: unhappy.id, playerMorale: 4 })),
          opt('none', 'У нас нет недовольных — есть те, кто хочет играть больше. Это нормально.', fx({ playerId: unhappy.id, playerMorale: 1, morale: 1 })),
          opt('door', 'Кто недоволен — может искать другую команду.', fx({ playerId: unhappy.id, playerMorale: -10, board: 1, fans: 1, morale: -1 })),
        ],
      }),
    });
  if (s.board && s.board.confidence < 40)
    out.push({
      key: 'board', main: false, w: 3, style: 'sharp',
      q: () => ({
        topic: 'Кресло тренера',
        question: pick(['Говорят, руководство уже ищет вам замену. Вы чувствуете, что кресло шатается?', `Доверие руководства тает. Сколько матчей вам дали на исправление?`]),
        options: [
          opt('calm', 'Я думаю о следующем матче, а не о своём кресле.', fx({ morale: 1 })),
          opt('results', 'Тренера оценивают по результату. Я это понимаю.', fx({ board: 2, morale: -1 })),
          opt('support', 'Мне нужна поддержка, а не слухи. Пусть руководство скажет это мне в лицо.', fx({ board: -3, morale: 2, fans: 1 })),
        ],
      }),
    });
  if (T.record.gp >= 10 && c.rank <= 2)
    out.push({
      key: 'standings-top', main: false, w: 1.5, style: 'tv',
      q: () => ({
        topic: 'Турнирная таблица',
        question: `«${T.short}» — ${c.rank}-й на ${T.conference === 'Запад' ? 'Западе' : T.conference === 'Восток' ? 'Востоке' : 'конференции'}. Цель — первое место?`,
        options: [
          opt('yes', 'Да. Домашний лёд в плей-офф дорогого стоит.', fx({ morale: 1, fans: 2, board: 1 })),
          opt('step', 'Таблица — для журналистов. Мы идём от матча к матчу.', fx({ board: 1 })),
          opt('early', 'Рано смотреть в таблицу — сезон длинный.', fx({ morale: 1, fans: -1 })),
        ],
      }),
    });
  if (T.record.gp >= 15 && c.rank > 8)
    out.push({
      key: 'standings-low', main: false, w: 2, style: 'local',
      q: () => ({
        topic: 'Зона плей-офф',
        question: `Вы ${c.rank}-е — за чертой плей-офф. Верите, что успеете?`,
        options: [
          opt('believe', 'Верю. Отставание не такое большое.', fx({ morale: 2, fans: 1 })),
          opt('honest', 'Каждый матч теперь как финал. По-другому нельзя.', fx({ board: 1, morale: 1 })),
          opt('rebuild', 'У нас перестройка, важно развитие молодых.', fx({ board: -2, fans: -2, morale: 1 })),
        ],
      }),
    });
  const injured = byOvr.slice(0, 6).find((p) => p.injury && p.injury.days >= 10);
  if (injured)
    out.push({
      key: 'injury', main: false, w: 2.5, style: 'local',
      q: () => ({
        topic: 'Травма лидера',
        question: `Как команда справится без ${injured.name}? Он выбыл ещё на ${injured.injury!.days} дн.`,
        options: [
          opt('chance', 'Это шанс для других. Кто-то обязательно выстрелит.', fx({ morale: 2 })),
          opt('miss', 'Его будет не хватать — заменить такого игрока невозможно.', fx({ playerId: injured.id, playerMorale: 4, morale: -1 })),
          opt('market', 'Будем искать усиление на рынке.', fx({ board: 1, morale: -1, fans: 1 })),
        ],
      }),
    });
  // next opponent (within 3 days)
  for (let d = s.day + (c.pre ? 1 : 0); d <= s.day + 3; d++) {
    const ng = (s.schedule[d] ?? []).find((x) => !x.played && x.id !== c.g.id && (x.home === T.id || x.away === T.id));
    if (!ng) continue;
    const no = s.teams[ng.home === T.id ? ng.away : ng.home];
    const der = getDerby(s.teams[ng.home], s.teams[ng.away]);
    if (der || confRank(s, no) <= 3)
      out.push({
        key: 'next-opp', main: false, w: 1.8, style: 'tv',
        q: () => ({
          topic: 'Следующий соперник',
          question: der ? `Впереди ${der.title.toLowerCase()} с «${no.short}». Уже думаете о нём?` : `Следующий соперник — лидер «${no.short}». Как будете его останавливать?`,
          options: [
            opt('ready', 'Мы готовы к любому сопернику.', fx({ morale: 2, fans: 1 })),
            opt('respect', `«${no.short}» — сильная команда, но у них есть слабые места.`, fx({ board: 1 })),
            opt('provoke', 'Пусть они думают, как останавливать нас.', fx({ morale: 2, fans: 3, board: -1, tag: `press:feud:${no.id}` })),
          ],
        }),
      });
    break;
  }
  if ((T.roadStreak ?? 0) >= 3)
    out.push({
      key: 'road', main: false, w: 1.2, style: 'analyst',
      q: () => ({
        topic: 'Выездная серия',
        question: `${T.roadStreak}-й матч подряд на выезде. Перелёты сказываются?`,
        options: [
          opt('tired', 'Конечно. Будем больше восстанавливаться.', fx({ rest: 6, board: -1 })),
          opt('excuse', 'Перелёты — не оправдание. У соперников тот же календарь.', fx({ board: 1, morale: -1 })),
          opt('bond', 'Выезды сплачивают — мы много времени проводим вместе.', fx({ morale: 2 })),
        ],
      }),
    });
  if ((s.fans ?? 60) < 45)
    out.push({
      key: 'fans', main: false, w: 2, style: 'local',
      q: () => ({
        topic: 'Трибуны',
        question: 'Трибуны пустеют, болельщики разочарованы. Как вернуть людей на хоккей?',
        options: [
          opt('play', 'Только игрой. Лучшая реклама — победы.', fx({ morale: 1 })),
          opt('open', 'Проведём открытую тренировку и встречу с болельщиками.', fx({ fans: 3, budget: -300_000 })),
          opt('blame', 'Настоящие болельщики с нами в любой ситуации.', fx({ fans: -3, morale: 1 })),
        ],
      }),
    });
  const backup = c.goalieId && T.lineup.starterG && c.goalieId !== T.lineup.starterG ? c.goalieId : null;
  const bl = backup && res ? res.lines[backup] : null;
  if (backup && bl && c.won && bl.shotsAgainst > 0 && bl.saves / bl.shotsAgainst >= 0.92)
    out.push({
      key: 'goalie-backup', main: false, w: 2.5, style: 'analyst',
      q: () => ({
        topic: 'Вратарская ротация',
        question: `${P[backup].name} отлично сыграл (${bl.saves} из ${bl.shotsAgainst}). Нашёлся новый первый номер?`,
        options: [
          opt('compete', 'Конкуренция в воротах — это прекрасно.', fx({ playerId: backup, playerMorale: 4, players: { [T.lineup.starterG!]: -2 } })),
          opt('starter', `Первый номер — ${lastName(P[T.lineup.starterG!])}. Это не обсуждается.`, fx({ playerId: backup, playerMorale: -3, players: { [T.lineup.starterG!]: 3 } })),
          opt('promise', `${lastName(P[backup])} получит больше матчей.`, fx({ playerId: backup, playerMorale: 6, players: { [T.lineup.starterG!]: -4 }, promise: { kind: 'starts', playerId: backup } }), 'Это обещание: ~4 из 8 матчей в воротах.'),
        ],
      }),
    });
  if (c.res && Math.random() < 0.35) {
    const wonBy = c.won;
    out.push({
      key: 'opp-coach', main: false, w: 1.2, style: 'fan',
      q: () => ({
        topic: 'Слова соперника',
        question: wonBy ? `Тренер «${opp.short}» заявил, что вам просто повезло. Ваш ответ?` : `Тренер «${opp.short}» сказал, что «${T.short}» играет примитивно. Обидно?`,
        options: [
          opt('fire', wonBy ? 'Пусть посмотрит на табло ещё раз.' : 'Посмотрим, как он заговорит в следующей встрече.', fx({ morale: 2, fans: 3, board: -2, tag: `press:feud:${opp.id}` })),
          opt('ignore', 'Не комментирую слова коллег.', fx({ board: 1 })),
          opt('joke', wonBy ? 'Везёт сильнейшим.' : 'Примитивно, зато результативно. Ну, в другой раз.', fx({ fans: 2 })),
        ],
      }),
    });
  }
  return out;
}

/* ---------------- pre-match ---------------- */
function preTopics(c: Ctx): Topic[] {
  const { s, T, opp, g } = c;
  const out: Topic[] = [];
  const series = g.seriesId != null ? s.playoffs?.series.find((x) => x.id === g.seriesId) : undefined;
  if (series) {
    const sw = series.high === T.id ? series.wins : [series.wins[1], series.wins[0]];
    const decisive = sw[0] === 3 || sw[1] === 3;
    out.push({
      key: 'pre-playoff', main: true, w: 9, style: 'tv',
      q: () => ({
        topic: decisive ? 'Решающий матч' : 'Плей-офф',
        question: decisive
          ? sw[1] === 3 && sw[0] < 3 ? `Счёт ${sw[0]}:${sw[1]}: проигрыш — и сезон окончен. Что скажете команде перед игрой?` : sw[0] === 3 && sw[1] < 3 ? `Одна победа до выхода в следующий раунд. Как не перегореть?` : 'Седьмой матч. Что чувствуете?'
          : `Счёт в серии ${sw[0]}:${sw[1]}. Что изменится в сегодняшнем матче?`,
        options: [
          opt('calm', 'Ничего особенного. Делаем то, что умеем.', fx({ morale: 2, board: 1 })),
          opt('fire', 'Это матч жизни. Отдадим всё до последней капли.', fx({ morale: 3, fans: 2, board: -1 })),
          opt('secret', 'Есть пара сюрпризов для соперника. Подробностей не будет.', fx({ morale: 1, fans: 1 })),
        ],
      }),
    });
  }
  if (c.derby)
    out.push({
      key: 'pre-derby', main: true, w: 8, style: 'fan',
      q: () => ({
        topic: `Перед матчем: ${c.derby!.title}`,
        question: pick([`Сегодня ${c.derby!.title.toLowerCase()} с «${opp.short}». Особая подготовка?`, `Город ждёт дерби. Что пообещаете болельщикам?`]),
        options: [
          opt('fans', 'Обещаю одно: никто не уйдёт с трибун разочарованным.', fx({ fans: 3, morale: 1 })),
          opt('provoke', `«${opp.short}» нас боится. И правильно делает.`, fx({ morale: 3, fans: 4, board: -2, tag: `press:feud:${opp.id}` })),
          opt('calm', 'Два очка, как и в любом другом матче.', fx({ board: 2, fans: -2 })),
        ],
      }),
    });
  if (!series && c.oppRank <= 2 && T.record.gp >= 8)
    out.push({
      key: 'pre-leader', main: true, w: 6, style: 'analyst',
      q: () => ({
        topic: 'Матч с лидером',
        question: `Сегодня против лидера — «${opp.short}». Это экзамен для команды?`,
        options: [
          opt('exam', 'Да, и мы хотим его сдать на отлично.', fx({ morale: 2, fans: 1 })),
          opt('normal', 'Обычный матч. Лидеры тоже проигрывают.', fx({ morale: 1, board: 1 })),
          opt('underdog', 'Давление на них — мы можем играть свободно.', fx({ morale: 2, board: -1 })),
        ],
      }),
    });
  return out;
}

/* ---------------- assembling ---------------- */
/**
 * A press conference is a choice, not a bonus: the average effect of a question's answers is taken out of
 * each answer (rounded toward zero), so over a season the press neither inflates nor drains morale, the
 * board and the fans — only the manager's choices move them.
 */
function centre(q: Omit<PressQuestion, 'reporter'>): Omit<PressQuestion, 'reporter'> {
  for (const k of ['morale', 'board', 'fans'] as const) {
    const m = q.options.reduce((a, o) => a + o.effects[k], 0) / q.options.length;
    const shift = m > 0 ? Math.floor(m + 0.25) : Math.ceil(m - 0.25);
    if (shift) for (const o of q.options) o.effects[k] -= shift;
  }
  return q;
}

function assemble(main: Topic[], extra: Topic[], total: number, base: Omit<PressConference, 'topic' | 'question' | 'options'>): PressConference | null {
  const maxW = Math.max(...main.map((t) => t.w));
  const firsts = main.filter((t) => t.w === maxW);
  const chosen: Topic[] = [pick(firsts)];
  const rest = [...main.filter((t) => !chosen.includes(t) && t.w >= 3 && t.key !== 'win' && t.key !== 'loss'), ...extra];
  while (chosen.length < total && rest.length) {
    const sum = rest.reduce((a, t) => a + t.w, 0);
    let r = Math.random() * sum, i = 0;
    while (i < rest.length - 1 && (r -= rest[i].w) > 0) i++;
    chosen.push(rest.splice(i, 1)[0]);
  }
  const used = new Set<string>();
  const qs: PressQuestion[] = [];
  for (const t of chosen) {
    const raw = t.q();
    if (!raw) continue;
    const body = centre(raw);
    const pool = REPORTERS.filter((r) => !used.has(r.name));
    const rep = pool.filter((r) => r.style === t.style)[0] ?? pick(pool);
    used.add(rep.name);
    qs.push({ ...body, reporter: `${rep.name}${rep.outlet ? `, ${rep.outlet}` : ''}` });
  }
  if (!qs.length) return null;
  const [first, ...queue] = qs;
  return { ...base, ...first, queue, step: 1, total: qs.length, totals: { morale: 0, board: 0, fans: 0 } };
}

export function createPressConference(state: GameState, g: Game, res: GameResult): PressConference | null {
  const U = state.userTeamId;
  if (g.home !== U && g.away !== U) return null;
  const c = buildCtx(state, g, res);
  const main = resultTopics(c);
  const extra = contextTopics(c);
  const total = Math.random() < 0.45 ? 3 : 2;
  return assemble(main, extra, total, { id: pressSeq++ + state.day * 1000, day: state.day, gameId: g.id, kind: 'post', title: `После матча с «${c.opp.short}» (${c.score})` });
}

/** Pre-match press conference before derbies, playoff games and games against the leaders (or null). */
export function createPrePressConference(state: GameState, g: Game): PressConference | null {
  const U = state.userTeamId;
  if (g.home !== U && g.away !== U) return null;
  const c = buildCtx(state, g, null);
  const main = preTopics(c);
  if (!main.length) return null;
  const extra = contextTopics(c).filter((t) => t.key.startsWith('fu-') || t.key === 'injury' || t.key === 'board' || t.key === 'unhappy');
  return assemble(main, extra, extra.length && Math.random() < 0.6 ? 2 : 1, { id: pressSeq++ + state.day * 1000, day: state.day, gameId: g.id, kind: 'pre', title: `Перед матчем с «${c.opp.short}»` });
}

/**
 * Apply the answer to the current question; the next question (if any) becomes current. Returns a summary
 * for the news feed when the press conference is over, otherwise null. `null` = «без комментариев»: the
 * manager leaves — the press will remember it.
 */
export function answerPressConference(state: GameState, optionId: string | null): string | null {
  const pc = state.press;
  if (!pc) return null;
  if (!optionId) {
    state.press = null;
    remember(state, 'skip');
    return `Пресс-конференция («${pc.title ?? pc.topic}»): тренер ушёл без комментариев.`;
  }
  const o = pc.options.find((x) => x.id === optionId);
  if (!o) return null;
  applyEffects(state, o.effects);
  const tot = (pc.totals ??= { morale: 0, board: 0, fans: 0 });
  tot.morale += o.effects.morale; tot.board += o.effects.board; tot.fans += o.effects.fans;
  const next = pc.queue?.shift();
  if (next) {
    Object.assign(pc, { topic: next.topic, question: next.question, options: next.options, reporter: next.reporter, step: (pc.step ?? 1) + 1 });
    return null;
  }
  state.press = null;
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  const parts = [tot.morale && `мораль ${sign(tot.morale)}`, tot.board && `руководство ${sign(tot.board)}`, tot.fans && `болельщики ${sign(tot.fans)}`].filter(Boolean);
  return `Пресс-конференция (${pc.title ?? pc.topic}): «${o.text}»${parts.length ? ' — итог: ' + parts.join(', ') : ''}`;
}

/** Gate revenue multiplier from fan support (60 = neutral). */
export const fanGateMult = (fans = 60) => 0.88 + clamp(fans, 0, 100) * 0.002;
