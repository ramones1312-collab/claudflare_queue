/**
 * Shared harness code for the isolated scenario files.
 *
 * This module holds no state: every scenario file runs in its own worker runtime and builds its own
 * sequencer stream, queue transport, KAWA receiver and DLQ. Nothing crosses between scenarios.
 */
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import producer, { sequencerStub } from '../src/producer.js';
import consumer from '../src/consumer.js';

export const PATH = '/webhook/test-path-token';
export const SIG = (tag) => `KAWA VECTOR V2.4 PROD · CORE-15 · SYNTHETIC ALERT ${tag} · PADDING`;
export const OK_QUEUED = { ok: true, code: 'QUEUED' };

let streamCounter = 0;

/**
 * A complete, private world for one scenario: its own Durable Object stream, an in-memory queue
 * transport, a scriptable KAWA receiver and a scriptable DLQ. No global mocks, no shared fetch
 * interception — the KAWA endpoint is injected, so nothing another test does can reach it.
 */
export function newScenario(opts = {}) {
  const published = [];         // transport envelopes the sequencer published
  const received = [];          // raw bodies KAWA saw, in the order it saw them
  const dlq = [];               // entries written to the dead-letter queue
  const world = {
    published, received, dlq,
    kawaScript: opts.kawa || (() => ({ status: 202, body: OK_QUEUED })),
    dlqScript: opts.dlq || (async () => {}),
    queueDown: false,
  };

  const streamName = `scenario-${++streamCounter}-${Math.random().toString(36).slice(2, 8)}`;

  world.env = {
    ...env,
    SEQUENCER_NAME: streamName,
    KAWA_WEBHOOK_URL: 'https://kawa.invalid/webhook/tok',   // never actually fetched; see below
    SIGNAL_QUEUE: {
      async send(envelope) {
        if (world.queueDown) throw new Error('QUEUE_UNAVAILABLE');
        published.push(envelope);
      },
    },
    DLQ: { async send(entry) { await world.dlqScript(entry); dlq.push(entry); } },
  };

  world.stub = () => sequencerStub(world.env);
  return world;
}

/**
 * Deliver one transport envelope through the real consumer, with KAWA replaced by the scenario's
 * scripted receiver. `fetch` is patched only for the duration of this call, so scenarios cannot
 * interfere with one another through a shared mock.
 */
export async function deliver(world, edgeSeq, attempts = 1, envOverrides = {}) {
  const acks = [], retries = [];
  const msg = {
    id: `cf-${edgeSeq}-${attempts}`, timestamp: new Date(), attempts,
    body: { schema: 'kawa.edge.v2', edge_seq: edgeSeq, digest: 'd' },
    ack: () => acks.push(edgeSeq),
    retry: (o) => retries.push(o || {}),
  };
  // The scenario's own KAWA receiver, injected through the service-binding seam. No global mock,
  // so two scenarios can never see each other's traffic.
  const kawaFetcher = {
    fetch: async (url, init) => {
      const body = init && init.body;
      const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
      const reply = await world.kawaScript({ url: String(url), body: text,
                                             headers: init && init.headers });
      if (reply && reply.throw) {
        world.received.push(text);          // KAWA did receive it; only the answer was lost
        throw new Error(reply.throw);
      }
      world.received.push(text);
      return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body),
                          { status: reply.status,
                            headers: { 'content-type': 'application/json' } });
    },
  };
  const ctx = createExecutionContext();
  await consumer.queue({ queue: 'kawa-signal-buffer', messages: [msg] },
                       { ...world.env, KAWA_FETCHER: kawaFetcher, ...envOverrides }, ctx);
  await waitOnExecutionContext(ctx);
  return { acks, retries, msg };
}

/** Accept one alert through the real ingress Worker. */
export async function accept(world, tag, envOverrides = {}) {
  const ctx = createExecutionContext();
  const res = await producer.fetch(
    new Request('https://edge.test' + PATH, { method: 'POST', body: SIG(tag) }),
    { ...world.env, ...envOverrides }, ctx);
  await waitOnExecutionContext(ctx);
  let body = null;
  try { body = await res.json(); } catch { /* non-json error path */ }
  return { status: res.status, ...(body || {}) };
}

/** Run the delivery loop until the queue drains or `maxPasses` is reached. */
export async function drainAll(world, seqs, maxPasses = 12) {
  for (let pass = 0; pass < maxPasses; pass++) {
    let progressed = false;
    for (const s of seqs) {
      const stats = await world.stub().stats();
      if (stats.next_seq_expected > s) continue;           // already past it
      const before = stats.next_seq_expected;
      await world.stub().expireDeliveryLease(s);
      await deliver(world, s);
      const after = (await world.stub().stats()).next_seq_expected;
      if (after !== before) progressed = true;
    }
    if (!progressed) break;
  }
}
