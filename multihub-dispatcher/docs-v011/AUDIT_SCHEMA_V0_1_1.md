# AUDIT SCHEMA · V0.1.1

Tabla nueva `audit_events` en el mismo `data/dispatcher.db`. Migración solo con `CREATE TABLE/INDEX IF NOT
EXISTS`; `events` y `deliveries` no se alteran. Solo se añaden filas; la retención borra únicamente
`audit_events` con más de `retention_days`.

| Columna | Contenido |
|---|---|
| `audit_id` | autoincremental |
| `ts_ms` | milisegundos Unix |
| `request_id` | UUID por petición al ingress (`crypto.randomUUID()`); no se devuelve en el ACK |
| `event_id` | id de la señal (= `x-kawa-dispatcher-event`) cuando existe |
| `event_type` | ver lista |
| `destination_id` | Hub, dinámico desde la configuración |
| `attempt` | nº de intento de entrega (= `x-kawa-dispatcher-attempt`) |
| `status` | `RECEIVED`, `PERSISTED`, `PENDING`, `RETRY`, `DELIVERED`, `FAILED_PERMANENT`, `REJECTED`, `FAILED`, `OK` |
| `http_status`, `latency_ms`, `error_code`, `next_retry_at` | resultado del intento (`TIMEOUT`, `ECONNREFUSED`, `HTTP 503`…) |
| `payload_sha256`, `body_bytes`, `content_type` | identificación del cuerpo, nunca el cuerpo |
| `symbol`, `order_id` | best-effort si el cuerpo es JSON (`symbol`/`ticker`, `order_id`/`orderId`); si no, `null` |
| `detail_json` | `order_action`, `market_position`, `cf_ray`, `source_ip`, destinos, motivos… nunca secretos |

Índices: `audit_event_id(event_id, audit_id)`, `audit_destination(destination_id, audit_id)`, `audit_ts(ts_ms)`.

`event_type`: `INGRESS_RECEIVED`, `INGRESS_PERSISTED`, `INGRESS_PERSIST_FAILED`, `INGRESS_REJECTED_AUTH`,
`INGRESS_REJECTED_TOO_LARGE`, `DELIVERY_ATTEMPT`, `DELIVERED`, `RETRY_SCHEDULED`, `FAILED_PERMANENT`,
`WORKER_ERROR`, `DISPATCHER_STARTED`, `DISPATCHER_STOPPING`, `CONFIG_INVALID`, `AUDIT_RETENTION_CLEANUP`.
`AUDIT_WRITE_FAILED` no puede escribirse en la tabla que falla: va a stdout y se refleja en `/health` y en el
fichero de estado.

**Nunca se guardan:** tokens (TradingView, Hubs, auditoría), la URL o ruta del webhook, `Authorization`, cookies,
el cuerpo RAW ni las cabeceras RAW.

**Fichero de estado** `data/audit/dispatcher_status.json` (escritura atómica: temporal → fsync → rename). Contiene
`schema_version`, `version`, `updated_at`, `audit_status`, `last_event_id`, `last_received_at` y, por destino,
`enabled`, `backlog`, último evento, última entrega, último error y último HTTP. Es solo observabilidad: el núcleo
no lo lee.

**HTTP** (puerto 8191, Basic Auth `audit` / `secrets/audit_admin_token`, solo LAN, 403 si llega por Cloudflare):
`GET /audit`, `/audit/api/events`, `/audit/api/summary`, `/audit/export.csv`, `/audit/export.json`.
Filtros: `event_id`, `request_id`, `destination_id`, `event_type`, `status`, `from`, `to` (ms o ISO) y `limit`
(por defecto 200, máximo 5000). Las exportaciones se guardan en `data/audit/exports/dispatcher_audit_YYYYMMDD_HHMMSS[_n].{csv,json}`.

**Configuración opcional** (`destinations.json`, bloque `audit`; un valor inválido usa el por defecto con aviso):
`enabled` true, `secret_file` "audit_admin_token", `retention_days` 90, `ui_default_rows` 200, `ui_max_rows` 5000.
