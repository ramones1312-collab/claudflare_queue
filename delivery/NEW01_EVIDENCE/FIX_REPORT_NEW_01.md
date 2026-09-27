# FIX REPORT · NEW-01 · KAWA Edge V1.3.1 R3.3

| | |
|---|---|
| Base | R3.2 exacta (commit `a49a526`, ZIP `ebd7dfd2…0b4b`) |
| ZIP final | `KAWA_EDGE_SIGNAL_BUFFER_V1_3_1_NAS_R3.3_2026-09-27.zip` |
| SHA-256 ZIP | `262ff379fc70a6fc4fd9b3efb7deb81f2bc5ac44afd82931ca298aca133ddae1` (línea 1 del `.sha256`) |
| SHA-256 manifiesto | `8ba04084326aa4a61b03d696f6eef159e2da6e4d5eed0dc5aa54ef90efd307b8` (línea 2; 103 ficheros) |
| Huella de entradas de tests | `eab40e62b7cbc867…` |

## Corrección

`deployer/lib/zip.mjs` (+7 líneas, `readZip`): rechaza cualquier entrada que lleve **campos extra en la
cabecera central o en la local**. El error nombra el campo (`0x7075 (Unicode Path: would replace the declared
name)`). Falla cerrado: `verify-release` lee la lista de entradas **antes** de extraer nada, así que no se
escribe ningún fichero. El paquete genuino no lleva campos extra, así que sigue en PASS. Se eligió rechazar
en vez de resolver nombres alternativos, como se pidió.

## Ficheros modificados

| Fichero | Motivo |
|---|---|
| `deployer/lib/zip.mjs` | la corrección |
| `deployer/test/release-integrity.test.mjs` | 3 regresiones: #34 → `secrets/cloudflare_api_token`, #35 → `config/kawa-edge.json`, ZIP canónico sin el campo → PASS |
| `deployer/test/expected-tests.json` | ancla de la suite (R3-02): `release-integrity` pasa de 18 a 21 tests |
| `deployer/lib/release.mjs` | solo metadata de release: revisión R3.3 y nombre del ZIP |
| `Dockerfile`, `docker-compose.yml`, `kawa-edge` | solo la etiqueta de la imagen, `1.3.1-nas-r3.3` |
| `VERSION`, `edge/VERSION`, `README_NAS_INSTALL.md`, `CHANGELOG_V1_3_1.md`, `TEST_REPORT_V1_3_1.md`, `RELEASE_REPORT_V1_3_1.md` | versión, nombre del ZIP, recuentos y tiempos, entrada de changelog |

Sin cambios: `edge/src/**`, receptor, admin, tests del Edge, lógica de Cloudflare, R3-01/02/03/07, P3 y B-1/B-2.
En `deployer/lib` solo cambian `zip.mjs` y la metadata de `release.mjs`.

**Nota:** los scripts del auditor para #34/#35 no venían en lo entregado a esta ronda. Los casos se
construyeron según su descripción: entrada declarada `kawa-edge-nas/docs/audit.txt`, declarada también en el
manifiesto y resellada, con un campo `0x7075` válido (versión 1, CRC del nombre declarado) en la cabecera local
y en la central, sin el flag UTF-8. Script: `new01_repro.mjs`.

## Evidencia

| Qué | Resultado | Fichero |
|---|---|---|
| Reproducción sobre el **ZIP R3.2 real** | Código R3.2: `verify-release` **PASS** y `unzip` 6.00 **escribe** `secrets/cloudflare_api_token` (#34) y `config/kawa-edge.json` (#35). Con la corrección: **FAIL** | `cases_34_35_before_after.txt` |
| Tests obligatorios | Código R3.2: #34 y #35 **not ok**, el canónico ok. Corrección: **3/3 ok** | `new01_tests_before_after.txt` |
| #34/#35 sobre el **ZIP final** con el código extraído de él | FAIL cerrado, 0 directorios temporales de extracción; ZIP genuino **PASS** | `cases_34_35_final_zip.txt` |
| `test-full` (exportación limpia del commit) | PASS · Edge 95/95 (11/11, exit 0) · deployer **104/104** anclado · 118.8 s | `clean_export_test-full.log` |
| `rehearse` (exportación limpia) | PASS · 13 gates + 5 CLOUD_ONLY · 204.5 s | `clean_export_rehearse.log` |
| `package` → `verify-release` | PASS · 104 entradas | — |
| **Gate físico** (directorio vacío nuevo, `sha256sum -c` antes de extraer, uid 1026:100, imagen desde el ZIP, lanzador) | `verify-fast` PASS 14.1 s · `test-full` PASS 117.1 s (misma huella `eab40e62…`) · `rehearse` PASS 203.9 s · 366 s | `final_zip_*.log` |
