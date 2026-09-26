# RUNBOOK VIGENTE · KAWA Edge Signal Buffer V1.3.x · multi-destino

**Único runbook en vigor** a partir de V1.3.1 R1. Sustituye a `STAGING_RUNBOOK.md` (V1.2.x, retirado del
paquete; sigue archivado dentro del ZIP R4). La arquitectura de referencia sigue siendo
`edge/ARCHITECTURE_V1_3_0.md` y `edge/MIGRATION_AND_DEPLOYMENT_V1_3_0.md`; **los comandos de despliegue los
ejecuta el instalador**, siempre con `--config` explícito sobre configs generados. No hay que ejecutar
`wrangler` a mano en ningún paso.

Todos los comandos: por SSH en la carpeta del paquete, `sudo ./kawa-edge <comando>`.
Códigos de salida: `0 PASS` · `1 FAIL` · `2 BLOCKED` (falta una precondición; no se cambió nada que no se diga).

---

## 0. Invariantes que el instalador impone (y no se pueden desactivar)

| Invariante | Dónde se aplica |
|---|---|
| El Edge es transporte: nunca lee LONG/SHORT, sizing, stops, TTL ni lifecycle | código R4 sin cambios (`edge/src/**` byte-idéntico a R4) |
| STAGING y PROD son identidades separadas (`-stg` / `-prod`; DO, colas y Workers distintos) | `naming.mjs` + guardia `assertEnvIsolation()` en cada render |
| Un consumer STAGING solo puede llegar a **su** receptor STAGING (Service Binding) | render + preflight + test de equivalencia |
| Ningún config PROD tiene Service Binding, nombre `-stg` ni admin HTTP | render + preflight |
| Señales a HUB_A solo por `https://vector-hook.integrademia.com/webhook/<secret>` (8181 → 8081) | `validateWebhookUrl()`; **8180 / 8080 rechazados** en cualquier forma |
| El instalador nunca contacta al Hub, al NAS de HUB_A ni al Tunnel | no existe ningún código que lo haga; el contenedor no tiene red hacia la LAN del Hub más allá de Internet |
| Cada Hub: cola, DLQ, consumer, credencial, cabeza y halt propios | render (un consumer por destino, con solo su entrada de `DESTINATIONS`) |
| Un secreto de Hub nunca se reutiliza en otro | huella HMAC en `state/prod/webhook-fingerprints.json` |
| Conflicto o permiso insuficiente ⇒ **se detiene antes de escribir** | preflight (`RESOURCE_CONFLICT`, `CF_PERMISSION`, …) |
| Nunca borra ni recrea un recurso que no creó | marcador `KAWA_EDGE_MANAGED` leído de Cloudflare |

## 1. Mapa de fases

| Fase | Comando | Qué cambia en Cloudflare | TradingView |
|---|---|---|---|
| A · Preflight | `preflight [--env staging\|prod]` | nada | directo a HUB_A |
| B · STAGING | `install` | recursos `-stg` y receptores STAGING | directo a HUB_A |
| C · PROD en paralelo | `prod-deploy`, `hub-check HUB_A` | recursos `-prod`, **inertes** | directo a HUB_A |
| D · Cutover | `cutover-check`, `cutover` | rota el path token PROD y muestra la URL | **solo aquí** cambia (a mano, por el owner) |
| E · Más Hubs | `add-hub HUB_N --env staging\|prod` | cola/DLQ/consumer/secreto del nuevo Hub + ingress | sin cambio |

Estado de esta versión: **A y B completos; C despliega pero `hub-check` está BLOQUEADO (B-2); D está
BLOQUEADO (B-1, B-2).** Ver §9.

## 2. Fase A · Preflight (solo lectura)

`sudo ./kawa-edge preflight` (o `--env prod`). Comprueba, y se detiene en el primer fallo:

1. **Paquete:** manifest SHA-256 de cada fichero de la imagen (config/ y secrets/ quedan fuera: son tuyos).
2. **Toolchain:** Node ≥ 22, npm, **wrangler fijado** (versión del lockfile = binario), que no exista un
   `wrangler.toml` implícito.
