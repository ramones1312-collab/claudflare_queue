/**
 * HALT NOTIFICATION · the gap declared in the previous round.
 *
 * A silent halt over a weekend is the worst operational scenario in this design: alerts accumulate
 * safely in the outbox but nothing executes. The notification is what turns that into a phone call,
 * so it has to work, carry enough to act on, survive a first failure, and never depend on KAWA.
 */
import { describe, it, expect } from 'vitest';
import { newScenario, accept, deliver } from './_harness.js';

const PERMANENT = { status: 400, body: { ok: false, code: 'BAD_SIGNAL' } };

/** Installs a notification receiver by overriding the DO's own fetch for the duration. */
function notifyCollector(script) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('halt-notify.test')) {
      const body = JSON.parse(init.body);
      calls.push(body);
      const reply = await script(calls.length, body);
      return new Response('', { status: reply });
    }
    return real(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

describe('halt notification', () => {
  it('fires on HALTED_DLQ with enough information to act', async () => {
    const world = newScenario({ kawa: async () => PERMANENT });
    const c = notifyCollector(async () => 200);
    try {
      const s = (await accept(world, 'notify')).edge_seq;
      await deliver(world, s);
      // the DO notifies through waitUntil; give it a turn
      await new Promise(r => setTimeout(r, 50));
      expect(c.calls.length).toBeGreaterThanOrEqual(1);
      const payload = c.calls[0];
      expect(payload.event).toBe('EDGE_STREAM_HALTED');
      expect(payload.edge_seq).toBe(s);           // identifies exactly which sequence stopped
      expect(payload.reason).toContain('PERMANENT_400');
      expect(payload.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof payload.ts_ms).toBe('number');
    } finally { c.restore(); }
  });

  it('carries no secret and no full body', async () => {
    const world = newScenario({ kawa: async () => PERMANENT });
    const c = notifyCollector(async () => 200);
    try {
      const s = (await accept(world, 'nosecret')).edge_seq;
      await deliver(world, s);
      await new Promise(r => setTimeout(r, 50));
      const blob = JSON.stringify(c.calls);
      expect(blob).not.toContain('test-path-token');
      expect(blob).not.toContain('ALERT nosecret');   // the alert body itself never travels
      expect(blob).not.toContain('kawa');
    } finally { c.restore(); }
  });

  it('retries when the first notification attempt fails', async () => {
    const world = newScenario({ kawa: async () => PERMANENT });
    const c = notifyCollector(async (n) => (n === 1 ? 500 : 200));
    try {
      const s = (await accept(world, 'retrynotify')).edge_seq;
      await deliver(world, s);
      await new Promise(r => setTimeout(r, 1500));
      expect(c.calls.length).toBeGreaterThanOrEqual(2);   // first failed, it tried again
    } finally { c.restore(); }
  });

  it('a halt is still durable even if the notification fails outright', async () => {
    const world = newScenario({ kawa: async () => PERMANENT });
    const c = notifyCollector(async () => 500);
    try {
      const s = (await accept(world, 'nonotify')).edge_seq;
      await deliver(world, s);
      // The safety property must not depend on the notification channel working.
      expect((await world.stub().stats()).halted_seq).toBe(s);
    } finally { c.restore(); }
  });
});
