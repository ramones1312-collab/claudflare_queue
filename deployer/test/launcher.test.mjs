/**
 * F-02 · The launcher usually runs under sudo. It must never follow a symbolic link planted in state/,
 * secrets/ or config/ (auditor reproduction: root chowned and overwrote files outside the package).
 * Docker is stubbed; nothing is built or run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../lib/paths.mjs';

function sandbox() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-'));
  fs.mkdirSync(path.join(t, 'pkg')); fs.mkdirSync(path.join(t, 'bin')); fs.mkdirSync(path.join(t, 'victims'));
  fs.copyFileSync(path.join(ROOT, 'kawa-edge'), path.join(t, 'pkg', 'kawa-edge'));
  fs.writeFileSync(path.join(t, 'pkg', 'MANIFEST_SHA256_V1_3_1.json'), '{}');
  fs.writeFileSync(path.join(t, 'bin', 'docker'), '#!/bin/sh\necho "[stub docker] $*" >&2\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(t, 'victims', 'file'), 'ORIGINAL');
  return t;
}
/** As on the NAS: the package folder belongs to a normal user; when these tests run as root (sudo), use uid 1234. */
function ownAsNasUser(t) {
  if (process.getuid() !== 0) return;
  spawnSync('chown', ['-R', '-h', '1234:1234', path.join(t, 'pkg')]);
}
const run = (t, args) => { ownAsNasUser(t); return spawnSync('sh', [path.join(t, 'pkg', 'kawa-edge'), ...args], { cwd: path.join(t, 'pkg'), encoding: 'utf8', env: { ...process.env, PATH: `${path.join(t, 'bin')}:${process.env.PATH}`, HTTPS_PROXY: '' } }); };

for (const [where, plant] of [
  ['state/.image-manifest', (t) => { fs.mkdirSync(path.join(t, 'pkg', 'state')); fs.symlinkSync(path.join(t, 'victims', 'file'), path.join(t, 'pkg', 'state', '.image-manifest')); }],
  ['config/kawa-edge.json', (t) => { fs.mkdirSync(path.join(t, 'pkg', 'config')); fs.symlinkSync(path.join(t, 'victims', 'file'), path.join(t, 'pkg', 'config', 'kawa-edge.json')); }],
  ['secrets (the directory itself)', (t) => { fs.symlinkSync(path.join(t, 'victims'), path.join(t, 'pkg', 'secrets')); }],
]) {
  test(`a symlink at ${where} makes the launcher refuse; the target is untouched`, () => {
    const t = sandbox();
    try {
      plant(t);
      const before = fs.statSync(path.join(t, 'victims', 'file'));
      const r = run(t, ['help']);
      assert.notEqual(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stderr, /symbolic link/);
      assert.doesNotMatch(r.stderr, /stub docker/, 'docker must not be reached');
      assert.equal(fs.readFileSync(path.join(t, 'victims', 'file'), 'utf8'), 'ORIGINAL');
      const after = fs.statSync(path.join(t, 'victims', 'file'));
      assert.deepEqual([after.uid, after.gid, after.mode], [before.uid, before.gid, before.mode]);
    } finally { fs.rmSync(t, { recursive: true, force: true }); }
  });
}

test('clean folder: the launcher proceeds and writes its stamp as a regular file', () => {
  const t = sandbox();
  try {
    const r = run(t, ['help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /stub docker\] compose run --rm installer help/);
    assert.equal(fs.lstatSync(path.join(t, 'pkg', 'state', '.image-manifest')).isFile(), true);
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

test('a root-owned folder is refused: the container must never run as root', () => {
  const t = sandbox();
  try {
    if (process.getuid() !== 0) return;              // only meaningful when the test itself is root
    const r = spawnSync('sh', [path.join(t, 'pkg', 'kawa-edge'), 'help'], { cwd: path.join(t, 'pkg'), encoding: 'utf8', env: { ...process.env, PATH: `${path.join(t, 'bin')}:${process.env.PATH}` } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /belongs to root/);
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

test('verify-zip fails without a .sha256 or an explicit expected hash', () => {
  const t = sandbox();
  try {
    fs.writeFileSync(path.join(t, 'x.zip'), 'zip');
    const r = run(t, ['verify-zip', path.join(t, 'x.zip')]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no .*sha256/);
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

test('verify-zip reads the ZIP hash from the first line of the two-line .sha256 sidecar', () => {
  const t = sandbox();
  try {
    const zip = path.join(t, 'x.zip');
    fs.writeFileSync(zip, 'zip');
    const sha = crypto.createHash('sha256').update('zip').digest('hex');
    fs.writeFileSync(zip + '.sha256', `${sha}  x.zip\n${'b'.repeat(64)}  kawa-edge-nas/MANIFEST_SHA256_V1_3_1.json\n`);
    const ok = run(t, ['verify-zip', zip]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /PASS/);
    fs.writeFileSync(zip, 'tampered');
    const bad = run(t, ['verify-zip', zip]);
    assert.notEqual(bad.status, 0);
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});
