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
const { writeZip } = await import('../lib/zip.mjs');

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
function makeZip(extra = [], { sha = true, manifestLine = true, signed = true, raw = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-pkg-'));
  const files = { 'Dockerfile': 'FROM x', 'docker-compose.yml': 'x', 'kawa-edge': '#!/bin/sh', 'README_NAS_INSTALL.md': 'x', 'RUNBOOK_VIGENTE.md': 'x',
                  'edge/package-lock.json': '{}', 'config/kawa-edge.example.json': '{}', 'edge/src/a.js': 'a' };
  for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); }
  const ev = { result: 'PASS', input_tree_sha256: inputTreeHash(root), edge_suite: ok, deployer_suite: ok };
  if (signed) writeSigned(path.join(root, EVIDENCE_NAME), ev); else fs.writeFileSync(path.join(root, EVIDENCE_NAME), JSON.stringify(ev));
  fs.writeFileSync(path.join(root, MANIFEST_NAME), JSON.stringify(buildManifest(root, { artifact: 't', revision: 'r' })));
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