3. **Configuración:** validada por el propio registro del Edge (`edge/src/destinations.js`), sin secretos.
4. **Aislamiento:** todos los nombres del plan pertenecen al entorno; hard-lock STAGING; forma PROD.
5. **Compilación offline:** `wrangler deploy --dry-run` de cada Worker del plan.
6. **Cloudflare:** token activo, cuenta, permisos de lectura (Workers Scripts, Queues), subdominio
   `workers.dev`.
7. **Recursos:** para cada cola y Worker del plan: `CREATE`, `REUSE`/`UNCHANGED`, `UPDATE` o **`CONFLICT`**
   (Worker con nuestro nombre sin marcador; cola con consumers/producers ajenos; cola pausada). Los
   recursos del otro entorno se listan y **no se tocan**.

## 3. Fase B · STAGING

`sudo ./kawa-edge install` = preflight → despliegue → gates. Orden de despliegue (dependencias):

1. colas y DLQ (`kawa-signal-buffer-hub-{a,b}[-dlq]-stg`; las 4 existentes se **reutilizan**);
2. receptores STAGING, **uno por Hub**: `kawa-staging-receiver-hub-a`, `…-hub-b`;
3. ingress + Sequencer (`kawa-edge-ingress-stg`, DO SQLite `EdgeSequencer`);
4. consumer HUB_A (`kawa-edge-delivery-hub-a-stg`) → Service Binding a `kawa-staging-receiver-hub-a`;
5. consumer HUB_B → `kawa-staging-receiver-hub-b`;
6. admin temporal (`kawa-edge-admin-stg`);
7. secretos: se suben con cada despliegue por `--secrets-file` en tmpfs (0600, destruido al terminar) y se
   verifican por **nombre** leyendo Cloudflare. Los tokens STAGING (path, control, admin) se generan
   aleatorios y se guardan solo en `state/staging/secrets.json` (0600) para poder repetir los gates;
8. gates físicos.

### 3.1 Gates STAGING (evidencia en `state/evidence/staging-gates-cloud-*.json`)

**Serie obligatoria:** todos actúan sobre el mismo Sequencer, colas y receptores, y varios dependen del
estado que deja el anterior (un halt, un backlog). El primer FAIL detiene la serie; la limpieza **siempre**
reanuda colas y devuelve los receptores a `ok` (también con Ctrl-C); si la limpieza falla, el resultado es FAIL.

| Gate | Verifica | Mecanismo físico |
|---|---|---|
| G00 | esquema 2, ambos destinos habilitados, sin halt ni pendientes | admin `/stats` |
| A | aceptación durable: 202 solo tras commit; digest = SHA-256 local; 1 señal → 2 entregas `E<n>:HUB_A`/`E<n>:HUB_B` | ingress + admin `/signal` |
| C | **reorder**: 5 alertas concurrentes → cada Hub las ve en orden de origen | receptores (orden real de recepción) |
| E | **burst** de 10 concurrentes, orden estricto por destino | idem |
| D | **duplicado** TradingView: dos `edge_seq`, mismo digest; cada Hub responde ACCEPTED y luego DUPLICATE | receptores |
| F | **respuesta perdida** en HUB_A: sin avance, reintento, DELIVERED; HUB_B no afectado | receptor `silent_once` |
| M | **caída del receptor** HUB_B (503) con 3 en vuelo: nada se pierde, orden estricto al recuperar | receptor `fail5xx_once` |
| ISO-X | **HUB_A caído / HUB_B sigue**; HUB_A se pone al día en orden | `queues pause-delivery` de la cola HUB_A |
| ISO-Y | **HUB_B caído / HUB_A sigue** (espejo) | idem cola HUB_B |
| ISO-XY | **ambos caídos**: señales durables; cada uno converge por su cuenta | pausa de ambas; reanuda B, luego A |
| G | **FAILED_PERMANENT + DLQ** en HUB_B (4xx permanente): halt solo de HUB_B; HUB_A entrega. Con Analytics:Read el backlog de la DLQ debe llegar a ≥ 1 (si no, FAIL); sin él la evidencia dice `verified:false` (registro probado por contrato, CASE H) | receptor `permanent4xx` |
| H | **N+1 bloqueado solo en HUB_B**; su backlog sigue durable (R21) | receptor sano, halt vigente |
| I | **admin retry** auditado: la alerta detenida y su backlog llegan en orden; sin `destination_id` → `DESTINATION_ID_REQUIRED`; `force` por HTTP → rechazado | admin `/retry` |
| J | **admin skip**: `ADMIN_SKIPPED`, la cabeza avanza, la alerta saltada nunca se acepta | admin `/skip` |
| L | **reinicio del DO** (redeploy del ingress) con una entrega pendiente: la secuencia continúa, nada se pierde; se exige que el id de despliegue del ingress **cambie** (prueba de reinicio) | `wrangler deploy` del ingress + API de despliegues |
| K | **corte > 5 min** (lease de redispatch): se recupera sin intervención | pausa 6 min (se omite con `--quick`) |
| BYTE | **byte a byte**: cada cuerpo recibido tiene el SHA-256 de lo enviado; `digest_mismatches = 0` | ledgers de los receptores |
| RB | **rollback-readiness** `ok:true`: todo drenado, sin halts | admin `/rollback-readiness` |

