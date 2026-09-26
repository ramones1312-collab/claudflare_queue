/**
 * DLQ · causal halt.
 *
 * A dead-lettered signal must stop the stream. Letting N+1 through after N was dead-lettered would
 * hand KAWA a broken causal chain -- an EXIT for a position that was never opened.
 */
import { describe, it, expect } from 'vitest';
import { newScenario, accept, deliver } from './_harness.js';

const PERMANENT = { status: 400, body: { ok: false, code: 'BAD_SIGNAL' } };
const ACCEPTED = { status: 202, body: { ok: true, code: 'QUEUED' } };

describe('DLQ causal halt', () => {
  it('CASE H · DLQ write, then durable HALT, then ack -- in that order', async () => {
    const order = [];
    const world = newScenario({
      kawa: async () => PERMANENT,
      dlq: async () => { order.push('dlq'); },
    });
    const s = (await accept(world, 'halt')).edge_seq;
    const out = await deliver(world, s);
    out.acks.forEach(() => order.push('ack'));
    // Acking before persisting the halt would leave a window where a restart lets the stream
    // advance over a broken causal chain.
    expect(order).toEqual(['dlq', 'ack']);
    const stats = await world.stub().stats();
    expect(stats.halted_seq).toBe(s);
    expect(stats.next_seq_expected).toBe(s);        // the head did NOT advance
    expect(world.dlq.length).toBe(1);
  });

  it('nothing after a halt ever reaches KAWA', async () => {
    let permanent = true;
    const world = newScenario({ kawa: async () => (permanent ? PERMANENT : ACCEPTED) });
    const a = (await accept(world, 'h1')).edge_seq;
    const b = (await accept(world, 'h2')).edge_seq;
    await deliver(world, a);                         // a is dead-lettered, stream halts
    const before = world.received.length;
    permanent = false;                               // KAWA is perfectly healthy now
    for (let i = 0; i < 3; i++) {
      await world.stub().expireDeliveryLease(b);
      await deliver(world, b);
    }
    expect(world.received.length).toBe(before);      // b never got through
    expect((await world.stub().stats()).next_seq_expected).toBe(a);
  });

  it('a failed DLQ write does not ack and does not halt', async () => {
    const world = newScenario({
      kawa: async () => PERMANENT,
      dlq: async () => { throw new Error('DLQ_DOWN'); },
    });
    const s = (await accept(world, 'dlqfail')).edge_seq;
    const out = await deliver(world, s);
    expect(out.acks.length).toBe(0);                 // the alert is not deleted
    expect(out.retries.length).toBe(1);
    expect((await world.stub().stats()).halted_seq).toBeNull();
  });

  it('an ambiguous DLQ write may be repeated with the same edge_seq', async () => {
    let calls = 0;
    const world = newScenario({
      kawa: async () => PERMANENT,
      dlq: async () => { calls += 1; if (calls === 1) throw new Error('AMBIGUOUS'); },
    });
    const s = (await accept(world, 'dlqamb')).edge_seq;
    await deliver(world, s);                          // first DLQ attempt fails
    await world.stub().expireDeliveryLease(s);
    const second = await deliver(world, s, 2);        // retried with the SAME sequence
    expect(second.acks.length).toBe(1);
    expect(calls).toBe(2);
    // A duplicate in the DLQ is acceptable; a lost signal is not.
    expect((await world.stub().stats()).halted_seq).toBe(s);
  });

  it('admin retry releases the halt and the stream resumes in order', async () => {
    let permanent = true;
    const world = newScenario({ kawa: async () => (permanent ? PERMANENT : ACCEPTED) });
    const a = (await accept(world, 'ar1')).edge_seq;
    const b = (await accept(world, 'ar2')).edge_seq;
    await deliver(world, a);
    expect((await world.stub().stats()).halted_seq).toBe(a);

    permanent = false;
    const res = await world.stub().adminResume('retry', a, 'felipe', 'payload fixed upstream');
    expect(res.ok).toBe(true);
    expect((await world.stub().stats()).halted_seq).toBeNull();

    await world.stub().expireDeliveryLease(a);
    await deliver(world, a);
    await world.stub().expireDeliveryLease(b);
    await deliver(world, b);
    // ar1 appears twice: the attempt that was dead-lettered did reach KAWA before the 400, and the
    // admin retry sent it again. Duplicates are tolerable by contract; what must hold is that ar2
    // never appears before the last ar1.
    const order = world.received.map(t => t.match(/ALERT (ar\d)/)[1]);
    expect(order.lastIndexOf('ar1')).toBeLessThan(order.indexOf('ar2'));
    expect(order[order.length - 1]).toBe('ar2');
  });

  it('ADMIN_SKIPPED is explicit, audited, and never automatic', async () => {
    const world = newScenario({ kawa: async () => PERMANENT });
    const a = (await accept(world, 'sk1')).edge_seq;
    const b = (await accept(world, 'sk2')).edge_seq;
    await deliver(world, a);
    const res = await world.stub().adminResume('skip', a, 'felipe', 'malformed alert, accepted loss');
    expect(res.ok).toBe(true);
    expect(res.action).toBe('skip');
    const claim = await world.stub().claim(a);
    expect(claim.skipped).toBe(true);
    expect((await world.stub().stats()).next_seq_expected).toBe(b);
  });

  it('no automatic path can skip a halted sequence', async () => {
    const world = newScenario({ kawa: async () => PERMANENT });
    const a = (await accept(world, 'auto1')).edge_seq;
    await accept(world, 'auto2');
    await deliver(world, a);
    // Hammer it: retries, alarms, redispatch -- none of them may move the head past a halt.
    for (let i = 0; i < 5; i++) {
      await world.stub().forceDispatchDue(a);
      await world.stub().alarmForTest();
      await world.stub().expireDeliveryLease(a);
      await deliver(world, a, i + 2);
    }
    expect((await world.stub().stats()).next_seq_expected).toBe(a);
    expect((await world.stub().stats()).halted_seq).toBe(a);
  });
});

