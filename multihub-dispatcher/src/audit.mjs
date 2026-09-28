/**
 * V0.1.1 · Durable audit & observability (OBSERVABILITY-ONLY).
 *
 * - Own SQLite connection to the same dispatcher.db: an audit failure can never roll back or block a core
 *   transaction; the core connection keeps its settings. Table audit_events is append-only (retention aside).
 * - record() never throws: on failure the audit is "degraded", AUDIT_WRITE_FAILED goes to stdout, transport
 *   continues untouched.
 * - Never stored: body, raw headers, URL paths, tokens, Authorization, cookies. Only a payload hash, its size,
 *   the content type and best-effort JSON fields (symbol, order id...).
 * - /audit* : HTTP Basic Auth (user "audit", password = secrets/audit_admin_token), constant-time, LAN only,
 *   refused whenever the request shows Cloudflare evidence (it came through the Tunnel).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const AUDIT_SCHEMA_VERSION = 1;
export const AUDIT_DEFAULTS = Object.freeze({ enabled: true, secret_file: 'audit_admin_token', retention_days: 90, ui_default_rows: 200, ui_max_rows: 5000 });
const COLUMNS = ['audit_id', 'ts_ms', 'request_id', 'event_id', 'event_type', 'destination_id', 'attempt', 'status', 'http_status', 'latency_ms',
  'error_code', 'next_retry_at', 'payload_sha256', 'body_bytes', 'content_type', 'symbol', 'order_id', 'detail_json'];

const DDL = `
  CREATE TABLE IF NOT EXISTS audit_events (
    audit_id INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL, request_id TEXT, event_id INTEGER,
    event_type TEXT NOT NULL, destination_id TEXT, attempt INTEGER, status TEXT, http_status INTEGER, latency_ms INTEGER,
    error_code TEXT, next_retry_at INTEGER, payload_sha256 TEXT, body_bytes INTEGER, content_type TEXT, symbol TEXT,
    order_id TEXT, detail_json TEXT);
  CREATE INDEX IF NOT EXISTS audit_event_id ON audit_events(event_id, audit_id);
  CREATE INDEX IF NOT EXISTS audit_destination ON audit_events(destination_id, audit_id);
  CREATE INDEX IF NOT EXISTS audit_ts ON audit_events(ts_ms);`;

/** Settings from the optional "audit" block of destinations.json; anything invalid falls back to the default. */
export function auditSettings(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const s = { ...AUDIT_DEFAULTS }, warnings = [];
  const int = (k, min, max) => { if (r[k] === undefined) return; if (Number.isInteger(r[k]) && r[k] >= min && r[k] <= max) s[k] = r[k]; else warnings.push(k); };
  if (r.enabled !== undefined) { if (typeof r.enabled === 'boolean') s.enabled = r.enabled; else warnings.push('enabled'); }
  if (r.secret_file !== undefined) { if (typeof r.secret_file === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(r.secret_file)) s.secret_file = r.secret_file; else warnings.push('secret_file'); }
  int('retention_days', 1, 3650); int('ui_default_rows', 1, 100000); int('ui_max_rows', 1, 100000);
  if (s.ui_default_rows > s.ui_max_rows) s.ui_default_rows = s.ui_max_rows;
  return { settings: s, warnings };
}

const clip = (v, n = 64) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, n) : null);

/** Best-effort, read-only look at a JSON body. Never validates, never rejects, never alters ingress. */
export function payloadFacts(body, contentType) {
  const facts = { payload_sha256: crypto.createHash('sha256').update(body).digest('hex'), body_bytes: body.length,
    content_type: clip(contentType || null, 200), symbol: null, order_id: null, detail: {} };
  try {
    const t = body.toString('utf8').trim();
    if (!t.startsWith('{')) return facts;
    const j = JSON.parse(t);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return facts;
    facts.symbol = clip(j.symbol ?? j.ticker ?? null);
    facts.order_id = clip(j.order_id ?? j.orderId ?? j.order_ID ?? null);
    const a = clip(j.order_action ?? j.action ?? j.side ?? null), m = clip(j.market_position ?? j.marketPosition ?? null);
    if (a !== null) facts.detail.order_action = a;
    if (m !== null) facts.detail.market_position = m;
  } catch { /* not JSON: semantic fields stay null */ }
  return facts;
}

