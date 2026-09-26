# KAWA VECTOR · EDGE SIGNAL BUFFER V1.3.0 — ARQUITECTURA MULTI-DESTINO

**Identidad:** `edge-signal-buffer-v1.3.0-staging` · **Linaje:** V1.3.0 ← V1.2.3 STAGING FROZEN
**Estado:** CANDIDATE para auditoría independiente. **NO DESPLEGADO. NO PROD.**

Fuera de alcance y sin tocar: KAWA Execution Platform, el Hub operativo, TradingView PROD y el Edge
desplegado si lo hubiera.

---

## 1. Qué cambia respecto de V1.2.3

```
V1.2.3    TradingView → Edge → 1 señal persistida → 1 estado de entrega → 1 Hub
V1.3.0    TradingView → Edge → 1 señal persistida → N estados de entrega → N Hubs aislados
```

La frontera de aceptación no cambia: **una transacción SQLite** asigna la secuencia, persiste los
bytes y crea las filas de entrega de todos los destinos habilitados; solo entonces el ingress
responde 202 a TradingView. `queue.send()` sigue sin formar parte de ese criterio.

```
TradingView
   │ POST /webhook/<TOKEN>
   ▼
Ingress Worker ──accept()──► Sequencer DO (SQLite, singleton)
   │ 202 BUFFERED                 │  signals:    el body UNA vez
   │                              │  deliveries: (edge_seq, destination_id)
   │                              ▼
   │                   fan-out: una cola POR destino
   │            ┌───────────────────────┬───────────────────────┐
   │            ▼                       ▼                       ▼
   │   queue hub-a-stg          queue hub-b-stg          queue hub-N-stg
   │            │                       │                       │
   │   consumer HUB_A            consumer HUB_B           consumer HUB_N
   │   claim(N,'HUB_A')          claim(N,'HUB_B')                │
   ▼            ▼                       ▼                       ▼
        KAWA Hub A / Lighter A   KAWA Hub B / Lighter B    Hub N / Lighter N
```

## 2. El invariante, ahora por destino

> «Recibí A antes que B, así que **cada** destino recibirá A antes que B.»

Cada destino tiene su **propia cabeza** (`next_seq_expected:<dest>`), su propio halt, su propio lease
de single-flight, su propia cola, su propia DLQ y su propia credencial. HUB_A puede ir por delante de
HUB_B; ninguno puede ver B antes que A. Un destino caído, detenido o con credencial rechazada no
bloquea, retrasa ni duplica a otro.

**Cloudflare no es autoridad de trading.** El Edge no interpreta LONG/SHORT, ENTRY/EXIT, sizing,
leverage, stop, TTL ni lifecycle; no lee el body salvo para medir su tamaño; y **nunca propaga estado
de trading entre Hubs**. Un SAFE HALT o WRITE LOCK en HUB_A es asunto de HUB_A y su cuenta Lighter.

## 3. Persistencia (esquema 2)

| Tabla | Contenido |
|---|---|
| `signals` | `edge_seq` (PK), `body` BLOB, `digest`, `content_type`, `edge_received_ms`. **El body se guarda una sola vez, sin duplicar por destino.** |
| `deliveries` | PK `(edge_seq, destination_id)`: `delivery_id`, `state`, `dispatch_attempts`, `delivery_attempt`, `lease_token`, `lease_until`, `halt_reason`, `last_error`, `first_received_ms`, `last_attempt_ms`, `resolved_ms` |
| `meta` | `counter`, `next_seq_expected:<dest>`, `halted_seq:<dest>`, `schema_version` |
| `admin_log` | auditoría de decisiones humanas, con `destination_id` |

La cola sigue siendo **transporte, nunca fuente de verdad**: el sobre (`kawa.edge.v3`) lleva
`edge_seq`, `destination_id`, `delivery_id` y `digest`; los bytes se leen del BLOB en el momento de
entregar, así que el contrato byte a byte no depende de la serialización de la cola.

### Estados de una entrega

| Estado | Significado | ¿Bloquea a ese destino? |
|---|---|---|
| `PENDING_DISPATCH` | pendiente de publicar en su cola | sí, hasta entregarse |
| `DISPATCHED` | en cola, esperando turno | sí, hasta entregarse |
| `DELIVERED` | el Hub confirmó aceptación durable | no, avanza |
| `FAILED_PERMANENT` | fallo permanente de **ese** destino (4xx permanente, 401/403 incluidos) | sí para ese destino, hasta decisión humana |
| `ADMIN_SKIPPED` | hueco cerrado por un humano y auditado | no, se salta con registro |
| `DISABLED_SKIPPED` | el destino se deshabilitó con la entrega aún debida; resuelta de forma durable y auditada | no, se salta con registro |

