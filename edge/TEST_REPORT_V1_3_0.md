# KAWA VECTOR · EDGE SIGNAL BUFFER V1.3.0 — TEST REPORT

**Artefacto:** `edge-signal-buffer-v1.3.0-staging` · **Linaje:** V1.3.0 ← V1.2.3 STAGING FROZEN
**Entorno:** workerd real (`@cloudflare/vitest-pool-workers` 0.5.40, vitest 2.1.9, wrangler 4.132.0,
Node 22), con Durable Objects respaldados por SQLite. Un runtime aislado **por fichero**: cada
escenario tiene su propio DO, su propio almacenamiento y sus propios receptores.

---

## 1. Resultado

| Categoría | Cantidad | Resultado |
|---|---|---|
| Tests legacy de V1.2.3 **sin cambios** | 41 | PASS |
| Test legacy **actualizado deliberadamente** por la política 401/403 | 1 | PASS |
| Tests nuevos de V1.3.0 | 17 | PASS |
| Tests de remediación de la auditoría (R1) | 14 | PASS |
| Tests de remediación de la reauditoría (R2) | 4 | PASS |
| Tests de remediación de la reauditoría (R3) | 6 | PASS |
| Tests de remediación de la reauditoría (R4) | 7 | PASS |
| **Total** | **90** | **90/90 PASS · 0 FAIL · 0 SKIP** |

Ficheros: 9 (`scenario_ingress`, `scenario_dlq`, `scenario_recovery`, `scenario_reorder`,
`scenario_halt_notify`, `scenario_I_lost_response`, `scenario_fanout`, `scenario_fanout_contract`, `scenario_audit_remediation`).

### El único test legacy modificado
`scenario_ingress.test.js > ack contract > classifies every branch`. Antes afirmaba
`classify(401) === RETRY`; ahora afirma `FAILED_PERMANENT`, más las ramas nuevas (403, 429, 408,
`retryable`). El motivo está escrito **dentro del propio test**: decisión del owner, un 401/403 deja
de reintentarse para siempre porque era un fallo silencioso. Ningún otro test legacy se tocó, ni se
borró ninguno, ni se relajó ninguna aserción para que pasara.

## 2. Los 15 casos obligatorios

| # | Caso | Test | Resultado |
|---|---|---|---|
| 1 | ONE SIGNAL → TWO DESTINATIONS, mismo `signal_id` | `fanout > 1` | PASS |
| 2 | HUB_A DOWN, HUB_B entrega; A queda pendiente | `fanout > 2` | PASS |
| 3 | HUB_A RECOVERS; B sin duplicado innecesario | `fanout > 3` | PASS |
| 4 | HUB_B DOWN (caso inverso) | `fanout > 4` | PASS |
| 5 | BOTH DOWN, señal durable, sin pérdida | `fanout > 5-6` | PASS |
| 6 | BOTH RECOVER a distinto tiempo, convergencia independiente | `fanout > 5-6` | PASS |
| 7 | DUPLICATE TRADINGVIEW REQUEST, una sola identidad de trading | `contract > 7` | PASS |
| 8 | EDGE RETRY DUPLICATE, mismo `signal_id`, sin segundo POST | `contract > 8` | PASS |
| 9 | ONE DESTINATION CONFIG = comportamiento V1.2.3 | `contract > 9` + los 41 legacy | PASS |
| 10 | DESTINATION DISABLED, no recibe y no interfiere | `fanout > 10` | PASS |
| 11 | BAD SECRET HUB_A; B sigue entregando | `contract > 11` | PASS |
| 12 | RESTART / WORKER REDEPLOY, pendientes sobreviven | `contract > 12` | PASS |
| 13 | CONCURRENT SIGNALS, sin mezclar delivery states | `contract > 13` | PASS |
| 14 | SIGNAL ORDERING respetando el sequencer | `contract > 14` | PASS |
| 15 | SECRET REDACTION en logs y diagnostics | `contract > 15` | PASS |

Añadidos por encima de la lista: `contract > 11b` (retención con un destino en `FAILED_PERMANENT`),
`RULE 1` (sin histórico al añadir un destino) y `RULE 2` (sin destino implícito en multi-destino).

## 3. Qué demuestra cada test nuevo, en concreto

- **1** · una entrada, una fila en `signals`, dos en `deliveries` con `delivery_id`
  `E<seq>:HUB_A` y `E<seq>:HUB_B`, y el mismo cuerpo byte a byte en los dos Hubs.
- **2 / 4** · la cabeza del destino vivo avanza y la del caído no; `unresolved` lo refleja.
- **3** · al recuperarse A recibe la alerta; el contador de B no se mueve.
- **5-6** · tres alertas con ambos caídos; B converge primero y A después, cada uno en orden de
  origen (`E1, E2, E3`).
- **7** · dos POST idénticos: el Edge transporta ambos con el mismo `signal_id` y es el Hub quien
  responde `DUPLICATE` a la segunda copia. El Edge **no inventa** identidad de trading.
- **8** · un sobre redelivered sobre una entrega ya `DELIVERED` se ackea sin volver a hacer POST; el
  fetcher del test lanza si alguien lo llama.
