# KAWA VECTOR · Multi-Hub Dispatcher V0.1 · TEST REPORT

| | |
|---|---|
| Artefacto | `KAWA_VECTOR_MULTIHUB_DISPATCHER_V0_1.zip` (SHA-256 en el `.sha256` entregado; `MANIFEST.sha256` dentro) |
| Runtime | `node:22-bookworm-slim@sha256:43ac6c60…772c` (Node 22.23.3) · SQLite `node:sqlite` 3.51 · **0 dependencias npm** |
| Evidencia de tests | huella de entradas `60f3c7d9a656636b…` · 20/20 PASS |

## Resultado

| Criterio de terminado | Resultado | Evidencia |
|---|---|---|
| BUILD LEGACY / BUILDKIT OFF | **PASS** | `DOCKER_BUILDKIT=0 docker build --no-cache`: salida del builder clásico (`Step 1/…`, `Successfully built`), 4-5 s; `docker compose build` con BuildKit OFF |
| COMPOSE | **PASS** | `docker compose config` sobre el fichero entregado, sin `.env`; arranque con `docker compose up -d`, como Container Manager |
| UNIT / CONTRACT | **PASS** | 20/20 en 1,5 s (`node --test`, 4 ficheros en paralelo) |
| RESTART DURABILITY | **PASS** | en proceso (backlog sobrevive a stop/start) y físico (`docker compose restart` con una señal pendiente → entregada) |
| MULTI-HUB INDEPENDENCE | **PASS** | con HUB_B caído, HUB_A sigue recibiendo; al volver HUB_B, su backlog llega en orden (s2, s3) |
| FINAL PACKAGE SMOKE | **PASS** | gate físico sobre el ZIP extraído en una carpeta vacía (20/20 comprobaciones, 54 s) |
| NO SECRETS | **PASS** | ZIP con `secrets/` vacíos; registros sin secretos ni cuerpo de señal; la imagen no contiene ni secretos, ni configuración, ni base de datos |

## Tests obligatorios (sección 15) → dónde se prueban

| # | Contrato | Test |
|---|---|---|
| 1 | POST válido → SQLite → 2xx | `ingress` · POST → committed → 200 |
| 2 | error SQLite → 503 | `ingress` · storage error → 503 |
| 3 | HUB_A entrega | `delivery` · own path secret; gate físico |
| 4 | HUB_B caído no bloquea HUB_A | `delivery` · HUB_B down; gate físico |
| 5 | HUB_B vuelve → retry → entrega | `delivery` (en orden); gate físico |
| 6 | N destinos configurables | `delivery` · 4 Hubs desde la configuración; `config` · N destinos |
| 7 | `enabled:false` no recibe | `delivery` · HUB_D deshabilitado: ni petición ni fila |
| 8 | timeout en uno no bloquea otro | `delivery` · Hub que nunca responde (timeout 300 ms) |
| 9 | reinicio conserva backlog | `delivery` · restart; gate físico |
| 10 | payload RAW preservado | `ingress` · bytes idénticos (UTF-8, CRLF), `Content-Type` y cabeceras de origen (`cf-connecting-ip`, `user-agent`) |
| 11 | secreto diferente por Hub | `delivery` · cada Hub recibe su ruta; `config` · secreto compartido → rechazado |
| 12 | secreto nunca en logs | `delivery` · no secret in logs; gate físico sobre `docker compose logs` |
| 13 | config inválida → fail closed | `config` · JSON inválido, ids, `enabled` no booleano, secretos |
| 14 | destinations vacío → fail closed | `config` · vacío / ninguno habilitado |
| 15 | puerto/URL inválidos → fail closed | `config` · puertos 0, 70000, `"8181"`, 8.5; 8180/8191/8080 prohibidos; host con esquema, puerto o ruta |
| 16 | `/health` refleja DB sana | `ingress` · healthy / 503 unhealthy; gate físico |
| 17 | arranca con volumen existente | gate físico · reinicio con `./data` existente (propiedad de uid 1026) |
| 18 | arranca con `data/` recién creada | gate físico · `data/` borrada → la crea, healthy, entrega |
| 19 | `docker compose config` | gate físico |
| 20 | build con BuildKit OFF | gate físico |

