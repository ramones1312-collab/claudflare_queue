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
import { renderEnv, writeBuild } from './render.mjs';
import { bindingHash, readEvidence, verify as verifySignature } from './evidence.mjs';
import { CLOUD_GATE_IDS } from './gates/run.mjs';
import { edgeRegistry, runtimeDestinations } from './config.mjs';
import { pinnedVersion } from './wrangler.mjs';
import { names, MANAGED_VAR, BUILD_VAR } from './naming.mjs';
import { EDGE_DIR, STATE_DIR, BUILD_DIR } from './paths.mjs';
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
    const line = `${r.state.padEnd(14)} ${r.kind.padEnd(6)} ${r.name}${r.secrets && r.secrets.length ? '  [' + r.secrets.join(' ') + ']' : ''}${r.consumers ? `  consumers: ${r.consumers.join(',') || '-'}` : ''}${r.backlog && r.backlog.readable && r.backlog.value !== null ? `  backlog≈${r.backlog.value}` : ''}`;
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
  if (f.queues) {
    const byName = new Map((await cloud.api.listQueues()).map(q => [q.queue_name, q]));
    for (const q of plan.queues) {
      const found = byName.get(q.name);
      if (!found) continue;
      // D-08 · after our Workers are gone nothing may still be attached; anything left is not ours.
      const d = await cloud.api.queue(found.queue_id);
      const attached = [...(d.consumers || []), ...(d.producers || [])].map(x => x.script || x.script_name || x.type);
      if (attached.length) { out.warn(`${q.name}: still attached to ${attached.join(',')}; NOT deleted`); continue; }
      try { await cloud.wrangler.deleteQueue(q.name); out.ok(`deleted queue ${q.name}`); } catch (err) { out.warn(`${q.name}: ${err.message}`); }
    }
  }
  deleteStagingSecrets();
  fs.rmSync(path.join(STATE_DIR, 'staging', 'deployed.json'), { force: true });
  return { result: 'PASS', detail: `STAGING Workers deleted${f.queues ? ' and queues' : ' (queues kept; --queues to delete them)'}`, report: file };
}

/** R3-03 · a STAGING run older than this no longer authorises PROD. */
export const STAGING_PASS_MAX_AGE_DAYS = 7;

/**
 * THE gate in front of every PROD write (prod-deploy, add-hub --env prod, cutover). Among the
 * Cloudflare STAGING runs of THIS build (bindingHash: deployer + Edge code + lockfile + wrangler), the
 * MOST RECENT one governs (R3-03): if it is FAIL or PARTIAL, PROD is BLOCKED even if an older run of
 * the same build passed. That run must also
 *   - be signed by this installation (not hand-written, edited or copied in),
 *   - be at most STAGING_PASS_MAX_AGE_DAYS old,
 *   - have passed EVERY gate of the list fixed in code (CLOUD_GATE_IDS), with no cleanup error,
 *   - have verified the DLQ record on the platform (gate G) and a real redispatch (gate K),
 *   - have run on the same Cloudflare account,
 *   - have gate-tested every PROD destination, enabled, with the same runtime settings (timeout, retry).
 * Returns { pass } or { reasons } — never throws on a corrupt file.
 */
