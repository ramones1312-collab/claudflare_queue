# Contexto para la re-auditoría · KAWA Edge Signal Buffer V1.3.1 **R3.2** (NAS turnkey)

R3.2 responde a su veredicto **PASS WITH OBSERVATIONS** sobre R3 (`KAWA_EDGE_V1_3_1_R3_AUDIT_VERDICT.md`,
SHA-256 `1c29ff986b5a477dfcfd66134153be41698345f7008f0dc114ac6bdf56e18b43`). El contexto del sistema, las
restricciones y el formato de veredicto no cambian (`AUDITOR_BRIEF_V1_3_1.md`, `AUDITOR_BRIEF_R3.md`).

Hubo una revisión intermedia, **R3.1**, que cerró solo R3-01, R3-02, R3-03 y R3-07 por instrucción del líder.
**R3.2** añade el cierre de todos los P3 restantes (R3-04…R3-16) por instrucción del owner. Se audita R3.2.

## Contenido de este paquete

| Ruta | Qué es |
|---|---|
| `release/KAWA_EDGE_SIGNAL_BUFFER_V1_3_1_NAS_R3.2_2026-09-26.zip` | el artefacto a auditar |
| `release/…zip.sha256` | línea 1: ZIP `ebd7dfd22fdbcdd4dc12393b6f1a8b32d7409f9257b5c65722a563b657890b4b`; línea 2: manifiesto `43dc60b07e5ad71e479f0dcbaea28472aa3d08d1f059ed8421f5a88faa947c41` |
| `release/MANIFEST_SHA256_V1_3_1.json` | copia del manifiesto que va dentro del ZIP (103 ficheros) |
| `reports/` | `RELEASE_REPORT`, `TEST_REPORT`, `CHANGELOG` (§R3.2 y §R3.1: tabla por hallazgo), `RUNBOOK_VIGENTE` (también dentro del ZIP) |
| `evidence/README.md` | índice de evidencia por hallazgo |
| `evidence/R3.2_negative_controls.txt` | cada corrección revertida una a una: su test la detecta, 15/15 (script en `evidence/mutations.py`) |
| `evidence/focused_before_R3.txt`, `focused_after.txt` | R3-01/02/03/07: tests nuevos contra el código de R3 exacto (5 fallan) y contra R3.1 (22/22) |
| `evidence/R3-02_repro.*` | variantes D2/D3/D7 del auditor: puerta de R3 PASS, puerta nueva FAIL |
| `evidence/R3.2_*.log` | `test-full` y `rehearse` desde una exportación limpia; gate físico sobre el ZIP final |
| `previous/` | briefs y respuesta de rondas anteriores (contexto) |

## Qué se pide verificar

1. **R3-01…R3-16 cerrados**, re-ejecutando sus propias reproducciones (`tests/REL/scripts/f06_zip.mjs`,
   `variants.sh`, `tests/PROD/tests/evidence-gate.test.mjs`, `forge-root.test.mjs`, `mutations`, `tests/SEC/*`)
   contra R3.2. Resultados esperados:
   - R3-01: nombres no canónicos → `ZIP_ENTRY_NOT_CANONICAL`.
   - R3-02 / R3-05: D2, D3 y D7 → FAIL; recuentos falsos impresos por un test → sin efecto.
   - R3-03: un FAIL/PARTIAL posterior del mismo build → BLOCKED; un PASS de más de 7 días → BLOCKED.
   - R3-04: un fichero malformado → motivo de bloqueo, sin excepción.
   - R3-10: señuelo en un subdirectorio → FAIL.
   - R3-11: casos 16-26 → FAIL.
   - R3-12: `edge/test/.wrangler/x.test.js` cambia la huella.
   - R3-14: el ZIP genuino en otra instalación → PASS con aviso.
   - R3-15: lanzador invocado por un enlace, o `.env` como enlace → se niega.
2. **R3-06, R3-08 y R3-16** son de texto o declaración: comprobar que dicen la garantía real.
3. **R3-13:** comprobar la nueva prueba del gate K. Exige ≥ 2 publicaciones, ningún fallo de `queue.send` y
   la entrega resuelta ≥ 5 min tras la aceptación. Solo puede ejecutarse contra Cloudflare real.
4. **Sin regresiones.** `edge/src/**`, receptor, admin y tests del Edge siguen idénticos a R4.

## Resultados del desarrollador (para contrastar, no para aceptar)

| Qué | Resultado |
|---|---|
| `test-full` (exportación limpia del commit) | Edge **95/95** (11/11, exit 0) · deployer **101/101** anclado por fichero · 119.4 s |
| `rehearse` | PASS · 13 gates + 5 CLOUD_ONLY · 203.4 s |
| `verify-release` | PASS · 104 entradas |
| Gate físico (directorio vacío, `sha256sum -c` antes de extraer, uid 1026:100) | `verify-fast` 14.7 s · `test-full` 118.2 s, huella `5b9922fe…` = evidencia empaquetada · PASS |

## Sigue abierto (decisión del owner)

- **B-1:** vía PROD de retry/skip/diagnóstico. Requiere elegir O1, O2 u O3 y una revisión del Edge.
- **B-2:** validación no-trading Edge → HUB_A. Requiere el contrato del Hub (2xx + `code: DUPLICATE`). Va
  después de B-1.

Mientras sigan abiertos, `cutover` está BLOCKED y TradingView sigue directo a HUB_A.
