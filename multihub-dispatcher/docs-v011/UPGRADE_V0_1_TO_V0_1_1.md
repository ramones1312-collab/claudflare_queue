# UPGRADE · Multi-Hub Dispatcher V0.1 → V0.1.1 (in situ)

No toca HUB_A/HUB_B, el Tunnel ni TradingView. No reinstala, no crea otra carpeta y no borra `data/`.

1. **Backup:** en File Station, copia la carpeta del proyecto (p. ej. `KAWA_VECTOR_MULTIHUB_DISPATCHER_V0_1`)
   a `…_BACKUP_V0_1`.
2. **Detener:** Container Manager → Proyecto del dispatcher → **Detener**. Solo ese proyecto.
3. **Sobrescribir:** extrae `KAWA_VECTOR_MULTIHUB_DISPATCHER_V0_1_1_FILES_TO_REPLACE.zip` **dentro** de la carpeta del
   proyecto y acepta sobrescribir. Contiene solo lo que figura en `FILES_TO_REPLACE.md`.
4. **Nuevo secreto:** escribe en `secrets/audit_admin_token` (llega vacío) una contraseña de 16 o más caracteres,
   sin espacios y distinta de cualquier otro secreto.
5. **No toques** `config/destinations.json` ni `secrets/ingress_webhook_token`, `hub_a_…`, `hub_b_…`.
6. **No toques** `data/` (incluida `data/dispatcher.db`).
7. **Construir:** Container Manager → Proyecto → **Construir** (usa el `docker-compose.yml` ya actualizado).
8. **Iniciar.**
9. **Comprobar:** `http://<IP-del-NAS>:8191/health` →
   `{"status":"healthy","db":"ok","destinations_enabled":2,"audit":"ok","audit_url":"/audit"}`.
10. **Auditoría:** abre `http://<IP-del-NAS>:8191/audit` desde la LAN, usuario `audit` y contraseña del paso 4.
11. **Prueba:** envía una señal de prueba (como hoy, a `/webhook/<secreto>`).
12. En `/audit`, esa señal muestra `HUB_A · DELIVERED` y `HUB_B · DELIVERED`.
13. **Download CSV** / **Download JSON**. Quedan también copiados en `data/audit/exports/`.

Lo pendiente en `data/dispatcher.db` antes de actualizar se entrega igual después (comprobado).
