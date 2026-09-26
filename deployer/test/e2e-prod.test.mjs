/** INSTALLER E2E · PROD phases: gated on STAGING PASS, hard locks, inert deploy, secret non-reuse, cutover refused. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { world, writes, fakeStagingPass, PRE_EXISTING, TOKEN } from './support/e2e-common.mjs';
import { runCli } from './support/cli-harness.mjs';

test('PROD needs a Cloudflare STAGING PASS for the same Edge code', async () => {
  const w = await world();
  try {
    w.sb.dropToken();
    const r = await runCli(w.sb, w.api, ['prod-deploy']);
    assert.equal(r.code, 2, r.text);
    assert.match(r.text, /no Cloudflare STAGING PASS/);
    assert.equal(writes(w.mock).length, 0);
  } finally { await w.close(); }
});

test('prod-deploy: control-plane port refused; nothing deployed', async () => {
  const w = await world();
  try {
    await fakeStagingPass(w.sb);
    w.sb.dropToken();
    const r = await runCli(w.sb, w.api, ['prod-deploy'], { answers: ['https://notify.example.org/kawa', 'https://vector-hook.integrademia.com:8180/webhook/' + 'S'.repeat(24)] });
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /HARD_LOCK_CONTROL_PORT/);
    assert.equal(w.mock.state.journal.some(j => j.method === 'PUT'), false);
  } finally { await w.close(); }
});

test('prod-deploy: PROD deployed inert with its own names and secrets; STAGING untouched; reuse refused; cutover refused', async () => {
  const w = await world();
  try {
    await fakeStagingPass(w.sb);
    w.sb.dropToken();
    const hubA = 'https://vector-hook.integrademia.com/webhook/' + 'A'.repeat(32);
    const r = await runCli(w.sb, w.api, ['prod-deploy'], { answers: ['https://notify.example.org/kawa', hubA] });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /INERT/);
    assert.equal(r.text.includes('A'.repeat(32)), false, 'webhook secret echoed');
    const puts = w.mock.state.journal.filter(j => j.method === 'PUT' && /\/workers\/scripts\/[^/]+$/.test(j.path)).map(j => j.script);
    assert.deepEqual(puts, ['kawa-edge-ingress-prod', 'kawa-edge-delivery-hub-a-prod']);
    assert.equal(w.mock.state.secretValues.get('kawa-edge-delivery-hub-a-prod/DEST_HUB_A_WEBHOOK_URL'), hubA);
    const created = w.mock.state.journal.filter(j => j.method === 'POST' && j.path.endsWith('/queues')).map(j => j.queue).sort();
    assert.deepEqual(created, ['kawa-signal-buffer-hub-a-dlq-prod', 'kawa-signal-buffer-hub-a-prod']);
    assert.equal(w.mock.state.journal.some(j => j.method !== 'GET' && /-stg|staging-receiver/.test(`${j.path} ${j.script || ''} ${j.queue || ''}`)), false, 'STAGING touched by a PROD run');
    assert.equal(w.sb.persisted().includes('A'.repeat(32)), false, 'webhook secret persisted');
    const bindings = w.mock.state.journal.find(j => j.script === 'kawa-edge-delivery-hub-a-prod' && j.binding_names).binding_names;
    assert.equal(bindings.some(b => /HUB_B|FETCHER|service/.test(b)), false, bindings.join(','));

    // Idempotent: a second prod-deploy asks for nothing and redeploys nothing.
    const n = writes(w.mock).length;
    w.sb.dropToken();
    const again = await runCli(w.sb, w.api, ['prod-deploy']);
    assert.equal(again.code, 0, again.text);
    assert.equal(writes(w.mock).length, n, 'second prod-deploy must not write');

    // HUB_B may never reuse HUB_A's credential, even on another host; HUB_A's consumer is not touched.
    w.sb.dropToken();
    const r2 = await runCli(w.sb, w.api, ['add-hub', 'HUB_B', '--env', 'prod', '--webhook-host', 'hub-b.example.com'],
                            { answers: ['https://hub-b.example.com/webhook/' + 'A'.repeat(32)] });
    assert.equal(r2.code, 1, r2.text);
    assert.match(r2.text, /WEBHOOK_SECRET_REUSED/);
    assert.equal(w.mock.state.journal.some(j => j.method === 'PUT' && j.script === 'kawa-edge-delivery-hub-b-prod'), false);

    // With its own credential it is added, and HUB_A's PROD consumer is left exactly as it was.
    const m = writes(w.mock).length;
    w.sb.dropToken();
    const r3 = await runCli(w.sb, w.api, ['add-hub', 'HUB_B', '--env', 'prod', '--webhook-host', 'hub-b.example.com'],
                            { answers: ['https://hub-b.example.com/webhook/' + 'B'.repeat(32)] });
    assert.equal(r3.code, 0, r3.text);
    const added = writes(w.mock).slice(m);
    assert.equal(added.some(j => j.script === 'kawa-edge-delivery-hub-a-prod'), false, 'HUB_A consumer touched by add-hub HUB_B');
    assert.deepEqual(added.filter(j => j.method === 'PUT' && /\/workers\/scripts\/[^/]+$/.test(j.path)).map(j => j.script),
                     ['kawa-edge-delivery-hub-b-prod', 'kawa-edge-ingress-prod']);

    // cutover-check: blocked by B-1 and B-2, whatever else is green; cutover refuses.
    w.sb.dropToken();
    const c = await runCli(w.sb, w.api, ['cutover-check']);
    assert.equal(c.code, 2, c.text);
    assert.match(c.text, /C3\s+BLOCKED/); assert.match(c.text, /C4\s+BLOCKED/);
    w.sb.dropToken();
    const cut = await runCli(w.sb, w.api, ['cutover']);
    assert.equal(cut.code, 2);
    assert.match(cut.text, /Cutover refused/);
    assert.equal(w.mock.state.secretValues.has('kawa-edge-ingress-prod/WEBHOOK_PATH_TOKEN'), true);
  } finally { await w.close(); }
});
