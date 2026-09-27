# KAWA VECTOR · Edge Signal Buffer · INSTALACIÓN EN EL NAS (V1.3.1 R3.3)

Todo corre en **un contenedor temporal** en tu Synology: no instalas Node, npm ni Wrangler en Windows, no
creas nada a mano en el dashboard de Cloudflare y no editas TOML. El contenedor **no publica puertos, no
comparte nada con HUB_A** y termina al acabar cada comando.

> HUB_A MAINNET, su compose, sus volúmenes, sus puertos (8180 control / 8181 ingress), el Tunnel,
> `vector-hook.integrademia.com` y TradingView **no se tocan** en ningún paso de esta guía.

## 0. Requisitos (una vez)

- DSM 7.2+ con **Container Manager** instalado (Centro de paquetes).
- **SSH** activado: Panel de control → Terminal y SNMP → *Habilitar SSH*.
- ~1.5 GB libres en el volumen y salida HTTPS a Internet desde el NAS.
- Un **API Token** de Cloudflare dedicado: sigue [`CLOUDFLARE_API_TOKEN.md`](./CLOUDFLARE_API_TOKEN.md)
  (2 permisos obligatorios para STAGING y un tercero, *Account Analytics: Read*, para autorizar PROD; 5 minutos).

## 1. Subir, verificar **antes** de extraer, y extraer

1. Copia `KAWA_EDGE_SIGNAL_BUFFER_V1_3_1_NAS_R3.3_2026-09-27.zip` **y** su `.sha256` a
   `/volume1/docker/kawa-edge-deployer/` (File Station). **No lo extraigas todavía.**
2. Por SSH, comprueba el hash con la herramienta del sistema (no con nada que venga dentro del ZIP):

```sh
cd /volume1/docker/kawa-edge-deployer
head -n 1 KAWA_EDGE_SIGNAL_BUFFER_V1_3_1_NAS_R3.3_2026-09-27.zip.sha256 | sha256sum -c -   # → ...zip: OK
```

   El hash de la primera línea debe ser además el que te dio el desarrollador por otro canal. La segunda
   línea es el hash del `MANIFEST_SHA256_V1_3_1.json` que va dentro (lo comprueba `verify-release`).
   Si no dice `OK`, **para**: no extraigas ni ejecutes nada.
3. Extrae el ZIP ahí (File Station, con tu usuario): aparece `kawa-edge-nas/`, una carpeta **distinta** de
   la de HUB_A. Debe pertenecer a **tu usuario del NAS, no a root** (el contenedor corre con ese usuario y
   el lanzador se niega a correr como root). Si la extrajiste por SSH con `sudo`, corrígelo una vez:
   `sudo chown -R <tu-usuario>:users /volume1/docker/kawa-edge-deployer/kawa-edge-nas`.

(`./kawa-edge verify-zip <zip>` hace la misma comprobación desde un paquete ya verificado, p. ej. para
comprobar la siguiente versión antes de extraerla; exige el `.sha256` o el hash como argumento.)

## 2. Configurar (solo un dato para STAGING)

```sh
cp config/kawa-edge.example.json config/kawa-edge.json
vi config/kawa-edge.json      # (o edítalo con File Station / Text Editor)
```

Cambia **solo** `cloudflare.account_id` (dashboard → Workers & Pages → columna derecha «Account ID»).
Los destinos de ejemplo (`HUB_A`, `HUB_B` en STAGING; `HUB_A` en PROD) ya son los correctos. Este
fichero **no contiene ni debe contener secretos**: el instalador lo rechaza si ve uno.

## 3. Comprobación rápida (sin Cloudflare, ~15 s tras la primera construcción)

```sh
sudo ./kawa-edge verify-fast
```

La primera vez construye la imagen (unos minutos en un NAS; después segundos gracias a la caché).
Comprueba manifest, toolchain fijada (wrangler 4.132.0), tu configuración, el aislamiento
STAGING/PROD y compila los 8 Workers sin subir nada. Debe terminar en **PASS**.

Opcional, para ver la suite completa en tu propio NAS (~1–3 min): `sudo ./kawa-edge test-full`.

## 4. Instalar STAGING y probarlo (un comando)

```sh
sudo ./kawa-edge install
```

1. Pide el **API Token** (entrada oculta; no se guarda).
2. Pide una URL de notificación de halts para STAGING (opcional, Enter = ninguna).
3. **Preflight** de solo lectura: identidad, permisos, recursos existentes. Reutiliza las 4 colas `-stg`
   que ya creaste; si algo no le pertenece o no cuadra, **se detiene sin cambiar nada** y explica qué.
4. Despliega en orden: colas → receptores STAGING (uno por Hub) → ingress + Sequencer → consumer HUB_A →
   consumer HUB_B → admin temporal → verifica secretos.
