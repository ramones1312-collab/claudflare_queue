/**
 * Resource names. The ONLY place that builds a Cloudflare resource name. STAGING and PROD are
 * separate identities: different Workers, queues and Durable Object namespaces (a DO namespace is
 * derived from its Worker name), so STAGING storage can never become PROD storage.
 *
 *   STAGING   kawa-edge-ingress-stg, kawa-edge-delivery-hub-a-stg, kawa-signal-buffer-hub-a-stg,
 *             kawa-signal-buffer-hub-a-dlq-stg, kawa-staging-receiver-hub-a, kawa-edge-admin-stg
 *   PROD      kawa-edge-ingress-prod, kawa-edge-delivery-hub-a-prod, kawa-signal-buffer-hub-a-prod,
 *             kawa-signal-buffer-hub-a-dlq-prod        (no receiver, no admin)
 */
export const ENVS = ['staging', 'prod'];
const SUFFIX = { staging: '-stg', prod: '-prod' };

export function slug(id) {
  return String(id).toLowerCase().replace(/_/g, '-');
}

function suffix(env) {
  if (!SUFFIX[env]) throw new Error(`unknown environment ${env}`);
  return SUFFIX[env];
}

export const names = {
  ingress: (env) => `kawa-edge-ingress${suffix(env)}`,
  consumer: (env, id) => `kawa-edge-delivery-${slug(id)}${suffix(env)}`,
  queue: (env, id) => `kawa-signal-buffer-${slug(id)}${suffix(env)}`,
  dlq: (env, id) => `kawa-signal-buffer-${slug(id)}-dlq${suffix(env)}`,
  receiver: (env, id) => { if (env !== 'staging') throw new Error('receivers exist only in STAGING'); return `kawa-staging-receiver-${slug(id)}`; },
  admin: (env) => { if (env !== 'staging') throw new Error('the HTTP admin exists only in STAGING (R4)'); return 'kawa-edge-admin-stg'; },
};

/** Every name a plan for `env` may touch must pass this, or the plan is refused. */
export function belongsTo(env, name) {
  if (env === 'staging') return /-stg$/.test(name) || /^kawa-staging-receiver-[a-z0-9-]+$/.test(name);
  if (env === 'prod') return /-prod$/.test(name);
  return false;
}

/** Marker var written into every Worker the deployer manages; read back to prove ownership. */
export const MANAGED_VAR = 'KAWA_EDGE_MANAGED';
export const BUILD_VAR = 'KAWA_EDGE_BUILD';
export const managedValue = (env, role) => `kawa-edge-nas:${env}:${role}`;
