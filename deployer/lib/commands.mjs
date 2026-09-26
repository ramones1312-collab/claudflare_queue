/**
 * Command implementations. Each returns { result: 'PASS'|'FAIL'|'BLOCKED', detail?, report? }.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from './config.mjs';
import { out, KawaError, redact } from './log.mjs';
import { createWrangler } from './wrangler.mjs';
import { createCfApi } from './cfapi.mjs';
import { validateHaltUrl, acquireApiToken, ensureStagingSecrets, loadStagingSecrets, promptHidden, promptLine, deleteStagingSecrets } from './secrets.mjs';
import { localChecks, cloudChecks } from './preflight.mjs';
import { execute, loadDeployed, secretsFingerprint } from './deploy.mjs';
import { runGates, repairStaging } from './gates/run.mjs';
import { cloudTarget, localTarget } from './gates/targets.mjs';
import { names } from './naming.mjs';
import { edgeSourcesHash, stagingBindingHash } from './render.mjs';
import { pinnedVersion } from './wrangler.mjs';
import { EDGE_DIR } from './paths.mjs';
import { BUILD_DIR, STATE_DIR } from './paths.mjs';
import * as prod from './prod.mjs';
import * as release from './release.mjs';
import * as addhub from './addhub.mjs';

export function flags(args) {
  const f0 = parse(args);
  if (f0.env !== undefined && !['staging', 'prod'].includes(f0.env)) throw new KawaError('USAGE_ENV', `--env must be staging or prod (got "${f0.env}")`);
  return f0;
}
function parse(args) {
  const f = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const v = eq < 0 ? undefined : a.slice(eq + 1);
      if (v !== undefined) f[k] = v;
      else if (args[i + 1] && !args[i + 1].startsWith('--') && ['env', 'target', 'timeout-ms', 'files', 'out', 'webhook-host', 'set-webhook', 'yes'].includes(k)) f[k] = args[++i];
      else f[k] = true;
    } else f._.push(a);
  }
  return f;
}

/** Every Hub ingress host known to the config, plus HUB_A's hard-locked host. */
export function hubHostsOf(cfg) {
  return [...((cfg.envs.prod && cfg.envs.prod.destinations) || []).map(d => d.webhook_host).filter(Boolean)];
}

export function timer() {
  const marks = {}; let last = Date.now();
  return { mark(k) { marks[k] = Date.now() - last; last = Date.now(); }, marks };
}

export async function cloudContext(cfg) {
  out.step('Cloudflare credentials');
  const token = await acquireApiToken();
  const api = createCfApi({ token, accountId: cfg.account_id });
  const wrangler = createWrangler({ token, accountId: cfg.account_id });
  return { token, api, wrangler };
}

export function writeReport(kind, data) {
  const dir = path.join(STATE_DIR, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, redact(JSON.stringify(data, null, 2)));   // defence in depth
  return file;
}

/** STAGING secrets per Worker role. */
export function stagingSecretsFor(secrets) {
  return (w) => {
    if (w.role === 'ingress') return { WEBHOOK_PATH_TOKEN: secrets.WEBHOOK_PATH_TOKEN, HALT_NOTIFY_URL: secrets.HALT_NOTIFY_URL };
    if (w.role === 'receiver') return { CONTROL_TOKEN: secrets.CONTROL_TOKEN[w.dest] };
    if (w.role === 'admin') return { ADMIN_TOKEN: secrets.ADMIN_TOKEN };
    return null;
  };
}

function gateDests(cfg) {
  const ids = cfg.envs.staging.parsed.filter(d => d.enabled).map(d => d.id);
  if (ids.length < 2) throw new KawaError('GATES_NEED_TWO_DESTINATIONS', 'the STAGING gates need at least two enabled destinations (isolation gates)');
  return ids.slice(0, 2);
}
function gateOutcome(g) {
  if (g.result === 'PARTIAL') return { result: 'BLOCKED', detail: 'STAGING PARTIAL: a gate was skipped (--quick); this is NOT a STAGING PASS', report: g.file };
  return { result: g.result, detail: `STAGING ${g.result}`, report: g.file };
}
const enabledIds = (cfg) => cfg.envs.staging.parsed.filter(d => d.enabled).map(d => d.id);

