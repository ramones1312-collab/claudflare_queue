import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ConfigError } from '../src/config.mjs';
import { sandbox, dest } from './helpers.mjs';

const load = (sb) => loadConfig({ configFile: sb.configFile, secretsDir: sb.secretsDir });
function refused(opts, re) {
  const sb = sandbox(opts);
  try { assert.throws(() => load(sb), (e) => e instanceof ConfigError && re.test(e.message)); } finally { sb.cleanup(); }
}

test('a valid config loads N destinations; a disabled one needs no secret', () => {
  const sb = sandbox({ destinations: [dest('HUB_A', 9001), dest('HUB_B', 9002, { enabled: false }), dest('HUB_C', 9003)], secrets: { HUB_B: '' } });
  try {
    const c = load(sb);
    assert.deepEqual(c.enabled.map(d => d.id), ['HUB_A', 'HUB_C']);
    assert.equal(c.destinations.length, 3);
  } finally { sb.cleanup(); }
});

test('the shipped example config is valid once its secrets are filled', () => {
  const sb = sandbox({ raw: fs.readFileSync(new URL('../config/destinations.json', import.meta.url), 'utf8') });
  try {
    fs.writeFileSync(path.join(sb.secretsDir, 'hub_a_webhook_token'), 'hub-a-secret-123456');
    assert.equal(load(sb).enabled[0].id, 'HUB_A');
  } finally { sb.cleanup(); }
});

test('empty destinations, or none enabled, fail closed', () => {
  refused({ destinations: [] }, /non-empty/);
  refused({ destinations: [dest('HUB_A', 9001, { enabled: false })] }, /no destination is enabled/);
});

test('invalid ports and hosts fail closed (incl. the control port and the dispatcher port)', () => {
  for (const port of [0, 70000, '8181', 8.5]) refused({ destinations: [dest('HUB_A', port)] }, /port/);
  for (const port of [8180, 8191, 8080]) refused({ destinations: [dest('HUB_A', port)] }, /forbidden/);
  for (const host of ['http://192.168.0.20', '192.168.0.20:8181', 'a/b', '', 'x y']) refused({ destinations: [dest('HUB_A', 9001, { host })] }, /host/);
});

test('invalid JSON, duplicate ids, bad ids and non-boolean enabled fail closed', () => {
  refused({ raw: '{ not json' }, /invalid JSON/);
  refused({ destinations: [dest('HUB_A', 9001), dest('HUB_A', 9002)] }, /duplicated/);
  refused({ destinations: [dest('hub a', 9001)] }, /id/);
  refused({ destinations: [dest('HUB_A', 9001, { enabled: 'true' })] }, /enabled/);
});

test('secrets: missing/empty for an enabled Hub, inline in the config, or shared by two Hubs fail closed', () => {
  refused({ destinations: [dest('HUB_A', 9001)], secrets: { HUB_A: '' } }, /empty/);
  refused({ destinations: [dest('HUB_A', 9001, { webhook_secret_file: '../etc/passwd' })] }, /plain file name/);
  refused({ destinations: [dest('HUB_A', 9001, { webhook_secret: 'abc' })] }, /never go in the config/);
  refused({ destinations: [dest('HUB_A', 9001), dest('HUB_B', 9002)], secrets: { HUB_A: 'same-secret-123', HUB_B: 'same-secret-123' } }, /same webhook secret/);
});

test('an empty ingress secret fails closed', () => {
  const sb = sandbox({ destinations: [dest('HUB_A', 9001)] });
  try { fs.writeFileSync(path.join(sb.secretsDir, 'ingress_webhook_token'), ''); assert.throws(() => load(sb), /ingress.*empty/); } finally { sb.cleanup(); }
});
