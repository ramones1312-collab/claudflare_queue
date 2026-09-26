import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWebhookUrl } from '../lib/secrets.mjs';
import { redact, registerSecret } from '../lib/log.mjs';

const H = 'vector-hook.integrademia.com';
const TOK = 'A'.repeat(24);

test('webhook URL: only https://<ingress host>/webhook/<secret>', () => {
  assert.ok(validateWebhookUrl(`https://${H}/webhook/${TOK}`, H));
  for (const [url, code] of [
    [`https://${H}:8180/webhook/${TOK}`, 'HARD_LOCK_CONTROL_PORT'],
    [`http://${H}:8080/webhook/${TOK}`, 'HARD_LOCK_CONTROL_PORT'],
    [`https://nas.local:8181/webhook/${TOK}`, 'WEBHOOK_URL_PORT'],
    [`http://${H}/webhook/${TOK}`, 'WEBHOOK_URL_NOT_HTTPS'],
    [`https://other.example.com/webhook/${TOK}`, 'WEBHOOK_URL_HOST'],
    [`https://${H}/control/${TOK}`, 'WEBHOOK_URL_PATH'],
    [`https://${H}/webhook/short`, 'WEBHOOK_URL_PATH'],
    [`https://${H}/webhook/${TOK}?x=1`, 'WEBHOOK_URL_PATH'],
  ]) assert.throws(() => validateWebhookUrl(url, H), { code }, url);
});

test('redaction masks registered secrets, webhook path tokens and bearer tokens', () => {
  registerSecret('super-secret-value-123');
  const s = redact('a super-secret-value-123 b https://h/webhook/abcdefghij c Bearer abcdefghijklmnop');
  assert.doesNotMatch(s, /super-secret|abcdefghij|abcdefghijklmnop/);
});

import { validateHaltUrl, checkAndRecordFingerprint } from '../lib/secrets.mjs';
import { validateConfig } from '../lib/config.mjs';

test('halt-notification URL can never reach a Hub (it bypasses the Service Binding)', () => {
  assert.ok(validateHaltUrl('https://ntfy.example.org/kawa-halts', ['hub-b.example.com']));
  assert.ok(validateHaltUrl('https://halt-notify.invalid/kawa-edge-stg'));
  for (const [u, code] of [
    [`https://${H}/anything`, 'HALT_URL_IS_HUB'],
    [`https://${H}./x`, 'HALT_URL_IS_HUB'],
    ['https://HUB-B.example.com/x', 'HALT_URL_IS_HUB'],
    ['https://collector.example.org/webhook/abc', 'HALT_URL_IS_HUB'],
    ['https://collector.example.org:8180/x', 'HARD_LOCK_CONTROL_PORT'],
    ['https://collector.example.org:8443/x', 'HALT_URL_INVALID'],
    ['http://collector.example.org/x', 'HALT_URL_INVALID'],
  ]) assert.throws(() => validateHaltUrl(u, ['hub-b.example.com']), { code }, u);
});

test('the same secret for two Hubs is refused even within one run', () => {
  const tok = 'Z'.repeat(32);
  checkAndRecordFingerprint('HUB_X', `https://x.example.com/webhook/${tok}`);
  assert.throws(() => checkAndRecordFingerprint('HUB_Y', `https://y.example.com/webhook/${tok}`), { code: 'WEBHOOK_SECRET_REUSED' });
});

test('no other destination may point at HUB_A\'s ingress host', async () => {
  const cfg = { schema: 'kawa.edge.nas.config.v1', cloudflare: { account_id: '0'.repeat(32) },
    staging: { destinations: [{ id: 'HUB_A' }, { id: 'HUB_B' }] },
    prod: { destinations: [{ id: 'HUB_A', webhook_host: H }, { id: 'HUB_B', webhook_host: H + '.' }] } };
  await assert.rejects(validateConfig(cfg));
  cfg.prod.destinations[1].webhook_host = H;
  await assert.rejects(validateConfig(cfg), { code: 'HARD_LOCK_HUB_A_HOST' });
});

test('halt URL: any host in a Hub domain and encoded /webhook paths are refused', () => {
  for (const u of ['https://x.integrademia.com/status', 'https://collector.example.org/%77ebhook/abc', 'https://collector.example.org/webhook',
                   'https://ctl.hub-b.example.com/x']) {
    assert.throws(() => validateHaltUrl(u, ['hub-b.example.com']), { code: 'HALT_URL_IS_HUB' }, u);
  }
});

test('F-07 · no destination other than HUB_A may point anywhere in HUB_A\'s domain', async () => {
  for (const host of ['integrademia.com', 'control.integrademia.com', 'x.vector-hook.integrademia.com']) {
    const cfg = { schema: 'kawa.edge.nas.config.v1', cloudflare: { account_id: '0'.repeat(32) },
      staging: { destinations: [{ id: 'HUB_A' }, { id: 'HUB_B' }] },
      prod: { destinations: [{ id: 'HUB_A', webhook_host: H }, { id: 'HUB_B', webhook_host: host }] } };
    await assert.rejects(validateConfig(cfg), { code: 'HARD_LOCK_HUB_A_HOST' }, host);
  }
});

test('C-02 / C-07 / F-18 · IP-literal halt URLs, ?/# markers and percent-encoded secrets are refused', () => {
  for (const u of ['https://192.168.1.10/x', 'https://[::1]/x', 'https://localhost/x']) assert.throws(() => validateHaltUrl(u), { code: 'HALT_URL_INVALID' }, u);
  for (const u of [`https://${H}/webhook/${TOK}?`, `https://${H}/webhook/${TOK}#`, `https://${H}/webhook/%41${TOK}`]) {
    assert.throws(() => validateWebhookUrl(u, H), { code: 'WEBHOOK_URL_PATH' }, u);
  }
});
