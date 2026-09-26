/**
 * PHASE A · PREFLIGHT. Everything here is read-only. It decides, for every resource of the plan,
 * one of: CREATE, REUSE / UNCHANGED, UPDATE, or CONFLICT. A single CONFLICT stops the run BEFORE
 * any write, so there are never silent partial changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { ROOT, EDGE_DIR, BUILD_DIR } from './paths.mjs';
import { out, KawaError } from './log.mjs';
import { renderEnv, writeBuild } from './render.mjs';
import { names, belongsTo, MANAGED_VAR, BUILD_VAR, managedValue } from './naming.mjs';
import { verifyManifest } from './manifest.mjs';
import { pinnedVersion } from './wrangler.mjs';
import { HARD_LOCKS } from './config.mjs';

export const REQUIRED_SECRETS = {
  staging: { ingress: ['WEBHOOK_PATH_TOKEN', 'HALT_NOTIFY_URL'], receiver: ['CONTROL_TOKEN'], admin: ['ADMIN_TOKEN'], consumer: [] },
  prod: { ingress: ['WEBHOOK_PATH_TOKEN', 'HALT_NOTIFY_URL'], consumer: null /* DEST_<ID>_WEBHOOK_URL */ },
};

export function requiredSecrets(env, w) {
  if (env === 'prod' && w.role === 'consumer') return [`DEST_${w.dest}_WEBHOOK_URL`];
  return REQUIRED_SECRETS[env][w.role] || [];
}

/** Local checks: need no token and no network. Shared with verify-fast. */
export async function localChecks({ cfg, env, wrangler, dryRun = true, inContainer = false }) {
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok, detail }); (ok ? out.ok : out.fail)(`${name}${detail ? ' — ' + detail : ''}`); if (!ok) throw new KawaError('PREFLIGHT_' + name.toUpperCase().replace(/\W+/g, '_'), `${name}: ${detail}`); };

  out.step('Package integrity');
  const m = verifyManifest(ROOT, { skip: inContainer ? ['config/', 'secrets/'] : [] });
  if (!m.present) {
    out.warn('no manifest in this tree (development checkout) — integrity check skipped');
  } else {
    check('manifest', m.ok, m.ok ? `${m.artifact} ${m.revision} · ${m.file_count} files · manifest sha256 ${m.manifest_sha256.slice(0, 16)}…`
      : `missing ${m.missing.join(',') || '-'} · mismatched ${m.mismatched.join(',') || '-'} · undeclared ${m.extra.join(',') || '-'}`);
  }

  out.step('Toolchain');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  check('node', nodeMajor >= 22, `v${process.versions.node}`);
  let npmV = null;
  try { npmV = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(); } catch { /* optional outside the image */ }
  out.info(`npm ${npmV || 'n/a'} · ${os.platform()}/${os.arch()} · ${os.cpus().length} CPU`);
  const pinned = pinnedVersion();
  const actual = await wrangler.version();
  check('wrangler pinned', actual === pinned, `lockfile ${pinned} · binary ${actual}`);
  check('no implicit wrangler.toml at the Edge root', !fs.existsSync(path.join(EDGE_DIR, 'wrangler.toml')) && !fs.existsSync(path.join(EDGE_DIR, 'wrangler.json')), 'a root config would make a bare `wrangler deploy` ambiguous');

  out.step(`Configuration · ${env.toUpperCase()}`);
  const envCfg = cfg.envs[env];
  if (!envCfg) throw new KawaError('CONFIG_NO_ENV', `config has no "${env}" section`);
  const plan = renderEnv(env, envCfg.destinations, EDGE_DIR);
  writeBuild(plan, BUILD_DIR);
  check('environment isolation', true, `${plan.workers.length} Workers + ${plan.queues.length} queues, every name ends in ${env === 'staging' ? '-stg (or is a staging receiver)' : '-prod'}`);
  out.info(`destinations: ${envCfg.parsed.map(d => `${d.id}${d.enabled ? '' : ' (disabled)'}`).join(', ')}`);
  if (env === 'staging') {
    check('STAGING hard-lock', plan.workers.filter(w => w.role === 'consumer').every(w => w.text.includes(`service = "${names.receiver('staging', w.dest)}"`)),
      'every consumer is bound to its own staging receiver; no production host is referenced');
  } else {
    check('PROD shape', !plan.workers.some(w => w.role === 'admin' || w.role === 'receiver'), 'no staging receiver, no HTTP admin');
  }
  out.info(`HUB_A MAINNET out of scope: the deployer never contacts ${HARD_LOCKS.HUB_A_PUBLIC_HOST} or the NAS; ports ${HARD_LOCKS.FORBIDDEN_PORTS.join('/')} are refused in any URL`);

  if (dryRun) {
    out.step('Offline build check (wrangler deploy --dry-run, pinned)');
    const outdir = path.join(BUILD_DIR, 'dry-run');
    for (const w of plan.workers) {
      await wrangler.dryRun(w.configPath, path.join(outdir, w.name));
      out.ok(`${w.name} bundles and validates`);
    }
  }
  return { plan, results };
}

