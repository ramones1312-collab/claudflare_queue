/**
 * F-04 (test evidence must be signed by this installation), F-06 (verify-release inspects the RAW ZIP
 * entries and requires the expected SHA-256), F-12 (manifest scope; symlinks refused).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-state-'));
process.env.KAWA_STATE = STATE;                           // before any lib import (paths are module-level)
const { findEvidence, verifyRelease, ZIP_NAME, EVIDENCE_NAME } = await import('../lib/release.mjs');
const { writeSigned } = await import('../lib/evidence.mjs');
const { buildManifest, inputTreeHash, listPackageFiles, MANIFEST_NAME } = await import('../lib/manifest.mjs');
const { writeZip, readZip } = await import('../lib/zip.mjs');
const { spawnSync } = await import('node:child_process');
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);

const ok = { ok: true, code: 0, pass: 1, total: 1, tests: 1 };

test('F-04 · test evidence with the right hash but not signed here is refused', () => {
  const hash = 'a'.repeat(64);
  const dir = path.join(STATE, 'evidence'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `test-full-${hash.slice(0, 16)}-PASS.json`);
  fs.writeFileSync(file, JSON.stringify({ result: 'PASS', input_tree_sha256: hash, edge_suite: ok, deployer_suite: ok }));
  assert.throws(() => findEvidence(hash), { code: 'EVIDENCE_UNSIGNED' });
  writeSigned(file, { result: 'PASS', input_tree_sha256: hash, edge_suite: ok, deployer_suite: ok });
  assert.ok(findEvidence(hash));
  const signed = JSON.parse(fs.readFileSync(file, 'utf8'));
  signed.edge_suite.pass = 999; fs.writeFileSync(file, JSON.stringify(signed));
  assert.throws(() => findEvidence(hash), { code: 'EVIDENCE_UNSIGNED' }, 'an edited signed file is refused');
});

/** A minimal but complete package, zipped exactly like `package` does, with optional extra raw entries. */
function makeZip(extra = [], { sha = true, manifestLine = true, signed = true, raw = null, declare = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-pkg-'));
  const files = { 'Dockerfile': 'FROM x', 'docker-compose.yml': 'x', 'kawa-edge': '#!/bin/sh', 'README_NAS_INSTALL.md': 'x', 'RUNBOOK_VIGENTE.md': 'x',
                  'edge/package-lock.json': '{}', 'config/kawa-edge.example.json': '{}', 'edge/src/a.js': 'a' };
  for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); }
  const ev = { result: 'PASS', input_tree_sha256: inputTreeHash(root), edge_suite: ok, deployer_suite: ok };
  if (signed) writeSigned(path.join(root, EVIDENCE_NAME), ev); else fs.writeFileSync(path.join(root, EVIDENCE_NAME), JSON.stringify(ev));
  const man = buildManifest(root, { artifact: 't', revision: 'r' });
  // declare: the attacker also re-seals the manifest with the extra entries (auditor R3-01 cases)
  if (declare) { for (const e of extra) man.files[e.replace(/^kawa-edge-nas\//, '')] = crypto.createHash('sha256').update('SECRET').digest('hex'); man.file_count = Object.keys(man.files).length; }
  fs.writeFileSync(path.join(root, MANIFEST_NAME), JSON.stringify(man));
  const entries = listPackageFiles(root).map(p => ({ name: `kawa-edge-nas/${p}`, data: fs.readFileSync(path.join(root, p)) }));
  for (const e of extra) entries.push({ name: e, data: Buffer.from('SECRET') });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-zip-'));
  const zip = path.join(out, ZIP_NAME);
  writeZip(zip, entries);
  if (raw) fs.writeFileSync(zip, raw(fs.readFileSync(zip)));
  const h = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const mline = manifestLine ? `${h(fs.readFileSync(path.join(root, MANIFEST_NAME)))}  kawa-edge-nas/${MANIFEST_NAME}\n` : '';
  if (sha) fs.writeFileSync(`${zip}.sha256`, `${h(fs.readFileSync(zip))}  ${ZIP_NAME}\n${mline}`);
  return zip;
}
const verify = (zip, extra = {}) => verifyRelease({}, { _: [zip], ...extra });

test('F-06 · a clean package verifies', async () => {
  assert.equal((await verify(makeZip())).result, 'PASS');
});

for (const [name, entry, code] of [
  ['a secret token file', 'kawa-edge-nas/secrets/cloudflare_api_token', 'FORBIDDEN_FILES'],
  ['the operator config', 'kawa-edge-nas/config/kawa-edge.json', 'FORBIDDEN_FILES'],
  ['state/', 'kawa-edge-nas/state/staging/secrets.json', 'FORBIDDEN_FILES'],
  ['an entry outside the package root', 'elsewhere/evil.sh', 'ZIP_ENTRY_OUTSIDE_ROOT'],
  ['an undeclared harmless-looking file', 'kawa-edge-nas/docs/extra.md', /MANIFEST_MISMATCH|ZIP_ENTRIES_NOT_MANIFEST/],
]) {
  test(`F-06 · a ZIP carrying ${name} is refused`, async () => {
    await assert.rejects(verify(makeZip([entry])), (err) => (code instanceof RegExp ? code.test(err.code) : err.code === code));
  });
}

test('F-06 · without a .sha256 (or --sha256) integrity cannot be checked: refused', async () => {
  await assert.rejects(verify(makeZip([], { sha: false })), { code: 'ZIP_SHA_UNKNOWN' });
});

test('F-12 · nested state/ build/ dist/ dirs are package content (hashed); symlinks are refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-m-'));
  fs.mkdirSync(path.join(root, 'edge/src/state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'edge/test/build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'edge/src/state/helper.js'), '1');
  fs.writeFileSync(path.join(root, 'edge/test/build/extra.test.js'), '1');
  const h0 = inputTreeHash(root);
  fs.writeFileSync(path.join(root, 'edge/src/state/helper.js'), '2');
  assert.notEqual(inputTreeHash(root), h0);
  assert.ok(listPackageFiles(root).includes('edge/test/build/extra.test.js'));
  fs.symlinkSync('/etc/hostname', path.join(root, 'edge/src/link.js'));
  assert.throws(() => listPackageFiles(root), /symbolic link/);
});

