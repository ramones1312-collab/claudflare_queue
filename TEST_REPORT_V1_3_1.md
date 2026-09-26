# KAWA VECTOR · EDGE SIGNAL BUFFER V1.3.1 R1 — TEST REPORT

**Identidad:** `edge-signal-buffer-v1.3.1-nas` · R1 · **Linaje:** V1.3.1 ← V1.3.0 R4 CANDIDATE
**Entorno de referencia (NAS-equivalente):** imagen `kawa-edge-deployer:1.3.1-nas-r1`
(`node:22-bookworm-slim@sha256:43ac6c60…772c`, Node 22, wrangler 4.132.0, vitest 2.1.9,
@cloudflare/vitest-pool-workers 0.5.40), contenedor con rootfs **read-only**, uid **no-root**,
`cap_drop: ALL`, red bridge **sin salida**, host de 4 vCPU. Resultados exactos, evidencias y tiempos
del RC en `TEST_EVIDENCE_V1_3_1.json` (ligado por hash a los bytes del paquete) y en
`RELEASE_REPORT_V1_3_1.md §4`.

---

## 1. Resultado

| Suite | Tests | Resultado |
|---|---|---|
| Edge · workerd (vitest) · 90 tests de R4 **sin modificar** | 90 | PASS |
| Edge · guardián de red hermética (nuevo) | 2 | PASS |
| Edge · consumer con solo su entrada de `DESTINATIONS` (nuevo) | 3 | PASS |
| **Edge total** | **95** | **95/95 PASS** |
| Deployer · unit (render, aislamiento, config, secretos, URL de halts, redacción, release tooling, runner de gates, backlog, id de despliegue) | 27 | PASS |
| Deployer · equivalencia semántica con los TOML de R4 (lector de wrangler) | 3 | PASS |
| Deployer · E2E instalador (CLI real + wrangler fijado vs API Cloudflare simulado) | 16 | PASS |
| **Deployer total** | **46** | **46/46 PASS** |
| Ensayo local de gates STAGING (Miniflare, bundles exactos) | 13 ejecutados + 5 `CLOUD_ONLY` | PASS |
| Gate físico sobre el ZIP final (imagen construida desde la carpeta extraída, lanzador `./kawa-edge`, uid 1026:100) | verify-fast + test-full + rehearse | PASS |

**Ningún test de R4 se modificó, se saltó ni se relajó.** Ningún timeout se aumentó.

## 2. La regresión del NAS (53/90), reproducida y cerrada

Ver `ROOT_CAUSE_NAS_53_90.md`. Resumen de la matriz:

| Entorno | R4 | V1.3.1 |
|---|---|---|
| DNS que responde | 90/90 | 92/92 (+ guardián) |
| `--dns 192.0.2.1` (DNS que no responde, como el NAS) | **50 fail / 40 pass**, 102 s | **92/92** en 8.0 s |
| `--network none` | — | 92/92 |
| `--cpus=1 --memory=1g` + DNS muerto | — | 92/92 en 10.0 s (test más lento 1.87 s) |

Mutación: al quitar el `outboundService`, el test guardián falla en cualquier host.

## 3. Clasificación de paralelismo

| Suite | Clase | Por qué |
|---|---|---|
| Edge · entre ficheros | **PARALLEL SAFE** (por defecto) | cada fichero corre en su propio isolate; cada escenario usa su propio stream (`SEQUENCER_NAME` único) y sus propias colas/receptores; el parche de `globalThis.fetch` de `scenario_halt_notify` es por isolate; tras V1.3.1 no hay egress compartido |
| Edge · dentro de un fichero | **SERIAL REQUIRED** | `scenario_halt_notify` parchea `globalThis.fetch` durante cada test; varios ficheros comparten contadores de módulo del harness. Es el comportamiento por defecto de vitest |
| Deployer · entre ficheros | **PARALLEL SAFE** | cada escenario E2E levanta su propio API simulado (puerto efímero) y su propio sandbox (config, state, secrets, runtime, build) |
| Deployer · dentro de un fichero | serial (por defecto de node:test) | independientes, pero el paralelismo entre ficheros ya satura 4 vCPU (cada escenario ejecuta wrangler) |
| Deployer · runner de gates (`runner.test.mjs`) | PARALLEL SAFE | objetivo falso en memoria, sin red |
| Gates STAGING (Cloudflare y ensayo) | **SERIAL REQUIRED** | mismo Sequencer, colas y receptores; G→H→I→J dependen del halt y el backlog que deja el anterior; los gates de orden no pueden compartir receptor con otra carga |

