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
