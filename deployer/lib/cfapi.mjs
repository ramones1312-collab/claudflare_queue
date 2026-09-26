/**
 * Minimal Cloudflare REST client for READ-ONLY preflight and state inspection, plus queue
 * creation. Deploys go through the pinned wrangler instead. A 403 is mapped to the exact token
 * permission that is missing, so the operator can fix the token without guessing.
 */
import { KawaError } from './log.mjs';

const PERMISSION = {
  queues: 'Account · Queues · Edit',
  scripts: 'Account · Workers Scripts · Edit',
  account: 'Account · Account Settings · Read',
  analytics: 'Account · Account Analytics · Read',
};

export function createCfApi({ token, accountId, base = process.env.CLOUDFLARE_API_BASE_URL || 'https://api.cloudflare.com/client/v4' }) {
  async function call(method, path, { body, perm, allow404 = false } = {}) {
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      throw new KawaError('CF_UNREACHABLE', `cannot reach the Cloudflare API (${err.cause && err.cause.code || err.name})`,
        'The deployer needs outbound HTTPS to api.cloudflare.com. Check the NAS DNS / Internet access.');
    }
    let json = null;
    try { json = await res.json(); } catch { /* non-json */ }
    if (res.status === 404 && allow404) return null;
    if (res.status === 401 || res.status === 403) {
      throw new KawaError('CF_PERMISSION', `Cloudflare refused ${method} ${path.replace(accountId, '<account>')} (${res.status})`,
        perm ? `The token is missing: ${PERMISSION[perm]} (or it is scoped to another account).` : 'Check the token and its account scope.');
    }
    if (!res.ok || !json || json.success === false) {
      const e = json && json.errors && json.errors[0];
      throw new KawaError('CF_API_ERROR', `Cloudflare API ${method} ${path.replace(accountId, '<account>')} -> ${res.status}${e ? ` ${e.code}: ${e.message}` : ''}`);
    }
    return json;
  }

  async function paged(path, perm) {
    const outList = [];
    for (let page = 1; page < 100; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const j = await call('GET', `${path}${sep}page=${page}&per_page=100`, { perm });
      const list = Array.isArray(j.result) ? j.result : [];
      outList.push(...list);
      const info = j.result_info;
      if (!info || list.length === 0 || outList.length >= (info.total_count ?? outList.length) || list.length < 100) break;
    }
    return outList;
  }

  const A = `/accounts/${accountId}`;
  return {
    async verifyToken() {
      // User tokens verify at /user/tokens/verify; account-owned tokens at /accounts/:id/tokens/verify.
      for (const p of ['/user/tokens/verify', `${A}/tokens/verify`]) {
        try { const j = await call('GET', p); if (j && j.result) return j.result; } catch (err) { if (err.code === 'CF_UNREACHABLE') throw err; }
      }
      throw new KawaError('TOKEN_INVALID', 'Cloudflare does not recognise this API token (expired, revoked or mistyped)');
    },
    async account() {
      try { return (await call('GET', A, { perm: 'account' })).result; } catch (err) {
        if (err.code === 'CF_PERMISSION') return null;   // optional permission: identity shown only if granted
        throw err;
      }
    },
    listScripts: async () => (await call('GET', `${A}/workers/scripts`, { perm: 'scripts' })).result || [],
    async scriptSettings(name) {
      const j = await call('GET', `${A}/workers/scripts/${encodeURIComponent(name)}/settings`, { perm: 'scripts', allow404: true });
      return j ? j.result : null;
    },
    async secretNames(name) {
      const j = await call('GET', `${A}/workers/scripts/${encodeURIComponent(name)}/secrets`, { perm: 'scripts', allow404: true });
      return j ? (j.result || []).map(s => s.name) : null;
    },
    async subdomain() {
      const j = await call('GET', `${A}/workers/subdomain`, { perm: 'scripts', allow404: true });
      return j && j.result ? j.result.subdomain : null;
    },
    doNamespaces: () => paged(`${A}/workers/durable_objects/namespaces`, 'scripts'),
    listQueues: () => paged(`${A}/queues`, 'queues'),
    async queue(id) { return (await call('GET', `${A}/queues/${id}`, { perm: 'queues' })).result; },
    async createQueue(name) { return (await call('POST', `${A}/queues`, { body: { queue_name: name }, perm: 'queues' })).result; },
    /** Best-effort backlog of one queue via GraphQL Analytics; null when the permission is absent. */
    async queueBacklog(queueId) {
      const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const query = `query($a:String!,$q:String!,$s:Time!){viewer{accounts(filter:{accountTag:$a}){queueBacklogAdaptiveGroups(limit:1,filter:{queueId:$q,datetime_geq:$s},orderBy:[datetimeMinute_DESC]){avg{messages}}}}}`;
      try {
        const j = await call('POST', '/graphql', { body: { query, variables: { a: accountId, q: queueId, s: since } }, perm: 'analytics' });
        const g = j && j.data && j.data.viewer.accounts[0].queueBacklogAdaptiveGroups[0];
        return g ? g.avg.messages : 0;
      } catch { return null; }
    },
  };
}
