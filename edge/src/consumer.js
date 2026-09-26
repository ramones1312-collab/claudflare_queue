/**
 * KAWA VECTOR · Edge Signal Buffer V1.3.0 — DELIVERY CONSUMER (per destination)
 *
 * One consumer deployment per destination queue. A courier with a turnstile, unchanged from V1.2.3
 * except that everything it touches is now scoped to ONE destination:
 *
 *   - the envelope carries `destination_id` (schema `kawa.edge.v3`); an envelope without one is a
 *     V1.2.3 message and means the only configured destination;
 *   - `DEST_<ID>_WEBHOOK_URL` is read one destination at a time. HUB_A's credential is never in
 *     scope while delivering to HUB_B;
 *   - a permanent 4xx dead-letters to `DEST_<ID>_DLQ` and halts THAT destination only;
 *   - `CONSUMER_DESTINATION_ID`, when set, pins this deployment: an envelope for another
 *     destination is refused instead of delivered with the wrong credential.
 *
 * ACK CONTRACT (unchanged)
 *   durable acceptance / recognised duplicate -> delivered(N, dest) -> ack -> release N+1 for dest
 *   timeout / 5xx / 429 / unrecognised 2xx    -> no advance, no ack, retry
 *   permanent 4xx                             -> DLQ.send -> HALTED_DLQ(dest) durable -> ack
 *
 * Duplicates are tolerable — each Hub deduplicates by the `signal_id` inside the body, which the
 * Edge never reads or rewrites. Reordering is not tolerable, for any destination.
 */
import { destinationById, enabledDestinations } from './destinations.js';

const DURABLE_ACCEPT = new Set(['QUEUED', 'ACCEPTED']);
const ALREADY_HELD = new Set(['DUPLICATE_REPLAY', 'DUPLICATE', 'ALREADY_ACCEPTED']);
/** 4xx that the HTTP contract itself marks as "try again", plus what a Hub can declare explicitly. */
const TRANSIENT_4XX = new Set([408, 423, 425]);
const RETRYABLE_CODES = new Set(['RETRY', 'TRY_AGAIN', 'TEMPORARILY_UNAVAILABLE', 'WARMING_UP']);

/**
 * ONE terminal name, end to end. `classify()` returns FAILED_PERMANENT; the consumer then writes the
 * failure record to that destination's dead-letter QUEUE (a Cloudflare resource, not a state) and
 * the sequencer stores the delivery as state `FAILED_PERMANENT`. There is no separate DEAD_LETTER
 * state anywhere: the key below is a deprecated alias of the SAME value, kept only so V1.2.3
 * callers and tests keep resolving.
 *
 *     classify() -> FAILED_PERMANENT
 *        -> DEST_<ID>_DLQ.send(record)        (transport: the failure is recorded off-stream)
 *        -> sequencer.haltedDlq(...)          (state: deliveries.state = FAILED_PERMANENT)
 *        -> halted_seq:<dest> + operator notification
 */
export const DISPOSITION = {
  DELIVERED: 'DELIVERED',
  DUPLICATE_ALREADY_HELD: 'DUPLICATE_ALREADY_HELD',
  RETRY: 'RETRY',
  FAILED_PERMANENT: 'FAILED_PERMANENT',
  /** @deprecated V1.2.3 spelling of FAILED_PERMANENT — same value, not a second state. */
  DEAD_LETTER: 'FAILED_PERMANENT',
};

function log(event, fields = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(fields)) {
    const key = String(k).toLowerCase();
    clean[k] = (key.includes('token') || key.includes('secret') || key.includes('url'))
      ? '[REDACTED]' : v;
  }
  console.log(JSON.stringify({ event, ...clean }));
}

export function sequencerStub(env) {
  // ONE global stream: a single name means a single instance, which is what makes the ordering
  // deterministic. Every destination reads its own head inside that one instance.
  const name = env.SEQUENCER_NAME || 'kawa-vector-global-stream';
  return env.SEQUENCER.get(env.SEQUENCER.idFromName(name));
}

