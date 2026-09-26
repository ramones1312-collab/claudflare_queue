import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateConfig, HARD_LOCKS } from '../lib/config.mjs';
import { renderEnv, assertEnvIsolation, writeBuild } from '../lib/render.mjs';
import { EDGE_DIR, ROOT } from '../lib/paths.mjs';
import { names, belongsTo } from '../lib/naming.mjs';

const example = () => {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'kawa-edge.example.json'), 'utf8'));
  c.cloudflare.account_id = '0123456789abcdef0123456789abcdef';
  return c;
};

test('names: STAGING and PROD never overlap and keep the R4 staging names', () => {
  assert.equal(names.ingress('staging'), 'kawa-edge-ingress-stg');
  assert.equal(names.queue('staging', 'HUB_A'), 'kawa-signal-buffer-hub-a-stg');
  assert.equal(names.dlq('staging', 'HUB_B'), 'kawa-signal-buffer-hub-b-dlq-stg');
  assert.equal(names.consumer('staging', 'HUB_A'), 'kawa-edge-delivery-hub-a-stg');
  assert.equal(names.ingress('prod'), 'kawa-edge-ingress-prod');
  assert.equal(names.queue('prod', 'HUB_A'), 'kawa-signal-buffer-hub-a-prod');
  assert.throws(() => names.admin('prod'));
  assert.throws(() => names.receiver('prod', 'HUB_A'));
  assert.equal(belongsTo('prod', 'kawa-edge-ingress-stg'), false);
  assert.equal(belongsTo('staging', 'kawa-edge-ingress-prod'), false);
});

test('render is deterministic', async () => {
  const cfg = await validateConfig(example());
  const a = renderEnv('staging', cfg.envs.staging.destinations, EDGE_DIR);
  const b = renderEnv('staging', cfg.envs.staging.destinations, EDGE_DIR);
  assert.deepEqual(a.workers.map(w => w.text), b.workers.map(w => w.text));
  assert.deepEqual(a.workers.map(w => w.name), [
    'kawa-staging-receiver-hub-a', 'kawa-staging-receiver-hub-b', 'kawa-edge-ingress-stg',
    'kawa-edge-delivery-hub-a-stg', 'kawa-edge-delivery-hub-b-stg', 'kawa-edge-admin-stg']);
  assert.deepEqual(a.queues.map(q => q.name), [
    'kawa-signal-buffer-hub-a-stg', 'kawa-signal-buffer-hub-a-dlq-stg',
    'kawa-signal-buffer-hub-b-stg', 'kawa-signal-buffer-hub-b-dlq-stg']);
});

test('no generated config contains a secret value or a production host in STAGING', async () => {
  const cfg = await validateConfig(example());
  for (const env of ['staging', 'prod']) {
    const plan = renderEnv(env, cfg.envs[env].destinations, EDGE_DIR);
    for (const w of plan.workers) {
      assert.doesNotMatch(w.text, /WEBHOOK_PATH_TOKEN\s*=|ADMIN_TOKEN\s*=|CONTROL_TOKEN\s*=|HALT_NOTIFY_URL\s*=/);
      assert.doesNotMatch(w.text, /:8180|:8080/);
      if (env === 'staging') assert.doesNotMatch(w.text, /integrademia/);
      if (env === 'prod') {
        assert.doesNotMatch(w.text, /\[\[services\]\]/);
        assert.doesNotMatch(w.text, /-stg|staging-receiver/);
        assert.doesNotMatch(w.text, /webhook_host|integrademia/);   // deployer metadata never reaches a Worker
      }
    }
  }
});

