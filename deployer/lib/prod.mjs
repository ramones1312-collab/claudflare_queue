/**
 * Status, STAGING teardown and the PROD phases (C: parallel deploy, D: cutover).
 *
 * BLOCKERS declared by this release (see RELEASE_REPORT §Blockers). They are enforced in code:
 *   B-1  R4 gives PROD no operational surface for retry / skip / FAILED_PERMANENT diagnosis /
 *        rollback-readiness: those live only on the STAGING admin Worker, which R4 forbids in PROD.
 *   B-2  No NON-TRADING method is known to prove Edge -> HUB_A transport and authentication. Every
 *        POST the Edge can make to /webhook/<secret> is a trading signal.
 * cutover-check reports them; cutover refuses while either stands.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, HARD_LOCKS } from './config.mjs';
import { out, KawaError, redact } from './log.mjs';
import { createWrangler } from './wrangler.mjs';
import { localChecks, cloudChecks, requiredSecrets } from './preflight.mjs';
import { execute, loadDeployed } from './deploy.mjs';
import { renderEnv, stagingBindingHash } from './render.mjs';
import { pinnedVersion } from './wrangler.mjs';
import { names, MANAGED_VAR, BUILD_VAR } from './naming.mjs';
import { EDGE_DIR, STATE_DIR } from './paths.mjs';
import { validateHaltUrl, promptHidden, promptLine, validateWebhookUrl, checkAndRecordFingerprint, randomToken, loadStagingSecrets, deleteStagingSecrets } from './secrets.mjs';
import { cloudContext, writeReport, hubHostsOf } from './commands.mjs';

export const BLOCKERS = {
  'B-1': {
    title: 'No PROD operational path for retry / skip / FAILED_PERMANENT diagnosis / rollback-readiness',
    why: 'R4 implements these only on the STAGING admin Worker (admin-worker/wrangler.toml: "Never deploy an equivalent of this Worker to production") and its rollback procedure requires GET /rollback-readiness. In PROD the Sequencer RPC exists but nothing can call it without a new component.',
    needs: 'Owner decision on one of the options in RELEASE_REPORT §B-1 (recommended: signed command queue, zero public HTTP surface). Implementing it is a new, audited revision.',
  },
  'B-2': {
    title: 'No non-trading method to validate Edge -> HUB_A (auth + transport)',
    why: 'The Edge only POSTs a TradingView body to /webhook/<secret>; the Hub treats every such POST as a signal. No health/probe endpoint on the INGRESS (8181/8081) and no written dedupe-replay guarantee of R8.4 REV8 has been provided.',
    needs: 'Hub contract evidence: either a documented non-trading probe on the ingress path, or the R8.4 REV8 guarantee that re-POSTing an already-processed signal_id is rejected as DUPLICATE with no execution side effect, plus one such processed body. Then a new revision wires hub-check to it.',
  },
};

async function inspect(env, cfg, api) {
  const plan = renderEnv(env, cfg.envs[env].destinations, EDGE_DIR);
  const scripts = new Set((await api.listScripts()).map(s => s.id || s.name));
  const queues = new Map((await api.listQueues()).map(q => [q.queue_name, q]));
  const rows = [];
  for (const w of plan.workers) {
    if (!scripts.has(w.name)) { rows.push({ kind: 'worker', name: w.name, state: 'MISSING' }); continue; }
    const s = await api.scriptSettings(w.name);
    const vars = Object.fromEntries(((s && s.bindings) || []).filter(b => b.type === 'plain_text').map(b => [b.name, b.text]));
    const secretNames = (await api.secretNames(w.name)) || [];
    const missing = requiredSecrets(env, w).filter(x => !secretNames.includes(x));
    const state = !vars[MANAGED_VAR] ? 'FOREIGN' : vars[BUILD_VAR] !== w.build ? 'OUTDATED' : missing.length ? 'SECRET_MISSING' : 'CURRENT';
    rows.push({ kind: 'worker', name: w.name, state, secrets: requiredSecrets(env, w).map(x => `${x}:${secretNames.includes(x) ? 'set' : 'MISSING'}`) });
  }
  for (const q of plan.queues) {
    const found = queues.get(q.name);
    if (!found) { rows.push({ kind: 'queue', name: q.name, state: 'MISSING' }); continue; }
    const d = await api.queue(found.queue_id);
    const backlog = await api.queueBacklog(found.queue_id);
    rows.push({ kind: 'queue', name: q.name, state: d.settings && d.settings.delivery_paused ? 'PAUSED' : 'OK',
                consumers: (d.consumers || []).map(c => c.script || c.script_name), backlog });
  }
  return { plan, rows };
}

export async function status(ctx, f) {
  const env = f.env || f._[0] || 'staging';
  const cfg = await loadConfig(ctx.configFile);
  if (!cfg.envs[env]) throw new KawaError('CONFIG_NO_ENV', `config has no "${env}" section`);
  const cloud = await cloudContext(cfg);
  out.step(`Resources · ${env.toUpperCase()}`);
  const { rows } = await inspect(env, cfg, cloud.api);
  for (const r of rows) {
    const line = `${r.state.padEnd(14)} ${r.kind.padEnd(6)} ${r.name}${r.secrets && r.secrets.length ? '  [' + r.secrets.join(' ') + ']' : ''}${r.consumers ? `  consumers: ${r.consumers.join(',') || '-'}` : ''}${r.backlog !== undefined && r.backlog !== null ? `  backlog≈${r.backlog}` : ''}`;
    (r.state === 'CURRENT' || r.state === 'OK' ? out.ok : out.fail)(line);
  }
  let seq = null;
  if (env === 'staging') {
    const secrets = loadStagingSecrets();
    const sub = await cloud.api.subdomain();
    if (secrets && sub) {
      out.step('Sequencer (STAGING admin, read-only)');
      try {
        const res = await fetch(`https://${names.admin('staging')}.${sub}.workers.dev/stats`, { headers: { authorization: `Bearer ${secrets.ADMIN_TOKEN}` }, signal: AbortSignal.timeout(20000) });
        seq = (await res.json()).stats;
        out.info(`counter ${seq.counter} · schema ${seq.schema_version}`);
        for (const [id, d] of Object.entries(seq.destinations)) {
          (d.halted_seq === null ? out.ok : out.fail)(`${id.padEnd(8)} enabled=${d.enabled} head=${d.next_seq_expected} halted=${d.halted_seq} unresolved=${d.unresolved}`);
        }
      } catch (err) { out.warn(`admin stats unavailable: ${err.message}`); }
    }
  } else {
    out.warn(`${'B-1'}: PROD has no Sequencer observability surface in R4 (heads, halts, unresolved). Queue backlog above and ./kawa-edge tail are the read-only signals available.`);
  }
  const bad = rows.filter(r => !['CURRENT', 'OK'].includes(r.state));
  const file = writeReport(`status-${env}`, { env, rows, sequencer: seq });
  return { result: bad.length ? 'FAIL' : 'PASS', detail: bad.length ? `${bad.length} resource(s) not current` : `${env.toUpperCase()} resources current`, report: file };
}

export async function stagingTeardown(ctx, f) {
  const cfg = await loadConfig(ctx.configFile);
  const answer = f.yes === 'DELETE-STAGING' ? 'DELETE STAGING' : await promptLine('This deletes the STAGING Workers (their Durable Object storage is destroyed). Type DELETE STAGING to continue: ');
  if (answer !== 'DELETE STAGING') return { result: 'BLOCKED', detail: 'not confirmed; nothing deleted' };
  const cloud = await cloudContext(cfg);
  const plan = renderEnv('staging', cfg.envs.staging.destinations, EDGE_DIR);
  const scripts = new Set((await cloud.api.listScripts()).map(s => s.id || s.name));
  // Evidence first: the receivers' ledgers die with their Workers.
  const secrets = loadStagingSecrets();
  const sub = await cloud.api.subdomain();
  const evidence = {};
  for (const w of plan.workers.filter(w => w.role === 'receiver' && scripts.has(w.name))) {
    try { evidence[w.dest] = await (await fetch(`https://${w.name}.${sub}.workers.dev/report`, { signal: AbortSignal.timeout(20000) })).json(); } catch (err) { evidence[w.dest] = { error: err.message }; }
  }
  const file = writeReport('staging-teardown-evidence', evidence);
  out.ok(`receiver ledgers exported: ${path.basename(file)}`);
  // Refuse to touch anything this deployer does not own.
  for (const w of plan.workers) {
    if (!scripts.has(w.name)) continue;
    const s = await cloud.api.scriptSettings(w.name);
    const managed = ((s && s.bindings) || []).some(b => b.type === 'plain_text' && b.name === MANAGED_VAR && String(b.text).startsWith('kawa-edge-nas:staging:'));
    if (!managed) throw new KawaError('FOREIGN_WORKER', `${w.name} is not managed by this deployer; refusing to delete anything`);
  }
  const order = [...plan.workers.filter(w => w.role === 'admin' || w.role === 'consumer'), ...plan.workers.filter(w => w.role === 'ingress'), ...plan.workers.filter(w => w.role === 'receiver')];
  for (const w of order) if (scripts.has(w.name)) { await cloud.wrangler.deleteWorker(w.name); out.ok(`deleted ${w.name}`); }
  if (f.queues) for (const q of plan.queues) { try { await cloud.wrangler.deleteQueue(q.name); out.ok(`deleted queue ${q.name}`); } catch (err) { out.warn(`${q.name}: ${err.message}`); } }
  deleteStagingSecrets();
  fs.rmSync(path.join(STATE_DIR, 'staging', 'deployed.json'), { force: true });
  return { result: 'PASS', detail: `STAGING Workers deleted${f.queues ? ' and queues' : ' (queues kept; --queues to delete them)'}`, report: file };
}

/** The newest Cloudflare STAGING run that passed EVERY mandatory gate for exactly this binding. */
function latestStagingPass(binding) {
  const dir = path.join(STATE_DIR, 'evidence');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(n => /^staging-gates-cloud-.*-PASS\.json$/.test(n)).sort().reverse();
  for (const n of files) {
    const e = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
    const mandatory = e.mandatory_gates || [];
    const passed = new Set((e.gates || []).filter(g => g.status === 'PASS').map(g => g.id));
    if (e.result === 'PASS' && e.target === 'cloud' && e.binding_sha256 === binding &&
        mandatory.length > 0 && mandatory.every(id => passed.has(id)) && passed.has('K')) return { file: n, e };
  }
  return null;
}
const currentBinding = () => stagingBindingHash(EDGE_DIR, pinnedVersion());

