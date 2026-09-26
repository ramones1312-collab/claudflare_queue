# API Token de Cloudflare · permisos exactos

Un token **dedicado**, solo para este instalador, con alcance a **una cuenta**. Se escribe en el NAS en
un prompt oculto (o en el fichero de un solo uso `secrets/cloudflare_api_token`); nunca va en Git, en la
imagen, en el ZIP, en logs ni en informes, y no se pega en ningún chat.

## Crear el token (navegador, una vez)

1. Cloudflare dashboard → icono de perfil → **My Profile → API Tokens → Create Token**.
2. **Create Custom Token** (no uses plantillas: dan más permisos de los necesarios).
3. Nombre: `kawa-edge-nas-deployer`.
4. **Permissions** — añade exactamente estas filas:

| Tipo | Recurso | Nivel | Obligatorio | Para qué (endpoints observados) |
|---|---|---|---|---|
| Account | **Workers Scripts** | **Edit** | **Sí** | desplegar/borrar Workers (`PUT /workers/scripts/:name`, `DELETE /workers/services/:name`), subir secretos con el despliegue, leer bindings y nombres de secretos (`GET …/settings`, `…/secrets`), subdominio `workers.dev`, namespaces de Durable Objects |
| Account | **Queues** | **Edit** | **Sí** | listar/crear colas (`GET/POST /queues`), registrar consumers (`POST /queues/:id/consumers`), pausar/reanudar entrega en los gates (`queues pause-delivery / resume-delivery`) |
| Account | Account Settings | Read | Opcional | mostrar el nombre de la cuenta en el preflight (`GET /accounts/:id`); sin él se continúa |
| Account | Account Analytics | Read | Opcional (recomendado) | backlog de colas por GraphQL: evidencia de DLQ en el gate G y la comprobación C6 «colas limpias» del cutover; sin él aparecen como `UNKNOWN` |
| Account | Workers Tail | Read | Opcional | solo para `./kawa-edge tail <worker>` (logs en vivo, redactados) |

5. **Account Resources** → *Include* → **tu cuenta concreta** (no «All accounts»).
6. **Zone Resources**: ninguno. El Edge usa `*.workers.dev`; no se crean rutas ni dominios.
7. (Recomendado) **Client IP Address Filtering**: la IP pública de salida de tu NAS.
8. (Recomendado) **TTL**: una fecha de caducidad (p. ej. el fin de la instalación); puedes crear otro
   token más adelante para operar.
9. *Continue to summary* → *Create Token* → copia el valor **una sola vez** y pégalo en el prompt del NAS.

## Lo que NO necesita (y no debe tener)

- Ningún permiso de **Zone** (DNS, Tunnel, rutas): el instalador **no toca** el Tunnel ni
  `vector-hook.integrademia.com`.
- **Cloudflare Tunnel / Zero Trust**, **DNS**, **KV**, **R2**, **D1**, **Pages**, **User → Memberships**:
  no se usan. (Al borrar un Worker, wrangler intenta listar KV para limpiar «Workers Sites»; con este
  token recibe 403 y lo omite — comprobado en el test E2E de teardown.)

## Cómo se verificó esta lista

El test E2E ejecuta el CLI real y el **wrangler fijado 4.132.0** contra un API de Cloudflare simulado que
registra cada petición. Sobre un ciclo completo (install, status, add-hub, prod-deploy, cutover-check,
staging-teardown) los endpoints usados fueron exactamente los de la tabla. Ninguna llamada a `/memberships`,
a zonas ni a Tunnel. El preflight comprueba en lectura cada permiso obligatorio y, si falta uno, lo nombra
(«The token is missing: Account · Queues · Edit»). El de escritura se comprueba en la primera escritura; un
fallo ahí deja solo colas creadas (reutilizables en la siguiente ejecución), nunca un Worker a medias.

## Revocar

My Profile → API Tokens → `kawa-edge-nas-deployer` → **Roll** o **Delete**. Los Workers desplegados siguen
funcionando: el token solo se usa para instalar y operar.