**GC:** el borrado físico solo ocurre con > 1000 señales por detrás (`GC_LAG`), así que en STAGING se
verifica la parte del contrato observable (H: el backlog de un destino en halt se conserva durable; RB) y
el borrado queda cubierto por los tests de workerd (`contract > 11b`, `R21`).

### 3.2 Operación STAGING

| Necesidad | Comando |
|---|---|
| estado de recursos + cabezas/halts del Sequencer | `status` |
| repetir los gates | `gates` (`--quick` omite el gate K de 6 min: resultado `PARTIAL`, **no** es STAGING PASS ni autoriza PROD) |
| STAGING sucio tras una ejecución interrumpida | `gates --repair` (skip auditado de halts y espera de drenaje) |
| colas que quedaron pausadas | `resume-queues staging` |
| ensayo local completo sin Cloudflare (Miniflare) | `rehearse` (13 gates; los 5 que exigen una operación de plataforma se marcan `CLOUD_ONLY`) |
| borrar STAGING (exporta antes la evidencia) | `staging-teardown` (pide escribir `DELETE STAGING`; `--queues` borra también las colas) |

## 4. Fase C · PROD en paralelo (HUB_A sigue operando)

`sudo ./kawa-edge prod-deploy`

- **Exige** una evidencia `STAGING PASS` de Cloudflare con **todos** los gates obligatorios en PASS (K
  incluido) para exactamente el mismo build: código del Edge (`src/**`), renderizador de configs y versión
  de wrangler. Una ejecución `--quick` o de otro build no vale. Sin ella: `BLOCKED`.
- Pide por prompt oculto:
  - la URL de notificación de halts PROD (https, sin puerto, **nunca** un host de Hub ni una ruta
    `/webhook/`; es la única salida del Sequencer que no pasa por un Service Binding);
  - `DEST_HUB_A_WEBHOOK_URL` = `https://vector-hook.integrademia.com/webhook/<WEBHOOK_SECRET>`. Se valida
    (https, host exacto, sin puerto, `/webhook/<secreto ≥ 16>`); **8180/8080 se rechazan**. Se sube como
    secreto **solo** del consumer de HUB_A y no se guarda en ningún sitio (solo una huella HMAC).
- Despliega: colas `kawa-signal-buffer-hub-a[-dlq]-prod` → `kawa-edge-ingress-prod` →
  `kawa-edge-delivery-hub-a-prod`. **Inerte**: ninguna alerta llega a él hasta el cutover, así que no
  envía nada a HUB_A. El path token PROD se genera aleatorio y **no se muestra** (se rota en el cutover).
- No despliega admin HTTP ni receptor en PROD (R4).
- Repetirlo no cambia nada (`UNCHANGED`); `--set-webhook HUB_A` o `--set-halt-notify` para cambiar ese
  secreto concreto. El path token del ingress PROD **solo** se rota en `cutover` (rotarlo en otro momento
  dejaría a TradingView sin Edge después del cutover).

`sudo ./kawa-edge hub-check HUB_A` → **BLOCKED (B-2)**. No envía nada.

`sudo ./kawa-edge status --env prod` → Workers/colas/secretos (por nombre)/backlog.

## 5. Fase D · Cutover

`sudo ./kawa-edge cutover-check` (no cambia nada):

