/**
 * Build / test / package pipeline, in layers (see RELEASE_REPORT for measured timings):
 *
 *   A  verify-fast     manifest, toolchain, config, isolation, offline bundle check, unit tests
 *   B  test-targeted   only the suites affected by the changed files
 *   C  test-full       every suite; evidence bound to the TEST INPUT TREE hash
 *   -  package         deterministic ZIP; REUSES the C evidence for the same bytes, never re-runs it
 *   D  verify-release  short gate on the packaged ZIP (then the physical gate runs once on it)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, EDGE_DIR, STATE_DIR, DEPLOYER_DIR } from './paths.mjs';
import { out, KawaError } from './log.mjs';
import { loadConfig, validateConfig } from './config.mjs';
import { localChecks } from './preflight.mjs';
import { createWrangler, pinnedVersion } from './wrangler.mjs';
import { buildManifest, verifyManifest, inputTreeHash, listPackageFiles, sha256File, MANIFEST_NAME, testInputFiles } from './manifest.mjs';
import { writeZip, extractZip, readZip } from './zip.mjs';
import { writeSigned, verify as verifySignature, readEvidence } from './evidence.mjs';

export const IDENTITY = {
  artifact: 'edge-signal-buffer-v1.3.1-nas',
  revision: 'R1 · turnkey NAS deployer + hermetic test harness (2026-09-26)',
  lineage: 'V1.3.1 <- V1.3.0 R4 CANDIDATE (zip sha256 1bcd1e3df8fba89781916efcaf173a45983f0566bb189d59e20929766db82867)',
  runtime_code: 'Edge Worker sources byte-identical to V1.3.0 R4',
};
export const ZIP_NAME = 'KAWA_EDGE_SIGNAL_BUFFER_V1_3_1_NAS_R1_2026-09-26.zip';
export const EVIDENCE_NAME = 'TEST_EVIDENCE_V1_3_1.json';
const ZIP_ROOT = 'kawa-edge-nas';

function run(cmd, args, { cwd = ROOT, env = {}, tee = true } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env, FORCE_COLOR: '0', NO_COLOR: '1' } });
    let text = '';
    const on = (b) => { text += b; if (tee) process.stdout.write(b); };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('close', (code) => resolve({ code, text, ms: Date.now() - t0 }));
  });
}

const deployerTests = (filter = null) => fs.readdirSync(path.join(DEPLOYER_DIR, 'test'))
  .filter(f => f.endsWith('.test.mjs') && (!filter || filter(f))).map(f => path.join('deployer', 'test', f)).sort();

/**
 * F-01 · A suite PASSES only if the runner itself says so AND nothing is missing: exit code 0, no
 * failed/pending suite, and every test file on disk ran with at least one test, all passed. A file
 * that fails to import contributes 0 failed tests, so counts alone can never decide.
 */
export function edgeVerdict(res, code, expectedFiles) {
  const reasons = [];
  if (code !== 0) reasons.push(`vitest exit code ${code}`);
  if (!res) return { ok: false, reasons: [...reasons, 'no JSON result'] };
  if (res.success !== true) reasons.push('runner reports success=false');
  if (res.numFailedTestSuites) reasons.push(`${res.numFailedTestSuites} failed suite(s)`);
  if (res.numFailedTests || res.numPendingTests || res.numTodoTests) reasons.push('failed/pending/todo tests');
  const ran = new Map(res.testResults.map(t => [path.basename(t.name), t]));
  for (const f of expectedFiles) {
    const t = ran.get(f);
    if (!t) { reasons.push(`${f} did not run`); continue; }
    if (t.status !== 'passed') reasons.push(`${f}: ${t.status}${t.message ? ' — ' + String(t.message).slice(0, 200) : ''}`);
    if (!t.assertionResults.length) reasons.push(`${f}: 0 tests`);
    if (t.assertionResults.some(a => a.status !== 'passed')) reasons.push(`${f}: a test did not pass`);
  }
  return { ok: reasons.length === 0, reasons };
}

