# RELEASE REPORT · KAWA Edge Signal Buffer V1.3.1 R3.1 (NAS turnkey)

| Campo | Valor |
|---|---|
| Identidad | `edge-signal-buffer-v1.3.1-nas` · revisión **R3.1** (correcciones quirúrgicas R3-01, R3-02, R3-03 y R3-07 sobre R3, auditada PASS WITH OBSERVATIONS) · 2026-09-26 |
| Linaje | V1.3.1 ← V1.3.0 R4 CANDIDATE (`1bcd1e3df8fba89781916efcaf173a45983f0566bb189d59e20929766db82867`) |
| Código de producción del Edge | **byte-idéntico a R4** (`git diff 7d8dab5 -- edge/src edge/staging-receiver edge/admin-worker` vacío) |
| ZIP | `KAWA_EDGE_SIGNAL_BUFFER_V1_3_1_NAS_R3.1_2026-09-26.zip` — SHA-256 en la **primera línea** del `.sha256` adjunto (un fichero no puede contener su propio hash) |
| Manifest | `MANIFEST_SHA256_V1_3_1.json` (autohash excluido, como R4); su SHA-256 va en la **segunda línea** del `.sha256` (F-20); `verify-release` la exige y la comprueba |
| Evidencia de tests | `TEST_EVIDENCE_V1_3_1.json`, ligada al hash del árbol de entrada de los tests y **firmada** (HMAC) por la instalación que la produjo |
| Estado | **STAGING-READY.** **CUTOVER PROD BLOQUEADO** por B-1 y B-2 (§6) |

## 1. Qué se entrega

- Paquete instalable: `Dockerfile` (base fijada por digest, capa de dependencias cacheada), `docker-compose.yml`
  (sin puertos, red propia, read-only, `cap_drop ALL`), lanzador `./kawa-edge`, configuración única
  `config/kawa-edge.json`, instalador `deployer/`.
- Un comando por fase: `verify-fast`, `test-targeted`, `test-full`, `package`, `verify-release`, `preflight`,
  `install`, `gates`, `rehearse`, `status`, `add-hub`, `resume-queues`, `staging-teardown`, `prod-deploy`,
  `hub-check`, `cutover-check`, `cutover`, `rollback-transport`, `tail`.
- Documentos: `README_NAS_INSTALL.md`, `RUNBOOK_VIGENTE.md` (único runbook vigente), `CLOUDFLARE_API_TOKEN.md`,
  `ROOT_CAUSE_NAS_53_90.md`, `TEST_REPORT_V1_3_1.md`, `CHANGELOG_V1_3_1.md`, este informe.

## 2. Root cause del 53/90

El harness no era hermético: ~80 notificaciones de halt por ejecución salían del runtime como búsquedas DNS
reales de `halt-notify.test`; con el DNS del NAS (que no responde) el **único** runtime workerd compartido se
bloqueaba y tests ajenos agotaban 5000 ms. Reproducido exactamente (50/90 con `--dns 192.0.2.1`; el auditor externo, de forma independiente, 60/90), probado
causalmente (reorder solo = PASS; reorder + dlq = FAIL) y corregido en el harness sin tocar producción ni
timeouts. Detalle: `ROOT_CAUSE_NAS_53_90.md`.

## 3. Resultados

| Suite | Resultado |
|---|---|
| Edge (workerd) | **95/95 PASS**, 11/11 ficheros, **exit 0** — 90 de R4 sin modificar + 2 guardián + 3 consumer con su entrada |
| Deployer | **84/84 PASS**, exit 0, **anclado por fichero** (`deployer/test/expected-tests.json`) — 58 unit (incl. veredictos con vitest real, integridad del ZIP, lanzador, runner de gates), 6 equivalencia R4 (config completo), 20 E2E del instalador contra API simulado |
| Ensayo local de gates STAGING | **PASS** — 13 ejecutados, 5 `CLOUD_ONLY` (justificado en TEST_REPORT §5) |
| Gate físico sobre el ZIP final | ver §4 |

## 4. Tiempos medidos (entorno NAS-equivalente: contenedor de la imagen, 4 vCPU, rootfs read-only, uid no-root)

