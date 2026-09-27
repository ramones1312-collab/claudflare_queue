/**
 * One delivery worker per ENABLED destination. Each worker delivers its own backlog in event order;
 * a slow, failing or dead Hub only delays itself, never another Hub.
 */
import { STATUS } from './store.mjs';

// Never forwarded: hop-by-hop headers and those the HTTP client recomputes.
const DROP = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'expect']);
const RETRYABLE_4XX = new Set([408, 425, 429]);

export function createDispatcher({ store, config, log, fetchImpl = fetch, now = Date.now }) {
  const workers = new Map();
  let stopped = false;

  function delay(attempt) {                    // attempt = number of failed attempts so far (>= 1)
    const s = config.retry.schedule_seconds;
    return Math.round(s[Math.min(attempt - 1, s.length - 1)] * 1000);
  }

  async function deliverOnce(dest, row) {
    const headers = {};
    for (const [k, v] of Object.entries(JSON.parse(row.headers))) if (!DROP.has(k)) headers[k] = v;
    headers['x-kawa-dispatcher-event'] = String(row.event_id);
    headers['x-kawa-dispatcher-attempt'] = String(row.attempts + 1);
    const url = `${dest.scheme}://${dest.host}:${dest.port}${dest.path_prefix}${dest.secret}${row.query}`;
    const t0 = now();
    try {
      const res = await fetchImpl(url, { method: row.method, headers, body: row.body, redirect: 'manual', signal: AbortSignal.timeout(dest.timeout_ms) });
      await res.arrayBuffer().catch(() => {});
      return { http: res.status, ms: now() - t0 };
    } catch (e) {
      const err = e && (e.name === 'TimeoutError' ? 'TIMEOUT' : (e.cause && e.cause.code) || e.name || 'ERROR');
      return { http: null, err: String(err), ms: now() - t0 };
    }
  }

  async function step(dest) {
    const row = store.head(dest.id);
    if (!row) return { idle: true };
    const wait = row.next_retry_at - now();
    if (wait > 0) return { wait };
    const r = await deliverOnce(dest, row);
    const attempt = row.attempts + 1;
    const f = { event: row.event_id, attempt, http: r.http, ms: r.ms };
    if (r.http !== null && r.http >= 200 && r.http < 300) {
      store.delivered(row.event_id, dest.id, r.http);
      log(`DELIVERED ${dest.id}`, f);
    } else if (r.http !== null && r.http < 500 && !RETRYABLE_4XX.has(r.http)) {
      // The Hub answered and refused (auth, bad request, duplicate…): retrying cannot change that.
      store.failedPermanent(row.event_id, dest.id, r.http, `HTTP ${r.http}`);
      log(`FAILED_PERMANENT ${dest.id}`, f);
    } else if (config.retry.max_attempts && attempt >= config.retry.max_attempts) {
      store.failedPermanent(row.event_id, dest.id, r.http, r.err || `HTTP ${r.http}`);
      log(`FAILED_PERMANENT ${dest.id}`, { ...f, err: r.err, reason: 'max_attempts' });
    } else {
      const d = delay(attempt);
      store.retry(row.event_id, dest.id, r.http, r.err || `HTTP ${r.http}`, now() + d);
      log(`RETRY ${dest.id}`, { ...f, err: r.err, next_in_s: d / 1000 });
    }
    return {};
  }

  function start(dest) {
    const w = { wake: null, running: null };
    const sleep = (ms) => new Promise(res => { const t = setTimeout(res, ms); w.wake = () => { clearTimeout(t); res(); }; });
    w.running = (async () => {
      while (!stopped) {
        let r;
        try { r = await step(dest); } catch (e) { log(`WORKER_ERROR ${dest.id}`, { err: e.code || e.name }); r = { wait: 1000 }; }
        if (stopped) break;
        if (r.idle) await sleep(1000);                 // woken immediately by notify() on a new event
        else if (r.wait) await sleep(Math.min(r.wait, 1000));
      }
    })();
    workers.set(dest.id, w);
  }

  return {
    start() { for (const d of config.enabled) start(d); },
    notify() { for (const w of workers.values()) if (w.wake) w.wake(); },
    async stop() { stopped = true; for (const w of workers.values()) { if (w.wake) w.wake(); } await Promise.all([...workers.values()].map(w => w.running)); },
  };
}