test('N-5 · a one-line sidecar (no published manifest hash) is refused', async () => {
  await assert.rejects(verify(makeZip([], { manifestLine: false })), { code: 'MANIFEST_SHA_UNKNOWN' });
});

test('N-2 · where the evidence key exists, unsigned packaged evidence is refused', async () => {
  await assert.rejects(verify(makeZip([], { signed: false })), { code: 'EVIDENCE_UNSIGNED' });
});

test('N-5 · duplicate entry names and bytes hidden outside the central directory are refused', async () => {
  const dup = makeZip(['kawa-edge-nas/Dockerfile']);
  await assert.rejects(verify(dup), /duplicate entry/);
  // A stray local entry prepended: the listed entries no longer tile the file from byte 0.
  const hidden = makeZip([], { raw: (b) => {
    const stray = Buffer.alloc(30 + 4); stray.writeUInt32LE(0x04034b50, 0); stray.writeUInt16LE(4, 26); stray.write('evil', 30);
    const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const cd = b.readUInt32LE(eocd + 16);
    // shift every offset by the stray length so the archive stays otherwise valid
    const out = Buffer.concat([stray, b]);
    const e2 = eocd + stray.length;
    out.writeUInt32LE(cd + stray.length, e2 + 16);
    for (let p = cd + stray.length, i = 0; i < out.readUInt16LE(e2 + 10); i++) {
      out.writeUInt32LE(out.readUInt32LE(p + 42) + stray.length, p + 42);
      p += 46 + out.readUInt16LE(p + 28) + out.readUInt16LE(p + 30) + out.readUInt16LE(p + 32);
    }
    return out;
  } });
  await assert.rejects(verify(hidden), /not described by its central directory/);
});

test('N-6 · a malformed evidence key fails closed', async () => {
  const { hasEvidenceKey } = await import('../lib/evidence.mjs');
  assert.ok(hasEvidenceKey());
  const kf = path.join(STATE, '.evidence-key');
  const good = fs.readFileSync(kf, 'utf8');
  try {
    fs.writeFileSync(kf, '');
    assert.throws(() => writeSigned(path.join(STATE, 'x.json'), { a: 1 }), { code: 'EVIDENCE_KEY_INVALID' });
  } finally { fs.writeFileSync(kf, good); }
});

