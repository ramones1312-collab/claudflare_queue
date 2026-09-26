/**
 * The generated STAGING configs must be the R4 V1.3.0 configs, semantically, except for the
 * differences listed (and justified) in CHANGELOG_V1_3_1.md. Parsed by the pinned wrangler's own
 * reader, so formatting and comments cannot hide a difference.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { validateConfig } from '../lib/config.mjs';
import { renderEnv, writeBuild } from '../lib/render.mjs';
import { EDGE_DIR, ROOT } from '../lib/paths.mjs';

const require = createRequire(path.join(EDGE_DIR, 'package.json'));
const { unstable_readConfig } = await import(require.resolve('wrangler'));
const FIX = path.join(ROOT, 'deployer', 'test', 'fixtures');
const quietly = (fn) => { const w = console.warn, l = console.log; console.warn = console.log = () => {}; try { return fn(); } finally { console.warn = w; console.log = l; } };
const read = (p) => quietly(() => unstable_readConfig({ config: p }, { hideWarnings: true }));

function shape(c) {
  return {
    name: c.name,
    main: path.basename(c.main || ''),
    compatibility_date: c.compatibility_date,
    durable_objects: c.durable_objects,
    queues: c.queues,
    services: c.services,
    vars: c.vars,
    secrets: c.secrets,
    exports: c.exports,
  };
}

const generated = async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'kawa-edge.example.json'), 'utf8'));
  cfg.cloudflare.account_id = '0123456789abcdef0123456789abcdef';
  const v = await validateConfig(cfg);
  const plan = renderEnv('staging', v.envs.staging.destinations, EDGE_DIR);
  writeBuild(plan, fs.mkdtempSync(path.join(os.tmpdir(), 'r4eq-')));
  return plan;
};

const stripMarkers = (vars) => { const v = { ...vars }; delete v.KAWA_EDGE_MANAGED; delete v.KAWA_EDGE_BUILD; return v; };

test('ingress: identical to R4 wrangler.staging.toml except the two ownership markers', async () => {
  const plan = await generated();
  const r4 = shape(read(path.join(FIX, 'wrangler.staging.toml')));
  const gen = shape(read(plan.workers.find(w => w.role === 'ingress').configPath));
  assert.match(gen.vars.KAWA_EDGE_MANAGED, /^kawa-edge-nas:staging:ingress$/);
  assert.match(gen.vars.KAWA_EDGE_BUILD, /^[0-9a-f]{64}$/);
  gen.vars = stripMarkers(gen.vars);
  assert.deepEqual(gen, r4);
});

for (const id of ['HUB_A', 'HUB_B']) {
  test(`consumer ${id}: R4 semantics; documented deltas only`, async () => {
    const plan = await generated();
    const file = `wrangler.consumer.${id.toLowerCase().replace('_', '-')}.staging.toml`;
    const r4 = shape(read(path.join(FIX, file)));
    const genRaw = read(plan.workers.find(w => w.role === 'consumer' && w.dest === id).configPath);
    const gen = shape(genRaw);
    // Delta 1 · each destination has its OWN staging receiver (per-destination outage gates).
    assert.equal(r4.services[0].service, 'kawa-staging-receiver');
    assert.equal(gen.services[0].service, `kawa-staging-receiver-${id.toLowerCase().replace('_', '-')}`);
    assert.equal(gen.services[0].binding, r4.services[0].binding);
    // Delta 2 · DESTINATIONS carries only this consumer's own entry, byte-equal to R4's entry.
    const r4Entry = JSON.parse(r4.vars.DESTINATIONS).find(d => d.id === id);
    assert.deepEqual(JSON.parse(gen.vars.DESTINATIONS), [r4Entry]);
    // Delta 3 · no public workers.dev URL / preview URLs for a queue consumer.
    assert.equal(genRaw.workers_dev, false);
    assert.equal(genRaw.preview_urls, false);
    // Everything else identical.
    for (const k of ['name', 'main', 'compatibility_date', 'durable_objects', 'queues', 'secrets', 'exports']) {
      assert.deepEqual(gen[k], r4[k], k);
    }
    const gv = stripMarkers(gen.vars); delete gv.DESTINATIONS;
    const rv = { ...r4.vars }; delete rv.DESTINATIONS;
    assert.deepEqual(gv, rv);
  });
}
