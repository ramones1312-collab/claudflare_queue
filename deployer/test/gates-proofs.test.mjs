/**
 * R3-09 negative controls for gate corrections that had none (E-05, E-06, E-10) and R3-13 (gate G null
 * baseline, gate K lease proof). Pure checks and the G00/RB gates with a fake harness: no Cloudflare.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.KAWA_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'kawa-gp-state-'));
const { restartProven, pendingForBoth, dlqBaselineUsable, redispatchProof, defineGates } = await import('../lib/gates/run.mjs');

test('E-05 · gate L: a restart is proven only by two known, different deployment ids', () => {
  assert.equal(restartProven('d1', 'd2'), true);
  for (const [a, b] of [[null, 'd2'], ['d1', null], [null, null], ['d1', 'd1'], [undefined, 'd2']]) assert.equal(restartProven(a, b), false, `${a} -> ${b}`);
});

test('E-06 · gate ISO-XY: both destinations must hold a durable pending delivery (never vacuous)', () => {
  const d = (id, state = 'DISPATCHED') => ({ destination_id: id, state });
  const sig = (deliveries) => ({ found: true, received: true, deliveries });
  assert.equal(pendingForBoth(sig([d('HUB_A'), d('HUB_B', 'PENDING_DISPATCH')]), 'HUB_A', 'HUB_B'), true);
  assert.equal(pendingForBoth(sig([]), 'HUB_A', 'HUB_B'), false, 'no deliveries at all');
  assert.equal(pendingForBoth(sig([d('HUB_A')]), 'HUB_A', 'HUB_B'), false, 'one destination missing');
  assert.equal(pendingForBoth(sig([d('HUB_A'), d('HUB_B', 'DELIVERED')]), 'HUB_A', 'HUB_B'), false, 'already delivered while paused');
  assert.equal(pendingForBoth({ found: true, received: false, deliveries: [d('HUB_A'), d('HUB_B')] }, 'HUB_A', 'HUB_B'), false);
});

test('R3-13 · gate G: a readable metric without a sample (null) is unknown, not 0', () => {
  assert.equal(dlqBaselineUsable({ readable: true, value: 0 }), true);
  assert.equal(dlqBaselineUsable({ readable: true, value: 3 }), true);
  assert.equal(dlqBaselineUsable({ readable: true, value: null }), false);
  assert.equal(dlqBaselineUsable({ readable: false, value: 0 }), false);
  assert.equal(dlqBaselineUsable(null), false);
});

test('R3-13 · gate K: the lease is proven only by >= 2 publications, no failed send, and a wait >= 5 min', () => {
  const sig = (dx) => ({ edge_received_ms: 1_000_000, deliveries: [{ destination_id: 'HUB_A', ...dx }] });
  assert.equal(redispatchProof(sig({ dispatch_attempts: 2, last_error: null, resolved_ms: 1_000_000 + 360e3 }), 'HUB_A').ok, true);
  assert.equal(redispatchProof(sig({ dispatch_attempts: 1, resolved_ms: 1_000_000 + 360e3 }), 'HUB_A').ok, false, 'one publication');
  assert.equal(redispatchProof(sig({ dispatch_attempts: 2, last_error: 'Error', resolved_ms: 1_000_000 + 360e3 }), 'HUB_A').ok, false, 'second attempt was a failed send retry');
  assert.equal(redispatchProof(sig({ dispatch_attempts: 2, resolved_ms: 1_000_000 + 60e3 }), 'HUB_A').ok, false, 'resolved before the lease');
  assert.equal(redispatchProof(sig({ dispatch_attempts: 2, resolved_ms: null }), 'HUB_A').ok, false, 'never resolved');
  assert.equal(redispatchProof(sig({ dispatch_attempts: 3 }), 'HUB_B').ok, false, 'other destination');
});

/** Fake harness: stats from a table, waitFor evaluates once (a false condition is a timeout). */
function fakeH(destinations) {
  return {
    stats: async () => ({ schema_version: 2, counter: 0, destinations }),
    control: async () => {},
    waitFor: async (name, fn) => { const v = await fn(); if (!v) throw new Error(`timeout: ${name}`); return v; },
    admin: async () => ({ status: 200, body: { ok: true, readiness: { blockers: [] } } }),
  };
}
const clean = { enabled: true, halted_seq: null, unresolved: 0, next_seq_expected: 1 };

test('E-10 · gates G00 and RB check EVERY enabled destination, not only the first two', async () => {
  const gates = defineGates({ X: 'HUB_A', Y: 'HUB_B', all: ['HUB_A', 'HUB_B', 'HUB_C'], includeLong: false, kind: 'cloud' });
  const g00 = gates.find(g => g.id === 'G00'), rb = gates.find(g => g.id === 'RB');
  await g00.run(fakeH({ HUB_A: clean, HUB_B: clean, HUB_C: clean }));
  await assert.rejects(g00.run(fakeH({ HUB_A: clean, HUB_B: clean, HUB_C: { ...clean, halted_seq: 7 } })), /HUB_C is halted/);
  await rb.run(fakeH({ HUB_A: clean, HUB_B: clean, HUB_C: clean }));
  await assert.rejects(rb.run(fakeH({ HUB_A: clean, HUB_B: clean, HUB_C: { ...clean, unresolved: 1 } })), /timeout: all destinations drained/);
});
