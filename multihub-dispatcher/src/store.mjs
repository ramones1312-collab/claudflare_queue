/**
 * SQLite store. A signal is stored ONCE (events); each enabled destination gets its own delivery row.
 * WAL + synchronous=FULL: once insertEvent() returns, the event survives a process or container crash.
 */
import { DatabaseSync } from 'node:sqlite';

export const STATUS = Object.freeze({ PENDING: 'PENDING', RETRY: 'RETRY', DELIVERED: 'DELIVERED', FAILED_PERMANENT: 'FAILED_PERMANENT' });

export function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS events (
      event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at  INTEGER NOT NULL,
      method       TEXT NOT NULL,
      query        TEXT NOT NULL,
      headers      TEXT NOT NULL,
      body         BLOB NOT NULL,
      remote       TEXT
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      event_id         INTEGER NOT NULL REFERENCES events(event_id),
      destination_id   TEXT NOT NULL,
      status           TEXT NOT NULL,
      attempts         INTEGER NOT NULL DEFAULT 0,
      last_attempt_at  INTEGER,
      next_retry_at    INTEGER NOT NULL,
      last_http_status INTEGER,
      last_error       TEXT,
      delivered_at     INTEGER,
      PRIMARY KEY (event_id, destination_id)
    );
    CREATE INDEX IF NOT EXISTS deliveries_open ON deliveries(destination_id, status, event_id);`);
  const q = {
    insEvent: db.prepare('INSERT INTO events(received_at, method, query, headers, body, remote) VALUES (?,?,?,?,?,?)'),
    insDelivery: db.prepare('INSERT INTO deliveries(event_id, destination_id, status, next_retry_at) VALUES (?,?,?,?)'),
    head: db.prepare(`SELECT d.*, e.method, e.query, e.headers, e.body FROM deliveries d JOIN events e USING(event_id)
                      WHERE d.destination_id = ? AND d.status IN ('PENDING','RETRY') ORDER BY d.event_id LIMIT 1`),
    done: db.prepare(`UPDATE deliveries SET status=?, attempts=attempts+1, last_attempt_at=?, last_http_status=?, last_error=?, delivered_at=?
                      WHERE event_id=? AND destination_id=?`),
    retry: db.prepare(`UPDATE deliveries SET status='RETRY', attempts=attempts+1, last_attempt_at=?, last_http_status=?, last_error=?, next_retry_at=?
                       WHERE event_id=? AND destination_id=?`),
    open: db.prepare(`SELECT destination_id, COUNT(*) n FROM deliveries WHERE status IN ('PENDING','RETRY') GROUP BY destination_id`),
    ping: db.prepare('SELECT 1 AS ok'),
  };
  return {
    db,
    /** Persists one signal and its deliveries in ONE transaction. Throws on any SQLite error. */
    insertEvent({ method, query, headers, body, remote }, destinationIds, now = Date.now()) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const { lastInsertRowid } = q.insEvent.run(now, method, query, JSON.stringify(headers), body, remote || null);
        const id = Number(lastInsertRowid);
        for (const d of destinationIds) q.insDelivery.run(id, d, STATUS.PENDING, now);
        db.exec('COMMIT');
        return id;
      } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
    },
    /** Oldest open delivery of a destination (strict order per destination). */
    head: (dest) => q.head.get(dest) || null,
    delivered: (ev, dest, http, now = Date.now()) => q.done.run(STATUS.DELIVERED, now, http, null, now, ev, dest),
    failedPermanent: (ev, dest, http, err, now = Date.now()) => q.done.run(STATUS.FAILED_PERMANENT, now, http, err, null, ev, dest),
    retry: (ev, dest, http, err, next, now = Date.now()) => q.retry.run(now, http, err, next, ev, dest),
    openCounts: () => Object.fromEntries(q.open.all().map(r => [r.destination_id, r.n])),
    ping: () => q.ping.get().ok === 1,
    close: () => db.close(),
  };
}