export function deployerVerdict(summary, code) {
  const reasons = [];
  if (code !== 0) reasons.push(`node --test exit code ${code}`);
  if (!summary.tests) reasons.push('0 tests ran');
  if (summary.fail || summary.cancelled) reasons.push(`${summary.fail} failed, ${summary.cancelled} cancelled`);
  if (summary.pass !== summary.tests) reasons.push(`passed ${summary.pass} of ${summary.tests}`);
  return { ok: reasons.length === 0, reasons };
}

async function runDeployerSuite(files) {
  if (!files.length) return { ok: true, pass: 0, fail: 0, tests: 0, ms: 0, files: 0, reasons: [] };
  const r = await run(process.execPath, ['--test', '--test-reporter=spec', ...files], { tee: true });
  // node:test's own summary, not a count of ✔ lines (which also match nested/suite lines).
  const num = (k) => { const m = new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(r.text); return m ? Number(m[1]) : 0; };
  const summary = { tests: num('tests'), pass: num('pass'), fail: num('fail'), cancelled: num('cancelled') };
  const v = deployerVerdict(summary, r.code);
  for (const x of v.reasons) out.fail(`deployer suite: ${x}`);
  return { ok: v.ok, reasons: v.reasons, ...summary, ms: r.ms, files: files.length, code: r.code };
}

/**
 * Vite writes a bundled copy of vitest.config.js NEXT TO the config file. The container's root
 * filesystem is read-only, so the suite runs from a tmpfs workspace whose entries are symlinks to the
 * image's own files (same bytes; the config file itself is copied and hash-checked). Unique and SHORT
 * path per run (workerd socket paths have a length limit).
 */
function edgeWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-'));
  for (const e of fs.readdirSync(EDGE_DIR)) {
    if (e === 'vitest.config.js') continue;
    fs.symlinkSync(path.join(EDGE_DIR, e), path.join(ws, e));
  }
  fs.copyFileSync(path.join(EDGE_DIR, 'vitest.config.js'), path.join(ws, 'vitest.config.js'));
  if (sha256File(path.join(ws, 'vitest.config.js')) !== sha256File(path.join(EDGE_DIR, 'vitest.config.js'))) throw new KawaError('WORKSPACE', 'config copy differs');
  // F-11 · the image links node_modules/.vite to a tmpfs dir that must exist, or vitest's results
  // cache write fails AFTER all tests passed and the run exits 1.
  try {
    const link = path.join(EDGE_DIR, 'node_modules', '.vite');
    if (fs.lstatSync(link).isSymbolicLink()) fs.mkdirSync(path.resolve(path.dirname(link), fs.readlinkSync(link)), { recursive: true });
  } catch { /* not the image layout */ }
  return ws;
}

export const edgeTestFiles = () => fs.readdirSync(path.join(EDGE_DIR, 'test')).filter(f => f.endsWith('.test.js')).sort();

