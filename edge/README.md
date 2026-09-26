# KAWA VECTOR · EDGE SIGNAL BUFFER — V1.3.0 STAGING · MULTI-DESTINATION DURABLE FAN-OUT

**Identidad:** `edge-signal-buffer-v1.3.0-staging` · **Revisión:** R4 (remediación de reauditoría) · **Linaje:** V1.3.0 ← V1.2.3 STAGING FROZEN
**Validación local:** 90/90 tests PASS en 9 runtimes aislados dentro de workerd
(41 legacy sin cambios + 1 legacy actualizado por la política 401/403 + 48 nuevos)

**Baseline de contrato:** KAWA VECTOR R8.2.3.3 — el contrato de webhook contra el que se validó la
matriz causal. **Hub operativo actual:** KAWA VECTOR **R8.4 REV8**, que este artefacto no modifica.

> ## NO PROD
>
> Este artefacto es **exclusivamente para Cloudflare STAGING**. No despliega ni puede desplegar
> producción. Todos los recursos llevan sufijo `-stg` y la entrega está bloqueada estructuralmente
> al receptor de staging mediante Service Binding.
>
> Permanecen congelados y fuera del alcance de este paquete: el **Hub KAWA VECTOR operativo**
> (actualmente **R8.4 REV8**; R8.2.3.3 es el **baseline de contrato** contra el que se validó la
> matriz causal, no la versión en operación),
> **TradingView PROD**, **Tunnel PROD** y **vector-hook.integrademia.com**.

## Qué es

Un buffer durable y preservador de orden entre TradingView y KAWA VECTOR. Recibe la alerta en el
edge, la persiste en un outbox transaccional (SQLite en un Durable Object) **antes** de responder, y
la entrega en el orden exacto de llegada, con independencia de cómo reordene la cola.

V1.3.0 añade **fan-out durable multi-destino**: una sola alerta se persiste **una vez** y se entrega
de forma independiente a N KAWA Hubs, cada uno con su propia cola, su propia cabeza de orden, su
propio halt y su propia credencial. Un Hub caído, detenido o con credencial rechazada no bloquea,
retrasa ni duplica a los demás. Con un solo destino configurado, el comportamiento es el de V1.2.3.

El Edge no interpreta la estrategia: no conoce LONG/SHORT, ENTRY/EXIT, sizing, leverage ni lifecycle.
Su única responsabilidad causal es *"recibí A antes que B; entregaré A antes que B"*.

## Empieza aquí

**Todo el procedimiento está en [`STAGING_RUNBOOK.md`](./STAGING_RUNBOOK.md)**: hashes de
verificación, recursos a crear, orden exacto de despliegue, guion de gates, observabilidad y
teardown.

Este paquete es autosuficiente: no necesitas ningún documento externo para desplegar STAGING.

## Verificación e instalación

```bash
sha256sum src/*.js staging-receiver/src/index.js admin-worker/src/index.js \
          wrangler*.toml package-lock.json VERSION    # cotejar con el runbook
npm ci
npm test                                               # debe dar 90/90
```

## Estructura

| Ruta | Qué es |
|---|---|
| `src/` | ingress, sequencer Durable Object y delivery consumer |
| `wrangler.staging.toml` | ingress + sequencer (`kawa-edge-ingress-stg`) |
| `wrangler.consumer.staging.toml` | consumer de UN destino (camino de compatibilidad V1.2.3) |
| `wrangler.consumer.hub-a.staging.toml`, `…hub-b…` | un consumer POR destino, con su cola, su DLQ y su secreto |
| `destinations.example.json` | configuración de destinos de ejemplo, **sin secretos** |
| `ARCHITECTURE_V1_3_0.md` | invariante por destino, esquema, política de fallos, reglas y seguridad |
| `TEST_REPORT_V1_3_0.md` | resultado de la suite, mutación y límites declarados |
| `MANIFEST_SHA256_V1_3_0.json` | SHA-256 de cada archivo del paquete (su propio hash excluido) |
| `MIGRATION_AND_DEPLOYMENT_V1_3_0.md` | migración en sitio, orden de despliegue, alta de HUB_C, rollback |
| `staging-receiver/` | receptor STAGING sin capacidad de operar; ledger durable de evidencia |
| `admin-worker/` | superficie admin **temporal** para los gates; borrar al terminar |
| `test/` | 90 tests en runtimes aislados + matriz causal contra el baseline de contrato R8.2.3.3 |
| `VERSION` | identidad y registro de cambios |

**No hay ningún `wrangler.toml` en la raíz, a propósito.** Ejecutar `wrangler deploy` sin
`--config` debe fallar en lugar de desplegar una forma no aislada del sistema.

## Despliegue, en una línea

No lo hagas desde este README. Sigue el orden del runbook: colas → receptor → ingress → consumer →
admin. El orden importa porque el consumer referencia al receptor por Service Binding.

## Lo que este componente no garantiza

**Durabilidad del mensaje ≠ validez de la operación.** El buffer preserva y entrega; KAWA conserva
la autoridad sobre TTL, freshness, deduplicación y ejecución. Una alerta antigua puede entregarse
correctamente y ser rechazada con razón por KAWA.
