# KAWA VECTOR · EDGE SIGNAL BUFFER — V1.3.x · MULTI-DESTINATION DURABLE FAN-OUT

**Código del Edge:** idéntico a V1.3.0 R4 (`src/**` byte a byte). **Paquete:** V1.3.1 R1 (instalador NAS).

> **Cómo instalar y operar:** `../README_NAS_INSTALL.md` y `../RUNBOOK_VIGENTE.md` (único runbook en vigor).
> Los configs de wrangler **se generan** desde `../config/kawa-edge.json`; en esta carpeta no hay ningún
> `wrangler*.toml`, a propósito: un `wrangler deploy` sin `--config` debe fallar.

## Qué es

Un buffer durable y preservador de orden entre TradingView y los KAWA Hubs. La alerta se persiste **una vez**
en un Durable Object SQLite (Sequencer) **antes** de responder 202, y se entrega de forma independiente a N
Hubs, cada uno con su cola, DLQ, consumer, credencial, cabeza causal y halt propios. Semántica at-least-once
con orden estricto por destino. El Edge no interpreta la estrategia (LONG/SHORT, sizing, stops, TTL,
lifecycle): el Hub es la única autoridad de trading.

## Contenido

| Ruta | Qué es |
|---|---|
| `src/` | ingress, Sequencer (DO) y consumer por destino — **sin cambios desde R4** |
| `staging-receiver/` | receptor STAGING sin capacidad de operar (uno desplegado por Hub) |
| `admin-worker/` | admin **temporal de STAGING**; nunca en PROD (R4) |
| `test/` | 95 tests en workerd (90 de R4 + 2 guardián de red hermética + 3 del consumer con su propia entrada) |
| `vitest.config.js` | harness; V1.3.1 lo hace hermético (ver `../ROOT_CAUSE_NAS_53_90.md`) |
| `ARCHITECTURE_V1_3_0.md` | arquitectura de referencia (autoridad) |
| `MIGRATION_AND_DEPLOYMENT_V1_3_0.md` | migración y contrato de despliegue/rollback (autoridad); lo ejecuta el instalador |
| `TEST_REPORT_V1_3_0.md`, `REQUIREMENTS_MATRIX_V1_3_0.json` | informe y matriz de R4 (históricos) |
| `destinations.example.json` | forma de `DESTINATIONS`, sin secretos |

## Lo que este componente no garantiza

**Durabilidad del mensaje ≠ validez de la operación.** El Edge preserva y entrega; cada Hub conserva la
autoridad sobre autenticación, deduplicación por `signal_id`, TTL, gate causal, sizing, ejecución y
recuperación.