Efecto medido de pasar el E2E del deployer de 1 fichero serial a 5 ficheros paralelos: **135 s → 49 s**
con el mismo número de escenarios y las mismas aserciones (más dos aserciones nuevas: segundo
`prod-deploy` sin escrituras; `add-hub HUB_B --env prod` no toca el consumer de HUB_A).

## 4. Qué demuestra el E2E del instalador

Estado inicial = el real del usuario: **las 4 colas STAGING ya existen, ningún Worker**.

| Escenario | Demuestra |
|---|---|
| install desde el estado real | reutiliza las 4 colas (0 creadas); despliega receptores → ingress → consumer A → consumer B → admin; cada Worker recibe **solo sus** secretos (por nombre); los consumers STAGING ninguno; el token de API y los secretos generados **no aparecen** en disco, logs, informes ni salida; `state/staging/secrets.json` es 0600; nada `-prod` tocado; la **segunda ejecución no escribe nada** (6× `unchanged`) |
| cuenta vacía | crea las 4 colas **antes** de cualquier Worker |
| 5 × fail-closed | Worker ajeno con nombre del Edge, cola con consumer ajeno, cola pausada, sin subdominio `workers.dev`, token caducado → `exit 1`, **cero escrituras** |
| permiso Queues:Edit ausente | el error nombra exactamente `Account · Queues · Edit`; ningún Worker desplegado |
| token erróneo | `TOKEN_INVALID` antes de nada |
| add-hub HUB_C (STAGING) | toca **solo** cola/DLQ/receptor/consumer de HUB_C y el ingress (orden: receptor → consumer → ingress); config actualizado con copia; repetirlo se rechaza sin escribir |
| PROD sin STAGING PASS, o con una ejecución `--quick` (PARTIAL) | `BLOCKED`, cero escrituras |
| URL de halts PROD apuntando a HUB_A | `HALT_URL_IS_HUB`, nada desplegado |
| PROD con 8180 en la URL | `HARD_LOCK_CONTROL_PORT`, nada desplegado |
| prod-deploy | despliega `kawa-edge-ingress-prod` y `kawa-edge-delivery-hub-a-prod` (inerte), el secreto de HUB_A solo en su consumer, sin Service Binding; STAGING intacto; el secreto no se imprime ni persiste (ni un digest); segundo `prod-deploy` sin escrituras; `--set-halt-notify` cambia solo esa URL y **no** rota el path token; HUB_B con el **mismo** secreto → `WEBHOOK_SECRET_REUSED`; HUB_B con el suyo → se añade **sin tocar** el consumer de HUB_A; `cutover-check` → C3/C4 `BLOCKED`; `cutover` → rechazado |
| staging-teardown | borra solo Workers gestionados, **dependientes primero** (nada queda referenciado), conserva las colas, borra los tokens STAGING; con el token mínimo el listado KV de wrangler recibe 403 y se omite |

Los prompts ocultos se prueban a través de un **pseudo-terminal real** (`script`), no con un atajo.

## 5. Ensayo local de los gates STAGING

`./kawa-edge rehearse` levanta la topología STAGING completa (2 receptores, ingress + DO, 2 consumers,
admin) en Miniflare desde **los mismos configs generados y los mismos bundles** de
`wrangler deploy --dry-run`, y ejecuta el runner de gates real.

| Ejecutados y PASS | CLOUD_ONLY (solo contra Cloudflare) |
|---|---|
| G00, A, C, E, D, F, M, G, H, I, J, BYTE, RB | ISO-X, ISO-Y, ISO-XY, L, K |

Por qué 5 son solo-Cloudflare (probado, no supuesto): pausar una cola o redesplegar exige reiniciar el
runtime local; el broker de colas de Miniflare es solo memoria (se pierden copias en vuelo) y un workerd
local reiniciado **conserva la marca de tiempo de la alarma del DO pero nunca la dispara**
(experimento mínimo: alarma armada, reinicio, 7 s después `n=0` con la alarma aún «pendiente»). Sin
reinicio, la alarma de redispatch del Sequencer real se disparó exactamente a los 300 s
(`dispatch_attempts 1 → 2`), así que el código del Edge es correcto; la limitación es del emulador.

## 6. Límites declarados

- **Sin cuenta de Cloudflare en este entorno.** El E2E usa un API simulado fiel a los endpoints que el
  wrangler fijado llama; el gate físico real de STAGING lo ejecuta `./kawa-edge install` en el NAS.
- **Edge → HUB_A no probado** (B-2) y **operación PROD de retry/skip inexistente** (B-1): ver runbook §9.
- NAS ARM64: la imagen base y el lockfile son multi-arquitectura (workerd/esbuild `linux-arm64`), pero
  solo se ha ejecutado en amd64.
