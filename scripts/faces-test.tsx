// Player photos (`face` in roster.json) and the club card.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { normalizeFaceUrl, parseRosterText } from '../src/game/roster';
import * as G from '../src/game/state';
import { clubLeaders, clubProfile, clubStrength } from '../src/game/teamInfo';
import { ClubOverview, TeamModal } from '../src/components/TeamInfo';
import { PlayerFace, UIContext } from '../src/components/ui';

const text = readFileSync('roster.json', 'utf8');
const raw = JSON.parse(text);
const r = parseRosterText(text);
let n = 0;
const ok = (m: string) => {
  n++;
  console.log('ok', m);
};

// 1. Parsing
const rawFaces = new Map<string, string>();
for (const t of raw.teams) for (const p of t.players) if (p.face) rawFaces.set(p.id, p.face);
for (const p of raw.freeAgents ?? []) if (p.face) rawFaces.set(p.id, p.face);
const parsed = Object.values(r.players).filter((p) => p.face);
assert.equal(parsed.length, rawFaces.size);
for (const p of parsed) assert.equal(p.face, rawFaces.get(p.id));
const without = Object.values(r.players).filter((p) => !p.face).length;
assert.ok(without > 0, 'some players have no photo in the file');
ok(`roster.json: ${parsed.length} photos parsed exactly, ${without} players without a photo`);

