/**
 * MOCK CLOUDFLARE API · test support only, never shipped into a deployment path.
 *
 * A small, stateful stand-in for the parts of api.cloudflare.com that the installer and the
 * PINNED wrangler use. The real wrangler binary is pointed at it through CLOUDFLARE_API_BASE_URL,
 * so the E2E test exercises the exact commands, flags and generated configs a NAS run uses —
 * without a Cloudflare account and without any network egress.
 *
 * It records every request (method, path, and which secret NAMES were uploaded — never values
 * in the journal) so tests can assert ordering, idempotency and that nothing touched PROD.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export function createMockCloudflare(opts = {}) {
  const accountId = opts.accountId || '0123456789abcdef0123456789abcdef';
  const state = {
    token: opts.token || 'mock-token-value-0000000000000000000000',
    tokenStatus: opts.tokenStatus || 'active',
    subdomain: opts.subdomain === undefined ? 'kawa-mock' : opts.subdomain,
    denyWrite: new Set(opts.denyWrite || []),        // e.g. ['queues'] to simulate a missing permission
    queues: new Map(),                                // name -> queue
    scripts: new Map(),                               // name -> script
    journal: [],
    secretValues: new Map(),                          // `${script}/${name}` -> value (for leak assertions)
  };
  for (const q of opts.queues || []) addQueue(q.name, q);
  for (const s of opts.scripts || []) state.scripts.set(s.name, { name: s.name, bindings: s.bindings || [], secrets: new Set(), subdomain: true, created_on: new Date().toISOString(), ...s });

  function addQueue(name, extra = {}) {
    const q = { queue_id: extra.queue_id || randomUUID().replace(/-/g, ''), queue_name: name,
                created_on: new Date().toISOString(), modified_on: new Date().toISOString(),
                producers: extra.producers || [], consumers: extra.consumers || [],
                settings: { delivery_delay: 0, delivery_paused: !!extra.paused, message_retention_period: 345600 },
                producers_total_count: (extra.producers || []).length,
                consumers_total_count: (extra.consumers || []).length };
    state.queues.set(name, q);
    return q;
  }

  const ok = (res, result, extra = {}) => send(res, 200, { success: true, errors: [], messages: [], result, ...extra });
  const fail = (res, status, code, message) => send(res, status, { success: false, errors: [{ code, message }], messages: [], result: null });
  function send(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  function parseMultipart(buf, contentType) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
    if (!m) return {};
    const boundary = '--' + (m[1] || m[2]);
    const parts = {};
    const text = buf.toString('latin1');
    for (const chunk of text.split(boundary)) {
      const idx = chunk.indexOf('\r\n\r\n');
      if (idx < 0) continue;
      const head = chunk.slice(0, idx);
      const name = /name="([^"]+)"/.exec(head);
      if (!name) continue;
      parts[name[1]] = chunk.slice(idx + 4).replace(/\r\n$/, '');
    }
    return parts;
  }

  function scriptView(s) {
    return { id: s.name, tag: s.name, etag: 'etag-' + s.name, created_on: s.created_on,
             modified_on: s.modified_on || s.created_on, handlers: s.handlers || ['fetch'],
             compatibility_date: s.compatibility_date || '2024-12-18', usage_model: 'standard' };
  }

  function recordBindings(s, metadata) {
    s.bindings = (metadata.bindings || []).filter(b => b.type !== 'secret_text' && b.type !== 'inherit');
    for (const b of metadata.bindings || []) {
      if (b.type === 'secret_text') { s.secrets.add(b.name); state.secretValues.set(`${s.name}/${b.name}`, b.text); }
    }
    s.compatibility_date = metadata.compatibility_date;
    s.main_module = metadata.main_module;
    s.migrations = metadata.migrations || null;
    s.exports = metadata.exports || null;
    s.modified_on = new Date().toISOString();
    // A queue consumer / producer relation, as Cloudflare would derive it.
    for (const b of s.bindings) {
      if (b.type === 'queue') {
        const q = state.queues.get(b.queue_name);
        if (q && !q.producers.find(p => p.script === s.name)) {
          q.producers.push({ type: 'worker', script: s.name }); q.producers_total_count = q.producers.length;
        }
      }
    }
  }

  function deleteScript(name, res, entry, url) {
      if (!state.scripts.has(name)) return fail(res, 404, 10007, 'workers.api.error.script_not_found');
      const dependents = [...state.scripts.values()].filter(o => o.name !== name && (o.bindings || []).some(b =>
        (b.type === 'service' && b.service === name) || (b.type === 'durable_object_namespace' && b.script_name === name)));
      entry.dependents = dependents.map(d => d.name);
      if (dependents.length && url.searchParams.get('force') !== 'true') return fail(res, 409, 10064, `script is referenced by ${entry.dependents.join(',')}`);
      state.scripts.delete(name); entry.script = name;
      for (const q of state.queues.values()) {
        q.consumers = q.consumers.filter(c => c.script !== name);
        q.producers = q.producers.filter(p => p.script !== name);
      }
      return ok(res, null);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://mock');
    const path = url.pathname.replace(/^\/client\/v4/, '');
    const chunks = []; for await (const c of req) chunks.push(c);
    const buf = Buffer.concat(chunks);
    const entry = { method: req.method, path, query: url.search };
    state.journal.push(entry);

    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${state.token}`) return fail(res, 403, 10000, 'Authentication error');

    let m;
    if (req.method === 'GET' && path === '/user/tokens/verify') {
      return ok(res, { id: 'tok-1', status: state.tokenStatus });
    }
    if (req.method === 'GET' && (m = /^\/accounts\/([^/]+)\/tokens\/verify$/.exec(path))) {
      return ok(res, { id: 'tok-1', status: state.tokenStatus });
    }
    if (req.method === 'GET' && path === '/memberships') {
      return ok(res, [{ id: 'mem-1', account: { id: accountId, name: 'Mock Account' }, status: 'accepted' }]);
    }
    if (req.method === 'GET' && path === '/accounts') {
      return ok(res, [{ id: accountId, name: 'Mock Account' }], { result_info: { page: 1, per_page: 50, count: 1, total_count: 1 } });
    }
    if (!(m = /^\/accounts\/([^/]+)(\/.*)?$/.exec(path))) return fail(res, 404, 7003, 'No route for that URI');
    if (m[1] !== accountId) return fail(res, 403, 9109, 'Unauthorized to access requested resource');
    const sub = m[2] || '';

    if (req.method === 'GET' && sub === '') return ok(res, { id: accountId, name: 'Mock Account' });

    // ---- workers.dev subdomain ------------------------------------------------------------
    if (sub === '/workers/subdomain' && req.method === 'GET') {
      if (!state.subdomain) return fail(res, 404, 10007, 'workers.api.error.no_subdomain');
      return ok(res, { subdomain: state.subdomain });
    }

    // ---- queues ---------------------------------------------------------------------------
    if (sub === '/queues' && req.method === 'GET') {
      const name = url.searchParams.get('name');
      let list = [...state.queues.values()];
      if (name) list = list.filter(q => q.queue_name === name);
      return ok(res, list, { result_info: { page: 1, per_page: 100, count: list.length, total_count: list.length, total_pages: 1 } });
    }
    if (sub === '/queues' && req.method === 'POST') {
      if (state.denyWrite.has('queues')) return fail(res, 403, 10000, 'Authentication error');
      const body = JSON.parse(buf.toString() || '{}');
      if (state.queues.has(body.queue_name)) return fail(res, 409, 11009, 'A queue with this name already exists');
      entry.queue = body.queue_name;
      return ok(res, addQueue(body.queue_name));
    }
    if ((m = /^\/queues\/([^/]+)$/.exec(sub))) {
      const q = [...state.queues.values()].find(x => x.queue_id === m[1]);
      if (!q) return fail(res, 404, 11000, 'Queue not found');
      if (req.method === 'GET') return ok(res, q);
      if (req.method === 'PATCH' || req.method === 'PUT') {
        if (state.denyWrite.has('queues')) return fail(res, 403, 10000, 'Authentication error');
        const body = JSON.parse(buf.toString() || '{}');
        entry.queue = q.queue_name; entry.settings = body.settings;
        if (body.settings) q.settings = { ...q.settings, ...body.settings };
        return ok(res, q);
      }
      if (req.method === 'DELETE') { state.queues.delete(q.queue_name); entry.queue = q.queue_name; return ok(res, null); }
    }
    if ((m = /^\/queues\/([^/]+)\/consumers(?:\/([^/]+))?$/.exec(sub))) {
      const q = [...state.queues.values()].find(x => x.queue_id === m[1]);
      if (!q) return fail(res, 404, 11000, 'Queue not found');
      if (req.method === 'GET') return ok(res, q.consumers);
      const body = buf.length ? JSON.parse(buf.toString()) : {};
      entry.queue = q.queue_name;
      if (req.method === 'POST') {
        if (q.consumers.find(c => c.script === body.script_name)) return fail(res, 409, 11004, 'consumer already exists');
        const c = { consumer_id: randomUUID().replace(/-/g, ''), script: body.script_name, script_name: body.script_name,
                    type: 'worker', settings: body.settings || {}, dead_letter_queue: body.dead_letter_queue };
        q.consumers.push(c); q.consumers_total_count = q.consumers.length;
        entry.consumer = body.script_name;
        return ok(res, c);
      }
      if (req.method === 'PUT') {
        const c = q.consumers.find(x => x.consumer_id === m[2]);
        if (!c) return fail(res, 404, 11005, 'consumer not found');
        Object.assign(c, { settings: body.settings || c.settings, dead_letter_queue: body.dead_letter_queue });
        entry.consumer = c.script;
        return ok(res, c);
      }
      if (req.method === 'DELETE') {
        q.consumers = q.consumers.filter(x => x.consumer_id !== m[2]); q.consumers_total_count = q.consumers.length;
        return ok(res, null);
      }
    }

    // ---- workers ---------------------------------------------------------------------------
    if (sub === '/workers/scripts' && req.method === 'GET') {
      return ok(res, [...state.scripts.values()].map(scriptView));
    }
    if (sub === '/workers/durable_objects/namespaces' && req.method === 'GET') {
      const out = [];
      for (const s of state.scripts.values()) {
        for (const cls of s.do_classes || []) out.push({ id: `ns-${s.name}-${cls}`, name: `${s.name}_${cls}`, script: s.name, class: cls, use_sqlite: true });
      }
      return ok(res, out, { result_info: { page: 1, per_page: 1000, count: out.length, total_count: out.length } });
    }
    if ((m = /^\/workers\/services\/([^/]+)$/.exec(sub)) && req.method === 'DELETE') {
      return deleteScript(m[1], res, entry, url);
    }
    if ((m = /^\/workers\/services\/([^/]+)$/.exec(sub)) && req.method === 'GET') {
      const s = state.scripts.get(m[1]);
      if (!s) return fail(res, 404, 10090, 'workers.api.error.service_not_found');
      return ok(res, { id: s.name, default_environment: { environment: 'production', script: scriptView(s) } });
    }
    if ((m = /^\/workers\/scripts\/([^/]+)$/.exec(sub))) {
      const name = m[1];
      if (req.method === 'PUT') {
        if (state.denyWrite.has('workers')) return fail(res, 403, 10000, 'Authentication error');
        const parts = parseMultipart(buf, req.headers['content-type']);
        const metadata = JSON.parse(parts.metadata || '{}');
        let s = state.scripts.get(name);
        const created = !s;
        if (!s) { s = { name, secrets: new Set(), subdomain: false, created_on: new Date().toISOString() }; state.scripts.set(name, s); }
        // Existing secrets survive an upload, as on Cloudflare (inherit / keep_bindings).
        recordBindings(s, metadata);
        s.do_classes = [...new Set([...(s.do_classes || []),
          ...Object.entries(metadata.exports || {}).filter(([, v]) => v && v.type === 'durable-object').map(([k]) => k),
          ...((metadata.migrations && metadata.migrations.new_sqlite_classes) || [])])];
        entry.script = name; entry.created = created;
        entry.binding_names = (metadata.bindings || []).map(b => `${b.type}:${b.name}`);
        entry.secret_names = (metadata.bindings || []).filter(b => b.type === 'secret_text').map(b => b.name);
        return ok(res, { ...scriptView(s), startup_time_ms: 5, deployment_id: randomUUID(), has_modules: true });
      }
      if (req.method === 'DELETE') return deleteScript(name, res, entry, url);
      if (req.method === 'GET') {
        const s = state.scripts.get(name);
        if (!s) return fail(res, 404, 10007, 'workers.api.error.script_not_found');
        return ok(res, scriptView(s));
      }
    }
    if ((m = /^\/workers\/scripts\/([^/]+)\/(settings|script-settings)$/.exec(sub))) {
      const s = state.scripts.get(m[1]);
      if (!s) return fail(res, 404, 10007, 'workers.api.error.script_not_found');
      if (req.method === 'GET') {
        return ok(res, { bindings: [...s.bindings, ...[...s.secrets].map(n => ({ type: 'secret_text', name: n }))],
                         compatibility_date: s.compatibility_date, logpush: false, observability: null,
                         tail_consumers: [], placement: {}, usage_model: 'standard', tags: [] });
      }
      return ok(res, {});
    }
    if ((m = /^\/workers\/scripts\/([^/]+)\/subdomain$/.exec(sub))) {
      const s = state.scripts.get(m[1]);
      if (!s) return fail(res, 404, 10007, 'workers.api.error.script_not_found');
      if (req.method === 'GET') return ok(res, { enabled: !!s.subdomain, previews_enabled: !!s.previews });
      const body = JSON.parse(buf.toString() || '{}');
      s.subdomain = !!body.enabled; s.previews = !!body.previews_enabled;
      entry.script = s.name;
      return ok(res, { enabled: s.subdomain, previews_enabled: s.previews });
    }
    if ((m = /^\/workers\/scripts\/([^/]+)\/schedules$/.exec(sub))) {
      return ok(res, { schedules: [] });
    }
    if ((m = /^\/workers\/scripts\/([^/]+)\/secrets$/.exec(sub))) {
      const s = state.scripts.get(m[1]);
      if (!s) return fail(res, 404, 10007, 'workers.api.error.script_not_found');
      if (req.method === 'GET') return ok(res, [...s.secrets].map(n => ({ name: n, type: 'secret_text' })));
      if (req.method === 'PUT') {
        const body = JSON.parse(buf.toString() || '{}');
        s.secrets.add(body.name); state.secretValues.set(`${s.name}/${body.name}`, body.text);
        entry.script = s.name; entry.secret_names = [body.name];
        return ok(res, { name: body.name, type: 'secret_text' });
      }
    }
    if ((m = /^\/workers\/scripts\/([^/]+)\/secrets\/([^/]+)$/.exec(sub)) && req.method === 'DELETE') {
      const s = state.scripts.get(m[1]);
      if (s) s.secrets.delete(decodeURIComponent(m[2]));
      return ok(res, null);
    }
    if ((m = /^\/workers\/scripts\/([^/]+)\/(versions|deployments)/.exec(sub))) {
      if (req.method === 'GET') return ok(res, { items: [], deployments: [], latest: null });
      return ok(res, { id: randomUUID() });
    }
    if ((m = /^\/workers\/scripts\/([^/]+)\/references$/.exec(sub)) && req.method === 'GET') {
      // Who depends on this script: service bindings and cross-script Durable Object bindings.
      const name = m[1];
      const incoming = [], dos = [];
      for (const other of state.scripts.values()) {
        for (const b of other.bindings || []) {
          if (b.type === 'service' && b.service === name) incoming.push({ service: other.name, environment: 'production', name: b.name });
          if (b.type === 'durable_object_namespace' && b.script_name === name) dos.push({ service: other.name, environment: 'production', durable_object_namespace_name: `${name}_${b.class_name}` });
        }
      }
      return ok(res, { services: { incoming, outgoing: [] }, durable_objects: dos, dispatch_outbounds: [], pages_function: false });
    }
    if ((m = /^\/workers\/tails\/by-consumer\/([^/]+)$/.exec(sub))) return ok(res, []);
    if ((m = /^\/workers\/scripts\/([^/]+)\/tails/.exec(sub))) {
      return ok(res, []);
    }
    if (sub.startsWith('/workers/domains/records')) return ok(res, []);
    // The documented minimal token has NO KV permission; answer as Cloudflare would.
    if (sub.startsWith('/storage/kv/namespaces')) return fail(res, 403, 10000, 'Authentication error');
    if ((m = /^\/workers\/services\/([^/]+)\/environments\/([^/]+)\/routes/.exec(sub))) return ok(res, []);

    entry.unhandled = true;
    return fail(res, 404, 7003, `MOCK: unhandled ${req.method} ${path}`);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => { res.writeHead(500); res.end(String(err && err.stack || err)); });
  });

  return {
    state, accountId,
    listen(port = 0) {
      return new Promise(resolve => server.listen(port, '127.0.0.1', () => {
        const addr = server.address();
        resolve(`http://127.0.0.1:${addr.port}/client/v4`);
      }));
    },
    close() { return new Promise(r => server.close(r)); },
  };
}

// Stand-alone mode, for manual rehearsal: `node mock-cloudflare.mjs 8788`
if (import.meta.url === `file://${process.argv[1]}`) {
  const mock = createMockCloudflare({ token: process.env.MOCK_TOKEN || undefined });
  mock.listen(Number(process.argv[2] || 8788)).then(u => console.log('MOCK CLOUDFLARE API at', u));
  setInterval(() => {
    const un = mock.state.journal.filter(j => j.unhandled);
    if (un.length) { console.log('UNHANDLED', JSON.stringify(un)); un.forEach(j => { j.unhandled = false; }); }
  }, 1000);
}
