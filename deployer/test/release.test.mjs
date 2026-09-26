import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeZip, readZip, extractZip } from '../lib/zip.mjs';
import { buildManifest, verifyManifest, inputTreeHash, MANIFEST_NAME } from '../lib/manifest.mjs';
import { selectTargets } from '../lib/release.mjs';

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawa-tree-'));
  for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); }
  return dir;
}

test('zip: byte-identical output whatever the input order; round-trips with modes', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kawa-zip-'));
  const e = [{ name: 'r/b.txt', data: Buffer.from('b') }, { name: 'r/a.sh', data: Buffer.from('#!/bin/sh\n'), mode: 0o755 }];
  writeZip(path.join(d, '1.zip'), e); writeZip(path.join(d, '2.zip'), [...e].reverse());
  assert.deepEqual(fs.readFileSync(path.join(d, '1.zip')), fs.readFileSync(path.join(d, '2.zip')));
  const back = readZip(path.join(d, '1.zip'));
  assert.deepEqual(back.map(x => [x.name, String(x.data), x.mode]), [['r/a.sh', '#!/bin/sh\n', 0o755], ['r/b.txt', 'b', 0o644]]);
});

test('zip: extraction refuses paths that escape the destination', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kawa-zip-'));
  writeZip(path.join(d, 'evil.zip'), [{ name: '../escape.txt', data: Buffer.from('x') }]);
  assert.throws(() => extractZip(path.join(d, 'evil.zip'), path.join(d, 'out')), /unsafe path/);
});

test('manifest: detects a modified, a missing and an undeclared file; excludes secrets and user config', () => {
  const root = tree({ 'a.txt': 'a', 'edge/src/x.js': 'x', 'secrets/cloudflare_api_token': 'tok', 'secrets/README.md': 'r', 'config/kawa-edge.json': '{}' });
  const m = buildManifest(root, { artifact: 't' });
  assert.deepEqual(Object.keys(m.files).sort(), ['a.txt', 'edge/src/x.js', 'secrets/README.md']);
  fs.writeFileSync(path.join(root, MANIFEST_NAME), JSON.stringify(m));
  assert.equal(verifyManifest(root).ok, true);
  fs.writeFileSync(path.join(root, 'a.txt'), 'A');
  fs.rmSync(path.join(root, 'edge/src/x.js'));
  fs.writeFileSync(path.join(root, 'extra.txt'), 'e');
  const v = verifyManifest(root);
  assert.deepEqual([v.ok, v.mismatched, v.missing, v.extra], [false, ['a.txt'], ['edge/src/x.js'], ['extra.txt']]);
});

test('evidence binding: the input-tree hash changes with any test input and ignores documentation', () => {
  const root = tree({ 'edge/src/x.js': '1', 'deployer/lib/y.mjs': '2', 'README_NAS_INSTALL.md': 'doc', 'edge/test/t.test.js': 't' });
  const h0 = inputTreeHash(root);
  fs.writeFileSync(path.join(root, 'README_NAS_INSTALL.md'), 'doc changed');
  assert.equal(inputTreeHash(root), h0);
  for (const f of ['edge/src/x.js', 'deployer/lib/y.mjs', 'edge/test/t.test.js']) {
    const before = inputTreeHash(root);
    fs.writeFileSync(path.join(root, f), 'changed ' + f);
    assert.notEqual(inputTreeHash(root), before, f);
  }
});

test('targeted selection: core -> whole Edge suite; one test file -> that file; docs -> nothing', () => {
  assert.equal(selectTargets(['edge/src/sequencer.js']).allEdge, true);
  assert.equal(selectTargets(['edge/test/_harness.js']).allEdge, true);
  assert.equal(selectTargets(['edge/vitest.config.js']).allEdge, true);
  const one = selectTargets(['edge/test/scenario_dlq.test.js']);
  assert.deepEqual([one.allEdge, one.edgeFiles, one.deployer], [false, ['test/scenario_dlq.test.js'], false]);
  assert.equal(selectTargets(['deployer/lib/render.mjs']).deployer, true);
  assert.equal(selectTargets(['edge/staging-receiver/src/index.js']).deployer, true);
  const docs = selectTargets(['RUNBOOK_VIGENTE.md']);
  assert.deepEqual([docs.allEdge, docs.edgeFiles.length, docs.deployer], [false, 0, false]);
});