assert.equal(normalizeFaceUrl('https://www.khl.ru/img/a.jpg'), 'https://www.khl.ru/img/a.jpg');
assert.equal(normalizeFaceUrl('  ./faces/ivanov.png '), './faces/ivanov.png');
assert.equal(normalizeFaceUrl('faces/ivanov.webp'), 'faces/ivanov.webp');
assert.equal(normalizeFaceUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
for (const bad of ['', null, 42, 'javascript:alert(1)', 'нет фото', '   ']) assert.equal(normalizeFaceUrl(bad), undefined);
const alt = parseRosterText(
  JSON.stringify({
    teams: [
      { id: 't', name: 'T', conference: 'Запад', players: [{ name: 'A Б', photo: 'https://x.y/a.jpg' }, { name: 'В Г', face: 'javascript:x' }] },
      { id: 'u', name: 'U', conference: 'Восток', players: [{ name: 'Д Е' }] },
    ],
  })
);
const altPs = Object.values(alt.players);
assert.equal(altPs[0].face, 'https://x.y/a.jpg');
assert.equal(altPs[1].face, undefined);
ok('face URLs: http(s), relative paths and data:image accepted; junk and javascript: rejected; `photo` alias works');

// 2. New career keeps photos; old careers adopt them once
const st = G.createGameState(r, 'ska');
assert.equal(st.facesSynced, true);
assert.equal(Object.values(st.players).filter((p) => p.face).length, parsed.length);
const legacy = JSON.parse(JSON.stringify(st));
delete legacy.facesSynced;
for (const p of Object.values<{ face?: string }>(legacy.players)) delete p.face;
legacy.players[Object.keys(legacy.players)[0]].name = 'Переименованный Игрок'; // id match with another name: skipped
const migrated = G.migrateState(legacy)!;
assert.ok(!migrated.facesSynced);
const filled = G.adoptRosterFaces(migrated, r);
assert.equal(migrated.facesSynced, true);
assert.ok(filled >= parsed.length - 1 && filled <= parsed.length, `filled ${filled}`);
assert.equal(G.adoptRosterFaces(migrated, r), 0, 'second pass changes nothing');
ok(`old save: ${filled} photos adopted by id/name, renamed player skipped, idempotent`);

// 2b. Editing roster.json later updates careers that already have photos (changed link, removed link, new link)
{
  const save = G.createGameState(r, 'ska');
  const withFace = Object.values(save.players).filter((p) => p.face);
  const noFace = Object.values(save.players).find((p) => !p.face && r.players[p.id])!;
  const [changedP, removedP] = withFace;
  const edited = JSON.parse(JSON.stringify(r)) as typeof r;
  edited.players[changedP.id].face = 'https://www.khl.ru/img/new/changed.jpg';
  delete edited.players[removedP.id].face;
  edited.players[noFace.id].face = 'https://www.khl.ru/img/new/added.jpg';
  const changed = G.adoptRosterFaces(save, edited);
  assert.equal(changed, 3, `changed ${changed}`);
  assert.equal(save.players[changedP.id].face, 'https://www.khl.ru/img/new/changed.jpg');
  assert.equal(save.players[removedP.id].face, undefined);
  assert.equal(save.players[noFace.id].face, 'https://www.khl.ru/img/new/added.jpg');
  assert.equal(G.adoptRosterFaces(save, edited), 0);

  // the real loader: fetches roster.json on every open and re-saves only when something changed
  const text = JSON.stringify({ ...JSON.parse(readFileSync('roster.json', 'utf8')) });
  const raw = JSON.parse(text);
  const target = raw.teams.find((t: { id: string }) => t.id === 'ska').players.find((p: { face?: string }) => p.face);
  const old = G.createGameState(parseRosterText(text), 'ska');
  const id = Object.values(old.players).find((p) => p.face === target.face)!.id;
  target.face = 'https://www.khl.ru/img/teamplayers_db/15542/updated.jpg';
  let served = JSON.stringify(raw);
  (globalThis as { fetch: unknown }).fetch = async () => ({ ok: true, status: 200, text: async () => served });
  G.store.set(old);
  let n = await G.syncFacesFromRoster(old.saveId);
  assert.equal(n, 1);
  assert.equal(G.store.get()!.players[id].face, 'https://www.khl.ru/img/teamplayers_db/15542/updated.jpg');
  const ref = G.store.get();
  n = await G.syncFacesFromRoster(old.saveId);
  assert.equal(n, 0);
  assert.equal(G.store.get(), ref, 'unchanged roster does not touch the state');
  served = '<html>';
  assert.equal(await G.syncFacesFromRoster(old.saveId), 0, 'broken roster.json keeps the saved photos');
  ok('roster edits reach old saves: changed, removed and added links; no-op when unchanged');
}

// 3. Club profile
const ska = st.teams.ska;
const pr = clubProfile(st.players, ska, st.teamOrder.map((id) => st.teams[id]));
assert.ok(pr.rank >= 1 && pr.rank <= st.teamOrder.length);
assert.equal(pr.strength, clubStrength(st.players, ska));
assert.equal(pr.stars.length, 5);
assert.ok(pr.stars[0].overall >= pr.stars[4].overall);
assert.ok(pr.attack > 50 && pr.defense > 50 && pr.goalie > 50);
const ranks = st.teamOrder.map((id) => clubProfile(st.players, st.teams[id], st.teamOrder.map((x) => st.teams[x])).rank);
assert.ok(ranks.includes(1));
assert.equal(clubLeaders(st.players, ska).scorers.length, 0, 'no leaders before the first game');
ok(`club profile: SKA strength ${pr.strength} (#${pr.rank}), attack ${pr.attack}, defense ${pr.defense}, goalie ${pr.goalie}`);

// 4. Rendering
const ui = { openPlayer() {}, openTeam() {}, openGame() {}, confirm() {}, nav() {}, tradeWith() {}, negotiate() {} };
const html = renderToStaticMarkup(<PlayerFace face="https://x.y/a.jpg" name="Иван Петров" size={30} />);
assert.ok(html.includes('src="https://x.y/a.jpg"') && /referrerpolicy="no-referrer"/i.test(html));
const noFace = renderToStaticMarkup(<PlayerFace name="Иван Петров" number={17} team={ska} size={30} />);
assert.ok(noFace.includes('ИП') && noFace.includes('data-face="initials"'));
G.store.set(st);
const card = renderToStaticMarkup(
  <UIContext.Provider value={ui}>
    <TeamModal id="avangard" onClose={() => {}} />
  </UIContext.Provider>
);
assert.ok(card.includes('data-team-modal="avangard"') && card.includes('Авангард') && card.includes('Тренерский штаб') && card.includes('Обмен с клубом'));
assert.ok((card.match(/data-face="photo"/g) ?? []).length >= 3, 'club card shows photos');
const preview = renderToStaticMarkup(<ClubOverview team={r.teams[0]} P={r.players} teams={r.teams} chip={(p) => <b>{p.overall}</b>} />);
assert.ok(preview.includes('Лучшие игроки') && preview.includes('Сила состава'));
ok('PlayerFace photo/initials, in-game club card and selection-screen overview render');

console.log(`PASS: ${n} faces & club card checks`);
