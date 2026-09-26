/**
 * CASE I · KAWA receives and processes N, but the Edge loses the response.
 *
 * The dangerous outcome would be advancing the stream on an unknown result. The required behaviour:
 * the head does NOT move, the same edge_seq is retried, KAWA deduplicates, and only a recognised
 * acknowledgement marks it DELIVERED and releases N+1.
 */
import { describe, it, expect } from 'vitest';
import { newScenario, accept, deliver } from './_harness.js';

describe('CASE I · lost response after KAWA already processed N', () => {
  it('does not advance, retries the same seq, and only settles on a recognised reply', async () => {
    // KAWA stores the alert on the first call but the response never gets back to us.
    const kawaLedger = [];
    const world = newScenario({
      // Only the FIRST alert loses its response; everything else behaves normally. Scoping this
      // matters: a script that swallowed every first response would also swallow N+1's, which is a
      // different scenario.
      kawa: async ({ body }) => {
        const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
        const isFirstAlert = text.includes('I-first');
        const seen = kawaLedger.includes(text);
        kawaLedger.push(text);
        if (isFirstAlert && !seen) return { throw: 'TimeoutError' };   // processed, answer lost
        if (seen) return { status: 200, body: { ok: true, code: 'DUPLICATE_REPLAY', duplicate: true } };
        return { status: 202, body: { ok: true, code: 'QUEUED' } };
      },
    });

    const a = await accept(world, 'I-first');
    const b = await accept(world, 'I-second');
    expect(a.status).toBe(202);
    expect(b.edge_seq).toBe(a.edge_seq + 1);

    // --- attempt 1: KAWA processed it, we never learned the outcome -----------------
    const first = await deliver(world, a.edge_seq);
    expect(first.acks.length).toBe(0);                 // never ack an unknown outcome
    expect(first.retries.length).toBe(1);
    let stats = await world.stub().stats();
    expect(stats.next_seq_expected).toBe(a.edge_seq);  // head did NOT move
    expect(kawaLedger.length).toBe(1);                 // KAWA really did receive it

    // --- N+1 must not slip past while N is unresolved --------------------------------
    const jumped = await deliver(world, b.edge_seq);
    expect(jumped.acks.length).toBe(0);
    expect(kawaLedger.length).toBe(1);                 // nothing new reached KAWA

    // --- attempt 2: same edge_seq, KAWA recognises the duplicate ---------------------
    await world.stub().expireDeliveryLease(a.edge_seq);
    const second = await deliver(world, a.edge_seq, 2);
    expect(second.acks.length).toBe(1);                // recognised duplicate == success
    stats = await world.stub().stats();
    expect(stats.next_seq_expected).toBe(b.edge_seq);  // only now does the head advance

    // --- and only now may N+1 pass ---------------------------------------------------
    await world.stub().expireDeliveryLease(b.edge_seq);
    const third = await deliver(world, b.edge_seq);
    expect(third.acks.length).toBe(1);
    expect(kawaLedger.length).toBe(3);                 // 1 original + 1 duplicate + 1 new
  });
});
