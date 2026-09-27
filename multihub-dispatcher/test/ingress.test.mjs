/** Ingress contract: commit before 2xx, 503 on a storage error, raw payload kept, refusals store nothing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, dest, mockHub, start, post, waitFor, INGRESS } from './helpers.mjs';

async function world(t) {
  const hub = await mockHub();
  const sb = sandbox({ destinations: [dest('HUB_A', hub.port)] });
  const app = await start(sb);
  t.after(async () => { await app.stop(); await hub.close(); sb.cleanup(); });
  return { hub, sb, app };
}
const count = (app) => app.store.db.prepare('SELECT COUNT(*) n FROM events').get().n;

test('POST → committed in SQLite → 200 with the event id', async (t) => {
  const { app } = await world(t);
  const r = await post(app, '{"a":1}', { contentType: 'application/json' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, 'accepted');
  const ev = app.store.db.prepare('SELECT * FROM events WHERE event_id = ?').get(j.event_id);
  assert.equal(Buffer.from(ev.body).toString(), '{"a":1}');
  assert.equal(app.store.db.prepare('SELECT status FROM deliveries WHERE event_id = ?').get(j.event_id) !== undefined, true);
});

test('a storage error answers 503 and never 2xx', async (t) => {
  const { app } = await world(t);
  app.store.insertEvent = () => { const e = new Error('disk I/O error'); e.code = 'ERR_SQLITE_ERROR'; throw e; };
  const r = await post(app, 'x');
  assert.equal(r.status, 503);
  assert.ok(app.lines.some(l => /PERSIST_FAILED/.test(l)));
});

test('the RAW body, content type and origin headers reach the Hub byte for byte', async (t) => {
  const { hub, app } = await world(t);
  const body = Buffer.from('{"ticker":"BTCUSDT","px":"65000.10","note":"ñ \\u00e9  spaces\\n"}\r\n');
  const r = await post(app, body, { contentType: 'application/json; charset=utf-8', headers: { 'cf-connecting-ip': '52.89.214.238', 'user-agent': 'Go-http-client/1.1' } });
  assert.equal(r.status, 200);
  await waitFor('delivery', () => hub.received.length === 1);
  const got = hub.received[0];
  assert.equal(got.method, 'POST');
  assert.ok(got.body.equals(body));
  assert.equal(got.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(got.headers['cf-connecting-ip'], '52.89.214.238');
  assert.equal(got.headers['user-agent'], 'Go-http-client/1.1');
});

test('identical payloads are two signals: the dispatcher does no trading dedupe', async (t) => {
  const { hub, app } = await world(t);
  await post(app, 'same'); await post(app, 'same');
  await waitFor('both delivered', () => hub.received.length === 2);
  assert.equal(count(app), 2);
});

test('refused requests store nothing: bad path token (401), GET (405), other path (404), body too large (413)', async (t) => {
  const { app } = await world(t);
  assert.equal((await post(app, 'x', { token: 'wrong-token-123456' })).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${app.port}/webhook/${INGRESS}`)).status, 405);
  assert.equal((await fetch(`http://127.0.0.1:${app.port}/other`, { method: 'POST', body: 'x' })).status, 404);
  const big = await post(app, 'x'.repeat(70000)).then(r => r.status, () => 'reset');
  assert.ok(big === 413 || big === 'reset', String(big));
  assert.equal(count(app), 0);
});

test('/health reports a healthy DB and the enabled destinations; unhealthy if the DB fails', async (t) => {
  const { app } = await world(t);
  const r = await fetch(`http://127.0.0.1:${app.port}/health`);
  assert.deepEqual(await r.json(), { status: 'healthy', db: 'ok', destinations_enabled: 1 });
  app.store.ping = () => { throw new Error('db gone'); };
  const bad = await fetch(`http://127.0.0.1:${app.port}/health`);
  assert.equal(bad.status, 503);
  assert.equal((await bad.json()).db, 'error');
});
