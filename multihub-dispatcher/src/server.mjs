/**
 * Ingress: POST <path_prefix><ingress token> → commit to SQLite → 200. Anything else is refused and
 * nothing is stored. GET /health for Container Manager and the operator.
 */
import http from 'node:http';
import crypto from 'node:crypto';

const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); };

export function createServer({ store, config, dispatcher, log }) {
  const prefix = config.ingress.path_prefix;
  const ids = config.enabled.map(d => d.id);
  return http.createServer((req, res) => {
    const [pathname, qs = ''] = (req.url || '/').split('?');
    if (pathname === '/health' && req.method === 'GET') {
      let db = 'ok';
      try { if (!store.ping()) db = 'error'; } catch { db = 'error'; }
      return json(res, db === 'ok' ? 200 : 503, { status: db === 'ok' ? 'healthy' : 'unhealthy', db, destinations_enabled: ids.length });
    }
    if (!pathname.startsWith(prefix)) return json(res, 404, { status: 'not_found' });
    if (req.method !== 'POST') return json(res, 405, { status: 'method_not_allowed' });
    if (!same(pathname.slice(prefix.length), config.ingress.secret)) { log('REJECTED', { reason: 'bad_path_token', remote: req.socket.remoteAddress }); return json(res, 401, { status: 'unauthorized' }); }
    const chunks = []; let size = 0; let tooBig = false;
    req.on('data', (c) => { size += c.length; if (size > config.ingress.max_body_bytes) { tooBig = true; req.destroy(); } else chunks.push(c); });
    req.on('error', () => {});
    req.on('end', () => {
      if (tooBig) return;
      const body = Buffer.concat(chunks);
      log('RECEIVED', { bytes: body.length, content_type: req.headers['content-type'] || '-', cf_ray: req.headers['cf-ray'] });
      let id;
      try {
        id = store.insertEvent({ method: req.method, query: qs ? `?${qs}` : '', headers: req.headers, body, remote: req.headers['cf-connecting-ip'] || req.socket.remoteAddress }, ids);
      } catch (e) {
        log('PERSIST_FAILED', { err: e.code || e.name });
        return json(res, 503, { status: 'unavailable' });   // never 2xx before the commit
      }
      log('PERSISTED', { event: id, destinations: ids.join(',') });
      json(res, 200, { status: 'accepted', event_id: id });
      dispatcher.notify();
    });
    req.on('close', () => { if (tooBig && !res.headersSent) { log('REJECTED', { reason: 'body_too_large' }); json(res, 413, { status: 'too_large' }); } });
  });
}