| # | Precondición | Estado en V1.3.1 R1 |
|---|---|---|
| C1 | STAGING PASS en Cloudflare para este código | automático |
| C2 | PROD desplegado, gestionado, al día, secretos presentes | automático |
| C3 | Edge → HUB_A PASS por método no-trading | **BLOCKED · B-2** |
| C4 | vía PROD para retry / skip / FAILED_PERMANENT / rollback-readiness | **BLOCKED · B-1** |
| C5 | HUB_A GREEN | manual: el owner lo mira en la UI de HUB_A (8180) |
| C6 | colas PROD limpias | automático si el token tiene Analytics:Read |
| C7 | rollback documentado y ensayado | gate RB de STAGING |
| C8 | aprobación expresa del owner | se escribe en `cutover` |

`sudo ./kawa-edge cutover` se niega mientras haya un BLOCKED/FAIL. Cuando todo esté en verde (revisión
futura que resuelva B-1 y B-2): pide la frase `CUTOVER HUB_A APPROVED`, **rota** el path token del ingress
PROD y muestra **una vez** la URL `https://kawa-edge-ingress-prod.<subdominio>.workers.dev/webhook/<token>`.
El owner la pega en las alertas de TradingView. Nada más cambia: `vector-hook.integrademia.com`, el Tunnel
y los puertos de HUB_A siguen igual y pasan a ser el **destino** del Edge.

## 6. Fase E · Añadir HUB_B / HUB_C / HUB_N (sin tocar código)

```sh
sudo ./kawa-edge add-hub HUB_C --env staging [--timeout-ms 10000] [--disabled]
sudo ./kawa-edge add-hub HUB_B --env prod --webhook-host hub-b.midominio.com
```

1. Valida el id (`^[A-Z][A-Z0-9_]{0,31}$`) y la nueva lista con el registro del Edge.
2. Crea su cola y su DLQ; en STAGING, su propio receptor.
3. Despliega **su** consumer (PROD: pide **su** `DEST_<ID>_WEBHOOK_URL`; si coincide con el secreto de
   otro Hub → `WEBHOOK_SECRET_REUSED`).
4. Solo después actualiza el ingress (`DESTINATIONS` + productor), para que la cola nueva nunca acumule
   sin consumer.
5. **Guardia de radio de impacto:** si cualquier otro consumer o receptor tuviera que cambiar, se detiene
   (`ADD_HUB_COLLATERAL`). Los consumers de los demás Hubs **no se redespliegan**.
6. Actualiza `config/kawa-edge.json` (con copia `.bak-<fecha>`).
7. STAGING: envía una alerta sintética y comprueba que llega a todos los receptores, incluido el nuevo, y
   que la cabeza del nuevo Hub nace en esa señal (**sin histórico**). PROD: nunca se envía nada sintético.

**Deshabilitar un Hub:** `"enabled": false` en `config/kawa-edge.json` y `install` (STAGING) o
`prod-deploy` (PROD). La autoridad es el Sequencer: sus pendientes pasan a `DISABLED_SKIPPED` auditado y no
se publica nada a su cola (R4 §5).

## 7. Operación PROD de retry / skip / diagnóstico — **B-1**

R4 implementa `retry`, `skip`, `/signal`, `/stats` y `/rollback-readiness` **solo** en el Worker admin de
STAGING, y prohíbe expresamente desplegar su equivalente en producción. En PROD existen los métodos RPC del
Sequencer, pero ningún componente de R4 puede invocarlos. Por tanto, **hoy**:

- **Diagnóstico disponible:** notificación de halt a `HALT_NOTIFY_URL` (evento `EDGE_STREAM_HALTED` con
  `edge_seq`, `destination_id`, `reason`, digest); `./kawa-edge tail kawa-edge-delivery-hub-a-prod`
  (`EDGE_DELIVERY_ATTEMPT` con `disposition`/`reason`, redactado); backlog de colas.
- **Resolución NO disponible:** un `FAILED_PERMANENT` en PROD dejaría detenida la línea de ese Hub hasta
  que exista una vía de `retry`/`skip`. Por eso es bloqueo de cutover.

Opciones propuestas para decisión del owner (cualquiera es una revisión nueva auditada; ninguna está
implementada):

