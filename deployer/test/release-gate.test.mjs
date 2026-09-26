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
import { edgeVerdict, deployerVerdict, expectedDeployerTests } from '../lib/release.mjs';
import { EDGE_DIR, DEPLOYER_DIR } from '../lib/paths.mjs';

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

/** R3-02 · run REAL node:test with the release gate's structured reporter over a throw-away test dir. */
function realNodeRun(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-'));
  try {
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(d, n), c);
    const ev = path.join(d, 'events.jsonl');
    const r = spawnSync(process.execPath, ['--test', `--test-reporter=${path.join(DEPLOYER_DIR, 'lib', 'test-reporter.mjs')}`,
      `--test-reporter-destination=${ev}`, ...Object.keys(files).map(n => path.join(d, n))],
      { encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')) });  // a nested run would ignore reporters
    const events = fs.existsSync(ev) ? fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    return { events, code: r.status };
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}
const T = "import { test } from 'node:test';\n";
const two = T + "test('a', () => {});\ntest('b', () => {});\n";

test('R3-02 · deployer gate anchored per file: the auditor variants D2/D3/D7 are FAIL with real node:test', () => {
  const ok = realNodeRun({ 'x.test.mjs': two });
  assert.equal(deployerVerdict(ok.events, ok.code, { 'x.test.mjs': 2 }).ok, true, JSON.stringify(deployerVerdict(ok.events, ok.code, { 'x.test.mjs': 2 })));
  for (const [name, body] of [
    ['D2 zero tests', '// no tests at all\n'],
    ['D3 process.exit(0) mid-file', T + "test('first', () => {});\ntest('second', async () => { process.exit(0); });\ntest('third', () => { throw new Error('never runs'); });\n"],
    ['D7 conditional test never registered', T + "if (process.env.NEVER_SET) { test('real', () => { throw new Error('x'); }); }\n"],
    ['skip', T + "test('a', () => {});\ntest('b', { skip: true }, () => {});\n"],
  ]) {
    const r = realNodeRun({ 'x.test.mjs': two, 'v.test.mjs': body });
    const n = { D2: 1, D3: 3, D7: 1, skip: 2 }[name.split(' ')[0]];
    const v = deployerVerdict(r.events, r.code, { 'x.test.mjs': 2, 'v.test.mjs': n });
    assert.equal(v.ok, false, `${name}: ${JSON.stringify(v)}`);
    assert.ok(v.reasons.every(x => x.startsWith('v.test.mjs')), `${name}: failed for the wrong file: ${v.reasons}`);
    assert.equal(deployerVerdict(r.events, r.code, { 'x.test.mjs': 2, 'v.test.mjs': 0 }).ok, false, `${name}: an anchor of 0 is never a PASS`);
  }
  // an expected file that did not run at all, and a file that ran but is not declared
  assert.equal(deployerVerdict(ok.events, ok.code, { 'x.test.mjs': 2, 'gone.test.mjs': 1 }).ok, false);
  const extra = realNodeRun({ 'x.test.mjs': two, 'y.test.mjs': two });
  assert.equal(deployerVerdict(extra.events, extra.code, { 'x.test.mjs': 2 }).ok, false);
  assert.equal(deployerVerdict(ok.events, 1, { 'x.test.mjs': 2 }).ok, false, 'a non-zero exit is never a PASS');
});

test('R3-02 · the anchor declares exactly the deployer test files on disk', () => {
  const { reasons } = expectedDeployerTests([]);
  assert.deepEqual(reasons, []);
});
