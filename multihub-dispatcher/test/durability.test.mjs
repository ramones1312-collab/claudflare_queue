/** V0.1.1 · crash test: kill -9 the real process mid-retry, restart on the same /data. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { sandbox, dest, mockHub, waitFor, INGRESS } from './helpers.mjs';
import { AUDIT_TOKEN, auth } from './audit-helpers.mjs';

function launch(sb) {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', new URL('../src/main.mjs', import.meta.url).pathname], {
    env: { ...process.env, KAWA_CONFIG: sb.configFile, KAWA_SECRETS: sb.secretsDir, KAWA_DATA: sb.dataDir, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = '';
  p.stdout.on('data', d => { p.out += d; }); p.stderr.on('data', d => { p.out += d; });
  return p;
}
const portOf = async (p) => Number((await waitFor('STARTED', () => /STARTED port=(\d+)/.exec(p.out)))[1]);
const readOnly = (sb, sql, ...a) => { const db = new DatabaseSync(path.join(sb.dataDir, 'dispatcher.db'), { readOnly: true }); try { return db.prepare(sql).all(...a); } finally { db.close(); } };

test('kill -9 mid-retry: DB intact, backlog and audit history kept, event_id continues, deliveries resume, exports include the past', async (t) => {
  const [a, b] = await Promise.all([mockHub('ok'), mockHub('down')]);
  const sb = sandbox({ destinations: [dest('HUB_A', a.port), dest('HUB_B', b.port)] });
  fs.writeFileSync(path.join(sb.secretsDir, 'audit_admin_token'), AUDIT_TOKEN);
  let p = launch(sb);
  t.after(async () => { try { p.kill('SIGKILL'); } catch { /* gone */ } await a.close(); await b.close(); sb.cleanup(); });
  let port = await portOf(p);
  const hook = (body, prt) => fetch(`http://127.0.0.1:${prt}/webhook/${INGRESS}`, { method: 'POST', body });
  for (const s of ['k1', 'k2', 'k3']) assert.equal((await hook(s, port)).status, 200);
  await waitFor('HUB_B retries recorded', () => readOnly(sb, "SELECT COUNT(*) n FROM audit_events WHERE destination_id='HUB_B' AND event_type='RETRY_SCHEDULED'")[0].n >= 2);
  await waitFor('HUB_A delivered 3', () => a.received.length === 3);
  const auditBefore = readOnly(sb, 'SELECT COUNT(*) n FROM audit_events')[0].n;

  p.kill('SIGKILL');                                                          // abrupt: no shutdown path runs
  await new Promise(r => p.once('exit', r));
  assert.equal(readOnly(sb, 'PRAGMA integrity_check')[0].integrity_check, 'ok');
  assert.equal(readOnly(sb, "SELECT COUNT(*) n FROM deliveries WHERE destination_id='HUB_B' AND status IN ('PENDING','RETRY')")[0].n, 3, 'backlog kept');
  assert.ok(readOnly(sb, 'SELECT COUNT(*) n FROM audit_events')[0].n >= auditBefore, 'audit history kept');

  b.mode = 'ok';
  p = launch(sb); port = await portOf(p);
  const r = await (await hook('k4', port)).json();
  assert.equal(r.event_id, 4, 'event_id continuity');
  await waitFor('HUB_B delivers the whole backlog in order + k4', () => b.received.filter(x => x.body.length).map(x => x.body.toString()).slice(-4).join() === 'k1,k2,k3,k4', 8000);
  const ex = await (await fetch(`http://127.0.0.1:${port}/audit/export.json?limit=5000`, { headers: auth() })).json();
  assert.ok(ex.events.some(e => e.event_id === 1 && e.event_type === 'INGRESS_PERSISTED'), 'export includes pre-crash history');
  assert.ok(ex.events.some(e => e.event_id === 1 && e.destination_id === 'HUB_B' && e.event_type === 'DELIVERED'), 'and the post-crash delivery');
  p.kill('SIGTERM');
  await new Promise(r => p.once('exit', r));
});

test('CONFIG_INVALID is recorded durably even though the dispatcher does not start', async (t) => {
  const sb = sandbox({ destinations: [] });
  t.after(() => sb.cleanup());
  const p = launch(sb);
  const code = await new Promise(r => p.once('exit', r));
  assert.equal(code, 1);
  assert.match(p.out, /CONFIG_INVALID/);
  const r = readOnly(sb, "SELECT * FROM audit_events WHERE event_type='CONFIG_INVALID'");
  assert.equal(r.length, 1);
  assert.match(JSON.parse(r[0].detail_json).reason, /non-empty/);
});
