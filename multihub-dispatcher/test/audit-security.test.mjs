/** V0.1.1 · /audit* is authenticated, LAN only, never through Cloudflare; no secret or payload is exposed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { post, waitFor, INGRESS, secretOf } from './helpers.mjs';
import { auditWorld, auditRows, get, auth, AUDIT_TOKEN } from './audit-helpers.mjs';

const PATHS = ['/audit', '/audit/app.js', '/audit/api/events', '/audit/api/summary', '/audit/export.csv', '/audit/export.json'];

test('every /audit* path needs Basic Auth: none or wrong → 401 with WWW-Authenticate; right → 200 on LAN', async (t) => {
  const { app } = await auditWorld(t, ['ok']);
  for (const p of PATHS) {
    for (const h of [{}, auth('wrong-password-000000000'), auth(AUDIT_TOKEN, 'admin'), { authorization: `Bearer ${AUDIT_TOKEN}` }]) {
      const r = await get(app, p, h);
      assert.equal(r.status, 401, `${p} ${JSON.stringify(h)}`);
      assert.match(r.headers.get('www-authenticate'), /^Basic realm="KAWA dispatcher audit"/);
      assert.equal(await r.text(), '{"status":"unauthorized"}', 'generic body');
    }
    const ok = await get(app, p, auth());
    assert.equal(ok.status, 200, p);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.equal(ok.headers.get('access-control-allow-origin'), null, 'no CORS');
  }
});

test('a token in the query string is never accepted', async (t) => {
  const { app } = await auditWorld(t, ['ok']);
  for (const q of [`?token=${AUDIT_TOKEN}`, `?password=${AUDIT_TOKEN}`, `?auth=${AUDIT_TOKEN}`, `?audit_admin_token=${AUDIT_TOKEN}`]) {
    assert.equal((await get(app, `/audit/export.json${q}`)).status, 401, q);
  }
});

test('Cloudflare evidence → /audit* refused even with the right credentials; the ingress still works through Cloudflare', async (t) => {
  const { app, hubs } = await auditWorld(t, ['ok']);
  for (const h of [{ 'cf-ray': '8a1b2c3d4e5f-FRA' }, { 'cf-connecting-ip': '52.89.214.238' }, { 'cdn-loop': 'cloudflare' }, { 'cf-ipcountry': 'US' }]) {
    for (const p of PATHS) assert.equal((await get(app, p, { ...auth(), ...h })).status, 403, `${p} ${JSON.stringify(h)}`);
  }
  const r = await post(app, 'via tunnel', { headers: { 'cf-ray': '8a1b2c3d4e5f-FRA', 'cf-connecting-ip': '52.89.214.238' } });
  assert.equal(r.status, 200);
  await waitFor('delivered', () => hubs[0].received.length === 1);
});

test('known-secret scan: 0 occurrences in the audit table, exports, HTML/JS, status file and stdout; no body, no Authorization', async (t) => {
  const { app, sb, hubs } = await auditWorld(t, ['ok', 'down']);
  const RAW = 'RAW-BODY-MUST-NEVER-BE-STORED-7f3a';
  const BEARER = 'Bearer upstream-credential-zz9-plural-z-alpha';
  await post(app, JSON.stringify({ ticker: 'ETHUSDT', note: RAW }), { contentType: 'application/json', headers: { authorization: BEARER, cookie: 'session=cookie-secret-123' } });
  await post(app, 'x', { token: 'wrong-token-123456' });
  await waitFor('HUB_A delivered, HUB_B retry', () => hubs[0].received.length === 1 && auditRows(app, "destination_id = 'HUB_B' AND event_type = 'RETRY_SCHEDULED'").length >= 1);
  const texts = [];
  texts.push(JSON.stringify(auditRows(app)));
  for (const p of ['/audit', '/audit/app.js', '/audit/api/events?limit=5000', '/audit/api/summary', '/audit/export.csv', '/audit/export.json']) texts.push(await (await get(app, p, auth())).text());
  await new Promise(r => setTimeout(r, 400));                                        // status file debounce
  const auditDir = path.join(sb.dataDir, 'audit');
  texts.push(fs.readFileSync(path.join(auditDir, 'dispatcher_status.json'), 'utf8'));
  for (const f of fs.readdirSync(path.join(auditDir, 'exports'))) texts.push(fs.readFileSync(path.join(auditDir, 'exports', f), 'utf8'));
  texts.push(app.lines.join('\n'));
  const all = texts.join('\n');
  for (const s of [AUDIT_TOKEN, INGRESS, secretOf('HUB_A'), secretOf('HUB_B'), RAW, 'upstream-credential', 'cookie-secret-123', '/webhook/']) assert.ok(!all.includes(s), `leaked: ${s.slice(0, 12)}…`);
  assert.ok(all.includes('ETHUSDT'), 'sanity: the audit data is there');
});

test('an audit token equal to the ingress or a Hub secret disables the UI (503), never the transport', async (t) => {
  const { app, hubs } = await auditWorld(t, ['ok'], { token: INGRESS });
  assert.equal((await get(app, '/audit', auth(INGRESS))).status, 503);
  assert.ok(app.lines.some(l => /AUDIT_UI_DISABLED/.test(l) && /reuse/.test(l)));
  assert.equal((await post(app, 'ok')).status, 200);
  await waitFor('delivered', () => hubs[0].received.length === 1);
});