const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^::1$/, /^f[cd][0-9a-f]{2}:/i, /^fe80:/i];
export const isLan = (addr) => { const a = String(addr || '').replace(/^::ffff:/i, ''); return PRIVATE.some(re => re.test(a)); };
const CF_HEADERS = ['cf-ray', 'cf-connecting-ip', 'cf-ipcountry', 'cf-visitor', 'cf-warp-tag-id', 'cf-worker', 'cf-connecting-ipv6'];
export const viaCloudflare = (h) => CF_HEADERS.some(k => h[k] !== undefined) || /cloudflare/i.test(String(h['cdn-loop'] || ''));

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sameSecret = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

export function createAudit({ dbFile, dataDir, secretsDir, settings, config, store, log, version, now = Date.now, knownSecrets = [] }) {
  const auditDir = path.join(dataDir, 'audit'), exportDir = path.join(auditDir, 'exports'), statusFile = path.join(auditDir, 'dispatcher_status.json');
  let db = null, ins = null, state = 'ok', failures = 0, lastFailLog = 0;
  const dests = new Map();                     // destination_id -> last known delivery facts (for the status file)
  let lastEventId = null, lastReceivedAt = null;
  const degrade = (err, what) => {
    state = 'degraded'; failures++;
    if (now() - lastFailLog > 60000) { lastFailLog = now(); log('AUDIT_WRITE_FAILED', { what, err: (err && (err.code || err.name)) || 'ERROR', failures }); }
  };

  if (settings.enabled) {
    try {
      fs.mkdirSync(exportDir, { recursive: true });
      db = new DatabaseSync(dbFile);
      // WAL is already set by the core; NORMAL on THIS connection only: durable across a process crash.
      db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
      db.exec(DDL);
      ins = db.prepare(`INSERT INTO audit_events(${COLUMNS.slice(1).join(',')}) VALUES (${COLUMNS.slice(1).map(() => '?').join(',')})`);
    } catch (e) { degrade(e, 'open'); }
  }

  // UI credentials: a missing/weak/reused token disables the UI only; recording and transport go on.
  let token = null, uiReason = settings.enabled ? null : 'audit disabled';
  if (settings.enabled) {
    try { token = fs.readFileSync(path.join(secretsDir, settings.secret_file), 'utf8').trim(); } catch { token = ''; }
    if (!token) { uiReason = `secrets/${settings.secret_file} missing or empty`; token = null; }
    else if (token.length < 16 || /\s/.test(token)) { uiReason = `secrets/${settings.secret_file} must be at least 16 characters without spaces`; token = null; }
    else if (knownSecrets.some(k => k && sameSecret(k, token))) { uiReason = 'the audit token must not reuse the ingress or a Hub secret'; token = null; }
    if (token) log.addSecret(token);
    if (uiReason) log('AUDIT_UI_DISABLED', { reason: uiReason });
  }

  function record(e) {
    if (!settings.enabled) return;
    const ts = e.ts_ms ?? now();
    if (e.event_type === 'INGRESS_PERSISTED') { lastEventId = e.event_id; lastReceivedAt = ts; }
    if (e.destination_id) {
      const d = dests.get(e.destination_id) || {};
      Object.assign(d, { last_event_type: e.event_type, last_event_id: e.event_id ?? d.last_event_id, last_at: ts });
      if (e.event_type === 'DELIVERED') Object.assign(d, { last_delivered_event_id: e.event_id, last_delivered_at: ts, last_http_status: e.http_status });
      if (e.event_type === 'RETRY_SCHEDULED' || e.event_type === 'FAILED_PERMANENT' || e.event_type === 'WORKER_ERROR') Object.assign(d, { last_error: e.error_code ?? null, last_error_at: ts, last_http_status: e.http_status ?? null });
      dests.set(e.destination_id, d);
    }
    scheduleStatus();
    if (!ins) { degrade(null, 'not open'); return; }
    queue.push([ts, e.request_id ?? null, e.event_id ?? null, e.event_type, e.destination_id ?? null, e.attempt ?? null, e.status ?? null,
      e.http_status ?? null, e.latency_ms ?? null, e.error_code ?? null, e.next_retry_at ?? null, e.payload_sha256 ?? null,
      e.body_bytes ?? null, e.content_type ?? null, e.symbol ?? null, e.order_id ?? null,
      e.detail && Object.keys(e.detail).length ? JSON.stringify(e.detail) : null]);
    if (!flushScheduled) { flushScheduled = true; setImmediate(flush); }
  }

  // Rows recorded during one event-loop turn are committed together (one transaction instead of one per row):
  // the audit costs the transport a single short write per turn. Worst case on an abrupt kill: the rows of
  // that last turn (milliseconds). The audit is not authoritative; the transport tables are untouched.
  const queue = [];
  let flushScheduled = false;
  function flush() {
    flushScheduled = false;
    if (!queue.length || !ins) return;
    const batch = queue.splice(0, queue.length);
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const row of batch) ins.run(...row);
      db.exec('COMMIT');
      if (state === 'degraded' && failures) state = 'ok';          // recovered: the next write succeeded
    } catch (err) { try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ } degrade(err, 'insert'); }
  }

  // ---- offline status file: temp -> fsync -> rename; observability only, never read by the core ----
  let statusTimer = null;
  function writeStatus() {
    statusTimer = null;
    flush();
    if (!settings.enabled) return;
    let backlog = {};
    try { backlog = store.openCounts(); } catch { /* core busy/closing: keep last known */ }
    const out = { schema_version: AUDIT_SCHEMA_VERSION, version, updated_at: new Date(now()).toISOString(), audit_status: state,
      last_event_id: lastEventId, last_received_at: lastReceivedAt ? new Date(lastReceivedAt).toISOString() : null, destinations: {} };
    const ids = new Set([...config.destinations.map(d => d.id), ...dests.keys(), ...Object.keys(backlog)]);
    for (const id of [...ids].sort()) {
      const c = config.destinations.find(d => d.id === id), d = dests.get(id) || {};
      out.destinations[id] = { enabled: !!(c && c.enabled), backlog: backlog[id] || 0, ...d,
        last_at: d.last_at ? new Date(d.last_at).toISOString() : null,
        last_delivered_at: d.last_delivered_at ? new Date(d.last_delivered_at).toISOString() : null,
        last_error_at: d.last_error_at ? new Date(d.last_error_at).toISOString() : null };
    }
    try {
      const tmp = `${statusFile}.tmp-${process.pid}`;
      const fd = fs.openSync(tmp, 'w', 0o644);
      try { fs.writeSync(fd, JSON.stringify(out, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, statusFile);
    } catch (e) { degrade(e, 'status_file'); }
  }
  function scheduleStatus() { if (!statusTimer && settings.enabled) { statusTimer = setTimeout(writeStatus, 250); statusTimer.unref(); } }

  // ---- retention: audit_events only; at startup and once a day; never VACUUM ----
  function purge() {
    if (!ins) return 0;
    flush();
    try {
      const cutoff = now() - settings.retention_days * 86400000;
      const r = db.prepare('DELETE FROM audit_events WHERE ts_ms < ?').run(cutoff);
      const n = Number(r.changes);
      record({ event_type: 'AUDIT_RETENTION_CLEANUP', status: 'OK', detail: { deleted: n, retention_days: settings.retention_days, cutoff: new Date(cutoff).toISOString() } });
      return n;
    } catch (e) { degrade(e, 'retention'); return 0; }
  }
  const purgeTimer = setInterval(purge, 86400000); purgeTimer.unref();

  // ---- queries (UI, API, exports share the same filters) ----
  const FILTERS = { event_id: /^\d{1,15}$/, request_id: /^[0-9a-f-]{36}$/, destination_id: /^[A-Z][A-Z0-9_]{0,31}$/, event_type: /^[A-Z_]{1,40}$/, status: /^[A-Z_]{1,40}$/ };
  function parseFilters(q) {
    const f = {};
    for (const [k, re] of Object.entries(FILTERS)) { const v = q.get(k); if (v) { if (!re.test(v)) throw new Error(`invalid ${k}`); f[k] = v; } }
    for (const k of ['from', 'to']) {
      const v = q.get(k);
      if (!v) continue;
      const t = /^\d{1,15}$/.test(v) ? Number(v) : Date.parse(v);
      if (!Number.isFinite(t)) throw new Error(`invalid ${k}`);
      f[k] = t;
    }
    const l = q.get('limit');
    if (l && !/^\d{1,7}$/.test(l)) throw new Error('invalid limit');
    f.limit = Math.max(1, Math.min(l ? Number(l) : settings.ui_default_rows, settings.ui_max_rows));
    return f;
  }
  function query(f) {
    flush();
    const w = [], a = [];
    if (f.event_id) { w.push('event_id = ?'); a.push(Number(f.event_id)); }
    if (f.request_id) { w.push('(request_id = ? OR event_id IN (SELECT event_id FROM audit_events WHERE request_id = ? AND event_id IS NOT NULL))'); a.push(f.request_id, f.request_id); }
    if (f.destination_id) { w.push('destination_id = ?'); a.push(f.destination_id); }
    if (f.event_type) { w.push('event_type = ?'); a.push(f.event_type); }
    if (f.status) { w.push('status = ?'); a.push(f.status); }
    if (f.from !== undefined) { w.push('ts_ms >= ?'); a.push(f.from); }
    if (f.to !== undefined) { w.push('ts_ms <= ?'); a.push(f.to); }
    const sql = `SELECT ${COLUMNS.join(',')} FROM audit_events ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY audit_id DESC LIMIT ?`;
    return db.prepare(sql).all(...a, f.limit);
  }
  function summary() {
    let backlog = {};
    try { backlog = store.openCounts(); } catch { /* shown as unknown */ }
    const known = [...new Set([...config.destinations.map(d => d.id), ...Object.keys(backlog), ...dests.keys()])].sort();
    return { version, dispatcher: 'running', audit: state, audit_ui: token ? 'enabled' : 'disabled', last_event_id: lastEventId,
      destinations: known.map(id => { const c = config.destinations.find(d => d.id === id); return { id, enabled: !!(c && c.enabled), backlog: backlog[id] || 0, ...(dests.get(id) || {}) }; }) };
  }

  // ---- exports ----
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;          // spreadsheet formula injection
    return `"${s.replace(/"/g, '""')}"`;
  };
  const toCsv = (rows) => '﻿' + [COLUMNS.join(','), ...rows.map(r => COLUMNS.map(c => cell(r[c])).join(','))].join('\r\n') + '\r\n';
  function persistExport(ext, text) {
    const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
    for (let i = 0; i < 1000; i++) {
      const name = `dispatcher_audit_${stamp}${i ? `_${i}` : ''}.${ext}`;
      try { fs.writeFileSync(path.join(exportDir, name), text, { flag: 'wx' }); return name; } catch (e) { if (e.code !== 'EEXIST') { degrade(e, 'export_file'); return null; } }
    }
    return null;
  }

  // ---- HTTP: /audit* ----
  const SEC = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };
  const send = (res, code, type, body, extra = {}) => { res.writeHead(code, { ...SEC, 'content-type': type, 'content-length': Buffer.byteLength(body), ...extra }); res.end(body); };
  const jsonOut = (res, code, obj, extra) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj), extra);
  const UI_DIR = new URL('./audit-ui/', import.meta.url);
  const asset = (n) => fs.readFileSync(new URL(n, UI_DIR), 'utf8');
  const authorized = (h) => {
    const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(String(h || '').trim());
    if (!m || !token) return false;
    const s = Buffer.from(m[1], 'base64').toString('utf8'), i = s.indexOf(':');
    if (i < 0) return false;
    const userOk = sameSecret(s.slice(0, i), 'audit'), passOk = sameSecret(s.slice(i + 1), token);
    return userOk && passOk;
  };

  function handle(req, res, pathname, qs) {
    if (!settings.enabled) { jsonOut(res, 404, { status: 'not_found' }); return; }
    if (viaCloudflare(req.headers) || !isLan(req.socket.remoteAddress)) { jsonOut(res, 403, { status: 'forbidden' }); return; }
    if (!token) { jsonOut(res, 503, { status: 'audit_ui_not_configured' }); return; }
    if (!authorized(req.headers.authorization)) { jsonOut(res, 401, { status: 'unauthorized' }, { 'www-authenticate': 'Basic realm="KAWA dispatcher audit", charset="UTF-8"' }); return; }
    if (req.method !== 'GET') { jsonOut(res, 405, { status: 'method_not_allowed' }); return; }
    const q = new URLSearchParams(qs || '');
    try {
      if (pathname === '/audit' || pathname === '/audit/') return send(res, 200, 'text/html; charset=utf-8', asset('index.html'));
      if (pathname === '/audit/app.js') return send(res, 200, 'text/javascript; charset=utf-8', asset('app.js'));
      if (pathname === '/audit/api/summary') return jsonOut(res, 200, summary());
      if (!db) return jsonOut(res, 503, { status: 'audit_unavailable' });
      if (pathname === '/audit/api/events') { const f = parseFilters(q); const events = query(f); return jsonOut(res, 200, { filters: f, count: events.length, events }); }
      if (pathname === '/audit/export.csv' || pathname === '/audit/export.json') {
        const f = parseFilters(q), events = query(f), csv = pathname.endsWith('.csv');
        const text = csv ? toCsv(events) : JSON.stringify({ schema_version: AUDIT_SCHEMA_VERSION, exported_at: new Date(now()).toISOString(), filters: f, count: events.length, events }, null, 2);
        const saved = persistExport(csv ? 'csv' : 'json', text);
        return send(res, 200, csv ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8', text,
          { 'content-disposition': `attachment; filename="${saved || `dispatcher_audit.${csv ? 'csv' : 'json'}`}"` });
      }
      return jsonOut(res, 404, { status: 'not_found' });
    } catch (e) {
      if (/^invalid /.test(e.message)) return jsonOut(res, 400, { status: 'bad_request', reason: e.message });
      degrade(e, 'read'); return jsonOut(res, 503, { status: 'audit_unavailable' });
    }
  }

  return {
    record, handle, purge, writeStatus, summary, flush,
    get status() { return settings.enabled ? state : 'disabled'; },
    get uiEnabled() { return !!token; },
    get db() { return db; },
    close() { clearInterval(purgeTimer); if (statusTimer) { clearTimeout(statusTimer); } writeStatus(); try { if (db) db.close(); } catch { /* closing */ } },
  };
}

/** CONFIG_INVALID happens before the dispatcher can start: record it best-effort, then the process exits. */
export function recordStandalone(dbFile, dataDir, event) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(dbFile);
    db.exec('PRAGMA busy_timeout=2000;'); db.exec(DDL);
    db.prepare('INSERT INTO audit_events(ts_ms, event_type, status, error_code, detail_json) VALUES (?,?,?,?,?)')
      .run(Date.now(), event.event_type, event.status || null, event.error_code || null, event.detail ? JSON.stringify(event.detail) : null);
    db.close();
    return true;
  } catch { return false; }
}
