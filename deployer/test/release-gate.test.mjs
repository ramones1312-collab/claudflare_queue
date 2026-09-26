/**
 * F-01 · The FULL RELEASE GATE must never PASS when a test file does not load, when the runner exits
 * non-zero, or when a file on disk did not run. Checked against the REAL pinned vitest/workerd output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { edgeVerdict, deployerVerdict } from '../lib/release.mjs';
import { EDGE_DIR } from '../lib/paths.mjs';

function realRun(files) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-'));
  for (const e of ['src', 'node_modules', 'package.json']) fs.symlinkSync(path.join(EDGE_DIR, e), path.join(ws, e));
  fs.copyFileSync(path.join(EDGE_DIR, 'vitest.config.js'), path.join(ws, 'vitest.config.js'));
  fs.mkdirSync(path.join(ws, 'test'));
  for (const f of ['_test-entry.js', '_testable-sequencer.js']) fs.copyFileSync(path.join(EDGE_DIR, 'test', f), path.join(ws, 'test', f));
  for (const [n, body] of Object.entries(files)) fs.writeFileSync(path.join(ws, 'test', n), body);
  try { const t = fs.readlinkSync(path.join(EDGE_DIR, 'node_modules', '.vite')); fs.mkdirSync(path.resolve(EDGE_DIR, 'node_modules', t), { recursive: true }); } catch { /* dev tree */ }
  const json = path.join(ws, 'r.json');
  const r = spawnSync(path.join(EDGE_DIR, 'node_modules', '.bin', 'vitest'), ['run', '--reporter=json', `--outputFile.json=${json}`], { cwd: ws, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  let res = null; try { res = JSON.parse(fs.readFileSync(json, 'utf8')); } catch { /* no result */ }
  fs.rmSync(ws, { recursive: true, force: true });
  return { res, code: r.status };
}

const good = fs.readFileSync(path.join(EDGE_DIR, 'test', 'hermetic_egress.test.js'), 'utf8');

test('real vitest: a test file that throws at import makes the gate FAIL (auditor F-01 reproduction)', () => {
  const { res, code } = realRun({ 'hermetic_egress.test.js': good, 'broken.test.js': "throw new Error('import failure');\n" });
  assert.ok(res, 'vitest wrote a JSON result');
  assert.equal(res.numFailedTests, 0, 'the counts alone look green — exactly the trap');
  const v = edgeVerdict(res, code, ['broken.test.js', 'hermetic_egress.test.js']);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some(r => /broken\.test\.js/.test(r)), v.reasons.join('; '));
});

test('real vitest: the same tree without the broken file passes, and a file that did not run is caught', () => {
  const { res, code } = realRun({ 'hermetic_egress.test.js': good });
  assert.equal(edgeVerdict(res, code, ['hermetic_egress.test.js']).ok, true, JSON.stringify(edgeVerdict(res, code, ['hermetic_egress.test.js'])));
  assert.equal(edgeVerdict(res, code, ['hermetic_egress.test.js', 'scenario_dlq.test.js']).ok, false);
  assert.equal(edgeVerdict(res, 1, ['hermetic_egress.test.js']).ok, false, 'a non-zero exit is never a PASS');
  assert.equal(edgeVerdict(null, 0, ['x.test.js']).ok, false);
});

test('deployer verdict: exit code, zero tests, and partial passes are all FAIL', () => {
  assert.equal(deployerVerdict({ tests: 5, pass: 5, fail: 0, cancelled: 0 }, 0).ok, true);
  assert.equal(deployerVerdict({ tests: 5, pass: 5, fail: 0, cancelled: 0 }, 1).ok, false);
  assert.equal(deployerVerdict({ tests: 0, pass: 0, fail: 0, cancelled: 0 }, 0).ok, false);
  assert.equal(deployerVerdict({ tests: 5, pass: 4, fail: 0, cancelled: 1 }, 0).ok, false);
});