test('R3-01 · equivalent spellings of secrets/, config/, state/ paths are refused even when the manifest declares them', async () => {
  for (const name of ['kawa-edge-nas/./secrets/cloudflare_api_token', 'kawa-edge-nas//secrets/cloudflare_api_token',
                      'kawa-edge-nas/secrets/./cloudflare_api_token', 'kawa-edge-nas/./config/kawa-edge.json',
                      'kawa-edge-nas/secrets\\cloudflare_api_token', 'kawa-edge-nas/./state/.evidence-key',
                      'kawa-edge-nas/edge/./node_modules/x.js', 'kawa-edge-nas/edge/src/../../secrets/x', 'kawa-edge-nas/secrets/']) {
    await assert.rejects(verify(makeZip([name], { declare: true })), { code: 'ZIP_ENTRY_NOT_CANONICAL' }, name);
  }
});

test('R3-04 · a malformed signature value (non-hex, multi-byte) is "not signed", never an exception', async () => {
  const { verify: v } = await import('../lib/evidence.mjs');
  writeSigned(path.join(STATE, 'r304.json'), { a: 1 });              // a key must exist, or verify() stops earlier
  for (const value of ['é'.repeat(64), 'z'.repeat(64), 'a'.repeat(63), 42, null]) assert.equal(v({ a: 1, signature: { alg: 'HMAC-SHA256', value } }), false, String(value));
});

/** Rewrites one field of a written ZIP (little-endian) at the n-th central/local record. */
function mutate(zip, fn) { const b = fs.readFileSync(zip); fn(b); fs.writeFileSync(zip, b); fs.writeFileSync(`${zip}.sha256`, fs.readFileSync(`${zip}.sha256`, 'utf8').replace(/^[0-9a-f]{64}/, crypto.createHash('sha256').update(b).digest('hex'))); return zip; }
const cdStart = (b) => b.readUInt32LE(b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) + 16);

test('R3-11 · symlink entries, local/central mismatches and bytes after the directory are refused', async () => {
  // a symlink entry (unix type 0o120000 in the external attributes)
  await assert.rejects(verify(mutate(makeZip(), (b) => { const p = cdStart(b); b.writeUInt32LE(((0o120777) << 16) >>> 0, p + 38); })), /not a regular file/);
  // local header CRC differs from the central directory
  await assert.rejects(verify(mutate(makeZip(), (b) => { b.writeUInt32LE((b.readUInt32LE(14) ^ 1) >>> 0, 14); })), /local header differs/);
  // bytes appended after the end record, and a comment
  const z = makeZip();
  fs.appendFileSync(z, 'TAIL');
  fs.writeFileSync(`${z}.sha256`, fs.readFileSync(`${z}.sha256`, 'utf8').replace(/^[0-9a-f]{64}/, crypto.createHash('sha256').update(fs.readFileSync(z)).digest('hex')));
  await assert.rejects(verify(z), /bytes after its end record/);
});

test('R3-12 · tool-named directories outside their fixed places are package content; non-regular files are refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-r12-'));
  fs.mkdirSync(path.join(root, 'edge/test/.wrangler'), { recursive: true });
  fs.mkdirSync(path.join(root, 'edge/node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'edge/test/.wrangler/x.test.js'), '1');
  fs.writeFileSync(path.join(root, 'edge/node_modules/ignored.js'), '1');
  fs.writeFileSync(path.join(root, 'edge/test/run.log'), '1');
  const h0 = inputTreeHash(root);
  fs.writeFileSync(path.join(root, 'edge/test/.wrangler/x.test.js'), '2');
  assert.notEqual(inputTreeHash(root), h0, 'edge/test/.wrangler/x.test.js must be hashed');
  const files = listPackageFiles(root);
  assert.ok(files.includes('edge/test/run.log') && !files.includes('edge/node_modules/ignored.js'));
  spawnSync('mkfifo', [path.join(root, 'edge/test/pipe')]);
  if (fs.existsSync(path.join(root, 'edge/test/pipe'))) assert.throws(() => listPackageFiles(root), /not a regular file/);
});