async function stagingPrepare(ctx, f) {
  const tm = timer();
  const cfg = await loadConfig(ctx.configFile);
  const local = await localChecks({ cfg, env: 'staging', wrangler: createWrangler({ quiet: true }), inContainer: !!process.env.KAWA_IN_CONTAINER });
  tm.mark('local_preflight_ms');
  const cloud = await cloudContext(cfg);
  let halt = null;
  const hubHosts = hubHostsOf(cfg);
  if (!loadStagingSecrets()) {
    halt = await promptHidden('STAGING halt-notification URL (optional, input hidden; Enter = none): ').catch(() => '');
    if (halt) validateHaltUrl(halt, hubHosts);
  }
  const { secrets, created } = ensureStagingSecrets(local.plan.workers.filter(w => w.role === 'receiver').map(w => w.dest), halt || null, hubHosts);
  if (created.length) out.info(`STAGING tokens generated: ${created.join(', ')} (kept in state/staging/secrets.json, 0600)`);
  const secretsFor = stagingSecretsFor(secrets);
  for (const w of local.plan.workers) w.secretsFp = secretsFingerprint(secretsFor(w));
  const pre = await cloudChecks({ env: 'staging', plan: local.plan, api: cloud.api, stateDeployed: loadDeployed('staging') });
  tm.mark('cloud_preflight_ms');
  return { cfg, local, cloud, secrets, secretsFor, pre, tm };
}

