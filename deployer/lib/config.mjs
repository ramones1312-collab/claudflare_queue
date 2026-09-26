/**
 * Operator configuration (config/kawa-edge.json). NON-SECRET by construction: a value that looks
 * like a credential is refused. Destination fields are validated by the Edge's OWN registry
 * (edge/src/destinations.js), so the deployer can never accept a configuration the runtime would
 * reject — and never reject one it would accept.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EDGE_DIR } from './paths.mjs';
import { KawaError } from './log.mjs';

export const SCHEMA = 'kawa.edge.nas.config.v1';

/**
 * HARD LOCKS · not configurable. HUB_A MAINNET is reached ONLY through its public ingress hostname,
 * which the existing Tunnel maps to host 8181 -> container 8081. The control plane (8180/8080) must
 * never receive a signal, so any URL naming those ports is refused outright.
 */
export const HARD_LOCKS = Object.freeze({
  HUB_A_PUBLIC_HOST: 'vector-hook.integrademia.com',
  FORBIDDEN_PORTS: Object.freeze(['8180', '8080']),
});

const DEST_KEYS = new Set(['id', 'enabled', 'timeout_ms', 'retry']);
const PROD_EXTRA_KEYS = new Set(['webhook_host']);
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

let registry = null;
export async function edgeRegistry() {
  if (!registry) registry = await import(pathToFileURL(path.join(EDGE_DIR, 'src', 'destinations.js')).href);
  return registry;
}

/** The exact value of the DESTINATIONS var: only runtime fields, canonical key order. */
export function runtimeDestinations(list) {
  return list.map((d) => {
    const o = { id: d.id };
    if (d.enabled !== undefined) o.enabled = d.enabled;
    if (d.timeout_ms !== undefined) o.timeout_ms = d.timeout_ms;
    if (d.retry !== undefined) o.retry = d.retry;
    return o;
  });
}

async function validateDestinations(env, list, where) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new KawaError('CONFIG_NO_DESTINATIONS', `${where}.destinations must be a non-empty array`);
  }
  for (const d of list) {
    const allowed = env === 'prod' ? new Set([...DEST_KEYS, ...PROD_EXTRA_KEYS]) : DEST_KEYS;
    for (const k of Object.keys(d || {})) {
      if (!allowed.has(k)) throw new KawaError('CONFIG_UNKNOWN_FIELD', `${where}: unknown field "${k}" in destination ${d && d.id}`,
        'Destination fields: id, enabled, timeout_ms, retry' + (env === 'prod' ? ', webhook_host' : '') + '. Secrets never go in this file.');
    }
    if (d.id !== String(d.id || '').toUpperCase()) {
      throw new KawaError('CONFIG_ID_NOT_CANONICAL', `${where}: destination id "${d.id}" must be upper case (e.g. HUB_B)`);
    }
  }
  const reg = await edgeRegistry();
  let parsed;
  try {
    parsed = reg.allDestinations({ DESTINATIONS: JSON.stringify(runtimeDestinations(list)) });
  } catch (err) {
    throw new KawaError('CONFIG_REJECTED_BY_EDGE', `${where}: the Edge registry rejects this configuration: ${err.code || err.message} ${err.detail ? JSON.stringify(err.detail) : ''}`,
      'Same validation the Workers apply at runtime (edge/src/destinations.js). Fix the value; nothing was changed in Cloudflare.');
  }
  if (!parsed.some(d => d.enabled)) throw new KawaError('CONFIG_NONE_ENABLED', `${where}: at least one destination must be enabled`);
  if (env === 'prod') {
    for (const d of list) {
      if (!d.webhook_host || !HOST_RE.test(String(d.webhook_host))) {
        throw new KawaError('CONFIG_WEBHOOK_HOST', `prod: destination ${d.id} needs "webhook_host" (the public hostname of that Hub's INGRESS, no scheme, no port)`);
      }
      if (d.id === 'HUB_A' && d.webhook_host !== HARD_LOCKS.HUB_A_PUBLIC_HOST) {
        throw new KawaError('HARD_LOCK_HUB_A_HOST', `prod: HUB_A webhook_host must be ${HARD_LOCKS.HUB_A_PUBLIC_HOST} (hard lock)`);
      }
      if (d.id !== 'HUB_A' && String(d.webhook_host).replace(/\.$/, '') === HARD_LOCKS.HUB_A_PUBLIC_HOST) {
        throw new KawaError('HARD_LOCK_HUB_A_HOST', `prod: ${d.id} cannot point at HUB_A's ingress host (${HARD_LOCKS.HUB_A_PUBLIC_HOST})`);
      }
    }
  }
  return parsed;
}

function refuseSecretLookingValues(obj, trail = '') {
  for (const [k, v] of Object.entries(obj || {})) {
    const here = trail ? `${trail}.${k}` : k;
    if (v && typeof v === 'object') { refuseSecretLookingValues(v, here); continue; }
    if (typeof v === 'string' && (/\/webhook\//i.test(v) || /token|secret|password/i.test(k))) {
      throw new KawaError('CONFIG_CONTAINS_SECRET', `config field "${here}" looks like a credential`,
        'config/kawa-edge.json must never contain secrets. The installer asks for them interactively and never stores them.');
    }
  }
}

export async function loadConfig(file) {
  if (!fs.existsSync(file)) {
    throw new KawaError('CONFIG_MISSING', `configuration not found: ${file}`,
      'Copy config/kawa-edge.example.json to config/kawa-edge.json and set cloudflare.account_id.');
  }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    throw new KawaError('CONFIG_NOT_JSON', `configuration is not valid JSON: ${err.message}`);
  }
  return validateConfig(cfg);
}

export async function validateConfig(cfg) {
  if (!cfg || cfg.schema !== SCHEMA) throw new KawaError('CONFIG_SCHEMA', `config "schema" must be "${SCHEMA}"`);
  refuseSecretLookingValues(cfg);
  const acct = cfg.cloudflare && cfg.cloudflare.account_id;
  if (!/^[0-9a-f]{32}$/.test(String(acct || ''))) {
    throw new KawaError('CONFIG_ACCOUNT_ID', 'cloudflare.account_id must be the 32-hex Account ID',
      'Cloudflare dashboard -> Workers & Pages -> right column "Account ID".');
  }
  const out = { raw: cfg, account_id: acct, envs: {} };
  out.envs.staging = { destinations: cfg.staging && cfg.staging.destinations,
                       parsed: await validateDestinations('staging', cfg.staging && cfg.staging.destinations, 'staging') };
  if (cfg.prod) {
    out.envs.prod = { destinations: cfg.prod.destinations,
                      parsed: await validateDestinations('prod', cfg.prod.destinations, 'prod') };
  }
  return out;
}

/** add-hub writes the config back. A timestamped backup is kept next to it. */
export function writeConfig(file, raw) {
  if (fs.existsSync(file)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, `${file}.bak-${ts}`);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  fs.renameSync(tmp, file);                           // atomic: never a half-written config
}