/** Pure, so the ack contract is testable without a network. Unchanged from V1.2.3. */
export function classify(status, payload) {
  if (status === null || status === undefined) {
    return { disposition: DISPOSITION.RETRY, reason: 'NETWORK_OR_TIMEOUT' };
  }
  const code = String((payload && payload.code) || '').toUpperCase();
  if (status >= 200 && status < 300) {
    if (DURABLE_ACCEPT.has(code)) return { disposition: DISPOSITION.DELIVERED, reason: code };
    if (ALREADY_HELD.has(code) || (payload && payload.duplicate === true)) {
      return { disposition: DISPOSITION.DUPLICATE_ALREADY_HELD, reason: code || 'DUPLICATE' };
    }
    return { disposition: DISPOSITION.RETRY, reason: 'ACCEPTANCE_NOT_CONFIRMED' };
  }
  // V1.3.0 · 4xx policy (owner decision, supersedes V1.2.3's "auth is always retryable"):
  //   429 and explicitly transient 4xx  -> retry with backoff
  //   401 / 403                         -> FAILED_PERMANENT for THIS destination + operator alert
  //   every other 4xx                   -> FAILED_PERMANENT for THIS destination
  //   5xx / network / timeout           -> retry with backoff
  // An endless retry on a rejected credential is a silent failure: the alert never arrives and
  // nobody is told. Failing permanently stops that destination, raises the halt notification and
  // leaves every other Hub untouched.
  // F-01 · PRECEDENCIA (auditoría de V1.3.0): 401/403 son SIEMPRE permanentes y se evalúan ANTES
  // que cualquier pista de reintento, porque esa pista viene del mismo Hub que rechaza la
  // credencial: un `retryable:true` o un `code:"RETRY"` en esa respuesta no puede convertir una
  // credencial rechazada en un reintento eterno. El remedio es humano: corregir el secreto.
  if (status === 401 || status === 403) {
    return { disposition: DISPOSITION.FAILED_PERMANENT, reason: `AUTH_REJECTED_${status}`, auth: true };
  }
  if (status === 429) return { disposition: DISPOSITION.RETRY, reason: 'BACKPRESSURE' };
  if (TRANSIENT_4XX.has(status) || (payload && payload.retryable === true) || RETRYABLE_CODES.has(code)) {
    return { disposition: DISPOSITION.RETRY, reason: `TRANSIENT_${status}` };
  }
  if (status >= 400 && status < 500) return { disposition: DISPOSITION.FAILED_PERMANENT, reason: `PERMANENT_${status}` };
  return { disposition: DISPOSITION.RETRY, reason: `UPSTREAM_${status}` };
}

export function retryDelaySeconds(attempt, reason, policy = {}) {
  const base = (reason === 'BACKPRESSURE' || String(reason).startsWith('TRANSIENT_'))
    ? Number(policy.backpressure_delay_s || 30) : Number(policy.base_delay_s || 5);
  return Math.min(base * Math.pow(2, Math.max(0, attempt - 1)), Number(policy.max_delay_s || 900));
}

/**
 * Where one destination's delivery goes. A Service Binding, when present, hard-locks the target
 * (STAGING); otherwise the destination's own webhook URL is used. Nothing here is shared between
 * destinations: both the binding and the URL are looked up by that destination's own names.
 */
function fetcherFor(env, dest) {
  const svc = dest && env[dest.fetcher_binding];
  if (svc && typeof svc.fetch === 'function') return (url, init) => svc.fetch(url, init);
  return (url, init) => fetch(url, init);
}

function webhookUrlFor(env, dest) {
  return dest ? env[dest.url_binding] : undefined;
}

async function deliver(claim, env, dest) {
  let status = null, payload = null;
  const doFetch = fetcherFor(env, dest);
  const url = webhookUrlFor(env, dest);
  if (!url) {
    log('EDGE_DESTINATION_URL_MISSING', { destination_id: claim.destination_id });
    return { disposition: DISPOSITION.RETRY, reason: 'DESTINATION_URL_MISSING' };
  }
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': claim.content_type || 'text/plain',
        // Transport correlation only. KAWA ignores unknown headers; admission never depends on
        // them, and the trading identity (signal_id) stays inside the untouched body.
        'x-edge-seq': String(claim.edge_seq),
        'x-edge-digest': String(claim.digest || ''),
        'x-edge-destination': String(claim.destination_id || ''),
        'x-edge-delivery-id': String(claim.delivery_id || ''),
        'x-edge-attempt': String(claim.delivery_attempt || 1),
        'x-edge-first-received-ms': String(claim.first_received_ms || claim.edge_received_ms || ''),
      },
      // The authoritative bytes, read from the single stored copy. Byte for byte, per destination.
      body: claim.body,
      signal: AbortSignal.timeout(Number((dest && dest.timeout_ms) || env.DELIVERY_TIMEOUT_MS || 10000)),
    });
    status = res.status;
    try { payload = await res.json(); } catch { payload = null; }
  } catch (err) {
    log('EDGE_DELIVERY_ERROR', { edge_seq: claim.edge_seq, destination_id: claim.destination_id,
                                 error: String(err && err.name || err) });
  }
  return classify(status, payload);
}

