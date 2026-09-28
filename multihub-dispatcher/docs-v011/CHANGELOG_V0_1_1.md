# CHANGELOG · V0.1.1 (observability-only)

**Añadido**
- `src/audit.mjs` y `src/audit-ui/`: tabla `audit_events`, `request_id`, fichero de estado, retención, UI, API y
  exportaciones (Basic Auth, solo LAN, bloqueo si llega por Cloudflare).
- `secrets/audit_admin_token`: placeholder vacío.
- Tests V0.1.1: 26 nuevos (los 20 de V0.1 sin cambios).

**Modificado (solo enganches de auditoría; la lógica no cambia)**
- `src/server.mjs`: `request_id`; filas de ingress después del ACK; rutas `/audit*`; campos opcionales en `/health`.
- `src/dispatcher.mjs`: filas por intento y resultado. El único cambio en líneas existentes es guardar `now() + d`
  en una variable para registrarla.
- `src/main.mjs`: crea la auditoría; `DISPATCHER_STARTED`/`STOPPING`; `CONFIG_INVALID` best-effort.
- `src/config.mjs`: devuelve el bloque `audit` opcional (la validación no cambia).
- `VERSION`, `package.json`, `package-lock.json`: 0.1.1. `docker-compose.yml`: solo la etiqueta de la imagen.
- `README_NAS_INSTALL.md`: sección de auditoría. `TEST_REPORT.md`: informe de V0.1.1.

**Sin cambios**: `Dockerfile`, `.dockerignore`, `src/store.mjs`, `src/log.mjs`, puertos, volúmenes, seguridad,
esquema `events`/`deliveries`, retry, clasificación, fan-out, orden y `FAILED_PERMANENT`.
