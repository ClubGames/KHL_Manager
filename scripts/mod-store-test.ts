// Mods installed from a .zip in the browser / the Android app (src/game/zip.ts + src/game/modStore.ts): the zip
// reader matches the desktop one, the layouts (a top folder, none, a multi-league pack) are found, files go into
// IndexedDB (fake-indexeddb here) under <id>/<path>, a reinstall replaces, removal deletes, zip-slip is ignored.
// Run: npx tsx scripts/mod-store-test.ts
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readZip, modsInZip } from '../src/game/zip';
import { storeModZip, storedMods, storedFile, removeStoredMod, fileType } from '../src/game/modStore';

const require = createRequire(import.meta.url);
const { writeZip } = require('../desktop/modInstall.cjs') as { writeZip: (files: Record<string, string | Buffer>, o?: { utf8Flag?: boolean }) => Buffer };
let pass = 0;
const test = async (name: string, fn: () => Promise<void>) => { await fn(); pass++; console.log('✓', name); };
const roster = JSON.stringify({ league: { name: 'Тест' }, teams: [] });
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

await test('the zip reader: names (UTF-8, cyrillic), sizes, inflate', async () => {
  const z = writeZip({ 'Лига/roster.json': roster, 'Лига/logos/ска.png': png, 'Лига/big.txt': 'x'.repeat(100000) });
  const e = readZip(new Uint8Array(z));
  assert.deepEqual(e.map((x) => x.name), ['Лига/roster.json', 'Лига/logos/ска.png', 'Лига/big.txt']);
  assert.equal(new TextDecoder().decode(await e[0].read()), roster);
  assert.deepEqual(Buffer.from(await e[1].read()), png);
  assert.equal((await e[2].read()).length, 100000);
  assert.throws(() => readZip(new Uint8Array([1, 2, 3, 4])), /не архив/);
});

await test('layouts: a top folder, no folder (named after the archive), a pack of leagues; junk and zip-slip skipped', async () => {
  const one = modsInZip(readZip(new Uint8Array(writeZip({ 'ВХЛ/roster.json': roster, 'ВХЛ/mod.json': '{}', '__MACOSX/ВХЛ/._roster.json': 'x', '../evil.json': 'x' }))), 'x.zip');
  assert.deepEqual(one.map((m) => [m.id, m.files.map((f) => f.rel).sort()]), [['ВХЛ', ['mod.json', 'roster.json']]]);
  const flat = modsInZip(readZip(new Uint8Array(writeZip({ 'roster.json': roster, 'logos/a.png': png }))), 'C:\\dl\\Моя лига.zip');
  assert.deepEqual(flat.map((m) => m.id), ['Моя лига']);
  const pack = modsInZip(readZip(new Uint8Array(writeZip({ 'Pack/A/roster.json': roster, 'Pack/B/roster.json': roster, 'Pack/B/backup/roster.json': roster }))), 'Pack.zip');
  assert.deepEqual(pack.map((m) => [m.id, m.files.length]), [['A', 1], ['B', 2]]);
  assert.throws(() => modsInZip(readZip(new Uint8Array(writeZip({ 'readme.txt': 'hi' }))), 'a.zip'), /нет roster\.json/);
});

await test('store: files under <id>/<path> with their types, the name from mod.json, a reinstall replaces, removal deletes', async () => {
  const r = await storeModZip(new Uint8Array(writeZip({ 'VHL/roster.json': roster, 'VHL/mod.json': JSON.stringify({ name: 'ВХЛ 2026/27' }), 'VHL/logos/a b.png': png })), 'VHL.zip');
  assert.deepEqual(r, { installed: [{ id: 'VHL', name: 'ВХЛ 2026/27', replaced: false }], errors: [] });
  const list = await storedMods();
  assert.deepEqual(list.map((m) => [m.id, m.name, m.files]), [['VHL', 'ВХЛ 2026/27', 3]]);
  assert.equal(await (await storedFile('VHL', 'roster.json'))!.text(), roster);
  assert.equal((await storedFile('VHL', 'logos/a b.png'))!.size, png.length);
  assert.equal(fileType('logos/a b.png'), 'image/png');
  const again = await storeModZip(new Uint8Array(writeZip({ 'VHL/roster.json': roster })), 'VHL.zip');
  assert.equal(again.installed[0].replaced, true);
  assert.equal(await storedFile('VHL', 'logos/a b.png'), null, 'files of the old version are gone');
  await storeModZip(new Uint8Array(writeZip({ 'VHL_B/roster.json': roster })), 'b.zip');
  await removeStoredMod('VHL');
  assert.deepEqual((await storedMods()).map((m) => m.id), ['VHL_B']);
  assert.equal(await storedFile('VHL', 'roster.json'), null);
  assert.ok(await storedFile('VHL_B', 'roster.json'), 'a mod whose name starts the same is kept');
});

console.log(`\n${pass} mod-store tests passed`);
