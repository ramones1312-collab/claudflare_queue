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


export async function fakeStagingPass(sb, { skip = null } = {}) {
  // Evidence as `install` writes it after a Cloudflare STAGING PASS (only the fields prod-deploy reads).
  const { stagingBindingHash } = await import('../../lib/render.mjs');
  const { EDGE_DIR } = await import('../../lib/paths.mjs');
  const { pinnedVersion } = await import('../../lib/wrangler.mjs');
  const ids = ['G00', 'A', 'C', 'E', 'D', 'F', 'M', 'ISO-X', 'ISO-Y', 'ISO-XY', 'G', 'H', 'I', 'J', 'L', 'K', 'BYTE', 'RB'];
  const dir = path.join(sb.stateDir, 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'staging-gates-cloud-2026-09-26T00-00-00-000Z-PASS.json'),
    JSON.stringify({ result: 'PASS', target: 'cloud', binding_sha256: stagingBindingHash(EDGE_DIR, pinnedVersion()), mandatory_gates: ids, gates: ids.map(id => ({ id, status: id === skip ? 'SKIPPED' : 'PASS' })) }));
}
