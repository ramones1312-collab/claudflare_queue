# RESPUESTA A LA AUDITORÍA · KAWA Edge V1.3.1 R1 → R2 → **R3** (revisión entregada)

Veredicto auditado: `KAWA_EDGE_V1_3_1_R1_AUDIT_VERDICT.md` (SHA-256 `b3cd1bd1…4ea5`), evidencia
`KAWA_EDGE_V1_3_1_R1_AUDIT_EVIDENCE.zip` (SHA-256 `32e18b5a…3a58`). Veredicto: **FAIL** (P0 ×1, P1 ×5).

La revisión **R2** corrige todos los hallazgos que no dependen de una decisión del propietario. **El código de
producción del Edge (`edge/src/**`, receptor STAGING, admin) sigue byte-idéntico a R4**: ningún hallazgo
estaba en él (OBS-1 queda anotado, fuera de alcance). Todo cambio está en el instalador, el lanzador, las
herramientas de release o la documentación.

Regla usada: cada corrección lleva un test que **falla sin la corrección** (se reprodujo el escenario del auditor
cuando lo había) y pasa con ella. Nada se relajó, saltó ni reinterpretó.

## P0 / P1

| ID | Corrección R2 | Test de regresión | Estado |
|---|---|---|---|
| **F-01** P0 | `edgeVerdict`: PASS solo si exit 0, `success`, ninguna suite fallida y **cada fichero `*.test.js` del disco se ejecutó y pasó**; `deployerVerdict`: exit 0, >0 tests, 0 fallos. `testFull` = `edge.ok && dep.ok` (`deployer/lib/release.mjs`) | `release-gate.test.mjs`: vitest **real** con un fichero que lanza al importar → FAIL (reproduce el escenario del auditor); fichero no ejecutado → FAIL; exit≠0, 0 tests, parciales → FAIL | CERRADO |
| **F-02** P1 | Lanzador: rechaza `state/`, `secrets/`, `config/` si son enlaces o contienen enlaces; `find … -exec chown -h` (nunca sigue un enlace); sello `state/.image-manifest` escrito a fichero temporal + `mv` (atómico, reemplaza el enlace, no lo sigue); rechaza carpeta de root (el contenedor nunca corre como uid 0; C-09) | `launcher.test.mjs`: escenario del auditor portado (enlace en cada ubicación → rechazo, objetivo intacto), carpeta limpia, carpeta de root | CERRADO |
| **F-03** P1 | `add-hub --env prod` pasa por **la misma puerta** que `prod-deploy` (`requireStagingPass`) inmediatamente tras leer el contexto, antes de cualquier guardia o escritura (`deployer/lib/addhub.mjs`) | `e2e-prod-gate.test.mjs` «add-hub --env prod is gated exactly like prod-deploy (F-03)»: sin STAGING PASS, Hub no probado y (R3) **código cambiado tras el STAGING PASS** (binding distinto, el caso del auditor) → BLOCKED, 0 escrituras PROD | CERRADO |
| **F-04** P1 | Evidencia firmada con HMAC-SHA256 (clave local `state/.evidence-key`, 0600, generada en el NAS; nueva `deployer/lib/evidence.mjs`). La lista de gates obligatorios es `CLOUD_GATE_IDS` **del código** (18, congelada), no la del fichero. PROD exige: firma válida, los 18 gates PASS, `cleanup_errors` vacío, gate G `dlq.verified: true`, gate K `dispatch_attempts ≥ 2`, mismo binding, misma cuenta, todos los destinos PROD probados con los mismos `timeout_ms`/reintentos, y **corroboración en vivo**: los Workers STAGING en Cloudflare siguen ejecutando los builds certificados. La evidencia de tests también va firmada y `package` rechaza evidencia sin firma (`EVIDENCE_UNSIGNED`). **Corregido en R3 (N-2):** en R2 `verify-release` no comprobaba esa firma; ahora la comprueba donde existe la clave y fuera de ella avisa de que no es verificable. **Límite:** la clave HMAC es local a la instalación que ejecutó las pruebas; no es una firma verificable por terceros. El ancla de integridad para terceros es el `.sha256` entregado aparte y la garantía independiente es el gate físico | `e2e-prod-gate.test.mjs` (ninguna, sin firma, gate ausente, lista de gates propia del fichero, cleanup_errors, DLQ no verificada, K sin redispatch, otro binding, otra cuenta, destino no probado, build no corroborado → todos BLOCKED con 0 escrituras PROD); `release-integrity.test.mjs` F-04; `runner.test.mjs` «the gate list PROD requires is the one defined in code» | CERRADO |
| **F-05** P1 | `bindingHash` cubre **todo** `deployer/lib/**` (incl. `config.mjs`, gates, render, naming), `edge/src`, `staging-receiver/src`, `admin-worker/src`, `edge/package-lock.json` y la versión de wrangler. La configuración del operador y la cuenta se comprueban aparte (destinos y `account_id` de la evidencia) | `e2e-prod-gate.test.mjs` (binding distinto, destino con otro timeout); `release.test.mjs` evidence binding | CERRADO |
| **F-06** P1 | `verify-release` inspecciona la **lista cruda** de entradas del ZIP: toda entrada bajo `kawa-edge-nas/` (`ZIP_ENTRY_OUTSIDE_ROOT`), ninguna prohibida (`secrets/*` salvo README, `config/kawa-edge.json`, `state/`, `node_modules`, `.env`, `.dev.vars`, `.npmrc` → `FORBIDDEN_FILES`), ninguna fuera del manifiesto (`ZIP_ENTRIES_NOT_MANIFEST`). Hash esperado obligatorio (`.sha256` o `--sha256`; si no, `ZIP_SHA_UNKNOWN`) | `release-integrity.test.mjs`: ZIP del auditor (token + config) → FAIL; entrada fuera de raíz → FAIL; sin `.sha256` → FAIL; paquete limpio → PASS | CERRADO |

