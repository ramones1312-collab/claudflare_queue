# Contexto para la re-auditoría · KAWA Edge Signal Buffer V1.3.1 **R2** (NAS turnkey)

R2 es la respuesta a su veredicto **FAIL** sobre R1 (`KAWA_EDGE_V1_3_1_R1_AUDIT_VERDICT.md`, SHA-256
`b3cd1bd13794aff1889de8aa0f320139fdec16fed21201358d7f51bb7bf44ea5`). El contexto del sistema, las restricciones
y el formato de veredicto por bloques no cambian: siguen siendo los de `AUDITOR_BRIEF_V1_3_1.md` (R1).

## Ficheros

| Fichero | Qué es |
|---|---|
| `KAWA_EDGE_SIGNAL_BUFFER_V1_3_1_NAS_R2_2026-09-26.zip` | el artefacto a auditar |
| `KAWA_EDGE_SIGNAL_BUFFER_V1_3_1_NAS_R2_2026-09-26.zip.sha256` | línea 1: ZIP ``8900863b41d2237ffc71897074207a46f170abc49ef456e225b5df085e0ed1de``; línea 2: manifiesto ``0e5785f320698647ab113b7df8ba894ceb3877dcc32a42d99730151b569083bd`` |
| `AUDIT_RESPONSE_R2.md` | hallazgo por hallazgo: corrección, test de regresión y estado (CERRADO / DECLARADO) |
| `RELEASE_REPORT_V1_3_1.md` | informe de release R2 (también dentro del ZIP; §5-ter resume la respuesta) |
| *(para A3/A4)* `KAWA_EDGE_SIGNAL_BUFFER_V1_3_0_R4_CANDIDATE_2026-09-22.zip` | SHA-256 `1bcd1e3df8fba89781916efcaf173a45983f0566bb189d59e20929766db82867`; lo aporta el propietario para cerrar la identidad frente al R4 original de forma independiente |

## Qué se pide verificar

1. **Que cada hallazgo marcado CERRADO lo está**, re-ejecutando sus propias reproducciones contra R2 cuando
   existan (`tests/FG-release-blockers/*`, `tests/C-security/launcher_symlink_test.sh`,
   `tests/D-installer/audit-d.test.mjs`, `tests/E-gates/tests/*`). Las esperadas: F-01 → `test-full` FAIL con un
   fichero que no carga; F-02 → el lanzador se niega sin tocar el objetivo del enlace; F-03 → `add-hub --env prod`
   BLOCKED sin STAGING PASS del código actual; F-04 → evidencia escrita a mano (o con lista de gates propia)
   rechazada; F-05 → cambiar `config.mjs`, receptor, admin o gates cambia el binding; F-06 → ZIP con
   `secrets/…` o `config/kawa-edge.json` → FAIL.
2. **Que lo DECLARADO está declarado de verdad** y es aceptable: F-10 (redespliegue del ingress PROD con
   confirmación tecleada), F-14 (doble ruta, RUNBOOK §5/§8), F-15 (B-2 después de B-1, RUNBOOK §9), H-16, OBS-1.
3. **Que no hay regresiones nuevas** en el mecanismo añadido por R2: firma HMAC de la evidencia
   (`deployer/lib/evidence.mjs`, clave local `state/.evidence-key` 0600 generada en la instalación), puerta
   STAGING PASS única (`deployer/lib/prod.mjs`: `findStagingPass`, `corroborate`, `requireStagingPass`),
   `verify-release` sobre entradas crudas, lanzador bajo `sudo`.
4. **Que `edge/src/**`, receptor y admin siguen idénticos a R4** (sin cambios respecto de R1).

**Límite de diseño declarado sobre la firma:** la clave vive en `state/` de la instalación que ejecutó las
pruebas. Impide que un JSON escrito a mano o editado autorice PROD o un empaquetado; **no** es una firma de
terceros. La garantía independiente sigue siendo re-ejecutar `./kawa-edge test-full` sobre el ZIP (gate físico).

## Resultados del desarrollador (para contrastar, no para aceptar)

| Qué | Resultado |
|---|---|
| `test-full` en la imagen | Edge **95/95**, 11/11 ficheros, exit 0 · deployer **75/75**, exit 0 · 122.3 s |
| `rehearse` | PASS · 13 gates + 5 `CLOUD_ONLY` · 203.9 s |
| `verify-release` | PASS · 101 entradas crudas = manifiesto (100) + el propio manifiesto |
| Gate físico sobre el ZIP cerrado, extraído **sobre** la carpeta de R1 (uid 1026:100, lanzador) | `verify-zip` PASS → imagen desde la carpeta (manifiesto dentro = publicado) → `verify-fast` 13.7 s → `test-full` 122.5 s (mismo árbol `ea3ccd37…`) → `rehearse` 203.6 s: **PASS** |

## Sigue fuera de alcance / no verificable aquí

Cloudflare real (paginación real, reinicio del DO, pausa de colas, métricas GraphQL, alarma a 300 s): lo ejecuta
`./kawa-edge install` en el NAS. arm64. Cutover: bloqueado por **B-1** y **B-2** (decisión del propietario).
