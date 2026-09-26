/**
 * EXPERIMENT (not part of the suites) · why 5 STAGING gates are CLOUD_ONLY in the local rehearsal.
 * Arms a Durable Object alarm, restarts the local runtime (Miniflare setOptions, as the rehearsal does
 * to emulate a queue pause or an ingress redeploy), and checks whether the alarm still fires.
 * Observed with the pinned toolchain: after the restart getAlarm() still returns the timestamp but the
 * alarm never fires (n stays 0). Without a restart the same alarm fires on time.
 *   node deployer/test/experiments/alarm-restart.mjs
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { EDGE_DIR } from '../../lib/paths.mjs';

const require = createRequire(path.join(EDGE_DIR, 'package.json'));
const { Miniflare } = await import(require.resolve('miniflare'));
const script = `
import { DurableObject } from 'cloudflare:workers';
export class P extends DurableObject {
  async arm(ms) { await this.ctx.storage.setAlarm(Date.now() + ms); return this.ctx.storage.getAlarm(); }
  async alarm() { await this.ctx.storage.put('n', Number((await this.ctx.storage.get('n')) || 0) + 1); }
  async count() { return { n: (await this.ctx.storage.get('n')) || 0, alarm: await this.ctx.storage.getAlarm() }; }
}
export default { async fetch(req, env) { const s = env.P.get(env.P.idFromName('x'));
  return Response.json(new URL(req.url).pathname === '/arm' ? await s.arm(2000) : await s.count()); } };`;
for (const restart of [false, true]) {
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-'));
  const opts = () => ({ modules: true, script, compatibilityDate: '2024-12-18', durableObjects: { P: { className: 'P', useSQLite: true } }, defaultPersistRoot: persist });
  const mf = new Miniflare(opts());
  await mf.dispatchFetch('http://x/arm');
  if (restart) await mf.setOptions(opts());
  await new Promise(r => setTimeout(r, 7000));
  console.log(`restart=${restart}`, await (await mf.dispatchFetch('http://x/count')).json());
  await mf.dispose();
}
