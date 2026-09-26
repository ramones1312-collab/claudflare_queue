# KAWA Edge V1.3.1 · R3.1 · evidencia focalizada (R3-01, R3-02, R3-03, R3-07; B-1/B-2)

Base: R3 exacta (commit `28652fa`, ZIP `ce1405d5…ce3a`), auditada **PASS WITH OBSERVATIONS**
(`KAWA_EDGE_V1_3_1_R3_AUDIT_VERDICT.md`, SHA-256 `1c29ff98…8b43`). Solo cambian los ficheros de estas correcciones;
`edge/src/**`, receptor, admin y tests del Edge siguen byte-idénticos a R4.

## Artefacto final

| | |
|---|---|
| ZIP | `KAWA_EDGE_SIGNAL_BUFFER_V1_3_1_NAS_R3.1_2026-09-26.zip` |
| SHA-256 ZIP | `4a67a7945bbe91afdc020c4264f6d6b61014e3d5960e08aa3a7d5a5dc0e7461d` (línea 1 del `.sha256`) |
| SHA-256 manifiesto | `1017623986eb38857d7323216e75f7c13cab1afddaf28894be4a9145b8a7c176` (línea 2; 102 ficheros) |
| Huella de entradas de tests | `b6b950ae3810a830…` (`TEST_EVIDENCE_V1_3_1.json`) |
| Construcción | `git archive` del commit en un directorio vacío → imagen desde ese árbol → `test-full` → `package` allí (manifiesto y evidencia fuera del árbol fuente hasta este paso) |

## Por corrección

| Id | Reproducción del fallo en R3 | Test que falla con R3 | PASS después | Regresión de lo tocado |
|---|---|---|---|---|
| **R3-01** nombres de entrada ZIP | `focused_before_R3.txt`: con el código de R3, un ZIP con `kawa-edge-nas/./secrets/…` declarado en el manifiesto **pasa** `verify-release` | `release-integrity` «R3-01 · equivalent spellings…» (9 variantes: `./`, `//`, `/./`, `\`, `..`, `/` final; en `secrets/`, `config/`, `state/`, `node_modules/`) → **not ok** con R3 | `ZIP_ENTRY_NOT_CANONICAL` en las 9 (`focused_after.txt`) | `release-integrity` 14/14; `verify-release` del ZIP final PASS |
| **R3-02** anclaje de la suite del deployer | `R3-02_repro.txt` (script `R3-02_repro.mjs`): las variantes D2 (0 tests), D3 (`process.exit(0)` a mitad) y D7 (test condicional) → puerta de R3 **PASS 3/3**; puerta nueva **FAIL** («0 of N expected tests reported») | `release-gate` «R3-02 · … D2/D3/D7 are FAIL with real node:test» → not ok con R3 | 4/4 | `test-full` Edge 95/95 + deployer **84/84** con el ancla por fichero (`expected-tests.json`) |
| **R3-03** orden de la evidencia STAGING | `focused_before_R3.txt`: con R3, PASS válido + run **FAIL posterior** del mismo build → `prod-deploy` autorizado | `e2e-prod-gate` «R3-03 · the most recent Cloudflare run of the same build governs; an old PASS expires» → not ok con R3 | FAIL/PARTIAL más reciente → BLOCKED; PASS de 8 días → BLOCKED («older than 7 days»); 0 escrituras PROD | `e2e-prod-gate` 3/3, `e2e-prod`, `e2e-prod-locks`, `e2e-cutover-rotate` |
| **R3-07** procedimiento de doble ruta | R3: RUNBOOK C9 («drenar antes») contradice §8a y `rollback-transport` («dejar que el Edge siga entregando»); `cutover-check` no emitía C9 | `e2e-prod` (asserts de C9 y del texto único en `cutover-check` y `rollback-transport`) → not ok con R3 | un único texto en código (`ROUTE_SWITCH_PROCEDURE`) que imprimen `cutover-check` (C9), `cutover` (frase `ROUTE SWITCH WINDOW READY`) y `rollback-transport`; RUNBOOK §5/§8/§9 remiten a él | `e2e-prod` 1/1 |
| **B-1 / B-2** | — | — | **NO CODIFICADO (STOP)**: ver abajo | `cutover-check` / `cutover` siguen BLOCKED en C3/C4 |

Resumen: `focused_before_R3.txt` = 5 not ok con el código de R3 exacto; `focused_after.txt` = 22/22.

## Pipeline sobre el artefacto final

| Paso | Resultado |
|---|---|
| `test-full` en la imagen construida desde la exportación limpia | PASS · Edge 95/95 (11/11, exit 0) · deployer 84/84 (exit 0) · 120.3 s (`test-full_clean-export.log`) |
| `verify-release` | PASS · 103 entradas canónicas = manifiesto + él mismo · firma de la evidencia verificada en la instalación que la produjo |
| **Gate físico**: directorio vacío nuevo, `sha256sum -c` antes de extraer, carpeta de uid 1026:100, imagen desde el ZIP extraído (manifiesto dentro = publicado), lanzador | `verify-fast` PASS 14.9 s · `test-full` PASS 120.7 s, misma huella `b6b950ae…` (`physical-gate_*.log`) · total 168 s |

`rehearse` no se repitió: R3.1 no toca los gates ni su runner (último PASS en R3: 13 + 5 CLOUD_ONLY).

## B-1 / B-2 · STOP (no codificado)

La instrucción pide resolverlos «únicamente conforme al contrato ya acordado». **No existe ese contrato en lo
entregado a esta revisión**:

- **B-1** (vía PROD de retry/skip/diagnóstico): la opción recomendada O1 (cola de órdenes firmadas consumida
  por el Edge) **nunca se aprobó**, y aplicarla exige cambiar el Edge (`edge/src`, nuevo consumer/admin) y abrir
  una revisión auditada del Edge. Eso es ampliar capacidades y tocar el core, prohibido en esta ronda.
- **B-2** (validación no-trading Edge → HUB_A): depende del Hub R8.4 REV8. Hace falta que el owner aporte el
  contrato del Hub: probe no-trading, o garantía escrita de deduplicación con **2xx + `code: DUPLICATE`** para un
  cuerpo ya procesado. Además va **después** de B-1 (F-15).

Para desbloquearlos: (1) decisión escrita del owner sobre B-1 (O1/O2/O3) y (2) el contrato del Hub para B-2.
Con eso se abre una revisión del Edge dedicada. Hasta entonces `cutover` sigue BLOCKED y TradingView sigue
directo a HUB_A. **STAGING puede instalarse y probarse una sola vez con este ZIP; PROD inerte en paralelo
también, sin cutover.**

## P3 abiertos a propósito

R3-04, R3-05 (el anclaje de R3-02 ya no usa el recuento de texto), R3-06, R3-08 (salvo lo que toca R3-07),
R3-09, R3-10…R3-16: fuera del alcance de esta ronda, sin cambios.