export const COMMANDS = {
  'verify-fast': {
    help: 'FAST PREFLIGHT (no Cloudflare, ~1 min): manifest, toolchain, config, isolation, offline bundle check, deployer unit tests',
    run: async (ctx) => release.verifyFast(ctx, flags(ctx.args)),
  },
  'test-targeted': {
    help: 'TARGETED TEST: only the suites affected by files changed vs the manifest (or --files a,b)',
    run: async (ctx) => release.testTargeted(ctx, flags(ctx.args)),
  },
  'test-full': {
    help: 'FULL RELEASE GATE: whole Edge suite (parallel by file) + deployer suite; evidence bound to the input-tree hash',
    run: async (ctx) => release.testFull(ctx, flags(ctx.args)),
  },
  package: {
    help: 'Build the deterministic release ZIP (reuses test-full evidence for the same bytes; never re-runs it)',
    run: async (ctx) => release.packageRelease(ctx, flags(ctx.args)),
  },
  'verify-release': {
    help: 'Short gate on a packaged ZIP: sha256, manifest, evidence binding, fast checks on the extracted tree',
    run: async (ctx) => release.verifyRelease(ctx, flags(ctx.args)),
  },

  preflight: {
    help: 'PHASE A: read-only checks against Cloudflare (identity, permissions, existing resources, conflicts). Changes nothing',
    run: async (ctx) => {
      const f = flags(ctx.args);
      const env = f.env || 'staging';
      const cfg = await loadConfig(ctx.configFile);
      const local = await localChecks({ cfg, env, wrangler: createWrangler({ quiet: true }), inContainer: !!process.env.KAWA_IN_CONTAINER });
      const cloud = await cloudContext(cfg);
      const pre = await cloudChecks({ env, plan: local.plan, api: cloud.api, stateDeployed: loadDeployed(env) });
      const file = writeReport(`preflight-${env}`, { env, actions: pre.actions.map(a => ({ kind: a.kind, name: a.name, action: a.action })), subdomain: pre.subdomain });
      return { result: 'PASS', detail: `${env.toUpperCase()}: ${pre.actions.filter(a => a.action !== 'REUSE' && a.action !== 'UNCHANGED').length} change(s) planned, no conflict`, report: file };
    },
  },

  install: {
    help: 'PHASE A+B: preflight -> deploy STAGING (idempotent) -> all STAGING gates -> STAGING PASS/FAIL',
    run: async (ctx) => {
      const f = flags(ctx.args);
      const p = await stagingPrepare(ctx, f);
      const done = await execute({ env: 'staging', actions: p.pre.actions, api: p.cloud.api, wrangler: p.cloud.wrangler, secretsFor: p.secretsFor, force: !!f.force });
      p.tm.mark('deploy_ms');
      if (f['no-gates']) {
        const file = writeReport('install-staging', { result: 'DEPLOYED_NO_GATES', applied: done, timings: p.tm.marks });
        return { result: 'BLOCKED', detail: 'STAGING deployed; gates NOT run (--no-gates) — no STAGING PASS', report: file };
      }
      const queueIds = Object.fromEntries((await p.cloud.api.listQueues()).map(q => [q.queue_name, q.queue_id]));
      const target = cloudTarget({ subdomain: p.pre.subdomain, wrangler: p.cloud.wrangler, plan: p.local.plan, api: p.cloud.api, queueIds });
      const dests = gateDests(p.cfg);
      if (f.repair) await repairStaging(target, p.secrets, dests);
      const g = await runGates({ target, secrets: p.secrets, dests, all: enabledIds(p.cfg), includeLong: !f.quick, evidenceDir: path.join(STATE_DIR, 'evidence'),
                                 meta: { edge_sources_sha256: edgeSourcesHash(EDGE_DIR), binding_sha256: stagingBindingHash(EDGE_DIR, pinnedVersion()), builds: Object.fromEntries(p.local.plan.workers.map(w => [w.name, w.build])) } });
      p.tm.mark('gates_ms');
      writeReport('install-staging', { result: g.result, applied: done, gates_evidence: g.file, timings: p.tm.marks });
      return gateOutcome(g);
    },
  },

  gates: {
    help: 'Re-run the STAGING gates against the deployed STAGING (flags: --repair, --quick to skip the 6-min long gate)',
    run: async (ctx) => {
      const f = flags(ctx.args);
      const p = await stagingPrepare(ctx, f);
      const pending = p.pre.actions.filter(a => a.kind === 'worker' && a.action !== 'UNCHANGED');
      if (pending.length) throw new KawaError('STAGING_NOT_CURRENT', `STAGING is not the current build (${pending.map(a => a.name).join(', ')})`, 'Run ./kawa-edge install first.');
      const queueIds = Object.fromEntries((await p.cloud.api.listQueues()).map(q => [q.queue_name, q.queue_id]));
      const target = cloudTarget({ subdomain: p.pre.subdomain, wrangler: p.cloud.wrangler, plan: p.local.plan, api: p.cloud.api, queueIds });
      const dests = gateDests(p.cfg);
      if (f.repair) await repairStaging(target, p.secrets, dests);
      const g = await runGates({ target, secrets: p.secrets, dests, all: enabledIds(p.cfg), includeLong: !f.quick, evidenceDir: path.join(STATE_DIR, 'evidence'),
                                 meta: { edge_sources_sha256: edgeSourcesHash(EDGE_DIR), binding_sha256: stagingBindingHash(EDGE_DIR, pinnedVersion()), builds: Object.fromEntries(p.local.plan.workers.map(w => [w.name, w.build])) } });
      return gateOutcome(g);
    },
  },

  rehearse: {
    help: 'Run the full STAGING gate suite LOCALLY (Miniflare, same configs and bundles) — no Cloudflare, no token',
    run: async (ctx) => {
      const f = flags(ctx.args);
      const cfg = await loadConfig(ctx.configFile);
      const wrangler = createWrangler({ quiet: true });
      const local = await localChecks({ cfg, env: 'staging', wrangler, dryRun: false, inContainer: !!process.env.KAWA_IN_CONTAINER });
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kawa-rehearsal-'));
      const { randomToken } = await import('./secrets.mjs');
      const dests = gateDests(cfg);
      const secrets = { WEBHOOK_PATH_TOKEN: randomToken(), ADMIN_TOKEN: randomToken(), HALT_NOTIFY_URL: 'https://halt-notify.invalid/rehearsal',
                        CONTROL_TOKEN: Object.fromEntries(local.plan.workers.filter(w => w.role === 'receiver').map(w => [w.dest, randomToken()])) };
      out.step('Starting the local STAGING topology (Miniflare/workerd, exact dry-run bundles)');
      const target = await localTarget({ plan: local.plan, secrets, persistDir: path.join(tmp, 'persist'), bundleDir: path.join(tmp, 'bundles'), wrangler });
      try {
        const g = await runGates({ target, secrets, dests, all: enabledIds(cfg), includeLong: false, evidenceDir: path.join(STATE_DIR, 'evidence'),
                                   meta: { note: 'LOCAL REHEARSAL — does not replace the Cloudflare STAGING gate' } });
        return { result: g.result === 'PASS' ? 'PASS' : 'FAIL', detail: `LOCAL REHEARSAL ${g.result} (not a STAGING PASS)`, report: g.file };
      } finally {
        await target.close();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  },

  'resume-queues': {
    help: 'Resume delivery on every queue of an environment (after an interrupted gate run). --env staging|prod',
    run: async (ctx) => {
      const f = flags(ctx.args); const env = f.env || f._[0] || 'staging';
      const cfg = await loadConfig(ctx.configFile);
      if (!cfg.envs[env]) throw new KawaError('CONFIG_NO_ENV', `config has no "${env}" section`);
      const cloud = await cloudContext(cfg);
      for (const d of cfg.envs[env].parsed) { await cloud.wrangler.resumeDelivery(names.queue(env, d.id)); out.ok(`resumed ${names.queue(env, d.id)}`); }
      return { result: 'PASS' };
    },
  },

  status: {
    help: 'Show deployed state: Workers, queues, secrets present; STAGING also Sequencer heads/halts and receivers. --env staging|prod',
    run: async (ctx) => prod.status(ctx, flags(ctx.args)),
  },

  'add-hub': {
    help: 'Add a destination without code changes: ./kawa-edge add-hub HUB_C --env staging|prod [--timeout-ms N] [--disabled] [--webhook-host H]',
    run: async (ctx) => addhub.addHub(ctx, flags(ctx.args)),
  },

  'staging-teardown': {
    help: 'Delete the STAGING Workers (and with --queues its queues) after exporting evidence. Asks for confirmation',
    run: async (ctx) => prod.stagingTeardown(ctx, flags(ctx.args)),
  },

  'prod-deploy': {
    help: 'PHASE C: deploy the PROD Edge in parallel, INERT (TradingView unchanged). Needs STAGING PASS evidence',
    run: async (ctx) => prod.prodDeploy(ctx, flags(ctx.args)),
  },
  'hub-check': {
    help: 'PHASE C: Edge -> Hub transport check by a NON-TRADING method (BLOCKED until the Hub contract provides one)',
    run: async (ctx) => prod.hubCheck(ctx, flags(ctx.args)),
  },
  'cutover-check': {
    help: 'PHASE D: evaluate every cutover precondition and print PASS / BLOCKED with reasons. Changes nothing',
    run: async (ctx) => prod.cutoverCheck(ctx, flags(ctx.args)),
  },
  cutover: {
    help: 'PHASE D: only if cutover-check passes and the owner types the approval phrase: rotate the PROD path token and show the TradingView URL once',
    run: async (ctx) => prod.cutover(ctx, flags(ctx.args)),
  },
  'rollback-transport': {
    help: 'Immediate transport rollback checklist (TradingView -> direct HUB_A webhook). Changes nothing in Cloudflare',
    run: async (ctx) => prod.rollbackTransport(ctx, flags(ctx.args)),
  },
  tail: {
    help: 'Stream redacted Worker logs (read-only, needs "Workers Tail: Read"): ./kawa-edge tail <worker-name>',
    run: async (ctx) => prod.tail(ctx, flags(ctx.args)),
  },
};
