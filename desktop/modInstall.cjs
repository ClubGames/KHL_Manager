// Installing a mod from a .zip archive into the player's mods folder (no third-party code: a minimal zip reader
// on top of node:zlib). Used by main.cjs (the «Установить мод» button / drag-and-drop) and by scripts/mod-install-test.
//
// Accepted layouts (anything with a roster.json inside):
//   МойМод.zip → МойМод/roster.json, МойМод/logos/…      → mods/МойМод/
//   МойМод.zip → roster.json, logos/… (no top folder)     → mods/МойМод/  (named after the archive)
//   Pack.zip   → Pack/ЛигаА/roster.json, Pack/ЛигаБ/…     → mods/ЛигаА/, mods/ЛигаБ/
const path = require('node:path');
const fs = require('node:fs/promises');
const zlib = require('node:zlib');

const MAX_TOTAL = 1024 * 1024 * 1024; // 1 GB unpacked: a league with photos is a few dozen MB
const MAX_ENTRIES = 50000;

let cp866 = null;
try { cp866 = new TextDecoder('ibm866'); } catch { /* small-icu build: names stay latin1 */ }

/** Entry names: UTF-8 when flagged (or with an Info-ZIP unicode path), otherwise the DOS code page Windows' own «Send to → zip» uses. */
function entryName(raw, flags, extra) {
  for (let i = 0; i + 4 <= extra.length;) {
    const id = extra.readUInt16LE(i), size = extra.readUInt16LE(i + 2);
    if (id === 0x7075 && size > 5) return extra.subarray(i + 9, i + 4 + size).toString('utf8');
    i += 4 + size;
  }
  if (flags & 0x800) return raw.toString('utf8');
  // Not flagged, but valid UTF-8 with non-ASCII bytes: many tools (7-Zip with -mcu, macOS) write UTF-8 without the flag.
  const utf = raw.toString('utf8');
  if (!utf.includes('\ufffd')) return utf;
  return cp866 ? cp866.decode(raw) : raw.toString('latin1');
}

/** Reads the central directory: [{ name, dir, size, read(): Buffer }]. Throws a Russian message on a broken file. */
function readZip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Это не архив .zip (или файл повреждён).');
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  // ZIP64 end of central directory (archives over 4 GB / 65535 files)
  if ((cdOffset === 0xffffffff || count === 0xffff) && eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) {
    const z64 = Number(buf.readBigUInt64LE(eocd - 12));
    if (buf.readUInt32LE(z64) === 0x06064b50) { count = Number(buf.readBigUInt64LE(z64 + 32)); cdOffset = Number(buf.readBigUInt64LE(z64 + 48)); }
  }
  if (count > MAX_ENTRIES) throw new Error('Слишком много файлов в архиве.');
  const out = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Архив повреждён (оглавление).');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    let csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    let local = buf.readUInt32LE(p + 42);
    const extra = buf.subarray(p + 46 + nlen, p + 46 + nlen + xlen);
    for (let i = 0; i + 4 <= extra.length;) { // ZIP64 sizes / offset
      const id = extra.readUInt16LE(i), size = extra.readUInt16LE(i + 2);
      if (id === 0x0001) {
        let q = i + 4;
        if (usize === 0xffffffff) { usize = Number(extra.readBigUInt64LE(q)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(extra.readBigUInt64LE(q)); q += 8; }
        if (local === 0xffffffff) { local = Number(extra.readBigUInt64LE(q)); }
      }
      i += 4 + size;
    }
    const name = entryName(buf.subarray(p + 46, p + 46 + nlen), flags, extra).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    const dir = name.endsWith('/');
    out.push({
      name, dir, size: usize,
      read() {
        if (flags & 1) throw new Error(`Файл «${name}» в архиве защищён паролем — распакуйте архив без пароля.`);
        if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('Архив повреждён (заголовок файла).');
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(start, start + csize);
        if (method === 0) return Buffer.from(data);
        if (method === 8) return zlib.inflateRawSync(data);
        throw new Error(`Файл «${name}» сжат неподдерживаемым методом (${method}). Пересохраните архив как обычный .zip.`);
      },
    });
  }
  return out;
}

/** A folder name Windows accepts. */
function safeFolderName(name) {
  const s = String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 80);
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s) || !s ? 'mod' : s;
}

