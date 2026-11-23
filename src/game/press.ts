import type { Game, GameResult, GameState, PressConference, PressEffect, PressOption } from '../types';
import { clamp, isGoalie } from './ratings';
import { getDerby } from './derbies';

/**
 * Post-match press conferences. The question depends on what just happened; every answer moves the
 * dressing room (morale), the owners (board confidence) and the stands (fan support) in its own way.
 */

let pressSeq = 1;
const opt = (id: string, text: string, effects: PressEffect): PressOption => ({ id, text, effects });

export function createPressConference(state: GameState, g: Game, res: GameResult): PressConference | null {
  const U = state.userTeamId;
  if (g.home !== U && g.away !== U) return null;
  const P = state.players;
  const home = g.home === U;
  const us = home ? res.homeScore : res.awayScore;
  const them = home ? res.awayScore : res.homeScore;
  const won = us > them;
  const diff = us - them;
  const T = state.teams[U];
  const opp = state.teams[home ? g.away : g.home];
  const streak = T.record.streakType === 'L' ? T.record.streak : 0;
  const winStreak = T.record.streakType === 'W' ? T.record.streak : 0;
  const myXg = (home ? res.homeStats.xg : res.awayStats.xg) ?? 0;
  const oppXg = (home ? res.awayStats.xg : res.homeStats.xg) ?? 0;
  const myPim = (home ? res.homeStats.pim : res.awayStats.pim) ?? 0;
  const goalieId = home ? res.homeGoalie : res.awayGoalie;
  const gl = goalieId ? res.lines[goalieId] : null;
  const derby = getDerby(state.teams[g.home], state.teams[g.away]);
  const myIds = home ? res.homeDressed : res.awayDressed;
  const hero = myIds
    .map((id) => ({ id, l: res.lines[id] }))
    .filter((x) => x.l && P[x.id] && !isGoalie(P[x.id]))
    .sort((a, b) => b.l.goals * 2 + b.l.assists - (a.l.goals * 2 + a.l.assists))[0];
  const heroPts = hero ? hero.l.goals + hero.l.assists : 0;
  const base = { id: pressSeq++ + state.day * 1000, day: state.day, gameId: g.id };
  const score = `${us}:${them}`;

  if (!won && streak >= 3) {
    return {
      ...base,
      topic: 'Серия поражений',
      question: `«${T.short}» проиграл ${streak} матча подряд (${score} с «${opp.short}»). Вы чувствуете давление руководства?`,
      options: [
        opt('blame-self', 'Вся ответственность на мне. Команду не трогайте.', { morale: 3, board: -2, fans: 1 }),
        opt('blame-players', 'Некоторым игрокам пора вспомнить, за какой клуб они играют.', { morale: -4, board: 2, fans: 2 }),
        opt('luck', 'По моментам мы не хуже. Цифры на нашей стороне, результат придёт.', { morale: 1, board: -1, fans: -2 }),
      ],
    };
  }
  if (gl && gl.goalsAgainst >= 5 && goalieId) {
    const name = P[goalieId]?.name ?? 'вратарь';
    return {
      ...base,
      topic: 'Вопрос по вратарю',
      question: `${name} пропустил ${gl.goalsAgainst} шайб. Будут перемены в воротах?`,
      options: [
        opt('trust', `Я доверяю ${name.split(' ').slice(-1)[0]}. Он вытащит нам ещё не один матч.`, { morale: 1, board: -1, fans: -1, playerId: goalieId, playerMorale: 6 }),
        opt('compete', 'Конкуренция открыта: сыграет тот, кто лучше готов.', { morale: 0, board: 2, fans: 1, playerId: goalieId, playerMorale: -6 }),
        opt('team', 'Вратарь не виноват — мы бросили его без защиты.', { morale: 2, board: 0, fans: 0, playerId: goalieId, playerMorale: 3 }),
      ],
    };
  }
  if (derby) {
    return {
      ...base,
      topic: derby.title,
      question: won
        ? `Победа в принципиальном матче с «${opp.short}» (${score}). Что скажете болельщикам?`
        : `Поражение в принципиальном матче с «${opp.short}» (${score}). Болельщики разочарованы.`,
      options: won
        ? [
            opt('fans', 'Эта победа — для наших трибун. Они нас несли весь вечер!', { morale: 2, board: 1, fans: 4 }),
            opt('provoke', 'Соперник много говорил до игры. Лёд всё расставил по местам.', { morale: 3, board: -2, fans: 5 }),
            opt('calm', 'Всего два очка. Дерби или нет — завтра новый матч.', { morale: 0, board: 2, fans: -1 }),
          ]
        : [
            opt('sorry', 'Мы подвели болельщиков. Извиняемся и ответим в следующей встрече.', { morale: 0, board: 1, fans: 2 }),
            opt('refs', 'Сегодня с нами играли не только хоккеисты соперника…', { morale: 2, board: -3, fans: 3 }),
            opt('calm', 'Обычный матч регулярки. Эмоции оставим болельщикам.', { morale: 1, board: 1, fans: -3 }),
          ],
    };
  }
  if (heroPts >= 3 && hero) {
    const name = P[hero.id]?.name ?? 'игрок';
    return {
      ...base,
      topic: 'Герой матча',
      question: `${name} набрал ${heroPts} очка (${hero.l.goals}+${hero.l.assists}). Это его лучший матч в сезоне?`,
      options: [
        opt('praise', `${name.split(' ').slice(-1)[0]} — игрок уровня сборной. Он заслужил все комплименты.`, { morale: -1, board: 0, fans: 2, playerId: hero.id, playerMorale: 7 }),
        opt('team', 'Его очки — заслуга всего звена и всей команды.', { morale: 3, board: 1, fans: 0, playerId: hero.id, playerMorale: 1 }),
        opt('demand', 'Хорошо, но от него мы ждём такого каждый вечер.', { morale: 0, board: 2, fans: 0, playerId: hero.id, playerMorale: -3 }),
      ],
    };
  }
  if (won && diff >= 3) {
    return {
      ...base,
      topic: 'Крупная победа',
      question: `Разгром «${opp.short}» — ${score}. Не боитесь звёздной болезни?`,
      options: [
        opt('praise', 'Ребята заслужили похвалу. Так и должен играть наш клуб.', { morale: 3, board: 0, fans: 2 }),
        opt('work', 'Рано расслабляться. Разберём ошибки — их было немало.', { morale: 1, board: 2, fans: 0 }),
        opt('weak', 'Соперник был не в лучшем состоянии, это не показатель.', { morale: -1, board: 1, fans: -1 }),
      ],
    };
  }
  if (won && (res.ot || res.so)) {
    return {
      ...base,
      topic: 'Нервная концовка',
      question: `Победа ${res.so ? 'по буллитам' : 'в овертайме'} над «${opp.short}». Почему не удалось дожать соперника в основное время?`,
      options: [
        opt('character', 'Главное — характер. Такие победы сплачивают команду.', { morale: 3, board: 0, fans: 1 }),
        opt('critical', 'Терять очко в основное время недопустимо, будем работать.', { morale: -1, board: 2, fans: 0 }),
        opt('fans', 'Зрители получили настоящий хоккей — ради этого мы и играем.', { morale: 1, board: -1, fans: 3 }),
      ],
    };
  }
  if (!won && myPim >= 14) {
    return {
      ...base,
      topic: 'Дисциплина',
      question: `${myPim} минут штрафа — поражение ${score}. Это проблема дисциплины или судейства?`,
      options: [
        opt('discipline', 'Наша вина. Глупые удаления — это то, что мы обязаны убрать.', { morale: -1, board: 2, fans: 0 }),
        opt('refs', 'Я посмотрю видео. Часть удалений вызывает вопросы.', { morale: 2, board: -2, fans: 2 }),
        opt('style', 'Мы играем жёстко и не изменим своему стилю.', { morale: 2, board: -1, fans: 1 }),
      ],
    };
  }
  if (!won && myXg > oppXg + 0.8) {
    return {
      ...base,
      topic: 'Не повезло',
      question: `По моментам вы были лучше (xG ${myXg.toFixed(1)}:${oppXg.toFixed(1)}), но проиграли ${score}. Что не так с реализацией?`,
      options: [
        opt('patience', 'Если продолжим так играть — шайбы полетят. Я спокоен.', { morale: 2, board: 0, fans: -1 }),
        opt('finish', 'Нападающие должны забивать такие моменты. Это их работа.', { morale: -2, board: 2, fans: 1 }),
        opt('goalie', 'Отдадим должное вратарю соперника — он сегодня был стеной.', { morale: 1, board: 1, fans: 0 }),
      ],
    };
  }
  if (won && winStreak >= 4) {
    return {
      ...base,
      topic: 'Победная серия',
      question: `Уже ${winStreak} побед подряд. Можно говорить о «${T.short}» как о фаворите?`,
      options: [
        opt('favorite', 'Да, мы хотим выигрывать всё и не прячемся.', { morale: 2, board: 1, fans: 3 }),
        opt('modest', 'Фаворитов определяет весна. Мы просто делаем свою работу.', { morale: 1, board: 2, fans: 0 }),
        opt('rest', 'Серия рано или поздно прервётся — важно, как мы на это ответим.', { morale: 0, board: 1, fans: -1 }),
      ],
    };
  }
  if (won) {
    return {
      ...base,
      topic: 'После победы',
      question: `Победа над «${opp.short}» — ${score}. Довольны игрой команды?`,
      options: [
        opt('happy', 'Да. План на игру выполнен, ребята молодцы.', { morale: 2, board: 1, fans: 1 }),
        opt('more', 'Результат есть, игры пока нет. Будем прибавлять.', { morale: 0, board: 2, fans: 0 }),
        opt('fans', 'Спасибо болельщикам — с такой поддержкой проигрывать нельзя.', { morale: 1, board: 0, fans: 3 }),
      ],
    };
  }
  return {
    ...base,
    topic: 'После поражения',
    question: `Поражение от «${opp.short}» — ${score}. В чём причина?`,
    options: [
      opt('self', 'Я неправильно подготовил команду. Исправим.', { morale: 2, board: -1, fans: 1 }),
      opt('effort', 'Не хватило самоотдачи. Это недопустимо.', { morale: -3, board: 2, fans: 2 }),
      opt('long', 'Сезон длинный. Сделаем выводы без паники.', { morale: 1, board: 1, fans: -1 }),
    ],
  };
}

