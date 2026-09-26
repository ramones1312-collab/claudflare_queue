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
function makeZip(extra = [], { sha = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-pkg-'));
  const files = { 'Dockerfile': 'FROM x', 'docker-compose.yml': 'x', 'kawa-edge': '#!/bin/sh', 'README_NAS_INSTALL.md': 'x', 'RUNBOOK_VIGENTE.md': 'x',
                  'edge/package-lock.json': '{}', 'config/kawa-edge.example.json': '{}', 'edge/src/a.js': 'a' };
  for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); }
  fs.writeFileSync(path.join(root, EVIDENCE_NAME), JSON.stringify({ result: 'PASS', input_tree_sha256: inputTreeHash(root), edge_suite: ok, deployer_suite: ok }));
  fs.writeFileSync(path.join(root, MANIFEST_NAME), JSON.stringify(buildManifest(root, { artifact: 't', revision: 'r' })));
  const entries = listPackageFiles(root).map(p => ({ name: `kawa-edge-nas/${p}`, data: fs.readFileSync(path.join(root, p)) }));
  for (const e of extra) entries.push({ name: e, data: Buffer.from('SECRET') });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-zip-'));
  const zip = path.join(out, ZIP_NAME);
  writeZip(zip, entries);
  if (sha) fs.writeFileSync(`${zip}.sha256`, crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex') + `  ${ZIP_NAME}\n`);
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