## P2

| ID | Corrección / tratamiento | Test | Estado |
|---|---|---|---|
| F-07 | Destinos ≠ HUB_A: se rechaza **cualquier host del dominio** de HUB_A (`integrademia.com` y subdominios), como en `validateHaltUrl` | `secrets.test.mjs` F-07 | CERRADO |
| F-08 | Antes de un CREATE de Worker: `GET …/scripts/<name>/settings` debe ser 404 (`scriptExists`); si existe y no es nuestro → conflicto, 0 escrituras (también cierra D-05) | `e2e-failclosed.test.mjs` (Worker ajeno oculto del listado) | CERRADO |
| F-09 | Paginación de colas y scripts por `page`/`total_count`/`total_pages`, no por «página corta» | `e2e-failclosed.test.mjs` (cola con consumer ajeno en una página posterior, 2 por página) | CERRADO |
| F-10 | **Declarado + control**: redesplegar un ingress PROD existente exige teclear `REDEPLOY PROD INGRESS` (o `--confirm-ingress-redeploy`) tras un aviso explícito de pérdida posible de una alerta; RUNBOOK corrige «TradingView: sin cambio» | `e2e-prod.test.mjs` (sin confirmación → nada cambia) | DECLARADO (riesgo heredado de R4; no se toca el Edge) |
| F-11 | Causa encontrada: el enlace `node_modules/.vite` del workspace apuntaba a un directorio inexistente y vitest salía con 1 tras 95/95. `edgeWorkspace` crea el destino. `files` = ficheros de test (11), no bloques `describe` | `release-gate.test.mjs` (vitest real, exit 0 exigido) | CERRADO |
| F-12 | Exclusiones del manifiesto solo en la **raíz**; un enlace simbólico en el árbol hace fallar el manifiesto | `release-integrity.test.mjs` F-12 | CERRADO |
| F-13 | La ruta de éxito de `cutover` hace `writeBuild` antes de `wrangler deploy --config <ruta>` (`rotateProdPathToken`) | `e2e-cutover-rotate.test.mjs` (ruta de éxito ejecutada directamente con wrangler real) | CERRADO (sigue inalcanzable por B-1/B-2) |
| F-14 | **Declarado y procedimentado**: ventana de doble ruta en cutover/rollback (RUNBOOK §5/§8: C5 cola PROD vacía y C6 backlog 0 antes de cambiar la URL; en rollback, no reanudar backlog Edge después de señales directas más nuevas sin decisión del operador) | — (procedimiento) | DECLARADO |
| F-15 | **Declarado**: B-2 depende de B-1 (un probe con DUPLICATE no-2xx sería `FAILED_PERMANENT` sin vía de recuperación en PROD). El contrato pedido al Hub para B-2 exige 2xx + `code: DUPLICATE`; B-2 solo se aborda después de B-1 (RUNBOOK §9) | — | DECLARADO |
| F-16 | Gate G registra `{readable, value}`; si la métrica no es legible `dlq.verified: false`, y **eso no autoriza PROD**. *Account Analytics: Read* pasa a ser obligatorio para PROD (`CLOUDFLARE_API_TOKEN.md`) | `e2e-prod-gate.test.mjs`; `runner.test.mjs` backlog | CERRADO |
| F-17 | Gate K exige `dispatch_attempts ≥ 2` (prueba real de la lease de redispatch), no «ACCEPTED ×1» | `e2e-prod-gate.test.mjs` (K sin redispatch → BLOCKED) | CERRADO |
| F-18 | Huella anti-reutilización sobre el secreto **decodificado**; `%` en el secreto de path rechazado | `secrets.test.mjs` C-02/C-07/F-18 | CERRADO |

