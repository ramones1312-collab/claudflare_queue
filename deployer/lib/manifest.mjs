/**
 * Package manifest (SHA-256 per file, self-hash excluded, as in R4) and the TEST INPUT TREE hash:
 * the digest of exactly the files that can change a test result. Test evidence is bound to that
 * hash, so packaging can reuse a FULL RELEASE GATE run instead of repeating it — and can prove the
 * reuse is legitimate because the bytes are the same.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MANIFEST_NAME = 'MANIFEST_SHA256_V1_3_1.json';

/** Never part of the package. */
const EXCLUDE_DIRS = new Set(['state', 'dist', 'build', 'delivery']);   // delivery/: notes for reviewers, not package content
// R3-12 · tool directories are excluded ONLY where the tools create them; anywhere else they are package
// content (hashed), so e.g. edge/test/.wrangler/x.test.js changes the input-tree hash.
const TOOL_DIRS = new Set(['node_modules', '.git', '.claude', '.wrangler', '.vite',
                           'edge/node_modules', 'edge/.wrangler', 'edge/.vite']);
const EXCLUDE_FILES = [/^secrets\/(?!README\.md$)/, /^config\/kawa-edge\.json(\.bak-.*)?$/, /^[^/]+\.log$/];

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function listPackageFiles(root) {
  const outFiles = [];
  (function walk(rel) {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      // F-12 · exclusions apply at the ROOT only (edge/src/state/x.js is package content); R3-12 · tool
      // directories only at their fixed places.
      const excluded = TOOL_DIRS.has(r) || (!rel && EXCLUDE_DIRS.has(e.name));
      if (e.isDirectory()) { if (!excluded) walk(r); continue; }
      // A symlink inside the package is refused, never silently skipped (it could hide test inputs).
      if (e.isSymbolicLink()) { if (!excluded) throw new Error(`symbolic link in the package: ${r}`); continue; }
      if (!e.isFile()) throw new Error(`not a regular file in the package: ${r}`);   // R3-12 · fifo, socket, device
      if (EXCLUDE_FILES.some(re => re.test(r))) continue;
      outFiles.push(r);
    }
  })('');
  return outFiles.sort();
}

export function buildManifest(root, meta) {
  const files = {};
  for (const f of listPackageFiles(root)) if (f !== MANIFEST_NAME) files[f] = sha256File(path.join(root, f));
  return { algorithm: 'SHA-256', ...meta, self_hash_excluded: true, file_count: Object.keys(files).length, files };
}

/** Verifies every declared file. `skip` prefixes are files the running context cannot see (mounts). */
export function verifyManifest(root, { skip = [] } = {}) {
  const file = path.join(root, MANIFEST_NAME);
  if (!fs.existsSync(file)) return { present: false, ok: false, missing: [], mismatched: [], extra: [] };
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  const missing = [], mismatched = [];
  for (const [f, h] of Object.entries(m.files)) {
    if (skip.some(p => f.startsWith(p))) continue;
    const p = path.join(root, f);
    if (!fs.existsSync(p)) { missing.push(f); continue; }
    if (sha256File(p) !== h) mismatched.push(f);
  }
  const declared = new Set(Object.keys(m.files));
  const extra = listPackageFiles(root).filter(f => f !== MANIFEST_NAME && !declared.has(f) && !skip.some(p => f.startsWith(p)));
  return { present: true, ok: !missing.length && !mismatched.length && !extra.length, missing, mismatched, extra,
           manifest_sha256: sha256File(file), artifact: m.artifact, revision: m.revision, file_count: m.file_count };
}

/** Files whose bytes can change a test outcome. Docs never do. */
export function testInputFiles(root) {
  return listPackageFiles(root).filter(f =>
    /^edge\/(src|test|staging-receiver|admin-worker)\//.test(f) ||
    /^edge\/(package\.json|package-lock\.json|vitest\.config\.js)$/.test(f) ||
    /^deployer\//.test(f) || /^config\/kawa-edge\.example\.json$/.test(f) ||
    /^(Dockerfile|docker-compose\.yml|\.dockerignore|kawa-edge)$/.test(f));
}

export function inputTreeHash(root) {
  const h = crypto.createHash('sha256');
  for (const f of testInputFiles(root)) h.update(`${f}\0${sha256File(path.join(root, f))}\n`);
  return h.digest('hex');
}