**Resuelto no es lo mismo que avanzable.** Un `FAILED_PERMANENT` está resuelto a efectos de
retención, pero **retiene la línea** de ese destino hasta que un humano decide `retry` o `skip`:
dejar que la cabeza lo sobrepase entregaría el resto de una cadena causal rota. Solo `DELIVERED`,
`ADMIN_SKIPPED` y `DISABLED_SKIPPED` hacen avanzar la cabeza.

**Un solo nombre terminal.** `classify()` devuelve `FAILED_PERMANENT`; el consumer registra el fallo
en la **cola** DLQ de ese destino y el sequencer escribe el estado `FAILED_PERMANENT`. No existe un
estado `DEAD_LETTER`: `DISPOSITION.DEAD_LETTER` es un alias deprecado **del mismo valor**, conservado
solo para que llamadas y tests de V1.2.3 sigan resolviendo. «DLQ» nombra únicamente el recurso de
cola donde se deja constancia del fallo.

## 4. Identidad e idempotencia

- El `signal_id` de TradingView **viaja intacto dentro del body** hacia cada Hub. El Edge no lo lee y
  nunca lo reescribe.
- `delivery_id = E<edge_seq>:<destination_id>`, determinista. Es metadata de transporte y **nunca
  sustituye** a `signal_id`, `event_ms` ni `order_id`.
- El Edge **no deduplica identidad de trading**: si TradingView repite el POST, transporta ambas
  copias con el mismo `signal_id` y es cada Hub quien deduplica. La autoridad de dedupe es del Hub,
  y esa deduplicación es una **barrera adicional**, nunca el mecanismo operativo primario: los
  procedimientos (rollback incluido) se diseñan para no producir residuos que dependan de ella.
- Semántica **at-least-once**: una repetición de transporte es aceptable; un reordenamiento no.
- Cabeceras añadidas (solo correlación, la admisión del Hub nunca depende de ellas): `x-edge-seq`,
  `x-edge-digest`, `x-edge-destination`, `x-edge-delivery-id`, `x-edge-attempt`,
  `x-edge-first-received-ms`.

## 5. Política de fallos

| Respuesta del Hub | Resultado |
|---|---|
| 2xx con `QUEUED`/`ACCEPTED` | `DELIVERED`, avanza la cabeza de ese destino |
| 2xx con duplicado reconocido | idem, sin reenviar |
| 2xx no reconocido | retry: un 2xx sin confirmación no prueba aceptación durable |
| `429` | retry con backoff |
| 4xx explícitamente transitorio (`408`, `423`, `425`, o el Hub declara `retryable`/`RETRY`) | retry con backoff |
| **`401` / `403`** | **`FAILED_PERMANENT` de ese destino + notificación al operador. Tiene PRECEDENCIA: se evalúa antes que cualquier `retryable:true` o `code:"RETRY"` del body, porque esa pista viene del mismo Hub que rechaza la credencial** |
| Resto de 4xx | `FAILED_PERMANENT` de ese destino |
| 5xx, red, timeout | retry con backoff |

Reintentar para siempre una credencial rechazada era un fallo silencioso: la alerta no llegaba y
nadie se enteraba. Ahora ese destino se detiene, se avisa y los demás siguen.

## 6. Dos reglas explícitas

1. **Sin histórico al añadir un destino.** La cabeza de un destino nace con su primera entrega
   debida. Un destino configurado hoy empieza en la siguiente señal aceptada; hacer backfill sería
   una decisión de trading y el Edge no las toma.
2. **Sin destino implícito en multi-destino.** El destino implícito existe solo en la configuración
   legacy de un único destino. Con varios configurados, `claim`, `delivered`, `haltedDlq` y
   `adminResume` rechazan la llamada con `DESTINATION_ID_REQUIRED`. `stats()` es la excepción
   deliberada: es lectura global, nunca exige destino y devuelve `null` en los campos con forma de
   V1.2.3 en lugar de inventar a quién describen.

## 6-bis. Ciclo de vida de un destino y configuración válida

**Un destino deshabilitado deja de retener.** Su cabeza se reconcilia sobre las secuencias que nunca
se le debieron, de modo que no fija la frontera global de GC mientras los demás Hubs operan. Esa
reconciliación no sobrepasa nunca una entrega realmente pendiente, un `FAILED_PERMANENT` ni un halt.

**`enabled`, si aparece, es booleano estricto.** `"false"`, `0` y `null` son configuración inválida,
no un destino habilitado por coerción: la aceptación falla cerrada con 503.