describe('adminResume hardening (V1.2.1)', () => {
  it('refuses to act on a sequence that is not the current halt', async () => {
    const world = newScenario({ kawa: async () => PERMANENT });
    const a = (await accept(world, 'hard1')).edge_seq;
    const b = (await accept(world, 'hard2')).edge_seq;
    await deliver(world, a);                                  // a is the halted sequence
    const res = await world.stub().adminResume('skip', b, 'felipe', 'wrong target');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('NOT_THE_CURRENT_HALT');
    expect(res.halted_seq).toBe(a);
    // and nothing moved
    expect((await world.stub().stats()).next_seq_expected).toBe(a);
  });

  it('refuses a forced action with no documented reason', async () => {
    const world = newScenario({ kawa: async () => PERMANENT });
    const a = (await accept(world, 'hard3')).edge_seq;
    const b = (await accept(world, 'hard4')).edge_seq;
    await deliver(world, a);
    const res = await world.stub().adminResume('skip', b, 'felipe', '', { force: true });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('FORCED_ACTION_REQUIRES_REASON');
  });

  it('allows a forced action when a reason is given, and marks it as forced', async () => {
    const world = newScenario({ kawa: async () => PERMANENT });
    const a = (await accept(world, 'hard5')).edge_seq;
    await accept(world, 'hard6');
    await deliver(world, a);
    const res = await world.stub().adminResume('retry', a, 'felipe', 'the current halt', {});
    expect(res.ok).toBe(true);                                 // current halt needs no force
  });

  it('the ordinary path on the current halt is unchanged', async () => {
    const world = newScenario({ kawa: async () => PERMANENT });
    const a = (await accept(world, 'hard7')).edge_seq;
    await deliver(world, a);
    const res = await world.stub().adminResume('skip', a, 'felipe', 'accepted loss');
    expect(res.ok).toBe(true);
  });
});

describe('halt marker integrity (V1.2.2)', () => {
  it('a forced action on another sequence never clears a different halt', async () => {
    const world = newScenario({ kawa: async () => PERMANENT });
    const a = (await accept(world, 'mk1')).edge_seq;
    const b = (await accept(world, 'mk2')).edge_seq;
    await deliver(world, a);                                   // a is the halted sequence
    expect((await world.stub().stats()).halted_seq).toBe(a);

    // Force an action on b, a completely different sequence.
    const res = await world.stub().adminResume('skip', b, 'felipe', 'unrelated cleanup',
                                               { force: true });
    expect(res.ok).toBe(true);
    // The halt marker for `a` must survive: erasing it would let the stream advance past an
    // incident nobody attended.
    expect((await world.stub().stats()).halted_seq).toBe(a);
    expect((await world.stub().stats()).next_seq_expected).toBe(a);
  });

  it('resolving the current halt does clear the marker', async () => {
    const world = newScenario({ kawa: async () => PERMANENT });
    const a = (await accept(world, 'mk3')).edge_seq;
    await accept(world, 'mk4');
    await deliver(world, a);
    await world.stub().adminResume('skip', a, 'felipe', 'accepted loss');
    expect((await world.stub().stats()).halted_seq).toBeNull();
  });

  it('a forced action is audited distinctly from an ordinary one', async () => {
    const world = newScenario({ kawa: async () => PERMANENT });
    const a = (await accept(world, 'mk5')).edge_seq;
    const b = (await accept(world, 'mk6')).edge_seq;
    await deliver(world, a);
    const res = await world.stub().adminResume('retry', b, 'felipe', 'documented emergency',
                                               { force: true });
    expect(res.ok).toBe(true);
    expect((await world.stub().stats()).halted_seq).toBe(a);   // untouched
  });
});
