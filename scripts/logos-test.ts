// Run with: npx tsx scripts/logos-test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OFFICIAL_KHL_PALETTES, getClubLogoSources } from '../src/game/clubColors';

for (const [id, palette] of Object.entries(OFFICIAL_KHL_PALETTES)) {
  assert.ok(palette.logo, `${id}: bundled crest is required`);
  const png = readFileSync(`public/${palette.logo.replace(/^\.\//, '')}`);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${id}: PNG signature`);
  assert.equal(png.readUInt32BE(16), 160, `${id}: width`);
  assert.equal(png.readUInt32BE(20), 160, `${id}: height`);
  assert.equal(png[25], 6, `${id}: truecolour with alpha`);

  const expected = [palette.logo, palette.khlCdnLogo].filter(Boolean);
  assert.deepEqual(getClubLogoSources({ id }), expected, `${id}: local first, then CDN`);
  assert.deepEqual(getClubLogoSources({ id, logo: ' ./custom.png ' }), ['./custom.png', ...expected]);
  assert.deepEqual(getClubLogoSources({ id, logo: palette.logo }), expected, `${id}: no duplicate URLs`);
}

for (const [alias, id] of [
  ['metallurg', 'metallurg-mg'], ['dynamo-minsk', 'dinamo-mn'],
  ['dynamo-msk', 'dinamo-msk'], ['loko', 'lokomotiv'],
]) {
  assert.deepEqual(getClubLogoSources({ id: alias }), getClubLogoSources({ id }));
}
assert.deepEqual(getClubLogoSources({ name: '  САЛАВАТ   ЮЛАЕВ ' }), getClubLogoSources({ id: 'salavat' }));
assert.deepEqual(getClubLogoSources({ id: 'unknown' }), []);
assert.deepEqual(getClubLogoSources({ id: 'unknown', logo: 'custom.png' }), ['custom.png']);
console.log(`PASS: ${Object.keys(OFFICIAL_KHL_PALETTES).length} bundled RGBA crests, source ordering, overrides and aliases`);