export async function findStagingPass(cfg, { prodDests = null, now = Date.now() } = {}) {
  const dir = path.join(STATE_DIR, 'evidence');
  if (!fs.existsSync(dir)) return { reasons: ['no evidence directory'] };
  const binding = currentBinding();
  const reg = await edgeRegistry();
  const parse = (list) => Object.fromEntries(reg.allDestinations({ DESTINATIONS: JSON.stringify(runtimeDestinations(list)) }).map(d => [d.id, { timeout_ms: d.timeout_ms, retry: d.retry, enabled: d.enabled }]));
  const wantProd = prodDests || (cfg.envs.prod ? cfg.envs.prod.destinations : []);
  const all = fs.readdirSync(dir).filter(n => /^staging-gates-cloud-.*\.json$/.test(n))
    .map(n => ({ n, e: readEvidence(path.join(dir, n)) })).filter(r => r.e);
  const runs = all.filter(r => r.e.binding_sha256 === binding)
    .map(r => ({ ...r, t: Date.parse(r.e.started) }))
    .sort((a, b) => (Number.isFinite(b.t) ? b.t : -Infinity) - (Number.isFinite(a.t) ? a.t : -Infinity) || (a.n < b.n ? 1 : -1));
  if (!runs.length) return { reasons: [all.length ? `no Cloudflare STAGING run of this build (${all.length} run(s) of other builds)` : 'no Cloudflare STAGING PASS evidence'] };
  const { n, e, t } = runs[0];
  const why = [];
  if (e.result !== 'PASS' || e.target !== 'cloud') why.push(`the most recent Cloudflare STAGING run of this build is ${e.result} (an older PASS does not count)`);
  if (!verifySignature(e)) why.push('not signed by this installation');
  if (!Number.isFinite(t)) why.push('no start time');
  else if (now - t > STAGING_PASS_MAX_AGE_DAYS * 86400e3) why.push(`older than ${STAGING_PASS_MAX_AGE_DAYS} days (${e.started}): re-run ./kawa-edge gates`);
  else if (t - now > 3600e3) why.push(`start time in the future (${e.started})`);
  if ((e.cleanup_errors || []).length) why.push('cleanup errors');
  // R3-04 · a malformed record is a reason, never an exception that would hide every other file.
  const byId = new Map((Array.isArray(e.gates) ? e.gates : []).filter(g => g && typeof g === 'object').map(g => [g.id, g]));
  const missing = CLOUD_GATE_IDS.filter(id => !byId.has(id) || byId.get(id).status !== 'PASS');
  if (missing.length) why.push(`gates not PASS: ${missing.join(',')}`);
  const g = byId.get('G');
  if (!(g && g.evidence && g.evidence.dlq && g.evidence.dlq.verified === true)) why.push('DLQ record not platform-verified (gate G; needs Account Analytics: Read)');
  const k = byId.get('K');
  if (!(k && k.evidence && k.evidence.dispatch_attempts >= 2 && k.evidence.redispatch_after_lease === true)) why.push('no redispatch after the 5-min lease proven (gate K)');
  if (e.account_id !== cfg.account_id) why.push('different Cloudflare account');
  try {
    const tested = parse(e.destinations_config || []);
    for (const [id, d] of Object.entries(parse(wantProd))) {
      const td = tested[id];
      if (!td) why.push(`${id} was never gate-tested in STAGING`);
      // N-4 · a destination that was DISABLED in STAGING received no signal from the gates: not tested.
      else if (td.enabled === false) why.push(`${id} was disabled in the STAGING run: never gate-tested`);
      else if (JSON.stringify([td.timeout_ms, td.retry]) !== JSON.stringify([d.timeout_ms, d.retry])) why.push(`${id}: PROD timeout/retry differ from what STAGING tested`);
      // R3-16 · declared scope: only the two gated destinations run the full gate set; any other one ran
      // G00, the fan-out of A and RB only. Said on screen, not hidden.
      else if (Array.isArray(e.destinations) && !e.destinations.includes(id)) out.warn(`${id}: STAGING ran only G00/fan-out/RB for it (full gates ran on ${e.destinations.join(', ')})`);
    }
  } catch (err) { why.push(`destinations: ${err.code || err.message}`); }
  if (!why.length) return { pass: { file: n, e } };
  return { reasons: [`${n}: ${why.join('; ')}`] };
}

