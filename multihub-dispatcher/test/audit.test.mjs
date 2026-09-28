/** V0.1.1 · every accepted event and every delivery attempt is traceable; the audit never blocks transport. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { post, waitFor, rows, start } from './helpers.mjs';
import { auditWorld, auditRows, get, auth } from './audit-helpers.mjs';

test('an accepted signal is traceable request_id → event_id → each Hub attempt and result', async (t) => {
  const { app, hubs } = await auditWorld(t, ['ok', 'ok']);
  const body = JSON.stringify({ ticker: 'BTCUSDT', order_id: 'L-1', order_action: 'buy', market_position: 'long', px: 1 });
  const { event_id } = await (await post(app, body, { contentType: 'application/json' })).json();
  await waitFor('both delivered', () => hubs.every(h => h.received.length === 1));
  await waitFor('audit rows', () => auditRows(app, "event_id = ? AND event_type = 'DELIVERED'", event_id).length === 2);
  const persisted = auditRows(app, "event_type = 'INGRESS_PERSISTED'")[0];
  assert.equal(persisted.event_id, event_id);
  assert.match(persisted.request_id, /^[0-9a-f-]{36}$/);
  assert.equal(auditRows(app, "event_type = 'INGRESS_RECEIVED' AND request_id = ?", persisted.request_id).length, 1);
  assert.equal(persisted.symbol, 'BTCUSDT'); assert.equal(persisted.order_id, 'L-1');
  assert.equal(persisted.body_bytes, Buffer.byteLength(body)); assert.equal(persisted.content_type, 'application/json');
  assert.equal(persisted.payload_sha256.length, 64);
  for (const id of ['HUB_A', 'HUB_B']) {
    const r = auditRows(app, 'event_id = ? AND destination_id = ?', event_id, id).map(x => x.event_type);
    assert.deepEqual(r, ['DELIVERY_ATTEMPT', 'DELIVERED'], id);
    const d = auditRows(app, "event_id = ? AND destination_id = ? AND event_type = 'DELIVERED'", event_id, id)[0];
    assert.equal(d.http_status, 200); assert.equal(d.attempt, 1); assert.ok(d.latency_ms >= 0);
  }
  // a non-JSON body is accepted untouched; semantic fields stay null
  const r2 = await post(app, 'not json at all');
  assert.equal(r2.status, 200);
  await waitFor('persisted row', () => auditRows(app, "event_type = 'INGRESS_PERSISTED'").length === 2);
  assert.equal(auditRows(app, "event_type = 'INGRESS_PERSISTED'")[1].symbol, null);
});

test('retries record attempt, error, latency and next retry; FAILED_PERMANENT is recorded', async (t) => {
  const { app, hubs } = await auditWorld(t, ['ok', 'down', 400]);
  const { event_id } = await (await post(app, 'r')).json();
  await waitFor('HUB_B 2 retries', () => auditRows(app, "destination_id = 'HUB_B' AND event_type = 'RETRY_SCHEDULED'").length >= 2);
  const rs = auditRows(app, "destination_id = 'HUB_B' AND event_type = 'RETRY_SCHEDULED'");
  assert.deepEqual(rs.slice(0, 2).map(r => r.attempt), [1, 2]);
  for (const r of rs) { assert.equal(r.event_id, event_id); assert.equal(r.http_status, 503); assert.equal(r.error_code, 'HTTP 503'); assert.equal(r.status, 'RETRY'); assert.ok(r.next_retry_at > r.ts_ms); assert.ok(r.latency_ms >= 0); }
  await waitFor('HUB_C FAILED_PERMANENT', () => auditRows(app, "destination_id = 'HUB_C' AND event_type = 'FAILED_PERMANENT'").length === 1);
  assert.equal(auditRows(app, "destination_id = 'HUB_C' AND event_type = 'FAILED_PERMANENT'")[0].http_status, 400);
  assert.equal(hubs[0].received.length, 1);
  hubs[1].mode = 'ok';
  await waitFor('HUB_B delivered', () => auditRows(app, "destination_id = 'HUB_B' AND event_type = 'DELIVERED'").length === 1);
});

test('5 Hubs: one event has 5 independent traces; nothing is hard-coded to HUB_A/HUB_B', async (t) => {
  const { app, ids } = await auditWorld(t, ['ok', 'ok', 'down', 'ok', 'ok']);
  const { event_id } = await (await post(app, 'five')).json();
  await waitFor('4 delivered', () => auditRows(app, "event_id = ? AND event_type = 'DELIVERED'", event_id).length === 4);
  await waitFor('HUB_C retry', () => auditRows(app, "event_id = ? AND destination_id = 'HUB_C' AND event_type = 'RETRY_SCHEDULED'", event_id).length >= 1);
  assert.deepEqual([...new Set(auditRows(app, "event_id = ? AND event_type = 'DELIVERY_ATTEMPT'", event_id).map(r => r.destination_id))].sort(), ids);
  const s = await (await get(app, '/audit/api/summary', auth())).json();
  assert.deepEqual(s.destinations.map(d => d.id), ids);
  for (const f of fs.readdirSync(new URL('../src/', import.meta.url)).filter(f => f.endsWith('.mjs'))) {
    assert.doesNotMatch(fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'), /(['"`])HUB_[A-Z0-9_]+\1/, `${f} hard-codes a Hub id as a value`);
  }
});

test('dispatcher_status.json is written atomically with backlog and last results per destination', async (t) => {
  const { app, sb } = await auditWorld(t, ['ok', 'down']);
  await post(app, 's');
  const file = path.join(sb.dataDir, 'audit', 'dispatcher_status.json');
  await waitFor('status file shows HUB_B backlog', () => { try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return s.destinations.HUB_B.backlog === 1 && s.destinations.HUB_A.last_delivered_event_id === 1 && s; } catch { return false; } });
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.last_event_id, 1); assert.equal(s.audit_status, 'ok'); assert.equal(s.destinations.HUB_B.last_error, 'HTTP 503');
  assert.equal(fs.readdirSync(path.dirname(file)).filter(f => f.includes('.tmp-')).length, 0, 'no temp file left');
});

test('an audit write failure never stops transport: degraded in /health, AUDIT_WRITE_FAILED on stdout', async (t) => {
  const { app, hubs } = await auditWorld(t, ['ok']);
  app.audit.db.exec('DROP TABLE audit_events');                       // the audit store breaks
  const r = await post(app, 'still flows');
  assert.equal(r.status, 200);
  await waitFor('delivered anyway', () => hubs[0].received.length === 1 && rows(app, 'HUB_A')[0].status === 'DELIVERED');
  const h = await (await get(app, '/health')).json();
  assert.equal(h.status, 'healthy'); assert.equal(h.audit, 'degraded'); assert.equal(h.audit_url, '/audit');
  assert.ok(app.lines.some(l => /AUDIT_WRITE_FAILED/.test(l)));
});

test('/health keeps the V0.1 shape when the audit UI is not configured, and shows audit=ok when it is', async (t) => {
  const a = await auditWorld(t, ['ok'], { token: null });
  assert.deepEqual(await (await get(a.app, '/health')).json(), { status: 'healthy', db: 'ok', destinations_enabled: 1 });
  const b = await auditWorld(t, ['ok']);
  assert.deepEqual(await (await get(b.app, '/health')).json(), { status: 'healthy', db: 'ok', destinations_enabled: 1, audit: 'ok', audit_url: '/audit' });
});

test('retention deletes only old audit_events; events and deliveries are never touched', async (t) => {
  const { app, sb } = await auditWorld(t, ['ok'], { audit: { retention_days: 1 } });
  await post(app, 'keep me');
  await waitFor('delivered', () => rows(app, 'HUB_A')[0]?.status === 'DELIVERED');
  const old = Date.now() - 3 * 86400000;
  app.audit.db.prepare("INSERT INTO audit_events(ts_ms, event_type) VALUES (?, 'OLD_ROW')").run(old);
  const before = { ev: app.store.db.prepare('SELECT COUNT(*) n FROM events').get().n, dl: app.store.db.prepare('SELECT COUNT(*) n FROM deliveries').get().n };
  const n = app.audit.purge();
  assert.equal(n, 1);
  assert.equal(auditRows(app, "event_type = 'OLD_ROW'").length, 0);
  assert.ok(auditRows(app, "event_type = 'DELIVERED'").length >= 1);
  assert.deepEqual({ ev: app.store.db.prepare('SELECT COUNT(*) n FROM events').get().n, dl: app.store.db.prepare('SELECT COUNT(*) n FROM deliveries').get().n }, before);
  assert.equal(JSON.parse(auditRows(app, "event_type = 'AUDIT_RETENTION_CLEANUP'").at(-1).detail_json).deleted, 1);
});

test('audit history survives a restart with the same /data', async (t) => {
  const { app, sb } = await auditWorld(t, ['ok']);
  const { event_id } = await (await post(app, 'before restart')).json();
  await waitFor('delivered', () => auditRows(app, "event_type = 'DELIVERED'").length === 1);
  await app.stop();
  const app2 = await start(sb);
  t.after(() => app2.stop());
  const again = await (await post(app2, 'after restart')).json();
  assert.equal(again.event_id, event_id + 1, 'event_id continues');
  await waitFor('delivered', () => auditRows(app2, "event_type = 'DELIVERED'").length === 2);
  assert.deepEqual(auditRows(app2, "event_type = 'DISPATCHER_STARTED'").length, 2);
  assert.equal(auditRows(app2, "event_type = 'DISPATCHER_STOPPING'").length, 1);
});