| Opción | Superficie pública | Resumen |
|---|---|---|
| **O1 (recomendada)** · cola de comandos firmada | **ninguna** | Worker `kawa-edge-admin-prod` con `workers_dev=false`, sin rutas, consumer de una cola `kawa-edge-admin-cmd-prod`. El NAS publica comandos (`stats`, `signal`, `retry`, `skip`, `rollback-readiness`) con la API de Queues, firmados con HMAC; el Worker verifica firma, `actor`, `reason`, `destination_id` obligatorio y rechaza `force`; resultados a una cola de respuestas leída por pull desde el NAS. |
| O2 · admin efímero | minutos, token de 256 bits | desplegar el admin de R4 solo durante un incidente y borrarlo al terminar. Contradice la letra de R4. |
| O3 · admin tras Cloudflare Access | hostname protegido por Zero Trust | requiere permisos de Access/Zone y un hostname; más piezas. |

## 8. Rollback

**a) Rollback inmediato de transporte** (`./kawa-edge rollback-transport` imprime la lista):
en TradingView, volver a poner en cada alerta `https://vector-hook.integrademia.com/webhook/<WEBHOOK_SECRET>`
(la URL actual, que tiene el owner). No se toca Tunnel, hostname, HUB_A ni puertos. Lo ya aceptado por el
Edge sigue entregándose en orden (at-least-once); HUB_A deduplica por `signal_id`.

**b) Rollback completo del Edge** (retirar el Edge PROD) — contrato R4 §6: detener la admisión, drenar
todas las colas y DLQ, `rollback-readiness ok:true` (`blockers: []`), resolver cada `FAILED_PERMANENT` con
retry/skip auditado (§3-bis de R4), y solo entonces retirar. **En PROD, la verificación de drenaje y la
resolución de FAILED_PERMANENT dependen de B-1.** En STAGING el procedimiento está ensayado (gates G, H, I,
J, RB).

**c) STAGING:** `staging-teardown` (exporta ledgers, borra Workers en orden de dependencias, conserva las
colas salvo `--queues`, borra los tokens STAGING).

Probado: gate RB (readiness en STAGING real), gates I/J (retry/skip), test E2E de teardown (orden y que
nada queda referenciado), test E2E de que `cutover` se niega.

## 9. Bloqueos declarados

| Id | Bloqueo | Qué desbloquea |
|---|---|---|
| **B-1** | no hay vía PROD para retry / skip / FAILED_PERMANENT / rollback-readiness dentro de R4 | decisión del owner entre O1/O2/O3 (§7) → revisión nueva |
| **B-2** | no hay método **no-trading** para validar Edge → HUB_A (auth + transporte). Todo POST a `/webhook/<secret>` es una señal | evidencia del contrato de R8.4 REV8: un probe no-trading en la ruta del ingress (8181/8081), **o** la garantía escrita de que re-POSTear un `signal_id` ya procesado devuelve `DUPLICATE` sin efecto de ejecución, más un cuerpo ya procesado. Después, una revisión nueva conecta `hub-check` a ese método |

**Por qué B-2 importa aunque STAGING pase:** en PROD el consumer llama a `vector-hook.integrademia.com`
desde un Worker de Cloudflare. Esa petición atraviesa la configuración de seguridad de la zona
`integrademia.com` (WAF, Bot Fight Mode, reglas de Access, rate limiting) de un modo distinto a como llega
TradingView hoy. Solo una prueba real Edge → HUB_A por un método no-trading demuestra que no hay un desafío
o bloqueo en ese camino. Si lo hubiera, el consumer lo vería como 403 → `FAILED_PERMANENT` de HUB_A (R4).

## 10. Pipeline para mantenimiento (desarrollo)

| Capa | Comando | Cuándo |
|---|---|---|
| A · fast preflight | `verify-fast` (~15 s) | tras cada edición |
| B · targeted | `test-targeted` (ficheros cambiados vs manifest) o `--files a,b` | tras cada corrección |
| C · full release gate | `test-full` (Edge en paralelo por fichero + deployer en paralelo por fichero) | antes de un RC |
| empaquetado | `package` (reutiliza la evidencia de C si el hash del árbol de entrada coincide; **no** re-ejecuta la suite) | una vez |
| D · verify-release | `verify-release dist/<zip>` | sobre el ZIP final, una vez |

Clasificación de suites: ver `TEST_REPORT_V1_3_1.md §3` (PARALLEL SAFE / SERIAL REQUIRED y por qué).
