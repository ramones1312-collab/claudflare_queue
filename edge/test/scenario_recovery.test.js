/**
 * Failure matrix · acceptance, transport loss and recovery.
 *
 * The outbox is the preservation guarantee: once a sequence is committed it exists forever, and the
 * queue is only transport. Every case here proves that a transport failure produces at worst a
 * duplicate, never a gap and never a reorder.
 */
import { describe, it, expect } from 'vitest';
import { newScenario, accept, deliver, drainAll } from './_harness.js';

const ACCEPTED = { status: 202, body: { ok: true, code: 'QUEUED' } };

describe('failure matrix · acceptance and transport', () => {
  it('CASE A · queue.send fails, the sequence still exists and is recoverable', async () => {
    const world = newScenario({ kawa: async () => ACCEPTED });
    await world.stub().setQueueFailureForTest(true);
    const res = await accept(world, 'A');
    // The queue is NOT the acceptance criterion: the DO transaction already committed.
    expect(res.status).toBe(202);
    expect(res.edge_seq).toBe(1);
    expect((await world.stub().publishedForTest()).length).toBe(0);            // nothing ever reached the queue

    const stats = await world.stub().stats();
    expect(stats.unresolved).toBe(1);
    expect(stats.by_state.PENDING_DISPATCH).toBe(1);

    // The alarm recreates the transport once the queue returns.
    await world.stub().setQueueFailureForTest(false);
    await world.stub().forceDispatchDue(1);
    await world.stub().alarmForTest();
    expect(await world.stub().publishedForTest()).toEqual([1]);

    await deliver(world, 1);
    expect(world.received.length).toBe(1);
  });

  it('CASE B/C · a lost send confirmation republishes the SAME edge_seq', async () => {
    const world = newScenario({ kawa: async () => ACCEPTED });
    const s = (await accept(world, 'BC')).edge_seq;
    expect((await world.stub().publishedForTest()).length).toBe(1);

    // The row is still DISPATCHED and unresolved; its redispatch lease expires.
    await world.stub().forceDispatchDue(s);
    await world.stub().alarmForTest();
    expect((await world.stub().publishedForTest()).length).toBe(2);
    // A duplicate in the queue, never a second sequence.
    expect(new Set(await world.stub().publishedForTest()).size).toBe(1);

    // Both copies arrive; KAWA is only asked once.
    await deliver(world, s);
    await world.stub().expireDeliveryLease(s);
    const second = await deliver(world, s, 2);
    expect(second.acks.length).toBe(1);
    expect(world.received.length).toBe(1);             // the duplicate was absorbed by the gate
  });

  it('CASE K · a DISPATCHED copy that vanishes is rebuilt from the outbox', async () => {
    const world = newScenario({ kawa: async () => ACCEPTED });
    const s = (await accept(world, 'K')).edge_seq;
    await world.stub().resetPublishedForTest();                        // the transport copy is simply gone

    await world.stub().forceDispatchDue(s);
    await world.stub().alarmForTest();
    expect(await world.stub().publishedForTest()).toEqual([s]);
    await deliver(world, s);
    expect((await world.stub().stats()).next_seq_expected).toBe(s + 1);
  });

  it('CASE M · the alarm keeps rearming through repeated failures', async () => {
    const world = newScenario({ kawa: async () => ACCEPTED });
    await world.stub().setQueueFailureForTest(true);
    const s = (await accept(world, 'M')).edge_seq;

    // Several alarm cycles all fail to publish.
    for (let i = 0; i < 4; i++) {
      await world.stub().forceDispatchDue(s);
      await world.stub().alarmForTest();
    }
    expect((await world.stub().publishedForTest()).length).toBe(0);
    let stats = await world.stub().stats();
    expect(stats.unresolved).toBe(1);                  // still owed, never dropped

    // Infrastructure returns and the very next cycle recovers it.
    await world.stub().setQueueFailureForTest(false);
    await world.stub().forceDispatchDue(s);
    await world.stub().alarmForTest();
    expect((await world.stub().publishedForTest()).length).toBe(1);
    await deliver(world, s);
    expect(world.received.length).toBe(1);
  });

  it('CASE N · an outage longer than queue retention still delivers, in order', async () => {
    const world = newScenario({ kawa: async () => ACCEPTED });
    const seqs = [];
    for (let i = 1; i <= 4; i++) seqs.push((await accept(world, `N${i}`)).edge_seq);

    // Every queue copy expires: retention elapsed while the stream was halted or KAWA was down.
    await world.stub().resetPublishedForTest();

    // The DO still holds every body and rebuilds the transport.
    for (const s of seqs) await world.stub().forceDispatchDue(s);
    await world.stub().alarmForTest();
    expect((await world.stub().publishedForTest()).sort((a, b) => a - b)).toEqual(seqs);

    await drainAll(world, [...seqs].reverse());        // rebuilt copies arrive out of order
    const observed = world.received.map(t => t.match(/ALERT (N\d)/)[1]);
    expect(observed).toEqual(['N1', 'N2', 'N3', 'N4']);
  });

  it('CASE O · N+1 losing its transport is NOT a causal halt', async () => {
    const world = newScenario({ kawa: async () => ACCEPTED });
    const a = (await accept(world, 'O1')).edge_seq;
    const b = (await accept(world, 'O2')).edge_seq;

    // b arrives out of turn many times and would exhaust its transport retries.
    for (let i = 0; i < 6; i++) {
      await world.stub().expireDeliveryLease(b);
      await deliver(world, b, 90 + i);
    }
    let stats = await world.stub().stats();
    expect(stats.halted_seq).toBeNull();               // WAIT is not a dead letter
    expect(world.received.length).toBe(0);

    // Its transport copy is then discarded entirely -- the DO rebuilds it.
    await world.stub().resetPublishedForTest();
    await world.stub().forceDispatchDue(b);
    await world.stub().alarmForTest();
    expect(await world.stub().publishedForTest()).toContain(b);

    await drainAll(world, [a, b]);
    const observed = world.received.map(t => t.match(/ALERT (O\d)/)[1]);
    expect(observed).toEqual(['O1', 'O2']);
  });

  it('CASE F/G · nothing unresolved is ever garbage collected', async () => {
    const world = newScenario({ kawa: async () => ACCEPTED });
    await world.stub().setQueueFailureForTest(true);
    const s = (await accept(world, 'FG')).edge_seq;
    // A restart would reload exactly this state from SQLite; the row must still be here and claimable.
    const claim = await world.stub().claim(s);
    expect(claim.status).toBe('GO');
    expect(new TextDecoder().decode(claim.body)).toContain('ALERT FG');
  });

  it('CASE L · single-flight: two copies of N, only one delivery lease', async () => {
    const world = newScenario({ kawa: async () => ACCEPTED });
    const s = (await accept(world, 'L')).edge_seq;
    const first = await world.stub().claim(s);
    const second = await world.stub().claim(s);
    expect(first.status).toBe('GO');
    expect(second.status).toBe('BUSY');
    expect(second.retry_after_ms).toBeGreaterThan(0);
  });
});
