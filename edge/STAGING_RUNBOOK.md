# EDGE SIGNAL BUFFER V1.2.3 · RUNBOOK STAGING

> **V1.3.0 · multi-destino.** Este runbook describe el despliegue de UN destino, tal y como se
> escribió para V1.2.3, y sigue siendo válido para esa configuración. Para el fan-out a varios Hubs
> (colas, consumers y secretos por destino, migración de esquema y rollback con drenaje previo), el
> procedimiento vigente es `MIGRATION_AND_DEPLOYMENT_V1_3_0.md`.

**ZIP:** `KAWA_EDGE_SIGNAL_BUFFER_V1_2_3_STAGING_FROZEN.zip`
**Identidad:** `edge-signal-buffer-v1.2.3-staging`
**Validación:** **42/42 tests PASS** en 6 runtimes aislados dentro de workerd
**Estado:** CONGELADO. Sustituye a V1.2.2. **Autorizado para despliegue STAGING real.**

> V1.2.3 es una **sanitización de paquete** sobre V1.2.2: se retiraron del artefacto el
> `wrangler.toml` y el `wrangler.consumer.toml` no-STAGING —un config en la raíz lo selecciona
> automáticamente `wrangler deploy` sin `--config`, lo que era una vía accidental fuera del
> aislamiento— y se sustituyó el README obsoleto. **Ningún archivo de código cambió.**

---

## 1. Hashes de verificación

Todos los archivos de código son **byte-idénticos a V1.2.2**.

| Archivo | SHA-256 | vs V1.2.1 |
|---|---|---|
| `src/producer.js` | `d6cf058ce7cfd653dcfa601e8fbc36c2e131fed35c84cc2334ee59268fec8029` | **idéntico** |
| `src/consumer.js` | `8760ab3b8222efc3ccc099a47cfd72eb6dffad3bba19a3875eb82d597d1fce29` | **idéntico** |
| `src/ingress-entry.js` | `2b14a95bba29296c1b5e3aa4ff879f2a9c6027b5f595586219d401a12bf6946c` | **idéntico** |
| `src/consumer-entry.js` | `bd3f0f94b2724d852f0379551e9065fe2d4b92ca6c0c7fc96a3072853e505b9d` | **idéntico** |
| `package-lock.json` | `7f7853f56953ce60d1ab9803821fb886a52adf49af57f975ce8ba466ec8641ff` | **idéntico** |
| `src/sequencer.js` | `d6092a7768b8e75325c6c3d4f261f4fbcab3ad7c8f0bac7f9b445239983fbf9e` | una línea (§4) |
| `staging-receiver/src/index.js` | `20c20d90f3210cea65b1a58d6240d98008103034dddd0d0c6ab7572827ed7247` | reescrito (§1, §2) |
| `admin-worker/src/index.js` | `af408558ef26665751b21e6ca08319a9d68c985503744605a101eb365e4864e6` | cambiado (§4) |
| `wrangler.consumer.staging.toml` | `60735919d92664e1d491493bf4c7db40383b280be3c95f402ab6ccecf8289832` | cambiado (§3) |
| `staging-receiver/wrangler.toml` | `30d4546ae3997080beaa04ae51d2ba608e56158d9e6844079eecc369446fd7ee` | cambiado (§1) |
| `wrangler.staging.toml` | `8b413776f350b5592b2b5c2a8e064ffa087d60a9c4f032c2c6c39518299d10b4` | **idéntico** |
| `README.md` | ver tabla de entrega | sustituido (solo STAGING) |
| `admin-worker/wrangler.toml` | `6e1169aaf3372a76dbbc902fabdf0fdb87826bb260b2be0f4f0ce8150a9b7418` | **idéntico** |
| `package.json` | `f88054a18c26b9298f3201b1115d780616f168eb9dac13ec5e13d5e2230879e5` | versión |
| `VERSION` | `ea7f03bf3b03233433c90843275506e8df332f63d9a7e2d009db393e9871ff37` | actualizado |
| `.dev.vars.example` | `599795ad1722eebdeb9679b3bc597b86d55c6edcd76ca93f7a232c0fb979793d` | actualizado |

**Producer, consumer y lockfile byte-idénticos.** El único cambio en `sequencer.js` es la línea de
§4. Sequencer causal, outbox transaccional, release gate, ACK y DLQ intactos.

## 2. §1 · Receptor con ledger durable

