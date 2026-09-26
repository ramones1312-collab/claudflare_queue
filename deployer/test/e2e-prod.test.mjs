/** INSTALLER E2E · PROD flow (3/3): gated on a signed, corroborated STAGING PASS; hard locks; inert deploy; secret non-reuse; cutover refused. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { world, writes, fakeStagingPass, stagingPassed } from './support/e2e-common.mjs';
import { runCli } from './support/cli-harness.mjs';

const prodWrites = (m) => writes(m).filter(j => /-prod/.test(`${j.path} ${j.script || ''} ${j.queue || ''}`));
const HUB_A = 'https://vector-hook.integrademia.com/webhook/' + 'A'.repeat(32);

test('prod-deploy: inert PROD with own names/secrets; idempotent; halt change needs confirmation and keeps the path token; reuse refused; HUB_A untouched by add-hub; cutover refused', async () => {
  const w = await world();
  try {
    await stagingPassed(w);
    const stgWrites = writes(w.mock).length;
    w.sb.dropToken();
    const r = await runCli(w.sb, w.api, ['prod-deploy'], { answers: ['https://notify.example.org/kawa', HUB_A] });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /INERT/);
    assert.match(r.text, /corroborated on Cloudflare/);
    assert.equal(r.text.includes('A'.repeat(32)), false, 'webhook secret echoed');
    const after = writes(w.mock).slice(stgWrites);
    assert.equal(after.some(j => /-stg|staging-receiver/.test(`${j.path} ${j.script || ''} ${j.queue || ''}`)), false, 'STAGING touched by a PROD run');
    assert.deepEqual(after.filter(j => j.method === 'PUT' && /\/workers\/scripts\/[^/]+$/.test(j.path)).map(j => j.script), ['kawa-edge-ingress-prod', 'kawa-edge-delivery-hub-a-prod']);
    assert.equal(w.mock.state.secretValues.get('kawa-edge-delivery-hub-a-prod/DEST_HUB_A_WEBHOOK_URL'), HUB_A);
    assert.equal(w.sb.persisted().includes('A'.repeat(32)), false, 'webhook secret persisted');
    const bindings = w.mock.state.journal.find(j => j.script === 'kawa-edge-delivery-hub-a-prod' && j.binding_names).binding_names;
    assert.equal(bindings.some(b => /HUB_B|FETCHER|service/.test(b)), false, bindings.join(','));

    let n = writes(w.mock).length;
    w.sb.dropToken();
    assert.equal((await runCli(w.sb, w.api, ['prod-deploy'])).code, 0);
    assert.equal(writes(w.mock).length, n, 'second prod-deploy must not write');

    // Redeploying the PROD ingress needs the typed confirmation (F-10) and never rotates the path token.
    const tok0 = w.mock.state.secretValues.get('kawa-edge-ingress-prod/WEBHOOK_PATH_TOKEN');
    w.sb.dropToken();
    const refused = await runCli(w.sb, w.api, ['prod-deploy', '--set-halt-notify'], { answers: ['https://other-collector.example.org/kawa', 'no'] });
    assert.equal(refused.code, 1, refused.text);
    assert.match(refused.text, /INGRESS_REDEPLOY_NOT_CONFIRMED/);
    w.sb.dropToken();
    const hn = await runCli(w.sb, w.api, ['prod-deploy', '--set-halt-notify'], { answers: ['https://other-collector.example.org/kawa', 'REDEPLOY PROD INGRESS'] });
    assert.equal(hn.code, 0, hn.text);
    assert.equal(w.mock.state.secretValues.get('kawa-edge-ingress-prod/HALT_NOTIFY_URL'), 'https://other-collector.example.org/kawa');
    assert.equal(w.mock.state.secretValues.get('kawa-edge-ingress-prod/WEBHOOK_PATH_TOKEN'), tok0, 'path token rotated');
    assert.equal(fs.readFileSync(path.join(w.sb.stateDir, 'prod', 'deployed.json'), 'utf8').includes('"secrets_fp": "'), false, 'PROD secret digest persisted');

    // HUB_B may never reuse HUB_A's credential (also not %-encoded); with its own it is added and HUB_A's consumer is untouched.
    for (const reuse of ['https://hub-b.example.com/webhook/' + 'A'.repeat(32), 'https://hub-b.example.com/webhook/%41' + 'A'.repeat(31)]) {
      w.sb.dropToken();
      const r2 = await runCli(w.sb, w.api, ['add-hub', 'HUB_B', '--env', 'prod', '--webhook-host', 'hub-b.example.com'], { answers: ['REDEPLOY PROD INGRESS', reuse] });
      assert.equal(r2.code, 1, r2.text);
      assert.match(r2.text, /WEBHOOK_SECRET_REUSED|WEBHOOK_URL_PATH/);
    }
    assert.equal(w.mock.state.journal.some(j => j.method === 'PUT' && j.script === 'kawa-edge-delivery-hub-b-prod'), false);
    n = writes(w.mock).length;
    w.sb.dropToken();
    const r3 = await runCli(w.sb, w.api, ['add-hub', 'HUB_B', '--env', 'prod', '--webhook-host', 'hub-b.example.com'], { answers: ['REDEPLOY PROD INGRESS', 'https://hub-b.example.com/webhook/' + 'B'.repeat(32)] });
    assert.equal(r3.code, 0, r3.text);
    const added = writes(w.mock).slice(n);
    assert.equal(added.some(j => j.script === 'kawa-edge-delivery-hub-a-prod'), false, 'HUB_A consumer touched by add-hub HUB_B');
    assert.deepEqual(added.filter(j => j.method === 'PUT' && /\/workers\/scripts\/[^/]+$/.test(j.path)).map(j => j.script), ['kawa-edge-delivery-hub-b-prod', 'kawa-edge-ingress-prod']);

    w.sb.dropToken();
    const c = await runCli(w.sb, w.api, ['cutover-check']);
    assert.equal(c.code, 2, c.text);
    assert.match(c.text, /C3\s+BLOCKED/); assert.match(c.text, /C4\s+BLOCKED/);
    // R3-07 · one route-switch procedure: cutover-check (C9) and rollback-transport print the same steps.
    const { ROUTE_SWITCH_PROCEDURE } = await import('../lib/prod.mjs');
    assert.match(c.text, /C9\s+MANUAL/);
    const rb = await runCli(w.sb, w.api, ['rollback-transport']);
    assert.equal(rb.code, 0, rb.text);
    for (const l of ROUTE_SWITCH_PROCEDURE) { assert.ok(c.text.includes(l), `cutover-check lacks: ${l}`); assert.ok(rb.text.includes(l), `rollback-transport lacks: ${l}`); }
    assert.doesNotMatch(rb.text, /Leave the PROD Edge running/, 'the contradictory R3 rollback step is gone');
    w.sb.dropToken();
    const cut = await runCli(w.sb, w.api, ['cutover']);
    assert.equal(cut.code, 2);
    assert.match(cut.text, /Cutover refused/);
  } finally { await w.close(); }
});
