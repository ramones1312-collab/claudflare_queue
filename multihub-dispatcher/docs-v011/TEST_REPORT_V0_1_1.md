# TEST REPORT · KAWA VECTOR Multi-Hub Dispatcher V0.1.1 · Durable Audit & Observability

Base: V0.1 exacta (`KAWA_VECTOR_MULTIHUB_DISPATCHER_V0_1.zip`, SHA-256 `03895cd96728ca3c6da2d63cffd8f79e21f684dae0a3f858aeccf0f2141d2e3b`).
V0.1.1 solo añade observabilidad. El transporte (ingress, ACK, fan-out, retry, clasificación y orden) no cambia.

```
legacy tests:     20/20 PASS  (los ficheros de test de V0.1, sin modificar)
new audit tests:  26/26 PASS  (audit 8 · security 5 · export 3 · core regression 8 · durability 2)
integration:      PASS  (N Hubs reales por HTTP en proceso; Docker: instalación limpia 20/20; actualización + rollback 21/21)
security:         PASS
durability:       PASS  (kill -9 a mitad de reintento; reinicio con el mismo /data)
exports:          PASS
N-Hub:            PASS  (1, 2, 5 y 7 Hubs; nada fijado a HUB_A/HUB_B)
```

`npm test` sobre el ZIP completo recién extraído: **46/46, 0 omitidos, 2,6 s**.

## Gate 1 · estático / paquete (18/18 PASS)

- SHA-256 de ambos ZIP; `MANIFEST.sha256` verificado sobre una extracción limpia, sin ficheros no declarados.
- `FILES_TO_REPLACE` es byte-idéntico al ZIP completo y nunca incluye `config/destinations.json`, `data/` ni los
  secretos existentes.
- Sintaxis de todos los módulos; 0 dependencias npm; los 4 ficheros de secretos vacíos; sin DB, `.env`, logs,
  exportaciones ni tokens de ruta; ningún id de Hub fijado en `src/`.
- Idénticos a V0.1: `Dockerfile`, `.dockerignore`, `store.mjs` (esquema y persistencia) y `log.mjs`.
- `docker-compose.yml`: solo cambian el comentario del título y la etiqueta de la imagen. Puertos `8191:8080`,
  volúmenes, `read_only`, capacidades y seguridad, idénticos.
- Núcleo: las 14 líneas de V0.1 que cambian en `config`/`dispatcher`/`server`/`main` están en una lista revisada.
  Cada una reaparece con la misma lógica más una llamada de auditoría (`evidence/core-diff-removed-lines.log`).
  Las líneas de retry, clasificación, orden, fan-out y cabeceras `x-kawa-dispatcher-*` siguen literalmente.

## Gate 2 · funcional sobre el ZIP extraído

| Qué | Resultado |
|---|---|
| `npm test` (ZIP extraído) | 46/46 |
| Instalación limpia (Docker, BuildKit OFF, carpeta de uid 1026) | 20/20: build clásico, `compose config`, healthy, fan-out, un Hub caído no bloquea al otro, backlog en orden, reinicio, `data/` nueva, sin secretos |
| **Actualización in situ V0.1 → V0.1.1 y rollback** (mismo `./data`) | 21/21. Detalle abajo |

Actualización y rollback, paso a paso:
1. V0.1 en marcha con 2 Hubs deja un backlog para HUB_B.
2. Copia de seguridad → `down` → se extrae `FILES_TO_REPLACE` → config y secretos existentes byte-idénticos,
   `dispatcher.db` intacta → se añade `audit_admin_token`.
3. Build con BuildKit OFF → `/health` con `audit: ok`.
4. **El backlog de V0.1 lo entrega V0.1.1, en orden.**
5. `/audit`: 401 sin credenciales, 200 con Basic Auth (LAN), 403 con cabecera de Cloudflare.
6. Señal de prueba → fan-out A+B → CSV y JSON descargados, con copia en `data/audit/exports`. Ningún secreto en
   logs, exportaciones ni en el fichero de estado.
7. **Rollback:** se restauran los 11 ficheros sustituidos → V0.1 arranca y entrega a A+B ignorando
   `audit_events` → `integrity_check` ok, `event_id` continuo del 1 al 5.

## Cobertura de la sección 16

