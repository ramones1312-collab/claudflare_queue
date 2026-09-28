/**
 * Packages the release WITHOUT re-running the suite: refuses unless dist/test-evidence.json (written by
 * tools/test-full.sh) matches the current input hash. Deterministic ZIP (fixed timestamps, sorted),
 * MANIFEST.sha256 inside, <zip>.sha256 beside it.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const NAME = 'KAWA_VECTOR_MULTIHUB_DISPATCHER_V0_1_1';
const FULL = 'KAWA_VECTOR_MULTIHUB_DISPATCHER_V0_1_1_AUDIT_OBSERVABILITY', FTR = 'KAWA_VECTOR_MULTIHUB_DISPATCHER_V0_1_1_FILES_TO_REPLACE';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]);

/** Everything the tests exercise: source, tests, package files, Docker files, example config. */
export const inputFiles = () => [...walk('src'), ...walk('test'), 'package.json', 'package-lock.json', 'Dockerfile', 'docker-compose.yml', '.dockerignore', 'config/destinations.json'].sort();
export const inputHash = () => sha(inputFiles().map(f => `${f}\0${sha(fs.readFileSync(path.join(ROOT, f)))}\n`).join(''));

const SHIP = () => [...walk('src'), ...walk('test'), 'package.json', 'package-lock.json', 'Dockerfile', 'docker-compose.yml', '.dockerignore', 'VERSION',
  'README_NAS_INSTALL.md', 'TEST_REPORT.md', 'config/destinations.json', 'secrets/hub_a_webhook_token', 'secrets/hub_b_webhook_token',
  'secrets/ingress_webhook_token', 'secrets/audit_admin_token', 'data/.keep'].sort();
const SECRETS = ['secrets/hub_a_webhook_token', 'secrets/hub_b_webhook_token', 'secrets/ingress_webhook_token', 'secrets/audit_admin_token'];
// Never part of an in-place upgrade: the operator's own configuration, data and existing secrets.
const DO_NOT_REPLACE = ['config/destinations.json', 'data/.keep', 'secrets/ingress_webhook_token', 'secrets/hub_a_webhook_token', 'secrets/hub_b_webhook_token'];
const PURPOSE = (f) => f === 'src/audit.mjs' ? 'NEW audit module: audit_events table, status file, retention, /audit UI/API/exports'
  : f.startsWith('src/audit-ui/') ? 'NEW /audit web page (no framework), served behind Basic Auth'
  : f === 'src/server.mjs' ? 'request_id, ingress audit rows after the ACK, /audit routing, optional audit fields in /health'
  : f === 'src/dispatcher.mjs' ? 'audit rows per delivery attempt/result (delivery logic unchanged)'
  : f === 'src/main.mjs' ? 'creates the audit; DISPATCHER_STARTED/STOPPING; CONFIG_INVALID recorded best-effort'
  : f === 'src/config.mjs' ? 'passes the optional "audit" block through (core validation unchanged)'
  : f === 'secrets/audit_admin_token' ? 'EMPTY placeholder: put the audit web password here (not a real secret)'
  : f.startsWith('test/') ? 'tests (not used at runtime; excluded from the image by .dockerignore)'
  : f === 'docker-compose.yml' ? 'image tag 0.1.1 only (ports, volumes, security unchanged)'
  : f === 'MANIFEST.sha256' ? 'integrity list of V0.1.1 (config/ and secrets/ are expected to differ on your NAS)'
  : f === 'FILES_TO_REPLACE.md' ? 'this table' : 'version / documentation';

