# Contexto para auditoría externa · KAWA Edge Signal Buffer V1.3.1 R1 (NAS turnkey)

Este documento acompaña a tres ficheros:

| Fichero | Qué es |
|---|---|
| `KAWA_EDGE_SIGNAL_BUFFER_V1_3_1_NAS_R1_2026-09-26.zip` | el artefacto a auditar |
| `KAWA_EDGE_SIGNAL_BUFFER_V1_3_1_NAS_R1_2026-09-26.zip.sha256` | `dcab151fc5f3abd03657943664a0133a633b7215b029cece923f84d86b0292a8` |
| `RELEASE_REPORT_V1_3_1.md` | informe de release del desarrollador (también va dentro del ZIP) |

Se pide una **validación independiente**: no dar por buena ninguna afirmación del informe sin comprobarla.
Si falta algo para verificar un punto, indíquelo como «no verificable» en lugar de suponerlo.

---

## 1. Qué es el sistema (en una página)

```
TradingView → Cloudflare Edge (Workers) → persistencia durable (Durable Object SQLite) → fan-out
            → una cola + DLQ + consumer + credencial por destino → HUB_A, HUB_B, … HUB_N
```

- El **Edge es solo transporte durable**: recibe la alerta, la persiste **una vez**, le asigna `edge_seq`,
  y la entrega a cada Hub **en orden estricto por destino**, con semántica at-least-once. No interpreta
  la estrategia (LONG/SHORT, sizing, stops, TTL, lifecycle).
- Cada Hub tiene su propia cola, DLQ, consumer, credencial, cabeza causal y halt. Un Hub caído o en
  `FAILED_PERMANENT` no debe bloquear a otro. Un Hub añadido después **no recibe histórico**.
- El **Hub** (KAWA VECTOR, fuera de alcance) es la única autoridad de trading: autenticación del webhook,
  deduplicación por `signal_id`, TTL, ejecución, recuperación.

## 2. Linaje y qué cambió

- **Base:** V1.3.0 R4 CANDIDATE, ZIP SHA-256
  `1bcd1e3df8fba89781916efcaf173a45983f0566bb189d59e20929766db82867`. El propietario puede
  facilitarle ese ZIP para comparar.
- **Afirmación central a verificar:** el código de producción del Edge (`edge/src/**`,
  `edge/staging-receiver/src/**`, `edge/admin-worker/src/**`) es **byte a byte idéntico a R4**, y los 90
  tests de R4 no se modificaron.
- **Cambios declarados:** `CHANGELOG_V1_3_1.md` (lista exhaustiva). En resumen:
  1. un cambio en el harness de tests (`edge/vitest.config.js`) + 5 tests nuevos;
  2. un instalador nuevo (`deployer/`, Node sin dependencias nuevas) que **genera** los configs de wrangler;
  3. empaquetado Docker (`Dockerfile`, `docker-compose.yml`, lanzador `kawa-edge`);
  4. documentación; retirada del runbook legacy V1.2.x.

## 3. Restricciones del propietario (el auditor debe respetarlas)

- **HUB_A MAINNET está operando en producción** y no debe verse afectado en ningún momento: nada de
  detenerlo, reiniciarlo, llamarlo ni enviarle tráfico. Puertos: **8180/8080 = CONTROL**, **8181/8081 =
  INGRESS**. Ninguna señal puede ir nunca a 8180/8080.
- No tocar el Cloudflare Tunnel, `vector-hook.integrademia.com`, ni TradingView.
- No desplegar nada en la cuenta Cloudflare de producción del propietario salvo que él lo autorice
  expresamente. **Toda la auditoría técnica se puede hacer sin cuenta de Cloudflare** (ver §5).
- No ejecutar `npm audit fix` ni actualizar dependencias (cualquier cambio exige una revisión nueva).

## 4. Qué pedimos validar (prioridad descendente)

**A. Integridad e identidad**
1. SHA-256 del ZIP = valor del `.sha256`.
2. `MANIFEST_SHA256_V1_3_1.json` verifica los 92 ficheros declarados y no hay ficheros sin declarar.
3. `edge/src/**` byte-idéntico a R4 (comparar contra el ZIP R4).
4. Los ficheros de test de R4 no fueron modificados (solo se añadieron 2 ficheros de test).

