/**
 * Secret handling. Rules, all enforced here:
 *   - the Cloudflare API token is read ONCE per run, from a hidden TTY prompt or from a
 *     consume-once file (secrets/cloudflare_api_token) that is overwritten and deleted the moment
 *     it is read. It lives only in this process's memory and in the environment of the wrangler
 *     child processes it spawns. It is never written to state/, logs or reports;
 *   - Hub webhook URLs (PROD) are prompted, validated, uploaded and forgotten. Only a keyed HMAC
 *     fingerprint is kept, so a later add-hub can refuse to reuse HUB_A's credential;
 *   - wrangler receives secrets through --secrets-file in a tmpfs directory (0700), file 0600,
 *     overwritten and unlinked in a finally block;
 *   - STAGING-only tokens (path token, receiver control, admin) are generated here and kept in
 *     state/staging/secrets.json (0600) so gates can be re-run; teardown deletes them.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { RUNTIME_DIR, SECRETS_DIR, STATE_DIR } from './paths.mjs';
import { registerSecret, KawaError, out } from './log.mjs';
import { HARD_LOCKS } from './config.mjs';

export const TOKEN_FILE = 'cloudflare_api_token';

function shred(file) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, Buffer.alloc(Math.max(size, 1), 0), 0, Math.max(size, 1), 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch { /* best effort before unlink */ }
  fs.rmSync(file, { force: true });
}

/** Container Manager UI runs allocate a TTY that nobody types into: KAWA_NONINTERACTIVE=1 says so. */
const interactive = () => process.stdin.isTTY && !process.env.KAWA_NONINTERACTIVE;

export function promptHidden(question) {
  if (!interactive()) {
    return Promise.reject(new KawaError('NO_TTY', 'cannot prompt for a secret: no interactive terminal',
      'Run through ./kawa-edge (docker compose run allocates a terminal) or use the consume-once secret file described in README_NAS_INSTALL.md.'));
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
  });
}

export function promptLine(question) {
  if (!interactive()) return Promise.resolve('');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

/** The Cloudflare API token. Consume-once file first, then hidden prompt. Never an env var. */
export async function acquireApiToken() {
  const file = path.join(SECRETS_DIR, TOKEN_FILE);
  let token = '';
  if (fs.existsSync(file)) {
    token = fs.readFileSync(file, 'utf8').trim();
    shred(file);
    out.info(`API token read from secrets/${TOKEN_FILE} — file overwritten and deleted (consume-once)`);
  } else {
    token = await promptHidden('Cloudflare API token (input hidden, never stored): ');
  }
  if (!/^[A-Za-z0-9_-]{30,}$/.test(token)) {
    throw new KawaError('TOKEN_MALFORMED', 'the Cloudflare API token is empty or malformed',
      'Create a dedicated token as described in CLOUDFLARE_API_TOKEN.md and paste it at the prompt.');
  }
  return registerSecret(token);
}

/** Runs `fn(file)` with the secrets written to a 0600 file on tmpfs; the file is always destroyed. */
export async function withSecretsFile(values, fn) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(RUNTIME_DIR, `s-${crypto.randomBytes(8).toString('hex')}.json`);
  for (const v of Object.values(values)) registerSecret(v);
  fs.writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
  try { return await fn(file); } finally { shred(file); }
}

export const randomToken = (bytes = 32) => registerSecret(crypto.randomBytes(bytes).toString('base64url'));

// ---- STAGING secrets store ---------------------------------------------------------------
const stagingFile = () => path.join(STATE_DIR, 'staging', 'secrets.json');

export function loadStagingSecrets() {
  const f = stagingFile();
  if (!fs.existsSync(f)) return null;
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  registerSecret(s.WEBHOOK_PATH_TOKEN); registerSecret(s.ADMIN_TOKEN);
  for (const v of Object.values(s.CONTROL_TOKEN || {})) registerSecret(v);
  if (s.HALT_NOTIFY_URL) registerSecret(s.HALT_NOTIFY_URL);
  return s;
}