/** Split an entry path into safe segments; null for absolute paths / `..` (zip-slip) / junk such as __MACOSX. */
function segments(name) {
  const parts = name.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.some((x) => x === '..' || /^[a-z]:$/i.test(x))) return null;
  if (parts[0] === '__MACOSX' || parts.some((x) => x === '.DS_Store' || x === 'Thumbs.db')) return null;
  return parts;
}

/**
 * Unpack `buf` (a .zip) into `modsDir`. Every folder that holds a roster.json (or a mod.json) becomes one mod;
 * a mod already installed under the same name is replaced. Returns { installed: [{ id, name, replaced }] }.
 */
async function installModZip(buf, archiveName, modsDir) {
  const entries = readZip(buf).filter((e) => !e.dir);
  const files = [];
  for (const e of entries) { const seg = segments(e.name); if (seg) files.push({ e, seg }); }
  const isRoot = (f) => /^(roster|mod)\.json$/i.test(f.seg[f.seg.length - 1]);
  // Mod roots: the folder of each roster.json / mod.json; nested ones inside another mod (e.g. backups) are not separate mods.
  let roots = [...new Set(files.filter(isRoot).map((f) => f.seg.slice(0, -1).join('/')))].sort((a, b) => a.length - b.length);
  roots = roots.filter((r, i) => !roots.slice(0, i).some((o) => o === '' || r.startsWith(o + '/')));
  if (!roots.length) throw new Error('В архиве нет roster.json — это не мод игры. Мод — папка с roster.json (и, по желанию, mod.json, schedule.json, logos/).');
  const total = files.reduce((s, f) => s + (f.e.size || 0), 0);
  if (total > MAX_TOTAL) throw new Error('Архив слишком большой (больше 1 ГБ в распакованном виде).');

  await fs.mkdir(modsDir, { recursive: true });
  const base = String(archiveName || 'mod').split(/[\\/]/).pop().replace(/\.zip$/i, '');
  const installed = [];
  const taken = new Set();
  for (const root of roots) {
    const rootSeg = root ? root.split('/') : [];
    let id = safeFolderName(rootSeg.length ? rootSeg[rootSeg.length - 1] : base);
    while (taken.has(id.toLowerCase())) id += '_2';
    taken.add(id.toLowerCase());
    const target = path.join(modsDir, id);
    const tmp = path.join(modsDir, `.installing-${id}-${process.pid}`);
    await fs.rm(tmp, { recursive: true, force: true });
    try {
      for (const f of files) {
        if (rootSeg.some((s, i) => f.seg[i] !== s) || f.seg.length <= rootSeg.length) continue;
        const rel = f.seg.slice(rootSeg.length).map((x) => x.replace(/[<>:"|?*\u0000-\u001f]/g, '_'));
        const dest = path.join(tmp, ...rel);
        if (!path.resolve(dest).startsWith(path.resolve(tmp) + path.sep)) continue;
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, f.e.read());
      }
      let name = id;
      try {
        const meta = JSON.parse((await fs.readFile(path.join(tmp, 'mod.json'), 'utf8')).replace(/^\ufeff/, ''));
        if (meta && typeof meta.name === 'string' && meta.name.trim()) name = meta.name.trim();
      } catch { /* no / broken mod.json: the folder name */ }
      const replaced = await fs.access(target).then(() => true, () => false);
      if (replaced) await fs.rm(target, { recursive: true, force: true });
      await fs.rename(tmp, target);
      installed.push({ id, name, replaced });
    } catch (e) {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  }
  return { installed };
}

/** Copy folders from an old mods directory into the new one (never overwriting); returns the copied names. */
async function migrateMods(fromDir, toDir) {
  const copied = [];
  let dirs = [];
  try { dirs = (await fs.readdir(fromDir, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.')); } catch { return copied; }
  for (const d of dirs) {
    const dest = path.join(toDir, d.name);
    if (await fs.access(dest).then(() => true, () => false)) continue;
    await fs.cp(path.join(fromDir, d.name), dest, { recursive: true, errorOnExist: false, force: false });
    copied.push(d.name);
  }
  return copied;
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Minimal zip writer (deflate, UTF-8 names) — for the self-test and the packaged-app smoke test. */
function writeZip(files, { utf8Flag = true } = {}) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    const comp = zlib.deflateRawSync(data), nameBuf = Buffer.from(name, 'utf8'), crc = crc32(data);
    const flags = utf8Flag ? 0x800 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp); central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22), n = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

module.exports = { readZip, writeZip, installModZip, migrateMods, safeFolderName };