export default {
  async queue(batch, env, ctx) {
    const seq = sequencerStub(env);
    const pinned = env.CONSUMER_DESTINATION_ID ? String(env.CONSUMER_DESTINATION_ID).toUpperCase() : null;
    const fallback = (enabledDestinations(env)[0] || {}).id;

    // §3 · strictly sequential within this destination's queue. Never Promise.all.
    for (const msg of batch.messages) {
      const edgeSeq = msg.body && msg.body.edge_seq;
      if (!edgeSeq) { msg.ack(); continue; }        // malformed envelope, nothing to deliver
      // A V1.2.3 envelope carries no destination: it belongs to the only configured destination.
      const destinationId = String((msg.body && msg.body.destination_id) || pinned || fallback || '').toUpperCase();

      if (pinned && destinationId !== pinned) {
        // Wrong queue for this deployment. Never deliver with another destination's credential.
        log('EDGE_DESTINATION_MISMATCH', { edge_seq: edgeSeq, expected: pinned, got: destinationId });
        msg.retry({ delaySeconds: 60 });
        continue;
      }
      const dest = destinationById(env, destinationId);
      if (!dest) {
        log('EDGE_DESTINATION_UNKNOWN', { edge_seq: edgeSeq, destination_id: destinationId });
        msg.retry({ delaySeconds: 60 });          // config may be fixed; never drop the delivery
        continue;
      }
      if (!dest.enabled) {
        // F-02 · DEFENSA SECUNDARIA. La autoridad sobre enabled/disabled vive en el Sequencer, que
        // resuelve estas entregas al despachar y en el torniquete; este Worker puede tener una copia
        // vieja de DESTINATIONS. Si aun así llega aquí, se resuelve de forma durable y auditada
        // antes de ackear: ackear una fila sin resolver congelaría la cabeza de ese destino.
        try {
          await seq.destinationDisabled(edgeSeq, dest.id);
          msg.ack();
        } catch (err) {
          log('EDGE_DISABLED_RESOLVE_FAILED', { edge_seq: edgeSeq, destination_id: dest.id,
                                                error: String(err && err.name || err) });
          msg.retry({ delaySeconds: 30 });
        }
        continue;
      }

      let claim;
      try {
        claim = await seq.claim(edgeSeq, dest.id);
      } catch (err) {
        log('EDGE_CLAIM_FAILED', { edge_seq: edgeSeq, destination_id: dest.id,
                                   error: String(err && err.name || err) });
        msg.retry({ delaySeconds: 5 });
        continue;
      }

      // ---- the turnstile -------------------------------------------------------------
      if (claim.status === 'WAIT' || claim.status === 'BUSY') { msg.retry({ delaySeconds: 2 }); continue; }
      if (claim.status === 'ALREADY_DELIVERED') { msg.ack(); continue; }
      if (claim.status === 'HALT') { msg.retry({ delaySeconds: 60 }); continue; }
      if (claim.status === 'UNKNOWN') { msg.ack(); continue; }
      if (claim.status !== 'GO') { msg.retry({ delaySeconds: 5 }); continue; }

      // ---- deliver -------------------------------------------------------------------
      const outcome = await deliver(claim, env, dest);
      log('EDGE_DELIVERY_ATTEMPT', { edge_seq: claim.edge_seq, destination_id: dest.id,
                                     delivery_id: claim.delivery_id, attempt: claim.delivery_attempt,
                                     disposition: outcome.disposition, reason: outcome.reason });

      if (outcome.disposition === DISPOSITION.DELIVERED ||
          outcome.disposition === DISPOSITION.DUPLICATE_ALREADY_HELD) {
        await seq.delivered(claim.edge_seq, dest.id, claim.lease_token);
        msg.ack();
        continue;
      }

      if (outcome.disposition === DISPOSITION.FAILED_PERMANENT) {
        // DLQ of THIS destination confirmed -> HALTED_DLQ(dest) durable -> only then ack.
        const dlq = env[dest.dlq_binding] || (dest.legacy ? env.DLQ : null);
        if (!dlq) { msg.retry({ delaySeconds: 30 }); continue; }
        try {
          await dlq.send({ edge_seq: claim.edge_seq, destination_id: dest.id,
                           delivery_id: claim.delivery_id, digest: claim.digest,
                           reason: outcome.reason, ts_ms: Date.now() });
        } catch (err) {
          log('EDGE_DLQ_WRITE_FAILED', { edge_seq: claim.edge_seq, destination_id: dest.id,
                                         error: String(err && err.name || err) });
          msg.retry({ delaySeconds: 30 });
          continue;
        }
        await seq.haltedDlq(claim.edge_seq, dest.id, outcome.reason, { http: outcome.reason });
        msg.ack();
        continue;
      }

      // Transient: no advance, no ack. This sequence keeps its place in THIS destination's line.
      msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts || 1, outcome.reason, dest.retry) });
    }
  },
};