test('R3-14 · evidence signed by ANOTHER installation (the developer\'s, seen on the NAS) warns, never refuses the genuine ZIP', async () => {
  const zip = makeZip();
  // re-sign the packaged evidence with a foreign key id, as a genuine ZIP looks on the NAS
  const b = readZip(zip);
  const e = b.find(x => x.name.endsWith(EVIDENCE_NAME));
  const ev = JSON.parse(e.data.toString());
  ev.signature = { alg: 'HMAC-SHA256', key_id: 'fffffffffff0', value: 'f'.repeat(64) };
  e.data = Buffer.from(JSON.stringify(ev));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-r14-'));
  for (const x of b) { fs.mkdirSync(path.dirname(path.join(root, x.name)), { recursive: true }); fs.writeFileSync(path.join(root, x.name), x.data); }
  const pkg = path.join(root, 'kawa-edge-nas');
  fs.writeFileSync(path.join(pkg, MANIFEST_NAME), JSON.stringify(buildManifest(pkg, { artifact: 't', revision: 'r' })));
  writeZip(zip, listPackageFiles(pkg).map(p => ({ name: `kawa-edge-nas/${p}`, data: fs.readFileSync(path.join(pkg, p)) })));
  const h = (x) => crypto.createHash('sha256').update(x).digest('hex');
  fs.writeFileSync(`${zip}.sha256`, `${h(fs.readFileSync(zip))}  ${ZIP_NAME}\n${h(fs.readFileSync(path.join(pkg, MANIFEST_NAME)))}  kawa-edge-nas/${MANIFEST_NAME}\n`);
  assert.equal((await verify(zip)).result, 'PASS');
});

/**
 * NEW-01 · Rebuilds a genuine package ZIP (stored entries) and adds an Info-ZIP Unicode Path extra field
 * (0x7075: version 1, CRC-32 of the declared name, UTF-8 name) to ONE entry, in its local AND central
 * header. unzip then uses that name instead of the declared one.
 */
function withUnicodePath(zip, declared, effective) {
  const zlib = require('node:zlib');
  const entries = readZip(zip);
  const locals = [], centrals = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), crc = zlib.crc32(e.data) >>> 0;
    let extra = Buffer.alloc(0);
    if (e.name === declared) {
      const u = Buffer.from(effective);
      extra = Buffer.alloc(4 + 5 + u.length);
      extra.writeUInt16LE(0x7075, 0); extra.writeUInt16LE(5 + u.length, 2); extra.writeUInt8(1, 4);
      extra.writeUInt32LE(zlib.crc32(name) >>> 0, 5); u.copy(extra, 9);
    }
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0, 6);
    l.writeUInt32LE(crc, 14); l.writeUInt32LE(e.data.length, 18); l.writeUInt32LE(e.data.length, 22);
    l.writeUInt16LE(name.length, 26); l.writeUInt16LE(extra.length, 28);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(0x031e, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 8);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(e.data.length, 20); c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt16LE(extra.length, 30); c.writeUInt32LE((((e.mode || 0o644) | 0o100000) << 16) >>> 0, 38); c.writeUInt32LE(off, 42);
    locals.push(l, name, extra, e.data); centrals.push(c, name, extra);
    off += 30 + name.length + extra.length + e.data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  fs.writeFileSync(zip, Buffer.concat([...locals, cd, end]));
  fs.writeFileSync(`${zip}.sha256`, fs.readFileSync(`${zip}.sha256`, 'utf8').replace(/^[0-9a-f]{64}/, crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex')));
  return zip;
}

for (const [label, target] of [['#34 secrets/cloudflare_api_token', 'kawa-edge-nas/secrets/cloudflare_api_token'],
                               ['#35 config/kawa-edge.json', 'kawa-edge-nas/config/kawa-edge.json']]) {
  test(`NEW-01 ${label}: a Unicode Path extra field (0x7075) redirecting a declared entry is refused, nothing written`, async () => {
    const zip = withUnicodePath(makeZip(['kawa-edge-nas/docs/audit.txt'], { declare: true }), 'kawa-edge-nas/docs/audit.txt', target);
    const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('kawa-verify-')).length;
    await assert.rejects(verify(zip), (e) => /extra field 0x7075/.test(e.message));
    assert.equal(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('kawa-verify-')).length, before, 'verify-release extracted something');
  });
}

test('NEW-01 · the same canonical ZIP rebuilt WITHOUT that field still passes', async () => {
  const zip = withUnicodePath(makeZip(['kawa-edge-nas/docs/audit.txt'], { declare: true }), '(none)', '');
  assert.equal((await verify(zip)).result, 'PASS');
});
