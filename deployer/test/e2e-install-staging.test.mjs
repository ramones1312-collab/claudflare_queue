/** INSTALLER E2E (real CLI + pinned wrangler vs mock Cloudflare API) · install from the user's real starting state. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { world, writes, fakeStagingPass, PRE_EXISTING, TOKEN } from './support/e2e-common.mjs';
import { runCli } from './support/cli-harness.mjs';

test('install from the real starting state: reuses the 4 queues, deploys in dependency order, keeps secrets out of disk', async () => {
  const w = await world();
  try {
    w.sb.dropToken();
    const r = await runCli(w.sb, w.api, ['install', '--no-gates']);
    assert.equal(r.code, 2, r.text);                               // BLOCKED: deployed, but no gates => no STAGING PASS
    assert.match(r.text, /STAGING deployed; gates NOT run/);
    assert.equal(fs.existsSync(w.sb.tokenFile), false, 'consume-once token file must be gone');
    assert.equal(w.mock.state.journal.filter(j => j.method === 'POST' && j.path.endsWith('/queues')).length, 0, 'no queue created');
    for (const q of PRE_EXISTING) assert.match(r.text, new RegExp(`queue reused: ${q}`));
    const deploys = w.mock.state.journal.filter(j => j.method === 'PUT' && /\/workers\/scripts\/[^/]+$/.test(j.path)).map(j => j.script);
    assert.deepEqual(deploys, ['kawa-staging-receiver-hub-a', 'kawa-staging-receiver-hub-b', 'kawa-edge-ingress-stg',
      'kawa-edge-delivery-hub-a-stg', 'kawa-edge-delivery-hub-b-stg', 'kawa-edge-admin-stg']);
    // Secrets: each Worker got exactly its own, by NAME; consumers got none in STAGING.
    const byScript = Object.fromEntries(w.mock.state.journal.filter(j => j.secret_names).map(j => [j.script, j.secret_names.sort()]));
    assert.deepEqual(byScript['kawa-edge-ingress-stg'], ['HALT_NOTIFY_URL', 'WEBHOOK_PATH_TOKEN']);
    assert.deepEqual(byScript['kawa-staging-receiver-hub-a'], ['CONTROL_TOKEN']);
    assert.deepEqual(byScript['kawa-edge-admin-stg'], ['ADMIN_TOKEN']);
    assert.equal((byScript['kawa-edge-delivery-hub-a-stg'] || []).length, 0);
    // Receivers are distinct per destination and differ in CONTROL_TOKEN.
    assert.notEqual(w.mock.state.secretValues.get('kawa-staging-receiver-hub-a/CONTROL_TOKEN'), w.mock.state.secretValues.get('kawa-staging-receiver-hub-b/CONTROL_TOKEN'));
    // The API token never lands on disk or in output.
    assert.equal(w.sb.persisted().includes(TOKEN), false);
    assert.equal(r.text.includes(TOKEN), false);
    // Generated secret values never appear in logs/reports (the 0600 staging store is the only place).
    const persistedNoStore = w.sb.persisted().replace(fs.readFileSync(path.join(w.sb.stateDir, 'staging', 'secrets.json'), 'utf8'), '');
    for (const [k, v] of w.mock.state.secretValues) if (!k.endsWith('HALT_NOTIFY_URL')) assert.equal(persistedNoStore.includes(v) || r.text.includes(v), false, k);
    assert.equal((fs.statSync(path.join(w.sb.stateDir, 'staging', 'secrets.json')).mode & 0o777), 0o600);
    // Nothing PROD was touched.
    assert.equal(w.mock.state.journal.some(j => /-prod/.test(j.path) || /-prod/.test(j.script || '')), false);

    // Idempotency: a second run changes nothing.
    const before = writes(w.mock).length;
    w.sb.dropToken();
    const r2 = await runCli(w.sb, w.api, ['install', '--no-gates']);
    assert.equal(r2.code, 2, r2.text);
    assert.equal(writes(w.mock).length, before, 'second run must not write anything');
    assert.equal((r2.text.match(/unchanged, not redeployed/g) || []).length, 6);
  } finally { await w.close(); }
});

test('fresh account: creates the missing queues before any Worker', async () => {
  const w = await world({ queues: [] });
  try {
    w.sb.dropToken();
    const r = await runCli(w.sb, w.api, ['install', '--no-gates']);
    assert.equal(r.code, 2, r.text);
    const created = w.mock.state.journal.filter(j => j.method === 'POST' && j.path.endsWith('/queues')).map(j => j.queue);
    assert.deepEqual(created.sort(), [...PRE_EXISTING].sort());
    const firstPut = w.mock.state.journal.findIndex(j => j.method === 'PUT');
    const lastQueue = w.mock.state.journal.map(j => j.method === 'POST' && j.path.endsWith('/queues')).lastIndexOf(true);
    assert.ok(lastQueue < firstPut);
  } finally { await w.close(); }
});
