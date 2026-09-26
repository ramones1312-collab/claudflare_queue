/**
 * V1.3.0 · R1/R2 — REMEDIACIÓN DE LA AUDITORÍA INDEPENDIENTE DEL CANDIDATO V1.3.0.
 * La identidad del artefacto NO cambia: sigue siendo `edge-signal-buffer-v1.3.0-staging`.
 *
 *   F-01 P1 · 401/403 son permanentes SIEMPRE, por encima de cualquier pista de reintento del body
 *   F-02 P1 · ciclo de vida disable/re-enable de un destino, sin entregas en limbo ni WAIT eterno
 *   F-03 P2 · validación de DESTINATIONS: falla cerrada, nunca retry infinito
 *   F-05    · gate de rollback y espejo de resolución en las filas legacy migradas
 */
import { describe, it, expect } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { classify, DISPOSITION } from '../src/consumer.js';
import { allDestinations, LIMITS } from '../src/destinations.js';
import { newFanout, boot, accept, drain, OK_QUEUED } from './_fanout.js';
import producer from '../src/producer.js';

const ALERT = (tag) => JSON.stringify({ signal_id: 'sig-' + tag, tag });

describe('F-01 · 401/403 tienen precedencia sobre cualquier pista de reintento', () => {
  it('401 con retryable:true sigue siendo FAILED_PERMANENT', () => {
    const out = classify(401, { ok: false, retryable: true, code: 'RETRY' });
    expect(out.disposition).toBe(DISPOSITION.FAILED_PERMANENT);
    expect(out.reason).toBe('AUTH_REJECTED_401');
  });

  it('403 con code:"RETRY" sigue siendo FAILED_PERMANENT', () => {
    const out = classify(403, { ok: false, code: 'RETRY' });
    expect(out.disposition).toBe(DISPOSITION.FAILED_PERMANENT);
    expect(out.reason).toBe('AUTH_REJECTED_403');
  });

  it('ninguna variante de pista convierte un rechazo de credencial en reintento', () => {
    const hints = [{ retryable: true }, { code: 'TRY_AGAIN' }, { code: 'TEMPORARILY_UNAVAILABLE' },
                   { code: 'WARMING_UP' }, { retryable: true, code: 'RETRY' }, null];
    for (const status of [401, 403]) {
      for (const payload of hints) {
        expect(classify(status, payload).disposition).toBe(DISPOSITION.FAILED_PERMANENT);
      }
    }
    // Y lo que sí es transitorio sigue siéndolo: la precedencia no se comió las demás ramas.
    expect(classify(429, { code: 'RETRY' }).disposition).toBe(DISPOSITION.RETRY);
    expect(classify(400, { retryable: true }).disposition).toBe(DISPOSITION.RETRY);
    expect(classify(400, null).disposition).toBe(DISPOSITION.FAILED_PERMANENT);
  });

  it('extremo a extremo: un 401 con retryable:true detiene ese destino y no al otro', async () => {
    const script = { HUB_A: () => ({ status: 401, body: { ok: false, retryable: true, code: 'RETRY' } }) };
    const w = await boot(newFanout(['HUB_A', 'HUB_B'], { script }));
    const out = await accept(w, 'F1', ALERT('F1'));
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B');
    const byId = Object.fromEntries((await w.stub().statusForTest(out.edge_seq))
      .deliveries.map(d => [d.destination_id, d]));
    expect(byId.HUB_A.state).toBe('FAILED_PERMANENT');
    expect(byId.HUB_A.halt_reason).toBe('AUTH_REJECTED_401');
    expect(byId.HUB_B.state).toBe('DELIVERED');
    expect(w.dlq.HUB_A.length).toBe(1);        // registrado, no reintentado para siempre
  });
});

