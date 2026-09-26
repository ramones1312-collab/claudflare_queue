/**
 * STAGING ADMIN WORKER · a temporary, deletable surface for the infrastructure gates.
 *
 * It exists so gates I and J (admin retry / ADMIN_SKIPPED) can be exercised on real Cloudflare
 * without putting an administrative endpoint on the ingress. It is deliberately separate so it can
 * be deleted the moment the STAGING gate closes, leaving no trace on the production shape.
 *
 * Scope, and nothing beyond it: `stats`, `retry`, `skip`.
 * It cannot accept an alert, cannot publish to the queue and cannot reach KAWA.
 *
 * NOT FOR PRODUCTION. Delete with `wrangler delete --name kawa-edge-admin-stg` after the gate.
 */
function timingSafeEqual(a, b) {
  const x = String(a ?? ''), y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function json(status, payload) {
  return new Response(JSON.stringify(payload, null, 2),
    { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    // --- authentication --------------------------------------------------------------
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!env.ADMIN_TOKEN || !timingSafeEqual(env.ADMIN_TOKEN, token)) {
      // Generic: an unset token must not be distinguishable from a wrong one.
      console.log(JSON.stringify({ event: 'ADMIN_AUTH_REJECTED' }));
      return json(404, { ok: false, code: 'NOT_FOUND' });
    }

    const url = new URL(request.url);
    const stub = env.SEQUENCER.get(env.SEQUENCER.idFromName('kawa-vector-global-stream'));

    if (request.method === 'GET' && url.pathname === '/stats') {
      return json(200, { ok: true, stats: await stub.stats() });
    }

    // V1.3.0 · "what happened to this alert?", per destination: state, attempts, last error.
    // F-05 · gate de rollback: solo procede con ok:true.
    if (request.method === 'GET' && url.pathname === '/rollback-readiness') {
      const out = await stub.rollbackReadiness();
      return json(out.ok ? 200 : 409, { ok: out.ok, readiness: out });
    }

    if (request.method === 'GET' && url.pathname === '/signal') {
      const seq = Number(url.searchParams.get('edge_seq'));
      if (!Number.isInteger(seq) || seq < 1) return json(400, { ok: false, code: 'BAD_EDGE_SEQ' });
      return json(200, { ok: true, signal: await stub.signalStatus(seq) });
    }

    if (request.method === 'POST' && (url.pathname === '/retry' || url.pathname === '/skip')) {
      let body = {};
      try { body = await request.json(); } catch { return json(400, { ok: false, code: 'BAD_JSON' }); }
      const action = url.pathname.slice(1);
      const seq = Number(body.edge_seq);
      if (!Number.isInteger(seq) || seq < 1) return json(400, { ok: false, code: 'BAD_EDGE_SEQ' });
      if (!String(body.actor || '').trim()) return json(400, { ok: false, code: 'ACTOR_REQUIRED' });
      if (!String(body.reason || '').trim()) return json(400, { ok: false, code: 'REASON_REQUIRED' });

      // V1.2.2 F4 · `force` is NOT exposed over HTTP. The gates only need retry/skip of the
      // CURRENT halt, and an internet-facing forced override is more power than this surface should
      // carry. The capability still exists internally for a documented emergency, reachable only by
      // RPC from a Worker of this project.
      if ('force' in body) return json(400, { ok: false, code: 'FORCE_NOT_ALLOWED_OVER_HTTP' });

      // V1.3.0 · an administrative action names ITS destination. With several configured there is no
      // implicit one: resuming the wrong Hub's stream is exactly the mistake this refuses to allow.
      // Omitting it stays valid only for the single-destination (V1.2.3) configuration.
      const destinationId = String(body.destination_id || '').trim().toUpperCase();
      let out;
      try {
        out = await stub.adminResume(action, seq, String(body.actor), String(body.reason),
                                     destinationId ? { destination_id: destinationId } : {});
      } catch (err) {
        if (String(err && err.message || err).includes('DESTINATION_ID_REQUIRED')) {
          return json(400, { ok: false, code: 'DESTINATION_ID_REQUIRED' });
        }
        throw err;
      }
      console.log(JSON.stringify({ event: 'ADMIN_ACTION', action, edge_seq: seq,
                                   destination_id: destinationId || null,
                                   actor: String(body.actor), ok: out.ok, code: out.code || null }));
      return json(out.ok ? 200 : 409, out);
    }

    return json(404, { ok: false, code: 'NOT_FOUND' });
  },
};
