/**
 * PHASE B · STAGING GATES. Physical evidence that the deployed Edge behaves as R4 specifies:
 * durable acceptance, strict per-destination order, isolation between destinations, halts,
 * admin retry/skip, restart and byte-for-byte integrity. SERIAL BY NECESSITY: every gate acts on
 * the same Sequencer, queues and receivers, and several gates depend on the state the previous
 * one left (a halt, a backlog).
 *
 * Result: PASS only if every mandatory gate passes. The first failure stops the run (later gates
 * would build on a broken state); cleanup always resumes queues and resets receiver behaviour.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { out, redact } from '../log.mjs';
import { names } from '../naming.mjs';

class GateFail extends Error {}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const OK2XX = new Set(['ACCEPTED', 'DUPLICATE']);

function expect(cond, msg, detail) { if (!cond) { const e = new GateFail(msg); e.detail = detail; throw e; } }

function harness(t, secrets, runId) {
  let n = 0;
  const sent = new Map();       // edge_seq -> { body, sha }
  const json = async (res) => { const text = await res.text(); try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200) }; } };
  const h = {
    sent,
    async send(gate, body) {
      const b = body ?? JSON.stringify({ signal_id: `STG-${runId}-${++n}`, source: 'kawa-edge-staging-gate', gate, n, pad: 'x'.repeat(16) });
      const res = await t.fetch(`${t.base.ingress}/webhook/${secrets.WEBHOOK_PATH_TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b });
      const j = await json(res);
      expect(res.status === 202 && j.code === 'BUFFERED', `ingress did not accept durably (HTTP ${res.status} ${j.code || ''})`);
      expect(j.digest === sha(b), 'ingress digest differs from the SHA-256 of the bytes sent');
      sent.set(j.edge_seq, { body: b, sha: sha(b) });
      return { seq: j.edge_seq, digest: j.digest, destinations: j.destinations, body: b };
    },
    async report(id) {
      const res = await t.fetch(`${t.base.receiver(id)}/report`);
      expect(res.ok, `receiver ${id} report unavailable (HTTP ${res.status})`);
      return json(res);
    },
    async control(id, behaviour) {
      const res = await t.fetch(`${t.base.receiver(id)}/control`, { method: 'POST',
        headers: { authorization: `Bearer ${secrets.CONTROL_TOKEN[id]}`, 'content-type': 'application/json' }, body: JSON.stringify({ behaviour }) });
      const j = await json(res);
      expect(res.ok && j.ok, `receiver ${id} refused behaviour ${behaviour} (HTTP ${res.status})`);
    },
    async admin(method, p, body) {
      const res = await t.fetch(`${t.base.admin}${p}`, { method, headers: { authorization: `Bearer ${secrets.ADMIN_TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
                                                        body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await json(res) };
    },
    async stats() { const r = await h.admin('GET', '/stats'); expect(r.status === 200, `admin /stats HTTP ${r.status}`); return r.body.stats; },
    async signal(seq) { const r = await h.admin('GET', `/signal?edge_seq=${seq}`); expect(r.status === 200, `admin /signal HTTP ${r.status}`); return r.body.signal; },
    async waitFor(what, fn, timeoutMs) {
      const t0 = Date.now(); let last;
      while (Date.now() - t0 < timeoutMs) {
        last = await fn();
        if (last) return last;
        await sleep(Math.min(3000, 500 + (Date.now() - t0) / 20));
      }
      throw new GateFail(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for: ${what}`);
    },
    /** Observations of `id` for the given sequences, in real order of receipt. */
    async obs(id, seqs) {
      const r = await h.report(id);
      const set = new Set(seqs.map(Number));
      return r.observations.filter(o => set.has(Number(o.edge_seq)));
    },
    async got2xx(id, seqs) {
      const o = await h.obs(id, seqs);
      return seqs.every(s => o.some(x => Number(x.edge_seq) === s && OK2XX.has(x.outcome)));
    },
  };
  return h;
}