function writeZip(out, entries) {           // entries: { name, data (Buffer) | null for a directory, mode }
  const T = (0 << 11) | (0 << 5), D = ((2026 - 1980) << 9) | (9 << 5) | 27;   // 2026-09-27 00:00, fixed
  const parts = [], central = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), dir = e.data === null, data = dir ? Buffer.alloc(0) : e.data;
    const comp = dir ? data : zlib.deflateRawSync(data, { level: 9 }), method = dir ? 0 : 8, crc = zlib.crc32(data) >>> 0;
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(method, 8); l.writeUInt16LE(T, 10); l.writeUInt16LE(D, 12);
    l.writeUInt32LE(crc, 14); l.writeUInt32LE(comp.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(0x031e, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(method, 10); c.writeUInt16LE(T, 12); c.writeUInt16LE(D, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE((((dir ? 0o40755 : e.mode) >>> 0) << 16 | (dir ? 0x10 : 0)) >>> 0, 38); c.writeUInt32LE(off, 42);
    parts.push(l, name, comp); central.push(c, name); off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  fs.writeFileSync(out, Buffer.concat([...parts, cd, end]));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const t0 = Date.now();
  const V01 = process.argv[2];
  if (!V01 || !fs.existsSync(path.join(V01, 'MANIFEST.sha256'))) { console.error('usage: node tools/package.mjs <extracted V0.1 folder>'); process.exit(2); }
  const evFile = path.join(ROOT, 'dist', 'test-evidence.json');
  const ev = fs.existsSync(evFile) ? JSON.parse(fs.readFileSync(evFile, 'utf8')) : null;
  const h = inputHash();
  if (!ev || ev.input_sha256 !== h || ev.result !== 'PASS') { console.error(`REFUSED: no PASS test evidence for input ${h.slice(0, 16)}… — run tools/test-full.sh`); process.exit(1); }
  for (const s of SECRETS) if (fs.statSync(path.join(ROOT, s)).size !== 0) { console.error(`REFUSED: ${s} is not empty (secrets never ship)`); process.exit(1); }
  const files = SHIP();
  const manifest = files.map(f => `${sha(fs.readFileSync(path.join(ROOT, f)))}  ${f}`).join('\n') + '\n';
  const dirs = (root, list) => [...new Set(list.flatMap(f => f.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))))].map(d => ({ name: `${root}${d}/`, data: null }));
  // FULL: fresh install folder
  const full = [{ name: `${NAME}/`, data: null }, ...dirs(`${NAME}/`, files)];
  for (const f of files) full.push({ name: `${NAME}/${f}`, data: fs.readFileSync(path.join(ROOT, f)), mode: 0o100644 });
  full.push({ name: `${NAME}/MANIFEST.sha256`, data: Buffer.from(manifest), mode: 0o100644 });
  full.sort((a, b) => (a.name < b.name ? -1 : 1));
  // FILES TO REPLACE: every shipped file that is new or different from V0.1, minus the operator's files
  const v01 = Object.fromEntries(fs.readFileSync(path.join(V01, 'MANIFEST.sha256'), 'utf8').trim().split('\n').map(l => l.split(/\s+/)).map(([hh, f]) => [f, hh]));
  const changed = files.filter(f => !DO_NOT_REPLACE.includes(f) && v01[f] !== sha(fs.readFileSync(path.join(ROOT, f))));
  const rowsT = [...changed, 'MANIFEST.sha256'].map(f => ({ f, action: (v01[f] || f === 'MANIFEST.sha256') ? 'REPLACE' : 'ADD', sha: f === 'MANIFEST.sha256' ? sha(manifest) : sha(fs.readFileSync(path.join(ROOT, f))) }));
  const removed = Object.keys(v01).filter(f => !files.includes(f));
  const md = ['# FILES TO REPLACE · Multi-Hub Dispatcher V0.1 → V0.1.1', '',
    'Extract this ZIP **inside** the existing project folder (the one with `docker-compose.yml`): paths are relative to it.', '',
    '| PATH | ACTION | SHA256 NEW | PURPOSE |', '|---|---|---|---|',
    ...rowsT.map(r => `| \`${r.f}\` | ${r.action} | \`${r.sha}\` | ${PURPOSE(r.f)} |`), '| `FILES_TO_REPLACE.md` | ADD | (this file) | this table |', '',
    '## DO NOT REPLACE', '', '```', 'config/destinations.json', 'data/', ...DO_NOT_REPLACE.filter(f => f.startsWith('secrets/')), '```', '',
    'The only new secret is `secrets/audit_admin_token`, shipped **empty**: write the audit web password into it (16+ characters, different from every other secret).',
    removed.length ? `\nFiles of V0.1 no longer shipped: ${removed.join(', ')}` : '\nNo V0.1 file is removed.', ''].join('\n');
  fs.mkdirSync(path.join(ROOT, 'dist', 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'dist', 'docs', 'FILES_TO_REPLACE.md'), md);
  const ftr = [...dirs('', changed), ...changed.map(f => ({ name: f, data: fs.readFileSync(path.join(ROOT, f)), mode: 0o100644 })),
    { name: 'MANIFEST.sha256', data: Buffer.from(manifest), mode: 0o100644 }, { name: 'FILES_TO_REPLACE.md', data: Buffer.from(md), mode: 0o100644 }].sort((a, b) => (a.name < b.name ? -1 : 1));
  const outDir = path.join(ROOT, 'dist', 'release');
  fs.mkdirSync(outDir, { recursive: true });
  const out = {};
  for (const [nm, entries] of [[FULL, full], [FTR, ftr]]) {
    const z = path.join(outDir, `${nm}.zip`);
    writeZip(z, entries);
    out[nm] = sha(fs.readFileSync(z));
    fs.writeFileSync(`${z}.sha256`, `${out[nm]}  ${nm}.zip\n`);
  }
  console.log(`PACKAGED in ${Date.now() - t0} ms (suite NOT re-run: evidence ${h.slice(0, 16)}…)`);
  console.log(`  ${FULL}.zip  ${out[FULL]}  (${files.length + 1} files)`);
  console.log(`  ${FTR}.zip  ${out[FTR]}  (${changed.length + 2} files: ${rowsT.filter(r => r.action === 'REPLACE').length} replace, ${rowsT.filter(r => r.action === 'ADD').length} add)`);
}
