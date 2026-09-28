/**
 * Ingress: POST <path_prefix><ingress token> → commit to SQLite → 200. Anything else is refused and
 * nothing is stored. GET /health for Container Manager and the operator.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { payloadFacts } from './audit.mjs';

const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); };

export function createServer({ store, config, dispatcher, log, audit = null }) {
  const rec = (e) => { if (audit) audit.record(e); };   // V0.1.1: audit never throws; transport unaffected
  const prefix = config.ingress.path_prefix;
  const ids = config.enabled.map(d => d.id);
  return http.createServer((req, res) => {
    const [pathname, qs = ''] = (req.url || '/').split('?');
    if (pathname === '/health' && req.method === 'GET') {
      let db = 'ok';
      try { if (!store.ping()) db = 'error'; } catch { db = 'error'; }
      const h = { status: db === 'ok' ? 'healthy' : 'unhealthy', db, destinations_enabled: ids.length };
      // V0.1.1: audit fields only when the audit UI is configured or the audit is degraded (V0.1 shape otherwise).
      if (audit && (audit.uiEnabled || audit.status === 'degraded')) Object.assign(h, { audit: audit.status, audit_url: '/audit' });
      return json(res, db === 'ok' ? 200 : 503, h);
    }
    if (audit && (pathname === '/audit' || pathname.startsWith('/audit/'))) return audit.handle(req, res, pathname, qs);   // V0.1.1
    if (!pathname.startsWith(prefix)) return json(res, 404, { status: 'not_found' });
    if (req.method !== 'POST') return json(res, 405, { status: 'method_not_allowed' });
    const request_id = crypto.randomUUID();   // V0.1.1 correlation id (not sent back: the ACK is unchanged)
    const cf = { cf_ray: req.headers['cf-ray'] || null, source_ip: req.headers['cf-connecting-ip'] || req.socket.remoteAddress || null };
    if (!same(pathname.slice(prefix.length), config.ingress.secret)) { log('REJECTED', { reason: 'bad_path_token', remote: req.socket.remoteAddress }); json(res, 401, { status: 'unauthorized' }); return rec({ event_type: 'INGRESS_REJECTED_AUTH', request_id, status: 'REJECTED', http_status: 401, detail: cf }); }
    const chunks = []; let size = 0; let tooBig = false;
    req.on('data', (c) => { size += c.length; if (size > config.ingress.max_body_bytes) { tooBig = true; req.destroy(); } else chunks.push(c); });
    req.on('error', () => {});
    req.on('end', () => {
      if (tooBig) return;
      const body = Buffer.concat(chunks);
      const t0 = Date.now();
      log('RECEIVED', { bytes: body.length, content_type: req.headers['content-type'] || '-', cf_ray: req.headers['cf-ray'] });
      let id;
      try {
        id = store.insertEvent({ method: req.method, query: qs ? `?${qs}` : '', headers: req.headers, body, remote: req.headers['cf-connecting-ip'] || req.socket.remoteAddress }, ids);
      } catch (e) {
        log('PERSIST_FAILED', { err: e.code || e.name });
        json(res, 503, { status: 'unavailable' });   // never 2xx before the commit
        return auditIngress(null, e.code || e.name);
      }
      log('PERSISTED', { event: id, destinations: ids.join(',') });
      json(res, 200, { status: 'accepted', event_id: id });
      dispatcher.notify();
      auditIngress(id, null);
      // V0.1.1: written AFTER the ACK (never delays it); facts only, never the body or headers.
      function auditIngress(eventId, err) {
        if (!audit) return;
        const f = payloadFacts(body, req.headers['content-type']);
        const base = { request_id, payload_sha256: f.payload_sha256, body_bytes: f.body_bytes, content_type: f.content_type, symbol: f.symbol, order_id: f.order_id };
        rec({ ...base, ts_ms: t0, event_type: 'INGRESS_RECEIVED', status: 'RECEIVED', detail: { ...f.detail, ...cf } });
        if (eventId === null) rec({ ...base, event_type: 'INGRESS_PERSIST_FAILED', status: 'FAILED', http_status: 503, error_code: String(err) });
        else rec({ ...base, event_id: eventId, event_type: 'INGRESS_PERSISTED', status: 'PERSISTED', http_status: 200, latency_ms: Date.now() - t0, detail: { destinations: ids } });
      }
    });
    req.on('close', () => { if (tooBig && !res.headersSent) { log('REJECTED', { reason: 'body_too_large' }); json(res, 413, { status: 'too_large' }); rec({ event_type: 'INGRESS_REJECTED_TOO_LARGE', request_id, status: 'REJECTED', http_status: 413, body_bytes: size, detail: cf }); } });
  });
}
