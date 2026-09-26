/**
 * KAWA VECTOR · Edge Signal Buffer V1.3.0 — DESTINATION REGISTRY
 *
 * One alert, N independent deliveries. This module is the only place that knows which destinations
 * exist; nothing downstream hardcodes HUB_A or HUB_B.
 *
 * CONFIGURATION (non-secret) lives in the `DESTINATIONS` var as JSON:
 *
 *     [{"id":"HUB_A","enabled":true,"timeout_ms":10000},
 *      {"id":"HUB_B","enabled":true,"timeout_ms":10000}]
 *
 * SECRETS are never part of that JSON. Each destination reads its own, by convention:
 *
 *     DEST_<ID>_WEBHOOK_URL   secret · the Hub's webhook, path token included
 *     DEST_<ID>_QUEUE         queue producer binding · one queue PER destination
 *     DEST_<ID>_DLQ           queue producer binding · that destination's dead-letter queue
 *     DEST_<ID>_FETCHER       service binding · STAGING hard-lock (optional)
 *     DEST_<ID>_TIMEOUT_MS    var · overrides timeout_ms
 *
 * A secret of HUB_A is therefore structurally unreachable from HUB_B: different binding names, read
 * one at a time, never merged into a shared object.
 *
 * BACKWARD COMPATIBILITY (V1.2.3): with no `DESTINATIONS` var the registry yields exactly one
 * destination, `LEGACY_DESTINATION_ID` (default `HUB_A`), wired to the V1.2.3 bindings
 * (KAWA_WEBHOOK_URL / SIGNAL_QUEUE / DLQ / KAWA_FETCHER). One destination configured = V1.2.3.
 */

export const LEGACY_ID = 'HUB_A';
const ID_RE = /^[A-Z][A-Z0-9_]{0,31}$/;

/**
 * F-03 · Operational ranges. A value outside them is a configuration error, and a configuration
 * error must fail CLOSED at load/acceptance time — never become an endless retry or a delivery
 * attempt that effectively has no timeout.
 */
export const LIMITS = {
  timeout_ms: { min: 250, max: 120000 },
  base_delay_s: { min: 1, max: 3600 },
  backpressure_delay_s: { min: 1, max: 3600 },
  max_delay_s: { min: 1, max: 86400 },
};

/** Presente = definido. `0`, `null`, `false` y `""` SON valores presentes, y se validan como tales. */
function present(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
}

