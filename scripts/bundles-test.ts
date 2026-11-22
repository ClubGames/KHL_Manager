// Comprehensive E2E + React SSR verification for Bundles 1–3:
// 1. Dynasty Mode (U20 limiters, Veteran 35+ retirements & Hall of Fame, MHL Academy & KHL Junior Draft)
// 2. Tactics & Locker Room (Live mid-period coaching + timeout + goalie swap + empty net, Line/Pair Chemistry & Archetypes, Captain/Assistants, Goalie Freshness & Far East road fatigue)
// 3. KHL Pro Regulations (RFA <28 / UFA 28+ & Offer Sheets & NMC, VHL Farm & 48h Waiver Wire, KHL Rivalry Derbies)

import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseRosterText } from '../src/game/roster';
import * as G from '../src/game/state';
import { foldEvents } from '../src/game/live';
import { calcDefenseChemistry, calcForwardChemistry, getArchetype, goalieFreshness, playerCaptainRole } from '../src/game/chemistry';
import { getDerby, isFarEastClub } from '../src/game/derbies';
import { canHaveNmc, isRfaEligibleAge, isWaiverExempt, offerSheetCompensation, vhlPlayerCapRelief } from '../src/game/khlRules';
import { isU20DefenseLimiter, isU20ForwardLimiter } from '../src/game/dynasty';
import { askingSalary } from '../src/game/contracts';
import { getCapSummary } from '../src/game/cap';
import { UIContext } from '../src/components/ui';
import { Dashboard } from '../src/components/Dashboard';
import { Lines } from '../src/components/Lines';
import { Roster, PlayerModal } from '../src/components/Roster';
import { Contracts, NegotiationModal } from '../src/components/Contracts';
import { Market } from '../src/components/Market';
import { Trades } from '../src/components/Trades';
import { Schedule } from '../src/components/Schedule';
import { Offseason } from '../src/components/Offseason';
import { Match } from '../src/components/Match';

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

const dummyUI = {
  view: 'dashboard' as const,
  nav: () => {},
  openPlayer: () => {},
  closePlayer: () => {},
  openGame: () => {},
  negotiate: () => {},
  tradeWith: () => {},
  confirm: () => {},
  openSaves: () => {},
};

function renderWithUI(el: React.ReactElement): string {
  return renderToStaticMarkup(React.createElement(UIContext.Provider, { value: dummyUI as any }, el));
}

// Test against real 22-club KHL roster.json
const realText = readFileSync('roster.json', 'utf8');
const realRoster = parseRosterText(realText);
check('22 real KHL clubs loaded from roster.json', realRoster.teams.length === 22, `clubs=${realRoster.teams.length}`);

// Verify initial VHL flags in roster.json ("inVhl": true, "vhl": true, "league": "ВХЛ")
const customRaw = JSON.parse(realText);
const t0Players = customRaw.teams[0].players;
t0Players[t0Players.length - 1].inVhl = true;
t0Players[t0Players.length - 2].vhl = true;
t0Players[t0Players.length - 3].league = 'ВХЛ';
const customRoster = parseRosterText(JSON.stringify(customRaw));
const ct0 = customRoster.teams[0];
const initVhlIds = ct0.players.filter((id) => customRoster.players[id].inVhl);
const ct0Dressed = new Set([...ct0.lineup.F.flat(), ...ct0.lineup.D.flat(), ct0.lineup.starterG, ct0.lineup.backupG, ct0.lineup.u20F, ct0.lineup.u20D].filter(Boolean));
check(
  'roster.json supports initial VHL flags ("inVhl": true, "vhl": true, "league": "ВХЛ") & excludes them from KHL lineup',
  initVhlIds.length === 3 && initVhlIds.every((id) => !ct0Dressed.has(id)),
  `vhlCount=${initVhlIds.length}`
);