/** Apply the chosen answer. Returns a short summary for the news feed. */
export function answerPressConference(state: GameState, optionId: string | null): string | null {
  const pc = state.press;
  if (!pc) return null;
  state.press = null;
  if (!optionId) return null;
  const o = pc.options.find((x) => x.id === optionId);
  if (!o) return null;
  const e = o.effects;
  const T = state.teams[state.userTeamId];
  for (const id of T.players) {
    const p = state.players[id];
    if (!p) continue;
    p.morale = clamp(p.morale + e.morale + (e.playerId === id ? e.playerMorale ?? 0 : 0), 25, 99);
  }
  if (state.board) state.board.confidence = clamp(state.board.confidence + e.board, 5, 100);
  state.fans = clamp((state.fans ?? 60) + e.fans, 0, 100);
  const parts: string[] = [];
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  if (e.morale) parts.push(`мораль ${sign(e.morale)}`);
  if (e.board) parts.push(`доверие руководства ${sign(e.board)}`);
  if (e.fans) parts.push(`болельщики ${sign(e.fans)}`);
  if (e.playerId && e.playerMorale) parts.push(`${state.players[e.playerId]?.name ?? 'игрок'} ${sign(e.playerMorale)}`);
  return `Пресс-конференция («${pc.topic}»): «${o.text}» ${parts.length ? '— ' + parts.join(', ') : ''}`.trim();
}

/** Gate revenue multiplier from fan support (60 = neutral). */
export const fanGateMult = (fans = 60) => 0.88 + clamp(fans, 0, 100) * 0.002;