test('every STAGING consumer is hard-locked to ITS OWN receiver; PROD consumers require their own secret', async () => {
  const cfg = await validateConfig(example());
  const stg = renderEnv('staging', cfg.envs.staging.destinations, EDGE_DIR);
  for (const w of stg.workers.filter(w => w.role === 'consumer')) {
    assert.match(w.text, new RegExp(`binding = "DEST_${w.dest}_FETCHER"\\nservice = "kawa-staging-receiver-${w.dest.toLowerCase().replace('_', '-')}"`));
    assert.doesNotMatch(w.text, /\[secrets\]/);
  }
  const prod = renderEnv('prod', cfg.envs.prod.destinations, EDGE_DIR);
  const a = prod.workers.find(w => w.name === 'kawa-edge-delivery-hub-a-prod');
  assert.match(a.text, /\[secrets\]\nrequired = \["DEST_HUB_A_WEBHOOK_URL"\]/);
  assert.equal(prod.workers.some(w => w.role === 'admin' || w.role === 'receiver'), false);
});

test('isolation guard refuses a tampered plan', async () => {
  const cfg = await validateConfig(example());
  const plan = renderEnv('staging', cfg.envs.staging.destinations, EDGE_DIR);
  const c = plan.workers.find(w => w.role === 'consumer');
  c.text = c.text.replace(/\[\[services\]\][\s\S]*?\n\n/, '');
  assert.throws(() => assertEnvIsolation(plan), /ENV_ISOLATION|hard-locked/);
  const prod = renderEnv('prod', cfg.envs.prod.destinations, EDGE_DIR);
  prod.workers[0].text += '\n[[services]]\nbinding="X"\nservice="kawa-staging-receiver-hub-a"\n';
  assert.throws(() => assertEnvIsolation(prod));
});

test('config: the Edge registry itself validates destinations (fail closed)', async () => {
  const bad = example(); bad.staging.destinations[0].timeout_ms = 0;
  await assert.rejects(validateConfig(bad), { code: 'CONFIG_REJECTED_BY_EDGE' });
  const bad2 = example(); bad2.staging.destinations[1].enabled = 'false';
  await assert.rejects(validateConfig(bad2), { code: 'CONFIG_REJECTED_BY_EDGE' });
  const dup = example(); dup.staging.destinations[1].id = 'HUB_A';
  await assert.rejects(validateConfig(dup), { code: 'CONFIG_REJECTED_BY_EDGE' });
});

test('config: secrets and control ports are refused; HUB_A host is hard-locked', async () => {
  const s = example(); s.prod.destinations[0].webhook_url = 'https://x/webhook/abc';
  await assert.rejects(validateConfig(s), { code: 'CONFIG_CONTAINS_SECRET' });
  const h = example(); h.prod.destinations[0].webhook_host = 'evil.example.com';
  await assert.rejects(validateConfig(h), { code: 'HARD_LOCK_HUB_A_HOST' });
  assert.deepEqual([...HARD_LOCKS.FORBIDDEN_PORTS], ['8180', '8080']);
});

test('writeBuild writes one explicit config per Worker', async () => {
  const cfg = await validateConfig(example());
  const plan = renderEnv('staging', cfg.envs.staging.destinations, EDGE_DIR);
  const dir = writeBuild(plan, fs.mkdtempSync(path.join(os.tmpdir(), 'kb-')));
  assert.equal(fs.readdirSync(dir).length, plan.workers.length);
  assert.equal(fs.existsSync(path.join(dir, 'wrangler.toml')), false);   // never an implicit root config
});

test('D-09 · the build digest does not depend on where the package is installed', async () => {
  const cfg = await validateConfig(example());
  const copies = ['/tmp/kawa-d09-a-', '/tmp/kawa-d09-bbbbbbbbbbbb-'].map(p => fs.mkdtempSync(p));
  try {
    for (const c of copies) for (const d of ['src', 'staging-receiver', 'admin-worker']) fs.cpSync(path.join(EDGE_DIR, d), path.join(c, d), { recursive: true });
    const [a, b] = copies.map(c => renderEnv('staging', cfg.envs.staging.destinations, c).workers.map(w => [w.name, w.build]));
    assert.deepEqual(a, b);
    fs.appendFileSync(path.join(copies[1], 'src', 'sequencer.js'), '\n');
    const c = renderEnv('staging', cfg.envs.staging.destinations, copies[1]).workers.map(w => [w.name, w.build]);
    assert.notDeepEqual(a, c, 'a source change must change the digest');
  } finally { for (const c of copies) fs.rmSync(c, { recursive: true, force: true }); }
});
