/**
 * Evidence integrity (audit F-04/F-05/F-16).
 *
 * THREAT MODEL, stated plainly: evidence files live in state/ on the NAS. A local HMAC key
 * (state/.evidence-key, 0600) signs every evidence file the deployer writes, so a hand-written,
 * edited or copied-in file is refused. It cannot stop someone with root on the NAS who can also read
 * the key; for PROD that is why STAGING evidence is ALSO corroborated live against Cloudflare (the
 * STAGING Workers must still carry the exact builds the gates certified), and why the release's
 * independent assurance is re-running `test-full` on the delivered ZIP (physical gate), not reading
 * the packaged JSON.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR, EDGE_DIR, DEPLOYER_DIR } from './paths.mjs';
import { KawaError } from './log.mjs';

const keyFile = () => path.join(STATE_DIR, '.evidence-key');

function key() {
  const f = keyFile();
  if (!fs.existsSync(f)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  }
  return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
}

/** Canonical JSON: sorted keys, so the signature does not depend on key order. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export function sign(obj) {
  const body = { ...obj }; delete body.signature;
  const k = key();
  return { ...body, signature: { alg: 'HMAC-SHA256', key_id: crypto.createHash('sha256').update(k).digest('hex').slice(0, 12),
                                  value: crypto.createHmac('sha256', k).update(canonical(body)).digest('hex') } };
}

export function verify(obj) {
  if (!obj || !obj.signature || obj.signature.alg !== 'HMAC-SHA256') return false;
  if (!fs.existsSync(keyFile())) return false;
  const body = { ...obj }; delete body.signature;
  const want = crypto.createHmac('sha256', key()).update(canonical(body)).digest('hex');
  const got = String(obj.signature.value || '');
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export function writeSigned(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(sign(obj), null, 2));
}

/** Parse, never throw: a corrupt evidence file is simply not evidence (audit E-12). */
export function readEvidence(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * What a STAGING PASS certifies for PROD (audit F-05): every file of the deployer (renderer, config
 * validation, gates, deploy logic), every Edge runtime source (ingress/sequencer/consumer, receiver,
 * admin), the lockfile, and the pinned wrangler. Change any byte and the old PASS stops counting.
 */
export function bindingHash(wranglerVersion) {
  const files = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name), r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p, r); else if (e.isFile()) files.push([r, p]);
    }
  };
  walk(path.join(DEPLOYER_DIR, 'lib'), 'deployer/lib');
  for (const d of ['src', 'staging-receiver/src', 'admin-worker/src']) walk(path.join(EDGE_DIR, d), `edge/${d}`);
  files.push(['edge/package-lock.json', path.join(EDGE_DIR, 'package-lock.json')]);
  const h = crypto.createHash('sha256');
  for (const [r, p] of files.sort((a, b) => (a[0] < b[0] ? -1 : 1))) { h.update(`${r}\0`); h.update(fs.readFileSync(p)); h.update('\0'); }
  h.update(`wrangler@${wranglerVersion}`);
  return h.digest('hex');
}

export function assertSigned(obj, what) {
  if (!verify(obj)) throw new KawaError('EVIDENCE_UNSIGNED', `${what} is not signed by this installation (hand-written, edited or copied)`);
}
