/**
 * Ingress · admission, the acceptance boundary and log hygiene.
 */
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import producer, { timingSafeEqual } from '../src/producer.js';
import { classify, DISPOSITION, retryDelaySeconds } from '../src/consumer.js';
import { newScenario, accept, deliver, SIG, PATH } from './_harness.js';

const ACCEPTED = { status: 202, body: { ok: true, code: 'QUEUED' } };

describe('ingress', () => {
  it('answers 202 only after a durable sequence exists', async () => {
    const world = newScenario();
    const r = await accept(world, 'i1');
    expect(r.status).toBe(202);
    expect(r.code).toBe('BUFFERED');
    expect(r.edge_seq).toBe(1);
    expect(r.digest).toMatch(/^[0-9a-f]{64}$/);
    expect((await world.stub().stats()).counter).toBe(1);
  });

  it('assigns strictly monotonic sequences', async () => {
    const world = newScenario();
    const a = await accept(world, 'm1'), b = await accept(world, 'm2'), c = await accept(world, 'm3');
    expect([a.edge_seq, b.edge_seq, c.edge_seq]).toEqual([1, 2, 3]);
  });

  it('fails closed with 503 when the sequencer is unreachable', async () => {
    const world = newScenario();
    const broken = { ...world.env,
      SEQUENCER: { idFromName: () => 'x',
                   get: () => ({ accept: async () => { throw new Error('DO_DOWN'); } }) } };
    const ctx = createExecutionContext();
    const res = await producer.fetch(
      new Request('https://edge.test' + PATH, { method: 'POST', body: SIG('z') }), broken, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(503);                 // never 2xx without a committed sequence
  });

  it('rejects a wrong path token generically and leaks nothing', async () => {
    const world = newScenario();
    const ctx = createExecutionContext();
    const res = await producer.fetch(
      new Request('https://edge.test/webhook/wrong', { method: 'POST', body: SIG('x') }),
      world.env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('test-path-token');
  });

  it('rejects non-POST and out-of-range bodies', async () => {
    const world = newScenario();
    const ctx = createExecutionContext();
    const bad = await producer.fetch(
      new Request('https://edge.test' + PATH, { method: 'GET' }), world.env, ctx);
    await waitOnExecutionContext(ctx);
    expect(bad.status).toBe(405);

    const ctx2 = createExecutionContext();
    const big = await producer.fetch(
      new Request('https://edge.test' + PATH, { method: 'POST', body: 'x'.repeat(20000) }),
      world.env, ctx2);
    await waitOnExecutionContext(ctx2);
    expect(big.status).toBe(413);
  });

  it('compares the path token in constant time', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
  });

  it('never logs the path token', async () => {
    const world = newScenario();
    const lines = [];
    const original = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      const ctx = createExecutionContext();
      await producer.fetch(new Request('https://edge.test/webhook/wrong',
        { method: 'POST', body: SIG('lg') }), world.env, ctx);
      await waitOnExecutionContext(ctx);
      await accept(world, 'lg2');
    } finally { console.log = original; }
    expect(lines.join('\n')).not.toContain('test-path-token');
  });
});

describe('body integrity', () => {
  it('delivers the raw BLOB byte for byte', async () => {
    const world = newScenario({ kawa: async () => ACCEPTED });
    const r = await accept(world, 'bytes');
    await deliver(world, r.edge_seq);
    expect(world.received[0]).toBe(SIG('bytes'));
  });

  it('the queue envelope carries no body at all', async () => {
    const world = newScenario({ kawa: async () => ACCEPTED });
    await accept(world, 'env');
    const published = await world.stub().publishedForTest();
    expect(published).toEqual([1]);               // sequence numbers only
  });
});

describe('ack contract', () => {
  it('classifies every branch', () => {
    expect(classify(202, { code: 'QUEUED' }).disposition).toBe(DISPOSITION.DELIVERED);
    expect(classify(200, { code: 'ACCEPTED' }).disposition).toBe(DISPOSITION.DELIVERED);
    expect(classify(200, { code: 'DUPLICATE_REPLAY' }).disposition).toBe(DISPOSITION.DUPLICATE_ALREADY_HELD);
    expect(classify(200, { x: 1 }).disposition).toBe(DISPOSITION.RETRY);
    expect(classify(null, null).disposition).toBe(DISPOSITION.RETRY);
    expect(classify(500, null).disposition).toBe(DISPOSITION.RETRY);
    expect(classify(429, null).disposition).toBe(DISPOSITION.RETRY);
    expect(classify(408, null).disposition).toBe(DISPOSITION.RETRY);
    // V1.3.0 · CAMBIO DE EXPECTATIVA POR ESPECIFICACIÓN (decisión del owner): un 401/403 ya no se
    // reintenta indefinidamente. Es un fallo permanente de ESE destino, con notificación al
    // operador, y no afecta a los demás Hubs. Reintentar para siempre una credencial rechazada era
    // un fallo silencioso: la alerta no llegaba y nadie se enteraba.
    expect(classify(401, null).disposition).toBe(DISPOSITION.DEAD_LETTER);
    expect(classify(401, null).reason).toBe('AUTH_REJECTED_401');
    expect(classify(403, null).disposition).toBe(DISPOSITION.DEAD_LETTER);
    expect(classify(429, null).disposition).toBe(DISPOSITION.RETRY);
    expect(classify(408, null).disposition).toBe(DISPOSITION.RETRY);
    expect(classify(400, { retryable: true }).disposition).toBe(DISPOSITION.RETRY);
    expect(classify(400, null).disposition).toBe(DISPOSITION.DEAD_LETTER);
    expect(classify(422, null).disposition).toBe(DISPOSITION.DEAD_LETTER);
  });

  it('backs off within a bounded ceiling', () => {
    expect(retryDelaySeconds(1, 'x')).toBeLessThan(retryDelaySeconds(5, 'x'));
    expect(retryDelaySeconds(50, 'x')).toBeLessThanOrEqual(900);
  });

  it('CASE E · a duplicate of a DELIVERED sequence acks without re-POSTing', async () => {
    const world = newScenario({ kawa: async () => ACCEPTED });
    const s = (await accept(world, 'dup')).edge_seq;
    await deliver(world, s);
    expect(world.received.length).toBe(1);
    const again = await deliver(world, s, 3);
    expect(again.acks.length).toBe(1);
    expect(world.received.length).toBe(1);       // never sent twice
  });
});
