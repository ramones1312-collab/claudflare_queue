/**
 * INSTALLER E2E · the real CLI and the PINNED wrangler against the mock Cloudflare API.
 * Starts from the user's real state: the four STAGING queues already exist, no Worker exists.
 * No network egress, no Cloudflare account, no secrets from anywhere but the sandbox.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createMockCloudflare } from './mock-cloudflare.mjs';
import { sandbox, runCli } from './cli-harness.mjs';

export const ACCOUNT = '0123456789abcdef0123456789abcdef';
export const TOKEN = 'e2eTokenValue_' + 'k'.repeat(30);
export const PRE_EXISTING = ['kawa-signal-buffer-hub-a-stg', 'kawa-signal-buffer-hub-a-dlq-stg', 'kawa-signal-buffer-hub-b-stg', 'kawa-signal-buffer-hub-b-dlq-stg'];
export const writes = (m) => m.state.journal.filter(j => j.method !== 'GET' && !j.path.endsWith('/tokens/verify'));

export async function world(opts = {}) {
  const mock = createMockCloudflare({ accountId: ACCOUNT, token: TOKEN, queues: PRE_EXISTING.map(name => ({ name })), ...opts });
  const api = await mock.listen();
  const sb = sandbox({ accountId: ACCOUNT, token: TOKEN, mutate: opts.mutate });
  return { mock, api, sb, async close() { await mock.close(); sb.cleanup(); } };
}


/**
 * A STAGING PASS exactly as `install` would record it, SIGNED with the sandbox's own evidence key and
 * listing the builds that STAGING really runs in the mock (so live corroboration can succeed).
 * `tamper` lets a test break one property at a time.
 */
export async function fakeStagingPass(sb, mock, tamper = {}) {
  const crypto = await import('node:crypto');
  const { canonical, bindingHash } = await import('../../lib/evidence.mjs');
  const { pinnedVersion } = await import('../../lib/wrangler.mjs');
  const { CLOUD_GATE_IDS } = await import('../../lib/gates/run.mjs');
  const { runtimeDestinations } = await import('../../lib/config.mjs');
  const cfg = sb.config();
  const builds = {};
  for (const [name, s] of mock.state.scripts) {
    if (!/-stg$|^kawa-staging-receiver-/.test(name)) continue;
    const b = (s.bindings || []).find(x => x.name === 'KAWA_EDGE_BUILD');
    if (b) builds[name] = b.text;
  }
  const gates = CLOUD_GATE_IDS.map(id => ({ id, status: id === tamper.skip ? 'SKIPPED' : 'PASS',
    evidence: id === 'G' ? { dlq: { verified: !tamper.dlqUnverified } } : id === 'K' ? { dispatch_attempts: tamper.noRedispatch ? 1 : 2 } : {} }));
  const ev = { result: 'PASS', target: 'cloud', cleanup_errors: tamper.cleanup ? ['resume failed'] : [],
    binding_sha256: tamper.binding || bindingHash(pinnedVersion()), account_id: tamper.account || cfg.cloudflare.account_id,
    destinations_config: runtimeDestinations(tamper.destinations || cfg.staging.destinations),
    builds: tamper.builds || builds, gates, mandatory_gates: tamper.mandatory || CLOUD_GATE_IDS };
  const keyFile = path.join(sb.stateDir, '.evidence-key');
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  const signed = tamper.unsigned ? ev : { ...ev, signature: { alg: 'HMAC-SHA256', key_id: 'test',
    value: crypto.createHmac('sha256', key).update(canonical(ev)).digest('hex') } };
  const dir = path.join(sb.stateDir, 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'staging-gates-cloud-2026-09-26T00-00-00-000Z-PASS.json'), JSON.stringify(signed));
}

/** STAGING deployed in the mock (what a real install leaves), then a signed PASS for it. */
export async function stagingPassed(w, tamper = {}) {
  const { runCli } = await import('./cli-harness.mjs');
  w.sb.dropToken();
  const r = await runCli(w.sb, w.api, ['install', '--no-gates']);
  if (r.code !== 2) throw new Error('staging install failed: ' + r.text.slice(-500));
  await fakeStagingPass(w.sb, w.mock, tamper);
}
