// Online over the local network, the Windows app's side (the page's side is src/net/lan.ts; the Android app's
// is LanNetPlugin.java — the three speak the same protocol, so a computer plays a phone).
// - host: a TCP server on port 47810 (the next free one up to 47815) for one guest at a time, and a UDP broadcast
//   «a game is here» once a second to every local network (port 47811);
// - join: a TCP connection to the host's address;
// - messages: one JSON object per line (UTF-8), passed to the page as they are;
// - scan: listens for the hosts' broadcasts.
// Events to the page: { type: 'peer' } a guest connected, { type: 'message', data } a line, { type: 'closed', reason },
// { type: 'found', host, data } a beacon.
const net = require('node:net');
const dgram = require('node:dgram');
const os = require('node:os');

/** IPv4 addresses of this computer on its networks (no loopback). */
function addresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
  return out;
}
/** Broadcast addresses: each network's own (a phone's hotspot, a VPN) and the general one. */
function broadcasts() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (!(a.family === 'IPv4' || a.family === 4) || a.internal || !a.netmask) continue;
    const ip = a.address.split('.').map(Number), m = a.netmask.split('.').map(Number);
    if (ip.length === 4 && m.length === 4) out.add(ip.map((b, i) => (b & m[i]) | (~m[i] & 255)).join('.'));
  }
  return [...out];
}

function createLan(emit) {
  let server = null, sock = null, beaconSock = null, beaconTimer = null, beaconText = '', beaconPort = 47811, scanSock = null;

  function attach(s) {
    sock = s;
    s.setNoDelay(true);
    s.setKeepAlive(true, 5000);
    s.setEncoding('utf8');
    let buf = '', why = '';
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line) emit({ type: 'message', data: line });
      }
      if (buf.length > 8e6) s.destroy(new Error('слишком длинное сообщение'));
    });
    s.on('error', (e) => { why = e && e.message || String(e); });
    s.on('close', () => { if (sock === s) { sock = null; emit({ type: 'closed', reason: why || 'соединение закрыто' }); } });
  }

  function stopBeacon() {
    if (beaconTimer) clearInterval(beaconTimer);
    beaconTimer = null;
    if (beaconSock) try { beaconSock.close(); } catch { /* closed */ }
    beaconSock = null;
  }
  function startBeacon() {
    stopBeacon();
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', () => {});
    s.bind(0, () => {
      try { s.setBroadcast(true); } catch { /* no broadcast here */ }
      const say = () => { const b = Buffer.from(beaconText); for (const addr of broadcasts()) s.send(b, beaconPort, addr, () => {}); };
      say();
      beaconTimer = setInterval(say, 1000);
    });
    beaconSock = s;
  }

  function listen(port) {
    return new Promise((resolve, reject) => {
      const srv = net.createServer((s) => {
        if (sock && !sock.destroyed) { s.end(JSON.stringify({ t: 'busy' }) + '\n'); return; }
        attach(s);
        emit({ type: 'peer' });
      });
      srv.once('error', reject);
      srv.listen(port, '0.0.0.0', () => { srv.removeListener('error', reject); srv.on('error', () => {}); resolve(srv); });
    });
  }

  return {
    addresses: async () => ({ addresses: addresses() }),
    async host({ port = 47810, beaconPort: bp = 47811, beacon = '' } = {}) {
      if (server) { try { server.close(); } catch { /* closed */ } server = null; }
      beaconText = String(beacon); beaconPort = bp;
      let last;
      for (let p = port; p < port + 6; p++) {
        try { server = await listen(p); last = null; break; } catch (e) { last = e; }
      }
      if (!server) throw last || new Error('порт занят');
      startBeacon();
      return { port: server.address().port, addresses: addresses() };
    },
    async beacon({ beacon = '' } = {}) { beaconText = String(beacon); },
    async stopHost() {
      stopBeacon();
      if (server) { try { server.close(); } catch { /* closed */ } server = null; }
    },
    join({ host, port = 47810 }) {
      return new Promise((resolve, reject) => {
        if (sock) { try { sock.destroy(); } catch { /* gone */ } sock = null; }
        const s = net.connect({ host: String(host), port: Number(port) });
        const fail = (e) => { s.destroy(); reject(e instanceof Error ? e : new Error(String(e))); };
        s.setTimeout(6000, () => fail(new Error('timed out')));
        s.once('error', fail);
        s.once('connect', () => { s.setTimeout(0); s.removeListener('error', fail); attach(s); resolve(); });
      });
    },
    send({ data }) { if (sock && !sock.destroyed) sock.write(String(data) + '\n'); },
    async close() {
      const s = sock;
      sock = null;
      if (s) { s.end(); setTimeout(() => s.destroy(), 300); }
    },
    async scan({ port = 47811 } = {}) {
      if (scanSock) return;
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      s.on('error', () => { try { s.close(); } catch { /* closed */ } if (scanSock === s) scanSock = null; });
      s.on('message', (msg, rinfo) => emit({ type: 'found', host: rinfo.address, data: msg.toString('utf8') }));
      s.bind(port);
      scanSock = s;
    },
    async stopScan() { if (scanSock) { try { scanSock.close(); } catch { /* closed */ } scanSock = null; } },
    /** everything off (the window closes) */
    dispose() { stopBeacon(); if (server) server.close(); if (sock) sock.destroy(); if (scanSock) scanSock.close(); server = sock = scanSock = null; },
  };
}

module.exports = { createLan, addresses, broadcasts };
