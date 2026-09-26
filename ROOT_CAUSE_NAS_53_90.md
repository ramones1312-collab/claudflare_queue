# ROOT CAUSE · R4 «90/90 PASS» → 53 FAIL / 37 PASS en el Synology

**Artefacto analizado:** `KAWA_EDGE_SIGNAL_BUFFER_V1_3_0_R4_CANDIDATE_2026-09-22.zip`
(SHA-256 `1bcd1e3df8fba89781916efcaf173a45983f0566bb189d59e20929766db82867`, manifest 43/43 verificado).
**Corrección:** V1.3.1 R1 — un cambio en el *harness* de tests (`edge/vitest.config.js`). **Cero cambios en
código de producción, aserciones, escenarios o timeouts.**

---

## 1. Veredicto

| Hipótesis del encargo | Resultado |
|---|---|
| timeout artificial del harness | **No es la causa.** El timeout de 5000 ms de vitest solo es el *síntoma*: detecta un runtime bloqueado. |
| incompatibilidad Vitest / workerd | No. Misma toolchain pasa 90/90 con DNS sano. |
| rendimiento del filesystem bind-mounted del Synology | No. Reproducido sin bind mount de `node_modules`, y con 1 CPU / 1 GB pasa. |
| runtime / race / bug real del Edge | **No.** Ningún test falla por una aserción; todos por timeout, y todos pasan con la misma lógica de producción cuando el DNS responde. |
| **otra causa** | **SÍ: el harness no era hermético.** Cada halt del Sequencer hace una petición HTTP **real** a `HALT_NOTIFY_URL = https://halt-notify.test/hook` (configurado en `vitest.config.js`). Solo `scenario_halt_notify` intercepta `fetch`; en el resto, ~80 llamadas por ejecución salían del runtime como **búsquedas DNS reales** de `halt-notify.test`. Si el resolvedor del host contesta rápido (NXDOMAIN), no pasa nada. Si **no contesta** (típico de un NAS en red bridge con el DNS del router), la búsqueda queda colgada, y como **los 9 ficheros comparten UN solo runtime workerd**, el runtime entero se bloquea y tests que no tienen nada que ver con halts agotan los 5000 ms. |

## 2. Evidencia (reproducida en `node:22-bookworm-slim`, Node v22.23.3, npm 10.9.9, `npm ci` limpio)

| Ejecución (R4 sin cambios) | Resultado | Duración |
|---|---|---|
| red del host, DNS que responde | **90 passed** (9/9 ficheros) | 8.65 s |
| bridge por defecto (DNS 8.8.8.8 que falla rápido) | **90 passed** | 7.72 s |
| bridge con `--dns 192.0.2.1` (resolvedor que **no responde**) | **50 failed / 40 passed**, 8/9 ficheros, **50× `Test timed out in 5000ms`** | 101.92 s |
| Synology del usuario | 53 failed / 37 passed, 9/9 ficheros, `Test timed out in 5000ms` | 267.72 s |
| auditor externo independiente (R4 reconstruido, resolvedor agujero negro) | **60 failed / 30 passed**, 108× «vitest-worker Timeout calling…» (runtime bloqueado); con V1.3.1: 95/95 | — |

La firma coincide: todos los fallos son timeouts de ~5000–5011 ms, ninguno es una aserción. La diferencia 50 / 53 / 60
y 101 s vs 267 s es la esperable entre un resolvedor que no responde con 4 CPU y el del NAS con menos CPU
(los ficheros se reparten distinto entre workers).

**Prueba causal del bloqueo compartido** (misma imagen, `--dns 192.0.2.1`):

| Ficheros ejecutados | `scenario_reorder` (no provoca ningún halt ni DNS) |
|---|---|
| `scenario_reorder` solo | **3/3 PASS** en 668 ms |
| `scenario_reorder` + `scenario_dlq` en paralelo | **2/3 FAIL por timeout** (5001 ms) |

`scenario_reorder` no hace ninguna llamada de red. Falla **solo** cuando otro fichero del mismo runtime
bloquea en DNS. La traza de vitest lo confirma: `[vpw:inf] Starting single runtime for vitest.config.js...`
y el log de workerd registra 82 `DNS lookup failed … params.host = halt-notify.test` en una ejecución de R4.

## 3. Corrección (harness, justificada)

`edge/vitest.config.js` añade un `outboundService` de Miniflare: **toda** la salida de red del runtime de
tests se resuelve localmente.

- `halt-notify.test` → `204` local (un colector de notificaciones de prueba);
- cualquier otro host → error inmediato (igual que un NXDOMAIN), y se registra `[hermetic] blocked …`.

Por qué es legítimo y no «maquillaje»:

1. **No toca producción.** `src/**` es byte-idéntico a R4. En Cloudflare, `HALT_NOTIFY_URL` es un colector
   real; el comportamiento de `_notifyHalt()` no cambia.
2. **No toca la semántica de ningún test.** `scenario_halt_notify` sigue interceptando `fetch` dentro del
   isolate (el `outboundService` solo actúa si la petición sale del runtime); sus 4 tests siguen probando
   el reintento y la durabilidad del halt aunque la notificación falle.
3. **No sube timeouts ni salta nada.** El límite de 5000 ms de vitest queda igual.
4. **Test guardián nuevo** (`test/hermetic_egress.test.js`, 2 tests): falla si alguien quita el
   `outboundService` — probado por mutación: sin él, el test «collector answers locally» falla en
   cualquier host.

## 4. Verificación tras la corrección

| Entorno | Resultado |
|---|---|
| `--dns 192.0.2.1` (el caso del NAS) | **92/92 PASS** (90 R4 + 2 guardián) en 8.0 s |
| `--network none` (sin red alguna) | **92/92 PASS** en 7.5 s |
| `--cpus=2 --memory=2g` + DNS muerto | 92/92 PASS en 8.4 s, pico de memoria ~0.5 GB |
| `--cpus=1 --memory=1g` + DNS muerto | 92/92 PASS en 10.0 s; test más lento 1.87 s (margen 2.7× bajo 5000 ms) |
| imagen del instalador (rootfs read-only, uid no-root, sin red) | **95/95 PASS** (92 + 3 del test de consumidor V1.3.1) |

## 5. npm audit (sin cambios, sin `audit fix`)

Reproducido: `npm ci` informa 10 vulnerabilidades en el árbol completo (4 moderate, 4 high, 2 critical) y
`npm audit --omit=dev` → `found 0 vulnerabilities`. Todas están en **devDependencies** de la toolchain
(vitest 2.1.9 / @vitest/mocker / vite, esbuild ≤ 0.24.2 del servidor de desarrollo, devalue, miniflare,
@cloudflare/vitest-pool-workers ≤ 0.8.68). Ninguna llega a los Workers desplegados: wrangler empaqueta
solo `src/**` (sin dependencias de runtime). En el contenedor no hay servidor de desarrollo escuchando ni
puertos publicados. **No se actualizó ninguna dependencia**: hacerlo exige una revisión nueva re-auditada
(`vitest@5` / `vitest-pool-workers@0.22` son cambios mayores del harness).
