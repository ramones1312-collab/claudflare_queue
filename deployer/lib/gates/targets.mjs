/**
 * Where the STAGING gates run.
 *
 *   cloud   the real Cloudflare STAGING deployment (workers.dev URLs, pinned wrangler for queue
 *           pause/resume and for the ingress redeploy). This is the gate that decides STAGING PASS.
 *   local   a rehearsal: the SAME generated configs and the SAME bundles `wrangler deploy --dry-run`
 *           produces, run together in one Miniflare (workerd) with persistent storage. Queue pause is
 *           emulated by detaching that consumer; "redeploy" restarts the runtime on the same storage.
 *           Miniflare's queue broker is in-memory, so a restart DISCARDS in-flight copies: recovery then
 *           comes from the Sequencer's 5-min redispatch lease (R4) — a harsher path than a real pause.
 *           It validates the gate logic and the topology before touching Cloudflare, and is what the
 *           physical-installation gate of the release runs. It never replaces the cloud gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EDGE_DIR } from '../paths.mjs';
import { MAIN } from '../render.mjs';
import { names } from '../naming.mjs';

export function cloudTarget({ subdomain, wrangler, plan, api, queueIds = {} }) {
  const ingressName = names.ingress('staging');
  const url = (name) => `https://${name}.${subdomain}.workers.dev`;
  const ingressWorker = plan.workers.find(w => w.role === 'ingress');
  return {
    kind: 'cloud',
    fetch: (u, init) => fetch(u, { ...init, signal: AbortSignal.timeout(30000) }),
    base: { ingress: url(names.ingress('staging')), admin: url(names.admin('staging')), receiver: (id) => url(names.receiver('staging', id)) },
    pause: async (queue) => { await wrangler.pauseDelivery(queue); },
    resume: async (queue) => { await wrangler.resumeDelivery(queue); },
    // Same bytes, same config, new version: this restarts the Durable Object on Cloudflare.
    redeployIngress: async () => { await wrangler.deploy(ingressWorker.configPath); },
    dlqBacklog: async (queue) => (queueIds[queue] ? api.queueBacklog(queueIds[queue]) : null),
    deploymentId: () => api.latestDeploymentId(ingressName),
    // Cloudflare needs time: queue delivery, retries (2 s WAIT, 60 s HALT) and leases (60 s).
    timeScale: 1,
    close: async () => {},
  };
}

export async function localTarget({ plan, secrets, persistDir, bundleDir, wrangler, initiallyPaused = [] }) {
  const require = createRequire(path.join(EDGE_DIR, 'package.json'));
  const { unstable_getMiniflareWorkerOptions } = await import(require.resolve('wrangler'));
  const { Miniflare } = await import(require.resolve('miniflare'));

  for (const w of plan.workers) await wrangler.dryRun(w.configPath, path.join(bundleDir, w.name));

  const secretsOf = (w) => {
    if (w.role === 'ingress') return { WEBHOOK_PATH_TOKEN: secrets.WEBHOOK_PATH_TOKEN, HALT_NOTIFY_URL: secrets.HALT_NOTIFY_URL };
    if (w.role === 'receiver') return { CONTROL_TOKEN: secrets.CONTROL_TOKEN[w.dest] };
    if (w.role === 'admin') return { ADMIN_TOKEN: secrets.ADMIN_TOKEN };
    return {};
  };
  const quiet = (fn) => { const a = console.log, b = console.warn; console.log = console.warn = () => {}; try { return fn(); } finally { console.log = a; console.warn = b; } };
  const detached = new Set(initiallyPaused);

  function options() {
    return plan.workers.map((w) => {
      const { workerOptions: o } = quiet(() => unstable_getMiniflareWorkerOptions(w.configPath));
      const dir = path.join(bundleDir, w.name);
      const durableObjects = { ...(o.durableObjects || {}) };
      for (const d of Object.values(durableObjects)) if (d.scriptName) d.useSQLite = true;
      let queueConsumers = o.queueConsumers || {};
      if (w.role === 'consumer' && detached.has(names.queue('staging', w.dest))) queueConsumers = {};
      return {
        name: w.name,
        modules: [{ type: 'ESModule', path: path.join(dir, path.basename(MAIN[w.role])) }],
        modulesRoot: dir,
        compatibilityDate: o.compatibilityDate, compatibilityFlags: o.compatibilityFlags,
        bindings: { ...o.bindings, ...secretsOf(w) },
        queueProducers: o.queueProducers, queueConsumers, durableObjects, serviceBindings: o.serviceBindings,
        routes: [`${w.name}.local.test/*`],
        // Egress from the rehearsal is refused (HALT_NOTIFY_URL is a .invalid host anyway).
        outboundService: () => new Response('rehearsal: egress disabled', { status: 503 }),
      };
    });
  }

  fs.mkdirSync(persistDir, { recursive: true });
  const logs = [];
  const mfOpts = () => ({ workers: options(), defaultPersistRoot: persistDir,
                          handleRuntimeStdio: (o, e) => { for (const s of [o, e]) s.on('data', b => logs.push(String(b))); } });
  let mf = new Miniflare(mfOpts());
  await mf.ready;
  const restart = async () => { await mf.setOptions(mfOpts()); };
  const local = (name) => `http://${name}.local.test`;

  return {
    kind: 'local',
    fetch: async (u, init = {}) => mf.dispatchFetch(u, init),
    base: { ingress: local(names.ingress('staging')), admin: local(names.admin('staging')), receiver: (id) => local(names.receiver('staging', id)) },
    pause: async (queue) => { detached.add(queue); await restart(); },
    resume: async (queue) => { detached.delete(queue); await restart(); },
    redeployIngress: restart,
    dlqBacklog: async () => null,
    deploymentId: async () => null,
    timeScale: 1,
    runtimeLog: () => logs.join(''),
    close: async () => { await mf.dispose(); },
  };
}
