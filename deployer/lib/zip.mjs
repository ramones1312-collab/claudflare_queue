/**
 * Deterministic ZIP writer/reader (no dependency). Same input tree -> byte-identical ZIP: sorted
 * entries, fixed timestamp, fixed permissions, DEFLATE level 9.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DOS_TIME = 0;                                   // 00:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (9 << 5) | 26; // 2026-09-26

export function writeZip(outFile, entries /* [{name, data: Buffer, mode}] */) {
  const chunks = [], central = [];
  let offset = 0;
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32(e.data) >>> 0;
    const comp = zlib.deflateRawSync(e.data, { level: 9 });
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE((3 << 8) | 20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10); c.writeUInt16LE(DOS_TIME, 12); c.writeUInt16LE(DOS_DATE, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32); c.writeUInt16LE(0, 34);
    c.writeUInt16LE(0, 36); c.writeUInt32LE((((e.mode || 0o644) | 0o100000) << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  fs.writeFileSync(outFile, Buffer.concat([...chunks, cd, end]));
}

export function readZip(file) {
  const buf = fs.readFileSync(file);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  const LIMIT = 256 * 1024 * 1024;                    // the package is < 1 MiB; refuse zip bombs
  let total = 0;
  let p = buf.readUInt32LE(eocd + 16);
  const cdStart = p;
  const out = [];
  const seen = new Set();
  const spans = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const attr = buf.readUInt32LE(p + 38), lo = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    // N-5 · duplicate names extract last-wins and differently across unzip tools: refuse them.
    if (seen.has(name)) throw new Error(`duplicate entry in zip: ${name}`);
    seen.add(name);
    if (buf.readUInt32LE(lo) !== 0x04034b50 || buf.toString('utf8', lo + 30, lo + 30 + buf.readUInt16LE(lo + 26)) !== name) throw new Error(`local header does not match the central directory: ${name}`);
    const lnlen = buf.readUInt16LE(lo + 26), lxlen = buf.readUInt16LE(lo + 28);
    const raw = buf.subarray(lo + 30 + lnlen + lxlen, lo + 30 + lnlen + lxlen + csize);
    const usize = buf.readUInt32LE(p + 24);
    total += usize;
    if (total > LIMIT) throw new Error('zip expands beyond the size limit');
    const data = method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: usize }) : Buffer.from(raw);
    if ((zlib.crc32(data) >>> 0) !== crc) throw new Error(`CRC mismatch in ${name}`);
    out.push({ name, data, mode: (attr >>> 16) & 0o777 });
    spans.push([lo, lo + 30 + lnlen + lxlen + csize]);
    p += 46 + nlen + xlen + clen;
  }
  // N-5 · the listed entries must tile the file from byte 0 to the central directory: no hidden local
  // entries (or other bytes) that a different tool could pick up.
  spans.sort((a, b) => a[0] - b[0]);
  let at = 0;
  for (const [s, e] of spans) { if (s !== at) throw new Error('zip has bytes not described by its central directory'); at = e; }
  if (at !== cdStart) throw new Error('zip has bytes not described by its central directory');
  return out;
}

export function extractZip(file, dest) {
  for (const e of readZip(file)) {
    if (e.name.endsWith('/')) continue;
    const target = path.resolve(dest, e.name);
    if (!target.startsWith(path.resolve(dest) + path.sep)) throw new Error(`unsafe path in zip: ${e.name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.data, { mode: e.mode || 0o644 });
  }
}