/** THE invariant, per destination: nothing about N+1 reaches the Hub before N was accepted. */
function strictOrder(observations, seqs) {
  const want = [...seqs].sort((a, b) => a - b);
  const acked = new Set();
  for (const o of observations) {
    const s = Number(o.edge_seq);
    const before = want.filter(x => x < s);
    if (!before.every(x => acked.has(x))) return { ok: false, violation: `seq ${s} observed (${o.outcome}) before ${before.filter(x => !acked.has(x)).join(',')} was accepted` };
    if (OK2XX.has(o.outcome)) acked.add(s);
  }
  const first2xx = [];
  for (const o of observations) { const s = Number(o.edge_seq); if (OK2XX.has(o.outcome) && !first2xx.includes(s)) first2xx.push(s); }
  return { ok: JSON.stringify(first2xx) === JSON.stringify(want), order: first2xx, expected: want };
}

export function defineGates({ X, Y, all = [X, Y], includeLong, kind }) {
  const T = kind === 'cloud' ? { deliver: 180e3, halt: 420e3, lost: 420e3 } : { deliver: 90e3, halt: 240e3, lost: 240e3 };
  const qX = names.queue('staging', X), qY = names.queue('staging', Y);
  const st = {};                                     // state carried between dependent gates
  const G = [];
  const gate = (id, title, run, opts = {}) => G.push({ id, title, run, ...opts });
  // Gates that need a platform operation (queue pause, redeploy) run ONLY against Cloudflare. A local
  // runtime restart cannot emulate them: Miniflare's queue broker is in-memory, and a restarted local
  // workerd keeps a Durable Object's alarm timestamp but never fires it (proven, RELEASE_REPORT §5).
  const cloudOnly = { cloudOnly: true };

  gate('G00', 'Baseline: schema 2, both destinations clean, receivers reset', async (h) => {
    const s = await h.stats();
    expect(s.schema_version === 2, `schema_version ${s.schema_version}`);
    for (const id of [X, Y]) {
      const d = s.destinations[id];
      expect(d && d.enabled, `${id} not configured/enabled in the Sequencer`);
      expect(d.halted_seq === null, `${id} is halted at ${d.halted_seq} (left by an earlier run?)`, 'run: ./kawa-edge gates --repair');
      expect(d.unresolved === 0, `${id} has ${d.unresolved} unresolved deliveries`, 'run: ./kawa-edge gates --repair');
      await h.control(id, 'reset');
    }
    st.counter0 = s.counter;
    return { counter: s.counter, heads: Object.fromEntries(Object.entries(s.destinations).map(([k, v]) => [k, v.next_seq_expected])) };
  });

  gate('A', 'Durable acceptance: 202 after commit; one signal, one delivery per destination, same bytes', async (h) => {
    const a = await h.send('A');
    expect(Array.isArray(a.destinations) && a.destinations.includes(X) && a.destinations.includes(Y), `destinations ${a.destinations}`);
    await h.waitFor(`both receivers accept seq ${a.seq}`, async () => (await h.got2xx(X, [a.seq])) && (await h.got2xx(Y, [a.seq])), T.deliver);
    expect(JSON.stringify([...a.destinations].sort()) === JSON.stringify([...all].sort()), `fan-out ${a.destinations} != enabled ${all}`);
    const sig = await h.waitFor('every delivery DELIVERED', async () => { const s = await h.signal(a.seq); return s.deliveries.length === all.length && s.deliveries.every(d => d.state === 'DELIVERED') ? s : null; }, T.deliver);
    const ids = sig.deliveries.map(d => d.delivery_id).sort();
    expect(JSON.stringify(ids) === JSON.stringify(all.map(d => `E${a.seq}:${d}`).sort()), `delivery ids ${ids}`);
    expect(new Set(sig.deliveries.map(d => d.delivery_id)).size === all.length, 'duplicate delivery identity');
    return { edge_seq: a.seq, digest: a.digest, deliveries: sig.deliveries.map(d => ({ id: d.delivery_id, state: d.state, attempts: d.delivery_attempts })) };
  });

  for (const [id, count, title] of [['C', 5, 'Reorder: 5 concurrent alerts reach each Hub in origin order'], ['E', 10, 'Burst: 10 concurrent alerts, strict order per destination']]) {
    gate(id, title, async (h) => {
      const r = await Promise.all(Array.from({ length: count }, () => h.send(id)));
      const seqs = r.map(x => x.seq).sort((a, b) => a - b);
      expect(new Set(seqs).size === count, 'duplicate edge_seq assigned');
      const ev = {};
      for (const d of [X, Y]) {
        await h.waitFor(`${d} accepts ${count}`, () => h.got2xx(d, seqs), T.deliver);
        const so = strictOrder(await h.obs(d, seqs), seqs);
        expect(so.ok, `${d} order violated: ${so.violation || JSON.stringify(so.order)}`);
        ev[d] = so.order;
      }
      return { edge_seqs: seqs, order: ev };
    });
  }

  gate('D', 'Duplicate TradingView request: Edge transports both, each Hub deduplicates', async (h) => {
    const body = JSON.stringify({ signal_id: `STG-DUP-${Date.now()}`, source: 'kawa-edge-staging-gate', gate: 'D', pad: 'x'.repeat(16) });
    const a = await h.send('D', body), b = await h.send('D', body);
    expect(a.seq !== b.seq && a.digest === b.digest, 'two POSTs must get two sequences with the same digest');
    const ev = {};
    for (const d of [X, Y]) {
      await h.waitFor(`${d} sees both copies`, () => h.got2xx(d, [a.seq, b.seq]), T.deliver);
      const o = await h.obs(d, [a.seq, b.seq]);
      const outA = o.find(x => Number(x.edge_seq) === a.seq && OK2XX.has(x.outcome)).outcome;
      const outB = o.find(x => Number(x.edge_seq) === b.seq && OK2XX.has(x.outcome)).outcome;
      expect(outA === 'ACCEPTED' && outB === 'DUPLICATE', `${d}: expected ACCEPTED then DUPLICATE, got ${outA}/${outB}`);
      ev[d] = [outA, outB];
    }
    return { edge_seqs: [a.seq, b.seq], outcomes: ev };
  });

  gate('F', `Lost response on ${X}: no advance, retry, then DELIVERED; ${Y} unaffected`, async (h) => {
    await h.control(X, 'silent_once');
    const a = await h.send('F');
    // While the answer is lost, HUB_A's head must not move past this alert.
    await h.waitFor(`${X} observes the silent attempt`, async () => (await h.obs(X, [a.seq])).some(o => o.outcome === 'SILENT'), T.deliver);
    const during = await h.stats();
    expect(during.destinations[X].next_seq_expected <= a.seq, `${X} head advanced to ${during.destinations[X].next_seq_expected} without an acceptance`);
    await h.waitFor(`${Y} accepts`, () => h.got2xx(Y, [a.seq]), T.deliver);
    await h.waitFor(`${X} accepts after the lost response`, () => h.got2xx(X, [a.seq]), T.lost);
    const o = await h.obs(X, [a.seq]);
    expect(o[0].outcome === 'SILENT' && OK2XX.has(o[o.length - 1].outcome), `${X} observations: ${o.map(x => x.outcome)}`);
    const s = await h.signal(a.seq);
    const dx = s.deliveries.find(d => d.destination_id === X);
    expect(dx.state === 'DELIVERED' && dx.delivery_attempts >= 2, `${X} delivery ${dx.state} attempts ${dx.delivery_attempts}`);
    return { edge_seq: a.seq, observations: o.map(x => x.outcome), attempts: dx.delivery_attempts };
  });

  gate('M', `Receiver outage on ${Y} (503) with 3 in flight: nothing lost, strict order on recovery`, async (h) => {
    await h.control(Y, 'fail5xx_once');
    const r = await Promise.all([h.send('M'), h.send('M'), h.send('M')]);
    const seqs = r.map(x => x.seq).sort((a, b) => a - b);
    await h.waitFor(`${Y} recovers all 3`, () => h.got2xx(Y, seqs), T.lost);
    await h.waitFor(`${X} accepts all 3`, () => h.got2xx(X, seqs), T.deliver);
    const o = await h.obs(Y, seqs);
    expect(o.some(x => x.outcome === 'FAIL_5XX'), `${Y} never saw the scripted 503`);
    const so = strictOrder(o, seqs);
    expect(so.ok, `${Y} order violated: ${so.violation || JSON.stringify(so.order)}`);
    return { edge_seqs: seqs, observations: o.map(x => `${x.edge_seq}:${x.outcome}`) };
  });

  const isolation = (id, down, up, qDown) => gate(id, `${down} down (queue delivery paused): ${up} keeps delivering; ${down} catches up in order`, async (h, t) => {
    await t.pause(qDown);
    let seqs;
    try {
      const r = [await h.send(id), await h.send(id)];
      seqs = r.map(x => x.seq);
      await h.waitFor(`${up} accepts while ${down} is down`, () => h.got2xx(up, seqs), T.deliver);
      await sleep(15000);
      expect((await h.obs(down, seqs)).length === 0, `${down} received while its queue was paused`);
      const s = await h.stats();
      expect(s.destinations[down].unresolved >= 2, `${down} should still owe 2 deliveries, unresolved=${s.destinations[down].unresolved}`);
    } finally { await t.resume(qDown); }
    await h.waitFor(`${down} catches up`, () => h.got2xx(down, seqs), T.halt);
    const so = strictOrder(await h.obs(down, seqs), seqs);
    expect(so.ok, `${down} order violated after recovery`);
    return { edge_seqs: seqs, [down]: 'recovered in order', [up]: 'delivered during the outage' };
  }, cloudOnly);
  isolation('ISO-X', X, Y, qX);
  isolation('ISO-Y', Y, X, qY);

  gate('ISO-XY', 'Both down: signals durable; each destination converges independently when it returns', async (h, t) => {
    await t.pause(qX); await t.pause(qY);
    let seqs;
    try {
      seqs = [(await h.send('ISO-XY')).seq, (await h.send('ISO-XY')).seq];
      await sleep(15000);
      for (const d of [X, Y]) expect((await h.obs(d, seqs)).length === 0, `${d} received while paused`);
      for (const s of seqs) { const sig = await h.signal(s); expect(sig.found && sig.received && sig.deliveries.filter(d => d.destination_id === X || d.destination_id === Y).every(d => ['PENDING_DISPATCH', 'DISPATCHED'].includes(d.state)), `seq ${s} not durable/pending for ${X}/${Y}`); }
      await t.resume(qY);
      await h.waitFor(`${Y} converges first`, () => h.got2xx(Y, seqs), T.halt);
      expect((await h.obs(X, seqs)).length === 0, `${X} received while still paused`);
    } finally { await t.resume(qY); await t.resume(qX); }
    await h.waitFor(`${X} converges`, () => h.got2xx(X, seqs), T.halt);
    return { edge_seqs: seqs, order_of_convergence: [Y, X] };
  }, cloudOnly);

  gate('G', `FAILED_PERMANENT on ${Y} (permanent 4xx): DLQ record (platform-verified when readable), halt of ${Y} only; ${X} delivers`, async (h, t) => {
    await h.control(Y, 'permanent4xx');
    const a = await h.send('G');
    st.s1 = a.seq;
    const sig = await h.waitFor(`${Y} FAILED_PERMANENT`, async () => { const s = await h.signal(a.seq); const d = s.deliveries.find(x => x.destination_id === Y); return d && d.state === 'FAILED_PERMANENT' ? s : null; }, T.lost);
    const dy = sig.deliveries.find(x => x.destination_id === Y);
    expect(dy.halt_reason === 'PERMANENT_400', `halt_reason ${dy.halt_reason}`);
    const s = await h.stats();
    expect(s.destinations[Y].halted_seq === a.seq, `${Y} halted_seq ${s.destinations[Y].halted_seq}`);
    expect(s.destinations[X].halted_seq === null, `${X} must not be halted`);
    await h.waitFor(`${X} accepts`, () => h.got2xx(X, [a.seq]), T.deliver);
    // DLQ record. With "Account Analytics: Read" it is verified on the platform (nobody consumes the DLQ,
    // so its backlog must reach >= 1); a metric that stays 0 is a FAIL. Without that permission the
    // evidence says so explicitly: the record is then proven only by contract (the consumer calls
    // haltedDlq() only after DLQ.send() is confirmed; workerd test CASE H).
    let dlq;
    const first = await t.dlqBacklog(names.dlq('staging', Y));
    if (first === null) dlq = { verified: false, basis: 'contract (R4 CASE H); backlog metric unreadable without Account Analytics: Read' };
    else {
      const b = await h.waitFor(`${Y} DLQ backlog >= 1`, async () => { const v = await t.dlqBacklog(names.dlq('staging', Y)); return v >= 1 ? v : null; }, 300e3);
      dlq = { verified: true, backlog: b };
    }
    return { edge_seq: a.seq, state: dy.state, halt_reason: dy.halt_reason, halted_seq: a.seq, dlq };
  });

  gate('H', `N+1 blocked ONLY on halted ${Y}; its backlog stays durable (R21)`, async (h) => {
    await h.control(Y, 'ok');                         // Hub healthy again; the halt is what must hold
    st.s2 = (await h.send('H')).seq; st.s3 = (await h.send('H')).seq;
    await h.waitFor(`${X} accepts N+1, N+2`, () => h.got2xx(X, [st.s2, st.s3]), T.deliver);
    await sleep(20000);
    const o = await h.obs(Y, [st.s2, st.s3]);
    expect(o.length === 0, `${Y} received ${o.map(x => x.edge_seq)} past its halt`);
    for (const s of [st.s2, st.s3]) {
      const sig = await h.signal(s);
      const dy = sig.deliveries.find(d => d.destination_id === Y);
      expect(sig.found && sig.received && ['PENDING_DISPATCH', 'DISPATCHED'].includes(dy.state), `seq ${s} for ${Y}: ${dy && dy.state}`);
    }
    return { halted_at: st.s1, backlog: [st.s2, st.s3], [X]: 'delivered', [Y]: 'held, durable' };
  });

  gate('I', `Admin retry (${Y}, audited): the halted alert and its backlog arrive in order`, async (h) => {
    const noDest = await h.admin('POST', '/retry', { edge_seq: st.s1, actor: 'kawa-edge-gates', reason: 'gate I negative check' });
    expect(noDest.status === 400 && noDest.body.code === 'DESTINATION_ID_REQUIRED', `retry without destination_id must be refused, got ${noDest.status} ${noDest.body.code}`);
    const forced = await h.admin('POST', '/retry', { edge_seq: st.s1, destination_id: Y, actor: 'kawa-edge-gates', reason: 'x', force: true });
    expect(forced.status === 400 && forced.body.code === 'FORCE_NOT_ALLOWED_OVER_HTTP', 'force over HTTP must be refused');
    const r = await h.admin('POST', '/retry', { edge_seq: st.s1, destination_id: Y, actor: 'kawa-edge-gates', reason: 'STAGING gate I: receiver fixed' });
    expect(r.status === 200 && r.body.ok, `retry refused: ${JSON.stringify(r.body)}`);
    const seqs = [st.s1, st.s2, st.s3];
    await h.waitFor(`${Y} receives ${seqs}`, () => h.got2xx(Y, seqs), T.halt);
    const so = strictOrder(await h.obs(Y, seqs), seqs);
    expect(so.ok, `${Y} order after retry: ${JSON.stringify(so.order)}`);
    expect((await h.stats()).destinations[Y].halted_seq === null, 'halt marker not cleared');
    return { resumed: seqs, order: so.order, refused: ['no destination_id', 'force over HTTP'] };
  });

  gate('J', `Admin skip (${Y}): ADMIN_SKIPPED, audited, head advances without delivering it`, async (h) => {
    await h.control(Y, 'permanent4xx');
    const s4 = (await h.send('J')).seq;
    await h.waitFor(`${Y} FAILED_PERMANENT at ${s4}`, async () => (await h.stats()).destinations[Y].halted_seq === s4, T.lost);
    await h.control(Y, 'ok');
    const r = await h.admin('POST', '/skip', { edge_seq: s4, destination_id: Y, actor: 'kawa-edge-gates', reason: 'STAGING gate J: decided not to deliver' });
    expect(r.status === 200 && r.body.ok, `skip refused: ${JSON.stringify(r.body)}`);
    const sig = await h.signal(s4);
    expect(sig.deliveries.find(d => d.destination_id === Y).state === 'ADMIN_SKIPPED', 'not ADMIN_SKIPPED');
    const s5 = (await h.send('J')).seq;
    await h.waitFor(`${Y} receives the next alert`, () => h.got2xx(Y, [s5]), T.halt);
    expect(!(await h.obs(Y, [s4])).some(x => OK2XX.has(x.outcome)), `${Y} must never accept the skipped alert`);
    await h.waitFor(`${X} got both`, () => h.got2xx(X, [s4, s5]), T.deliver);
    return { skipped: s4, next_delivered: s5 };
  });

  gate('L', 'Durable Object restart (ingress redeploy) with a pending delivery: sequence continues, nothing lost', async (h, t) => {
    await t.pause(qX);
    let a, b, before, restart;
    try {
      a = await h.send('L');
      await h.waitFor(`${Y} accepts`, () => h.got2xx(Y, [a.seq]), T.deliver);
      before = (await h.stats()).counter;
      const dep0 = await t.deploymentId();
      await t.redeployIngress();
      const dep1 = await t.deploymentId();
      // Proof that the ingress (and so its Durable Object) was really replaced, not merely still up.
      expect(dep0 !== dep1 && dep1 !== null, `ingress deployment unchanged (${dep0} -> ${dep1}): no restart happened`);
      restart = { from: dep0, to: dep1 };
      await h.waitFor('ingress back after redeploy', async () => { try { return (await t.fetch(`${t.base.ingress}/`, { method: 'GET' })).status === 405; } catch { return false; } }, T.deliver);
      const after = await h.stats();
      expect(after.schema_version === 2 && after.counter === before, `counter ${before} -> ${after.counter}`);
      b = await h.send('L');
      expect(b.seq === before + 1, `sequence did not continue: ${before} -> ${b.seq}`);
    } finally { await t.resume(qX); }
    await h.waitFor(`${X} receives the pending and the new alert`, () => h.got2xx(X, [a.seq, b.seq]), T.halt);
    const so = strictOrder(await h.obs(X, [a.seq, b.seq]), [a.seq, b.seq]);
    expect(so.ok, 'order after restart');
    return { pending_across_restart: a.seq, first_after_restart: b.seq, deployment: restart };
  }, cloudOnly);

  gate('K', 'Transport outage longer than the 5-min redispatch lease: recovers without intervention', async (h, t) => {
    await t.pause(qX);
    let a;
    try {
      a = await h.send('K');
      await h.waitFor(`${Y} accepts`, () => h.got2xx(Y, [a.seq]), T.deliver);
      out.info('   waiting 6 min (longer than REDISPATCH_LEASE_MS = 5 min)…');
      await sleep(6 * 60 * 1000);
    } finally { await t.resume(qX); }
    await h.waitFor(`${X} delivers after the long outage`, () => h.got2xx(X, [a.seq]), T.halt);
    const o = await h.obs(X, [a.seq]);
    expect(o.filter(x => x.outcome === 'ACCEPTED').length === 1, 'accepted more than once');
    return { edge_seq: a.seq, observations: o.map(x => x.outcome) };
  }, { optional: !includeLong, cloudOnly: true });

  gate('BYTE', 'Byte-for-byte: every delivered body hashes to what was sent', async (h) => {
    let checked = 0;
    expect(h.sent.size > 0, 'no alert was sent in this run');
    for (const d of [X, Y]) {
      const r = await h.report(d);
      expect(r.digest_mismatches === 0, `${d}: ${r.digest_mismatches} digest mismatches`);
      const seen = new Set();
      for (const o of r.observations) {
        const s = h.sent.get(Number(o.edge_seq));
        if (!s) continue;
        expect(o.received_digest === s.sha, `${d} seq ${o.edge_seq}: received bytes differ from the bytes sent`);
        seen.add(Number(o.edge_seq)); checked++;
      }
      // Not vacuous: every alert of this run must have reached this receiver at least once.
      const missing = [...h.sent.keys()].filter(k => !seen.has(k));
      expect(missing.length === 0, `${d} never observed seq ${missing.join(',')}`);
    }
    return { alerts: h.sent.size, observations_checked: checked, digest_mismatches: 0 };
  });

  gate('RB', 'Rollback readiness: every destination drained, no halt, gate ok:true', async (h) => {
    await h.waitFor('all destinations drained', async () => {
      const s = await h.stats();
      return [X, Y].every(d => s.destinations[d].unresolved === 0 && s.destinations[d].halted_seq === null);
    }, T.halt);
    const r = await h.admin('GET', '/rollback-readiness');
    expect(r.status === 200 && r.body.ok === true && r.body.readiness.blockers.length === 0, `readiness ${r.status} ${JSON.stringify(r.body.readiness && r.body.readiness.blockers)}`);
    return { ok: true, blockers: [] };
  });

  return G;
}