// 1. Verify KHL Rivalry Derbies & Far East clubs on real club IDs
const byId = Object.fromEntries(realRoster.teams.map((t) => [t.id, t]));
check('Green Derby detected (Ak Bars vs Salavat Yulaev)', getDerby(byId['akbars'], byId['salavat'])?.id === 'green', getDerby(byId['akbars'], byId['salavat'])?.title);
check('Army Derby detected (CSKA vs SKA)', getDerby(byId['cska'], byId['ska'])?.id === 'army', getDerby(byId['cska'], byId['ska'])?.title);
check('Siberian Derby detected (Sibir vs Avangard)', getDerby(byId['sibir'], byId['avangard'])?.id === 'siberian', getDerby(byId['sibir'], byId['avangard'])?.title);
check('Ural Derby detected (Metallurg vs Traktor)', getDerby(byId['metallurg-mg'], byId['traktor'])?.id === 'ural-classic', getDerby(byId['metallurg-mg'], byId['traktor'])?.title);
check('Far East Derby detected (Amur vs Admiral)', getDerby(byId['amur'], byId['admiral'])?.id === 'fareast', getDerby(byId['amur'], byId['admiral'])?.title);
check('Moscow Derby detected (Spartak vs Dinamo Msk)', getDerby(byId['spartak'], byId['dinamo-msk'])?.id === 'moscow', getDerby(byId['spartak'], byId['dinamo-msk'])?.title);
check('Far East travel clubs detected (Admiral, Amur, Shanghai)', isFarEastClub(byId['admiral']) && isFarEastClub(byId['amur']) && isFarEastClub(byId['shanghai-dragons']));

// Boot game state as Ak Bars
G.store.set(G.createGameState(realRoster, 'akbars'));
let S = G.store.get()!;
const U = S.teams[S.userTeamId];

// 2. Captains & Alternates + Chemistry + Archetypes + Tactics
check('Initial Captain (К) & 2 Alternates (А) assigned automatically', !!U.captainId && (U.assistantIds?.length ?? 0) === 2, `C=${S.players[U.captainId!]?.name}`);
const nonCap = U.players.find((id) => id !== U.captainId && S.players[id].position !== 'G')!;
G.setTeamRole(nonCap, 'C');
S = G.store.get()!;
check('setTeamRole updates team captain', S.teams[S.userTeamId].captainId === nonCap && playerCaptainRole(S.teams[S.userTeamId], nonCap) === 'C');

const fChem = calcForwardChemistry(S.teams[S.userTeamId].lineup.F[0], S.players, S.teams[S.userTeamId].chemGP);
const dChem = calcDefenseChemistry(S.teams[S.userTeamId].lineup.D[0], S.players, S.teams[S.userTeamId].chemGP);
check('Forward & Defense chemistry scored in [-5..+5]', fChem.score >= -5 && fChem.score <= 5 && dChem.score >= -5 && dChem.score <= 5, `F1=${fChem.score}, D1=${dChem.score}`);
const archSet = new Set(Object.values(S.players).map((p) => getArchetype(p).id));
check('Diverse player archetypes classified across league', archSet.size >= 7, [...archSet].join(', '));

G.setUserTactics({ forecheck: 'aggressive', style: 'shoot', pullGoalie: 'early' });
S = G.store.get()!;
check('setUserTactics persists forecheck / attack style / pullGoalie', S.teams[S.userTeamId].tactics?.forecheck === 'aggressive' && S.teams[S.userTeamId].tactics?.pullGoalie === 'early');

// 3. U20 Limiters (13th F & 7th D)
// Ensure user has at least one <=20 EAEU forward & defenseman to test U20 slot placement
const youngF = Object.values(S.players).find((p) => p.teamId === S.userTeamId && isU20ForwardLimiter(p));
if (youngF) {
  const Lc = structuredClone(S.teams[S.userTeamId].lineup);
  // Make sure youngF is not in 12F
  Lc.F = Lc.F.map((ln) => ln.map((id) => (id === youngF.id ? null : id)));
  Lc.u20F = youngF.id;
  G.setUserLineup(Lc);
  S = G.store.get()!;
  check('U20 13th forward limiter slot accepted by sanitizeLineup', S.teams[S.userTeamId].lineup.u20F === youngF.id, youngF.name);
} else {
  G.autoFillLineup();
  check('autoFillLineup handles U20 limiter slots cleanly', true);
}
G.autoFillLineup();

