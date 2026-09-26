/**
 * KAWA VECTOR · Edge Signal Buffer V1.3.0 — SEQUENCER DURABLE OBJECT (SQLite)
 *
 * MULTI-DESTINATION DURABLE FAN-OUT. V1.3.0 <- V1.2.3 STAGING FROZEN.
 *
 * What changed, and nothing else did:
 *
 *   V1.2.3   one signal  ->  one delivery state  ->  one KAWA Hub
 *   V1.3.0   one signal  ->  N delivery states   ->  N KAWA Hubs, fully isolated
 *
 * THE INVARIANT IS UNCHANGED, NOW PER DESTINATION
 *     "I received A before B, so EVERY destination receives A before B."
 *   Each destination keeps its OWN head (`next_seq_expected:<dest>`), its own halt marker, its own
 *   single-flight lease, its own queue and its own attempt counters. HUB_A may run ahead of HUB_B;
 *   neither can ever see B before A. A destination that is down, halted or unauthenticated cannot
 *   block, delay or duplicate another one.
 *
 * STORAGE (schema 2)
 *   signals      one row per accepted alert: the body lives here ONCE, as an opaque BLOB
 *   deliveries   one row per (edge_seq, destination_id): state, attempts, lease, last error
 *
 * The acceptance boundary is unchanged: ONE SQLite transaction assigns the sequence, persists the
 * bytes and creates the delivery rows of every enabled destination. Only then may the ingress
 * answer TradingView 2xx. `queue.send()` is still NOT part of that criterion.
 *
 * The Edge learns nothing about the strategy: no LONG/SHORT, no ENTRY/EXIT, no sizing, no TTL, no
 * lifecycle. It never parses the body, and it never propagates any trading state between Hubs.
 */
import { DurableObject } from 'cloudflare:workers';
import { allDestinations, enabledDestinations, destinationById, deliveryId, LEGACY_ID } from './destinations.js';

export const STATE = {
  PENDING_DISPATCH: 'PENDING_DISPATCH',
  DISPATCHED: 'DISPATCHED',
  DELIVERED: 'DELIVERED',
  // V1.3.0 · terminal failure of ONE destination: it stops there, the operator is notified, and no
  // other destination is affected. HALTED_DLQ is the V1.2.3 spelling, kept so migrated rows and
  // their audit trail still read correctly; new rows are written as FAILED_PERMANENT.
  FAILED_PERMANENT: 'FAILED_PERMANENT',
  HALTED_DLQ: 'HALTED_DLQ',
  ADMIN_SKIPPED: 'ADMIN_SKIPPED',
  // F-02 · the destination was disabled while this delivery was still owed. Resolved durably and
  // audited, never acked into limbo: an unresolved row would freeze that destination's head and
  // pin the outbox for as long as the destination stayed off.
  DISABLED_SKIPPED: 'DISABLED_SKIPPED',
};

/** Nothing more is owed for these: delivered, skipped by a human, or permanently failed. */
export const RESOLVED = ['DELIVERED', 'ADMIN_SKIPPED', 'FAILED_PERMANENT', 'HALTED_DLQ', 'DISABLED_SKIPPED'];

/**
 * Resolved is NOT the same as advanceable. A delivery that FAILED_PERMANENT is resolved for
 * retention (§GC) but it still HOLDS that destination's line until a human decides retry or skip:
 * letting the head walk over it would deliver the rest of a broken causal chain.
 */
const ADVANCEABLE = [STATE.DELIVERED, STATE.ADMIN_SKIPPED, STATE.DISABLED_SKIPPED];

/** States that still owe a destination a delivery. Rows in these states are never collected. */
const UNRESOLVED = [STATE.PENDING_DISPATCH, STATE.DISPATCHED];
const UNRESOLVED_SQL = `'${UNRESOLVED.join("','")}'`;
const SCHEMA_VERSION = 2;

const DEFAULTS = {
  REDISPATCH_LEASE_MS: 5 * 60 * 1000,
  DELIVERY_LEASE_MS: 60 * 1000,
  DISPATCH_BACKOFF_MS: [10e3, 30e3, 60e3, 300e3, 900e3, 1800e3],
  GC_LAG: 1000,
};

function backoff(attempts) {
  const t = DEFAULTS.DISPATCH_BACKOFF_MS;
  return t[Math.min(Math.max(attempts, 1) - 1, t.length - 1)];
}

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function log(event, fields = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(fields)) {
    const key = k.toLowerCase();
    clean[k] = (key.includes('token') || key.includes('secret') || key.includes('url'))
      ? '[REDACTED]' : v;
  }
  console.log(JSON.stringify({ event, ...clean }));
}

