/**
 * STAGING RECEIVER · a KAWA stand-in that CANNOT place an order.
 *
 * V1.2.2 · the observation ledger and the scripted behaviour now live in a SQLite-backed Durable
 * Object, not in module memory. An isolate can be evicted at any moment on real Cloudflare, so
 * anything used as GATE EVIDENCE has to survive that. The previous in-memory version could silently
 * lose the very ordering record the reorder gate depends on.
 *
 * It speaks the small part of KAWA's response contract the buffer depends on, and nothing else:
 *     202 {"ok":true,"code":"QUEUED"}            durable acceptance
 *     200 {"ok":true,"code":"DUPLICATE_REPLAY"}  a digest it has already accepted
 *
 * No credentials, no exchange, nothing imported from KAWA. The guarantee is structural: there is no
 * code here that could submit anything anywhere.  NOT FOR PRODUCTION.
 */
import { DurableObject } from 'cloudflare:workers';

/** Steady states persist; `*_once` entries are spent by a single request. */
const BEHAVIOURS = new Set(['ok', 'silent_once', 'fail5xx_once', 'permanent4xx', 'slow_once']);

export class ReceiverLedger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS observations(
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          ts_ms           INTEGER NOT NULL,
          edge_seq        INTEGER,
          digest          TEXT,
          received_digest TEXT,
          digest_match    INTEGER,
          bytes           INTEGER,
          attempt         INTEGER NOT NULL,
          behaviour       TEXT NOT NULL,
          outcome         TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS accepted(digest TEXT PRIMARY KEY, edge_seq INTEGER, ts_ms INTEGER);
        CREATE TABLE IF NOT EXISTS script(k TEXT PRIMARY KEY, v TEXT NOT NULL);
      `);
    });
  }

  _behaviour() {
    const r = [...this.sql.exec("SELECT v FROM script WHERE k='behaviour'")];
    return r.length ? r[0].v : 'ok';
  }

  async setBehaviour(b) {
    if (b === 'reset') { await this.reset(); return { ok: true, behaviour: 'ok', reset: true }; }
    if (!BEHAVIOURS.has(b)) return { ok: false, code: 'UNKNOWN_BEHAVIOUR' };
    this.sql.exec("INSERT OR REPLACE INTO script(k,v) VALUES('behaviour',?)", b);
    return { ok: true, behaviour: b };
  }

  /** Explicit reset so every scenario starts from a clean ledger. */
  async reset() {
    this.sql.exec('DELETE FROM observations');
    this.sql.exec('DELETE FROM accepted');
    this.sql.exec('DELETE FROM script');
    return { ok: true, reset: true };
  }

  /** Persist the observation BEFORE producing a reply: a lost answer is still recorded. */
  async observe({ edgeSeq, digest, receivedDigest, bytes }) {
    const behaviour = this._behaviour();
    const attempt = [...this.sql.exec(
      'SELECT COUNT(*) AS n FROM observations WHERE received_digest=?', receivedDigest)][0].n + 1;

    let outcome;
    if (behaviour === 'silent_once') outcome = 'SILENT';
    else if (behaviour === 'slow_once') outcome = 'SLOW';
    else if (behaviour === 'fail5xx_once') outcome = 'FAIL_5XX';
    else if (behaviour === 'permanent4xx') outcome = 'PERMANENT_4XX';
    else {
      const known = [...this.sql.exec('SELECT edge_seq FROM accepted WHERE digest=?', receivedDigest)];
      if (known.length) outcome = 'DUPLICATE';
      else {
        this.sql.exec('INSERT INTO accepted(digest, edge_seq, ts_ms) VALUES(?,?,?)',
                      receivedDigest, edgeSeq === null ? null : Number(edgeSeq), Date.now());
        outcome = 'ACCEPTED';
      }
    }

    this.sql.exec(
      `INSERT INTO observations(ts_ms, edge_seq, digest, received_digest, digest_match, bytes,
                                attempt, behaviour, outcome)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      Date.now(), edgeSeq === null ? null : Number(edgeSeq), digest, receivedDigest,
      digest === receivedDigest ? 1 : 0, bytes, attempt, behaviour, outcome);

    // Spent after one request, so a gate can script a single failure without redeploying.
    if (behaviour.endsWith('_once')) this.sql.exec("DELETE FROM script WHERE k='behaviour'");
    return { outcome, behaviour, attempt };
  }

  /** The gate evidence: every observation, in real order of receipt. */
  async report() {
    const rows = [...this.sql.exec('SELECT * FROM observations ORDER BY id ASC')];
    return {
      service: 'KAWA-STAGING-RECEIVER',
      behaviour: this._behaviour(),
      observations: rows,
      accepted_order: rows.filter(r => r.outcome === 'ACCEPTED').map(r => r.edge_seq),
      digest_mismatches: rows.filter(r => r.digest_match === 0).length,
    };
  }
}

function json(status, payload) {
  return new Response(JSON.stringify(payload, null, 2),
    { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

function timingSafeEqual(a, b) {
  const x = String(a ?? ''), y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

const ledgerOf = (env) => env.LEDGER.get(env.LEDGER.idFromName('staging-receiver-ledger'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/report')) {
      return json(200, await ledgerOf(env).report());
    }

    if (request.method === 'POST' && url.pathname === '/control') {
      const auth = request.headers.get('authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!env.CONTROL_TOKEN || !timingSafeEqual(env.CONTROL_TOKEN, token)) {
        return json(404, { ok: false, code: 'NOT_FOUND' });
      }
      let body = {};
      try { body = await request.json(); } catch { return json(400, { ok: false, code: 'BAD_JSON' }); }
      const out = await ledgerOf(env).setBehaviour(String(body.behaviour || ''));
      console.log(JSON.stringify({ event: 'STG_BEHAVIOUR_SET', behaviour: body.behaviour, ok: out.ok }));
      return json(out.ok ? 200 : 400, out);
    }

    if (request.method !== 'POST') return json(405, { ok: false, code: 'METHOD_NOT_ALLOWED' });

    const bytes = new Uint8Array(await request.arrayBuffer());
    const d = await crypto.subtle.digest('SHA-256', bytes);
    const receivedDigest = [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');

    const res = await ledgerOf(env).observe({
      edgeSeq: request.headers.get('x-edge-seq'),
      digest: request.headers.get('x-edge-digest'),
      receivedDigest, bytes: bytes.length,
    });

    console.log(JSON.stringify({ event: 'STG_RECEIVED', edge_seq: request.headers.get('x-edge-seq'),
                                 bytes: bytes.length, received_digest: receivedDigest,
                                 outcome: res.outcome, behaviour: res.behaviour, attempt: res.attempt }));

    if (res.outcome === 'SILENT') return new Promise(() => {});
    if (res.outcome === 'SLOW') await new Promise(r => setTimeout(r, 20000));
    if (res.outcome === 'FAIL_5XX') return json(503, { ok: false, code: 'UNAVAILABLE' });
    if (res.outcome === 'PERMANENT_4XX') return json(400, { ok: false, code: 'BAD_SIGNAL' });
    if (res.outcome === 'DUPLICATE') return json(200, { ok: true, code: 'DUPLICATE_REPLAY', duplicate: true });
    return json(202, { ok: true, code: 'QUEUED' });
  },
};
