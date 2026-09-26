/**
 * THE RELEASE GATE · forced reorder.
 *
 * Cloudflare Queues does not guarantee FIFO. Publish 1..5, hand them to the consumer in the order
 * 3,1,5,2,4, and require that KAWA observes exactly 1,2,3,4,5.
 */
import { describe, it, expect } from 'vitest';
import { newScenario, accept, deliver, SIG } from './_harness.js';

describe('release gate · forced reorder 3,1,5,2,4', () => {
  it('KAWA observes 1,2,3,4,5 regardless of delivery order', async () => {
    const world = newScenario();
    const seqs = [];
    for (let i = 1; i <= 5; i++) seqs.push((await accept(world, `r${i}`)).edge_seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);

    const scrambled = [3, 1, 5, 2, 4];
    // Out-of-turn messages retry, exactly as the real queue redelivers them. Several passes model
    // that redelivery without ever reordering what KAWA sees.
    for (let pass = 0; pass < 6; pass++) {
      for (const s of scrambled) {
        await world.stub().expireDeliveryLease(s);
        await deliver(world, s);
      }
    }
    const observed = world.received.map(t => Number(t.match(/ALERT r(\d)/)[1]));
    expect(observed).toEqual([1, 2, 3, 4, 5]);
    expect((await world.stub().stats()).next_seq_expected).toBe(6);
  });

  it('CASE J · a burst of 10 is delivered in order', async () => {
    const world = newScenario();
    const seqs = [];
    for (let i = 1; i <= 10; i++) seqs.push((await accept(world, `b${i}`)).edge_seq);
    const shuffled = [7, 2, 9, 1, 5, 10, 3, 8, 4, 6];
    for (let pass = 0; pass < 12; pass++) {
      for (const s of shuffled) {
        await world.stub().expireDeliveryLease(s);
        await deliver(world, s);
      }
    }
    const observed = world.received.map(t => Number(t.match(/ALERT b(\d+)/)[1]));
    expect(observed).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('CASE D · N+1 never reaches KAWA before N', async () => {
    const world = newScenario();
    const a = (await accept(world, 'd1')).edge_seq;
    const b = (await accept(world, 'd2')).edge_seq;
    const out = await deliver(world, b);
    expect(world.received.length).toBe(0);      // nothing was POSTed at all
    expect(out.acks.length).toBe(0);
    expect(out.retries.length).toBe(1);
    const claim = await world.stub().claim(b);
    expect(claim.status).toBe('WAIT');
    expect(claim.next_seq_expected).toBe(a);
  });
});