- **9** · con un destino, `stats()` mantiene la forma de V1.2.3 y la llamada legacy sin destino
  resuelve.
- **11** · 401 → `FAILED_PERMANENT`, `halt_reason: AUTH_REJECTED_401`, registro en la DLQ **de ese
  destino**, `halted_seq` solo en A, y la alerta siguiente llega a B mientras A sigue detenido.
- **11b** · la frontera de retención avanza sobre la secuencia fallida concreta; con un destino
  simplemente caído, no avanza. **No** significa que un halt desatendido pierda su backlog: las
  señales posteriores se le siguen debiendo y se conservan durables hasta `retry` o `skip`, que es
  lo que demuestra el test de R21 (§3-quinquies).
- **12** · se descartan todas las copias en vuelo, se fuerza el redispatch y ambos destinos entregan
  `R1, R2` con la **misma** `delivery_id`. Nunca se crea una identidad nueva.
- **13** · B adelantado, A retrasado y luego alcanzando: ambos acaban con `C1, C2, C3` y los
  intentos de A no inflan los de B.
- **14** · los sobres de A se entregan en orden 3, 2, 1: solo pasa el primero de la línea; los demás
  esperan y **nunca** se hace POST fuera de turno. B, intacto, sigue al principio de su propia línea.
- **15** · con secretos plantados en las URL de ambos destinos y un 401 provocado, ni los logs ni
  `stats()` ni la traza por señal contienen credencial alguna; los logs sí nombran el destino y el
  motivo.

## 3-bis. Remediación de la auditoría independiente (R1)

| Finding | Qué se corrigió | Test | Resultado |
|---|---|---|---|
| **F-01** P1 | 401/403 se evalúan ANTES que cualquier pista de reintento del body | `F-01` (4 tests, incluidos `401 + retryable:true` y `403 + code:"RETRY"`, más un extremo a extremo) | PASS |
| **F-02** P1 | `destinationDisabled()`: la entrega de un destino deshabilitado se resuelve durable y auditada (`DISABLED_SKIPPED`), la cabeza se reconcilia al rehabilitar | `F-02` (4 tests: pendientes al deshabilitar, señales durante, re-enable sin WAIT eterno, sin redispatch ni retención) | PASS |
| **F-03** P2 | validación de `timeout_ms` y de la política de retry; fallo cerrado en carga/aceptación | `F-03` (3 tests, 9 configuraciones inválidas + ingress 503 sin aceptar nada) | PASS |
| **F-04** P2 | `package-lock.json` raíz a 1.3.0; R8.2.3.3 queda declarado **baseline de contrato** y R8.4 REV8 como **Hub operativo actual** | verificación en `package-lock.json`, `VERSION` y `README.md` | PASS |
| **F-05** | espejo de resolución en filas legacy + gate `rollbackReadiness()` | `F-05` (3 tests: bloqueo por pendientes/halt, nota de barrera, espejo en `outbox`) | PASS |

Durante F-02 apareció una regresión propia que el test legacy de halt detectó: al ampliar el avance
de cabeza, esta saltaba también los `FAILED_PERMANENT`, lo que habría roto el halt causal. Se separó
"resuelto para GC" de "avanzable" (`RESOLVED` vs `ADVANCEABLE`).

## 3-ter. Reauditoría: F-02 reabierto (R2)

La reauditoría encontró una discrepancia real entre el procedimiento y la implementación: el
consumer decidía si una entrega debía pasar a `DISABLED_SKIPPED` leyendo **su propia** copia de
`DESTINATIONS`. Con el ingress ya deshabilitado y un consumer con config vieja (`enabled:true`), una
entrega pendiente podía acabar POSTeada al Hub. El test anterior no lo veía porque su helper
actualizaba a la vez la config del DO y la del consumer.

**Corrección:** la autoridad pasa al Sequencer, en dos puntos. Al **despachar**, un destino
deshabilitado resuelve ahí mismo sus entregas pendientes y no se publica nada a su cola. En el
**torniquete**, un sobre ya en vuelo reclamado por un consumer desactualizado tampoco pasa: se
resuelve y se devuelve `ALREADY_DELIVERED · disabled`, sin bytes. El chequeo del consumer queda como
defensa secundaria.

| Test (R2) | Qué demuestra | Resultado |
|---|---|---|
| DO disabled + consumer con config vieja | 0 POST al Hub; la entrega queda `DISABLED_SKIPPED`; HUB_A entregado | PASS |
| Pendiente + consumer apagado / cola no disponible | El DO la resuelve solo en una pasada de alarma: `unresolved: 0` y deja de retener | PASS |
| Sobre ya en vuelo con config vieja | `claim()` devuelve `ALREADY_DELIVERED · disabled` y no entrega bytes; motivo `DESTINATION_DISABLED_AT_CLAIM` | PASS |
| Rehabilitar después | La primera señal nueva se entrega; HUB_A nunca se vio afectado | PASS |

Mutación: al quitar los dos chequeos del DO, **fallan los 4**.

## 3-quater. Reauditoría R3

