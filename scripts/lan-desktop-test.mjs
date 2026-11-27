// The Windows app's sockets (desktop/lan.cjs) for real: a host and a guest on this machine — a game found by its
// beacon, messages both ways (long ones, Cyrillic, many at once), a second guest told the game is busy, a closed
// connection noticed on the other end.
// Run: node scripts/lan-desktop-test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLan, broadcasts } = require('../desktop/lan.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) return false; await sleep(10); } return true; };
let pass = 0;
const ok = (name) => { pass++; console.log('✓', name); };

const hostEv = [], guestEv = [], thirdEv = [];
const host = createLan((e) => hostEv.push(e)), guest = createLan((e) => guestEv.push(e)), third = createLan((e) => thirdEv.push(e));
const BEACON = 47911, PORT = 47910;

assert.ok(broadcasts().includes('255.255.255.255'));
await guest.scan({ port: BEACON });
const r = await host.host({ port: PORT, beaconPort: BEACON, beacon: JSON.stringify({ khl: 'lan', name: 'Хозяин', port: PORT, v: 1 }) });
assert.equal(r.port, PORT);
assert.ok(Array.isArray(r.addresses));
console.log('   addresses:', r.addresses.join(', ') || '(none)');
const found = await until(() => guestEv.some((e) => e.type === 'found'), 3500);
if (found) { const f = guestEv.find((e) => e.type === 'found'); assert.equal(JSON.parse(f.data).name, 'Хозяин'); ok(`the guest hears the host's beacon (${f.host})`); }
else console.log('   (no UDP broadcast in this sandbox: the beacon is not heard here — checked on real networks only)');
await guest.stopScan();

await guest.join({ host: '127.0.0.1', port: r.port });
assert.ok(await until(() => hostEv.some((e) => e.type === 'peer')), 'the host sees the guest');
ok('the guest connects, the host is told');

const big = JSON.stringify({ t: 'tick', s: 'ш'.repeat(200000) });
guest.send({ data: JSON.stringify({ t: 'hello', name: 'Гость' }) });
host.send({ data: big });
for (let i = 0; i < 200; i++) host.send({ data: JSON.stringify({ t: 'pad', i }) });
assert.ok(await until(() => hostEv.some((e) => e.type === 'message')));
assert.equal(JSON.parse(hostEv.find((e) => e.type === 'message').data).name, 'Гость');
assert.ok(await until(() => guestEv.filter((e) => e.type === 'message').length === 201));
const msgs = guestEv.filter((e) => e.type === 'message');
assert.equal(msgs[0].data, big, 'a long message arrives whole');
assert.deepEqual(msgs.slice(1).map((m) => JSON.parse(m.data).i), [...Array(200).keys()], 'in order, none lost');
ok('messages both ways: Cyrillic, 400 KB in one, 200 in a row — whole and in order');

await third.join({ host: '127.0.0.1', port: r.port });
assert.ok(await until(() => thirdEv.some((e) => e.type === 'message')));
assert.equal(JSON.parse(thirdEv.find((e) => e.type === 'message').data).t, 'busy');
assert.ok(await until(() => thirdEv.some((e) => e.type === 'closed')));
ok('a second guest is told the game is busy');

await guest.close();
assert.ok(await until(() => hostEv.some((e) => e.type === 'closed')), 'the host notices');
ok('a closed connection is noticed on the other end');

// the port taken: the next one
const other = createLan(() => {});
const r2 = await other.host({ port: PORT, beaconPort: BEACON, beacon: '{}' });
assert.equal(r2.port, PORT + 1);
ok('the port is taken (another game open): the next free one');

for (const l of [host, guest, third, other]) l.dispose();
console.log(`\n${pass} desktop LAN checks passed`);
process.exit(0);