export async function prodDeploy(ctx, f) {
  const cfg = await loadConfig(ctx.configFile);
  if (!cfg.envs.prod) throw new KawaError('CONFIG_NO_ENV', 'config has no "prod" section');
  const src = currentBinding();
  const pass = latestStagingPass(src);
  if (!pass) return { result: 'BLOCKED', detail: `no complete Cloudflare STAGING PASS for this Edge code + renderer + wrangler (${src.slice(0, 12)}…). Run ./kawa-edge install first.` };
  out.ok(`STAGING PASS evidence (all mandatory gates) for this exact build: ${pass.file}`);
  const local = await localChecks({ cfg, env: 'prod', wrangler: createWrangler({ quiet: true }), inContainer: !!process.env.KAWA_IN_CONTAINER });
  const cloud = await cloudContext(cfg);
  const pre = await cloudChecks({ env: 'prod', plan: local.plan, api: cloud.api, stateDeployed: loadDeployed('prod') });

  const secrets = {};
  const commits = [];
  const ingressA = pre.actions.find(a => a.kind === 'worker' && a.worker.role === 'ingress');
  const missing = new Set(ingressA.missingSecrets || []);
  const isNew = ingressA.action === 'CREATE';
  // Upload ONLY what is missing or explicitly requested. The PROD path token is generated once here,
  // never shown, and rotated only by `cutover`: rotating it anywhere else would silently cut
  // TradingView off after cutover.
  const ingressSecrets = {};
  if (isNew || missing.has('HALT_NOTIFY_URL') || f['set-halt-notify']) {
    const halt = await promptHidden('PROD halt-notification URL (https, a collector independent of every Hub; input hidden): ');
    ingressSecrets.HALT_NOTIFY_URL = validateHaltUrl(halt, hubHostsOf(cfg));
  }
  if (isNew || missing.has('WEBHOOK_PATH_TOKEN')) ingressSecrets.WEBHOOK_PATH_TOKEN = randomToken();
  if (Object.keys(ingressSecrets).length) secrets.ingress = ingressSecrets;
  for (const a of pre.actions.filter(a => a.kind === 'worker' && a.worker.role === 'consumer')) {
    const id = a.worker.dest;
    if (a.action === 'CREATE' || (a.missingSecrets || []).length || f['set-webhook'] === id) {
      const dest = cfg.envs.prod.destinations.find(d => d.id === id);
      out.info(`${id}: webhook URL of the Hub INGRESS — https://${dest.webhook_host}/webhook/<WEBHOOK_SECRET> (never port 8180/8080)`);
      const url = validateWebhookUrl(await promptHidden(`DEST_${id}_WEBHOOK_URL (input hidden, never stored): `), dest.webhook_host);
      commits.push(checkAndRecordFingerprint(id, url));
      secrets[id] = { [`DEST_${id}_WEBHOOK_URL`]: url };
      if (a.action === 'UNCHANGED') a.action = 'UPDATE';
    }
  }
  if (secrets.ingress && ingressA.action === 'UNCHANGED') ingressA.action = 'UPDATE';
  const done = await execute({ env: 'prod', actions: pre.actions, api: cloud.api, wrangler: cloud.wrangler,
                               secretsFor: (w) => (w.role === 'ingress' ? secrets.ingress : secrets[w.dest]) || null });
  for (const c of commits) c();
  const file = writeReport('prod-deploy', { applied: done, staging_pass: pass.file, binding_sha256: src });
  out.ok('PROD Edge deployed INERT: no alert reaches it until TradingView is pointed at it (cutover).');
  out.info('TradingView still posts DIRECTLY to HUB_A. Tunnel, hostname and HUB_A untouched.');
  out.warn('Next: hub-check (BLOCKED by B-2) and cutover-check (BLOCKED by B-1, B-2).');
  return { result: 'PASS', detail: 'PROD deployed in parallel, inert', report: file };
}