async function runEdgeSuite(files = []) {
  const json = path.join(os.tmpdir(), `vitest-${crypto.randomBytes(4).toString('hex')}.json`);
  const ws = edgeWorkspace();
  const r = await run(path.join(EDGE_DIR, 'node_modules', '.bin', 'vitest'),
    ['run', '--reporter=default', '--reporter=json', `--outputFile.json=${json}`, ...files], { cwd: ws, tee: false });
  fs.rmSync(ws, { recursive: true, force: true });
  let res = null;
  try { res = JSON.parse(fs.readFileSync(json, 'utf8')); fs.rmSync(json, { force: true }); } catch { /* verdict below */ }
  const summary = (r.text.match(/Test Files .*|Tests .*|Duration .*/g) || []).map(s => s.trim());
  for (const s of summary) out.info(s);
  const expected = files.length ? files.map(f => path.basename(f)) : edgeTestFiles();
  const v = edgeVerdict(res, r.code, expected);
  for (const x of v.reasons) out.fail(`edge suite: ${x}`);
  if (!res) return { ok: false, reasons: v.reasons, pass: 0, fail: 1, ms: r.ms, code: r.code, tail: r.text.slice(-2000) };
  const rel = (n) => path.relative(fs.realpathSync(EDGE_DIR), fs.realpathSync(n));
  const byFile = res.testResults.map(t => ({ file: rel(t.name), status: t.status, tests: t.assertionResults.length,
    failed: t.assertionResults.filter(a => a.status !== 'passed').length,
    ms: Math.round(t.endTime - t.startTime) }));
  const slow = res.testResults.flatMap(t => t.assertionResults.map(a => ({ test: a.fullName, ms: Math.round(a.duration || 0) }))).sort((a, b) => b.ms - a.ms).slice(0, 5);
  const failures = res.testResults.flatMap(t => t.assertionResults.filter(a => a.status !== 'passed').map(a => `${a.fullName}: ${(a.failureMessages || []).join(' ').slice(0, 300)}`));
  for (const f of failures) out.fail(f);
  return { ok: v.ok, reasons: v.reasons, pass: res.numPassedTests, fail: res.numFailedTests + res.numPendingTests + res.numTodoTests,
           total: res.numTotalTests, files: res.testResults.length, expected_files: expected.length, describe_blocks: res.numTotalTestSuites,
           ms: r.ms, by_file: byFile, slowest: slow, failures, code: r.code };
}

function toolchain() {
  return { node: process.version, platform: `${os.platform()}/${os.arch()}`, cpus: os.cpus().length,
           wrangler: pinnedVersion(), image: process.env.KAWA_IMAGE || null };
}

// ---- A · FAST PREFLIGHT -----------------------------------------------------------------------
export async function verifyFast(ctx, f) {
  const t0 = Date.now();
  const wrangler = createWrangler({ quiet: true });
  out.step('Syntax check (node --check) of every deployer and Edge module');
  const js = listPackageFiles(ROOT).filter(p => /\.(mjs|js)$/.test(p) && /^(deployer|edge\/(src|admin-worker|staging-receiver))\//.test(p));
  for (const file of js) {
    if (file.startsWith('edge/')) continue;            // Worker modules import cloudflare:*; bundled by wrangler below
    const r = await run(process.execPath, ['--check', file], { tee: false });
    if (r.code !== 0) throw new KawaError('SYNTAX', `${file}: ${r.text.trim().split('\n')[0]}`);
  }
  out.ok(`${js.length} modules parse (Edge modules are compiled by the wrangler dry-run below)`);
  let cfg;
  if (fs.existsSync(ctx.configFile)) cfg = await loadConfig(ctx.configFile);
  else {
    const ex = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'kawa-edge.example.json'), 'utf8'));
    ex.cloudflare.account_id = '0'.repeat(32);
    cfg = await validateConfig(ex);
    out.info('no config/kawa-edge.json yet: checking the shipped example');
  }
  for (const env of Object.keys(cfg.envs)) await localChecks({ cfg, env, wrangler, dryRun: !f['no-dry-run'], inContainer: !!process.env.KAWA_IN_CONTAINER });
  out.step('Deployer unit tests (no network)');
  const u = await runDeployerSuite(deployerTests(fl => !fl.startsWith('e2e')));
  if (!u.ok) return { result: 'FAIL', detail: `deployer unit tests: ${u.reasons.join('; ')}` };
  return { result: 'PASS', detail: `fast preflight in ${((Date.now() - t0) / 1000).toFixed(1)} s · ${u.pass} unit tests` };
}

// ---- B · TARGETED ---------------------------------------------------------------------------
export function changedFiles() {
  const m = verifyManifest(ROOT);
  if (!m.present) return null;
  return [...m.mismatched, ...m.extra, ...m.missing];
}