/** Live corroboration: STAGING on Cloudflare still runs exactly the builds the gates certified. */
export async function corroborate(pass, api) {
  const bad = [];
  for (const [name, build] of Object.entries(pass.e.builds || {})) {
    const s = await api.scriptSettings(name);
    const vars = Object.fromEntries(((s && s.bindings) || []).filter(b => b.type === 'plain_text').map(b => [b.name, b.text]));
    if (vars[BUILD_VAR] !== build) bad.push(name);
  }
  if (!Object.keys(pass.e.builds || {}).length) bad.push('(evidence lists no builds)');
  return bad;
}

export async function requireStagingPass(cfg, api, opts = {}) {
  const f = await findStagingPass(cfg, opts);
  if (!f.pass) {
    for (const r of f.reasons.slice(0, 5)) out.info(`   ${r}`);
    return { blocked: `no complete, signed Cloudflare STAGING PASS for this build and these destinations (${currentBinding().slice(0, 12)}…). Run ./kawa-edge install.` };
  }
  const bad = await corroborate(f.pass, api);
  if (bad.length) return { blocked: `STAGING on Cloudflare no longer runs the certified builds (${bad.join(', ')}). Keep STAGING deployed and re-run ./kawa-edge install.` };
  out.ok(`STAGING PASS (signed, all ${CLOUD_GATE_IDS.length} gates, corroborated on Cloudflare): ${f.pass.file}`);
  return { pass: f.pass };
}
const currentBinding = () => bindingHash(pinnedVersion());

/**
 * F-10 · Redeploying an EXISTING PROD ingress restarts the Sequencer Durable Object. An alert that
 * arrives during that restart may get a 503, and TradingView does not retry: that alert would be lost
 * for every Hub. Never done silently.
 */
export async function confirmIngressRedeploy(f) {
  out.warn('Redeploying the PROD ingress restarts the Sequencer. An alert arriving during the restart can be answered 503,');
  out.warn('and TradingView does NOT retry it: it would be lost for EVERY Hub. Do it only when no alert is expected.');
  if (f['confirm-ingress-redeploy'] === 'REDEPLOY PROD INGRESS') return;
  const a = await promptLine('Type REDEPLOY PROD INGRESS to continue: ');
  if (a !== 'REDEPLOY PROD INGRESS') throw new KawaError('INGRESS_REDEPLOY_NOT_CONFIRMED', 'PROD ingress redeploy not confirmed; nothing was changed');
}

