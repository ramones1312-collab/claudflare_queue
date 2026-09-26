/** INSTALLER E2E · add-hub in STAGING: only the new Hub and the ingress change. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { world, writes, fakeStagingPass, PRE_EXISTING, TOKEN } from './support/e2e-common.mjs';
import { runCli } from './support/cli-harness.mjs';

test('add-hub HUB_C (STAGING): only the new Hub and the ingress change; config updated', async () => {
  const w = await world();
  try {
    w.sb.dropToken();
    assert.equal((await runCli(w.sb, w.api, ['install', '--no-gates'])).code, 2);
    const before = writes(w.mock).length;
    w.sb.dropToken();
    const r = await runCli(w.sb, w.api, ['add-hub', 'HUB_C', '--env', 'staging', '--no-check']);
    assert.equal(r.code, 2, r.text);                               // provisioned; isolation check needs real workers.dev
    const after = writes(w.mock).slice(before);
    const touched = [...new Set(after.map(j => j.script || j.queue).filter(Boolean))].sort();
    assert.deepEqual(touched, ['kawa-edge-delivery-hub-c-stg', 'kawa-edge-ingress-stg', 'kawa-signal-buffer-hub-c-dlq-stg',
                               'kawa-signal-buffer-hub-c-stg', 'kawa-staging-receiver-hub-c'].sort());
    const puts = after.filter(j => j.method === 'PUT' && /\/workers\/scripts\/[^/]+$/.test(j.path)).map(j => j.script);
    assert.deepEqual(puts, ['kawa-staging-receiver-hub-c', 'kawa-edge-delivery-hub-c-stg', 'kawa-edge-ingress-stg']);
    assert.deepEqual(w.sb.config().staging.destinations.map(d => d.id), ['HUB_A', 'HUB_B', 'HUB_C']);
    assert.ok(fs.readdirSync(path.dirname(w.sb.configFile)).some(f => f.startsWith('kawa-edge.json.bak-')));
    // Re-running is refused (already configured) and changes nothing.
    const n = writes(w.mock).length;
    w.sb.dropToken();
    const again = await runCli(w.sb, w.api, ['add-hub', 'HUB_C', '--env', 'staging', '--no-check']);
    assert.equal(again.code, 1); assert.match(again.text, /ADD_HUB_EXISTS/);
    assert.equal(writes(w.mock).length, n);
  } finally { await w.close(); }
});