export function selectTargets(changed) {
  const edge = new Set(); let allEdge = false; let deployer = false; const reasons = [];
  for (const f of changed) {
    if (/^edge\/(src\/|test\/_|vitest\.config\.js|package(-lock)?\.json)/.test(f)) { allEdge = true; reasons.push(`${f} -> whole Edge suite`); }
    else if (/^edge\/test\/.*\.test\.js$/.test(f)) { edge.add(f.slice('edge/'.length)); reasons.push(`${f} -> that file`); }
    else if (/^(deployer\/|config\/kawa-edge\.example\.json|edge\/(staging-receiver|admin-worker)\/)/.test(f)) { deployer = true; reasons.push(`${f} -> deployer suite (+ rehearse recommended)`); }
    else reasons.push(`${f} -> no test affected (documentation / packaging)`);
  }
  return { allEdge, edgeFiles: [...edge].sort(), deployer, reasons };
}

export async function testTargeted(ctx, f) {
  const changed = f.files ? String(f.files).split(',').map(s => s.trim()).filter(Boolean) : changedFiles();
  if (!changed) throw new KawaError('NO_BASELINE', 'no manifest to diff against in this tree', 'Pass --files edge/test/x.test.js,deployer/lib/y.mjs');
  const sel = selectTargets(changed);
  out.step(`Targeted selection for ${changed.length} changed file(s)`);
  for (const r of sel.reasons) out.info(r);
  let fails = 0, passes = 0;
  if (sel.allEdge || sel.edgeFiles.length) {
    out.step(`Edge suite (${sel.allEdge ? 'all files' : sel.edgeFiles.join(', ')})`);
    const e = await runEdgeSuite(sel.allEdge ? [] : sel.edgeFiles);
    fails += e.ok ? 0 : Math.max(e.fail, 1); passes += e.pass;
  }
  if (sel.deployer) {
    out.step('Deployer suite');
    const d = await runDeployerSuite(deployerTests());
    fails += d.ok ? 0 : Math.max(d.fail, 1); passes += d.pass;
  }
  if (!passes && !fails) return { result: 'PASS', detail: 'no test-affecting change' };
  return { result: fails ? 'FAIL' : 'PASS', detail: `targeted: ${passes} passed, ${fails} failed` };
}

// ---- C · FULL RELEASE GATE -------------------------------------------------------------------
export async function testFull(ctx, f) {
  const hash = inputTreeHash(ROOT);
  out.step(`FULL RELEASE GATE · input tree ${hash.slice(0, 16)}… (${testInputFiles(ROOT).length} files)`);
  out.step('Edge suite · workerd · files in PARALLEL (each file its own isolate and Durable Object streams)');
  const edge = await runEdgeSuite();
  out.step('Deployer suite · node:test · files in parallel (unit + installer E2E against the mock Cloudflare API)');
  const dep = await runDeployerSuite(deployerTests());
  const result = edge.ok && dep.ok ? 'PASS' : 'FAIL';
  const evidence = { schema: 'kawa.edge.test.evidence.v1', ...IDENTITY, result, input_tree_sha256: hash,
    input_files: testInputFiles(ROOT).length, at: new Date().toISOString(), toolchain: toolchain(),
    edge_suite: edge, deployer_suite: dep };
  const dir = path.join(STATE_DIR, 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `test-full-${hash.slice(0, 16)}-${result}.json`);
  writeSigned(file, evidence);
  return { result, detail: `Edge ${edge.pass}/${edge.total ?? edge.pass + edge.fail} (${edge.files ?? 0}/${edge.expected_files ?? '?'} files, exit ${edge.code}) · deployer ${dep.pass}/${dep.tests} (exit ${dep.code}) · ${(edge.ms / 1000).toFixed(1)} s + ${(dep.ms / 1000).toFixed(1)} s`, report: file };
}

