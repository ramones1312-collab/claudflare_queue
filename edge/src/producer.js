/**
 * KAWA VECTOR · Edge Signal Buffer V1.2 — INGRESS WORKER
 *
 * Validates the request shape and hands the raw bytes to the sequencer. It persists nothing itself:
 * the acceptance boundary is the Durable Object's SQLite transaction.
 *
 *     DO transaction commits  ->  and only then 202 to TradingView
 *
 * `queue.send()` is NOT part of that criterion. If the queue is down after N was persisted, N still
 * exists in the outbox and will be retried. Answering 2xx before the commit would turn an edge
 * failure into a silently lost alert, which is the whole point of this buffer.
 */
const MAX_BODY_BYTES = 16 * 1024;
const MIN_BODY_BYTES = 8;

export function timingSafeEqual(a, b) {
  const x = String(a ?? ''), y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export function safeLog(event, fields = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(fields)) {
    const key = String(k).toLowerCase();
    clean[k] = (key.includes('token') || key.includes('secret') || key.includes('url') ||
                key === 'path' || key === 'authorization' || key === 'cookie')
      ? '[REDACTED]' : v;
  }
  console.log(JSON.stringify({ event, ...clean }));
}

/** The single global stream. One name, one instance, deterministic serialisation. */
export function sequencerStub(env) {
  // ONE global stream in production: a single name means a single instance, which is what makes the
  // ordering deterministic. The name is overridable so tests can give each scenario its own stream
  // instead of sharing one -- this pool cannot isolate SQLite-backed Durable Objects per test.
  const name = env.SEQUENCER_NAME || 'kawa-vector-global-stream';
  return env.SEQUENCER.get(env.SEQUENCER.idFromName(name));
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== 'POST') {
      safeLog('EDGE_REJECT', { reason: 'METHOD_NOT_ALLOWED', method: request.method });
      return json(405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
    }
    const expected = `/webhook/${env.WEBHOOK_PATH_TOKEN}`;
    if (!env.WEBHOOK_PATH_TOKEN || !timingSafeEqual(url.pathname, expected)) {
      // An unset secret must not be distinguishable from a wrong one.
      safeLog('EDGE_REJECT', { reason: 'PATH_NOT_FOUND' });
      return json(404, { ok: false, code: 'NOT_FOUND' });
    }

    // Raw bytes. Never decoded, never re-encoded: byte-for-byte all the way to KAWA.
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > MAX_BODY_BYTES) {
      safeLog('EDGE_REJECT', { reason: 'BODY_TOO_LARGE', bytes: bytes.length });
      return json(413, { ok: false, code: 'BODY_TOO_LARGE' });
    }
    if (bytes.length < MIN_BODY_BYTES) {
      safeLog('EDGE_REJECT', { reason: 'BODY_TOO_SMALL', bytes: bytes.length });
      return json(400, { ok: false, code: 'BODY_TOO_SMALL' });
    }

    try {
      const out = await sequencerStub(env).accept(
        bytes, request.headers.get('content-type') || 'text/plain');
      // Durable acceptance is proven. Only now.
      return json(202, { ok: true, code: 'BUFFERED', edge_seq: out.edge_seq, digest: out.digest,
                         // V1.3.0 · which destinations owe a delivery for this alert. Transport
                         // metadata only: the body TradingView sent is never altered.
                         destinations: out.destinations || undefined });
    } catch (err) {
      // Fail closed: no 2xx without a committed sequence.
      safeLog('EDGE_ACCEPT_FAILED', { bytes: bytes.length, error: String(err && err.name || err) });
      return json(503, { ok: false, code: 'BUFFER_UNAVAILABLE' });
    }
  },
};