**B. Causa raíz del fallo 53/90 en el NAS** (`ROOT_CAUSE_NAS_53_90.md`)
5. ¿La explicación (búsquedas DNS reales de `halt-notify.test` que bloquean el único runtime workerd
   compartido) es correcta y suficiente? ¿Reproducible con R4 usando `--dns 192.0.2.1`?
6. ¿La corrección (`outboundService` en `vitest.config.js`) es legítima, es decir, no oculta un fallo
   del producto ni debilita ningún test? El propietario prohibió subir timeouts, saltar tests o relajar
   aserciones.

**C. Seguridad y aislamiento**
7. El token de API de Cloudflare nunca queda en disco, logs, informes ni en la imagen.
8. Los secretos de webhook de cada Hub nunca se guardan ni se imprimen, y el mismo secreto no puede
   reutilizarse entre Hubs.
9. **STAGING no puede alcanzar ningún host de producción** (los consumers STAGING quedan fijados a su
   receptor por Service Binding). Verificar también la URL de notificación de halts: es la única salida
   del Sequencer que **no** pasa por un Service Binding.
10. Los configs PROD nunca contienen Service Binding, nombres STAGING ni el admin HTTP (R4 lo prohíbe).
11. Cualquier URL con 8180/8080 se rechaza; solo se acepta `https://vector-hook.integrademia.com/webhook/<secreto>`
    como destino de HUB_A.
12. Contenedor: sin puertos, sin privileged, `cap_drop: ALL`, rootfs de solo lectura, red propia,
    ningún volumen compartido con HUB_A, imagen base fijada por digest.

**D. Comportamiento del instalador**
13. Fallo cerrado: ante un conflicto (Worker ajeno con el mismo nombre, cola con consumer ajeno, cola
    pausada, token inválido, falta de subdominio `workers.dev`) se detiene **antes de escribir nada**.
14. Idempotencia: una segunda ejecución no escribe nada. Las 4 colas STAGING que ya existen se reutilizan.
15. `add-hub` no modifica los Workers de los Hubs existentes; el Hub nuevo empieza en la siguiente señal.
16. Todo `wrangler deploy` usa el binario fijado (4.132.0) con `--config` explícito.
17. Los configs generados son semánticamente iguales a los TOML de R4 salvo las 5 diferencias declaradas
    en el CHANGELOG. **Juzgar si esas diferencias están justificadas**, en especial:
    un receptor STAGING por Hub, y que cada consumer lleve solo su propia entrada de `DESTINATIONS`.

**E. Gates STAGING** (`deployer/lib/gates/run.mjs`, tabla en `RUNBOOK_VIGENTE.md §3.1`)
18. ¿Cada gate comprueba realmente lo que su título afirma? ¿Hay caminos de PASS falso (conjuntos vacíos,
    timeouts tratados como éxito, limpieza que falla en silencio)?
19. ¿Es correcto que 5 gates (ISO-X, ISO-Y, ISO-XY, L, K) no puedan ejecutarse en el ensayo local y se
    marquen `CLOUD_ONLY`? El informe afirma, con un experimento, que un workerd local reiniciado conserva
    la alarma del Durable Object pero nunca la dispara.
20. ¿Queda alguna forma de que una ejecución parcial (`--quick`) o de otro build autorice PROD?

**F. Bloqueos declarados** (`RUNBOOK_VIGENTE.md §7 y §9`)
21. **B-1:** ¿es correcto que R4 no ofrece ninguna vía para retry/skip/diagnóstico/rollback-readiness en
    PROD? Opinión sobre las opciones O1/O2/O3 propuestas.
22. **B-2:** ¿es correcto que no hay forma de validar Edge → HUB_A sin enviar una señal? ¿Es suficiente lo
    que se pide al contrato del Hub para desbloquearlo?
23. ¿Hay algún otro bloqueo de cutover que no se haya declarado?

**G. Eficiencia** (requisito del propietario)
24. ¿El empaquetado reutiliza legítimamente la evidencia de tests (hash del árbol de entrada) sin poder
    reutilizarla para bytes distintos? ¿La clasificación paralelo/serie de las suites es correcta?

## 5. Cómo reproducir (sin cuenta de Cloudflare, sin tocar HUB_A)

