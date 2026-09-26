/** INSTALLER E2E · PROD gate (1/3): gated on a signed, corroborated STAGING PASS; hard locks; inert deploy; secret non-reuse; cutover refused. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { world, writes, fakeStagingPass, stagingPassed } from './support/e2e-common.mjs';
import { runCli } from './support/cli-harness.mjs';

const prodWrites = (m) => writes(m).filter(j => /-prod/.test(`${j.path} ${j.script || ''} ${j.queue || ''}`));
const HUB_A = 'https://vector-hook.integrademia.com/webhook/' + 'A'.repeat(32);

test('PROD needs a STAGING PASS: none, or any tampered/insufficient one, is BLOCKED with zero PROD writes', async () => {
  const w = await world();
  try {
    w.sb.dropToken();
    let r = await runCli(w.sb, w.api, ['prod-deploy']);
    assert.equal(r.code, 2, r.text);
    assert.equal(writes(w.mock).length, 0);
    await stagingPassed(w, { unsigned: true });                  // deploys STAGING in the mock
    const cases = [
      ['hand-written (unsigned)', { unsigned: true }],
      ['--quick run (K skipped)', { skip: 'K' }],
      ['file declares a shorter gate list', { skip: 'ISO-X', mandatory: ['A'] }],
      ['cleanup errors', { cleanup: true }],
      ['DLQ not platform-verified', { dlqUnverified: true }],
      ['no redispatch proven by K', { noRedispatch: true }],
      ['other build', { binding: 'f'.repeat(64) }],
      ['other account', { account: 'f'.repeat(32) }],
      ['PROD HUB_A settings never tested', { destinations: [{ id: 'HUB_A', enabled: true, timeout_ms: 20000 }, { id: 'HUB_B', enabled: true, timeout_ms: 10000 }] }],
      ['STAGING no longer runs the certified builds', { builds: { 'kawa-edge-ingress-stg': 'e'.repeat(64) } }],
    ];
    for (const [name, tamper] of cases) {
      await fakeStagingPass(w.sb, w.mock, tamper);
      w.sb.dropToken();
      r = await runCli(w.sb, w.api, ['prod-deploy']);
      assert.equal(r.code, 2, `${name}: ${r.text}`);
      assert.equal(prodWrites(w.mock).length, 0, `${name}: wrote to PROD`);
    }
    fs.writeFileSync(path.join(w.sb.stateDir, 'evidence', 'staging-gates-cloud-2026-09-27T00-00-00-000Z-PASS.json'), '{corrupt');
    w.sb.dropToken();
    r = await runCli(w.sb, w.api, ['prod-deploy']);
    assert.equal(r.code, 2, 'a corrupt evidence file must not crash the gate');
  } finally { await w.close(); }
});

test('add-hub --env prod is gated exactly like prod-deploy (F-03)', async () => {
  const w = await world();
  try {
    w.sb.dropToken();
    assert.equal((await runCli(w.sb, w.api, ['install', '--no-gates'])).code, 2);
    w.sb.dropToken();
    const r = await runCli(w.sb, w.api, ['add-hub', 'HUB_B', '--env', 'prod', '--webhook-host', 'hub-b.example.com']);
    assert.equal(r.code, 2, r.text);
    assert.equal(prodWrites(w.mock).length, 0);
    await fakeStagingPass(w.sb, w.mock);
    w.sb.dropToken();
    const z = await runCli(w.sb, w.api, ['add-hub', 'HUB_Z', '--env', 'prod', '--webhook-host', 'hub-z.example.com']);
    assert.equal(z.code, 2, z.text);
    assert.match(z.text, /HUB_Z was never gate-tested in STAGING/);
    assert.equal(prodWrites(w.mock).length, 0);
  } finally { await w.close(); }
});