describe('F-02 · ciclo de vida disable / re-enable de un destino', () => {
  /** Cambia la configuración vista por el DO y por los workers. */
  async function reconfigure(w, entries) {
    const json = JSON.stringify(entries);
    await w.stub().setDestinationsForTest({ ...w.cfg, DESTINATIONS: json });
    w.cfg = { ...w.cfg, DESTINATIONS: json };
    w.env = { ...w.env, DESTINATIONS: json };
  }

  it('ACTIVE → DISABLED con entregas pendientes: se resuelven, auditadas, sin limbo', async () => {
    const w = await boot(newFanout());
    w.down.HUB_B = true;
    const one = await accept(w, 'D1', ALERT('D1'));
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B', 2);
    expect((await w.stub().stats()).destinations.HUB_B.unresolved).toBe(1);

    await reconfigure(w, [{ id: 'HUB_A' }, { id: 'HUB_B', enabled: false }]);
    w.down.HUB_B = false;
    await drain(w, 'HUB_B');                    // el consumer resuelve en vez de ackear en limbo

    const byId = Object.fromEntries((await w.stub().statusForTest(one.edge_seq))
      .deliveries.map(d => [d.destination_id, d]));
    expect(byId.HUB_B.state).toBe('DISABLED_SKIPPED');
    expect(byId.HUB_B.resolved_ms).toBeTruthy();
    expect(w.received.HUB_B).toEqual([]);       // deshabilitado: no recibe nada
    const s = await w.stub().stats();
    expect(s.destinations.HUB_B.unresolved).toBe(0);
    expect(s.destinations.HUB_B.next_seq_expected).toBe(one.edge_seq + 1);
  });

  it('señales aceptadas mientras está DISABLED no crean entrega ni retienen nada', async () => {
    const w = await boot(newFanout());
    await reconfigure(w, [{ id: 'HUB_A' }, { id: 'HUB_B', enabled: false }]);
    const during = [];
    for (const t of ['W1', 'W2']) during.push(await accept(w, t, ALERT(t)));
    await drain(w, 'HUB_A');

    for (const a of during) {
      const ids = (await w.stub().statusForTest(a.edge_seq)).deliveries.map(d => d.destination_id);
      expect(ids).toEqual(['HUB_A']);           // ni una fila para el destino deshabilitado
    }
    expect(await w.stub().queuedForTest('HUB_B')).toEqual([]);   // ni un redispatch
    const s = await w.stub().stats();
    expect(s.destinations.HUB_B.unresolved).toBe(0);
  });

  it('DISABLED → ENABLED: la primera señal posterior se entrega, sin WAIT eterno', async () => {
    const w = await boot(newFanout());
    w.down.HUB_B = true;
    await accept(w, 'P0', ALERT('P0'));                       // queda debiéndose a HUB_B
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B', 2);

    await reconfigure(w, [{ id: 'HUB_A' }, { id: 'HUB_B', enabled: false }]);
    w.down.HUB_B = false;
    await drain(w, 'HUB_B');                                  // resuelve lo pendiente
    await accept(w, 'P1', ALERT('P1'));                       // aceptada estando deshabilitado
    await drain(w, 'HUB_A');

    await reconfigure(w, [{ id: 'HUB_A' }, { id: 'HUB_B', enabled: true }]);
    const after = await accept(w, 'P2', ALERT('P2'));          // primera señal tras rehabilitar
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B');

    expect(w.received.HUB_B.map(b => JSON.parse(b).tag)).toEqual(['P2']);
    const s = await w.stub().stats();
    expect(s.destinations.HUB_B.next_seq_expected).toBe(after.edge_seq + 1);
    expect(s.destinations.HUB_B.unresolved).toBe(0);
    // Y HUB_A, ajeno a todo el ciclo, entregó las tres.
    expect(w.received.HUB_A.map(b => JSON.parse(b).tag)).toEqual(['P0', 'P1', 'P2']);
  });

  it('un destino deshabilitado no provoca redispatch infinito ni retención', async () => {
    const w = await boot(newFanout());
    w.down.HUB_B = true;
    const one = await accept(w, 'R0', ALERT('R0'));
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B', 2);
    await reconfigure(w, [{ id: 'HUB_A' }, { id: 'HUB_B', enabled: false }]);
    w.down.HUB_B = false;
    await drain(w, 'HUB_B');

    // Varias pasadas de alarma después, no hay nada que republicar para ese destino.
    for (let i = 0; i < 3; i++) {
      await w.stub().forceDispatchDue(one.edge_seq);
      await w.stub().alarmForTest();
    }
    expect(await w.stub().queuedForTest('HUB_B')).toEqual([]);
    // Y deja de retener: su frontera de retención ya pasó la secuencia resuelta.
    expect(await w.stub().gcFrontierForTest('HUB_B')).toBe(one.edge_seq + 1);
  });
});