| Paso | Antes (R4, entorno del NAS) | V1.3.1 R3.1 (medido en esta revisión; lo no re-medido se indica) |
|---|---|---|
| Instalación limpia de dependencias (imagen sin caché: `npm ci` + export) | `npm ci` en bind mount del NAS (no medido por fase) | **28.4 s** medido en R1 (de ellos `npm ci` 8.6 s); capa de dependencias sin cambios desde R1 |
| Reconstrucción tras un cambio solo de código | reinstalar | segundos (capa de dependencias en caché) |
| Fast preflight (`verify-fast`: manifest, toolchain, config, aislamiento, 8 bundles offline, 64 unit) | — | 13.7 s (medido en R3; +2 tests unitarios rápidos) |
| Targeted (`test-targeted`, 1 fichero de test del Edge) | suite completa | **2.2 s** |
| Targeted (cambio solo de documentación) | suite completa | **0.0 s** (nada que ejecutar) |
| Full release gate (`test-full`: Edge 95 + deployer 84) | **267.7 s y FAIL 53/90** (NAS); 101.9 s y FAIL 50/90 (DNS muerto, 4 vCPU) | **120.3 s PASS** (Edge 9.9 s en paralelo por fichero; deployer 110.4 s en paralelo por fichero) |
| Empaquetado (`package`, sin re-ejecutar la suite) | 15–20 min (incluía repetir la suite) | < 1 s (evidencia **firmada** de `test-full` reutilizada por hash; la suite **no** se repite) |
| Verificación del ZIP (`verify-release`) | — | < 1 s (hash esperado obligatorio, entradas crudas del ZIP, manifest y su hash publicado, vínculo de evidencia, ficheros prohibidos, runbook único) |
| Install STAGING hasta gates (preflight + 6 bundles + 6 despliegues, contra API simulado) | manual, Worker a Worker | **13.6 s**; re-ejecución idempotente **7.0 s** |
| Gates STAGING | — | ensayo local **203.5 s** (medido en R3; R3.1 no toca los gates ni el runner) (13 gates + 5 CLOUD_ONLY); en Cloudflare no medible aquí (estimado ≈ 20 min: retries de 60 s del halt + gate K de 6 min) |
| Gate físico sobre el ZIP final (extraer → imagen → verify-fast → test-full → rehearse) | — | se ejecuta **después** de empaquetar, sobre el ZIP ya cerrado; su resultado va en el mensaje de entrega y en `delivery/` (un fichero dentro del ZIP no puede certificar el ZIP que lo contiene). R1: 281 s PASS |

Ningún paso supera los objetivos (empaquetado ≪ 5 min; full test ≪ 10 min). El flujo normal nunca ejecuta dos
suites completas seguidas: `package` reutiliza la evidencia de `test-full` si el hash del árbol de entrada
coincide (`TEST_EVIDENCE_V1_3_1.json`), y se niega si no.

## 5. Doble auditoría

**Auditoría 1 (independiente, sobre el instalador completo):** 4 P0, 4 P1, 9 P2, 13 P3. Todos los P0/P1/P2
corregidos con test de regresión donde aplica; P3 corregidos salvo los marcados «aceptado».

| Id | Hallazgo | Corrección |
|---|---|---|
| P0-1 | la URL de notificación de halts (única salida del Sequencer sin Service Binding) no se validaba en STAGING y en PROD aceptaba `:8180` o `host.` | `validateHaltUrl()` en ambos entornos y al recargar: https, sin puerto, nunca host de Hub ni ruta `/webhook/`; tests |
| P0-2 | una ejecución `--quick` contaba como STAGING PASS y autorizaba PROD | resultado `PARTIAL` (BLOCKED); PROD exige todos los gates obligatorios, K incluido; test |
| P0-3 | gate G decía «DLQ record» sin comprobarlo | con Analytics:Read exige backlog ≥ 1 (si no, FAIL); sin él la evidencia dice `verified:false` |
| P0-4 | gate L podía pasar sin reinicio real | exige que cambie el id de despliegue del ingress |
| P1-5 | la huella anti-reutilización de secretos se perdía con varios Hubs en una ejecución | almacén único por ejecución, comprobación contra las entradas del run; test |
| P1-6 | `--set-halt-notify` rotaba en silencio el path token PROD | solo se sube lo que falta o se pide; el path token solo se rota en `cutover`; test |
| P1-7 | el lanzador creaba `state/` como root y el contenedor no-root no podía escribir | `chown` al propietario de la carpeta; error legible si aun así falla |
| P1-8 | `network_mode: bridge` compartía la red por defecto con otros contenedores | red propia del proyecto |
| P2 | redacción por trozos; limpieza que tragaba errores; Ctrl-C durante una pausa; ISO-XY/add-hub con > 2 Hubs; digest SHA-256 sin clave del webhook PROD en `deployed.json`; otro Hub apuntando al host de HUB_A; huecos de `.dockerignore`; borrado en btrfs | redacción por líneas; limpieza verificada (FAIL si falla) y manejadores de señal; filtros por X/Y y caso deshabilitado; `deployed.json` ya no guarda digest PROD; bloqueo de host; exclusiones; advertencia documentada |
| P2-15 | la evidencia STAGING solo ligaba el código del Edge | liga código + renderizador + versión de wrangler |
| P3 | parseo de flags con `=`; base del API configurable a cualquier host; informes sin redactar; escritura no atómica; sin timeouts; zip sin límite | corregidos (API solo `api.cloudflare.com` o loopback de tests). **Aceptados:** comprobación de permisos de escritura sin escribir (Cloudflare no lo permite: documentado), `tty:true` en compose |