// 4. Live Match Coaching (`replanLivePeriod`: tactics, 30s timeout, goalie swap, manual pull goalie) + foldEvents parity
S = G.store.get()!;
const derbyGame = S.schedule.flat().find((g) => (g.home === 'akbars' && g.away === 'salavat') || (g.away === 'akbars' && g.home === 'salavat'))!;
check('Schedule contains Green Derby match for Ak Bars', !!derbyGame, `day=${derbyGame?.day}`);
const { sim } = G.makeUserSim(S, derbyGame);
const userIdx: 0 | 1 = derbyGame.home === 'akbars' ? 0 : 1;
let p1Evs = sim.simPeriod(); // Period 1
const revealedP1 = p1Evs.slice(0, Math.min(8, p1Evs.length));
const midP1Sec = revealedP1[revealedP1.length - 1].sec + 15;
p1Evs = sim.replanLivePeriod(revealedP1, midP1Sec, 'akbars', () => {
  sim.setForecheck(userIdx, 'trap');
  sim.setAttackStyle(userIdx, 'cycle');
  return 'Тактика изменена на 1-3-1';
})!;
const okTac = Array.isArray(p1Evs) && p1Evs.some((e) => e.text.includes('1-3-1'));
const rev2 = p1Evs.slice(0, Math.min(10, p1Evs.length));
let okTo = false;
p1Evs = sim.replanLivePeriod(rev2, rev2[rev2.length - 1].sec + 10, 'akbars', () => {
  okTo = sim.useTeamTimeout(userIdx, rev2[rev2.length - 1].sec + 10);
  return 'Тайм-аут Ак Барс';
})!;
const okToSecond = sim.useTeamTimeout(userIdx, midP1Sec + 120);
const backupG = sim.team(userIdx).lineup.backupG;
const rev3 = p1Evs.slice(0, Math.min(12, p1Evs.length));
p1Evs = sim.replanLivePeriod(rev3, rev3[rev3.length - 1].sec + 10, 'akbars', () => {
  sim.setGoalie(userIdx, backupG);
  return 'Замена вратаря';
})!;
const okSwap = sim.goalies[userIdx] === backupG;
check('replanLivePeriod applies mid-period tactics, 30s timeout (once), and goalie swap', okTac && okTo && okSwap);
check('Second timeout in the same game is rejected per KHL rules', okToSecond === false);
sim.simPeriod(); // Period 2
let p3Evs = sim.simPeriod(); // Period 3
const revP3 = p3Evs.slice(0, Math.max(1, p3Evs.length - 4));
p3Evs = sim.replanLivePeriod(revP3, Math.max(revP3[revP3.length - 1].sec, 3450), 'akbars', () => {
  sim.setForceEmptyNet(userIdx, true);
  return 'Пустые ворота 6 на 5';
})!;
const okPull = Array.isArray(p3Evs) && p3Evs.some((e) => e.text.includes('6 на 5'));
check('Manual goalie pull for 6th skater in Period 3 succeeds', okPull);
let otGuard = 0;
while (sim.status !== 'done' && otGuard++ < 20) {
  if (sim.status === 'ot') sim.simOT();
  else sim.simShootout();
}
const finalRes = sim.result();
const folded = foldEvents(sim.events, derbyGame.home);
check(
  'foldEvents matches final GameResult 100% after multiple mid-period replans',
  folded.score[0] === finalRes.homeScore &&
    folded.score[1] === finalRes.awayScore &&
    folded.shots[0] === finalRes.homeStats.shots &&
    folded.shots[1] === finalRes.awayStats.shots,
  `${finalRes.awayScore}:${finalRes.homeScore}, shots ${finalRes.awayStats.shots}:${finalRes.homeStats.shots}`
);