## P3

| ID | Corrección | Estado |
|---|---|---|
| F-19 | CHANGELOG con el recuento real (ver TEST_REPORT §1) | CERRADO |
| F-20 | El `.sha256` publica dos líneas: hash del ZIP y hash de `MANIFEST_SHA256_V1_3_1.json`; `verify-release` comprueba la segunda y `verify-zip` lee la primera (test de lanzador con sidecar de dos líneas) | CERRADO |
| F-21 | `r4-equivalence.test.mjs` compara el **config completo** de los 6 configs STAGING (lector de wrangler) y exige que las únicas diferencias sean los deltas declarados | CERRADO |
| F-22 | C-02 URL de halt: IP literales rechazadas; C-05 aviso si falta el almacén de huellas con PROD desplegado; C-06 redacción sin distinción de mayúsculas; C-07 `?`/`#` vacíos rechazados; C-08 quitada la línea `# syntax=` (sin frontend remoto sin digest); C-09 carpeta de root rechazada (la red de proyecto propia **ya estaba en R1**; sigue siendo un bridge con NAT que podría alcanzar la LAN: la protección es que el deployer no abre esas conexiones, declarado); D-08 `resume-queues`/teardown comprueban propiedad; D-10 wrangler ejecutado con `process.execPath` + ruta fija, no por PATH | CERRADO |
| F-23 | D-05 (ver F-08); D-09 digest de build independiente de la ruta; H-08 el marcador `<WEBHOOK_SECRET>` ya no se oculta; H-09/H-10 workspace de tests `mkdtemp` corto (ruta < 94); H-15 `cutover` re-verifica el manifiesto (`localChecks`) y C5 exige teclear `HUB_A IS GREEN`; E-05 gate L exige ids previo y nuevo no nulos y distintos; E-06 ISO-XY exige 2 destinos; E-07 0 gates = FAIL; E-08 backlog sin filas = desconocido (nunca 0); E-10 G00/RB sobre todos los Hubs; E-12 evidencia corrupta → motivo, no `SyntaxError`. **H-16 declarado**: PROD no se ejercita antes de la primera señal real (depende de B-2) | CERRADO / H-16 DECLARADO |
| F-24 | Tiempos del informe tomados de la evidencia empaquetada; cita corregida a TEST_REPORT §5; script del experimento de alarma entregado (`deployer/test/experiments/alarm-restart.mjs`); fila M del RUNBOOK corregida (un único 503) | CERRADO |
| OBS-1 | `_notifyHalt` sin timeout: anotado para una revisión futura del Edge. No se toca `edge/src` (R4 congelado) | FUERA DE ALCANCE |