// ---- PACKAGE ----------------------------------------------------------------------------------
export function findEvidence(hash) {
  const p = path.join(STATE_DIR, 'evidence', `test-full-${hash.slice(0, 16)}-PASS.json`);
  const e = fs.existsSync(p) ? readEvidence(p) : null;
  if (!e) return null;
  // F-04 · only evidence written by test-full on this installation counts (a hand-written file with
  // the right hash is refused). The independent assurance remains re-running test-full on the ZIP.
  if (!verifySignature(e)) throw new KawaError('EVIDENCE_UNSIGNED', `${path.basename(p)} is not signed by this installation`, 'Re-run ./kawa-edge test-full.');
  return e.input_tree_sha256 === hash && e.result === 'PASS' && e.edge_suite && e.edge_suite.ok && e.deployer_suite && e.deployer_suite.ok ? { file: p, e } : null;
}

export async function packageRelease(ctx, f) {
  const t0 = Date.now();
  const hash = inputTreeHash(ROOT);
  const ev = findEvidence(hash);
  if (!ev) throw new KawaError('NO_TEST_EVIDENCE', `no FULL RELEASE GATE PASS for input tree ${hash.slice(0, 16)}…`,
    'Run ./kawa-edge test-full first. Packaging never re-runs the suite; it proves the evidence covers these exact bytes.');
  out.ok(`test-full evidence reused: ${path.basename(ev.file)} (same input-tree hash; suite NOT re-run)`);
  fs.writeFileSync(path.join(ROOT, EVIDENCE_NAME), JSON.stringify(ev.e, null, 2) + '\n');
  const manifest = buildManifest(ROOT, { ...IDENTITY, input_tree_sha256: hash, test_evidence: EVIDENCE_NAME,
    excludes: 'its own hash; node_modules, state/, secrets/* (except README), config/kawa-edge.json, dist/' });
  fs.writeFileSync(path.join(ROOT, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
  const files = listPackageFiles(ROOT);
  const entries = files.map(p => ({ name: `${ZIP_ROOT}/${p}`, data: fs.readFileSync(path.join(ROOT, p)),
                                   mode: p === 'kawa-edge' ? 0o755 : 0o644 }));
  const distDir = f.out ? path.resolve(f.out) : path.join(ROOT, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const zip = path.join(distDir, ZIP_NAME);
  writeZip(zip, entries);
  const zsha = sha256File(zip);
  fs.writeFileSync(`${zip}.sha256`, `${zsha}  ${ZIP_NAME}\n`);
  const msha = sha256File(path.join(ROOT, MANIFEST_NAME));
  out.ok(`${ZIP_NAME} · ${files.length} files · ${(fs.statSync(zip).size / 1024).toFixed(0)} KiB`);
  out.info(`ZIP sha256      ${zsha}`);
  out.info(`MANIFEST sha256 ${msha} (${manifest.file_count} files declared, self-hash excluded)`);
  return { result: 'PASS', detail: `packaged in ${((Date.now() - t0) / 1000).toFixed(1)} s · sha256 ${zsha}` };
}

// ---- D · VERIFY RELEASE ------------------------------------------------------------------------
export async function verifyRelease(ctx, f) {
  const zip = path.resolve(f._[0] || path.join(ROOT, 'dist', ZIP_NAME));
  if (!fs.existsSync(zip)) throw new KawaError('NO_ZIP', `not found: ${zip}`);
  out.step(`Verify ${path.basename(zip)}`);
  const zsha = sha256File(zip);
  const side = `${zip}.sha256`;
  const want = f.sha256 || (fs.existsSync(side) ? fs.readFileSync(side, 'utf8').split(/\s+/)[0] : null);
  if (!want) throw new KawaError('ZIP_SHA_UNKNOWN', `no ${path.basename(side)} and no --sha256=<expected>: integrity cannot be checked`);
  if (want !== zsha) throw new KawaError('ZIP_SHA_MISMATCH', `sha256 ${zsha} != ${want}`);
  out.ok('sha256 matches the expected value');
  // F-06 · inspect the RAW entry list, not a filtered directory listing: every entry must be under the
  // package root, declared in the manifest, and nothing secret/stateful may be present at all.
  const entries = readZip(zip).map(e => e.name);
  const outside = entries.filter(n => !n.startsWith(`${ZIP_ROOT}/`) || n.includes('..') || n.startsWith('/'));
  if (outside.length) throw new KawaError('ZIP_ENTRY_OUTSIDE_ROOT', outside.slice(0, 5).join(', '));
  const rel = entries.map(n => n.slice(ZIP_ROOT.length + 1));
  const forbiddenRaw = rel.filter(p => /(^|\/)node_modules\/|(^|\/)\.git\/|^state\/|^dist\/|^secrets\/(?!README\.md$)|^config\/kawa-edge\.json|^config\/.*\.(bak|tmp)-|(^|\/)\.dev\.vars$|(^|\/)\.npmrc$|(^|\/)\.env$|^edge\/wrangler\.(toml|json)$|\.(zip|sha256|log)$/.test(p));
  if (forbiddenRaw.length) throw new KawaError('FORBIDDEN_FILES', forbiddenRaw.join(', '));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kawa-verify-'));
  try {
    extractZip(zip, tmp);
    const root = path.join(tmp, ZIP_ROOT);
    const m = verifyManifest(root);
    if (!m.ok) throw new KawaError('MANIFEST_MISMATCH', `missing ${m.missing} mismatched ${m.mismatched} undeclared ${m.extra}`);
    const declared = new Set([...Object.keys(JSON.parse(fs.readFileSync(path.join(root, MANIFEST_NAME), 'utf8')).files), MANIFEST_NAME]);
    const undeclared = rel.filter(p => !declared.has(p));
    const absent = [...declared].filter(p => !rel.includes(p));
    if (undeclared.length || absent.length) throw new KawaError('ZIP_ENTRIES_NOT_MANIFEST', `undeclared ${undeclared.join(',') || '-'} · absent ${absent.join(',') || '-'}`);
    out.ok(`manifest: ${m.file_count} files verified · ${m.artifact} · ${m.revision}`);
    const ev = JSON.parse(fs.readFileSync(path.join(root, EVIDENCE_NAME), 'utf8'));
    const h = inputTreeHash(root);
    if (ev.input_tree_sha256 !== h || ev.result !== 'PASS') throw new KawaError('EVIDENCE_NOT_BOUND', `evidence is for ${ev.input_tree_sha256.slice(0, 16)}…, package inputs are ${h.slice(0, 16)}…`);
    if (!ev.edge_suite.ok || !ev.deployer_suite.ok || ev.edge_suite.code !== 0 || ev.deployer_suite.code !== 0) throw new KawaError('EVIDENCE_NOT_PASS', 'packaged evidence records a non-zero exit or a failed verdict');
    out.ok(`test evidence bound to these bytes: input tree ${h.slice(0, 16)}… · Edge ${ev.edge_suite.pass}/${ev.edge_suite.total} (exit 0) · deployer ${ev.deployer_suite.pass}/${ev.deployer_suite.tests} (exit 0)`);
    out.info('the packaged evidence is a signed RECORD; independent assurance = re-run ./kawa-edge test-full on this ZIP (physical gate)');
    const all = rel;
    out.ok(`raw ZIP entries (${entries.length}) = manifest + itself; no secrets, state, node_modules, user config or implicit root wrangler config`);
    for (const p of ['Dockerfile', 'docker-compose.yml', 'kawa-edge', 'README_NAS_INSTALL.md', 'RUNBOOK_VIGENTE.md', 'edge/package-lock.json', 'config/kawa-edge.example.json']) {
      if (!all.includes(p)) throw new KawaError('INCOMPLETE_PACKAGE', `missing ${p}`);
    }
    out.ok('turnkey files present');
    const legacy = all.filter(p => /STAGING_RUNBOOK\.md$|wrangler\.consumer\.staging\.toml$/.test(p));
    if (legacy.length) throw new KawaError('LEGACY_RUNBOOK_PRESENT', legacy.join(', '));
    out.ok('exactly one runbook in force (RUNBOOK_VIGENTE.md); no V1.2.x deploy instructions shipped');
    return { result: 'PASS', detail: `release verified · sha256 ${zsha}` };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
