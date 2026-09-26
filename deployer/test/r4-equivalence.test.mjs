/**
 * F-21 · The generated STAGING configs are the R4 V1.3.0 configs, compared on the FULL normalized
 * config object (every field wrangler reads), for every STAGING Worker: ingress, both consumers, the
 * receiver and the admin (R4's own staging-receiver/ and admin-worker/ TOMLs). Every difference must be
 * in the allow-list below, and each allowed difference is then checked for its exact expected value.
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

function diff(a, b, p = '', outList = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return outList;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], p ? `${p}.${k}` : k, outList);
  } else outList.push(p);
  return outList;
}

const plan = await (async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'kawa-edge.example.json'), 'utf8'));
  cfg.cloudflare.account_id = '0123456789abcdef0123456789abcdef';
  const p = renderEnv('staging', (await validateConfig(cfg)).envs.staging.destinations, EDGE_DIR);
  writeBuild(p, fs.mkdtempSync(path.join(os.tmpdir(), 'r4eq-')));
  return p;
})();

// Always different, by construction: where the file lives, and the absolute main path (same file).
const LOCATION = ['configPath', 'userConfigPath', 'main'];
// Documented deltas (CHANGELOG §configs): ownership markers, explicit workers_dev/preview_urls.
const COMMON = ['vars.KAWA_EDGE_MANAGED', 'vars.KAWA_EDGE_BUILD', 'workers_dev', 'preview_urls'];

const CASES = [
  { name: 'kawa-edge-ingress-stg', r4: path.join(FIX, 'wrangler.staging.toml'), extra: [] },
  { name: 'kawa-edge-delivery-hub-a-stg', r4: path.join(FIX, 'wrangler.consumer.hub-a.staging.toml'), extra: ['vars.DESTINATIONS', 'services'], dest: 'HUB_A' },
  { name: 'kawa-edge-delivery-hub-b-stg', r4: path.join(FIX, 'wrangler.consumer.hub-b.staging.toml'), extra: ['vars.DESTINATIONS', 'services'], dest: 'HUB_B' },
  { name: 'kawa-staging-receiver-hub-a', r4: path.join(EDGE_DIR, 'staging-receiver', 'wrangler.toml'), extra: ['name', 'topLevelName'] },
  { name: 'kawa-staging-receiver-hub-b', r4: path.join(EDGE_DIR, 'staging-receiver', 'wrangler.toml'), extra: ['name', 'topLevelName'] },
  { name: 'kawa-edge-admin-stg', r4: path.join(EDGE_DIR, 'admin-worker', 'wrangler.toml'), extra: [] },
];

for (const c of CASES) {
  test(`${c.name}: full config = R4 except the documented deltas`, () => {
    const w = plan.workers.find(x => x.name === c.name);
    const gen = read(w.configPath), r4 = read(c.r4);
    const allowed = new Set([...LOCATION, ...COMMON, ...c.extra]);
    const d = diff(gen, r4);
    assert.deepEqual(d.filter(k => !allowed.has(k)), [], `undocumented differences: ${d.filter(k => !allowed.has(k))}`);
    // main: the same source file. R4's path is relative to where that TOML lived inside edge/
    // (edge/ for the moved fixtures, edge/staging-receiver/, edge/admin-worker/).
    const r4Home = c.r4.startsWith(FIX) ? EDGE_DIR : path.dirname(c.r4);
    assert.equal(gen.main, path.join(r4Home, path.relative(path.dirname(c.r4), r4.main)));
    assert.ok(fs.existsSync(gen.main));
    // Each allowed delta has exactly the documented value.
    assert.match(gen.vars.KAWA_EDGE_MANAGED, /^kawa-edge-nas:staging:/);
    assert.match(gen.vars.KAWA_EDGE_BUILD, /^[0-9a-f]{64}$/);
    assert.equal(gen.preview_urls, false);
    assert.equal(gen.workers_dev, w.role !== 'consumer');     // consumers: no public URL; others: R4's default made explicit
    if (c.dest) {
      const slug = c.dest.toLowerCase().replace('_', '-');
      assert.deepEqual(gen.services, [{ binding: `DEST_${c.dest}_FETCHER`, service: `kawa-staging-receiver-${slug}` }]);
      assert.deepEqual(r4.services, [{ binding: `DEST_${c.dest}_FETCHER`, service: 'kawa-staging-receiver' }]);
      assert.deepEqual(JSON.parse(gen.vars.DESTINATIONS), JSON.parse(r4.vars.DESTINATIONS).filter(d2 => d2.id === c.dest));
    }
    if (c.extra.includes('name')) assert.equal(gen.name, c.name);
  });
}
