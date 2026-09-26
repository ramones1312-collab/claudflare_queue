/** INSTALLER E2E · fail closed: a conflict or a permission problem stops the run before ANY write. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { world, writes, fakeStagingPass, PRE_EXISTING, TOKEN } from './support/e2e-common.mjs';
import { runCli } from './support/cli-harness.mjs';

for (const [name, opts, code, re] of [
  ['a foreign Worker with an Edge name', { scripts: [{ name: 'kawa-edge-ingress-stg' }] }, 'RESOURCE_CONFLICT', /NOT created by this deployer/],
  ['a queue consumed by a foreign Worker', { queues: [{ name: 'kawa-signal-buffer-hub-a-stg', consumers: [{ script: 'someone-else', type: 'worker' }] }] }, 'RESOURCE_CONFLICT', /foreign Workers/],
  ['a paused queue', { queues: [{ name: 'kawa-signal-buffer-hub-b-stg', paused: true }] }, 'RESOURCE_CONFLICT', /PAUSED/],
  ['no workers.dev subdomain', { subdomain: null }, 'NO_WORKERS_SUBDOMAIN', /workers\.dev subdomain/],
  ['an inactive token', { tokenStatus: 'expired' }, 'TOKEN_NOT_ACTIVE', /status is "expired"/],
  // F-08 · the listing is not trusted to prove absence: a per-name lookup finds it.
  ['a foreign Worker the listing does not show', { scripts: [{ name: 'kawa-edge-ingress-stg' }], hideFromList: ['kawa-edge-ingress-stg'] }, 'RESOURCE_CONFLICT', /NOT created by this deployer/],
  // F-09 · a short page is not the end: the conflicting queue is on page 4 of 2-per-page.
  ['a foreign-consumed queue on a later page', { pageSize: 2, queues: [
    ...['aaa-1', 'aaa-2', 'aaa-3', 'aaa-4', 'aaa-5'].map(name => ({ name })),
    ...PRE_EXISTING.map(name => ({ name, consumers: name === 'kawa-signal-buffer-hub-b-dlq-stg' ? [{ script: 'someone-else', type: 'worker' }] : [] })),
  ] }, 'RESOURCE_CONFLICT', /foreign Workers/],
]) {
  test(`fail closed, zero writes: ${name}`, async () => {
    const w = await world(opts);
    try {
      w.sb.dropToken();
      const r = await runCli(w.sb, w.api, ['install', '--no-gates']);
      assert.equal(r.code, 1, r.text);
      assert.match(r.text, new RegExp(code));
      assert.match(r.text, re);
      assert.equal(writes(w.mock).length, 0, JSON.stringify(writes(w.mock)));
    } finally { await w.close(); }
  });
}

test('missing Queues:Edit permission is named precisely', async () => {
  const w = await world({ queues: [], denyWrite: ['queues'] });
  try {
    w.sb.dropToken();
    const r = await runCli(w.sb, w.api, ['install', '--no-gates']);
    assert.equal(r.code, 1);
    assert.match(r.text, /Account · Queues · Edit/);
    assert.equal(w.mock.state.journal.some(j => j.method === 'PUT'), false, 'no Worker deployed');
  } finally { await w.close(); }
});

test('a wrong token is refused before anything else', async () => {
  const w = await world();
  try {
    w.sb.dropToken('wrongTokenValue_' + 'z'.repeat(30));
    const r = await runCli(w.sb, w.api, ['install', '--no-gates']);
    assert.equal(r.code, 1);
    assert.match(r.text, /TOKEN_INVALID/);
    assert.equal(writes(w.mock).length, 0);
  } finally { await w.close(); }
});