## Bloqueos que siguen abiertos (decisión del propietario)

- **B-1** · no existe en R4 una vía PROD segura de retry/skip/diagnóstico sin admin HTTP público.
  Recomendación: O1, cola de órdenes firmadas consumida por el propio Edge (nueva revisión del Edge, auditada).
- **B-2** · no hay un método no-trading para validar Edge → HUB_A. Contrato ampliado requerido al Hub (2xx +
  `code: DUPLICATE`, sin efecto de trading, identificable). Solo después de B-1 (F-15).

Mientras sigan abiertos, `cutover-check` da BLOCKED y TradingView sigue directo a HUB_A. STAGING y el despliegue
PROD inerte en paralelo sí están listos.

## A3/A4 (identidad frente al ZIP R4 original)

El auditor comparó contra el manifiesto R4 que viaja en la candidata. Para cerrarlo de forma independiente
hay que entregarle `KAWA_EDGE_SIGNAL_BUFFER_V1_3_0_R4_CANDIDATE_2026-09-22.zip`
(SHA-256 `1bcd1e3df8fba89781916efcaf173a45983f0566bb189d59e20929766db82867`).

## R3 · re-auditoría independiente de R2

Una re-auditoría independiente de R2 (antes de entregarlo) no encontró P0/P1. Dio F-02 y F-04 como PARCIALES por
dos P2 nuevos y encontró 4 P3 y las tres afirmaciones exageradas corregidas arriba (F-03, F-04, C-09). R2 no se
entregó; **R3** corrige todo:

| Id | Sev | Hallazgo | Corrección R3 | Test (falla sin la corrección) |
|---|---|---|---|---|
| N-1 | P2 | el sello `state/.image-manifest` escrito por root tras el build: un enlace a directorio plantado durante el build hacía que `mv` escribiera fuera del paquete | root ya no escribe ningún fichero: el manifiesto de la imagen se lee de la imagen | `launcher.test.mjs` «as root, writes nothing into state/» |
| N-2 | P2 | `verify-release` aceptaba evidencia empaquetada sin firma | firma comprobada donde existe la clave; aviso explícito donde no | `release-integrity.test.mjs` N-2 |
| N-3 | P3 | `chown -h` de root seguía enlaces duros | solo `-user 0`, directorios o ficheros con 1 enlace; `chmod` sin seguir enlaces | `launcher.test.mjs` N-3 |
| N-4 | P3 | un destino deshabilitado en STAGING contaba como probado para PROD | exigido `enabled` en la ejecución probada | `e2e-prod-gate.test.mjs` caso N-4 |
| N-5 | P3 | línea del manifiesto opcional; nombres duplicados; bytes fuera del directorio central | línea obligatoria; duplicados rechazados; las entradas deben cubrir el fichero de 0 al directorio central; cabecera local = nombre central | `release-integrity.test.mjs` N-5 ×2 |
| N-6 | P3 | clave vacía o no hex → HMAC con clave vacía | clave de 32 bytes hex obligatoria | `release-integrity.test.mjs` N-6 |
| N-7 | P3 | el README ejecutaba `sudo ./kawa-edge verify-zip` desde el ZIP aún sin verificar | `sha256sum -c` del sistema **antes** de extraer | documentación |

Residuo de F-05 (P3) también cerrado en R3: el binding incluye ahora `deployer/cli.mjs`, `edge/package.json` y el
`Dockerfile` (`release.test.mjs` «F-05 · the STAGING binding covers …», que cambia cada fichero y exige otro hash).

Residuo declarado: en sistemas sin `touch -h`, `refresh-context` podría seguir un enlace que el **propio dueño**
de la carpeta cambie en el instante entre `find` y `touch` (fuera de las carpetas que monta el contenedor; el dueño
es quien ya ejecuta el lanzador con sudo).