export async function prodDeploy(ctx, f) {
  const cfg = await loadConfig(ctx.configFile);
  if (!cfg.envs.prod) throw new KawaError('CONFIG_NO_ENV', 'config has no "prod" section');
  const offline = await findStagingPass(cfg);
  if (!offline.pass) {
    for (const r of offline.reasons.slice(0, 5)) out.info(`   ${r}`);
    return { result: 'BLOCKED', detail: 'no complete, signed Cloudflare STAGING PASS for this build and these destinations. Run ./kawa-edge install first.' };
  }
  const local = await localChecks({ cfg, env: 'prod', wrangler: createWrangler({ quiet: true }), inContainer: !!process.env.KAWA_IN_CONTAINER });
  const cloud = await cloudContext(cfg);
  const gate = await requireStagingPass(cfg, cloud.api);
  if (!gate.pass) return { result: 'BLOCKED', detail: gate.blocked };
  const pass = gate.pass;
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
  if (ingressA.action === 'UPDATE') await confirmIngressRedeploy(f);
  const done = await execute({ env: 'prod', actions: pre.actions, api: cloud.api, wrangler: cloud.wrangler,
                               secretsFor: (w) => (w.role === 'ingress' ? secrets.ingress : secrets[w.dest]) || null });
  for (const c of commits) c();
  const file = writeReport('prod-deploy', { applied: done, staging_pass: pass.file, binding_sha256: currentBinding() });
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

/**
 * R3-07 · ONE route-switch procedure (F-14), the same for cutover (direct -> Edge) and transport rollback
 * (Edge -> direct). Printed by cutover-check (C9), cutover and rollback-transport; RUNBOOK §5 quotes it.
 * Why: the two routes have no order between them, so the old route must hold nothing still to deliver.
 */
export const ROUTE_SWITCH_PROCEDURE = Object.freeze([
  '1. Window: strategy inactive (no alert expected) for the whole switch.',
  '2. Old route drained BEFORE switching. Cutover: nothing to drain (direct delivery is synchronous) and PROD',
  '   queues clean (C6). Rollback: `./kawa-edge status prod` shows every PROD queue backlog = 0; if it is > 0 and',
  '   falling, WAIT until 0 (the Edge keeps delivering in order), then switch.',
  '3. Switch ALL KAWA alerts in TradingView in the same window.',
  '4. Rollback with the HUB_A line HALTED (backlog does not fall): switch anyway. The halted signals are older',
  '   than any direct signal from now on: they must NOT be resumed (retry) without an owner decision (and in',
  '   PROD there is no retry path until B-1). Never run both routes with the Edge still delivering.',
]);
const printProcedure = () => { for (const l of ROUTE_SWITCH_PROCEDURE) out.info(l); };

export async function cutoverCheck(ctx, f) {
  const cfg = await loadConfig(ctx.configFile);
  const checks = [];
  const add = (id, title, status, detail) => { checks.push({ id, title, status, detail }); (status === 'PASS' ? out.ok : status === 'MANUAL' ? out.warn : out.fail)(`${id.padEnd(4)} ${status.padEnd(8)} ${title}${detail ? ' — ' + detail : ''}`); };
  out.step('Cutover preconditions (nothing is changed)');
  const found = await findStagingPass(cfg);
  let pass = found.pass || null;
  let cloud = null;
  if (!f.offline && cfg.envs.prod) cloud = await cloudContext(cfg);
  if (pass && cloud) { const bad = await corroborate(pass, cloud.api); if (bad.length) { pass = null; found.reasons = [`STAGING no longer runs the certified builds: ${bad.join(', ')}`]; } }
  add('C1', 'STAGING PASS on Cloudflare (signed, all gates, corroborated) for this exact build', pass ? (cloud ? 'PASS' : 'UNKNOWN') : 'FAIL',
      pass ? `${pass.file}${cloud ? '' : ' (not corroborated: --offline)'}` : (found.reasons[0] || 'run ./kawa-edge install'));
  if (!cloud) add('C2', 'PROD Edge deployed, managed, current, secrets set', 'UNKNOWN', f.offline ? '--offline' : 'no prod section');
  else {
    const { rows } = await inspect('prod', cfg, cloud.api);
    const bad = rows.filter(r => !['CURRENT', 'OK'].includes(r.state));
    add('C2', 'PROD Edge deployed, managed, current, secrets set', bad.length ? 'FAIL' : 'PASS', bad.length ? bad.map(r => `${r.name}:${r.state}`).join(', ') : `${rows.length} resources current`);
    const backlog = rows.filter(r => r.kind === 'queue').map(r => r.backlog);
    const unknown = backlog.some(b => !b || !b.readable || b.value === null);
    add('C6', 'PROD queues clean / known', unknown ? 'UNKNOWN' : backlog.every(b => b.value === 0) ? 'PASS' : 'FAIL',
        unknown ? 'backlog not readable or no sample (needs "Account Analytics: Read")' : `backlog ${backlog.map(b => b.value).join(',')}`);
  }
  add('C3', 'Edge -> HUB_A transport + auth PASS (non-trading)', 'BLOCKED', `B-2: ${BLOCKERS['B-2'].title}`);
  add('C4', 'PROD retry / skip / FAILED_PERMANENT / rollback-readiness path', 'BLOCKED', `B-1: ${BLOCKERS['B-1'].title}`);
  add('C5', 'HUB_A GREEN', 'MANUAL', 'owner attests from the Hub UI (8180) at cutover time; the deployer never contacts the Hub');
  add('C7', 'Rollback documented and rehearsed', pass && pass.e.gates.some(g => g.id === 'RB' && g.status === 'PASS') ? 'PASS' : 'FAIL', 'RUNBOOK_VIGENTE §8; STAGING gate RB (rollback-readiness ok:true)');
  add('C8', 'Owner approval', 'MANUAL', 'typed at ./kawa-edge cutover');
  add('C9', 'Route-switch window (one procedure for cutover and rollback)', 'MANUAL', 'typed at ./kawa-edge cutover; procedure below');
  printProcedure();
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
  // Unreachable while B-1/B-2 stand; the rotation itself is tested directly (rotateProdPathToken).
  return cutoverProceed(await loadConfig(ctx.configFile));
}

/** After every automatic precondition passed: manifest re-verified FIRST (H-15), then the typed attestations. */
export async function cutoverProceed(cfg, { prompt = promptLine } = {}) {
  await localChecks({ cfg, env: 'prod', wrangler: createWrangler({ quiet: true }), dryRun: false, inContainer: !!process.env.KAWA_IN_CONTAINER });  // H-15 · manifest re-verified
  const green = await prompt('C5 · Type HUB_A IS GREEN after checking the Hub UI (8180) yourself: ');
  if (green !== 'HUB_A IS GREEN') return { result: 'BLOCKED', detail: 'HUB_A GREEN not attested' };
  printProcedure();
  const win = await prompt('C9 · Type ROUTE SWITCH WINDOW READY once steps 1-2 hold: ');
  if (win !== 'ROUTE SWITCH WINDOW READY') return { result: 'BLOCKED', detail: 'route-switch window not confirmed' };
  const phrase = await prompt('Type exactly "CUTOVER HUB_A APPROVED" (owner): ');
  if (phrase !== 'CUTOVER HUB_A APPROVED') return { result: 'BLOCKED', detail: 'owner approval not given' };
  const cloud = await cloudContext(cfg);
  const { url } = await rotateProdPathToken(cfg, cloud);
  process.stdout.write(`\n  TradingView webhook URL (shown ONCE, not logged):\n  ${url}\n\n`);
  return { result: 'PASS', detail: 'PROD path token rotated; paste the URL in TradingView now' };
}

/** Rotates the PROD ingress path token (same build, new secret) and returns the new webhook URL. */
export async function rotateProdPathToken(cfg, cloud) {
  const plan = renderEnv('prod', cfg.envs.prod.destinations, EDGE_DIR);
  writeBuild(plan, BUILD_DIR);                                        // F-13 · the config must exist on disk
  const ingress = plan.workers.find(w => w.role === 'ingress');
  const token = randomToken();
  const { withSecretsFile } = await import('./secrets.mjs');
  await withSecretsFile({ WEBHOOK_PATH_TOKEN: token }, (file) => cloud.wrangler.deploy(ingress.configPath, file));
  const sub = await cloud.api.subdomain();
  return { url: `https://${ingress.name}.${sub}.workers.dev/webhook/${token}`, token };
}

export async function rollbackTransport() {
  out.step('IMMEDIATE TRANSPORT ROLLBACK (TradingView -> direct HUB_A) · same procedure as cutover (C9)');
  printProcedure();
  for (const l of [
    'Direct URL for step 3: https://' + HARD_LOCKS.HUB_A_PUBLIC_HOST + '/webhook/<WEBHOOK_SECRET> (the owner holds it; the deployer never stores or prints it).',
    'Nothing changes in Cloudflare Tunnel, the hostname, HUB_A or its ports (8181 -> 8081 ingress).',
    'FULL Edge rollback (removing the PROD Edge) follows R4 §6: stop admission, drain, rollback-readiness ok:true.',
    'Drain verification beyond queue backlog is blocked by B-1 (no PROD admin/readiness surface). See RUNBOOK_VIGENTE §5/§8.',
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
