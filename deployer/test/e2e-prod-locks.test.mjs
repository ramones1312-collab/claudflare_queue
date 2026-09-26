/** INSTALLER E2E · PROD hard locks (2/3): gated on a signed, corroborated STAGING PASS; hard locks; inert deploy; secret non-reuse; cutover refused. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { world, writes, fakeStagingPass, stagingPassed } from './support/e2e-common.mjs';
import { runCli } from './support/cli-harness.mjs';

const prodWrites = (m) => writes(m).filter(j => /-prod/.test(`${j.path} ${j.script || ''} ${j.queue || ''}`));
const HUB_A = 'https://vector-hook.integrademia.com/webhook/' + 'A'.repeat(32);

test('prod-deploy: a halt URL pointing into a Hub domain is refused; nothing deployed', async () => {
  const w = await world();
  try {
    await stagingPassed(w);
    w.sb.dropToken();
    const r = await runCli(w.sb, w.api, ['prod-deploy'], { answers: ['https://status.integrademia.com/x'] });
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /HALT_URL_IS_HUB/);
    assert.equal(prodWrites(w.mock).length, 0);
  } finally { await w.close(); }
});

test('prod-deploy: control-plane port refused; nothing deployed', async () => {
  const w = await world();
  try {
    await stagingPassed(w);
    w.sb.dropToken();
    const r = await runCli(w.sb, w.api, ['prod-deploy'], { answers: ['https://notify.example.org/kawa', 'https://vector-hook.integrademia.com:8180/webhook/' + 'S'.repeat(24)] });
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /HARD_LOCK_CONTROL_PORT/);
    assert.equal(prodWrites(w.mock).filter(j => j.method === 'PUT').length, 0);
  } finally { await w.close(); }
});

