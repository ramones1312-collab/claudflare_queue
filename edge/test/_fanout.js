/**
 * Shared fan-out harness. Each scenario builds its own destinations, each with its OWN queue,
 * receiver, DLQ and credential. Nothing is shared between destinations or between scenarios.
 */
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import producer, { sequencerStub } from '../src/producer.js';
import consumer from '../src/consumer.js';

export const PATH = '/webhook/test-path-token';
export const SIG = (tag) => `KAWA VECTOR V2.4 PROD · CORE-15 · SYNTHETIC ALERT ${tag} · PADDING`;
export const OK_QUEUED = { ok: true, code: 'QUEUED' };

let counter = 0;

/** A private world with N destinations, each with its own queue, receiver, DLQ and secret. */
export function newFanout(ids = ['HUB_A', 'HUB_B'], opts = {}) {
  const w = { queues: {}, received: {}, dlq: {}, script: {}, down: {}, enabled: {} };
  const streamName = `fanout-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
  // Only serialisable config here: the DO builds its own queue shims (see the test seam).
  const cfg = { DESTINATIONS: JSON.stringify(ids.map(id => ({ id, enabled: opts.disabled !== id }))) };

  for (const id of ids) {
    w.queues[id] = []; w.received[id] = []; w.dlq[id] = [];
    w.script[id] = opts.script && opts.script[id] ? opts.script[id]
      : () => ({ status: 202, body: OK_QUEUED });
    // Each destination's credential is its OWN binding name; they are never merged.
    cfg[`DEST_${id}_WEBHOOK_URL`] = `https://${id.toLowerCase()}.invalid/webhook/secret-of-${id}`;
  }
  w.cfg = cfg;
  w.env = { ...env, SEQUENCER_NAME: streamName, ...cfg };
  w.stub = () => sequencerStub(w.env);
  return w;
}

export async function boot(w) {
  // The DO owns its env, so the per-scenario destination config is injected through the test seam.
  await w.stub().setDestinationsForTest(w.cfg);
  return w;
}

export async function accept(w, tag, body) {
  const ctx = createExecutionContext();
  const res = await producer.fetch(
    new Request('https://edge.test' + PATH, { method: 'POST', body: body ?? SIG(tag) }), w.env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, ...(await res.json()) };
}

/** Drain one destination's queue through the real consumer, with that destination's receiver. */
export async function drain(w, id, passes = 6) {
  const acks = [], retries = [];
  for (let p = 0; p < passes; p++) {
    // The DO dispatches through its own waitUntil; one alarm pass is what production does on a
    // timer, and it makes the test deterministic instead of racing that background work.
    await w.stub().alarmForTest();
    const pending = [...w.queues[id].splice(0, w.queues[id].length),
                     ...await w.stub().takeQueuedForTest(id)];
    if (!pending.length) break;
    for (const envelope of pending) {
      const fetcher = {
        fetch: async (url, init) => {
          const text = new TextDecoder().decode(init.body);
          if (w.down[id]) throw new Error('HUB_DOWN');            // nothing observed, nothing acked
          const reply = await w.script[id]({ url: String(url), body: text, headers: init.headers });
          w.received[id].push(text);
          return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status,
                              headers: { 'content-type': 'application/json' } });
        },
      };
      const msg = {
        id: `cf-${envelope.edge_seq}-${id}`, timestamp: new Date(), attempts: 1, body: envelope,
        ack: () => acks.push(envelope.edge_seq),
        retry: () => { retries.push(envelope.edge_seq); w.queues[id].push(envelope); },
      };
      const ctx = createExecutionContext();
      await w.stub().expireDeliveryLease(envelope.edge_seq, id);
      // The dead-letter queue is a CONSUMER binding (the worker writes it), one per destination.
      const dlq = { send: async (e) => { w.dlq[id].push(e); } };
      await consumer.queue({ queue: `q-${id}`, messages: [msg] },
                           { ...w.env, CONSUMER_DESTINATION_ID: id, [`DEST_${id}_FETCHER`]: fetcher,
                             [`DEST_${id}_DLQ`]: dlq }, ctx);
      await waitOnExecutionContext(ctx);
    }
    if (!w.queues[id].length) break;
  }
  return { acks, retries };
}

export const tagOf = (text) => text.split('ALERT ')[1].split(' ·')[0];