/** Brings a dirty STAGING back to a clean baseline: skip halts (audited) and wait for drain. */
export async function repairStaging(t, secrets, ids) {
  const h = harness(t, secrets, 'repair');
  for (const id of ids) await h.control(id, 'ok');
  const s = await h.stats();
  for (const id of ids) {
    const d = s.destinations[id];
    if (d && d.halted_seq !== null) {
      const r = await h.admin('POST', '/skip', { edge_seq: d.halted_seq, destination_id: id, actor: 'kawa-edge-gates-repair', reason: 'STAGING repair before a gate run' });
      out.info(`repair: ${id} halt at ${d.halted_seq} -> skip (${r.status})`);
    }
  }
  await h.waitFor('staging drained', async () => { const x = await h.stats(); return ids.every(id => x.destinations[id].unresolved === 0); }, 600e3);
}

export async function runGates({ target, secrets, dests, all = dests, includeLong = false, evidenceDir, meta = {} }) {
  const [X, Y] = dests;
  const runId = crypto.randomBytes(4).toString('hex');
  const h = harness(target, secrets, runId);
  const gates = defineGates({ X, Y, all, includeLong, kind: target.kind });
  const results = [];
  let failed = null;
  const t0 = Date.now();
  const cleanupErrors = [];
  const cleanup = async () => {
    // Never leave STAGING paused or scripted, whatever happened. 'ok' keeps the evidence ledger.
    for (const d of [X, Y]) {
      try { await target.resume(names.queue('staging', d)); } catch (err) { cleanupErrors.push(`resume ${d}: ${redact(err.message)}`); }
      try { await h.control(d, 'ok'); } catch (err) { cleanupErrors.push(`receiver ${d}: ${redact(err.message)}`); }
    }
  };
  const onSignal = (sig) => { out.warn(`${sig}: restoring STAGING (resuming queues) before exit…`); cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  out.step(`STAGING gates · target=${target.kind} · destinations ${X}, ${Y} · run ${runId}`);
  try {
    for (const g of gates) {
      if (failed) { results.push({ id: g.id, title: g.title, status: 'NOT_RUN' }); continue; }
      if (g.cloudOnly && target.kind !== 'cloud') { results.push({ id: g.id, title: g.title, status: 'CLOUD_ONLY', note: 'needs a Cloudflare platform operation; runs in ./kawa-edge install' }); out.info(`cloud ${g.id.padEnd(6)} ${g.title} (Cloudflare-only gate)`); continue; }
      if (g.optional) { results.push({ id: g.id, title: g.title, status: 'SKIPPED', note: 'long gate skipped (--quick): this run is PARTIAL and is not a STAGING PASS' }); out.warn(`skip  ${g.id} ${g.title} (--quick)`); continue; }
      const g0 = Date.now();
      try {
        const evidence = await g.run(h, target);
        results.push({ id: g.id, title: g.title, status: 'PASS', duration_ms: Date.now() - g0, evidence });
        out.ok(`${g.id.padEnd(6)} ${g.title} (${Math.round((Date.now() - g0) / 1000)} s)`);
      } catch (err) {
        failed = g.id;
        results.push({ id: g.id, title: g.title, status: 'FAIL', duration_ms: Date.now() - g0, error: redact(err.message), detail: err.detail });
        out.fail(`${g.id.padEnd(6)} ${g.title}: ${err.message}${err.detail ? ` (${err.detail})` : ''}`);
      }
    }
  } finally {
    await cleanup();
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  }
  for (const e of cleanupErrors) out.fail(`cleanup: ${e}`);
  // PASS: every gate this target can run passed and cleanup succeeded. A cloud run with a skipped gate
  // is PARTIAL (never a STAGING PASS); the local rehearsal never claims the CLOUD_ONLY gates.
  const ran = results.filter(r => r.status !== 'CLOUD_ONLY');
  const result = failed || cleanupErrors.length ? 'FAIL' : ran.every(r => r.status === 'PASS') ? 'PASS' : 'PARTIAL';
  const report = { schema: 'kawa.edge.staging.gates.v1', result, target: target.kind, run_id: runId, cleanup_errors: cleanupErrors,
                   mandatory_gates: gates.filter(g => target.kind === 'cloud' || !g.cloudOnly).map(g => g.id),
                   started: new Date(t0).toISOString(), duration_s: Math.round((Date.now() - t0) / 1000),
                   destinations: [X, Y], ...meta, gates: results };
  fs.mkdirSync(evidenceDir, { recursive: true });
  const file = path.join(evidenceDir, `staging-gates-${target.kind}-${new Date(t0).toISOString().replace(/[:.]/g, '-')}-${result}.json`);
  fs.writeFileSync(file, redact(JSON.stringify(report, null, 2)));
  return { result, report, file };
}
