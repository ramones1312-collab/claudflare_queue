# KAWA VECTOR · Multi-Hub Dispatcher V0.1 · Instalación en el NAS

Recibe cada alerta de TradingView, la guarda en SQLite, responde 200 y la entrega por separado a cada Hub
configurado, con reintentos. No toca HUB_A, el Tunnel, TradingView ni ningún puerto existente.

## 1. Copiar y comprobar

1. Con File Station, sube `KAWA_VECTOR_MULTIHUB_DISPATCHER_V0_1.zip` a `/docker/` y extráelo. Aparece la carpeta
   `KAWA_VECTOR_MULTIHUB_DISPATCHER_V0_1/`.
2. (Opcional) Comprueba el hash del ZIP contra el `.sha256` entregado.

## 2. Configurar (solo dos cosas)

1. **`config/destinations.json`**: un bloque por Hub (`id`, `enabled`, `host`, `port`, `webhook_secret_file`).
   Ya trae HUB_A (`192.168.0.20:8181`, activo) y HUB_B (`:8281`, inactivo). Para añadir HUB_C, copia un bloque.
   No pongas secretos aquí.
2. **Secretos** (Text Editor de DSM; una línea, sin espacios):
   - `secrets/ingress_webhook_token`: el secreto que TradingView usa **hoy** en la URL
     `…/webhook/<secreto>`. Así las alertas no cambian.
   - `secrets/hub_a_webhook_token`: el secreto de HUB_A (hoy es el mismo).
   - `secrets/hub_b_webhook_token`: el de HUB_B, cuando lo actives. Cada Hub debe tener el suyo.

Opcional, en `destinations.json`: `"retry": {"schedule_seconds": [5,15,30,60,120,300], "max_attempts": 0}`
(0 = reintentar sin límite al último intervalo) y `timeout_ms` por Hub (por defecto 10000).

## 3. Arrancar

Container Manager → **Proyecto** → **Crear** → ruta: la carpeta extraída → usa el `docker-compose.yml` existente →
**Construir** / **Iniciar**. No hace falta SSH, `.env` ni cambiar permisos.

Comprobar: en el registro del contenedor sale `STARTED port=8080 destinations=HUB_A@192.168.0.20:8181`, y
`http://<IP-del-NAS>:8191/health` responde `{"status":"healthy","db":"ok","destinations_enabled":1}`.
Si la configuración es inválida, el contenedor se detiene y el registro dice exactamente qué corregir
(`CONFIG_INVALID reason=…`).

## 4. Cutover (un solo cambio) y rollback

- **Cutover:** en el Tunnel, cambia el servicio de `vector-hook.integrademia.com` de `http://192.168.0.20:8181`
  a `http://192.168.0.20:8191`. TradingView no cambia.
- **Rollback:** vuelve a poner `http://192.168.0.20:8181`.

## 5. Operación

- **Añadir, quitar o desactivar un Hub:** edita `config/destinations.json` (y su secreto) y reinicia el proyecto.
  No hay que reconstruir la imagen.
- **Registro:** `RECEIVED`, `PERSISTED`, `DELIVERED HUB_x`, `RETRY HUB_x`, `FAILED_PERMANENT HUB_x`. Nunca incluye
  secretos ni el cuerpo de la señal.
- **Datos:** `data/dispatcher.db`. Sobrevive a reinicios y reconstrucciones. Lo pendiente se entrega al volver a
  arrancar.
- **Respuestas de un Hub:**
  - 4xx (salvo 408/425/429): `FAILED_PERMANENT` (el Hub decidió; se guarda, no se reintenta).
  - 5xx, timeout o sin conexión: `RETRY`, en orden y sin bloquear a los demás Hubs.
