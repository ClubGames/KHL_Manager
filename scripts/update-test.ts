// The update button finds the new build by kind of file, whatever the release names it.
// Run: npx tsx scripts/update-test.ts
import assert from 'node:assert/strict';
import { downloadUrl } from '../src/update';
import { APP_DOWNLOADS } from '../src/platform';

const R = 'https://github.com/ClubGames/KHL_Manager/releases/download/app/';
const assets = ['Hockey-Simulator-Manager-Setup.exe', 'Hockey-Simulator-Manager-Portable.exe', 'Hockey-Simulator-Manager.apk', 'KHL-GM-Setup.exe', 'KHL-GM-Portable.exe', 'KHL-GM.apk']
  .map(name => ({ name, browser_download_url: R + name }));
assert.equal(downloadUrl('windows', false, assets), R + 'Hockey-Simulator-Manager-Setup.exe');
assert.equal(downloadUrl('windows', true, assets), R + 'Hockey-Simulator-Manager-Portable.exe');
assert.equal(downloadUrl('android', false, assets), R + 'Hockey-Simulator-Manager.apk');
// a later rename still works; junk is ignored; no list → the known addresses
assert.equal(downloadUrl('windows', true, [{ name: 'Other-Name-Portable.exe', browser_download_url: R + 'Other-Name-Portable.exe' }]), R + 'Other-Name-Portable.exe');
assert.equal(downloadUrl('android', false, [{ name: 'x.apk', browser_download_url: 'javascript:alert(1)' }]), APP_DOWNLOADS.android);
assert.equal(downloadUrl('windows', false, []), APP_DOWNLOADS.windowsSetup);
for (const u of Object.values(APP_DOWNLOADS)) assert.ok(!/KHL-GM/.test(u), `download links carry the game's name: ${u}`);
console.log('ok update links');