Hallazgos propios antes de la auditoría (corregidos): gate A asumía 2 destinos; gate BYTE podía pasar vacío;
`.dockerignore` excluía `.gitignore` (fallo de manifest en el NAS); consumer PROD de HUB_A redesplegado al
añadir HUB_B (lo detectó la guardia de radio de impacto).

**Auditoría 2 (re-auditoría independiente de las correcciones):** confirmó todas las correcciones P0/P1 y la identidad byte a byte de `edge/src`, y
encontró un P1 nuevo — `queueBacklog` leía un error de permiso de GraphQL (HTTP 200 + `errors`) como backlog 0:
el gate G habría fallado siempre sin el permiso opcional de Analytics y C6 podía leerse «limpio» — más P2/P3
(línea base de la DLQ entre ejecuciones, máscara de 43 caracteres que ocultaba nombres de recursos, dominio
completo del Hub y `/webhook` codificado en la URL de halts, pruebas del runner, última línea de wrangler,
carrera Ctrl-C/pausa, `chown -R`, redacción de comentarios exagerados). **Todos corregidos** con tests nuevos
(runner PASS/PARTIAL/FAIL/limpieza/CLOUD_ONLY, forma de la respuesta de despliegues, error de GraphQL, secreto
partido entre dos trozos de salida). Matiz aceptado y documentado: el almacén de huellas HMAC de secretos PROD
guarda la clave junto a las huellas en `state/`; su protección descansa en la entropía del secreto del webhook
(≥ 16 caracteres exigidos).

## 5-bis. Hallazgo del gate físico (corregido)

Al descomprimir un ZIP nuevo **sobre** uno anterior en la misma carpeta, la imagen quedó con el `MANIFEST`
viejo: el ZIP es determinista (todas las entradas con la misma marca de tiempo) y la sincronización
incremental del contexto de BuildKit compara tamaño + mtime, así que un fichero cambiado del mismo tamaño se
reutiliza. El preflight lo detectó y **se negó a ejecutar** (fallo cerrado correcto), pero habría bloqueado
una actualización en el NAS. Corrección: el lanzador compara el manifest del paquete con el de la última
imagen y, si difiere, refresca las marcas de tiempo antes de construir (`./kawa-edge refresh-context` para el
camino manual). Re-probado en la misma ruta: PASS.

## 5-ter. Auditoría externa de R1 (FAIL) y respuesta R2

Un auditor externo independiente confirmó que el código del Edge es el de R4 y la causa raíz del 53/90, y dio
**FAIL** por defectos del mecanismo que rodea al Edge: 1 P0 (la puerta `test-full` podía declarar PASS con un
fichero de test que no cargaba), 5 P1 (lanzador con `sudo` que seguía enlaces simbólicos; `add-hub --env prod`
sin STAGING PASS; evidencia sin firma con su propia lista de gates; binding incompleto; `verify-release` ciego a
secretos dentro del ZIP), 12 P2 y 6 P3. **R2 los corrige todos** salvo los que son riesgos heredados de R4 o
decisiones del propietario, que quedan **declarados** (F-10 reinicio del Sequencer al redesplegar el ingress, con
confirmación tecleada; F-14 ventana de doble ruta; F-15 B-2 depende de B-1; H-16 PROD sin ejercitar antes de la
primera señal; OBS-1 `_notifyHalt` sin timeout, en `edge/src` congelado). Tabla hallazgo → corrección → test:
`AUDIT_RESPONSE_R2.md` (se entrega junto al ZIP).

