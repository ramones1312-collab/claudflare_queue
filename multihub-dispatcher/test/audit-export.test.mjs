/** V0.1.1 · CSV/JSON exports: parseable, same filters as the UI, limits, escaping, persisted copies. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { post, waitFor } from './helpers.mjs';
import { auditWorld, auditRows, get, auth, parseCsv } from './audit-helpers.mjs';

async function seeded(t, opts) {
  const w = await auditWorld(t, ['ok', 'down'], opts);
  for (const b of ['{"ticker":"A,B \\"quoted\\"\\nline2","order_id":"=HYPERLINK(\\"x\\")"}', '{"ticker":"ÑANDÚ-€"}', 'plain']) await post(w.app, b, { contentType: 'application/json' });
  await waitFor('3 delivered to HUB_A + retries on HUB_B', () => auditRows(w.app, "destination_id = 'HUB_A' AND event_type = 'DELIVERED'").length === 3
    && auditRows(w.app, "destination_id = 'HUB_B' AND event_type = 'RETRY_SCHEDULED'").length >= 1);
  return w;
}

test('CSV: UTF-8 with stable headers, one row per audit event, correct quoting and formula neutralisation', async (t) => {
  const { app } = await seeded(t);
  const r = await get(app, '/audit/export.csv?limit=5000', auth());
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/csv; charset=utf-8/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="dispatcher_audit_\d{8}_\d{6}(_\d+)?\.csv"/);
  const rows = parseCsv(await r.text());
  assert.deepEqual(rows[0].slice(0, 5), ['audit_id', 'ts_ms', 'request_id', 'event_id', 'event_type']);
  assert.equal(rows[0].length, 18);
  assert.ok(rows.slice(1).every(x => x.length === 18), 'every row has every column');
  assert.equal(rows.length - 1, auditRows(app).length);
  const sym = rows.find(x => x[4] === 'INGRESS_PERSISTED' && x[15].startsWith('A,B'));
  assert.equal(sym[15], 'A,B "quoted" line2', 'comma, quotes and newline survive (control chars made spaces)');
  assert.equal(sym[16], `'=HYPERLINK("x")`, 'a formula is neutralised');
  assert.ok(rows.some(x => x[15] === 'ÑANDÚ-€'), 'UTF-8');
});

test('JSON: valid, with schema_version, exported_at, filters and events; filters by event_id, Hub, status; limit capped', async (t) => {
  const { app } = await seeded(t, { audit: { ui_max_rows: 4 } });
  const j = await (await get(app, '/audit/export.json?event_id=1', auth())).json();
  assert.equal(j.schema_version, 1); assert.ok(Date.parse(j.exported_at)); assert.equal(j.filters.event_id, '1');
  assert.ok(j.events.length > 0 && j.events.every(e => e.event_id === 1));
  const hubB = await (await get(app, '/audit/export.json?destination_id=HUB_B&status=RETRY', auth())).json();
  assert.ok(hubB.events.length >= 1 && hubB.events.every(e => e.destination_id === 'HUB_B' && e.status === 'RETRY'));
  const capped = await (await get(app, '/audit/export.json?limit=100000', auth())).json();
  assert.equal(capped.events.length, 4, 'ui_max_rows caps any requested limit');
  const byReq = auditRows(app, "event_type = 'INGRESS_PERSISTED'")[0];
  const viaReq = await (await get(app, `/audit/api/events?request_id=${byReq.request_id}`, auth())).json();
  assert.ok(viaReq.events.some(e => e.destination_id === 'HUB_A' && e.event_id === byReq.event_id), 'request_id finds the delivery rows of its event');
  assert.equal((await get(app, '/audit/api/events?event_id=1;DROP', auth())).status, 400);
  const from = Date.now() + 3600e3;
  assert.equal((await (await get(app, `/audit/api/events?from=${from}`, auth())).json()).events.length, 0, 'time range');
});

test('each export is also saved under data/audit/exports and never overwritten', async (t) => {
  const { app, sb } = await seeded(t);
  for (let i = 0; i < 3; i++) { await get(app, '/audit/export.csv', auth()); await get(app, '/audit/export.json', auth()); }
  const files = fs.readdirSync(path.join(sb.dataDir, 'audit', 'exports'));
  assert.equal(files.filter(f => f.endsWith('.csv')).length, 3);
  assert.equal(files.filter(f => f.endsWith('.json')).length, 3);
  assert.ok(files.every(f => /^dispatcher_audit_\d{8}_\d{6}(_\d+)?\.(csv|json)$/.test(f)));
});
