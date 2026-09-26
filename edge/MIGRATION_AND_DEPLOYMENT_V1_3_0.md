# KAWA VECTOR · EDGE SIGNAL BUFFER V1.3.0 — MIGRACIÓN Y DESPLIEGUE

**NO DESPLEGAR durante el desarrollo.** Este documento describe el procedimiento para cuando la
auditoría independiente lo apruebe. V1.2.3 no se sobrescribe: sigue siendo un artefacto válido y el
camino de rollback.

---

## 1. Qué cambia en la infraestructura

| Recurso | V1.2.3 | V1.3.0 |
|---|---|---|
| Worker ingress | `kawa-edge-ingress-stg` | igual, ahora publica a N colas |
| Durable Object | `EdgeSequencer` (SQLite) | igual, esquema 2 (migración en sitio) |
| Cola de señales | `kawa-signal-buffer-stg` | **una por destino**: `kawa-signal-buffer-hub-a-stg`, `…-hub-b-stg` |
| DLQ | `kawa-signal-buffer-dlq-stg` | **una por destino**: `…-hub-a-dlq-stg`, `…-hub-b-dlq-stg` |
| Worker consumer | `kawa-edge-delivery-stg` | **uno por destino**: `kawa-edge-delivery-hub-a-stg`, `…-hub-b-stg` |
| Receptor STAGING | `kawa-staging-receiver` | igual |

No hay recursos que borrar para migrar: los nuevos se suman.

## 2. Migración de estado (automática, en sitio, una vez)

Al arrancar, el Durable Object detecta `schema_version < 2` y migra:

- cada fila de `outbox` pasa a `signals` (el body) más **una** fila en `deliveries` para el destino
  legacy, con su estado, intentos, lease y motivo de halt exactos;
- `next_seq_expected` y `halted_seq` globales pasan a ser los de ese destino;
- la tabla `outbox` **se conserva como evidencia** de la migración. Su contenido de evidencia -- cuerpo,
  digest, content type y marca de recepción -- no se toca nunca. Lo único que V1.3.0 vuelve a escribir
  en ella es el **estado de resolución** de una fila migrada (`state` y `resolved_ms`), y solo del
  destino legacy: es el espejo de rollback de F-05, sin el cual V1.2.3 leería un estado caducado.

Consecuencia operativa: **las entregas pendientes sobreviven a la migración** y siguen su curso con
la misma `edge_seq` y la misma identidad. El destino nuevo (HUB_B) **no recibe histórico**: empieza
en la siguiente señal aceptada.

## 3. Orden exacto de despliegue

1. **Crear las colas** (cuatro, con sufijo `-stg`):
   `kawa-signal-buffer-hub-a-stg`, `kawa-signal-buffer-hub-a-dlq-stg`,
   `kawa-signal-buffer-hub-b-stg`, `kawa-signal-buffer-hub-b-dlq-stg`.
2. **Desplegar el ingress**, que trae el sequencer y las colas productoras:
   `wrangler deploy --config wrangler.staging.toml`.
   Al arrancar, migra el esquema. Verifica en `/admin/stats` que `schema_version` es 2 y que aparece
   cada destino con su cabeza.
3. **Desplegar un consumer por destino**, uno cada vez:
   `wrangler deploy --config wrangler.consumer.hub-a.staging.toml`
   `wrangler deploy --config wrangler.consumer.hub-b.staging.toml`.
4. **Secretos**: `WEBHOOK_PATH_TOKEN` y `HALT_NOTIFY_URL` en el ingress. En STAGING los consumers no
   llevan secreto: el Service Binding fija el receptor. En PRODUCCIÓN, y solo ahí, cada consumer
   recibe **su propio** `DEST_<ID>_WEBHOOK_URL`. Nunca el mismo valor para dos Hubs.
5. **Verificar** con una alerta sintética: una sola entrada, dos entregas, mismo `signal_id`, dos
   `delivery_id` distintos.

Siempre con `--config` explícito. Nunca `wrangler deploy` sin él.

## 4. Añadir HUB_C más adelante

Sin tocar código:

1. Crear `kawa-signal-buffer-hub-c-stg` y `kawa-signal-buffer-hub-c-dlq-stg`.
2. Añadir `{"id":"HUB_C","enabled":true}` a la var `DESTINATIONS` (ingress y consumers) y el
   productor `DEST_HUB_C_QUEUE` en el config del ingress.