Al ejecutar el pipeline R2 dentro del contenedor aparecieron tres defectos más, corregidos antes de empaquetar:
`test-full` resolvía rutas de un workspace ya borrado (ENOENT tras 95/95: fallo cerrado, nunca PASS falso); los
tests del runner escribían evidencia y la clave de firma en el `state/` real; y `verify-zip` leía mal el nuevo
`.sha256` de dos líneas (habría dado FAIL con un ZIP correcto). Cada uno tiene test.

**R3.** R2 no se entregó: una re-auditoría independiente (sin P0/P1) encontró 2 P2 (el sello escrito por root
tras el build podía seguir un enlace a directorio; `verify-release` no comprobaba la firma de la evidencia
empaquetada), 5 P3 y tres afirmaciones exageradas en la respuesta a la auditoría. Todo corregido en R3 con test
(`AUDIT_RESPONSE_R2.md` §R3).

**R3.1.** La auditoría de R3 dio **PASS WITH OBSERVATIONS** (sin P0/P1; los 6 P0/P1 de R1 cerrados; A3/A4
cerrado con el ZIP R4 original). R3.1 corrige solo lo que el auditor pide antes de PROD: R3-01 (nombres de entrada
ZIP no canónicos), R3-02 (suite del deployer anclada por fichero), R3-03 (gobierna el run STAGING más reciente del
mismo build; caducidad de 7 días) y R3-07 (procedimiento único de cambio de ruta). Los P3 restantes (R3-04…R3-06,
R3-08…R3-16) quedan **abiertos a propósito** en esta ronda. Evidencia antes/después: `delivery/FPC_EVIDENCE/`.

## 6. Bloqueos (declarados, no resueltos en silencio)

**B-1 · Superficie admin PROD.** R4 solo tiene retry/skip/diagnóstico/rollback-readiness en el Worker admin de
STAGING y prohíbe su equivalente en PROD. Sin una vía, un `FAILED_PERMANENT` en PROD detendría la línea de ese
Hub sin forma auditada de reanudarla, y el rollback completo R4 §6 no puede verificarse. Opciones (runbook
§7): **O1 recomendada** — cola de comandos firmada con HMAC, Worker admin sin superficie HTTP
(`workers_dev=false`, sin rutas), resultados por cola de respuestas en pull desde el NAS; O2 admin efímero; O3
admin tras Cloudflare Access. Requiere decisión del owner y una revisión nueva auditada.

**B-2 · Validación Edge → HUB_A no-trading.** Todo POST a `/webhook/<secret>` es una señal. No se ha aportado un
probe no-trading del ingress de R8.4 REV8 ni la garantía escrita de deduplicación por `signal_id` para un
cuerpo ya procesado. El contrato pedido al Hub exige además respuesta **2xx con `code: DUPLICATE`**: un
DUPLICATE no-2xx sería `FAILED_PERMANENT` y, sin B-1, detendría la línea HUB_A PROD sin vía de recuperación;
por eso **B-2 solo se aborda después de B-1** (F-15). Además, solo esa prueba demuestra que la seguridad de la zona `integrademia.com` (WAF,
Bot Fight Mode, Access) no desafía las peticiones de un Worker. `hub-check` no envía nada.

Mientras B-1 y B-2 sigan abiertos: `cutover-check` → BLOCKED, `cutover` se niega, TradingView sigue directo a
HUB_A. **Nada de este paquete toca HUB_A, su compose, sus volúmenes, sus puertos, el Tunnel ni el hostname.**

## 7. npm audit

Árbol completo: 10 (4 moderate, 4 high, 2 critical), todas en devDependencies de la toolchain de tests/build;
`--omit=dev`: 0. Ninguna llega a los Workers (el bundle solo contiene `src/**`). Sin `audit fix`: actualizar
vitest/vitest-pool-workers son cambios mayores del harness y exigen revisión propia. Detalle en
`ROOT_CAUSE_NAS_53_90.md §5`.

## 8. Límites

- No hay cuenta de Cloudflare en el entorno de construcción: el **gate físico real de STAGING** lo ejecuta
  `./kawa-edge install` en el NAS; aquí se probó el instalador de extremo a extremo contra un API simulado
  (con el wrangler fijado real) y los gates con un ensayo local fiel (salvo 5 gates de plataforma).
- Ejecutado en amd64; la imagen y el lockfile soportan arm64 pero no se ejecutó en arm64.
- Cutover bloqueado por B-1/B-2.
