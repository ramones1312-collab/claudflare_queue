/** Fan-out contract: independent per Hub, retry until back, order kept, restart keeps the backlog. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, dest, mockHub, start, post, waitFor, rows, secretOf, INGRESS } from './helpers.mjs';

async function hubs(t, ...modes) {
  const hs = await Promise.all(modes.map(m => mockHub(m)));
  t.after(() => Promise.all(hs.map(h => h.close())));
  return hs;
}
async function run(t, destinations, extra = {}) {
  const sb = sandbox({ destinations, ...extra });
  const app = await start(sb);
  t.after(async () => { await app.stop(); sb.cleanup(); });
  return { sb, app };
}

test('HUB_A receives on its own path secret; each Hub gets ITS secret', async (t) => {
  const [a, b] = await hubs(t, 'ok', 'ok');
  const { app } = await run(t, [dest('HUB_A', a.port), dest('HUB_B', b.port)]);
  await post(app, 'sig');
  await waitFor('both', () => a.received.length && b.received.length);
  assert.equal(a.received[0].url, `/webhook/${secretOf('HUB_A')}`);
  assert.equal(b.received[0].url, `/webhook/${secretOf('HUB_B')}`);
  await waitFor('DELIVERED rows', () => rows(app, 'HUB_A')[0].status === 'DELIVERED' && rows(app, 'HUB_B')[0].status === 'DELIVERED');
});

test('HUB_B down does not block HUB_A; when HUB_B returns, its backlog is delivered in order', async (t) => {
  const [a, b] = await hubs(t, 'ok', 'down');
  const { app } = await run(t, [dest('HUB_A', a.port), dest('HUB_B', b.port)]);
  for (const s of ['s1', 's2', 's3']) assert.equal((await post(app, s)).status, 200);
  await waitFor('HUB_A gets all 3', () => a.received.length === 3);
  await waitFor('HUB_B in RETRY', () => rows(app, 'HUB_B')[0].status === 'RETRY' && rows(app, 'HUB_B')[0].attempts >= 2);
  assert.equal(rows(app, 'HUB_B')[0].last_http_status, 503);
  assert.ok(app.lines.some(l => /RETRY HUB_B/.test(l)));
  b.mode = 'ok';
  await waitFor('HUB_B catches up', () => rows(app, 'HUB_B').every(r => r.status === 'DELIVERED'));
  const okB = b.received.filter((_, i, all) => i >= all.length - 3).map(r => r.body.toString());
  assert.deepEqual(okB, ['s1', 's2', 's3'], 'strict order per destination after recovery');
  assert.ok(app.lines.some(l => /DELIVERED HUB_B/.test(l)));
});

test('a Hub that never answers (timeout) does not block another', async (t) => {
  const [a, b] = await hubs(t, 'ok', 'hang');
  const { app } = await run(t, [dest('HUB_A', a.port), dest('HUB_B', b.port, { timeout_ms: 300 })]);
  await post(app, 'x1'); await post(app, 'x2');
  await waitFor('HUB_A delivered both', () => a.received.length === 2);
  await waitFor('HUB_B timed out → RETRY', () => rows(app, 'HUB_B')[0].last_error === 'TIMEOUT');
});

test('N destinations from config only; a disabled one receives nothing', async (t) => {
  const hs = await hubs(t, 'ok', 'ok', 'ok', 'ok');
  const ds = [dest('HUB_A', hs[0].port), dest('HUB_B', hs[1].port), dest('HUB_C', hs[2].port), dest('HUB_D', hs[3].port, { enabled: false })];
  const { app } = await run(t, ds);
  await post(app, 'fan');
  await waitFor('3 enabled Hubs', () => hs.slice(0, 3).every(h => h.received.length === 1));
  await new Promise(r => setTimeout(r, 300));
  assert.equal(hs[3].received.length, 0);
  assert.equal(rows(app, 'HUB_D').length, 0, 'no delivery row for a disabled Hub');
});

test('a Hub that refuses (4xx) is FAILED_PERMANENT, kept, not retried; the next signal still flows', async (t) => {
  const [a] = await hubs(t, 401);
  const { app } = await run(t, [dest('HUB_A', a.port)]);
  await post(app, 'p1');
  await waitFor('FAILED_PERMANENT', () => rows(app, 'HUB_A')[0]?.status === 'FAILED_PERMANENT');
  a.mode = 'ok';
  await post(app, 'p2');
  await waitFor('p2 delivered', () => rows(app, 'HUB_A')[1]?.status === 'DELIVERED');
  assert.equal(a.received.filter(r => r.body.toString() === 'p1').length, 1, 'p1 not retried');
});

test('restart: the backlog survives in SQLite and is delivered after restart', async (t) => {
  const [a] = await hubs(t, 'down');
  const sb = sandbox({ destinations: [dest('HUB_A', a.port)] });
  t.after(() => sb.cleanup());
  let app = await start(sb);
  await post(app, 'r1'); await post(app, 'r2');
  await waitFor('in RETRY', () => rows(app, 'HUB_A')[0].status === 'RETRY');
  await app.stop();
  a.mode = 'ok';
  app = await start(sb);
  t.after(() => app.stop());
  await waitFor('both delivered after restart', () => rows(app, 'HUB_A').length === 2 && rows(app, 'HUB_A').every(r => r.status === 'DELIVERED'));
  assert.deepEqual(a.received.filter(r => r.body.length).slice(-2).map(r => r.body.toString()), ['r1', 'r2']);
  assert.ok(app.lines.some(l => /STARTED .*backlog=\{"HUB_A":2\}/.test(l)));
});

test('no secret ever appears in the logs', async (t) => {
  const [a, b] = await hubs(t, 'ok', 'down');
  const { app } = await run(t, [dest('HUB_A', a.port), dest('HUB_B', b.port)]);
  await post(app, 'body-must-not-be-logged-either');
  await post(app, 'x', { token: 'wrong-token-123456' });
  await waitFor('delivered + retry', () => a.received.length === 1 && rows(app, 'HUB_B')[0].attempts >= 1);
  const all = app.lines.join('\n');
  for (const s of [INGRESS, secretOf('HUB_A'), secretOf('HUB_B'), 'body-must-not-be-logged-either']) assert.ok(!all.includes(s), `leaked: ${s.slice(0, 6)}…`);
  for (const k of ['RECEIVED', 'PERSISTED', 'DELIVERED HUB_A', 'RETRY HUB_B']) assert.ok(all.includes(k), `missing log ${k}`);
});