describe('F-03 · validación de DESTINATIONS, fallo cerrado', () => {
  const cases = [
    ['timeout no finito', '[{"id":"HUB_A","timeout_ms":"abc"}]', 'DESTINATION_TIMEOUT_MS_NOT_FINITE'],
    ['timeout negativo', '[{"id":"HUB_A","timeout_ms":-1}]', 'DESTINATION_TIMEOUT_MS_NEGATIVE'],
    ['timeout fuera de rango', '[{"id":"HUB_A","timeout_ms":999999}]', 'DESTINATION_TIMEOUT_MS_OUT_OF_RANGE'],
    ['base_delay_s no finito', '[{"id":"HUB_A","retry":{"base_delay_s":"x"}}]', 'DESTINATION_BASE_DELAY_S_NOT_FINITE'],
    ['base_delay_s negativo', '[{"id":"HUB_A","retry":{"base_delay_s":-5}}]', 'DESTINATION_BASE_DELAY_S_NEGATIVE'],
    ['backpressure fuera de rango', '[{"id":"HUB_A","retry":{"backpressure_delay_s":99999}}]', 'DESTINATION_BACKPRESSURE_DELAY_S_OUT_OF_RANGE'],
    ['max_delay_s = 0', '[{"id":"HUB_A","retry":{"max_delay_s":0}}]', 'DESTINATION_MAX_DELAY_S_OUT_OF_RANGE'],
    ['max por debajo de base', '[{"id":"HUB_A","retry":{"base_delay_s":100,"max_delay_s":10}}]', 'DESTINATION_MAX_DELAY_BELOW_BASE'],
    ['Infinity', '[{"id":"HUB_A","timeout_ms":1e999}]', 'DESTINATION_TIMEOUT_MS_NOT_FINITE'],
  ];

  it('cada valor inválido se rechaza con su código', () => {
    for (const [label, cfg, code] of cases) {
      let err = null;
      try { allDestinations({ DESTINATIONS: cfg }); } catch (e) { err = e; }
      expect(err, label).toBeTruthy();
      expect(err.code, label).toBe(code);
    }
  });

  it('los límites son explícitos y la configuración válida pasa', () => {
    expect(LIMITS.timeout_ms.min).toBeGreaterThan(0);
    const ok = allDestinations({ DESTINATIONS: '[{"id":"HUB_A","timeout_ms":250,"retry":{"base_delay_s":1,"max_delay_s":86400}}]' });
    expect(ok[0].timeout_ms).toBe(250);
    expect(ok[0].retry.max_delay_s).toBe(86400);
  });

  it('con configuración inválida el ingress falla cerrado: 503, nada aceptado', async () => {
    const w = await boot(newFanout(['HUB_A']));
    const badEnv = { ...w.env, DESTINATIONS: '[{"id":"HUB_A","timeout_ms":-1}]' };
    await w.stub().setDestinationsForTest({ ...w.cfg, DESTINATIONS: '[{"id":"HUB_A","timeout_ms":-1}]' });
    const ctx = createExecutionContext();
    const res = await producer.fetch(
      new Request('https://edge.test/webhook/test-path-token', { method: 'POST', body: ALERT('B1') }),
      badEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(503);                       // ni 202 ni retry infinito
    expect((await res.json()).code).toBe('BUFFER_UNAVAILABLE');
    expect((await w.stub().stats()).counter).toBe(0);   // nada se aceptó
  });
});

describe('F-02 R2 · la autoridad de enabled/disabled vive en el Sequencer', () => {
  /** Deshabilita SOLO en el DO. El consumer conserva a propósito su copia vieja `enabled:true`. */
  async function disableOnlyInTheDO(w, id) {
    const json = JSON.stringify([{ id: 'HUB_A' }, { id, enabled: false }]);
    await w.stub().setDestinationsForTest({ ...w.cfg, DESTINATIONS: json });
    // w.env (la config del consumer Worker) se deja INTACTA: ese es justo el escenario auditado.
    return json;
  }

  it('DO con HUB_B disabled y consumer con config vieja: 0 POST al Hub', async () => {
    const w = await boot(newFanout());
    w.down.HUB_B = true;
    const one = await accept(w, 'S1', ALERT('S1'));      // entrega pendiente para HUB_B
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B', 2);
    expect((await w.stub().stats()).destinations.HUB_B.unresolved).toBe(1);

    await disableOnlyInTheDO(w, 'HUB_B');
    w.down.HUB_B = false;                                 // el Hub responde: si se le POSTea, recibe
    // El consumer sigue creyendo que HUB_B está habilitado.
    expect(JSON.parse(w.env.DESTINATIONS).find(d => d.id === 'HUB_B').enabled).not.toBe(false);
    await drain(w, 'HUB_B');

    expect(w.received.HUB_B).toEqual([]);                 // ni un POST
    const byId = Object.fromEntries((await w.stub().statusForTest(one.edge_seq))
      .deliveries.map(d => [d.destination_id, d]));
    expect(byId.HUB_B.state).toBe('DISABLED_SKIPPED');
    expect(byId.HUB_A.state).toBe('DELIVERED');           // HUB_A, intacto
  });

  it('pendiente + consumer apagado: el DO la resuelve solo, sin unresolved', async () => {
    const w = await boot(newFanout());
    w.down.HUB_B = true;
    const one = await accept(w, 'S2', ALERT('S2'));
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B', 2);

    await disableOnlyInTheDO(w, 'HUB_B');
    // Nadie drena la cola de HUB_B: su consumer está apagado o su cola no está disponible.
    await w.stub().forceDispatchDue(one.edge_seq);
    await w.stub().alarmForTest();

    const s = await w.stub().stats();
    expect(s.destinations.HUB_B.unresolved).toBe(0);
    expect(s.destinations.HUB_B.by_state.DISABLED_SKIPPED).toBe(1);
    expect(await w.stub().gcFrontierForTest('HUB_B')).toBe(one.edge_seq + 1);   // deja de retener
    expect(w.received.HUB_B).toEqual([]);
  });

  it('un sobre ya en vuelo tampoco pasa el torniquete con config vieja', async () => {
    const w = await boot(newFanout());
    const one = await accept(w, 'S3', ALERT('S3'));
    const pending = await w.stub().takeQueuedForTest('HUB_B');   // sobre ya publicado
    expect(pending.length).toBe(1);

    await disableOnlyInTheDO(w, 'HUB_B');
    const claim = await w.stub().claim(one.edge_seq, 'HUB_B');   // lo que haría el consumer viejo
    expect(claim.status).toBe('ALREADY_DELIVERED');
    expect(claim.disabled).toBe(true);
    expect(claim.body).toBeUndefined();                          // no entrega bytes que entregar
    const byId = Object.fromEntries((await w.stub().statusForTest(one.edge_seq))
      .deliveries.map(d => [d.destination_id, d]));
    expect(byId.HUB_B.state).toBe('DISABLED_SKIPPED');
    expect(byId.HUB_B.halt_reason).toBe('DESTINATION_DISABLED_AT_CLAIM');
  });

  it('al rehabilitar, la primera señal nueva se entrega y HUB_A nunca se vio afectado', async () => {
    const w = await boot(newFanout());
    w.down.HUB_B = true;
    await accept(w, 'S4', ALERT('S4'));
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B', 2);
    await disableOnlyInTheDO(w, 'HUB_B');
    w.down.HUB_B = false;
    await drain(w, 'HUB_B');
    await accept(w, 'S5', ALERT('S5'));                 // aceptada estando deshabilitado
    await drain(w, 'HUB_A');

    const json = JSON.stringify([{ id: 'HUB_A' }, { id: 'HUB_B', enabled: true }]);
    await w.stub().setDestinationsForTest({ ...w.cfg, DESTINATIONS: json });
    const after = await accept(w, 'S6', ALERT('S6'));
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B');

    expect(w.received.HUB_B.map(b => JSON.parse(b).tag)).toEqual(['S6']);
    expect(w.received.HUB_A.map(b => JSON.parse(b).tag)).toEqual(['S4', 'S5', 'S6']);
    const s = await w.stub().stats();
    expect(s.destinations.HUB_B.next_seq_expected).toBe(after.edge_seq + 1);
    expect(s.destinations.HUB_B.unresolved).toBe(0);
    expect(s.destinations.HUB_A.unresolved).toBe(0);
  });
});

describe('F-02B R3 · un destino deshabilitado no fija la frontera de GC', () => {
  it('su cabeza avanza sobre los huecos y deja de retener; HUB_A no queda atrapado', async () => {
    const w = await boot(newFanout());
    const first = await accept(w, 'G0', ALERT('G0'));
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B');       // HUB_B activo y entregado
    expect(w.received.HUB_B.length).toBe(1);

    // Se deshabilita HUB_B (autoridad en el DO) y siguen entrando señales solo para HUB_A.
    const off = JSON.stringify([{ id: 'HUB_A' }, { id: 'HUB_B', enabled: false }]);
    await w.stub().setDestinationsForTest({ ...w.cfg, DESTINATIONS: off });
    w.cfg = { ...w.cfg, DESTINATIONS: off }; w.env = { ...w.env, DESTINATIONS: off };

    const many = [];
    for (let i = 1; i <= 12; i++) many.push(await accept(w, 'G' + i, ALERT('G' + i)));
    await drain(w, 'HUB_A');

    const s = await w.stub().stats();
    expect(s.destinations.HUB_B.unresolved).toBe(0);
    expect(s.destinations.HUB_A.unresolved).toBe(0);
    const last = many[many.length - 1].edge_seq;
    // La cabeza de HUB_B avanza causalmente sobre secuencias que nunca se le debieron...
    expect(s.destinations.HUB_B.next_seq_expected).toBe(last + 1);
    // ...y por tanto su frontera de retención deja de fijar la global.
    expect(await w.stub().gcFrontierForTest('HUB_B')).toBe(last + 1);
    expect(await w.stub().gcFrontierForTest('HUB_A')).toBe(last + 1);

    // Con la frontera avanzada, las señales antiguas ya son recolectables (aquí, con lag 0).
    expect(await w.stub().collectableBelowForTest(last + 1)).toBeGreaterThan(0);
    expect(w.received.HUB_A.length).toBe(13);
    expect(w.received.HUB_B.length).toBe(1);                 // nada nuevo para el deshabilitado
    void first;
  });

  it('no salta pendientes reales, FAILED_PERMANENT ni halts', async () => {
    const w = await boot(newFanout(['HUB_A', 'HUB_B'],
      { script: { HUB_A: () => ({ status: 400, body: { ok: false } }) } }));
    const bad = await accept(w, 'H1', ALERT('H1'));
    w.down.HUB_B = true;
    await drain(w, 'HUB_A');                                  // HUB_A -> FAILED_PERMANENT
    await accept(w, 'H2', ALERT('H2'));
    await w.stub().alarmForTest();

    const s = await w.stub().stats();
    // La cabeza de HUB_A NO sobrepasa la secuencia fallida, y la de HUB_B no sobrepasa su pendiente.
    expect(s.destinations.HUB_A.next_seq_expected).toBe(bad.edge_seq);
    expect(s.destinations.HUB_A.halted_seq).toBe(bad.edge_seq);
    expect(s.destinations.HUB_B.next_seq_expected).toBe(bad.edge_seq);
    expect(await w.stub().gcFrontierForTest('HUB_B')).toBe(bad.edge_seq);
  });

  it('al rehabilitar, la primera señal nueva se entrega con normalidad', async () => {
    const w = await boot(newFanout());
    await accept(w, 'J0', ALERT('J0'));
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B');
    const off = JSON.stringify([{ id: 'HUB_A' }, { id: 'HUB_B', enabled: false }]);
    await w.stub().setDestinationsForTest({ ...w.cfg, DESTINATIONS: off });
    for (let i = 1; i <= 5; i++) await accept(w, 'J' + i, ALERT('J' + i));
    await drain(w, 'HUB_A');

    const on = JSON.stringify([{ id: 'HUB_A' }, { id: 'HUB_B', enabled: true }]);
    await w.stub().setDestinationsForTest({ ...w.cfg, DESTINATIONS: on });
    w.cfg = { ...w.cfg, DESTINATIONS: on }; w.env = { ...w.env, DESTINATIONS: on };
    const after = await accept(w, 'J9', ALERT('J9'));
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B');

    expect(w.received.HUB_B.map(b => JSON.parse(b).tag)).toEqual(['J0', 'J9']);
    expect((await w.stub().stats()).destinations.HUB_B.next_seq_expected).toBe(after.edge_seq + 1);
  });
});

describe('F-03B R3 · `enabled` debe ser booleano estricto', () => {
  const invalid = [['cadena "false"', '"false"'], ['cadena "true"', '"true"'], ['cero', '0'],
                   ['uno', '1'], ['null', 'null'], ['cadena arbitraria', '"yes"'],
                   ['objeto', '{}'], ['array', '[]']];

  it('cualquier tipo que no sea booleano invalida la configuración', () => {
    for (const [label, value] of invalid) {
      let err = null;
      try {
        allDestinations({ DESTINATIONS: `[{"id":"HUB_A"},{"id":"HUB_B","enabled":${value}}]` });
      } catch (e) { err = e; }
      expect(err, label).toBeTruthy();
      expect(err.code, label).toBe('DESTINATION_ENABLED_NOT_BOOLEAN');
    }
  });

  it('true, false y la ausencia del campo siguen siendo válidos', () => {
    const d = allDestinations({ DESTINATIONS: '[{"id":"HUB_A","enabled":true},{"id":"HUB_B","enabled":false},{"id":"HUB_C"}]' });
    expect(d.map(x => x.enabled)).toEqual([true, false, true]);
  });

  it('con `enabled:"false"` el ingress falla cerrado: 503 y ninguna señal aceptada', async () => {
    const w = await boot(newFanout(['HUB_A']));
    const bad = '[{"id":"HUB_A"},{"id":"HUB_B","enabled":"false"}]';
    await w.stub().setDestinationsForTest({ ...w.cfg, DESTINATIONS: bad });
    const ctx = createExecutionContext();
    const res = await producer.fetch(
      new Request('https://edge.test/webhook/test-path-token', { method: 'POST', body: ALERT('X') }),
      { ...w.env, DESTINATIONS: bad }, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('BUFFER_UNAVAILABLE');
    expect((await w.stub().stats()).counter).toBe(0);
  });
});

describe('F-04 R4 · DESTINATIONS presente pero vacío falla cerrado', () => {
  it('ausente = legacy de un destino; vacío, espacios o null = configuración inválida', () => {
    expect(allDestinations({}).length).toBe(1);                     // ausente: camino V1.2.3
    for (const [label, value] of [['cadena vacía', ''], ['espacios', '   '], ['tabulador', '\t'], ['null', null]]) {
      let err = null;
      try { allDestinations({ DESTINATIONS: value }); } catch (e) { err = e; }
      expect(err, label).toBeTruthy();
      expect(err.code, label).toBe('DESTINATIONS_PRESENT_BUT_EMPTY');
    }
    // Un array vacío tampoco es "legacy": es una configuración sin destinos.
    let err = null;
    try { allDestinations({ DESTINATIONS: '[]' }); } catch (e) { err = e; }
    expect(err.code).toBe('DESTINATIONS_EMPTY');
  });

  for (const [label, value] of [['cadena vacía', ''], ['espacios', '   ']]) {
    it(`el ingress responde 503 y no acepta nada con DESTINATIONS = ${label}`, async () => {
      const w = await boot(newFanout(['HUB_A']));
      await w.stub().setDestinationsForTest({ ...w.cfg, DESTINATIONS: value });
      const ctx = createExecutionContext();
      const res = await producer.fetch(
        new Request('https://edge.test/webhook/test-path-token', { method: 'POST', body: ALERT('E') }),
        { ...w.env, DESTINATIONS: value }, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe('BUFFER_UNAVAILABLE');
      expect((await w.stub().stats()).counter).toBe(0);
    });
  }
});

describe('F-05 R4 · timeout_ms presente se valida, nunca cae al default', () => {
  it('0, null, false y "" son inválidos, no 10000 por omisión', () => {
    const expected = { '0': 'DESTINATION_TIMEOUT_MS_OUT_OF_RANGE', 'null': 'DESTINATION_TIMEOUT_MS_NOT_FINITE',
                       'false': 'DESTINATION_TIMEOUT_MS_NOT_FINITE', '""': 'DESTINATION_TIMEOUT_MS_NOT_FINITE' };
    for (const [value, code] of Object.entries(expected)) {
      let err = null;
      try { allDestinations({ DESTINATIONS: `[{"id":"HUB_A","timeout_ms":${value}}]` }); } catch (e) { err = e; }
      expect(err, value).toBeTruthy();
      expect(err.code, value).toBe(code);
    }
    // Un valor válido se respeta y la ausencia sí cae al default.
    expect(allDestinations({ DESTINATIONS: '[{"id":"HUB_A","timeout_ms":5000}]' })[0].timeout_ms).toBe(5000);
    expect(allDestinations({ DESTINATIONS: '[{"id":"HUB_A"}]' })[0].timeout_ms).toBe(10000);
  });

  it('lo mismo para la política de retry presente con valores imposibles', () => {
    for (const cfg of ['{"base_delay_s":null}', '{"backpressure_delay_s":false}', '{"max_delay_s":""}']) {
      let err = null;
      try { allDestinations({ DESTINATIONS: `[{"id":"HUB_A","retry":${cfg}}]` }); } catch (e) { err = e; }
      expect(err, cfg).toBeTruthy();
      expect(err.code, cfg).toMatch(/NOT_FINITE$/);
    }
  });

  it('con timeout_ms: 0 el ingress falla cerrado y no acepta la señal', async () => {
    const w = await boot(newFanout(['HUB_A']));
    const bad = '[{"id":"HUB_A","timeout_ms":0}]';
    await w.stub().setDestinationsForTest({ ...w.cfg, DESTINATIONS: bad });
    const ctx = createExecutionContext();
    const res = await producer.fetch(
      new Request('https://edge.test/webhook/test-path-token', { method: 'POST', body: ALERT('T') }),
      { ...w.env, DESTINATIONS: bad }, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(503);
    expect((await w.stub().stats()).counter).toBe(0);
  });
});

describe('R21 · el backlog de un destino en FAILED_PERMANENT es durable hasta retry/skip', () => {
  it('las señales posteriores se le siguen debiendo y no se recolectan; los demás siguen', async () => {
    const w = await boot(newFanout(['HUB_A', 'HUB_B'],
      { script: { HUB_A: () => ({ status: 400, body: { ok: false } }) } }));
    const failed = await accept(w, 'B0', ALERT('B0'));
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B');
    expect((await w.stub().stats()).destinations.HUB_A.halted_seq).toBe(failed.edge_seq);

    // Siguen entrando señales: a HUB_A se le DEBEN, aunque esté detenido.
    const backlog = [];
    for (const tag of ['B1', 'B2', 'B3']) backlog.push(await accept(w, tag, ALERT(tag)));
    await drain(w, 'HUB_A'); await drain(w, 'HUB_B');

    for (let i = 0; i < 3; i++) { await w.stub().alarmForTest(); }   // GC corre en cada pasada
    const s = await w.stub().stats();
    expect(s.destinations.HUB_A.unresolved).toBe(3);                  // el backlog sigue vivo
    expect(s.destinations.HUB_A.next_seq_expected).toBe(failed.edge_seq);
    expect(s.destinations.HUB_B.unresolved).toBe(0);                  // el otro Hub, operando
    expect(w.received.HUB_B.length).toBe(4);
    for (const a of backlog) {
      const st = await w.stub().statusForTest(a.edge_seq);
      expect(st.received).toBe(true);                                 // la señal NO se recolectó
      expect(st.deliveries.find(d => d.destination_id === 'HUB_A').resolved_ms).toBeFalsy();
    }
    // Su frontera de retención no pasa del backlog pendiente.
    expect(await w.stub().gcFrontierForTest('HUB_A')).toBe(failed.edge_seq + 1);

    // Tras la decisión humana, el backlog se entrega en orden de origen.
    w.script.HUB_A = () => ({ status: 202, body: OK_QUEUED });
    await w.stub().adminResume('skip', failed.edge_seq, 'tester', 'contenido rechazado por el Hub',
                               { destination_id: 'HUB_A' });
    await drain(w, 'HUB_A');
    expect(w.received.HUB_A.map(b => JSON.parse(b).tag)).toEqual(['B0', 'B1', 'B2', 'B3']);
    expect((await w.stub().stats()).destinations.HUB_A.unresolved).toBe(0);
  });
});

describe('F-05 · gate de rollback y filas legacy migradas', () => {
  it('el gate bloquea mientras haya entregas pendientes o un destino detenido', async () => {
    const w = await boot(newFanout(['HUB_A', 'HUB_B'],
      { script: { HUB_A: () => ({ status: 400, body: { ok: false } }) } }));
    w.down.HUB_B = true;
    await accept(w, 'K1', ALERT('K1'));

    let gate = await w.stub().rollbackReadiness();
    expect(gate.ok).toBe(false);
    expect(gate.blockers.some(b => b.startsWith('UNRESOLVED:'))).toBe(true);

    await drain(w, 'HUB_A');                       // HUB_A falla permanentemente
    gate = await w.stub().rollbackReadiness();
    expect(gate.ok).toBe(false);
    expect(gate.blockers).toContain('HALTED:HUB_A:1');

    // Resolución explícita y auditada del incidente, más entrega del destino que estaba caído.
    await w.stub().adminResume('skip', 1, 'tester', 'rollback drill', { destination_id: 'HUB_A' });
    w.down.HUB_B = false;
    await drain(w, 'HUB_B');

    gate = await w.stub().rollbackReadiness();
    expect(gate.ok).toBe(true);
    expect(gate.blockers).toEqual([]);
  });

  it('el gate nombra la deduplicación del Hub como barrera, no como mecanismo', async () => {
    const w = await boot(newFanout(['HUB_A']));
    const gate = await w.stub().rollbackReadiness();
    expect(gate.gate).toBe('ROLLBACK_TO_V1_2_3');
    expect(gate.note).toMatch(/additional barrier, not the mechanism/);
    expect(gate).toHaveProperty('legacy_outbox_unresolved');
    expect(gate).toHaveProperty('migrated_max_seq');
  });

  it('la resolución de una fila migrada se refleja en outbox, que es lo que leería V1.2.3', async () => {
    const w = await boot(newFanout(['HUB_A']));
    // Simula el estado post-migración: una fila legacy pendiente con su espejo en deliveries.
    const seq = (await accept(w, 'L1', ALERT('L1'))).edge_seq;
    await w.stub().seedLegacyOutboxForTest(seq);
    let gate = await w.stub().rollbackReadiness();
    expect(gate.ok).toBe(false);
    expect(gate.legacy_outbox_unresolved).toContain(seq);   // V1.2.3 la reintentaría

    await drain(w, 'HUB_A');                                // se entrega en V1.3.0
    gate = await w.stub().rollbackReadiness();
    expect(gate.ok).toBe(true);
    expect(gate.legacy_outbox_unresolved).toEqual([]);      // el espejo la marcó resuelta
    // La evidencia del cuerpo no se toca: solo estado y marca de resolución.
    const legacy = await w.stub().legacyRowForTest(seq);
    expect(legacy.state).toBe('DELIVERED');
    expect(legacy.digest).toBe((await w.stub().statusForTest(seq)).digest);
  });
});