Requisitos: Docker (amd64 o arm64). No hace falta Node en el host para lo siguiente.

```sh
sha256sum KAWA_EDGE_SIGNAL_BUFFER_V1_3_1_NAS_R1_2026-09-26.zip     # comparar con el .sha256
unzip KAWA_EDGE_SIGNAL_BUFFER_V1_3_1_NAS_R1_2026-09-26.zip && cd kawa-edge-nas
cp config/kawa-edge.example.json config/kawa-edge.json
sed -i 's/REPLACE_WITH_YOUR_32_HEX_ACCOUNT_ID/0123456789abcdef0123456789abcdef/' config/kawa-edge.json

./kawa-edge verify-fast     # manifest, toolchain, config, aislamiento, compilación offline, 30 unit (~15 s)
./kawa-edge test-full       # Edge 95 tests en workerd + instalador 46 (unit + E2E contra API simulado) (~70 s)
./kawa-edge rehearse        # gates STAGING en local, con los mismos configs y bundles (~200 s)
./kawa-edge cutover-check --offline    # debe dar BLOCKED (B-1, B-2)
```

- La primera ejecución construye la imagen (necesita salida a Internet para `npm ci`).
- Los tests E2E del instalador levantan un **API de Cloudflare simulado** local
  (`deployer/test/support/mock-cloudflare.mjs`) contra el que se ejecuta el wrangler real. Ningún test
  contacta Cloudflare ni ningún Hub.
- Para reproducir la causa raíz con R4: `npm ci && npx vitest run` dentro de
  `docker run --dns 192.0.2.1 node:22-bookworm-slim` sobre el árbol de R4 (esperado: ~50 fallos por
  timeout), y lo mismo sobre `edge/` de V1.3.1 (esperado: 95/95).
- Resultados del desarrollador para comparar: `TEST_EVIDENCE_V1_3_1.json` y `RELEASE_REPORT_V1_3_1.md §4`.

## 6. Mapa de ficheros para la revisión de código

| Área | Ficheros |
|---|---|
| Harness (único cambio en `edge/`) | `edge/vitest.config.js`, `edge/test/hermetic_egress.test.js`, `edge/test/scenario_consumer_own_entry.test.js` |
| Generación de configs y aislamiento | `deployer/lib/render.mjs`, `naming.mjs`, `config.mjs` |
| Preflight y ejecución | `deployer/lib/preflight.mjs`, `deploy.mjs`, `wrangler.mjs`, `cfapi.mjs` |
| Secretos y redacción | `deployer/lib/secrets.mjs`, `log.mjs` |
| Gates | `deployer/lib/gates/run.mjs`, `targets.mjs` |
| PROD, cutover, bloqueos | `deployer/lib/prod.mjs`, `addhub.mjs` |
| Release, manifest y evidencia | `deployer/lib/release.mjs`, `manifest.mjs`, `zip.mjs` |
| Contenedor | `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `kawa-edge` |
| Tests del instalador | `deployer/test/*.test.mjs`, `deployer/test/support/*` |
| Configs R4 originales (referencia de equivalencia) | `deployer/test/fixtures/*.toml` |

## 7. Límites declarados por el desarrollador

- No se ha desplegado en Cloudflare real. El STAGING PASS real lo produce `./kawa-edge install` en el NAS.
- Solo se ha ejecutado en amd64.
- El historial de Git de la entrega (una auditoría previa del propio desarrollador + una re-auditoría, con
  hallazgos y correcciones) se resume en `RELEASE_REPORT §5`. Esta auditoría externa debe ser
  independiente de ellas.

## 8. Formato de respuesta sugerido

1. Veredicto por bloque A–G: **PASS / FAIL / NO VERIFICABLE**, con la evidencia usada.
2. Hallazgos priorizados:
   - **P0:** podría afectar a HUB_A, filtrar secretos o dar un PASS falso;
   - **P1:** rompería una instalación real o incumple un requisito;
   - **P2:** robustez;
   - **P3:** menores.
   
   Cada uno con fichero:línea y la corrección propuesta.
3. Opinión sobre B-1 y B-2, y si hay algún bloqueo adicional antes del cutover.
4. Recomendación final:
   - ¿apto para instalar STAGING en el NAS?
   - ¿qué falta para PROD?
