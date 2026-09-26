# CHANGELOG · V1.3.1 (R3.1) respecto de V1.3.0 R4

## R3.1 (2026-09-26) · correcciones quirúrgicas de la auditoría de R3 (PASS WITH OBSERVATIONS)

Solo los P2 que el auditor pide cerrar antes de PROD y el procedimiento de doble ruta. `edge/src/**` sigue
byte-idéntico a R4. B-1 y B-2 **no** se tocan: siguen pendientes de decisión (ver RELEASE_REPORT §6).

| Id | Cambio | Ficheros |
|---|---|---|
| R3-01 (P2) | `verify-release` rechaza cualquier nombre de entrada no canónico (`./`, `//`, `\`, segmentos `.`/`..` o vacíos, caracteres de control, `/` final) **antes** de aplicar los filtros: `ZIP_ENTRY_NOT_CANONICAL` | `deployer/lib/release.mjs` |
| R3-02 (P2) | la suite del deployer se ancla **por fichero**: `deployer/test/expected-tests.json` declara cada fichero y su número de tests; el veredicto sale de un reporter estructurado (`deployer/lib/test-reporter.mjs`), no del resumen de texto. 0 tests, salida prematura, fichero omitido o no declarado → FAIL | `release.mjs`, `test-reporter.mjs` (**A**), `test/expected-tests.json` (**A**) |
| R3-03 (P2) | entre los runs Cloudflare del **mismo build**, gobierna el más reciente: un FAIL/PARTIAL posterior bloquea PROD aunque exista un PASS anterior; la evidencia caduca a los **7 días** | `deployer/lib/prod.mjs` |
| R3-07 (P3) | **un único** procedimiento de cambio de ruta (cutover y rollback de transporte), definido en código y citado por el RUNBOOK: `cutover-check` lo imprime (fila C9), `cutover` pide `ROUTE SWITCH WINDOW READY`, `rollback-transport` imprime el mismo texto | `prod.mjs`, `RUNBOOK_VIGENTE.md` §5/§8/§9 |

## R3 (2026-09-26) · correcciones de la re-auditoría independiente de R2

R2 no se entregó: una re-auditoría independiente encontró 2 P2 y 4 P3 nuevos en el mecanismo de R2 (ningún
P0/P1) y tres afirmaciones exageradas en la respuesta a la auditoría. R3 los corrige. `edge/src/**` sigue
byte-idéntico a R4.

| Id | Cambio |
|---|---|
| N-1 (P2) | el lanzador ya no escribe ningún fichero como root: el manifiesto con el que se construyó la imagen se lee de la propia imagen (se elimina `state/.image-manifest` y su carrera con un enlace a directorio) |
| N-2 (P2) | `verify-release` comprueba la firma de la evidencia empaquetada donde existe la clave (la instalación que la produjo) y, fuera de ella, avisa de que no es verificable; la afirmación «verify-release rechaza evidencia sin firma» se corrige |
| N-3 (P3) | el `chown` del lanzador solo toca lo que es de root, nunca por un enlace ni un fichero con un segundo enlace duro; `chmod` sin seguir enlaces; `touch -h` donde existe |
| N-4 (P3) | un destino **deshabilitado** en la ejecución STAGING no cuenta como probado para PROD |
| N-5 (P3) | `verify-release` exige el hash publicado del manifiesto (línea 2 del `.sha256` o `--manifest-sha256`), rechaza nombres duplicados y cualquier byte del ZIP no descrito por el directorio central |
| N-6 (P3) | una clave de evidencia vacía o malformada falla cerrado |
| N-7 (P3) | el README verifica el ZIP con `sha256sum` del sistema **antes** de extraerlo |
| F-03 | test añadido con el caso exacto del auditor (código cambiado tras el STAGING PASS → `add-hub --env prod` BLOCKED) |

## R2 (2026-09-26) · remediación de la auditoría externa de R1 (veredicto FAIL)

Detalle hallazgo por hallazgo, con su test de regresión: `delivery/AUDIT_RESPONSE_R2.md`.
**`edge/src/**`, receptor STAGING y admin: siguen byte-idénticos a R4.** Cambios solo en el instalador, el
lanzador, las herramientas de release, los tests del deployer y la documentación:

| Área | Cambio |
|---|---|
| `deployer/lib/release.mjs` | veredictos estrictos de `test-full` (F-01/F-11); evidencia firmada; `.sha256` con hash del ZIP y del manifiesto; `verify-release` sobre entradas crudas del ZIP y hash esperado obligatorio (F-06/F-20) |
| `deployer/lib/evidence.mjs` (**A**) | firma HMAC de la evidencia y binding sobre deployer + runtime del Edge + lockfile + wrangler (F-04/F-05) |
| `deployer/lib/prod.mjs`, `addhub.mjs` | una sola puerta STAGING PASS para toda escritura PROD, corroborada en Cloudflare (F-03/F-04/F-16/F-17); confirmación tecleada para redesplegar el ingress PROD (F-10); ruta de éxito del cutover (F-13/H-15) |
| `deployer/lib/gates/run.mjs` | lista de gates en código; G/K/L/ISO-XY/G00/RB endurecidos; 0 gates = FAIL (E-05…E-10) |
| `deployer/lib/cfapi.mjs`, `preflight.mjs`, `deploy.mjs` | paginación completa, existencia por nombre antes de CREATE (F-08/F-09/D-05) |
| `deployer/lib/config.mjs`, `secrets.mjs`, `log.mjs` | bloqueo por dominio de HUB_A, huella decodificada, reglas de URL, redacción (F-07/F-18/C-02…C-07/H-08) |
| `deployer/lib/manifest.mjs`, `render.mjs`, `wrangler.mjs`, `paths.mjs`, `commands.mjs` | exclusiones solo en raíz y enlaces rechazados (F-12); digest independiente de la ruta (D-09); wrangler por ruta fija (D-10); propiedad en `resume-queues` (D-08) |
| `kawa-edge`, `Dockerfile`, `docker-compose.yml`, `.dockerignore` | lanzador sin seguir enlaces bajo sudo, carpeta de root rechazada, sello atómico, `verify-zip` exige hash (F-02/C-09); sin `# syntax=` (C-08); imagen `1.3.1-nas-r2` |
| `deployer/test/**` | nuevos: `release-gate`, `release-integrity`, `launcher`, `e2e-prod-gate`, `e2e-prod-locks`, `e2e-cutover-rotate`; equivalencia R4 del config completo de los 6 configs (F-21); experimento `experiments/alarm-restart.mjs` (F-24) |
| Documentación | RUNBOOK (invariantes, requisitos de STAGING PASS, aviso de redespliegue del ingress, doble ruta, B-2←B-1, riesgos declarados), token (*Account Analytics: Read* obligatorio para PROD), README, informes |

---

## R1 · respecto de V1.3.0 R4

Base: `KAWA_EDGE_SIGNAL_BUFFER_V1_3_0_R4_CANDIDATE_2026-09-22.zip`
(SHA-256 `1bcd1e3df8fba89781916efcaf173a45983f0566bb189d59e20929766db82867`), importado sin cambios como
primer commit del repositorio (`7d8dab5`). Esta lista sale de `git diff --name-status 7d8dab5` y es
exhaustiva. En el ZIP, R4 vive bajo `edge/`.

## Código de producción del Edge: **SIN CAMBIOS**

`edge/src/ingress-entry.js`, `producer.js`, `sequencer.js`, `destinations.js`, `consumer-entry.js`,
`consumer.js`, `edge/staging-receiver/src/index.js`, `edge/admin-worker/src/index.js`: **byte-idénticos a
R4** (`git diff 7d8dab5 -- edge/src edge/staging-receiver edge/admin-worker` vacío). No se encontró ningún
bug de producción: el fallo del NAS era del harness.

## Tests del Edge

| Fichero | Cambio | Motivo |
|---|---|---|
| `edge/vitest.config.js` | **M** · añade `outboundService` (salida de red local) | causa raíz del 53/90 (`ROOT_CAUSE_NAS_53_90.md`); sin tocar timeouts ni bindings |
| `edge/test/hermetic_egress.test.js` | **A** · 2 tests | guardián: falla si se pierde la hermeticidad |
| `edge/test/scenario_consumer_own_entry.test.js` | **A** · 3 tests | respalda el delta 2 de configuración (abajo) |
| los 9 ficheros de test de R4 y sus helpers | **sin cambios** | — |

## Configuración de wrangler (ya no se edita a mano)

| Fichero R4 | Ahora | Motivo |
|---|---|---|
| `edge/wrangler.staging.toml` | **R** → `deployer/test/fixtures/` | se **genera** desde `config/kawa-edge.json`; el original queda como referencia del test de equivalencia |
| `edge/wrangler.consumer.hub-a.staging.toml` | **R** → `deployer/test/fixtures/` | idem |
| `edge/wrangler.consumer.hub-b.staging.toml` | **R** → `deployer/test/fixtures/` | idem |
| `edge/wrangler.consumer.staging.toml` | **D** | forma V1.2.3 de un solo destino con colas `kawa-signal-buffer-stg` que no existen: desplegarlo contradiría V1.3.0 (queda en el ZIP R4) |

Deltas de los configs **generados** frente a R4 (comprobados por `deployer/test/r4-equivalence.test.mjs`
con el lector de configuración del wrangler fijado; todo lo demás es idéntico):

1. **Un receptor STAGING por Hub** (`kawa-staging-receiver-hub-a`, `…-hub-b`) en lugar de uno compartido.
   Mismo código de receptor. Motivo: los gates obligatorios «HUB_A caído / HUB_B sigue» y de
   deduplicación por Hub necesitan ledgers y comportamiento independientes; con un receptor compartido el
   segundo Hub recibía `DUPLICATE` del primero y el ledger mezclaba destinos.
2. **Cada consumer lleva solo su propia entrada** en `DESTINATIONS`. El consumer está fijado por
   `CONSUMER_DESTINATION_ID` y nunca lee otra entrada; el Sequencer (autoridad) conserva la lista completa.
   Motivo: añadir HUB_C **no** redespliega el consumer de HUB_A. Probado en workerd (3 tests).
3. **Consumers sin URL pública** (`workers_dev = false`, `preview_urls = false`): un consumer de cola no
   necesita HTTP. Ingress/admin/receptores: `preview_urls = false`.
4. **Marcadores de propiedad** `KAWA_EDGE_MANAGED` y `KAWA_EDGE_BUILD` (vars en claro, inertes para el
   código): permiten al preflight distinguir un recurso propio de uno ajeno y no redesplegar lo que ya
   está al día.
5. **PROD** (nuevo; R4 solo traía STAGING): nombres `-prod`, sin Service Binding, sin receptor, sin admin;
   `DEST_<ID>_WEBHOOK_URL` como secreto obligatorio solo en el consumer de ese Hub.

## Documentación

| Fichero | Cambio |
|---|---|
| `edge/STAGING_RUNBOOK.md` | **D** · runbook V1.2.x con órdenes legacy; sustituido por `RUNBOOK_VIGENTE.md` (único vigente) |
| `edge/README.md` | **M** · apuntaba a `STAGING_RUNBOOK.md`; ahora apunta al runbook vigente |
| `edge/MIGRATION_AND_DEPLOYMENT_V1_3_0.md` | **M** · solo una nota de 5 líneas al principio (autoridad de arquitectura; comandos ejecutados por el instalador; B-1). Resto intacto |
| `edge/VERSION` | **M** · identidad V1.3.1 (R1, luego R2) antepuesta; registro de R4 intacto debajo |
| `edge/package.json`, `edge/package-lock.json` | **M** · solo la versión raíz `1.3.0 → 1.3.1`. **Árbol de dependencias idéntico** |
| `edge/ARCHITECTURE_V1_3_0.md`, `TEST_REPORT_V1_3_0.md`, `REQUIREMENTS_MATRIX_V1_3_0.json`, `destinations.example.json`, `.dev.vars.example`, `test/kawa/*` | sin cambios |

## Nuevo (paquete instalable)

| Ruta | Qué es |
|---|---|
| `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `kawa-edge` | imagen fijada por digest, capas de dependencias/código separadas; contenedor sin puertos, read-only, `cap_drop ALL`; lanzador del host |
| `config/kawa-edge.example.json`, `secrets/README.md` | configuración única, sin secretos; buzón de un solo uso para el token |
| `deployer/cli.mjs`, `deployer/lib/**` | instalador y operación (ver `RUNBOOK_VIGENTE.md`) |
| `deployer/test/**` | R1: 46 tests (27 unit + 3 equivalencia R4 + 16 E2E contra API simulado); R2: ver `TEST_REPORT_V1_3_1.md §1` |
| `README_NAS_INSTALL.md`, `RUNBOOK_VIGENTE.md`, `CLOUDFLARE_API_TOKEN.md`, `ROOT_CAUSE_NAS_53_90.md`, `TEST_REPORT_V1_3_1.md`, `RELEASE_REPORT_V1_3_1.md`, `CHANGELOG_V1_3_1.md`, `VERSION` | documentación de la entrega |
| `MANIFEST_SHA256_V1_3_1.json`, `TEST_EVIDENCE_V1_3_1.json` | generados por `package` |

## Toolchain

Sin cambios: wrangler 4.132.0, vitest 2.1.9, @cloudflare/vitest-pool-workers 0.5.40, Node 22. Sin
`npm audit fix`. Las 10 vulnerabilidades del árbol dev siguen presentes y analizadas en
`ROOT_CAUSE_NAS_53_90.md §5`; `npm audit --omit=dev` = 0.