5. Ejecuta los **gates STAGING** (≈ 20 min, incluye un gate de 6 min de corte prolongado). Con `--quick`
   se omite ese gate y el resultado es `PARTIAL` (BLOCKED): **no** cuenta como STAGING PASS.
6. Resultado: **`PASS  STAGING PASS`** o **`FAIL`** con el gate y el motivo exactos.
   Evidencia completa en `state/evidence/staging-gates-cloud-…-PASS.json`.

Repetir `install` es seguro: lo que ya está al día no se vuelve a desplegar.

## 5. Después

Todo lo demás (estado, HUB_A en paralelo, cutover, añadir HUB_N, rollback) está en
[`RUNBOOK_VIGENTE.md`](./RUNBOOK_VIGENTE.md), el **único runbook en vigor**.

> **Importante antes de PROD:** esta versión declara dos bloqueos que impiden el cutover
> (B-1: no hay vía segura de retry/skip en PROD dentro de R4; B-2: no hay un método no-trading para
> validar Edge → HUB_A). `./kawa-edge cutover-check` los muestra. TradingView **sigue directo a HUB_A**.

## Sin SSH (alternativa por la interfaz de Container Manager)

Solo para `install`/`gates`/`status` (los pasos PROD piden datos por teclado y requieren SSH):

1. Crea `kawa-edge-nas/.env` con: `KAWA_COMMAND=install`, `KAWA_NONINTERACTIVE=1`, `KAWA_UID=<tu uid>`, `KAWA_GID=<tu gid>`
   (los ves en Panel de control → Usuario, o `id` por SSH).
2. Crea `secrets/cloudflare_api_token` con el token (una línea). El instalador lo lee, lo sobrescribe y lo
   borra al arrancar. En btrfs con instantáneas eso **no** garantiza su destrucción física: prefiere el
   prompt por SSH o rota el token al terminar (ver `secrets/README.md`).
3. Container Manager → Proyecto → Crear → ruta `kawa-edge-nas` → usa `docker-compose.yml` → Construir e
   iniciar. El resultado aparece en el registro del contenedor y en `state/`.

## Detrás de un proxy con inspección TLS (raro en casa)

```sh
sudo ./kawa-edge refresh-context          # tras descomprimir una versión nueva sobre la anterior
sudo KAWA_UID=$(stat -c %u .) KAWA_GID=$(stat -c %g .) docker compose build \
     --build-arg HTTPS_PROXY=http://proxy:3128 --secret id=npm_ca,src=/ruta/ca-del-proxy.pem
```

La CA solo se usa durante `npm ci`; no queda en la imagen. Después usa el lanzador sin reconstruir:
`sudo KAWA_SKIP_BUILD=1 ./kawa-edge install`. (Si el proxy no inspecciona TLS, basta con exportar
`HTTPS_PROXY`: el lanzador lo pasa a la construcción.)

## Si algo falla

| Mensaje | Qué hacer |
|---|---|
| `CONFIG_ACCOUNT_ID` | pon el Account ID (32 hex) en `config/kawa-edge.json` |
| `TOKEN_INVALID` / `TOKEN_NOT_ACTIVE` | token mal copiado, caducado o revocado: crea otro |
| `CF_PERMISSION … missing: …` | añade exactamente ese permiso al token |
| `NO_WORKERS_SUBDOMAIN` | dashboard → Workers & Pages → configura tu subdominio `workers.dev` una vez |
| `RESOURCE_CONFLICT … NOT created by this deployer` | existe un Worker/cola con ese nombre que no es de este instalador; no se toca: revísalo tú |
| `RESOURCE_CONFLICT … PAUSED` | `sudo ./kawa-edge resume-queues staging` y repite |
| `G00 … halted / unresolved` | STAGING quedó sucio de una ejecución interrumpida: `sudo ./kawa-edge gates --repair` |
| `NO_TTY` | ejecuta por SSH con `sudo ./kawa-edge …` (hace falta un terminal para los prompts ocultos) |
| permiso denegado en `state/` | ejecuta siempre con `./kawa-edge` (usa el propietario de la carpeta como usuario del contenedor) |
| `this folder belongs to root` | `sudo chown -R <tu-usuario>:users .` en `kawa-edge-nas/` (paso 1.3) |
| `symbolic link found at …` / `… is a symbolic link` | alguien dejó un enlace simbólico en `state/`, `secrets/` o `config/`; bórralo. El lanzador corre con sudo y nunca sigue enlaces (F-02) |
| `no complete, signed Cloudflare STAGING PASS …` al ir a PROD | no hay un STAGING PASS firmado, completo y del mismo código/cuenta/destinos; el mensaje lista cada motivo (p. ej. falta *Account Analytics: Read*) |

Cada ejecución deja un log redactado en `state/logs/` (sin secretos).