export async function hubCheck(ctx, f) {
  const id = f._[0] || 'HUB_A';
  const b = BLOCKERS['B-2'];
  out.step(`Edge -> ${id} transport check`);
  out.fail(`B-2 · ${b.title}`);
  out.info(b.why);
  out.info(`Needed: ${b.needs}`);
  out.info('Nothing was sent. The deployer will not invent a probe, and will not POST a signal to a live Hub.');
  return { result: 'BLOCKED', detail: `${id} transport check blocked by B-2` };
}

export async function cutoverCheck(ctx, f) {
  const cfg = await loadConfig(ctx.configFile);
  const checks = [];
  const add = (id, title, status, detail) => { checks.push({ id, title, status, detail }); (status === 'PASS' ? out.ok : status === 'MANUAL' ? out.warn : out.fail)(`${id.padEnd(4)} ${status.padEnd(8)} ${title}${detail ? ' — ' + detail : ''}`); };
  out.step('Cutover preconditions (nothing is changed)');
  const pass = latestStagingPass(currentBinding());
  add('C1', 'STAGING PASS on Cloudflare (all mandatory gates) for this exact build', pass ? 'PASS' : 'FAIL', pass ? pass.file : 'run ./kawa-edge install');
  if (f.offline || !cfg.envs.prod) add('C2', 'PROD Edge deployed, managed, current, secrets set', 'UNKNOWN', f.offline ? '--offline' : 'no prod section');
  else {
    const cloud = await cloudContext(cfg);
    const { rows } = await inspect('prod', cfg, cloud.api);
    const bad = rows.filter(r => !['CURRENT', 'OK'].includes(r.state));
    add('C2', 'PROD Edge deployed, managed, current, secrets set', bad.length ? 'FAIL' : 'PASS', bad.length ? bad.map(r => `${r.name}:${r.state}`).join(', ') : `${rows.length} resources current`);
    const backlog = rows.filter(r => r.kind === 'queue').map(r => r.backlog);
    add('C6', 'PROD queues clean / known', backlog.some(b => b === null) ? 'UNKNOWN' : backlog.every(b => b === 0) ? 'PASS' : 'FAIL', backlog.some(b => b === null) ? 'backlog metric needs "Account Analytics: Read"' : `backlog ${backlog.join(',')}`);
  }
  add('C3', 'Edge -> HUB_A transport + auth PASS (non-trading)', 'BLOCKED', `B-2: ${BLOCKERS['B-2'].title}`);
  add('C4', 'PROD retry / skip / FAILED_PERMANENT / rollback-readiness path', 'BLOCKED', `B-1: ${BLOCKERS['B-1'].title}`);
  add('C5', 'HUB_A GREEN', 'MANUAL', 'owner attests from the Hub UI (8180) at cutover time; the deployer never contacts the Hub');
  add('C7', 'Rollback documented and rehearsed', pass && pass.e.gates.some(g => g.id === 'RB' && g.status === 'PASS') ? 'PASS' : 'FAIL', 'RUNBOOK_VIGENTE §8; STAGING gate RB (rollback-readiness ok:true)');
  add('C8', 'Owner approval', 'MANUAL', 'typed at ./kawa-edge cutover');
  const blocked = checks.filter(c => ['BLOCKED', 'FAIL', 'UNKNOWN'].includes(c.status));
  const file = writeReport('cutover-check', { checks, blockers: BLOCKERS });
  return { result: blocked.length ? 'BLOCKED' : 'PASS', detail: blocked.length ? `cutover NOT allowed: ${blocked.map(c => c.id).join(', ')}` : 'all automatic preconditions met', report: file };
}

