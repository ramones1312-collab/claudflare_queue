/**
 * The safety logic around the STAGING gates, without Cloudflare: outcome of a run (PASS / PARTIAL /
 * FAIL / FAIL on cleanup error / CLOUD_ONLY), the deployment-id proof used by gate L, the backlog
 * metric (a GraphQL permission error is UNKNOWN, never 0) and line-buffered redaction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGates } from '../lib/gates/run.mjs';
import { createCfApi } from '../lib/cfapi.mjs';
import { lineSink } from '../lib/wrangler.mjs';
import { redact, registerSecret } from '../lib/log.mjs';
import { createMockCloudflare } from './support/mock-cloudflare.mjs';

const secrets = { WEBHOOK_PATH_TOKEN: 'p'.repeat(20), ADMIN_TOKEN: 'a'.repeat(20), CONTROL_TOKEN: { HUB_A: 'c'.repeat(20), HUB_B: 'd'.repeat(20) } };
function fakeTarget(kind, { resumeFails = false } = {}) {
  const calls = [];
  return {
    kind, calls,
    base: { ingress: 'http://i', admin: 'http://adm', receiver: (id) => `http://r-${id}` },
    fetch: async (u) => { calls.push(`fetch ${u}`); return new Response(JSON.stringify({ ok: true }), { status: 200 }); },
    pause: async (q) => { calls.push(`pause ${q}`); },
    resume: async (q) => { calls.push(`resume ${q}`); if (resumeFails) throw new Error('resume refused'); },
  };
}
const ok = (id, extra = {}) => ({ id, title: id, run: async () => ({ ok: true }), ...extra });
const bad = (id) => ({ id, title: id, run: async () => { throw new Error('assertion failed'); } });
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kawa-runner-'));
const run = (target, gatesOverride) => runGates({ target, secrets, dests: ['HUB_A', 'HUB_B'], evidenceDir: dir(), gatesOverride });

test('all gates pass -> PASS, and cleanup resumes both queues', async () => {
  const t = fakeTarget('cloud');
  const g = await run(t, [ok('A'), ok('B')]);
  assert.equal(g.result, 'PASS');
  assert.ok(t.calls.includes('resume kawa-signal-buffer-hub-a-stg') && t.calls.includes('resume kawa-signal-buffer-hub-b-stg'));
});

test('a skipped (--quick) gate makes the cloud run PARTIAL, never PASS', async () => {
  const g = await run(fakeTarget('cloud'), [ok('A'), ok('K', { optional: true, cloudOnly: true })]);
  assert.equal(g.result, 'PARTIAL');
  assert.equal(g.report.gates.find(x => x.id === 'K').status, 'SKIPPED');
});

test('first failure stops the run; later gates are NOT_RUN; result FAIL', async () => {
  const g = await run(fakeTarget('cloud'), [ok('A'), bad('B'), ok('C')]);
  assert.equal(g.result, 'FAIL');
  assert.deepEqual(g.report.gates.map(x => x.status), ['PASS', 'FAIL', 'NOT_RUN']);
});

test('a cleanup failure turns an otherwise green run into FAIL', async () => {
  const g = await run(fakeTarget('cloud', { resumeFails: true }), [ok('A')]);
  assert.equal(g.result, 'FAIL');
  assert.ok(g.report.cleanup_errors.length >= 1);
});

test('local rehearsal marks platform gates CLOUD_ONLY and does not claim them', async () => {
  const g = await run(fakeTarget('local'), [ok('A'), ok('L', { cloudOnly: true })]);
  assert.equal(g.result, 'PASS');
  assert.equal(g.report.gates.find(x => x.id === 'L').status, 'CLOUD_ONLY');
  assert.deepEqual(g.report.mandatory_gates, ['A']);
});

test('gate L proof: the latest deployment id changes on every deploy; unknown script -> null', async () => {
  const mock = createMockCloudflare({ token: 'tok_' + 'x'.repeat(30), accountId: '0'.repeat(32), scripts: [] });
  const base = await mock.listen();
  try {
    const api = createCfApi({ token: 'tok_' + 'x'.repeat(30), accountId: '0'.repeat(32), base });
    assert.equal(await api.latestDeploymentId('kawa-edge-ingress-stg'), null);
    mock.state.scripts.set('kawa-edge-ingress-stg', { name: 'kawa-edge-ingress-stg', bindings: [], secrets: new Set(),
      deployments: [{ id: 'd1', created_on: '2026-09-26T00:00:00Z' }, { id: 'd2', created_on: '2026-09-26T00:01:00Z' }] });
    assert.equal(await api.latestDeploymentId('kawa-edge-ingress-stg'), 'd2');
  } finally { await mock.close(); }
});

test('queue backlog: a GraphQL permission error is UNKNOWN (null), not 0; rows are read', async () => {
  const mock = createMockCloudflare({ token: 'tok_' + 'x'.repeat(30), accountId: '0'.repeat(32) });
  const base = await mock.listen();
  try {
    const api = createCfApi({ token: 'tok_' + 'x'.repeat(30), accountId: '0'.repeat(32), base });
    assert.equal(await api.queueBacklog('q1'), null);
    mock.state.analytics = [{ avg: { messages: 3 } }];
    assert.equal(await api.queueBacklog('q1'), 3);
    mock.state.analytics = [];
    assert.equal(await api.queueBacklog('q1'), 0);
  } finally { await mock.close(); }
});

test('a secret split across two output chunks is still redacted as a whole', () => {
  const secret = registerSecret('split-secret-VALUE-1234567890');
  const lines = [];
  const sink = lineSink(l => lines.push(redact(l)));
  sink.push('prefix split-secret-VAL'); sink.push('UE-1234567890 suffix\nnext line'); sink.flush();
  assert.deepEqual(lines, ['prefix [REDACTED] suffix', 'next line']);
  assert.equal(lines.join('').includes(secret.slice(0, 10)), false);
});
