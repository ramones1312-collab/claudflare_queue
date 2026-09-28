# ROLLBACK · V0.1.1 → V0.1

1. **Detener** el proyecto del dispatcher (Container Manager → Detener).
2. **Restaurar solo los ficheros sustituidos** (acción REPLACE en `FILES_TO_REPLACE.md`) desde la copia
   `…_BACKUP_V0_1`:
   `README_NAS_INSTALL.md`, `TEST_REPORT.md`, `VERSION`, `docker-compose.yml`, `package.json`, `package-lock.json`,
   `src/config.mjs`, `src/dispatcher.mjs`, `src/main.mjs`, `src/server.mjs`, `MANIFEST.sha256`.
   Los ficheros añadidos (`src/audit.mjs`, `src/audit-ui/`, `test/`, `secrets/audit_admin_token`) pueden quedarse:
   V0.1 no los usa.
3. **Construir.**
4. **Iniciar.** `/health` vuelve a `{"status":"healthy","db":"ok","destinations_enabled":N}`.

No restaures una `dispatcher.db` antigua salvo corrupción demostrada. La tabla `audit_events` se queda en la DB y
V0.1 la ignora sin error. Comprobado: tras el rollback, V0.1 entrega a A+B, `integrity_check` = ok y `event_id`
continúa.