export function saveStagingSecrets(s) {
  fs.mkdirSync(path.dirname(stagingFile()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(stagingFile(), JSON.stringify(s, null, 2), { mode: 0o600 });
}

export function deleteStagingSecrets() { shred(stagingFile()); }

/** Ensures every STAGING token exists; returns { secrets, created: [...] }. */
export function ensureStagingSecrets(destIds, haltNotifyUrl) {
  const s = loadStagingSecrets() || {};
  const created = [];
  if (!s.WEBHOOK_PATH_TOKEN) { s.WEBHOOK_PATH_TOKEN = randomToken(); created.push('WEBHOOK_PATH_TOKEN'); }
  if (!s.ADMIN_TOKEN) { s.ADMIN_TOKEN = randomToken(); created.push('ADMIN_TOKEN'); }
  s.CONTROL_TOKEN = s.CONTROL_TOKEN || {};
  for (const id of destIds) if (!s.CONTROL_TOKEN[id]) { s.CONTROL_TOKEN[id] = randomToken(); created.push(`CONTROL_TOKEN:${id}`); }
  if (haltNotifyUrl) s.HALT_NOTIFY_URL = registerSecret(haltNotifyUrl);
  // STAGING without a collector: a .invalid host fails fast on Cloudflare and the halt is still
  // durable (R4: the safety property never depends on the notification channel).
  if (!s.HALT_NOTIFY_URL) s.HALT_NOTIFY_URL = 'https://halt-notify.invalid/kawa-edge-stg';
  saveStagingSecrets(s);
  return { secrets: s, created };
}

// ---- PROD webhook URL validation and non-reuse -----------------------------------------------
/**
 * A Hub webhook URL is accepted only if it points at that Hub's public INGRESS hostname over HTTPS,
 * with no explicit port and a /webhook/<token> path. 8180/8080 (control plane) are refused in any
 * form, whatever the configuration says.
 */
export function validateWebhookUrl(raw, expectedHost) {
  let u;
  try { u = new URL(raw); } catch { throw new KawaError('WEBHOOK_URL_INVALID', 'not a valid URL'); }
  for (const p of HARD_LOCKS.FORBIDDEN_PORTS) {
    if (u.port === p || raw.includes(`:${p}`)) {
      throw new KawaError('HARD_LOCK_CONTROL_PORT', `port ${p} is the Hub CONTROL plane; signals may only go to the INGRESS (8181 -> 8081) through the public hostname`);
    }
  }
  if (u.protocol !== 'https:') throw new KawaError('WEBHOOK_URL_NOT_HTTPS', 'the webhook URL must use https');
  if (u.port) throw new KawaError('WEBHOOK_URL_PORT', 'the webhook URL must not name a port: the Tunnel maps the public hostname to the ingress');
  if (u.hostname !== expectedHost) throw new KawaError('WEBHOOK_URL_HOST', `host must be ${expectedHost} (config webhook_host), got a different host`);
  if (!/^\/webhook\/[^/]{16,}$/.test(u.pathname) || u.search || u.hash || u.username || u.password) {
    throw new KawaError('WEBHOOK_URL_PATH', 'path must be exactly /webhook/<WEBHOOK_SECRET> (secret ≥ 16 chars), no query or credentials');
  }
  return registerSecret(u.toString());
}

const fpFile = () => path.join(STATE_DIR, 'prod', 'webhook-fingerprints.json');

function fpStore() {
  const f = fpFile();
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  return { key: crypto.randomBytes(32).toString('hex'), destinations: {} };
}

export function fingerprint(store, url) {
  // Only the secret part matters: the same token on another host is still reuse.
  const token = new URL(url).pathname.split('/').pop();
  return crypto.createHmac('sha256', Buffer.from(store.key, 'hex')).update(token).digest('hex');
}

/** Refuses a credential already used by another destination. Records it for this one. */
export function checkAndRecordFingerprint(destId, url) {
  const store = fpStore();
  const fp = fingerprint(store, url);
  for (const [other, v] of Object.entries(store.destinations)) {
    if (other !== destId && v === fp) {
      throw new KawaError('WEBHOOK_SECRET_REUSED', `this webhook secret is already used by ${other}; every Hub needs its own credential`);
    }
  }
  return () => {
    store.destinations[destId] = fp;
    fs.mkdirSync(path.dirname(fpFile()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(fpFile(), JSON.stringify(store, null, 2), { mode: 0o600 });
  };
}
