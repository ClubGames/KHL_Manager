// Run with: node scripts/mod-install-test.mjs
// «Установить мод»: desktop/modInstall.cjs unpacks a .zip into the mods folder (layouts, zip-slip, real zip tools).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { readZip, writeZip, installModZip, migrateMods, safeFolderName } = require('../desktop/modInstall.cjs');

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log('PASS', name); };
const fresh = () => mkdtempSync(path.join(tmpdir(), 'khl-mods-'));
const roster = JSON.stringify({ league: { name: 'Тестовая лига' }, teams: [] });

await ok('archive with a top folder → mods/<folder>, mod.json name reported', async () => {
  const dir = fresh();
  const zip = writeZip({ 'МояЛига/roster.json': roster, 'МояЛига/mod.json': JSON.stringify({ name: 'Моя лига 2027' }), 'МояЛига/logos/a.png': Buffer.from([1, 2, 3]) });
  const r = await installModZip(zip, 'download (1).zip', dir);
  assert.deepEqual(r.installed, [{ id: 'МояЛига', name: 'Моя лига 2027', replaced: false }]);
  assert.equal(readFileSync(path.join(dir, 'МояЛига', 'roster.json'), 'utf8'), roster);
  assert.deepEqual([...readFileSync(path.join(dir, 'МояЛига', 'logos', 'a.png'))], [1, 2, 3]);
});

await ok('archive without a top folder → folder named after the archive', async () => {
  const dir = fresh();
  const r = await installModZip(writeZip({ 'roster.json': roster, 'schedule.json': '{}' }), 'C:\\Downloads\\VHL_2627.zip', dir);
  assert.equal(r.installed[0].id, 'VHL_2627');
  assert.ok(existsSync(path.join(dir, 'VHL_2627', 'schedule.json')));
});

await ok('a pack with two leagues → two mods; __MACOSX junk ignored', async () => {
  const dir = fresh();
  const r = await installModZip(writeZip({ 'Pack/A/roster.json': roster, 'Pack/B/roster.json': roster, '__MACOSX/Pack/A/._roster.json': 'x', 'Pack/readme.txt': 'hi' }), 'Pack.zip', dir);
  assert.deepEqual(r.installed.map((m) => m.id).sort(), ['A', 'B']);
  assert.deepEqual(readdirSync(dir).sort(), ['A', 'B']);
});

await ok('reinstalling replaces the old version (stale files removed)', async () => {
  const dir = fresh();
  await installModZip(writeZip({ 'L/roster.json': roster, 'L/old.png': 'x' }), 'L.zip', dir);
  const r = await installModZip(writeZip({ 'L/roster.json': roster, 'L/new.png': 'y' }), 'L.zip', dir);
  assert.equal(r.installed[0].replaced, true);
  assert.ok(!existsSync(path.join(dir, 'L', 'old.png')));
  assert.ok(existsSync(path.join(dir, 'L', 'new.png')));
});

await ok('zip-slip entries (../, absolute paths) never leave the mods folder', async () => {
  const dir = fresh();
  const outside = path.join(path.dirname(dir), 'pwned-' + path.basename(dir) + '.txt');
  await installModZip(writeZip({ 'M/roster.json': roster, ['../' + path.basename(outside)]: 'x', 'M/../../evil.txt': 'x', '/etc/evil': 'x' }), 'M.zip', dir);
  assert.ok(!existsSync(outside));
  assert.deepEqual(readdirSync(dir), ['M']);
  assert.deepEqual(readdirSync(path.join(dir, 'M')), ['roster.json']);
});

await ok('no roster.json → a clear error, nothing written', async () => {
  const dir = fresh();
  await assert.rejects(installModZip(writeZip({ 'photos/a.png': 'x' }), 'x.zip', dir), /нет roster\.json/);
  await assert.rejects(installModZip(Buffer.from('not a zip at all'), 'x.zip', dir), /не архив/);
  assert.deepEqual(readdirSync(dir), []);
});

await ok('names without the UTF-8 flag: UTF-8 bytes and CP866 (Windows «Send to → zip») both decode', async () => {
  const utf = readZip(writeZip({ 'Лига/roster.json': roster }, { utf8Flag: false }));
  assert.equal(utf[0].name, 'Лига/roster.json');
  // CP866 "Лига" = 8B A8 A3 A0
  const z = writeZip({ 'XXXX/roster.json': roster }, { utf8Flag: false });
  const at = z.lastIndexOf(Buffer.from('XXXX'));
  const cp = Buffer.from([0x8b, 0xa8, 0xa3, 0xa0]);
  cp.copy(z, z.indexOf(Buffer.from('XXXX'))); cp.copy(z, at);
  const e = readZip(z);
  assert.equal(e[0].name, 'Лига/roster.json');
});

await ok('archives made by real tools (Info-ZIP zip, Python zipfile) install', async () => {
  const src = fresh(), dir = fresh();
  mkdirSync(path.join(src, 'КХЛ мод', 'logos'), { recursive: true });
  writeFileSync(path.join(src, 'КХЛ мод', 'roster.json'), roster);
  writeFileSync(path.join(src, 'КХЛ мод', 'logos', 'ska.png'), Buffer.alloc(5000, 7));
  let tools = 0;
  try {
    execFileSync('zip', ['-qr', path.join(src, 'a.zip'), 'КХЛ мод'], { cwd: src });
    const r = await installModZip(readFileSync(path.join(src, 'a.zip')), 'a.zip', dir);
    assert.equal(r.installed[0].id, 'КХЛ мод');
    assert.equal(readFileSync(path.join(dir, 'КХЛ мод', 'logos', 'ska.png')).length, 5000);
    tools++;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try {
    execFileSync('python3', ['-c', `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED)\nz.write(sys.argv[2],'roster.json')\nz.close()`, path.join(src, 'b.zip'), path.join(src, 'КХЛ мод', 'roster.json')]);
    const r = await installModZip(readFileSync(path.join(src, 'b.zip')), 'Без папки.zip', dir);
    assert.equal(r.installed[0].id, 'Без папки');
    tools++;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  console.log(`  (${tools} external zip tools checked)`);
});

await ok('migrating the old Documents folder copies mods without overwriting', async () => {
  const from = fresh(), to = fresh();
  mkdirSync(path.join(from, 'A')); writeFileSync(path.join(from, 'A', 'roster.json'), 'old');
  mkdirSync(path.join(from, 'B')); writeFileSync(path.join(from, 'B', 'roster.json'), 'b');
  mkdirSync(path.join(to, 'A')); writeFileSync(path.join(to, 'A', 'roster.json'), 'new');
  assert.deepEqual(await migrateMods(from, to), ['B']);
  assert.equal(readFileSync(path.join(to, 'A', 'roster.json'), 'utf8'), 'new');
  assert.equal(readFileSync(path.join(to, 'B', 'roster.json'), 'utf8'), 'b');
  assert.deepEqual(await migrateMods(path.join(from, 'missing'), to), []);
});

await ok('folder names are Windows-safe', () => {
  assert.equal(safeFolderName('a:b*c?'), 'a_b_c_');
  assert.equal(safeFolderName(' .hidden. '), 'hidden');
  assert.equal(safeFolderName('CON'), 'mod');
});

console.log(`\n${passed} passed`);
