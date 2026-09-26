/** INSTALLER E2E · staging-teardown: managed STAGING Workers only, dependents first. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { world, writes, fakeStagingPass, PRE_EXISTING, TOKEN } from './support/e2e-common.mjs';
import { runCli } from './support/cli-harness.mjs';

test('staging-teardown deletes only managed STAGING Workers, dependents first', async () => {
  const w = await world();
  try {
    w.sb.dropToken();
    assert.equal((await runCli(w.sb, w.api, ['install', '--no-gates'])).code, 2);
    w.sb.dropToken();
    const r = await runCli(w.sb, w.api, ['staging-teardown', '--yes=DELETE-STAGING']);
    assert.equal(r.code, 0, r.text);
    const dels = w.mock.state.journal.filter(j => j.method === 'DELETE' && j.script).map(j => j.script);
    assert.deepEqual(dels, ['kawa-edge-delivery-hub-a-stg', 'kawa-edge-delivery-hub-b-stg', 'kawa-edge-admin-stg',
                            'kawa-edge-ingress-stg', 'kawa-staging-receiver-hub-a', 'kawa-staging-receiver-hub-b']);
    assert.equal(w.mock.state.journal.some(j => j.method === 'DELETE' && (j.dependents || []).length), false, 'deleted something still referenced');
    assert.equal(fs.existsSync(path.join(w.sb.stateDir, 'staging', 'secrets.json')), false);
    assert.equal(w.mock.state.queues.size, 4, 'queues kept without --queues');
  } finally { await w.close(); }
});
