/**
 * V1.3.0 · MULTI-DESTINATION CONTRACT — mandatory cases 7-9 and 11-15, plus the two explicit rules
 * (no history for a destination added later; no implicit destination once several are configured)
 * and the retention rule for a permanently failed destination.
 */
import { describe, it, expect, vi } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import consumer from '../src/consumer.js';
import { newFanout, boot, accept, drain, SIG, tagOf, OK_QUEUED } from './_fanout.js';

const SIGNAL_ID = 'a1b2c3d4e5f60718';
/** A TradingView-shaped alert: the trading identity lives INSIDE the body and the Edge never reads it. */
const ALERT = (tag) => JSON.stringify({ signal_id: SIGNAL_ID, tag, strategy: 'KAWA VECTOR V2.4 PROD' });

describe('V1.3.0 · multi-destination contract', () => {
  it('7 · a repeated TradingView request keeps ONE trading identity; each Hub deduplicates it', async () => {
    const seenByHub = { HUB_A: [], HUB_B: [] };
    const script = {};
    for (const id of ['HUB_A', 'HUB_B']) {
      script[id] = ({ body }) => {
        const sid = JSON.parse(body).signal_id;
        const first = !seenByHub[id].includes(sid);
        seenByHub[id].push(sid);
        // Each Hub is the authority on trading identity: the second copy is a recognised duplicate.
        return first ? { status: 202, body: OK_QUEUED } : { status: 200, body: { ok: true, code: 'DUPLICATE' } };
      };
    }
    const w = await boot(newFanout(['HUB_A', 'HUB_B'], { script }));
    const ctx = createExecutionContext(); await waitOnExecutionContext(ctx);
    const first = await accept(w, 'X', ALERT('X'));
    const second = await accept(w, 'X', ALERT('X'));
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B');

    // The Edge never parses the body, so it cannot merge two POSTs into one logical signal: it
    // transports both. What must NOT happen is a new trading identity -- and none is invented.
    for (const id of ['HUB_A', 'HUB_B']) {
      expect(seenByHub[id]).toEqual([SIGNAL_ID, SIGNAL_ID]);
      expect(w.received[id].map(b => JSON.parse(b).signal_id)).toEqual([SIGNAL_ID, SIGNAL_ID]);
    }
    // Both copies are resolved for both destinations, and no third delivery was created.
    for (const seq of [first.edge_seq, second.edge_seq]) {
      const st = await w.stub().statusForTest(seq);
      expect(st.deliveries.map(d => d.state)).toEqual(['DELIVERED', 'DELIVERED']);
    }
  });

  it('8 · an Edge redelivery reuses the same identity and does not POST twice', async () => {
    const w = await boot(newFanout());
    const out = await accept(w, 'Y', ALERT('Y'));
    await drain(w, 'HUB_A');
    expect(w.received.HUB_A.length).toBe(1);

    // The transport hands the same envelope again (queue redelivery, worker retry, redispatch).
    const envelope = { schema: 'kawa.edge.v3', edge_seq: out.edge_seq, destination_id: 'HUB_A',
                       delivery_id: `E${out.edge_seq}:HUB_A`, digest: 'd' };
    const acks = [], retries = [];
    const fetcher = { fetch: async () => { throw new Error('MUST_NOT_BE_CALLED'); } };
    const msg = { id: 'dup', timestamp: new Date(), attempts: 2, body: envelope,
                  ack: () => acks.push(1), retry: () => retries.push(1) };
    const ctx = createExecutionContext();
    await consumer.queue({ queue: 'q', messages: [msg] },
                         { ...w.env, CONSUMER_DESTINATION_ID: 'HUB_A', DEST_HUB_A_FETCHER: fetcher }, ctx);
    await waitOnExecutionContext(ctx);

    expect(acks.length).toBe(1);                      // acked without re-POSTing
    expect(retries.length).toBe(0);
    expect(w.received.HUB_A.length).toBe(1);          // the Hub saw it once
    const st = await w.stub().statusForTest(out.edge_seq);
    expect(st.deliveries[0].delivery_id).toBe(`E${out.edge_seq}:HUB_A`);   // same identity, always
  });

  it('9 · one destination configured behaves exactly like V1.2.3', async () => {
    const w = await boot(newFanout(['HUB_A']));
    const out = await accept(w, 'Z', ALERT('Z'));
    expect(out.destinations).toEqual(['HUB_A']);
    await drain(w, 'HUB_A');
    expect(w.received.HUB_A).toEqual([ALERT('Z')]);
    const s = await w.stub().stats();
    // The V1.2.3-shaped view is populated, because there is exactly one destination.
    expect(s.default_destination_id).toBe('HUB_A');
    expect(s.next_seq_expected).toBe(out.edge_seq + 1);
    // And the legacy call shape (no destination argument) still resolves.
    expect((await w.stub().claim(out.edge_seq)).status).toBe('ALREADY_DELIVERED');
  });

  it('11 · a bad secret on HUB_A fails that destination permanently; HUB_B keeps delivering', async () => {
    const script = { HUB_A: () => ({ status: 401, body: { ok: false, code: 'UNAUTHORIZED' } }) };
    const w = await boot(newFanout(['HUB_A', 'HUB_B'], { script }));
    const out = await accept(w, 'W', ALERT('W'));
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B');

    const st = await w.stub().statusForTest(out.edge_seq);
    const byId = Object.fromEntries(st.deliveries.map(d => [d.destination_id, d]));
    expect(byId.HUB_A.state).toBe('FAILED_PERMANENT');
    expect(byId.HUB_A.halt_reason).toBe('AUTH_REJECTED_401');
    expect(byId.HUB_B.state).toBe('DELIVERED');
    // The operator is told, through that destination's own dead-letter queue.
    expect(w.dlq.HUB_A.map(e => e.reason)).toEqual(['AUTH_REJECTED_401']);
    expect(w.dlq.HUB_A.map(e => e.destination_id)).toEqual(['HUB_A']);
    expect(w.dlq.HUB_B).toEqual([]);

    const s = await w.stub().stats();
    expect(s.destinations.HUB_A.halted_seq).toBe(out.edge_seq);
    expect(s.destinations.HUB_B.halted_seq).toBeNull();

    // And a later alert still reaches HUB_B while HUB_A stays stopped.
    const next = await accept(w, 'W2', ALERT('W2'));
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B');
    expect(w.received.HUB_B.length).toBe(2);
    // HUB_A's receiver saw exactly the one POST it rejected with 401; the later alert never reached
    // it, because that destination is stopped.
    expect(w.received.HUB_A.length).toBe(1);
    expect(w.received.HUB_A.map(b => JSON.parse(b).tag)).toEqual(['W']);
    // W2 is still owed to HUB_A: it may be dispatched on the queue, but the turnstile holds it
    // behind the failed sequence. What matters is that it is unresolved and was never delivered.
    const pending = (await w.stub().statusForTest(next.edge_seq)).deliveries
      .find(d => d.destination_id === 'HUB_A');
    expect(['PENDING_DISPATCH', 'DISPATCHED']).toContain(pending.state);
    expect(pending.resolved_ms).toBeFalsy();
  });

  it('11b · a permanently failed destination stops retaining signals forever (GC)', async () => {
    const w = await boot(newFanout(['HUB_A', 'HUB_B'],
      { script: { HUB_A: () => ({ status: 400, body: { ok: false, code: 'BAD' } }) } }));
    const out = await accept(w, 'G', ALERT('G'));
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B');
    // Resolved for retention: HUB_A permanently failed, HUB_B delivered. Neither still owes it.
    expect(await w.stub().gcFrontierForTest('HUB_A')).toBe(out.edge_seq + 1);
    expect(await w.stub().gcFrontierForTest('HUB_B')).toBe(out.edge_seq + 1);
    // A destination that is merely down keeps its frontier where it is: nothing is collected.
    const w2 = await boot(newFanout(['HUB_A', 'HUB_B']));
    const o2 = await accept(w2, 'H', ALERT('H'));
    w2.down.HUB_A = true;
    await drain(w2, 'HUB_A', 2); await drain(w2, 'HUB_B');
    expect(await w2.stub().gcFrontierForTest('HUB_A')).toBe(o2.edge_seq);
  });

  it('12 · pending deliveries survive a restart / redeploy, keeping the same identity', async () => {
    const w = await boot(newFanout());
    w.down.HUB_A = true; w.down.HUB_B = true;
    const one = await accept(w, 'R1', ALERT('R1'));
    const two = await accept(w, 'R2', ALERT('R2'));
    await drain(w, 'HUB_A', 2); await drain(w, 'HUB_B', 2);

    // "Redeploy": every in-flight transport copy is discarded and the workers start clean. Only the
    // Durable Object's SQLite survives -- which is the whole point of the buffer.
    await w.stub().takeQueuedForTest('HUB_A'); await w.stub().takeQueuedForTest('HUB_B');
    w.queues.HUB_A = []; w.queues.HUB_B = [];
    await w.stub().forceDispatchDue(one.edge_seq); await w.stub().forceDispatchDue(two.edge_seq);

    w.down.HUB_A = false; w.down.HUB_B = false;
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B');
    for (const id of ['HUB_A', 'HUB_B']) {
      expect(w.received[id].map(b => JSON.parse(b).tag)).toEqual(['R1', 'R2']);
    }
    const st = await w.stub().statusForTest(one.edge_seq);
    expect(st.deliveries.map(d => d.delivery_id))
      .toEqual([`E${one.edge_seq}:HUB_A`, `E${one.edge_seq}:HUB_B`]);   // never a new identity
  });

  it('13 · concurrent signals never mix delivery state between destinations', async () => {
    const w = await boot(newFanout());
    const accepted = [];
    for (const t of ['C1', 'C2', 'C3']) accepted.push(await accept(w, t, ALERT(t)));
    // Interleaved progress: B runs ahead, A lags, then A catches up.
    w.down.HUB_A = true;
    await drain(w, 'HUB_B');
    await drain(w, 'HUB_A', 2);
    w.down.HUB_A = false;
    await drain(w, 'HUB_A');

    for (const id of ['HUB_A', 'HUB_B']) {
      expect(w.received[id].map(b => JSON.parse(b).tag)).toEqual(['C1', 'C2', 'C3']);
    }
    for (const a of accepted) {
      const st = await w.stub().statusForTest(a.edge_seq);
      expect(st.deliveries.map(d => `${d.destination_id}:${d.state}`))
        .toEqual(['HUB_A:DELIVERED', 'HUB_B:DELIVERED']);
      // Attempts are counted per destination; A's retries never inflate B's.
      expect(st.deliveries.find(d => d.destination_id === 'HUB_B').delivery_attempts).toBe(1);
    }
  });

  it('14 · origin order holds per destination even when the transport reorders', async () => {
    const w = await boot(newFanout());
    const seqs = [];
    for (const t of ['O1', 'O2', 'O3']) seqs.push((await accept(w, t, ALERT(t))).edge_seq);

    // Hand HUB_A its envelopes backwards: 3, 2, 1.
    const pending = [...await w.stub().takeQueuedForTest('HUB_A')].reverse();
    expect(pending.map(e => e.edge_seq)).toEqual([...seqs].reverse());
    const out = [];
    for (const envelope of pending) {
      const fetcher = { fetch: async (url, init) => {
        out.push(JSON.parse(new TextDecoder().decode(init.body)).tag);
        return new Response(JSON.stringify(OK_QUEUED), { status: 202,
                            headers: { 'content-type': 'application/json' } });
      } };
      const msg = { id: `o-${envelope.edge_seq}`, timestamp: new Date(), attempts: 1, body: envelope,
                    ack: () => {}, retry: () => {} };
      const ctx = createExecutionContext();
      await consumer.queue({ queue: 'q', messages: [msg] },
                           { ...w.env, CONSUMER_DESTINATION_ID: 'HUB_A', DEST_HUB_A_FETCHER: fetcher }, ctx);
      await waitOnExecutionContext(ctx);
    }
    // Only the head passed the turnstile; the out-of-turn ones were told to wait, never POSTed.
    expect(out).toEqual(['O1']);
    const s = await w.stub().stats();
    expect(s.destinations.HUB_A.next_seq_expected).toBe(seqs[1]);
    // HUB_B, untouched by any of this, is still at the start of its own line.
    expect(s.destinations.HUB_B.next_seq_expected).toBe(seqs[0]);
  });

  it('15 · no destination credential appears in logs, stats or the signal trace', async () => {
    const script = { HUB_A: () => ({ status: 401, body: { ok: false, code: 'UNAUTHORIZED' } }) };
    const w = await boot(newFanout(['HUB_A', 'HUB_B'], { script }));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let logged = '';
    try {
      const out = await accept(w, 'S1', ALERT('S1'));
      await drain(w, 'HUB_A'); await drain(w, 'HUB_B');
      logged = spy.mock.calls.map(c => c.map(String).join(' ')).join('\n');
      const trace = JSON.stringify(await w.stub().statusForTest(out.edge_seq));
      const stats = JSON.stringify(await w.stub().stats());
      for (const id of ['HUB_A', 'HUB_B']) {
        const secret = `secret-of-${id}`;
        expect(logged).not.toContain(secret);
        expect(logged).not.toContain(w.cfg[`DEST_${id}_WEBHOOK_URL`]);
        expect(trace).not.toContain(secret);
        expect(stats).not.toContain(secret);
      }
    } finally {
      spy.mockRestore();
    }
    // The logs are still useful: they name the destination and the reason, never the credential.
    expect(logged).toContain('HUB_A');
    expect(logged).toContain('AUTH_REJECTED_401');
  });

  it('RULE 1 · a destination added later receives no history', async () => {
    const w = await boot(newFanout(['HUB_A']));
    const before = await accept(w, 'P1', ALERT('P1'));
    await drain(w, 'HUB_A');

    // HUB_B is configured now, after P1 was accepted.
    await w.stub().setDestinationsForTest({
      ...w.cfg, DESTINATIONS: JSON.stringify([{ id: 'HUB_A' }, { id: 'HUB_B' }]) });
    w.env = { ...w.env, DESTINATIONS: JSON.stringify([{ id: 'HUB_A' }, { id: 'HUB_B' }]) };
    w.queues.HUB_B = w.queues.HUB_B || []; w.received.HUB_B = w.received.HUB_B || [];
    w.script.HUB_B = () => ({ status: 202, body: OK_QUEUED });
    w.env.DEST_HUB_B_WEBHOOK_URL = 'https://hub_b.invalid/webhook/secret-of-HUB_B';

    const after = await accept(w, 'P2', ALERT('P2'));
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B');

    expect((await w.stub().statusForTest(before.edge_seq)).deliveries.map(d => d.destination_id))
      .toEqual(['HUB_A']);                                    // no backfill of P1
    expect(w.received.HUB_B.map(b => JSON.parse(b).tag)).toEqual(['P2']);
    expect((await w.stub().stats()).destinations.HUB_B.next_seq_expected).toBe(after.edge_seq + 1);
  });

  it('RULE 2 · with several destinations configured, no route may use an implicit one', async () => {
    const w = await boot(newFanout(['HUB_A', 'HUB_B']));
    const out = await accept(w, 'I1', ALERT('I1'));
    // Every ambiguous call is refused rather than guessed.
    await expect(w.stub().claim(out.edge_seq)).rejects.toThrow(/DESTINATION_ID_REQUIRED/);
    await expect(w.stub().delivered(out.edge_seq)).rejects.toThrow(/DESTINATION_ID_REQUIRED/);
    await expect(w.stub().adminResume('skip', out.edge_seq, 'tester', 'why'))
      .rejects.toThrow(/DESTINATION_ID_REQUIRED/);
    // Naming the destination works normally.
    expect((await w.stub().claim(out.edge_seq, 'HUB_B')).status).toBe('GO');
    // Observability never needs a destination, and never invents one.
    const s = await w.stub().stats();
    expect(s.default_destination_id).toBeNull();
    expect(s.next_seq_expected).toBeNull();
    expect(Object.keys(s.destinations).sort()).toEqual(['HUB_A', 'HUB_B']);
  });
});