3. Copiar `wrangler.consumer.hub-a.staging.toml` cambiando id, colas, binding y secreto.
4. Desplegar ingress y luego el consumer de HUB_C.

HUB_C empieza en la siguiente señal aceptada. No recibe nada de lo anterior.

## 5. Deshabilitar o retirar un destino

`"enabled": false` en `DESTINATIONS` y **redesplegar el ingress**. Eso basta: la autoridad sobre
enabled/disabled vive en el Sequencer (el Durable Object del ingress), no en los consumers.

- Deja de crearse su fila de entrega para las señales nuevas.
- Sus entregas ya pendientes las resuelve el propio DO al despachar, como `DISABLED_SKIPPED`
  auditado, y **no se publica nada a su cola**.
- Un sobre que ya estuviera en vuelo tampoco pasa: el torniquete lo resuelve igual.
- **No hace falta redesplegar su consumer** para que esto ocurra, ni que esté encendido. Si conserva
  una copia vieja de `DESTINATIONS` diciendo `enabled:true`, no cambia nada: no hay entrega que
  hacer. El chequeo en el consumer permanece solo como defensa secundaria.

Conviene igualmente redesplegar o apagar su consumer cuando haya ocasión, por higiene. Retirar el
destino del todo es, además, borrar su consumer y sus colas.

## 6. Rollback a V1.2.3

El esquema 2 es aditivo y `outbox` se conserva, así que V1.2.3 vuelve a arrancar sobre el mismo
Durable Object leyendo su tabla original. Desde F-05, cuando V1.3.0 resuelve una entrega de una fila
**migrada** del destino legacy, refleja esa resolución en `outbox.state` y `resolved_ms`: V1.2.3 ve
el estado real, no el del momento de migrar. El cuerpo, el digest y la marca de recepción no se
tocan, así que la tabla sigue siendo evidencia de la migración.

Lo que **no** viaja a `outbox` son las entregas de destinos añadidos en V1.3.0 y las de señales
aceptadas después de migrar: V1.2.3 no las conoce ni las conocerá. Por eso el rollback se hace con
todo drenado y el gate en verde, y no apoyándose en la deduplicación del Hub.

**El rollback se hace con las colas vacías.** La deduplicación por `signal_id` de cada Hub es una
barrera adicional, no el mecanismo operativo para absorber residuos de un rollback.

### Procedimiento obligatorio, en este orden

1. **Detener la admisión nueva en el Edge.** Quitar la ruta del ingress o rotar
   `WEBHOOK_PATH_TOKEN`, de modo que TradingView deje de poder entregar alertas nuevas. A partir de
   aquí no entra nada al buffer. *(Una alerta emitida durante la ventana de rollback no se pierde en
   el Edge porque nunca llega a aceptarse: TradingView no recibe 2xx. Es una interrupción
   consciente, no una pérdida silenciosa.)*
2. **Drenar y verificar todas las colas de destino**, una por una, incluidas sus DLQ. Dejar que los
   consumers terminen el trabajo en vuelo; no borrar mensajes a mano.
3. **Pasar el gate `GET /rollback-readiness`** (`ok: true`, `blockers: []`). Comprueba de una vez
   lo mismo que se verifica a mano abajo, incluidas las filas legacy migradas que V1.2.3 leería de
   `outbox`. Con `ok:false` el rollback NO procede, y cada `blocker` dice por qué:
   `UNRESOLVED:<dest>:<n>`, `HALTED:<dest>:<seq>` o `LEGACY_OUTBOX_UNRESOLVED:<seq>`.
   **Confirmar además `pending/retrying = 0`.** En `GET /admin/stats`, para **cada** destino:
   `unresolved: 0`, sin filas en `PENDING_DISPATCH` ni `DISPATCHED`, y `halted_seq: null`.
   **Con cualquier destino distinto de cero, el rollback no procede.** Si algún destino está en
   `FAILED_PERMANENT`, se resuelve con el procedimiento 3-bis antes de seguir.

### 3-bis · Cómo se llega a `halted_seq: null` con un `FAILED_PERMANENT` pendiente

