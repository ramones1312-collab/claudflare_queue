/**
 * TEST-ONLY subclass of the production sequencer.
 *
 * The seams below never ship. `src/sequencer.js` — the class the deployed Workers export — has no
 * test methods at all, so a real Durable Object in STAGING or PROD exposes no accidental
 * administrative surface: calling `setQueueFailureForTest` on it would be a TypeError, because the
 * method does not exist in that build.
 *
 * The tests bind THIS class instead (see vitest.config.js -> className: 'EdgeSequencerTestable'),
 * and it is reachable only from the test entrypoint, which wrangler never packages.
 */
import { EdgeSequencer } from '../src/sequencer.js';
import { allDestinations } from '../src/destinations.js';

export class EdgeSequencerTestable extends EdgeSequencer {
  /** Simulate a transport outage from inside the DO, which owns its own env. */
  async setQueueFailureForTest(fail) { this._queueFails = !!fail; return true; }
  async publishedForTest() { return this._published || []; }
  async resetPublishedForTest() { this._published = []; this._publishedDetail = []; return true; }
  async publishedDetailForTest() { return this._publishedDetail || []; }

  /**
   * V1.3.0 · per-scenario destination config and queue bindings. A DO reads its OWN env, so this is
   * the only way to give each scenario its own destinations. Never shipped: the production class
   * has no such method.
   */
  async setDestinationsForTest(override) {
    // Only serialisable config crosses the RPC boundary; the per-destination queue shims are built
    // HERE, inside the DO, because a binding with methods cannot be passed in from outside.
    this._envOverride = { ...(override || {}) };
    this._queued = this._queued || {};
    // Una config INVÁLIDA se acepta aquí a propósito: los tests de F-03 necesitan inyectarla para
    // comprobar que es el ingress quien falla cerrado, no el seam.
    let dests = [];
    try { dests = allDestinations(this._envOverride); } catch { dests = []; }
    for (const d of dests) {
      this._queued[d.id] = [];
      this._envOverride[d.queue_binding] = {
        send: async (e) => { (this._queued[e.destination_id] ||= []).push(e); },
      };
    }
    return true;
  }
  async queuedForTest(id) { return (this._queued && this._queued[String(id).toUpperCase()]) || []; }
  async takeQueuedForTest(id) {
    const k = String(id).toUpperCase();
    const out = (this._queued && this._queued[k]) || [];
    if (this._queued) this._queued[k] = [];
    return out;
  }
  async statusForTest(edgeSeq) { return this.signalStatus(edgeSeq); }
  async gcFrontierForTest(destinationId) { return this._gcFrontier(String(destinationId).toUpperCase()); }

  /**
   * F-05 · reproduce el estado POST-MIGRACIÓN: una fila legacy pendiente en `outbox` con su espejo
   * ya creado en `deliveries`. Es la única forma de ejercitar el espejo de rollback sin arrancar un
   * DO de V1.2.3 real.
   */
  async seedLegacyOutboxForTest(edgeSeq) {
    const seq = Number(edgeSeq);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS outbox(
      edge_seq INTEGER PRIMARY KEY, body BLOB NOT NULL, digest TEXT NOT NULL, content_type TEXT NOT NULL,
      edge_received_ms INTEGER NOT NULL, state TEXT NOT NULL, dispatch_attempts INTEGER NOT NULL DEFAULT 0,
      last_dispatch_ms INTEGER, next_dispatch_ms INTEGER, delivery_attempt INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT, lease_until INTEGER, halt_reason TEXT, resolved_ms INTEGER)`);
    const s = [...this.sql.exec('SELECT * FROM signals WHERE edge_seq=?', seq)][0];
    this.sql.exec(
      `INSERT OR REPLACE INTO outbox(edge_seq, body, digest, content_type, edge_received_ms, state,
        dispatch_attempts, next_dispatch_ms) VALUES(?,?,?,?,?,?,1,?)`,
      seq, s.body, s.digest, s.content_type, s.edge_received_ms, 'DISPATCHED', s.edge_received_ms);
    this._setMeta('legacy_destination', this._defaultDestination());
    this._setMeta('migrated_max_seq', seq);
    return true;
  }
  /** Cuántas filas quedarían por debajo de un corte, es decir, cuántas son ya recolectables. */
  async collectableBelowForTest(cutoff) {
    return [...this.sql.exec('SELECT COUNT(*) AS n FROM signals WHERE edge_seq < ?', Number(cutoff))][0].n;
  }
  async legacyRowForTest(edgeSeq) {
    const r = [...this.sql.exec('SELECT edge_seq, digest, state, resolved_ms FROM outbox WHERE edge_seq=?',
                                Number(edgeSeq))];
    return r.length ? r[0] : null;
  }

  /** Deterministic control over time-based behaviour, so tests need not wait minutes. */
  async forceDispatchDue(edgeSeq, destinationId) {
    if (destinationId) {
      this.sql.exec('UPDATE deliveries SET next_dispatch_ms=? WHERE edge_seq=? AND destination_id=?',
                    0, Number(edgeSeq), String(destinationId).toUpperCase());
    } else {
      this.sql.exec('UPDATE deliveries SET next_dispatch_ms=? WHERE edge_seq=?', 0, Number(edgeSeq));
    }
    return true;
  }
  async expireDeliveryLease(edgeSeq, destinationId) {
    if (destinationId) {
      this.sql.exec('UPDATE deliveries SET lease_until=? WHERE edge_seq=? AND destination_id=?',
                    0, Number(edgeSeq), String(destinationId).toUpperCase());
    } else {
      this.sql.exec('UPDATE deliveries SET lease_until=? WHERE edge_seq=?', 0, Number(edgeSeq));
    }
    return true;
  }
  /** One dispatch pass, mirroring what the production alarm() does. */
  async alarmForTest() { return this._dispatchDue(Date.now()); }

  /** Wraps the production publish path to record what went out and to inject failure. */
  async _publish(row, now = Date.now()) {
    if (this._queueFails) {
      const attempts = row.dispatch_attempts + 1;
      this.sql.exec(
        `UPDATE deliveries SET dispatch_attempts=?, last_dispatch_ms=?, next_dispatch_ms=?
          WHERE edge_seq=? AND destination_id=?`,
        attempts, now, now + 10000, row.edge_seq, row.destination_id);
      return false;
    }
    const ok = await super._publish(row, now);
    if (ok) {
      // V1.2.3 shape kept: a list of sequences. The per-destination detail lives in its own seam,
      // so the existing scenario expectations do not change meaning.
      (this._published = this._published || []).push(row.edge_seq);
      (this._publishedDetail = this._publishedDetail || []).push(
        { edge_seq: row.edge_seq, destination_id: row.destination_id, delivery_id: row.delivery_id });
    }
    return ok;
  }
}
