/** V0.1.1 · core regression: the V0.1 transport contract, unchanged, with the audit running alongside. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { post, waitFor, rows, start, sandbox, dest, mockHub } from './helpers.mjs';
import { auditWorld, auditRows } from './audit-helpers.mjs';

for (const n of [1, 2, 5]) {
  test(`${n} Hub(s) enabled: every Hub receives every signal, in order`, async (t) => {
    const { app, hubs } = await auditWorld(t, Array(n).fill('ok'));
    for (const s of ['o1', 'o2', 'o3']) await post(app, s);
    await waitFor('all delivered', () => hubs.every(h => h.received.length === 3));
    for (const h of hubs) assert.deepEqual(h.received.map(r => r.body.toString()), ['o1', 'o2', 'o3']);
  });
}

test('a disabled destination receives nothing and its secret file is never needed', async (t) => {
  const [a, d] = await Promise.all([mockHub(), mockHub()]);
  const sb = sandbox({ destinations: [dest('HUB_A', a.port), dest('HUB_D', d.port, { enabled: false, webhook_secret_file: 'does_not_exist' })] });
  const app = await start(sb);
  t.after(async () => { await app.stop(); await a.close(); await d.close(); sb.cleanup(); });
  await post(app, 'x');
  await waitFor('HUB_A', () => a.received.length === 1);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(d.received.length, 0);
  assert.equal(auditRows(app, "destination_id = 'HUB_D'").length, 0);
});

test('classification unchanged: 2xx DELIVERED · 400 FAILED_PERMANENT · 408/425/429/5xx/timeout RETRY', async (t) => {
  const modes = [200, 400, 408, 425, 429, 500, 'hang'];
  const { app, ids } = await auditWorld(t, modes, { destExtra: { HUB_G: { timeout_ms: 300 } } });
  await post(app, 'c');
  const want = ['DELIVERED', 'FAILED_PERMANENT', 'RETRY', 'RETRY', 'RETRY', 'RETRY', 'RETRY'];
  await waitFor('classified', () => ids.every((id, i) => rows(app, id)[0]?.status === want[i]));
  assert.equal(rows(app, 'HUB_G')[0].last_error, 'TIMEOUT');
  assert.equal(rows(app, 'HUB_C')[0].last_http_status, 408);
});

test('max_attempts unchanged: after N failed attempts the delivery is FAILED_PERMANENT', async (t) => {
  const { app } = await auditWorld(t, ['down'], { retry: { schedule_seconds: [0.05], max_attempts: 3 } });
  await post(app, 'm');
  await waitFor('FAILED_PERMANENT after 3', () => rows(app, 'HUB_A')[0]?.status === 'FAILED_PERMANENT');
  assert.equal(rows(app, 'HUB_A')[0].attempts, 3);
});

test('HUB_A failure never blocks HUB_B (and vice versa); event_id is monotonic; ACK only after the commit', async (t) => {
  const { app, hubs } = await auditWorld(t, ['down', 'ok']);
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const r = await (await post(app, `m${i}`)).json();
    ids.push(r.event_id);
    assert.ok(app.store.db.prepare('SELECT 1 FROM events WHERE event_id = ?').get(r.event_id), 'the event is already committed when the ACK arrives');
  }
  assert.deepEqual(ids, [1, 2, 3, 4, 5]);
  await waitFor('HUB_B got all 5 while HUB_A is down', () => hubs[1].received.length === 5);
  hubs[0].mode = 'ok'; hubs[1].mode = 'down';
  await post(app, 'm5');
  await waitFor('HUB_A caught up (6) while HUB_B is now down', () => rows(app, 'HUB_A').every(r => r.status === 'DELIVERED') && hubs[0].received.filter(r => r.body.length).map(r => r.body.toString()).slice(-6).join() === 'm0,m1,m2,m3,m4,m5');
});

test('the upgraded V0.1.1 opens a V0.1 dispatcher.db unchanged (additive migration only)', async (t) => {
  const { app, sb } = await auditWorld(t, ['ok']);
  const tables = app.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
  assert.deepEqual(tables, ['audit_events', 'deliveries', 'events']);
  const cols = (tb) => app.store.db.prepare(`PRAGMA table_info(${tb})`).all().map(c => c.name).join(',');
  assert.equal(cols('events'), 'event_id,received_at,method,query,headers,body,remote');
  assert.equal(cols('deliveries'), 'event_id,destination_id,status,attempts,last_attempt_at,next_retry_at,last_http_status,last_error,delivered_at');
});