| Finding | Corrección | Test | Mutación |
|---|---|---|---|
| **F-02B** P1 · un destino deshabilitado fijaba el GC | `_reconcileHeads()` reconcilia la cabeza de todos los destinos conocidos en `stats()`, en el GC y tras cada pasada de despacho; la reconciliación nunca sobrepasa una entrega pendiente real, un `FAILED_PERMANENT` ni un halt | 3 tests: 12 señales posteriores solo para HUB_A con HUB_B apagado, respeto de pendientes y fallos, y re-enable | 1 fallo al revertir |
| **F-03B** P1 · `enabled` por coerción | Booleano estricto cuando el campo está presente; `"false"`, `0`, `null`, objetos y arrays son configuración inválida con fallo cerrado 503 | 3 tests, 8 tipos inválidos + ingress sin aceptar nada | 2 fallos al revertir |

## 3-quinquies. Reauditoría R4

| Finding | Corrección | Test | Mutación |
|---|---|---|---|
| **F-04** P1 · `DESTINATIONS` vacío caía al camino legacy | El legacy de un solo destino existe **solo** si la variable está AUSENTE. Presente pero `""`, espacios o `null` es `DESTINATIONS_PRESENT_BUT_EMPTY`, y `[]` sigue siendo `DESTINATIONS_EMPTY` | 3 tests, con `counter: 0` tras el 503 | 3 fallos al revertir |
| **F-05** P2 · `timeout_ms` falsy caía al default | Se valida el primer valor **presente**, no el primero "verdadero": `0`, `null`, `false` y `""` son inválidos. Igual para `base_delay_s`, `backpressure_delay_s` y `max_delay_s` | 3 tests + ingress 503 sin aceptar | 2 fallos al revertir |
| **R21** · contrato de GC | Documentación y test precisos: la secuencia fallida está resuelta, pero el **backlog posterior de ese destino se conserva durable** hasta `retry`/`skip`; los demás Hubs siguen operando | 1 test: 3 señales de backlog sobreviven a varias pasadas de GC y se entregan en orden tras la decisión humana | — |

## 4. Comprobación de mutación

Para verificar que los tests muerden, se revirtieron tres decisiones sobre una copia del árbol:

| Mutación | Tests que fallan |
|---|---|
| Halt global en vez de por destino | 1 |
| Cabeza de orden compartida entre destinos | 8 |
| `401` vuelve a ser reintentable para siempre | 3 |
| **F-01** · quitar la precedencia de 401/403 sobre la pista de reintento | 4 |
| **F-02** · volver a ackear en limbo la entrega de un destino deshabilitado | 3 |
| **F-03** · validación de config que no rechaza nada | 2 |
| **F-05** · desactivar el espejo de resolución en filas legacy | 1 |
| **F-02 R2** · devolver la autoridad de enabled/disabled al consumer | 4 |
| **F-02B R3** · no reconciliar las cabezas | 1 |
| **F-03B R3** · aceptar `enabled` por coerción | 2 |
| **F-04 R4** · `DESTINATIONS` vacío vuelve a caer en legacy | 3 |
| **F-05 R4** · `timeout_ms` falsy vuelve a caer al default | 2 |

## 5. Defectos encontrados y corregidos durante el desarrollo

1. **Cabeza huérfana de un destino nuevo.** La cabeza se inicializaba de forma perezosa como
   `counter + 1`, de modo que el segundo destino quedaba esperando para siempre su `seq 1`. Ahora
   nace con su primera entrega debida. Lo destapó el test 1.
2. **Objetos de cola cruzando la frontera RPC.** El harness pasaba bindings con métodos al Durable
   Object; no son serializables. Los shims se construyen dentro del DO.
3. **`stats()` exigía destino** y, tras F-03, también propagaba el error de una configuración
   inválida; ahora responde siempre con lo que hay en el almacenamiento. Igual que `_publish`, que
   lee la configuración dentro de su `try` para que una config rota degrade en backoff y no en una
   excepción no capturada.
4. **`stats()` no listaba los destinos deshabilitados**, así que no se podía comprobar que un
   destino apagado no retiene nada. Ahora lista todos los configurados, con su campo `enabled`.
5. **Antes:** La observabilidad es global y no puede depender de un destino
   implícito; ahora devuelve `null` en los campos con forma de V1.2.3 cuando hay varios.

## 6. Límites declarados

- **Sin despliegue y sin validación física contra Cloudflare.** Todo lo anterior es workerd local.
  Límites, cuotas y precios del plan siguen **sin verificar** (el entorno no puede abrir
  `developers.cloudflare.com`), igual que en el diseño de V1.2.
- **Sin prueba de concurrencia real entre consumers de distintos destinos** en la plataforma: los
  escenarios ejercitan la lógica de forma determinista, no la planificación real de Cloudflare.
- **La migración de esquema se prueba sobre un DO nuevo**, no sobre una instancia V1.2.3 con estado
  real en producción. La ruta existe y está probada por código, pero su verificación con datos
  reales corresponde a STAGING.
- **El `R-BUNDLE`-equivalente aquí no aplica**; lo que no se ha probado es el comportamiento con más
  de tres destinos simultáneos, aunque nada en el diseño los limita.