function num(value, field, id, range) {
  // F-05 · un valor presente pero de tipo imposible (null, false, cadena vacía) es inválido, no un
  // motivo para caer al default: `||` hacía que `timeout_ms: 0` se convirtiera en 10000 en silencio.
  if (value === null || typeof value === 'boolean' ||
      (typeof value === 'string' && value.trim() === '') ||
      (typeof value !== 'number' && typeof value !== 'string')) {
    throw new DestinationConfigError(`DESTINATION_${field}_NOT_FINITE`, { id, value: String(value) });
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new DestinationConfigError(`DESTINATION_${field}_NOT_FINITE`, { id, value });
  if (n < 0) throw new DestinationConfigError(`DESTINATION_${field}_NEGATIVE`, { id, value: n });
  if (n < range.min || n > range.max) {
    throw new DestinationConfigError(`DESTINATION_${field}_OUT_OF_RANGE`, { id, value: n, ...range });
  }
  return n;
}

/** El primero que esté PRESENTE decide; solo si ninguno lo está se usa el default. */
function timeoutFor(env, d, id) {
  for (const [obj, key] of [[env, `DEST_${id}_TIMEOUT_MS`], [d, 'timeout_ms'], [env, 'DELIVERY_TIMEOUT_MS']]) {
    if (present(obj, key)) return num(obj[key], 'TIMEOUT_MS', id, LIMITS.timeout_ms);
  }
  return 10000;
}

function field(r, key, def, name, id, range) {
  return present(r, key) ? num(r[key], name, id, range) : def;
}

function retryPolicy(retry, id) {
  const r = retry || {};
  const policy = {
    base_delay_s: field(r, 'base_delay_s', 5, 'BASE_DELAY_S', id, LIMITS.base_delay_s),
    backpressure_delay_s: field(r, 'backpressure_delay_s', 30, 'BACKPRESSURE_DELAY_S', id, LIMITS.backpressure_delay_s),
    max_delay_s: field(r, 'max_delay_s', 900, 'MAX_DELAY_S', id, LIMITS.max_delay_s),
  };
  // A ceiling below the floor would silently shorten every backoff to the ceiling.
  if (policy.max_delay_s < policy.base_delay_s || policy.max_delay_s < policy.backpressure_delay_s) {
    throw new DestinationConfigError('DESTINATION_MAX_DELAY_BELOW_BASE', { id, ...policy });
  }
  return policy;
}

export class DestinationConfigError extends Error {
  constructor(code, detail) { super(code); this.name = 'DestinationConfigError'; this.code = code; this.detail = detail; }
}

function legacyDestination(env) {
  return {
    id: String(env.LEGACY_DESTINATION_ID || LEGACY_ID),
    enabled: true,
    legacy: true,
    timeout_ms: present(env, 'DELIVERY_TIMEOUT_MS')
      ? num(env.DELIVERY_TIMEOUT_MS, 'TIMEOUT_MS', LEGACY_ID, LIMITS.timeout_ms) : 10000,
    queue_binding: 'SIGNAL_QUEUE',
    dlq_binding: 'DLQ',
    url_binding: 'KAWA_WEBHOOK_URL',
    fetcher_binding: 'KAWA_FETCHER',
  };
}

function parseConfigured(raw, env) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    throw new DestinationConfigError('DESTINATIONS_NOT_JSON');
  }
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.destinations) ? parsed.destinations : null);
  if (!list || list.length === 0) throw new DestinationConfigError('DESTINATIONS_EMPTY');
  const seen = new Set();
  return list.map((d) => {
    const id = String((d && d.id) || '').toUpperCase();
    if (!ID_RE.test(id)) throw new DestinationConfigError('DESTINATION_ID_INVALID', id);
    if (seen.has(id)) throw new DestinationConfigError('DESTINATION_ID_DUPLICATE', id);
    seen.add(id);
    // F-03B · `enabled`, si viene, es booleano ESTRICTO. Antes `"false"`, `0` y `null` quedaban
    // habilitados por coerción: un destino que el operador cree apagado seguiría recibiendo.
    if (d && Object.prototype.hasOwnProperty.call(d, 'enabled') && typeof d.enabled !== 'boolean') {
      throw new DestinationConfigError('DESTINATION_ENABLED_NOT_BOOLEAN',
                                       { id, type: d.enabled === null ? 'null' : typeof d.enabled });
    }
    return {
      id,
      // A destination is delivered to only when explicitly enabled. Ausente = habilitado.
      enabled: d.enabled !== false,
      legacy: false,
      timeout_ms: timeoutFor(env, d, id),
      queue_binding: `DEST_${id}_QUEUE`,
      dlq_binding: `DEST_${id}_DLQ`,
      url_binding: `DEST_${id}_WEBHOOK_URL`,
      fetcher_binding: `DEST_${id}_FETCHER`,
      // Per-destination retry policy; falls back to the V1.2.3 numbers.
      retry: retryPolicy(d.retry, id),
    };
  });
}

/** Every configured destination, enabled or not. Throws on a malformed config: fail closed. */
export function allDestinations(env) {
  // F-04 · el camino legacy de un solo destino existe SOLO si la variable está realmente AUSENTE.
  // Presente pero vacía ("", espacios, null) es configuración inválida, no "vuelve a V1.2.3": un
  // operador que borró el valor por error no debe acabar entregando a un destino implícito.
  const present = !!env && Object.prototype.hasOwnProperty.call(env, 'DESTINATIONS')
                  && env.DESTINATIONS !== undefined;
  if (!present) return [legacyDestination(env)];
  const raw = env.DESTINATIONS;
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    throw new DestinationConfigError('DESTINATIONS_PRESENT_BUT_EMPTY');
  }
  return parseConfigured(raw, env);
}

/** The destinations that receive a fan-out. */
export function enabledDestinations(env) {
  return allDestinations(env).filter(d => d.enabled);
}

export function destinationById(env, id) {
  const wanted = String(id || '').toUpperCase();
  return allDestinations(env).find(d => d.id === wanted) || null;
}

/**
 * Transport identity of one delivery. Deterministic, so a redelivery of the same (sequence,
 * destination) always carries the same id.
 *
 * The Edge never parses the body, so it cannot compose `signal_id + destination_id`: KAWA's
 * `signal_id` travels untouched INSIDE the payload and each Hub keeps its own deduplication by it.
 * `delivery_id` is transport metadata and never substitutes it.
 */
export function deliveryId(edgeSeq, destinationId) {
  return `E${Number(edgeSeq)}:${String(destinationId).toUpperCase()}`;
}