export async function cutover(ctx, f) {
  const res = await cutoverCheck(ctx, f);
  if (res.result !== 'PASS') {
    out.fail('Cutover refused. TradingView stays on the direct HUB_A webhook. Nothing was changed.');
    return { result: 'BLOCKED', detail: res.detail, report: res.report };
  }
  // Unreachable while B-1/B-2 stand; kept so the procedure is reviewable. See RUNBOOK_VIGENTE §7.
  const phrase = await promptLine('Type exactly "CUTOVER HUB_A APPROVED" (owner): ');
  if (phrase !== 'CUTOVER HUB_A APPROVED') return { result: 'BLOCKED', detail: 'owner approval not given' };
  const cfg = await loadConfig(ctx.configFile);
  const cloud = await cloudContext(cfg);
  const plan = renderEnv('prod', cfg.envs.prod.destinations, EDGE_DIR);
  const ingress = plan.workers.find(w => w.role === 'ingress');
  const token = randomToken();
  const { withSecretsFile } = await import('./secrets.mjs');
  await withSecretsFile({ WEBHOOK_PATH_TOKEN: token }, (file) => cloud.wrangler.deploy(ingress.configPath, file));
  const sub = await cloud.api.subdomain();
  process.stdout.write(`\n  TradingView webhook URL (shown ONCE, not logged):\n  https://${ingress.name}.${sub}.workers.dev/webhook/${token}\n\n`);
  return { result: 'PASS', detail: 'PROD path token rotated; paste the URL in TradingView now' };
}