Además: el dispatcher no deduplica (dos cuerpos idénticos son dos señales); un 4xx del Hub es
`FAILED_PERMANENT`, se conserva y no se reintenta, y la siguiente señal sigue fluyendo; las peticiones rechazadas
(token de ruta erróneo 401, GET 405, otra ruta 404, cuerpo grande 413) no guardan nada.

## Gate físico (`tools/physical-gate.sh`, equivalente a Synology)

Carpeta vacía, ZIP extraído y con propietario uid 1026:100 (como File Station). Se usa el `docker-compose.yml`
entregado **sin cambios**, más un override solo de test que añade dos Hubs simulados en el mismo proyecto. El único
paso manual es el del usuario: editar `config/destinations.json` y rellenar `secrets/`.

```
PASS  ZIP sha256 matches .sha256
PASS  MANIFEST.sha256 verifies every shipped file
PASS  shipped secrets/ are empty; no .env, no data/*.db
PASS  docker compose config (shipped file, no .env)
PASS  classic builder (DOCKER_BUILDKIT=0), no cache: 5 s
PASS  docker compose build with BuildKit OFF
PASS  container healthy (Docker HEALTHCHECK)
PASS  /health = {"status":"healthy","db":"ok","destinations_enabled":2}
PASS  hardening: privileged=false read_only=true cap_drop=ALL (+DAC_OVERRIDE) no-new-privileges
PASS  POST → 200
PASS  SQLite file persisted in ./data (owned by uid 1026)
PASS  HUB_A mock and HUB_B mock received the raw body
PASS  HUB_A called with ITS own secret path
PASS  HUB_B down: HUB_A keeps receiving (2 more)
PASS  dispatcher logs RETRY HUB_B
PASS  HUB_B back: backlog delivered in order (s2, s3)
PASS  restart with an existing ./data: pending signal delivered after restart
PASS  fresh (missing) data/ folder: created, healthy, delivers
PASS  logs: RECEIVED/PERSISTED/DELIVERED/RETRY present; no secret, no payload
PASS  image: no secrets, no config, no DB baked in
```

## Tiempos medidos

| Paso | Objetivo | Medido |
|---|---|---|
| suite dirigida (un fichero) | < 15 s | 1,5 s |
| suite completa offline | < 60 s | 1,5 s |
| package (sin repetir la suite) | < 10 s | 8 ms |
| gate físico completo | — | 54 s: build sin caché ~5 s; ~30 s esperando la primera comprobación del HEALTHCHECK de Docker (intervalo 30 s); el resto, esperas de reintento |

## Decisión declarada: `cap_add: DAC_OVERRIDE`

El contenedor corre como root **dentro** del contenedor, con todas las capacidades eliminadas salvo
`DAC_OVERRIDE`, rootfs de solo lectura y `no-new-privileges`. Sin esa capacidad no puede escribir en un `data/` que
pertenece al usuario del NAS, y el requisito es no tocar permisos a mano. Comprobado:

```
[cap_drop ALL, nothing added]         exit=1 :: START_FAILED reason="unable to open database file"
[cap_drop ALL + cap_add DAC_OVERRIDE] runs (parado por el timeout de 8 s del experimento: STOPPING signal=SIGTERM)
```

## Límites

- Sin NAS físico en este entorno: el gate se ejecuta con Docker 29 y el builder clásico. El comportamiento de las
  ACL de Synology sobre `data/` se cubre con `DAC_OVERRIDE`, pero no se ha probado en un DSM real.
- La caída total del NAS queda fuera de alcance, como indica la especificación (futuro Edge Buffer).
- Un Hub que responda 5xx a una señal concreta la reintenta sin límite (`max_attempts: 0`) y retiene las
  siguientes de **ese** Hub, para conservar el orden. Es configurable (`retry.max_attempts`).
