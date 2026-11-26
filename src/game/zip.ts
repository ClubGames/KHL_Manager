// A minimal .zip reader for the browser and the Android app (no third-party code): the central directory is parsed
// by hand, deflated entries are inflated with the platform's DecompressionStream('deflate-raw'). It mirrors
// desktop/modInstall.cjs (readZip / installModZip), which does the same on top of node:zlib for the Windows app.

export interface ZipEntry {
  name: string;
  dir: boolean;
  /** unpacked size, bytes */
  size: number;
  read(): Promise<Uint8Array>;
}

const MAX_ENTRIES = 50000;

let cp866: TextDecoder | null = null;
try { cp866 = new TextDecoder('ibm866'); } catch { /* no legacy encodings: names stay latin1 */ }
const utf8 = new TextDecoder('utf-8', { fatal: true });
const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('');

/** Entry names: UTF-8 when flagged (or with an Info-ZIP unicode path), otherwise the DOS code page Windows' own «Send to → zip» uses. */
function entryName(raw: Uint8Array, flags: number, extra: DataView, extraBytes: Uint8Array): string {
  for (let i = 0; i + 4 <= extra.byteLength;) {
    const id = extra.getUint16(i, true), size = extra.getUint16(i + 2, true);
    if (id === 0x7075 && size > 5) { try { return utf8.decode(extraBytes.subarray(i + 9, i + 4 + size)); } catch { /* broken: fall through */ } }
    i += 4 + size;
  }
  try { return utf8.decode(raw); } catch { /* not UTF-8 */ }
  if (flags & 0x800) return new TextDecoder().decode(raw);
  return cp866 ? cp866.decode(raw) : latin1(raw);
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('Браузер не умеет распаковывать .zip (нужен Chrome / Edge / Firefox / Safari свежих версий).');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads the central directory. Throws a Russian message on a broken file. */
export function readZip(input: ArrayBuffer | Uint8Array): ZipEntry[] {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true), u32 = (o: number) => dv.getUint32(o, true), u64 = (o: number) => Number(dv.getBigUint64(o, true));
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65557); i--) {
    if (u32(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Это не архив .zip (или файл повреждён).');
  let count = u16(eocd + 10);
  let cdOffset = u32(eocd + 16);
  // ZIP64 end of central directory (archives over 4 GB / 65535 files)
  if ((cdOffset === 0xffffffff || count === 0xffff) && eocd >= 20 && u32(eocd - 20) === 0x07064b50) {
    const z64 = u64(eocd - 12);
    if (u32(z64) === 0x06064b50) { count = u64(z64 + 32); cdOffset = u64(z64 + 48); }
  }
  if (count > MAX_ENTRIES) throw new Error('Слишком много файлов в архиве.');
  const out: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || u32(p) !== 0x02014b50) throw new Error('Архив повреждён (оглавление).');
    const flags = u16(p + 8), method = u16(p + 10);
    let csize = u32(p + 20), usize = u32(p + 24);
    const nlen = u16(p + 28), xlen = u16(p + 30), clen = u16(p + 32);
    let local = u32(p + 42);
    const extraBytes = buf.subarray(p + 46 + nlen, p + 46 + nlen + xlen);
    const extra = new DataView(extraBytes.buffer, extraBytes.byteOffset, extraBytes.byteLength);
    for (let i = 0; i + 4 <= extra.byteLength;) { // ZIP64 sizes / offset
      const id = extra.getUint16(i, true), size = extra.getUint16(i + 2, true);
      if (id === 0x0001) {
        let q = i + 4;
        if (usize === 0xffffffff) { usize = Number(extra.getBigUint64(q, true)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(extra.getBigUint64(q, true)); q += 8; }
        if (local === 0xffffffff) local = Number(extra.getBigUint64(q, true));
      }
      i += 4 + size;
    }
    const name = entryName(buf.subarray(p + 46, p + 46 + nlen), flags, extra, extraBytes).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    const lo = local, cs = csize;
    out.push({
      name, dir: name.endsWith('/'), size: usize,
      async read() {
        if (flags & 1) throw new Error(`Файл «${name}» в архиве защищён паролем — распакуйте архив без пароля.`);
        if (u32(lo) !== 0x04034b50) throw new Error('Архив повреждён (заголовок файла).');
        const start = lo + 30 + u16(lo + 26) + u16(lo + 28);
        const data = buf.subarray(start, start + cs);
        if (method === 0) return data.slice();
        if (method === 8) return inflateRaw(data);
        throw new Error(`Файл «${name}» сжат неподдерживаемым методом (${method}). Пересохраните архив как обычный .zip.`);
      },
    });
  }
  return out;
}

/** Split an entry path into safe segments; null for absolute paths / `..` (zip-slip) / junk such as __MACOSX. */
export function zipSegments(name: string): string[] | null {
  const parts = name.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.some((x) => x === '..' || /^[a-z]:$/i.test(x))) return null;
  if (parts[0] === '__MACOSX' || parts.some((x) => x === '.DS_Store' || x === 'Thumbs.db')) return null;
  return parts;
}

/** A folder name every platform accepts (the mod id). */
export function safeFolderName(name: string): string {
  const s = String(name).replace(/[<>:"/\\|?*\u0000-\u001f%#]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 80);
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s) || !s ? 'mod' : s;
}

export interface ModPack { id: string; files: { rel: string; entry: ZipEntry }[] }

/**
 * The mods inside an archive: every folder holding a roster.json (or a mod.json) is one mod; nested ones inside
 * another mod (backups) are not separate. A mod without a top folder is named after the archive.
 */
export function modsInZip(entries: ZipEntry[], archiveName: string): ModPack[] {
  const files: { e: ZipEntry; seg: string[] }[] = [];
  for (const e of entries) { if (e.dir) continue; const seg = zipSegments(e.name); if (seg) files.push({ e, seg }); }
  const isRoot = (f: { seg: string[] }) => /^(roster|mod)\.json$/i.test(f.seg[f.seg.length - 1]);
  let roots = [...new Set(files.filter(isRoot).map((f) => f.seg.slice(0, -1).join('/')))].sort((a, b) => a.length - b.length);
  roots = roots.filter((r, i) => !roots.slice(0, i).some((o) => o === '' || r.startsWith(o + '/')));
  if (!roots.length) throw new Error('В архиве нет roster.json — это не мод игры. Мод — папка с roster.json (и, по желанию, mod.json, schedule.json, logos/).');
  const base = String(archiveName || 'mod').split(/[\\/]/).pop()!.replace(/\.zip$/i, '');
  const taken = new Set<string>();
  return roots.map((root) => {
    const rootSeg = root ? root.split('/') : [];
    let id = safeFolderName(rootSeg.length ? rootSeg[rootSeg.length - 1] : base);
    while (taken.has(id.toLowerCase())) id += '_2';
    taken.add(id.toLowerCase());
    const mine = files.filter((f) => f.seg.length > rootSeg.length && rootSeg.every((s, i) => f.seg[i] === s));
    return { id, files: mine.map((f) => ({ rel: f.seg.slice(rootSeg.length).join('/'), entry: f.e })) };
  });
}