El estado pasó de memoria del módulo a un **Durable Object SQLite singleton**. El motivo es
concreto: un isolate puede ser evictado en cualquier momento, y la versión anterior podía perder en
silencio justamente el registro de orden en el que se apoya el gate de reorden.

Se persiste por observación: `id` autoincremental (**el orden real de recepción**), `ts_ms`,
`edge_seq`, `digest` de la cabecera, `received_digest` calculado, `digest_match`, `bytes`, número de
intento, comportamiento aplicado y resultado.

`GET /` lee de SQLite y devuelve además dos campos listos para el gate:

- `accepted_order` — las secuencias en el orden en que KAWA las aceptó
- `digest_mismatches` — debe ser **0**

Reset explícito: `POST /control {"behaviour":"reset"}`.

**Detalle de diseño:** la observación se persiste **antes** de producir la respuesta, así que una
respuesta que nunca llega —el caso `silent_once`— queda igualmente registrada. Sin eso, el gate F no
tendría evidencia de que el receptor sí recibió.

## 3. §2 · Control de comportamiento

Tenías razón: el consumer no reenvía `x-stg-behaviour`, así que esa cabecera nunca llegaba al
receptor. Ahora el comportamiento se programa en el receptor, autenticado:

```bash
curl -X POST -H "Authorization: Bearer $CONTROL_TOKEN" -H 'content-type: application/json' \
     -d '{"behaviour":"permanent4xx"}' https://kawa-staging-receiver.<sub>.workers.dev/control
```

| Comportamiento | Efecto | Gate |
|---|---|---|
| `ok` | acepta; duplicados reconocidos por digest | A, C, D, E |
| `silent_once` | **un** request sin respuesta, luego `ok` | F |
| `fail5xx_once` | **un** `503`, luego `ok` | M, N |
| `permanent4xx` | `400` permanente hasta cambiarlo | G, H, I, J |
| `slow_once` | **un** request con 20 s de retardo | F |
| `reset` | limpia ledger y script | entre escenarios |

Los `*_once` se consumen con un solo request, así que puedes guionizar un fallo aislado **sin
redesplegar nada entre intentos**, que era el objetivo.

Auth fallida → `404` genérico: un token sin configurar es indistinguible de uno erróneo.

## 4. §3 · Hard-lock estructural de la entrega

```toml
[[services]]
binding = "KAWA_FETCHER"
service = "kawa-staging-receiver"

[vars]
KAWA_WEBHOOK_URL = "https://staging-receiver.invalid/webhook/stg"
```

`KAWA_WEBHOOK_URL` **deja de ser secreto**. Su host `.invalid` nunca se marca: el Service Binding
decide el destino y el valor solo aporta una URL sintácticamente válida para construir el `Request`.

La lógica del consumer **no cambió** — ya soportaba `KAWA_FETCHER` desde V1.2.0.

Esto convierte en estructuralmente cierta la afirmación *"STAGING no tiene ruta capaz de ejecutar una
orden real"*: ya no depende de que alguien escriba bien una URL, sino de que no existe forma de
alcanzar otro host.

## 5. §4 · Marcador de halt y superficie admin

**El bug que señalaste era real.** `adminResume()` borraba `halted_seq` en toda operación exitosa, de
modo que una acción forzada sobre otra secuencia **borraba el marcador de un halt distinto**, y el
stream podía avanzar sobre un incidente que nadie había atendido.

Ahora solo se limpia cuando la operación resuelve **el halt actual**. Tres tests nuevos lo cubren:
acción forzada sobre otra secuencia con el marcador intacto, resolución del halt actual que sí lo
limpia, y auditoría diferenciada.

**El Worker admin rechaza `force` sobre HTTP** con `FORCE_NOT_ALLOWED_OVER_HTTP`. Los gates solo
necesitan retry/skip del halt actual. La capacidad forzada sigue existiendo internamente por RPC para
una emergencia documentada, que es donde debe estar.

## 6. §5 · Primer despliegue con `--secrets-file`

**Verificado en el CLI real** (`wrangler deploy --help` sobre 4.132.0):

> `--secrets-file` — Path to a file containing secrets to upload with the version (JSON or .env
> format). **Applies additively with secrets from previous deployments — omitted secrets will not be
> deleted.**

Ese carácter aditivo importa: un redespliegue con un fichero parcial **no** borra los secretos
previos, así que no hay riesgo de dejar un Worker sin secreto por omisión.