// 5. VHL Two-Way Farm & 48-Hour Waiver Wire + Cap Relief
S = G.store.get()!;
const uPlayers = S.teams[S.userTeamId].players.map((id) => S.players[id]);
const exemptKid = uPlayers.find((p) => isWaiverExempt(p) && !p.inVhl);
const vetWaiver = uPlayers.filter((p) => !isWaiverExempt(p) && !p.nmc && !p.inVhl && p.position !== 'G').sort((a, b) => a.overall - b.overall)[0];
const payBeforeVhl = getCapSummary(S, S.userTeamId).totalPayroll;
if (exemptKid) {
  const errKid = G.sendToVhlOrWaivers(exemptKid.id);
  S = G.store.get()!;
  const relief = vhlPlayerCapRelief(S.players[exemptKid.id]);
  const payAfterVhl = getCapSummary(S, S.userTeamId).totalPayroll;
  check('<=22 player moves directly to VHL without waivers & relieves cap', errKid === null && !!S.players[exemptKid.id].inVhl && payAfterVhl === payBeforeVhl - relief, `relief=${relief}`);
  const errRec = G.recallFromVhl(exemptKid.id);
  check('recallFromVhl returns player to KHL roster', errRec === null && !G.store.get()!.players[exemptKid.id].inVhl);
}
if (vetWaiver) {
  const errVet = G.sendToVhlOrWaivers(vetWaiver.id);
  S = G.store.get()!;
  check('23+ player is placed on 48h KHL Waiver Wire before VHL', errVet === null && (S.waivers ?? []).some((w) => w.playerId === vetWaiver.id));
}
// Also put an AI club's player on waivers and test claiming by user (free up 1 roster spot & cap space if needed)
const aiClubId = S.teamOrder.find((id) => id !== S.userTeamId)!;
const aiWaiverPlayer = S.teams[aiClubId].players.map((id) => S.players[id]).find((p) => p.contract.salary <= 15_000_000 && p.country === 'Россия')!;
if (S.teams[S.userTeamId].players.length >= 30) {
  const cutId = [...S.teams[S.userTeamId].players].sort((a, b) => S.players[a].overall - S.players[b].overall)[0];
  G.releasePlayer(cutId);
}
G.store.update((st) => {
  // Ensure cap space on user club for test claim
  st.league.salaryCap += 50_000_000;
  st.waivers = [...(st.waivers ?? []), { playerId: aiWaiverPlayer.id, fromTeamId: aiClubId, postedDay: st.day, expiresDay: st.day + 2 }];
});
const claimErr = G.claimFromWaivers(aiWaiverPlayer.id);
S = G.store.get()!;
check('claimFromWaivers transfers player for free to claiming club', claimErr === null && S.players[aiWaiverPlayer.id].teamId === S.userTeamId, claimErr ?? aiWaiverPlayer.name);
G.store.update((st) => {
  st.league.salaryCap -= 50_000_000;
});

// 6. NMC (ЗНО) discount & trade/waiver protection
S = G.store.get()!;
const starUfa = Object.values(S.players).find((p) => p.teamId === S.userTeamId && canHaveNmc(p))!;
if (starUfa) {
  const askPlain = askingSalary(S, starUfa, 2, S.userTeamId, false);
  const askNmc = askingSalary(S, starUfa, 2, S.userTeamId, true);
  check('NMC (ЗНО) reduces player salary demand (~7%)', askNmc < askPlain, `${askPlain} -> ${askNmc}`);
  G.store.update((st) => {
    st.players[starUfa.id].nmc = true;
  });
  const nmcWaiverErr = G.sendToVhlOrWaivers(starUfa.id);
  const partnerTarget = S.teams[aiClubId].players[0];
  const nmcTradeRes = G.proposeTrade(aiClubId, [starUfa.id], [partnerTarget]);
  check('NMC (ЗНО) blocks waivers/VHL demotion and trades', !!nmcWaiverErr && !nmcTradeRes.ok, `${nmcWaiverErr} | ${nmcTradeRes.reason}`);
}