Un `FAILED_PERMANENT` es un incidente, no ruido: se **resuelve**, no se borra. `halted_seq:<dest>`
solo se limpia cuando una acción administrativa resuelve **esa misma** secuencia; ninguna ruta
automática lo hace y ningún vaciado de cola lo toca.

1. **Capturar la evidencia antes de actuar.** `GET /signal?edge_seq=N` da, por destino, el estado,
   `halt_reason`, intentos y marcas de tiempo; `GET /stats` da `halted_seq:<dest>`. Guardar ambas
   salidas y el mensaje correspondiente de `DEST_<ID>_DLQ`. **La DLQ no se vacía ni se purga**: es
   el registro del fallo. Sus mensajes se consumen (o se dejan expirar por retención) *después* de
   resolver la entrega, nunca como forma de resolverla.
2. **Diagnosticar por `halt_reason`:**
   - `AUTH_REJECTED_401` / `AUTH_REJECTED_403` → credencial o ruta del webhook incorrecta en
     `DEST_<ID>_WEBHOOK_URL`. Corregir el secreto de **ese** destino y redesplegar solo su consumer.
   - `PERMANENT_4xx` → el Hub rechazó el contenido. Confirmar con el operador del Hub si esa alerta
     debe entregarse o no.
3. **Elegir la acción, y dejarla escrita.** Ambas son explícitas, autenticadas y quedan en
   `admin_log` con `actor` y `reason` obligatorios:
   - `POST /retry` con `{edge_seq, destination_id, actor, reason}` → la entrega vuelve a
     `PENDING_DISPATCH` y se reintenta. **Es la opción por defecto** cuando la causa se ha corregido
     (credencial arreglada): el Hub acaba recibiendo la alerta y la cabeza avanza sola.
   - `POST /skip` con los mismos campos → la entrega queda `ADMIN_SKIPPED`, auditada, y la cabeza
     avanza sin entregarla. **Solo** cuando se ha decidido, con el operador del Hub, que esa alerta
     no debe llegar a ese destino. El body original sigue en `signals` mientras la retención lo
     conserve: se salta la entrega, no se borra la evidencia.
   En multi-destino `destination_id` es **obligatorio**: sin él la llamada se rechaza con
   `DESTINATION_ID_REQUIRED`, precisamente para no resolver el incidente del Hub equivocado.
4. **Verificar que ese destino quedó limpio:** en `GET /stats`, `halted_seq: null` y su
   `next_seq_expected` por delante de la secuencia resuelta. Si la acción fue `retry`, volver al
   paso 2 del rollback y drenar de nuevo: la entrega reintentada tiene que llegar a `DELIVERED`.
5. **Repetir por cada destino detenido.** Un destino resuelto no resuelve a los demás: cada
   `halted_seq:<dest>` se limpia por separado, con su propia decisión y su propio registro.

Nunca: editar SQLite a mano, borrar filas de `deliveries` o `signals`, purgar una DLQ para
"desatascar", ni usar `force` (no está expuesto por HTTP). Si un incidente exigiera `force`, es una
emergencia documentada y se ejecuta por RPC desde un Worker del proyecto, dejando constancia.
4. **Ejecutar el rollback**: desplegar los artefactos de V1.2.3, borrar los consumers por destino y
   dejar de publicar en las colas nuevas. Restaurar después la admisión del ingress.

Si por una urgencia hubiera que volver sin drenar, asúmase de forma explícita que habrá duplicados
de transporte hacia los Hubs; serán duplicados, no ejecuciones nuevas, porque cada Hub deduplica por
`signal_id`. Esa ruta es excepcional y debe quedar registrada.

## 7. Verificación posterior

- `GET /admin/stats` (superficie temporal de STAGING): `schema_version: 2`, una entrada por destino
  con su `next_seq_expected`, `halted_seq` y `unresolved`.
- Traza de una señal: estado por destino, intentos, último error y marcas de tiempo.
- Prueba de aislamiento antes de dar por buena la instalación: apagar el receptor de un destino y
  comprobar que el otro entrega con normalidad y que el primero queda pendiente.

## 8. Qué NO hace este despliegue

No toca KAWA Execution Platform, ni el Hub operativo, ni TradingView, ni el Edge actualmente
desplegado si lo hubiera. No habilita PROD: todos los recursos llevan sufijo `-stg` y la entrega está
bloqueada estructuralmente al receptor de staging mediante Service Binding.
