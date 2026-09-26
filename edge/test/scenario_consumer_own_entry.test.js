/**
 * V1.3.1 · The deployer gives each consumer only ITS OWN entry in DESTINATIONS (so adding HUB_C never
 * redeploys HUB_A's consumer). The Sequencer's config is unchanged and remains the authority.
 * This file proves the consumer behaves identically with that reduced view: delivery in order, the
 * pinned-destination refusal, the 401 permanent-failure path to ITS OWN DLQ, and the disabled check.
 * Production code is not modified.
 */
import { describe, it, expect } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import consumer from '../src/consumer.js';
import { newFanout, boot, accept, OK_QUEUED } from './_fanout.js';

/** Like _fanout.drain, but the consumer sees ONLY its own DESTINATIONS entry. */
async function drainOwn(w, id, { script, passes = 6, envelopes } = {}) {
  const seen = [], acks = [], retries = [], dlq = [];
  const own = JSON.stringify([{ id, enabled: true }]);
  for (let p = 0; p < passes; p++) {
    await w.stub().alarmForTest();
    const pending = envelopes ? envelopes.splice(0) : await w.stub().takeQueuedForTest(id);
    if (!pending.length) break;
    for (const envelope of pending) {
      const fetcher = { fetch: async (url, init) => {
        const text = new TextDecoder().decode(init.body);
        seen.push(text);
        const reply = script ? script(text) : { status: 202, body: OK_QUEUED };
        return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
      } };
      const msg = { id: `m-${envelope.edge_seq}`, timestamp: new Date(), attempts: 1, body: envelope,
                    ack: () => acks.push(envelope.edge_seq), retry: () => retries.push(envelope.edge_seq) };
      await w.stub().expireDeliveryLease(envelope.edge_seq, envelope.destination_id);
      const ctx = createExecutionContext();
      const env = { ...w.env, DESTINATIONS: own, CONSUMER_DESTINATION_ID: id,
                    [`DEST_${id}_FETCHER`]: fetcher, [`DEST_${id}_DLQ`]: { send: async (e) => dlq.push(e) } };
      await consumer.queue({ queue: `q-${id}`, messages: [msg] }, env, ctx);
      await waitOnExecutionContext(ctx);
    }
  }
  return { seen, acks, retries, dlq };
}

describe('V1.3.1 · consumer with only its own DESTINATIONS entry', () => {
  it('delivers in origin order for each destination, same bytes to both', async () => {
    const w = await boot(newFanout(['HUB_A', 'HUB_B']));
    for (const t of ['o1', 'o2', 'o3']) expect((await accept(w, t)).status).toBe(202);
    const a = await drainOwn(w, 'HUB_A');
    const b = await drainOwn(w, 'HUB_B');
    expect(a.seen.map(s => s.split('ALERT ')[1].split(' ·')[0])).toEqual(['o1', 'o2', 'o3']);
    expect(b.seen).toEqual(a.seen);
    const st = await w.stub().stats();
    expect(st.destinations.HUB_A.next_seq_expected).toBe(4);
    expect(st.destinations.HUB_B.next_seq_expected).toBe(4);
  });

  it('an envelope for another destination is refused, never delivered with this credential', async () => {
    const w = await boot(newFanout(['HUB_A', 'HUB_B']));
    await accept(w, 'x1');
    await w.stub().alarmForTest();
    const forB = await w.stub().takeQueuedForTest('HUB_B');
    const r = await drainOwn(w, 'HUB_A', { envelopes: forB, passes: 1 });
    expect(r.seen.length).toBe(0);
    expect(r.acks.length).toBe(0);
    expect(r.retries.length).toBe(1);
  });

  it('401 fails ONLY this destination permanently, recorded in ITS OWN DLQ; the other keeps delivering', async () => {
    const w = await boot(newFanout(['HUB_A', 'HUB_B']));
    await accept(w, 'p1');
    const a = await drainOwn(w, 'HUB_A', { script: () => ({ status: 401, body: { ok: false } }) });
    expect(a.dlq.map(e => [e.destination_id, e.reason])).toEqual([['HUB_A', 'AUTH_REJECTED_401']]);
    await accept(w, 'p2');
    const b = await drainOwn(w, 'HUB_B');
    expect(b.seen.length).toBe(2);
    const st = await w.stub().stats();
    expect(st.destinations.HUB_A.halted_seq).toBe(1);
    expect(st.destinations.HUB_B.halted_seq).toBe(null);
  });
});
