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
import { writeZip, extractZip } from './zip.mjs';

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

async function runDeployerSuite(files) {
  if (!files.length) return { pass: 0, fail: 0, ms: 0, files: 0 };
  const r = await run(process.execPath, ['--test', '--test-reporter=spec', ...files], { tee: true });
  // node:test's own summary, not a count of ✔ lines (which also match nested/suite lines).
  const num = (k) => { const m = new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(r.text); return m ? Number(m[1]) : 0; };
  const pass = num('pass'), fail = num('fail') + num('cancelled');
  return { pass, fail: r.code === 0 ? fail : Math.max(fail, 1), ms: r.ms, files: files.length, code: r.code };
}

/**
 * Vite writes a bundled copy of vitest.config.js NEXT TO the config file. The container's root
 * filesystem is read-only, so the suite runs from a tmpfs workspace whose entries are symlinks to the
 * image's own files (same bytes; the config file itself is copied and hash-checked).
 */
function edgeWorkspace() {
  const ws = path.join(os.tmpdir(), 'kawa-edge-tests');
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });
  for (const e of fs.readdirSync(EDGE_DIR)) {
    if (e === 'vitest.config.js') continue;
    fs.symlinkSync(path.join(EDGE_DIR, e), path.join(ws, e));
  }
  fs.copyFileSync(path.join(EDGE_DIR, 'vitest.config.js'), path.join(ws, 'vitest.config.js'));
  if (sha256File(path.join(ws, 'vitest.config.js')) !== sha256File(path.join(EDGE_DIR, 'vitest.config.js'))) throw new KawaError('WORKSPACE', 'config copy differs');
  return ws;
}

async function runEdgeSuite(files = []) {
  const json = path.join(os.tmpdir(), `vitest-${crypto.randomBytes(4).toString('hex')}.json`);
  const ws = edgeWorkspace();
  const r = await run(path.join(EDGE_DIR, 'node_modules', '.bin', 'vitest'),
    ['run', '--reporter=default', '--reporter=json', `--outputFile.json=${json}`, ...files], { cwd: ws, tee: false });
  let res = null;
  try { res = JSON.parse(fs.readFileSync(json, 'utf8')); fs.rmSync(json, { force: true }); } catch { /* reported below */ }
  const summary = (r.text.match(/Test Files .*|Tests .*|Duration .*/g) || []).map(s => s.trim());
  for (const s of summary) out.info(s);
  if (!res) return { pass: 0, fail: 1, ms: r.ms, error: 'vitest produced no JSON result', tail: r.text.slice(-2000) };
  const rel = (n) => path.relative(fs.realpathSync(EDGE_DIR), fs.realpathSync(n));
  const byFile = res.testResults.map(t => ({ file: rel(t.name), tests: t.assertionResults.length,
    failed: t.assertionResults.filter(a => a.status !== 'passed').length,
    ms: Math.round(t.endTime - t.startTime) }));
  const slow = res.testResults.flatMap(t => t.assertionResults.map(a => ({ test: a.fullName, ms: Math.round(a.duration || 0) }))).sort((a, b) => b.ms - a.ms).slice(0, 5);
  const failures = res.testResults.flatMap(t => t.assertionResults.filter(a => a.status !== 'passed').map(a => `${a.fullName}: ${(a.failureMessages || []).join(' ').slice(0, 300)}`));
  for (const f of failures) out.fail(f);
  return { pass: res.numPassedTests, fail: res.numFailedTests + res.numPendingTests + res.numTodoTests, total: res.numTotalTests,
           files: res.numTotalTestSuites, ms: r.ms, by_file: byFile, slowest: slow, failures, code: r.code };
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
  if (u.fail) return { result: 'FAIL', detail: `deployer unit tests: ${u.fail} failed` };
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
    fails += e.fail; passes += e.pass;
  }
  if (sel.deployer) {
    out.step('Deployer suite');
    const d = await runDeployerSuite(deployerTests());
    fails += d.fail; passes += d.pass;
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
  const result = !edge.fail && !dep.fail && edge.pass > 0 ? 'PASS' : 'FAIL';
  const evidence = { schema: 'kawa.edge.test.evidence.v1', ...IDENTITY, result, input_tree_sha256: hash,
    input_files: testInputFiles(ROOT).length, at: new Date().toISOString(), toolchain: toolchain(),
    edge_suite: edge, deployer_suite: dep };
  const dir = path.join(STATE_DIR, 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `test-full-${hash.slice(0, 16)}-${result}.json`);
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
  return { result, detail: `Edge ${edge.pass}/${edge.total ?? edge.pass + edge.fail} · deployer ${dep.pass} passed, ${dep.fail} failed · ${(edge.ms / 1000).toFixed(1)} s + ${(dep.ms / 1000).toFixed(1)} s`, report: file };
}

// ---- PACKAGE ----------------------------------------------------------------------------------
export function findEvidence(hash) {
  const dir = path.join(STATE_DIR, 'evidence');
  const p = path.join(dir, `test-full-${hash.slice(0, 16)}-PASS.json`);
  if (!fs.existsSync(p)) return null;
  const e = JSON.parse(fs.readFileSync(p, 'utf8'));
  return e.input_tree_sha256 === hash && e.result === 'PASS' ? { file: p, e } : null;
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
  if (fs.existsSync(side)) {
    const want = fs.readFileSync(side, 'utf8').split(/\s+/)[0];
    if (want !== zsha) throw new KawaError('ZIP_SHA_MISMATCH', `sha256 ${zsha} != ${want}`);
    out.ok(`sha256 matches ${path.basename(side)}`);
  } else out.info(`sha256 ${zsha} (no sidecar to compare)`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kawa-verify-'));
  try {
    extractZip(zip, tmp);
    const root = path.join(tmp, ZIP_ROOT);
    const m = verifyManifest(root);
    if (!m.ok) throw new KawaError('MANIFEST_MISMATCH', `missing ${m.missing} mismatched ${m.mismatched} undeclared ${m.extra}`);
    out.ok(`manifest: ${m.file_count} files verified · ${m.artifact} · ${m.revision}`);
    const ev = JSON.parse(fs.readFileSync(path.join(root, EVIDENCE_NAME), 'utf8'));
    const h = inputTreeHash(root);
    if (ev.input_tree_sha256 !== h || ev.result !== 'PASS') throw new KawaError('EVIDENCE_NOT_BOUND', `evidence is for ${ev.input_tree_sha256.slice(0, 16)}…, package inputs are ${h.slice(0, 16)}…`);
    out.ok(`test evidence bound to these bytes: input tree ${h.slice(0, 16)}… · Edge ${ev.edge_suite.pass}/${ev.edge_suite.total} · deployer ${ev.deployer_suite.pass} passed`);
    const all = listPackageFiles(root);
    const forbidden = all.filter(p => /(^|\/)node_modules\/|^state\/|^secrets\/(?!README\.md$)|^config\/kawa-edge\.json$|^edge\/wrangler\.(toml|json)$|\.dev\.vars$/.test(p));
    if (forbidden.length) throw new KawaError('FORBIDDEN_FILES', forbidden.join(', '));
    out.ok('no secrets, state, node_modules, user config or implicit root wrangler config in the package');
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