export async function rollbackTransport() {
  out.step('IMMEDIATE TRANSPORT ROLLBACK (TradingView -> direct HUB_A)');
  for (const l of [
    '1. In TradingView, set every KAWA alert\'s webhook URL back to https://' + HARD_LOCKS.HUB_A_PUBLIC_HOST + '/webhook/<WEBHOOK_SECRET>.',
    '   (The owner holds that URL. It is the one in use today; the deployer never stores or prints it.)',
    '2. Nothing changes in Cloudflare Tunnel, the hostname, HUB_A or its ports (8181 -> 8081 ingress).',
    '3. The PROD Edge keeps delivering what it already accepted (at-least-once, strict order);',
    '   HUB_A deduplicates by signal_id. Leave the PROD Edge running until it is drained.',
    '4. FULL Edge rollback (removing the PROD Edge) follows R4 §6: stop admission, drain, rollback-readiness ok:true.',
    '   Drain verification in PROD is blocked by B-1 (no PROD admin/readiness surface). See RUNBOOK_VIGENTE §8.',
  ]) out.info(l);
  return { result: 'PASS', detail: 'checklist printed; no change made' };
}

export async function tail(ctx, f) {
  const name = f._[0];
  if (!name || !/^kawa-(edge|staging)-[a-z0-9-]+$/.test(name)) throw new KawaError('TAIL_NAME', 'usage: ./kawa-edge tail <kawa-edge-… worker name>');
  const cfg = await loadConfig(ctx.configFile);
  const cloud = await cloudContext(cfg);
  out.info('streaming (Ctrl-C to stop); every line is redacted');
  await cloud.wrangler.tail(name);
  return { result: 'PASS' };
}