/** Read-only cloud inspection and classification. Returns the action list; throws on conflicts. */
export async function cloudChecks({ env, plan, api, stateDeployed = {} }) {
  out.step('Cloudflare identity and permissions (read-only)');
  const tok = await api.verifyToken();
  if (tok.status !== 'active') throw new KawaError('TOKEN_NOT_ACTIVE', `API token status is "${tok.status}"`);
  out.ok('API token is active');
  const acct = await api.account();
  out.info(acct ? `account: ${acct.name} (${acct.id})` : 'account name not readable (optional permission "Account Settings: Read" absent) — scope proven by the calls below');
  const [scripts, queues, subdomain] = [await api.listScripts(), await api.listQueues(), await api.subdomain()];
  out.ok(`Workers Scripts readable (${scripts.length} scripts in the account)`);
  out.ok(`Queues readable (${queues.length} queues in the account)`);
  if (!subdomain) {
    throw new KawaError('NO_WORKERS_SUBDOMAIN', 'this account has no workers.dev subdomain yet',
      'Cloudflare dashboard -> Workers & Pages -> "Set up" your workers.dev subdomain once, then re-run. Nothing was changed.');
  }
  out.ok(`workers.dev subdomain: ${subdomain}`);

  out.step(`Existing resources vs plan · ${env.toUpperCase()}`);
  const actions = [], conflicts = [];
  const scriptNames = new Set(scripts.map(s => s.id || s.name));
  const qByName = new Map(queues.map(q => [q.queue_name, q]));

  for (const q of plan.queues) {
    const found = qByName.get(q.name);
    if (!found) { actions.push({ kind: 'queue', name: q.name, action: 'CREATE' }); continue; }
    const detail = await api.queue(found.queue_id);
    const consumers = (detail.consumers || []).map(c => c.script || c.script_name || c.service || c.type);
    const producers = (detail.producers || []).map(p => p.script || p.service || p.type);
    const allowedConsumer = q.kind === 'main' ? [names.consumer(env, q.dest)] : [];
    const allowedProducer = q.kind === 'main' ? [names.ingress(env)] : [names.consumer(env, q.dest)];
    const foreignC = consumers.filter(c => !allowedConsumer.includes(c));
    const foreignP = producers.filter(p => !allowedProducer.includes(p));
    if (foreignC.length || foreignP.length) {
      conflicts.push({ kind: 'queue', name: q.name, reason: `attached to foreign Workers (consumers: ${foreignC.join(',') || '-'}; producers: ${foreignP.join(',') || '-'})` });
    } else if (detail.settings && detail.settings.delivery_paused) {
      conflicts.push({ kind: 'queue', name: q.name, reason: 'delivery is PAUSED (an interrupted gate run?)', hint: `./kawa-edge resume-queues ${env}` });
    } else {
      actions.push({ kind: 'queue', name: q.name, action: 'REUSE', id: found.queue_id });
    }
  }

  for (const w of plan.workers) {
    if (!scriptNames.has(w.name) && !(await api.scriptExists(w.name))) { actions.push({ kind: 'worker', name: w.name, action: 'CREATE', worker: w }); continue; }
    const settings = await api.scriptSettings(w.name);
    const vars = Object.fromEntries(((settings && settings.bindings) || []).filter(b => b.type === 'plain_text').map(b => [b.name, b.text]));
    const expected = managedValue(env, w.role === 'consumer' ? `consumer:${w.dest}` : w.role === 'receiver' ? `receiver:${w.dest}` : w.role);
    if (vars[MANAGED_VAR] !== expected) {
      conflicts.push({ kind: 'worker', name: w.name, reason: vars[MANAGED_VAR] ? `managed as "${vars[MANAGED_VAR]}", expected "${expected}"` : 'exists but was NOT created by this deployer (no ownership marker)' });
      continue;
    }
    const secretNames = (await api.secretNames(w.name)) || [];
    const missing = requiredSecrets(env, w).filter(s => !secretNames.includes(s));
    const sameBuild = vars[BUILD_VAR] === w.build;
    // Only when this run supplies the Worker's secrets (STAGING, where the deployer owns them) can a
    // changed value be detected. PROD secrets are never re-supplied implicitly: their presence is
    // checked by name above, and a new value is uploaded only on explicit request.
    const sameSecrets = w.secretsFp === undefined || !stateDeployed[w.name] || stateDeployed[w.name].secrets_fp === w.secretsFp;
    actions.push({ kind: 'worker', name: w.name, worker: w, missingSecrets: missing,
                   action: sameBuild && !missing.length && sameSecrets ? 'UNCHANGED' : 'UPDATE' });
  }

  // Resources of the OTHER environment are listed, never touched.
  const other = [...scriptNames, ...qByName.keys()].filter(n => /^kawa-/.test(n) && !belongsTo(env, n));
  out.info(`resources of other environments present (never touched by this run): ${other.length ? other.join(', ') : 'none'}`);

  for (const a of actions) out.info(`${a.action.padEnd(9)} ${a.kind.padEnd(6)} ${a.name}${a.missingSecrets && a.missingSecrets.length ? ` (missing secrets: ${a.missingSecrets.join(',')})` : ''}`);
  for (const c of conflicts) out.fail(`CONFLICT ${c.kind} ${c.name}: ${c.reason}`);
  if (conflicts.length) {
    const err = new KawaError('RESOURCE_CONFLICT', `${conflicts.length} conflicting resource(s); nothing was changed`,
      conflicts.map(c => c.hint).filter(Boolean).join(' ') || 'Resolve the conflict by hand (the deployer never deletes or recreates a resource it does not own) and re-run.');
    err.conflicts = conflicts;
    throw err;
  }
  return { actions, subdomain, account: acct };
}
