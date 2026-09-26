/**
 * Executes a preflight-approved action list, in plan order: queues first, then Workers in the
 * dependency order renderEnv() produced. Every Worker deploy uses the pinned wrangler with an
 * explicit --config; secrets travel only through a shredded --secrets-file. After each deploy the
 * ownership marker, build digest and required secret NAMES are read back from Cloudflare.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from './paths.mjs';
import { out, KawaError } from './log.mjs';
import { withSecretsFile } from './secrets.mjs';
import { MANAGED_VAR, BUILD_VAR } from './naming.mjs';
import { requiredSecrets } from './preflight.mjs';

export function secretsFingerprint(values) {
  if (!values || !Object.keys(values).length) return null;
  const h = crypto.createHash('sha256');
  for (const k of Object.keys(values).sort()) h.update(`${k}\0${values[k]}\n`);
  return h.digest('hex');
}

const deployedFile = (env) => path.join(STATE_DIR, env, 'deployed.json');
export function loadDeployed(env) {
  try { return JSON.parse(fs.readFileSync(deployedFile(env), 'utf8')); } catch { return {}; }
}
function saveDeployed(env, d) {
  fs.mkdirSync(path.dirname(deployedFile(env)), { recursive: true });
  fs.writeFileSync(deployedFile(env), JSON.stringify(d, null, 2));
}

/**
 * @param secretsFor (worker) => { NAME: value } | null   secrets to upload with that Worker
 */
export async function execute({ env, actions, api, wrangler, secretsFor, force = false }) {
  const done = [];
  const deployed = loadDeployed(env);
  out.step(`Applying ${env.toUpperCase()} plan`);
  for (const a of actions.filter(a => a.kind === 'queue')) {
    if (a.action === 'CREATE') {
      await api.createQueue(a.name);
      out.ok(`queue created: ${a.name}`);
      done.push({ ...a, result: 'CREATED' });
    } else {
      out.ok(`queue reused: ${a.name}`);
      done.push({ ...a, result: 'REUSED' });
    }
  }
  for (const a of actions.filter(a => a.kind === 'worker')) {
    const w = a.worker;
    const secrets = secretsFor(w) || {};
    if (a.action === 'UNCHANGED' && !force) {
      out.ok(`unchanged, not redeployed: ${w.name}`);
      done.push({ kind: 'worker', name: w.name, result: 'UNCHANGED', build: w.build });
      continue;
    }
    out.info(`deploying ${w.name} (${a.action === 'CREATE' ? 'new' : 'update'}) --config ${path.basename(w.configPath)}${Object.keys(secrets).length ? ` + secrets: ${Object.keys(secrets).join(', ')}` : ''}`);
    if (Object.keys(secrets).length) await withSecretsFile(secrets, (file) => wrangler.deploy(w.configPath, file));
    else await wrangler.deploy(w.configPath);

    // Read back what Cloudflare now holds.
    const settings = await api.scriptSettings(w.name);
    const vars = Object.fromEntries(((settings && settings.bindings) || []).filter(b => b.type === 'plain_text').map(b => [b.name, b.text]));
    if (vars[BUILD_VAR] !== w.build || !vars[MANAGED_VAR]) {
      throw new KawaError('DEPLOY_READBACK_MISMATCH', `${w.name}: Cloudflare does not report the build just deployed`);
    }
    const names = (await api.secretNames(w.name)) || [];
    const missing = requiredSecrets(env, w).filter(s => !names.includes(s));
    if (missing.length) throw new KawaError('SECRET_MISSING_AFTER_DEPLOY', `${w.name}: required secret(s) not present: ${missing.join(', ')}`);
    // Secret fingerprints are kept for STAGING only (values the deployer owns). A PROD Hub URL never
    // leaves a digest on disk that could be brute-forced offline.
    const fp = env === 'staging' ? (secretsFingerprint(secrets) || (deployed[w.name] && deployed[w.name].secrets_fp) || null) : null;
    deployed[w.name] = { build: w.build, secrets_fp: fp, at: new Date().toISOString() };
    saveDeployed(env, deployed);
    out.ok(`${w.name} deployed · build ${w.build.slice(0, 12)} · secrets present: ${requiredSecrets(env, w).join(', ') || 'none required'}`);
    done.push({ kind: 'worker', name: w.name, result: a.action === 'CREATE' ? 'CREATED' : 'UPDATED', build: w.build });
  }
  return done;
}