**La autoridad sobre enabled/disabled es el Sequencer**, no los consumers. Al deshabilitar un
destino, sus entregas pendientes las resuelve el propio DO —al despachar y en el torniquete— como
`DISABLED_SKIPPED` durable y auditado, y **no publica nada a su cola**. No depende de que su
consumer esté desplegado, actualizado o siquiera disponible: si su copia de `DESTINATIONS` estuviera
obsoleta, no hay entrega que entregar. El chequeo equivalente en el consumer queda como **defensa
secundaria**. Mientras esté
deshabilitado no se crean filas nuevas, no hay redispatch y no retiene señales. Al rehabilitarlo, su
cabeza se reconcilia sobre los huecos del periodo apagado, de modo que **la primera señal posterior
se entrega con normalidad**, sin espera eterna.

**Configuración inválida = fallo cerrado.** `timeout_ms`, `base_delay_s`, `backpressure_delay_s` y
`max_delay_s` se validan al cargar: finitos, no negativos y dentro de rangos operativos
(`LIMITS` en `src/destinations.js`); un techo por debajo del suelo también se rechaza. Con una
configuración inválida, la aceptación falla cerrada con 503 y **no** se acepta la alerta; nunca se
degrada en un reintento infinito. La observabilidad (`stats()`) sigue respondiendo con lo que hay en
el almacenamiento, para poder diagnosticar precisamente esa situación.

## 7. Retención (GC)

Una señal nunca se borra mientras **algún** destino le deba una entrega. Esa es la regla, y las
demás son matices suyos.

- **La entrega que falló de forma permanente** está resuelta: ya no se le debe, y su frontera de
  retención pasa por encima de esa secuencia concreta. Eso evita que una única secuencia fallida
  ancle la retención por sí sola.
- **El backlog posterior de ese mismo destino NO se recolecta.** Mientras el halt no se resuelva con
  `retry` o `skip`, las señales que llegaron después le siguen debiéndose: sus filas están
  pendientes, la frontera no pasa de ellas y las señales se conservan **durables**. Un halt
  desatendido conserva su backlog; lo que no hace es anclarlo la secuencia ya fallida.
- **Un destino simplemente caído** retiene igual: todavía se le debe esa entrega.
- **Un destino deshabilitado** deja de retener, porque sus entregas se resuelven
  (`DISABLED_SKIPPED`) y no se le crean nuevas (F-02B).

Los demás Hubs nunca quedan atrapados por ninguno de estos casos: la frontera global es el mínimo de
las fronteras, y cada destino avanza la suya de forma independiente.

## 7-bis. Filas legacy y gate de rollback

Tras la migración, las filas de V1.2.3 siguen existiendo en `outbox`, que es **lo que leería V1.2.3
si se volviera atrás**. Por eso la resolución de una fila migrada (solo del destino legacy) se
refleja en `outbox.state` y `resolved_ms`; el cuerpo, el digest y la marca de recepción quedan
intactos, así que la tabla sigue siendo evidencia de la migración: lo único que se reescribe en ella
es `state` y `resolved_ms` de una fila ya migrada del destino legacy. `rollbackReadiness()` —expuesto
como `GET /rollback-readiness`— devuelve `ok: true` solo cuando ningún destino tiene entregas
pendientes ni halt, y **ninguna fila legacy de `outbox` sigue sin resolver**. Así el rollback no
depende de la deduplicación del Hub, que es una barrera, no el mecanismo.

## 8. Seguridad

- Una credencial por destino: `DEST_<ID>_WEBHOOK_URL`, enlazada **solo** en el consumer de ese
  destino. El Worker de HUB_B no tiene binding alguno con el secreto de HUB_A.
- `CONSUMER_DESTINATION_ID` fija el destino de cada despliegue: un sobre de otro destino se rechaza
  en vez de entregarse con la credencial equivocada.
- Los logs redactan cualquier campo cuyo nombre contenga `token`, `secret` o `url`; ni `stats()` ni
  la traza por señal devuelven credenciales. Hay un test que lo comprueba con secretos plantados.
- Cloudflare nunca guarda claves privadas de Lighter ni `hub_admin_token`.

## 9. Compatibilidad hacia atrás

Sin la var `DESTINATIONS`, el registro devuelve un único destino cableado a los bindings de V1.2.3
(`SIGNAL_QUEUE`, `DLQ`, `KAWA_WEBHOOK_URL`, `KAWA_FETCHER`) y el comportamiento es el de V1.2.3. La
prueba es que **41 de los 42 tests de V1.2.3 pasan sin modificación** contra el motor multi-destino;
el único actualizado lo fue por el cambio de política de 401/403, documentado dentro del propio test.

## 10. Qué NO trae esta release

Copy trading, sizing centralizado, ratios por cuenta, distribución de capital, transformación de
señales o de stops, orquestación entre Hubs, UI multi-cuenta, y cualquier cambio en KAWA o en
TradingView. Esto es **exclusivamente entrega durable multi-destino**.