```bash
# Fichero temporal FUERA del repositorio y FUERA del ZIP
cat > /tmp/stg-ingress.json <<'JSON'
{ "WEBHOOK_PATH_TOKEN": "...", "HALT_NOTIFY_URL": "https://..." }
JSON

wrangler deploy --config wrangler.staging.toml --secrets-file /tmp/stg-ingress.json
shred -u /tmp/stg-ingress.json       # bórralo en cuanto termine
```

Igual para el receptor (`CONTROL_TOKEN`) y el admin (`ADMIN_TOKEN`). El consumer **ya no necesita
ningún secreto**.

## 7. Orden de despliegue

```bash
unzip KAWA_EDGE_SIGNAL_BUFFER_V1_2_2_STAGING_FROZEN.zip && cd edge
sha256sum src/*.js staging-receiver/src/index.js admin-worker/src/index.js \
          wrangler*.toml package-lock.json VERSION        # cotejar con §1
npm ci && npm test                                         # 42/42 antes de desplegar

wrangler queues create kawa-signal-buffer-stg
wrangler queues create kawa-signal-buffer-dlq-stg

# receptor primero: el consumer lo referencia por Service Binding
cd staging-receiver
wrangler deploy --secrets-file /tmp/stg-receiver.json && shred -u /tmp/stg-receiver.json
cd ..

wrangler deploy --config wrangler.staging.toml --secrets-file /tmp/stg-ingress.json
shred -u /tmp/stg-ingress.json

# el consumer no lleva secretos
wrangler deploy --config wrangler.consumer.staging.toml

cd admin-worker
wrangler deploy --secrets-file /tmp/stg-admin.json && shred -u /tmp/stg-admin.json
cd ..
```

## 8. §6 · Outage de cola sin destruirla

```bash
wrangler queues pause-delivery kawa-signal-buffer-stg     # verificado en el CLI
# ... enviar alertas: el ingress responde 202 y el outbox las conserva ...
wrangler queues resume-delivery kawa-signal-buffer-stg
```

**No borres la cola.** Pausar la entrega prueba exactamente lo que interesa —el transporte se
detiene, el outbox no— y la cola sobrevive al test.

## 9. Guion de gates actualizado

| # | Gate | Preparación | Evidencia |
|---|---|---|---|
| A | Aceptación durable | — | `202` con `edge_seq` y `digest` |
| B | Fallo de transporte | `queues pause-delivery` → alertas → `resume-delivery` | todas entregadas al reanudar |
| C | **Reorder** | `reset`, 5 alertas | `accepted_order` = `[1,2,3,4,5]` |
| D | Duplicado | reenviar la misma alerta | una sola `ACCEPTED`, luego `DUPLICATE` |
| E | Burst de 10 | `reset`, 10 alertas | `accepted_order` = `[1..10]` |
| F | Respuesta perdida | `silent_once` | sin avance; reintento; luego `DELIVERED` |
| G | HALT DLQ | `permanent4xx` | DLQ escrita; `halted_seq` fijado |
| H | N+1 tras HALT | con el halt activo, `ok`, alerta nueva | **no aparece** en el ledger |
| I | Admin retry | `ok` + `POST /retry` | stream reanuda **en orden** |
| J | `ADMIN_SKIPPED` | `POST /skip` | cabecera avanza; `admin_log` |
| K | Alarm prolongado | `pause-delivery` >15 min | recupera sin intervención |
| L | Reinicio del DO | esperar evicción / redesplegar ingress | secuencia continúa |
| M | Outage del receptor | `fail5xx_once` repetido | nada se pierde |
| N | Recuperación en orden | M con varias en vuelo | orden estricto al drenar |
| — | **Byte-for-byte** | cualquiera | `digest_mismatches` = **0** |

## 10. Teardown

```bash
wrangler delete --name kawa-edge-admin-stg
wrangler delete --name kawa-edge-delivery-stg
wrangler delete --name kawa-edge-ingress-stg        # destruye el SQLite del outbox
wrangler delete --name kawa-staging-receiver        # destruye el ledger del receptor
wrangler queues delete kawa-signal-buffer-stg
wrangler queues delete kawa-signal-buffer-dlq-stg
```

> Borrar los Workers con Durable Object **destruye su SQLite**: el outbox con alertas sin entregar y
> el ledger de evidencia. Exporta `GET /report` antes si quieres conservar la evidencia del gate.

## 11. Congelado

KAWA R8.2.3.3 MAINNET · TradingView PROD · Tunnel PROD · `vector-hook.integrademia.com`.

**NO PROD DEPLOY.**