| Grupo | Tests |
|---|---|
| Regresión núcleo | 1/2/5 Hubs en orden · deshabilitado no recibe y no necesita su secreto · secretos duplicados → fail closed (legacy) · A caído no bloquea B y viceversa · 2xx DELIVERED · 400 FAILED_PERMANENT · 408/425/429/5xx/timeout RETRY · `max_attempts` · reinicio conserva backlog · `event_id` monótono · ACK solo tras el commit · la DB de V0.1 se abre sin cambios (migración aditiva) |
| Auditoría | historial por señal (`request_id` → `event_id` → intentos y resultado por Hub) · `DELIVERY_ATTEMPT` / `DELIVERED` / `RETRY_SCHEDULED` (intento, error, latencia, próximo reintento) / `FAILED_PERMANENT` · 5 Hubs con trazas independientes · sobrevive a reinicio · retención borra solo `audit_events` · `dispatcher_status.json` atómico · fallo de auditoría → transporte sigue, `/health` degraded, `AUDIT_WRITE_FAILED` · `CONFIG_INVALID` registrado |
| Seguridad | sin auth / contraseña errónea / otro usuario / Bearer → 401 genérico con `WWW-Authenticate` · correcto → 200 en LAN · exportaciones protegidas · token por query nunca aceptado · evidencia de Cloudflare → 403 en `/audit*` · ingress por Cloudflare sigue funcionando · escaneo de secretos (DB, exportaciones, HTML/JS, fichero de estado, stdout): 0 apariciones · cuerpo RAW, `Authorization` y cookies nunca almacenados · `Cache-Control: no-store`, sin CORS · token reutilizado → UI desactivada, transporte intacto |
| Exportación | CSV RFC 4180 (UTF-8, cabeceras estables, comas, comillas, fórmulas neutralizadas) · JSON con `schema_version`, `exported_at`, filtros y eventos · filtros por `event_id`, Hub, estado, `request_id` y rango de tiempo · límite máximo respetado · copia guardada sin sobrescribir |

## Crash / durabilidad (sección 18)

Proceso real, HUB_B caído, 3 señales. Se esperan filas `RETRY_SCHEDULED` y luego **kill -9**. Tras el kill:
- `PRAGMA integrity_check` = ok, y el backlog de HUB_B (3) y el historial de auditoría se conservan.
- Al reiniciar: `event_id` continúa (4); HUB_B recibe k1, k2, k3 y k4 en orden; la exportación incluye el
  historial previo a la caída y la entrega posterior.

## Rendimiento (sección 17): V0.1 vs V0.1.1, mismo fixture, Hubs locales

| Modo | Hubs | ACK p50/p95/p99 ms V0.1 → V0.1.1 | Entrega p50 ms V0.1 → V0.1.1 | RSS pico MB | DB MB |
|---|---|---|---|---|---|
| ritmo real (50 señales, 1 cada 100 ms) | 1 | 2.64/3.95/6.65 → 2.80/3.95/7.16 | 3.68 → 4.00 | 83 → 83 | 0.04 → 0.08 |
| ritmo real | 2 | 2.66/3.17/9.71 → 2.92/4.39/7.85 | 4.20 → 4.61 | 87 → 87 | 0.04 → 0.10 |
| ritmo real | 5 | 2.92/3.82/7.50 → 2.76/4.51/9.02 | 5.49 → 5.32 | 84 → 94 | 0.06 → 0.16 |
| ráfaga (1000 seguidas) | 1 | 2.33/3.90/6.60 → 2.56/4.04/6.84 | 31 → 100 | 118 → 126 | 0.33 → 1.09 |
| ráfaga | 2 | 2.15/4.33/6.84 → 3.51/6.41/9.77 | 882 → 231 | 125 → 133 | 0.43 → 1.41 |
| ráfaga | 5 | 5.70/10.49/14.03 → 6.77/10.77/12.68 | 547 → 55 | 150 → 162 | 0.73 → 2.34 |

- **ACK:** p95 entre +0 y +2,1 ms. Las filas de ingress se escriben después de enviar el ACK.
- **Entrega a ritmo real:** igual que V0.1 (±0,4 ms).
- **Entrega en ráfaga:** mide sobre todo la cola, que varía mucho entre ejecuciones en ambas versiones; no es un
  criterio de regresión. Para no encolar, las filas de auditoría de cada vuelta del event loop se escriben en
  **una** transacción, en una conexión propia con `synchronous=NORMAL`; la conexión del núcleo sigue con `FULL`.
- **Memoria:** acotada (pico +0 a +12 MB, sin crecimiento).
- **Base de datos:** unos 0,1 KB por señal y Hub, con retención de 90 días.

## Observaciones conocidas

1. **Ventana de auditoría ante kill -9:** las filas de auditoría de la última vuelta del event loop (milisegundos)
   pueden perderse. El transporte no se ve afectado y la auditoría no es autoritativa.
2. **`/health`:** muestra `audit`/`audit_url` solo si la UI de auditoría está configurada o si la auditoría está
   degradada. Así la forma de V0.1, y sus tests exactos, se mantiene intacta cuando no hay token.
3. **Basic Auth sobre HTTP en la LAN**, como pide la especificación. Por el Tunnel, `/audit*` siempre responde 403.
4. **`/health` sigue siendo público**, como en V0.1. Solo expone el estado, sin datos.
5. **Detección de Cloudflare por cabeceras** (`cf-ray`, `cf-connecting-ip`, `cdn-loop`…), además de exigir una IP
   de red privada. `cloudflared` siempre añade esas cabeceras.
6. **Límites:** sin NAS físico en este entorno (Docker 29 y builder clásico); la prueba final es la actualización
   real en Synology.