export class EdgeSequencer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS signals(
          edge_seq          INTEGER PRIMARY KEY,
          body              BLOB    NOT NULL,
          digest            TEXT    NOT NULL,
          content_type      TEXT    NOT NULL,
          edge_received_ms  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS deliveries(
          edge_seq          INTEGER NOT NULL,
          destination_id    TEXT    NOT NULL,
          delivery_id       TEXT    NOT NULL,
          state             TEXT    NOT NULL,
          dispatch_attempts INTEGER NOT NULL DEFAULT 0,
          last_dispatch_ms  INTEGER,
          next_dispatch_ms  INTEGER,
          delivery_attempt  INTEGER NOT NULL DEFAULT 0,
          lease_token       TEXT,
          lease_until       INTEGER,
          halt_reason       TEXT,
          last_error        TEXT,
          first_received_ms INTEGER NOT NULL,
          last_attempt_ms   INTEGER,
          resolved_ms       INTEGER,
          PRIMARY KEY(edge_seq, destination_id)
        );
        CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS admin_log(
          id INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL, edge_seq INTEGER NOT NULL,
          action TEXT NOT NULL, actor TEXT, reason TEXT, previous_state TEXT, digest TEXT,
          destination_id TEXT
        );
        CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(state, next_dispatch_ms);
        CREATE INDEX IF NOT EXISTS deliveries_dest ON deliveries(destination_id, state);
      `);
      if (this._meta('counter') === null) this._setMeta('counter', '0');
      this._migrateFromV1();
      this._setMeta('schema_version', SCHEMA_VERSION);
      await this._ensureAlarm();
    });
  }

  /**
   * The environment the destination registry is read from. Production returns `this.env` untouched;
   * the TEST-ONLY subclass overlays a per-scenario config here, because a Durable Object owns its
   * own env and the test pool cannot give each scenario different bindings.
   */
  _cfg() { return this._envOverride ? { ...this.env, ...this._envOverride } : this.env; }

  // ---- migration ---------------------------------------------------------------------
  /**
   * V1.2.3 -> V1.3.0, in place and once. Every outbox row becomes a signal plus ONE delivery row
   * for the legacy destination, carrying its exact state, attempts, lease and halt reason. The old
   * `outbox` table is left untouched as migration evidence; nothing writes to it again.
   *
   * Signals accepted BEFORE a new destination existed are NOT backfilled to it: a destination added
   * today starts at the current head. Backfilling would replay history into a Hub that never saw
   * it, which is a trading decision the Edge must not take.
   */
  _migrateFromV1() {
    if (Number(this._meta('schema_version') || 0) >= SCHEMA_VERSION) return;
    const hasOutbox = [...this.sql.exec(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='outbox'")][0].n > 0;
    const legacy = String(this._cfg().LEGACY_DESTINATION_ID || LEGACY_ID);
    if (hasOutbox) {
      const rows = [...this.sql.exec('SELECT * FROM outbox ORDER BY edge_seq ASC')];
      for (const r of rows) {
        this.sql.exec(
          `INSERT OR IGNORE INTO signals(edge_seq, body, digest, content_type, edge_received_ms)
           VALUES(?,?,?,?,?)`, r.edge_seq, r.body, r.digest, r.content_type, r.edge_received_ms);
        this.sql.exec(
          `INSERT OR IGNORE INTO deliveries(edge_seq, destination_id, delivery_id, state,
             dispatch_attempts, last_dispatch_ms, next_dispatch_ms, delivery_attempt, lease_token,
             lease_until, halt_reason, first_received_ms, resolved_ms)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          r.edge_seq, legacy, deliveryId(r.edge_seq, legacy), r.state, r.dispatch_attempts,
          r.last_dispatch_ms, r.next_dispatch_ms, r.delivery_attempt, r.lease_token, r.lease_until,
          r.halt_reason, r.edge_received_ms, r.resolved_ms);
      }
      if (rows.length) log('EDGE_MIGRATED_V13', { rows: rows.length, destination_id: legacy });
      // F-05 · alcance exacto de lo migrado: qué filas de `outbox` tienen un espejo en `deliveries`.
      this._setMeta('migrated_max_seq', rows.length ? rows[rows.length - 1].edge_seq : 0);
    }
    // Global heads become that destination's heads.
    this._setMeta('legacy_destination', legacy);
    if (this._meta('migrated_max_seq') === null) this._setMeta('migrated_max_seq', 0);
    const head = this._meta('next_seq_expected');
    this._setMeta(this._headKey(legacy), head === null ? '1' : head);
    const halted = this._meta('halted_seq');
    if (halted !== null) this._setMeta(this._haltKey(legacy), halted);
  }

  // ---- small helpers -----------------------------------------------------------------
  _meta(k) {
    const r = [...this.sql.exec('SELECT v FROM meta WHERE k=?', k)];
    return r.length ? r[0].v : null;
  }
  _setMeta(k, v) { this.sql.exec('INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)', k, String(v)); }
  _headKey(dest) { return `next_seq_expected:${dest}`; }
  _haltKey(dest) { return `halted_seq:${dest}`; }

  _head(dest) {
    const v = this._meta(this._headKey(dest));
    if (v !== null) return Number(v);
    // A destination added later starts at the current head of the stream, never at 1: it is not
    // owed the history it never had.
    const start = Number(this._meta('counter')) + 1;
    this._setMeta(this._headKey(dest), start);
    return start;
  }

  /**
   * RULE · an implicit destination exists ONLY for the legacy single-destination configuration.
   * With more than one destination configured, every internal path must name its destination: an
   * ambiguous route could deliver one Hub's alert against another Hub's head, lease or credential.
   */
  _defaultDestination() {
    const all = allDestinations(this._cfg());
    if (all.length > 1) throw new Error('DESTINATION_ID_REQUIRED');
    return (all[0] || { id: String(this._cfg().LEGACY_DESTINATION_ID || LEGACY_ID) }).id;
  }
  _destId(id) { return id === undefined || id === null || id === '' ? this._defaultDestination() : String(id).toUpperCase(); }

  _delivery(seq, dest) {
    const r = [...this.sql.exec('SELECT * FROM deliveries WHERE edge_seq=? AND destination_id=?', seq, dest)];
    return r.length ? r[0] : null;
  }
  _signal(seq) {
    const r = [...this.sql.exec('SELECT * FROM signals WHERE edge_seq=?', seq)];
    return r.length ? r[0] : null;
  }
  _unresolvedCount(dest = null) {
    const sql = dest
      ? `SELECT COUNT(*) AS n FROM deliveries WHERE state IN (${UNRESOLVED_SQL}) AND destination_id=?`
      : `SELECT COUNT(*) AS n FROM deliveries WHERE state IN (${UNRESOLVED_SQL})`;
    return dest ? [...this.sql.exec(sql, dest)][0].n : [...this.sql.exec(sql)][0].n;
  }

  async _ensureAlarm(now = Date.now()) {
    if (this._unresolvedCount() === 0) return;
    const due = [...this.sql.exec(
      `SELECT MIN(COALESCE(next_dispatch_ms, 0)) AS d FROM deliveries
        WHERE state IN (${UNRESOLVED_SQL})`)][0].d ?? now;
    const current = await this.ctx.storage.getAlarm();
    const target = Math.max(due, now + 1000);
    if (current === null || current > target) await this.ctx.storage.setAlarm(target);
  }

  // ---- ACCEPTANCE BOUNDARY -----------------------------------------------------------
  /**
   * ONE transaction: assign the sequence, persist the exact bytes ONCE, create one delivery row per
   * ENABLED destination, advance the counter. When this resolves the alert exists forever, for
   * every destination — that is what lets the ingress answer 2xx.
   *
   * A disabled destination gets no row: it receives nothing and interferes with nothing.
   */
  async accept(bodyBytes, contentType) {
    const bytes = bodyBytes instanceof ArrayBuffer ? new Uint8Array(bodyBytes) : new Uint8Array(bodyBytes);
    const digest = await sha256Hex(bytes);
    const now = Date.now();
    // Fail closed: a malformed destination config must not accept an alert it cannot fan out.
    const dests = enabledDestinations(this._cfg());
    if (dests.length === 0) throw new Error('NO_ENABLED_DESTINATIONS');
    let seq;
    this.ctx.storage.transactionSync(() => {
      seq = Number(this._meta('counter')) + 1;
      this.sql.exec(
        `INSERT INTO signals(edge_seq, body, digest, content_type, edge_received_ms)
         VALUES(?,?,?,?,?)`, seq, bytes, digest, contentType || 'text/plain', now);
      for (const d of dests) {
        this.sql.exec(
          `INSERT INTO deliveries(edge_seq, destination_id, delivery_id, state, dispatch_attempts,
             next_dispatch_ms, first_received_ms) VALUES(?,?,?,?,0,?,?)`,
          seq, d.id, deliveryId(seq, d.id), STATE.PENDING_DISPATCH, now, now);
        // RULE · a destination added later receives NO history: its head is born with the first
        // delivery it is owed -- never at 1 (it is not owed what it never saw) and never ahead of
        // that sequence (which would strand this very alert).
        if (this._meta(this._headKey(d.id)) === null) this._setMeta(this._headKey(d.id), seq);
      }
      this._setMeta('counter', seq);
    });
    log('EDGE_ACCEPTED', { edge_seq: seq, bytes: bytes.length, digest,
                           destinations: dests.map(d => d.id) });
    this.ctx.waitUntil(this._dispatchDue());
    return { edge_seq: seq, digest, destinations: dests.map(d => d.id) };
  }

  // ---- TRANSPORT ---------------------------------------------------------------------
  /**
   * Publish one delivery on ITS OWN queue. A destination whose queue binding is missing or failing
   * backs off alone: the row stays unresolved, no gap is created and no other destination is
   * touched.
   */
  async _publish(row, now = Date.now()) {
    const attempts = row.dispatch_attempts + 1;
    try {
      // F-03 · la lectura de la configuración va DENTRO del try: una config inválida debe degradar
      // en backoff de esa fila, nunca en una excepción no capturada en el despacho de fondo.
      const dest = destinationById(this._cfg(), row.destination_id);
      const queue = dest && this._cfg()[dest.queue_binding];
      if (!queue || typeof queue.send !== 'function') throw new Error('QUEUE_BINDING_MISSING');
      await queue.send({ schema: 'kawa.edge.v3', edge_seq: row.edge_seq,
                         destination_id: row.destination_id, delivery_id: row.delivery_id,
                         digest: row.digest });
      this.sql.exec(
        `UPDATE deliveries SET state=?, dispatch_attempts=?, last_dispatch_ms=?, next_dispatch_ms=?
          WHERE edge_seq=? AND destination_id=?`,
        STATE.DISPATCHED, attempts, now, now + DEFAULTS.REDISPATCH_LEASE_MS, row.edge_seq,
        row.destination_id);
      log('EDGE_DISPATCHED', { edge_seq: row.edge_seq, destination_id: row.destination_id,
                               attempt: attempts });
      return true;
    } catch (err) {
      this.sql.exec(
        `UPDATE deliveries SET dispatch_attempts=?, last_dispatch_ms=?, next_dispatch_ms=?,
                               last_error=? WHERE edge_seq=? AND destination_id=?`,
        attempts, now, now + backoff(attempts), String(err && err.name || err), row.edge_seq,
        row.destination_id);
      log('EDGE_DISPATCH_FAILED', { edge_seq: row.edge_seq, destination_id: row.destination_id,
                                    attempt: attempts, error: String(err && err.name || err) });
      return false;
    }
  }

  /**
   * F-02 (reauditoría) · EL DO ES LA AUTORIDAD sobre enabled/disabled. Un destino deshabilitado
   * resuelve aquí sus entregas pendientes (`DISABLED_SKIPPED`) y **no se publica nada** a su cola.
   * No depende de que su consumer esté desplegado, actualizado, ni siquiera disponible: si la copia
   * de `DESTINATIONS` del consumer estuviera obsoleta, la entrega ya no existe que entregar.
   */
  _isDisabled(destinationId) {
    try {
      const d = destinationById(this._cfg(), destinationId);
      return !!d && !d.enabled;          // desconocido != deshabilitado: eso se trata como config rota
    } catch {
      return false;                      // config ilegible: no se resuelve nada por silencio
    }
  }

  /** Everything due, across destinations, oldest first within each destination. */
  async _dispatchDue(now = Date.now(), limit = 20) {
    const due = [...this.sql.exec(
      `SELECT d.*, s.digest AS digest FROM deliveries d JOIN signals s USING(edge_seq)
        WHERE d.state IN (${UNRESOLVED_SQL}) AND COALESCE(d.next_dispatch_ms,0) <= ?
        ORDER BY d.destination_id ASC, d.edge_seq ASC LIMIT ?`, now, limit)];
    for (const row of due) {
      if (this._isDisabled(row.destination_id)) {
        await this.destinationDisabled(row.edge_seq, row.destination_id, 'DESTINATION_DISABLED_AT_DISPATCH');
        continue;                        // nunca se publica a la cola de un destino deshabilitado
      }
      await this._publish(row, now);
    }
    this._gc();                          // F-02B · la retención no espera a que alguien entregue
    await this._ensureAlarm(now);
    return due.length;
  }

  async alarm() {
    try {
      await this._dispatchDue();
    } catch (err) {
      log('EDGE_ALARM_ERROR', { error: String(err && err.name || err) });
    } finally {
      const now = Date.now();
      if (this._unresolvedCount() > 0) {
        const current = await this.ctx.storage.getAlarm();
        if (current === null) await this.ctx.storage.setAlarm(now + 30000);
      }
    }
  }

  // ---- RELEASE GATE (per destination) ------------------------------------------------
  /**
   * Only `next_seq_expected:<dest>` may pass, and only one attempt at a time holds that
   * destination's single-flight lease. `destinationId` is optional: omitted, it means the only
   * configured destination, which is what keeps the V1.2.3 call shape working.
   */
  async claim(edgeSeq, destinationId) {
    const seq = Number(edgeSeq);
    const dest = this._destId(destinationId);
    const now = Date.now();
    const row = this._delivery(seq, dest);
    if (!row) return { status: 'UNKNOWN' };
    if (row.state === STATE.DELIVERED) return { status: 'ALREADY_DELIVERED' };
    if (row.state === STATE.ADMIN_SKIPPED) return { status: 'ALREADY_DELIVERED', skipped: true };
    if (row.state === STATE.DISABLED_SKIPPED) return { status: 'ALREADY_DELIVERED', disabled: true };
    if (row.state === STATE.FAILED_PERMANENT || row.state === STATE.HALTED_DLQ) {
      return { status: 'HALT', reason: row.halt_reason, failed_permanent: true };
    }

    // A halt belongs to ONE destination. HUB_B halted never stops HUB_A.
    const halted = this._meta(this._haltKey(dest));
    if (halted !== null && Number(halted) < seq) {
      return { status: 'HALT', reason: 'STREAM_HALTED_AT_' + halted, destination_id: dest };
    }
    // F-02 · reconciliar antes de comparar: si el destino estuvo deshabilitado, su cabeza puede
    // apuntar a secuencias para las que nunca hubo fila. Sin esto, la primera señal posterior a
    // rehabilitarlo esperaría para siempre.
    this._advance(dest);
    const expected = this._head(dest);
    if (seq !== expected) return { status: 'WAIT', next_seq_expected: expected, destination_id: dest };
    if (row.lease_until && row.lease_until > now) {
      return { status: 'BUSY', retry_after_ms: row.lease_until - now };
    }
    // F-02 (reauditoría) · un sobre ya en vuelo, reclamado por un consumer cuya copia de
    // DESTINATIONS sigue diciendo enabled:true, tampoco pasa: la autoridad es esta, no la suya.
    if (this._isDisabled(dest)) {
      await this.destinationDisabled(seq, dest, 'DESTINATION_DISABLED_AT_CLAIM');
      return { status: 'ALREADY_DELIVERED', disabled: true, destination_id: dest };
    }
    const signal = this._signal(seq);
    if (!signal) return { status: 'UNKNOWN' };

    const token = crypto.randomUUID();
    this.sql.exec(
      `UPDATE deliveries SET lease_token=?, lease_until=?, delivery_attempt=delivery_attempt+1,
                             last_attempt_ms=? WHERE edge_seq=? AND destination_id=?`,
      token, now + DEFAULTS.DELIVERY_LEASE_MS, now, seq, dest);
    return {
      status: 'GO', edge_seq: seq, destination_id: dest, delivery_id: row.delivery_id,
      lease_token: token, digest: signal.digest, content_type: signal.content_type,
      edge_received_ms: signal.edge_received_ms, first_received_ms: row.first_received_ms,
      last_attempt_ms: now,
      // The authoritative bytes, straight from the single stored copy.
      body: signal.body,
      delivery_attempt: row.delivery_attempt + 1,
    };
  }

  /** Idempotent, per destination. Advances only that destination's head. */
  async delivered(edgeSeq, destinationId, leaseToken) {
    const seq = Number(edgeSeq);
    // V1.2.3 shape: delivered(seq, leaseToken).
    if (leaseToken === undefined && destinationId && String(destinationId).includes('-')) {
      leaseToken = destinationId; destinationId = undefined;
    }
    const dest = this._destId(destinationId);
    const row = this._delivery(seq, dest);
    if (!row) return { ok: false, code: 'UNKNOWN_SEQ' };
    if (row.state === STATE.DELIVERED) return { ok: true, idempotent: true };
    if (row.lease_token && leaseToken && row.lease_token !== leaseToken) {
      return { ok: false, code: 'STALE_LEASE' };
    }
    this.sql.exec(
      `UPDATE deliveries SET state=?, resolved_ms=?, lease_token=NULL, lease_until=NULL
        WHERE edge_seq=? AND destination_id=?`, STATE.DELIVERED, Date.now(), seq, dest);
    this._advance(dest);
    this._mirrorLegacy(seq, dest, STATE.DELIVERED);
    log('EDGE_DELIVERED', { edge_seq: seq, destination_id: dest });
    this._gc();
    return { ok: true, destination_id: dest, next_seq_expected: this._head(dest) };
  }

  _advance(dest) {
    let n = this._head(dest);
    const counter = Number(this._meta('counter'));
    for (;;) {
      const r = this._delivery(n, dest);
      if (r && ADVANCEABLE.includes(r.state)) { n += 1; continue; }
      // F-02 · a sequence this destination never had a row for -- it was added later, or it was
      // DISABLED when that alert was accepted -- is not owed to it and must not block its line.
      // Skipping is bounded by the counter: the head never runs past what has been accepted.
      if (!r && n <= counter) { n += 1; continue; }
      break;
    }
    this._setMeta(this._headKey(dest), n);
  }

  /**
   * F-05 · ROLLBACK MIRROR. A row migrated from V1.2.3 keeps living in `outbox`, and V1.2.3 — if we
   * ever roll back — reads THAT table. If V1.3.0 resolved the delivery but `outbox` still said
   * PENDING_DISPATCH, a rollback would redeliver it and the only thing standing between that and a
   * repeated POST would be the Hub's dedupe, which is a barrier, not a mechanism.
   *
   * So the resolution of a MIGRATED row, for the LEGACY destination only, is mirrored back into
   * `outbox.state` / `resolved_ms`. Nothing else is touched: body, digest, content type and
   * received timestamp stay byte-identical, so the table remains migration evidence.
   */
  _mirrorLegacy(seq, dest, state, now = Date.now()) {
    if (dest !== this._meta('legacy_destination')) return;
    if (Number(seq) > Number(this._meta('migrated_max_seq') || 0)) return;
    try {
      const has = [...this.sql.exec(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='outbox'")][0].n > 0;
      if (!has) return;
      // V1.2.3 knows nothing of DISABLED_SKIPPED; for it, an administratively closed row is
      // ADMIN_SKIPPED, which is exactly how it must be treated after a rollback.
      const legacyState = state === STATE.DISABLED_SKIPPED ? STATE.ADMIN_SKIPPED
                        : state === STATE.FAILED_PERMANENT ? STATE.HALTED_DLQ : state;
      this.sql.exec('UPDATE outbox SET state=?, resolved_ms=? WHERE edge_seq=?', legacyState, now, Number(seq));
    } catch (err) {
      log('EDGE_LEGACY_MIRROR_FAILED', { edge_seq: seq, error: String(err && err.name || err) });
    }
  }

  /**
   * F-05 · Rollback gate. Read-only. `ok` is true ONLY when every destination is fully drained and
   * every MIGRATED legacy row is resolved in `outbox` too. A rollback must not rely on the Hub's
   * deduplication to absorb what this gate can prove empty beforehand.
   */
  async rollbackReadiness() {
    const s = await this.stats();
    const blockers = [];
    for (const [id, d] of Object.entries(s.destinations)) {
      if (d.unresolved) blockers.push(`UNRESOLVED:${id}:${d.unresolved}`);
      if (d.halted_seq !== null) blockers.push(`HALTED:${id}:${d.halted_seq}`);
    }
    let legacyPending = [];
    try {
      const has = [...this.sql.exec(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='outbox'")][0].n > 0;
      if (has) {
        legacyPending = [...this.sql.exec(
          `SELECT edge_seq FROM outbox WHERE state IN (${UNRESOLVED_SQL}) ORDER BY edge_seq ASC LIMIT 50`)]
          .map(r => r.edge_seq);
      }
    } catch { /* no legacy table: nothing to mirror */ }
    for (const seq of legacyPending) blockers.push(`LEGACY_OUTBOX_UNRESOLVED:${seq}`);
    return {
      ok: blockers.length === 0,
      gate: 'ROLLBACK_TO_V1_2_3',
      destinations: s.destinations,
      legacy_destination: this._meta('legacy_destination'),
      migrated_max_seq: Number(this._meta('migrated_max_seq') || 0),
      legacy_outbox_unresolved: legacyPending,
      blockers,
      note: "Hub-side deduplication is an additional barrier, not the mechanism: roll back only with ok:true.",
    };
  }

  /**
   * F-02 · Durable, audited resolution of a delivery whose destination was disabled after the alert
   * was accepted. Called by the consumer instead of acking a row into limbo. Idempotent.
   */
  async destinationDisabled(edgeSeq, destinationId, reason = 'DESTINATION_DISABLED') {
    const seq = Number(edgeSeq);
    const dest = this._destId(destinationId);
    const row = this._delivery(seq, dest);
    if (!row) return { ok: true, code: 'NOTHING_OWED', destination_id: dest };
    if (RESOLVED.includes(row.state)) return { ok: true, idempotent: true, state: row.state };
    const now = Date.now();
    this.sql.exec(
      `UPDATE deliveries SET state=?, resolved_ms=?, halt_reason=?, lease_token=NULL, lease_until=NULL
        WHERE edge_seq=? AND destination_id=?`, STATE.DISABLED_SKIPPED, now, String(reason), seq, dest);
    const signal = this._signal(seq);
    this.sql.exec(
      `INSERT INTO admin_log(ts_ms, edge_seq, action, actor, reason, previous_state, digest,
                             destination_id) VALUES(?,?,?,?,?,?,?,?)`,
      now, seq, 'disabled_skip', 'system', String(reason), row.state, signal && signal.digest, dest);
    this._advance(dest);
    this._mirrorLegacy(seq, dest, STATE.DISABLED_SKIPPED, now);
    log('EDGE_DELIVERY_DISABLED_SKIPPED', { edge_seq: seq, destination_id: dest, reason });
    this._gc();
    return { ok: true, destination_id: dest, state: STATE.DISABLED_SKIPPED,
             next_seq_expected: this._head(dest) };
  }

  /**
   * Never removes a signal that still OWES a destination a delivery.
   *
   * V1.3.0 · a FAILED_PERMANENT delivery is resolved for retention purposes: the destination is
   * stopped and the operator has been told, so the sequence must not pin the whole outbox forever.
   * Its retention frontier is therefore the failed sequence itself, not the halted head.
   */
  _gcFrontier(dest) {
    const head = this._head(dest);
    const failedAtHead = this._delivery(head, dest);
    if (failedAtHead && (failedAtHead.state === STATE.FAILED_PERMANENT ||
                         failedAtHead.state === STATE.HALTED_DLQ)) return head + 1;
    return head;
  }

  /**
   * F-02B · Reconcilia la cabeza de TODOS los destinos conocidos. Sin esto, un destino deshabilitado
   * -- que correctamente deja de recibir filas -- se queda con la cabeza clavada en la primera
   * secuencia que nunca se le debió, y como `_gcFrontier()` parte de esa cabeza, fijaba la frontera
   * global de GC indefinidamente mientras los demás Hubs seguían operando.
   *
   * `_advance()` solo salta filas ADVANCEABLE y huecos por debajo del contador: nunca sobrepasa una
   * entrega realmente pendiente, un `FAILED_PERMANENT` ni un halt. Es idempotente y barato.
   */
  _reconcileHeads() {
    const ids = new Set([...this.sql.exec('SELECT DISTINCT destination_id AS id FROM deliveries')].map(r => r.id));
    for (const r of this.sql.exec('SELECT k FROM meta WHERE k LIKE ?', 'next_seq_expected:%')) {
      ids.add(String(r.k).slice('next_seq_expected:'.length));
    }
    try { for (const d of allDestinations(this._cfg())) ids.add(d.id); } catch { /* config rota */ }
    for (const id of ids) this._advance(id);
    return [...ids];
  }

  _gc() {
    const ids = this._reconcileHeads();
    if (!ids.length) return;
    const cutoff = Math.min(...ids.map(id => this._gcFrontier(id))) - DEFAULTS.GC_LAG;
    const resolved = `'${RESOLVED.join("','")}'`;
    this.sql.exec(`DELETE FROM deliveries WHERE state IN (${resolved}) AND edge_seq < ?`, cutoff);
    this.sql.exec(
      `DELETE FROM signals WHERE edge_seq < ?
        AND NOT EXISTS (SELECT 1 FROM deliveries WHERE deliveries.edge_seq = signals.edge_seq)`,
      cutoff);
  }

  // ---- CAUSAL HALT (per destination) -------------------------------------------------
  /**
   * Records the ONE terminal failure state, `FAILED_PERMANENT`, for ONE destination. The method
   * keeps its V1.2.3 name because the audit trail and the admin surface refer to it; the state it
   * writes is `FAILED_PERMANENT` and there is no `DEAD_LETTER` state. "DLQ" names only the queue
   * where the consumer records the failure before calling this.
   *
   * Called only AFTER that destination's DLQ write is confirmed and BEFORE the original is acked.
   * The halt is scoped to ONE destination: every other destination keeps delivering. The Edge does
   * not interpret why a Hub rejected the alert and never propagates that state sideways.
   */
  async haltedDlq(edgeSeq, destinationId, reason, detail = {}) {
    const seq = Number(edgeSeq);
    // V1.2.3 shape: haltedDlq(seq, reason, detail).
    if (typeof destinationId === 'string' && reason !== undefined && typeof reason === 'object') {
      detail = reason; reason = destinationId; destinationId = undefined;
    } else if (reason === undefined && destinationId !== undefined && !destinationById(this._cfg(), destinationId)) {
      reason = destinationId; destinationId = undefined;
    }
    const dest = this._destId(destinationId);
    const row = this._delivery(seq, dest);
    if (!row) return { ok: false, code: 'UNKNOWN_SEQ' };
    this.sql.exec(
      `UPDATE deliveries SET state=?, halt_reason=?, resolved_ms=?, lease_token=NULL,
                             lease_until=NULL WHERE edge_seq=? AND destination_id=?`,
      STATE.FAILED_PERMANENT, String(reason || 'PERMANENT_FAILURE'), Date.now(), seq, dest);
    this._setMeta(this._haltKey(dest), seq);
    this._mirrorLegacy(seq, dest, STATE.FAILED_PERMANENT);
    log('EDGE_STREAM_HALTED', { edge_seq: seq, destination_id: dest, state: STATE.FAILED_PERMANENT,
                                reason, ...detail });
    const signal = this._signal(seq);
    this.ctx.waitUntil(this._notifyHalt(seq, dest, reason, signal && signal.digest));
    return { ok: true, halted_at: seq, destination_id: dest };
  }

  /** Active notification, independent of any Hub: a halt must still reach a human. */
  async _notifyHalt(seq, dest, reason, digest) {
    const url = this.env.HALT_NOTIFY_URL;
    if (!url) return;
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event: 'EDGE_STREAM_HALTED', edge_seq: seq, destination_id: dest,
                                 reason: String(reason), digest, ts_ms: Date.now() }),
        });
        if (res.ok) return;
      } catch { /* keep trying */ }
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
    log('EDGE_HALT_NOTIFY_FAILED', { edge_seq: seq, destination_id: dest });
  }

  // ---- ADMIN -------------------------------------------------------------------------
  /**
   * Explicit human decisions only, scoped to one destination. `opts.destination_id` selects it;
   * omitted, it is the only configured destination (V1.2.3 shape).
   */
  async adminResume(action, edgeSeq, actor, reason, opts = {}) {
    const seq = Number(edgeSeq);
    const dest = this._destId(opts.destination_id);
    const row = this._delivery(seq, dest);
    if (!row) return { ok: false, code: 'UNKNOWN_SEQ' };
    const haltedAt = this._meta(this._haltKey(dest));
    const isCurrentHalt = haltedAt !== null && Number(haltedAt) === seq;
    if (!isCurrentHalt && !opts.force) {
      return { ok: false, code: 'NOT_THE_CURRENT_HALT', destination_id: dest,
               halted_seq: haltedAt === null ? null : Number(haltedAt),
               hint: 'pass force:true with a documented reason to act on another sequence' };
    }
    if (!isCurrentHalt && !String(reason || '').trim()) {
      return { ok: false, code: 'FORCED_ACTION_REQUIRES_REASON' };
    }
    const previous = row.state;
    const now = Date.now();
    if (action === 'retry') {
      this.sql.exec(
        `UPDATE deliveries SET state=?, halt_reason=NULL, next_dispatch_ms=?, lease_token=NULL,
                               lease_until=NULL WHERE edge_seq=? AND destination_id=?`,
        STATE.PENDING_DISPATCH, now, seq, dest);
    } else if (action === 'skip') {
      this.sql.exec('UPDATE deliveries SET state=?, resolved_ms=? WHERE edge_seq=? AND destination_id=?',
                    STATE.ADMIN_SKIPPED, now, seq, dest);
    } else {
      return { ok: false, code: 'UNKNOWN_ACTION' };
    }
    const signal = this._signal(seq);
    this.sql.exec(
      `INSERT INTO admin_log(ts_ms, edge_seq, action, actor, reason, previous_state, digest,
                             destination_id) VALUES(?,?,?,?,?,?,?,?)`,
      now, seq, (opts.force && !isCurrentHalt) ? action + '_FORCED' : action,
      String(actor || 'unknown'), String(reason || ''), previous, signal && signal.digest, dest);
    if (isCurrentHalt) this.sql.exec('DELETE FROM meta WHERE k=?', this._haltKey(dest));
    this._advance(dest);
    this._mirrorLegacy(seq, dest, action === 'skip' ? STATE.ADMIN_SKIPPED : STATE.PENDING_DISPATCH, now);
    await this._ensureAlarm(now);
    log('EDGE_ADMIN_RESUME', { edge_seq: seq, destination_id: dest, action, previous_state: previous });
    return { ok: true, action, edge_seq: seq, destination_id: dest,
             next_seq_expected: this._head(dest) };
  }

  // ---- OBSERVABILITY -----------------------------------------------------------------
  /**
   * "What happened to this alert?" answered per destination. The top-level fields keep the V1.2.3
   * shape and describe the default destination, so existing tooling keeps working.
   */
  async stats() {
    this._reconcileHeads();   // F-02B · lo que se informa es la cabeza ya reconciliada
    // Todos los destinos CONFIGURADOS (habilitados o no) más cualquiera con filas: un destino
    // deshabilitado sigue siendo observable, que es como se comprueba que no retiene nada.
    let configured = [];
    try { configured = allDestinations(this._cfg()); } catch { configured = []; }
    const enabledIds = new Set(configured.filter(d => d.enabled).map(d => d.id));
    const ids = [...new Set([
      ...configured.map(d => d.id),
      ...[...this.sql.exec('SELECT DISTINCT destination_id AS id FROM deliveries')].map(r => r.id),
    ])];
    const per = {};
    for (const id of ids) {
      const by = {};
      for (const r of this.sql.exec(
        'SELECT state, COUNT(*) AS n FROM deliveries WHERE destination_id=? GROUP BY state', id)) {
        by[r.state] = r.n;
      }
      const oldest = [...this.sql.exec(
        `SELECT MIN(first_received_ms) AS m FROM deliveries
          WHERE destination_id=? AND state IN (${UNRESOLVED_SQL})`, id)][0].m;
      const halted = this._meta(this._haltKey(id));
      per[id] = {
        enabled: enabledIds.has(id),
        next_seq_expected: this._head(id),
        halted_seq: halted === null ? null : Number(halted),
        by_state: by,
        unresolved: this._unresolvedCount(id),
        oldest_unresolved_ms: oldest ?? null,
      };
    }
    // Observability is global and must never require a destination. The V1.2.3-shaped top-level
    // fields describe the single destination when there is exactly one; with several configured
    // they are null, because an implicit destination would be a lie about whose state this is.
    // Observabilidad a prueba de config rota: si la configuración es inválida, `stats()` sigue
    // respondiendo con lo que hay en el almacenamiento en vez de propagar el error.
    const single = configured.length === 1 ? configured[0].id : null;
    const d = (single && per[single]) || { next_seq_expected: null, halted_seq: null, by_state: {},
                                           unresolved: null, oldest_unresolved_ms: null };
    const def = single;
    return {
      counter: Number(this._meta('counter')),
      schema_version: Number(this._meta('schema_version') || SCHEMA_VERSION),
      destinations: per,
      default_destination_id: def,
      // V1.2.3-shaped view of the default destination.
      next_seq_expected: d.next_seq_expected,
      halted_seq: d.halted_seq,
      by_state: d.by_state,
      unresolved: d.unresolved,
      oldest_unresolved_ms: d.oldest_unresolved_ms,
    };
  }

  /** Per-signal trace: "SIGNAL 7 · HUB_A DELIVERED attempts 1 · HUB_B RETRYING attempts 4". */
  async signalStatus(edgeSeq) {
    const seq = Number(edgeSeq);
    const signal = this._signal(seq);
    const rows = [...this.sql.exec(
      'SELECT * FROM deliveries WHERE edge_seq=? ORDER BY destination_id ASC', seq)];
    if (!signal && !rows.length) return { found: false, edge_seq: seq };
    return {
      found: true, edge_seq: seq,
      received: !!signal,
      digest: signal ? signal.digest : null,
      edge_received_ms: signal ? signal.edge_received_ms : null,
      deliveries: rows.map(r => ({
        destination_id: r.destination_id, delivery_id: r.delivery_id, state: r.state,
        dispatch_attempts: r.dispatch_attempts, delivery_attempts: r.delivery_attempt,
        last_error: r.last_error, halt_reason: r.halt_reason,
        first_received_ms: r.first_received_ms, last_attempt_ms: r.last_attempt_ms,
        resolved_ms: r.resolved_ms,
      })),
    };
  }
}