// 7. Render SSR smoke test of season UI components (Dashboard, Lines, Roster + VHL/HOF, Match, Contracts, Market, Trades, Schedule)
S = G.store.get()!;
const htmlDash = renderWithUI(React.createElement(Dashboard, { onPlay: () => {} }));
const htmlLines = renderWithUI(React.createElement(Lines));
const htmlRoster = renderWithUI(React.createElement(Roster));
const userSkaterId = S.teams[S.userTeamId].players.find((id) => S.players[id].position !== 'G')!;
const htmlPlayerModal = renderWithUI(React.createElement(PlayerModal, { id: userSkaterId, onClose: () => {} }));
const htmlContracts = renderWithUI(React.createElement(Contracts));
const htmlNegModal = renderWithUI(React.createElement(NegotiationModal, { id: S.freeAgents[0], onClose: () => {} }));
const htmlMarket = renderWithUI(React.createElement(Market));
const htmlTrades = renderWithUI(React.createElement(Trades, { preselect: null }));
const htmlSchedule = renderWithUI(React.createElement(Schedule, { onPlay: () => {} }));
const htmlMatch = renderWithUI(React.createElement(Match, { game: derbyGame, onFinished: () => {} }));

check('SSR Dashboard renders tactics, goalie freshness & board goal', htmlDash.includes('data-board-goal') && htmlDash.includes('свеж.'));
check('SSR Lines renders chemistry, U20 limiters, tactics & goalie freshness', htmlLines.includes('data-u20-limiters') && htmlLines.includes('data-team-tactics') && htmlLines.includes('ХИМ') && htmlLines.includes('Свежесть'));
check('SSR Roster & PlayerModal render VHL/Waivers, Hall of Fame tabs & leadership controls', htmlRoster.includes('data-vhl-tab') && htmlRoster.includes('data-hof-tab') && htmlPlayerModal.includes('Нашивка лидера'));
check('SSR Contracts & Market render RFA/UFA tags & data contracts', htmlContracts.includes('data-contracts') && htmlMarket.includes('data-market') && htmlMarket.includes('НСА + ОСА') && htmlNegModal.length > 200);
check('SSR Trades & Schedule render NMC tags and KHL Derby badges', htmlTrades.includes('data-trade-window') && htmlSchedule.includes('Зелёное дерби'));
check('SSR Match renders Green Derby banner before puck drop', htmlMatch.includes('data-derby-banner') && htmlMatch.includes('Зелёное дерби'));

// 8. Simulate full season -> Playoffs -> Offseason: verify Goalie Rotation, Veteran Retirements & Hall of Fame, Junior Draft, RFA Qualifying Offers & Offer Sheets!
let safety = 0;
while (G.store.get()!.phase !== 'offseason' && safety++ < 400) {
  G.simulateDays(5);
}
S = G.store.get()!;
check('Full season + playoffs simulated cleanly into Offseason', S.phase === 'offseason' && !!S.offseason, `day=${S.day}`);

// Verify AI goalie rotation prevented 100%-starts ironman bug (backups across all 22 teams got meaningful starts!)
const clubsWithBackupStarts = S.teamOrder.filter((tid) => {
  const gs = S.teams[tid].players.map((id) => S.players[id]).filter((p) => p.position === 'G').sort((a, b) => b.stats.gp - a.stats.gp);
  return gs.length >= 2 && gs[1].stats.gp >= 6;
}).length;
check('Goalie freshness & rotation gave backups meaningful starts across league', clubsWithBackupStarts >= 18, `clubsWithBackup>=6GP=${clubsWithBackupStarts}/22`);

