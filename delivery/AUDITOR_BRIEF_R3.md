# Contexto para la re-auditoría · KAWA Edge Signal Buffer V1.3.1 **R3** (NAS turnkey)

R3 es la respuesta a su veredicto **FAIL** sobre R1 (`KAWA_EDGE_V1_3_1_R1_AUDIT_VERDICT.md`, SHA-256
`b3cd1bd13794aff1889de8aa0f320139fdec16fed21201358d7f51bb7bf44ea5`). El contexto del sistema, las restricciones
y el formato de veredicto por bloques no cambian: siguen siendo los de `AUDITOR_BRIEF_V1_3_1.md` (R1).
Entre medias hubo una R2 **no entregada**: una re-auditoría independiente interna de R2 encontró 2 P2 y 5 P3 (N-7 ya existía en R1)
nuevos (sin P0/P1) y tres afirmaciones exageradas; R3 lo corrige (sección «R3» de `AUDIT_RESPONSE_R2.md`).

## Ficheros

| Fichero | Qué es |
|---|---|
| `KAWA_EDGE_SIGNAL_BUFFER_V1_3_1_NAS_R3_2026-09-26.zip` | el artefacto a auditar |
| `KAWA_EDGE_SIGNAL_BUFFER_V1_3_1_NAS_R3_2026-09-26.zip.sha256` | línea 1: ZIP `ce1405d572f8ebde0686b40f39b406b1fadc87960e23ffb4b87fc18e3d31ce3a`; línea 2: manifiesto `9faad044b1747813e88acfbf26e504ac6b338dffdb09df940f404343c651a486` |
| `AUDIT_RESPONSE_R2.md` | R1→R2→R3, hallazgo por hallazgo: corrección, test de regresión y estado (CERRADO / DECLARADO) |
| `RELEASE_REPORT_V1_3_1.md` | informe de release R3 (también dentro del ZIP; §5-ter resume la respuesta) |
| *(para A3/A4)* `KAWA_EDGE_SIGNAL_BUFFER_V1_3_0_R4_CANDIDATE_2026-09-22.zip` | SHA-256 `1bcd1e3df8fba89781916efcaf173a45983f0566bb189d59e20929766db82867`; lo aporta el propietario para cerrar la identidad frente al R4 original de forma independiente |

## Qué se pide verificar

1. **Que cada hallazgo marcado CERRADO lo está**, re-ejecutando sus propias reproducciones contra R3 cuando
   existan (`tests/FG-release-blockers/*`, `tests/C-security/launcher_symlink_test.sh`,
   `tests/D-installer/audit-d.test.mjs`, `tests/E-gates/tests/*`). Las esperadas: F-01 → `test-full` FAIL con un
   fichero que no carga; F-02 → el lanzador se niega sin tocar el objetivo del enlace; F-03 → `add-hub --env prod`
   BLOCKED sin STAGING PASS del código actual; F-04 → evidencia escrita a mano (o con lista de gates propia)
   rechazada; F-05 → cambiar `config.mjs`, receptor, admin o gates cambia el binding; F-06 → ZIP con
   `secrets/…` o `config/kawa-edge.json` → FAIL.
2. **Que lo DECLARADO está declarado de verdad** y es aceptable: F-10 (redespliegue del ingress PROD con
   confirmación tecleada), F-14 (doble ruta, RUNBOOK §5/§8), F-15 (B-2 después de B-1, RUNBOOK §9), H-16, OBS-1.
3. **Que no hay regresiones nuevas** en el mecanismo añadido por R2/R3: firma HMAC de la evidencia
   (`deployer/lib/evidence.mjs`, clave local `state/.evidence-key` 0600 generada en la instalación), puerta
   STAGING PASS única (`deployer/lib/prod.mjs`: `findStagingPass`, `corroborate`, `requireStagingPass`),
   `verify-release` sobre entradas crudas y cobertura del fichero ZIP, lanzador bajo `sudo` (ya no escribe ningún fichero como root).
4. **Que `edge/src/**`, receptor y admin siguen idénticos a R4** (sin cambios respecto de R1).

**Límite de diseño declarado sobre la firma:** la clave vive en `state/` de la instalación que ejecutó las
pruebas. Impide que un JSON escrito a mano o editado autorice PROD o un empaquetado; **no** es una firma de
terceros. La garantía independiente sigue siendo re-ejecutar `./kawa-edge test-full` sobre el ZIP (gate físico).

## Resultados del desarrollador (para contrastar, no para aceptar)

| Qué | Resultado |
|---|---|
| `test-full` en la imagen | Edge **95/95**, 11/11 ficheros, exit 0 · deployer **81/81**, exit 0 · 122.7 s |
| `rehearse` | PASS · 13 gates + 5 `CLOUD_ONLY` · 203.5 s |
| `verify-release` | PASS · 101 entradas crudas = manifiesto (100) + el propio manifiesto |
| Gate físico sobre el ZIP cerrado, extraído **sobre** la carpeta de R2 (uid 1026:100, lanzador, procedimiento del README) | `sha256sum -c` antes de extraer → OK → `refresh-context` detecta imagen antigua → imagen desde la carpeta → `verify-fast` 13.8 s → `test-full` 121.5 s (mismo árbol `c641ff7e…`) → `rehearse` 204.3 s: **PASS** (343 s) |

## Sigue fuera de alcance / no verificable aquí

Cloudflare real (paginación real, reinicio del DO, pausa de colas, métricas GraphQL, alarma a 300 s): lo ejecuta
`./kawa-edge install` en el NAS. arm64. Cutover: bloqueado por **B-1** y **B-2** (decisión del propietario).
