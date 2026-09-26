/**
 * V1.3.0 · ONE SIGNAL -> N DESTINATIONS.
 *
 * Mandatory cases 1-6 and 10: fan-out, isolation of a down destination, independent recovery at
 * different times, and a disabled destination that receives nothing and blocks nobody.
 */
import { describe, it, expect } from 'vitest';
import { newFanout, boot, accept, drain, SIG, tagOf } from './_fanout.js';

describe('V1.3.0 · durable fan-out', () => {
  it('1 · one signal is stored once and owed to every enabled destination', async () => {
    const w = await boot(newFanout());
    const out = await accept(w, 'A1');
    expect(out.status).toBe(202);
    expect(out.destinations).toEqual(['HUB_A', 'HUB_B']);

    const st = await w.stub().statusForTest(out.edge_seq);
    expect(st.received).toBe(true);
    expect(st.deliveries.map(d => d.destination_id)).toEqual(['HUB_A', 'HUB_B']);
    // Same edge_seq, distinct delivery identities.
    expect(st.deliveries.map(d => d.delivery_id))
      .toEqual([`E${out.edge_seq}:HUB_A`, `E${out.edge_seq}:HUB_B`]);

    await drain(w, 'HUB_A'); await drain(w, 'HUB_B');
    // Byte-for-byte the same alert reaches both Hubs.
    expect(w.received.HUB_A).toEqual([SIG('A1')]);
    expect(w.received.HUB_B).toEqual([SIG('A1')]);
  });

  it('2 · HUB_A down does not stop HUB_B, and A stays owed', async () => {
    const w = await boot(newFanout());
    await accept(w, 'B1');
    w.down.HUB_A = true;

    await drain(w, 'HUB_A', 2);
    await drain(w, 'HUB_B');

    expect(w.received.HUB_B).toEqual([SIG('B1')]);
    expect(w.received.HUB_A).toEqual([]);
    const s = await w.stub().stats();
    expect(s.destinations.HUB_B.next_seq_expected).toBe(2);   // B advanced
    expect(s.destinations.HUB_A.next_seq_expected).toBe(1);   // A still owes seq 1
    expect(s.destinations.HUB_A.unresolved).toBe(1);
  });

  it('3 · when HUB_A recovers it receives it, and HUB_B gets no needless duplicate', async () => {
    const w = await boot(newFanout());
    await accept(w, 'C1');
    w.down.HUB_A = true;
    await drain(w, 'HUB_A', 2);
    await drain(w, 'HUB_B');
    expect(w.received.HUB_B.length).toBe(1);

    w.down.HUB_A = false;
    await drain(w, 'HUB_A');
    expect(w.received.HUB_A).toEqual([SIG('C1')]);
    expect(w.received.HUB_B.length).toBe(1);                  // untouched by A's recovery
  });

  it('4 · the mirror case: HUB_B down, HUB_A delivers', async () => {
    const w = await boot(newFanout());
    await accept(w, 'D1');
    w.down.HUB_B = true;
    await drain(w, 'HUB_B', 2);
    await drain(w, 'HUB_A');
    expect(w.received.HUB_A).toEqual([SIG('D1')]);
    expect(w.received.HUB_B).toEqual([]);
    const s = await w.stub().stats();
    expect(s.destinations.HUB_B.by_state.DISPATCHED).toBe(1);
  });

  it('5-6 · both down: nothing is lost, and each converges when it comes back', async () => {
    const w = await boot(newFanout());
    w.down.HUB_A = true; w.down.HUB_B = true;
    for (const t of ['E1', 'E2', 'E3']) expect((await accept(w, t)).status).toBe(202);
    await drain(w, 'HUB_A', 2); await drain(w, 'HUB_B', 2);
    expect(w.received.HUB_A).toEqual([]); expect(w.received.HUB_B).toEqual([]);

    // B recovers first, then A: each converges on its own, in origin order.
    w.down.HUB_B = false;
    await drain(w, 'HUB_B');
    expect(w.received.HUB_B.map(tagOf)).toEqual(['E1', 'E2', 'E3']);
    expect(w.received.HUB_A).toEqual([]);

    w.down.HUB_A = false;
    await drain(w, 'HUB_A');
    expect(w.received.HUB_A.map(tagOf)).toEqual(['E1', 'E2', 'E3']);

    const s = await w.stub().stats();
    expect(s.destinations.HUB_A.next_seq_expected).toBe(4);
    expect(s.destinations.HUB_B.next_seq_expected).toBe(4);
    expect(s.destinations.HUB_A.unresolved).toBe(0);
    expect(s.destinations.HUB_B.unresolved).toBe(0);
  });

  it('10 · a disabled destination receives nothing and blocks nobody', async () => {
    const w = await boot(newFanout(['HUB_A', 'HUB_B'], { disabled: 'HUB_B' }));
    const out = await accept(w, 'F1');
    expect(out.destinations).toEqual(['HUB_A']);
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B');
    expect(w.received.HUB_A).toEqual([SIG('F1')]);
    expect(w.received.HUB_B).toEqual([]);
    expect(await w.stub().queuedForTest('HUB_B')).toEqual([]);  // never even dispatched
    const st = await w.stub().statusForTest(out.edge_seq);
    expect(st.deliveries.map(d => d.destination_id)).toEqual(['HUB_A']);
  });
});