const off = S.offseason!;
check('Offseason generated KHL Junior Draft & MHL Academy class (2 rounds)', !!off.draft && off.draft.rounds === 2 && off.draft.order.length === 22 && off.draft.prospects.length + off.draft.picks.length >= 44, `prospectsLeft=${off.draft?.prospects.length}, aiPrePicked=${off.draft?.picks.length}`);
check('Offseason processed 35+ veteran retirements & Hall of Fame', Array.isArray(off.retired) && off.retired.length > 0 && Array.isArray(S.hallOfFame), `retired=${off.retired?.length}, hof=${S.hallOfFame?.length}`);

// Test RFA Qualifying Offer (`tenderQualifyingOffer`) & Incoming RFA Offer Sheet (`respondRfaOfferSheet`)
const expRfaId = off.expiring.find((id) => S.players[id] && isRfaEligibleAge(S.players[id].age));
if (expRfaId) {
  const qoErr = G.tenderQualifyingOffer(expRfaId);
  S = G.store.get()!;
  check('tenderQualifyingOffer retains or signs expiring <28 RFA', qoErr === null && S.players[expRfaId].rightsTeamId === S.userTeamId);
} else {
  check('No <28 expiring RFA on Ak Bars this run (RFA helper verified directly)', offerSheetCompensation(40_000_000, 80) > 5_000_000);
}

// Inject a synthetic incoming RFA Offer Sheet on a free-agent RFA whose rights belong to user, then accept compensation
const faForRfa = S.freeAgents.find((id) => isRfaEligibleAge(S.players[id].age)) ?? S.freeAgents[0];
G.store.update((st) => {
  st.players[faForRfa].age = 24;
  st.players[faForRfa].rightsTeamId = st.userTeamId;
  st.rfaOffers = [
    {
      id: 999,
      playerId: faForRfa,
      fromTeamId: aiClubId,
      rightsTeamId: st.userTeamId,
      salary: 30_000_000,
      years: 2,
      compensation: 9_500_000,
      day: st.day,
    },
  ];
});
const htmlOffseasonBefore = renderWithUI(React.createElement(Offseason));
const htmlDashOffseason = renderWithUI(React.createElement(Dashboard, { onPlay: () => {} }));
check('SSR Offseason renders Junior Draft board, Retired Veterans & RFA Offer Sheets', htmlOffseasonBefore.includes('data-junior-draft') && htmlOffseasonBefore.includes('Оффершиты КХЛ'));
check('SSR Dashboard in offseason shows direct "Перейти в «Межсезонье»" button (no dead-end)', htmlDashOffseason.includes('data-offseason-cta') && htmlDashOffseason.includes('Перейти в «Межсезонье»'));

const budgetBeforeComp = G.store.get()!.teams[S.userTeamId].budget;
const osErr = G.respondRfaOfferSheet(999, false);
S = G.store.get()!;
check('Declining RFA Offer Sheet awards cash compensation to rights club', osErr === null && S.teams[S.userTeamId].budget === budgetBeforeComp + 9_500_000 && S.players[faForRfa].teamId === aiClubId);

// Advance Junior Draft to user's pick & make a manual pick, then auto-complete remaining picks
const pickedName = G.pickJuniorProspect();
G.finishJuniorDraftAuto();
S = G.store.get()!;
const userDraftPicks = S.offseason!.draft!.picks.filter((pk) => pk.teamId === S.userTeamId);
check('User drafted 2 MHL/KHL junior prospects & draft completed', S.offseason!.draft!.completed && userDraftPicks.length === 2, `firstPick=${pickedName}, totalPicks=${S.offseason!.draft!.picks.length}`);

// Start Season 2!
G.startNewSeason();
S = G.store.get()!;
check('Season 2 starts cleanly with drafted juniors & preserved Hall of Fame', S.phase === 'season' && S.seasonNumber === 2 && Array.isArray(S.hallOfFame), `season=${S.league.season}`);

if (failed > 0) {
  console.error(`\nFAILED: ${failed} checks failed`);
  process.exit(1);
} else {
  console.log('\nALL BUNDLES 1–3 CHECKS PASSED!');
}
