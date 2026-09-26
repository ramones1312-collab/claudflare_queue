/**
 * add-hub · a new destination without touching code or hand-editing TOML.
 *
 *   ./kawa-edge add-hub HUB_C --env staging [--timeout-ms 10000] [--disabled]
 *   ./kawa-edge add-hub HUB_C --env prod --webhook-host hub-c.example.com
 *
 * Creates its queue and DLQ, (STAGING) its own receiver, its own consumer with its own secret
 * (PROD), then updates the ingress DESTINATIONS + producer. BLAST-RADIUS GUARD: no existing
 * consumer or receiver may change — each consumer carries only its own DESTINATIONS entry, so the
 * other Hubs' Workers are left exactly as they are. The new Hub starts at the next accepted alert.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { loadConfig, validateConfig, writeConfig } from './config.mjs';
import { out, KawaError } from './log.mjs';
import { createWrangler } from './wrangler.mjs';
import { localChecks, cloudChecks } from './preflight.mjs';
import { execute, loadDeployed, secretsFingerprint } from './deploy.mjs';
import { names } from './naming.mjs';
import { promptHidden, validateWebhookUrl, checkAndRecordFingerprint, ensureStagingSecrets, loadStagingSecrets } from './secrets.mjs';
import { cloudContext, writeReport, stagingSecretsFor } from './commands.mjs';

export async function addHub(ctx, f) {
  const id = String(f._[0] || '').toUpperCase();
  const env = f.env || 'staging';
  if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(id)) throw new KawaError('ADD_HUB_ID', 'usage: ./kawa-edge add-hub HUB_C --env staging|prod');
  const cfg = await loadConfig(ctx.configFile);
  const raw = JSON.parse(JSON.stringify(cfg.raw));
  if (!raw[env]) throw new KawaError('CONFIG_NO_ENV', `config has no "${env}" section`);
  const existing = raw[env].destinations.find(d => d.id === id);
  if (existing && !f.resume) throw new KawaError('ADD_HUB_EXISTS', `${id} is already configured in ${env}`, 'To finish an interrupted add-hub, re-run with --resume.');
  if (!existing) {
    const dest = { id, enabled: !f.disabled, timeout_ms: Number(f['timeout-ms'] || 10000) };
    if (env === 'prod') {
      if (!f['webhook-host']) throw new KawaError('ADD_HUB_HOST', 'PROD needs --webhook-host <public hostname of that Hub\'s INGRESS>');
      dest.webhook_host = String(f['webhook-host']).toLowerCase();
    }
    raw[env].destinations.push(dest);
  }
  const next = await validateConfig(raw);           // the Edge registry validates the new list
  const before = new Set(cfg.envs[env].destinations.map(d => d.id));

  const local = await localChecks({ cfg: next, env, wrangler: createWrangler({ quiet: true }), inContainer: !!process.env.KAWA_IN_CONTAINER });
  const cloud = await cloudContext(next);
  let secretsFor = () => null;
  let commit = () => {};
  if (env === 'staging') {
    const { secrets } = ensureStagingSecrets(next.envs.staging.parsed.map(d => d.id), null);
    secretsFor = stagingSecretsFor(secrets);
    for (const w of local.plan.workers) w.secretsFp = secretsFingerprint(secretsFor(w));
  }
  const pre = await cloudChecks({ env, plan: local.plan, api: cloud.api, stateDeployed: loadDeployed(env) });

  // Blast-radius guard: only the new Hub's resources and the ingress may change.
  const mine = new Set([names.consumer(env, id), env === 'staging' ? names.receiver(env, id) : null, names.ingress(env)]);
  const collateral = pre.actions.filter(a => a.kind === 'worker' && a.action !== 'UNCHANGED' && !mine.has(a.name));
  if (collateral.length) {
    throw new KawaError('ADD_HUB_COLLATERAL', `adding ${id} would also change ${collateral.map(a => a.name).join(', ')}`,
      'Those Workers are not current. Run ./kawa-edge install (STAGING) or prod-deploy first; add-hub only adds.');
  }
  if (env === 'prod') {
    const dest = next.envs.prod.destinations.find(d => d.id === id);
    out.info(`${id}: its OWN webhook URL — https://${dest.webhook_host}/webhook/<secret>. Never another Hub's credential.`);
    const url = validateWebhookUrl(await promptHidden(`DEST_${id}_WEBHOOK_URL (input hidden, never stored): `), dest.webhook_host);
    commit = checkAndRecordFingerprint(id, url);
    secretsFor = (w) => (w.role === 'consumer' && w.dest === id ? { [`DEST_${id}_WEBHOOK_URL`]: url } : null);
  }
  // Order: queues -> (receiver) -> NEW consumer -> ingress. The consumer exists before the ingress
  // starts fanning out to it, so the new queue never accumulates an unconsumed backlog.
  const rank = (a) => a.kind === 'queue' ? 0 : a.worker.role === 'receiver' ? 1 : a.worker.role === 'consumer' ? 2 : a.worker.role === 'ingress' ? 3 : 4;
  const actions = [...pre.actions].sort((a, b) => rank(a) - rank(b));
  const done = await execute({ env, actions, api: cloud.api, wrangler: cloud.wrangler, secretsFor });
  commit();
  if (!existing) writeConfig(ctx.configFile, raw);
  out.ok(`config updated: ${id} added to ${env} (backup kept next to config/kawa-edge.json)`);

  let isolation = 'not run';
  if (env === 'staging' && f['no-check']) {
    out.warn('isolation check skipped (--no-check): run ./kawa-edge gates before relying on it');
    const file = writeReport(`add-hub-${env}-${id}`, { id, env, applied: done, isolation: 'SKIPPED' });
    return { result: 'BLOCKED', detail: `${id} provisioned in STAGING; isolation NOT verified`, report: file };
  }
  if (env === 'staging') isolation = await stagingIsolationCheck(cloud, next, id, before);
  else out.warn('PROD: no synthetic alert is ever sent (it would reach real Hubs). Verify with ./kawa-edge status --env prod.');
  const file = writeReport(`add-hub-${env}-${id}`, { id, env, applied: done, isolation });
  return { result: 'PASS', detail: `${id} added to ${env.toUpperCase()}; starts at the next accepted alert (no history)`, report: file };
}

/** STAGING only: one synthetic alert reaches every enabled receiver, including the new one, and the new Hub got no history. */
async function stagingIsolationCheck(cloud, cfg, id, before) {
  const secrets = loadStagingSecrets();
  const sub = await cloud.api.subdomain();
  const base = (n) => `https://${n}.${sub}.workers.dev`;
  const body = JSON.stringify({ signal_id: `STG-ADDHUB-${id}-${crypto.randomBytes(3).toString('hex')}`, source: 'kawa-edge-add-hub-check', pad: 'x'.repeat(16) });
  const res = await fetch(`${base(names.ingress('staging'))}/webhook/${secrets.WEBHOOK_PATH_TOKEN}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  const j = await res.json();
  if (res.status !== 202 || !j.destinations.includes(id)) throw new KawaError('ADD_HUB_NOT_FANNED_OUT', `ingress answered ${res.status}, destinations ${j.destinations}`);
  const enabled = cfg.envs.staging.parsed.filter(d => d.enabled).map(d => d.id);
  const t0 = Date.now();
  for (;;) {
    const got = await Promise.all(enabled.map(async d => ((await (await fetch(`${base(names.receiver('staging', d))}/report`)).json()).observations || [])
      .some(o => Number(o.edge_seq) === j.edge_seq && ['ACCEPTED', 'DUPLICATE'].includes(o.outcome))));
    if (got.every(Boolean)) break;
    if (Date.now() - t0 > 180e3) throw new KawaError('ADD_HUB_ISOLATION', `seq ${j.edge_seq} not received by: ${enabled.filter((_, i) => !got[i]).join(', ')}`);
    await new Promise(r => setTimeout(r, 3000));
  }
  const stats = (await (await fetch(`${base(names.admin('staging'))}/stats`, { headers: { authorization: `Bearer ${secrets.ADMIN_TOKEN}` } })).json()).stats;
  const d = stats.destinations[id];
  if (!d || d.next_seq_expected !== j.edge_seq + 1) throw new KawaError('ADD_HUB_HISTORY', `${id} head is ${d && d.next_seq_expected}, expected ${j.edge_seq + 1} (it must start at the first alert after it was added)`);
  out.ok(`isolation check: seq ${j.edge_seq} delivered to ${enabled.join(', ')}; ${id} head ${d.next_seq_expected} (no history)`);
  return { edge_seq: j.edge_seq, delivered_to: enabled, new_head: d.next_seq_expected, existing_before: [...before] };
}
