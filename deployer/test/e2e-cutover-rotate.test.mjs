/**
 * F-13 · the success path of `cutover` (rotate the PROD path token) is unreachable while B-1/B-2
 * stand, so it is exercised directly: real pinned wrangler against the mock API.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rot-'));
for (const [k, d] of [['KAWA_STATE', 'state'], ['KAWA_RUNTIME', 'rt'], ['KAWA_BUILD', 'build']]) process.env[k] = path.join(dir, d);
const { createMockCloudflare } = await import('./support/mock-cloudflare.mjs');
const { rotateProdPathToken } = await import('../lib/prod.mjs');
const { createCfApi } = await import('../lib/cfapi.mjs');
const { createWrangler } = await import('../lib/wrangler.mjs');
const { validateConfig } = await import('../lib/config.mjs');
const { ROOT } = await import('../lib/paths.mjs');

test('rotateProdPathToken writes the config, redeploys the PROD ingress with a NEW token only, returns its URL', async () => {
  const token = 'rotToken_' + 'r'.repeat(30), accountId = '0123456789abcdef0123456789abcdef';
  const mock = createMockCloudflare({ token, accountId, scripts: [{ name: 'kawa-edge-ingress-prod', bindings: [
    { type: 'plain_text', name: 'KAWA_EDGE_MANAGED', text: 'kawa-edge-nas:prod:ingress' }] }] });
  const base = await mock.listen();
  process.env.CLOUDFLARE_API_BASE_URL = base;
  try {
    const s = mock.state.scripts.get('kawa-edge-ingress-prod');
    s.secrets.add('HALT_NOTIFY_URL'); s.secrets.add('WEBHOOK_PATH_TOKEN');
    mock.state.secretValues.set('kawa-edge-ingress-prod/WEBHOOK_PATH_TOKEN', 'old-token-value');
    mock.state.secretValues.set('kawa-edge-ingress-prod/HALT_NOTIFY_URL', 'https://n.example.org/x');
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'kawa-edge.example.json'), 'utf8'));
    raw.cloudflare.account_id = accountId;
    const cfg = await validateConfig(raw);
    const cloud = { api: createCfApi({ token, accountId, base }), wrangler: createWrangler({ token, accountId, quiet: true }) };
    const { url, token: newTok } = await rotateProdPathToken(cfg, cloud);
    assert.equal(url, `https://kawa-edge-ingress-prod.kawa-mock.workers.dev/webhook/${newTok}`);
    assert.equal(mock.state.secretValues.get('kawa-edge-ingress-prod/WEBHOOK_PATH_TOKEN'), newTok);
    assert.notEqual(newTok, 'old-token-value');
    assert.equal(mock.state.secretValues.get('kawa-edge-ingress-prod/HALT_NOTIFY_URL'), 'https://n.example.org/x', 'other secrets untouched');
    const puts = mock.state.journal.filter(j => j.method === 'PUT' && /\/workers\/scripts\/[^/]+$/.test(j.path));
    assert.deepEqual(puts.map(j => [j.script, j.secret_names]), [['kawa-edge-ingress-prod', ['WEBHOOK_PATH_TOKEN']]]);
  } finally { await mock.close(); delete process.env.CLOUDFLARE_API_BASE_URL; }
});
