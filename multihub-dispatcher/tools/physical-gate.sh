#!/bin/bash
# PHYSICAL GATE on a release ZIP (Synology-equivalent): fresh folder owned by a NAS-like uid, classic builder
# (BuildKit OFF), the SHIPPED docker-compose.yml unchanged (+ a gate-only override that adds two mock Hubs).
#   tools/physical-gate.sh <zip> [<zip>.sha256]
set -uo pipefail
ZIP=$(readlink -f "$1"); SIDE="${2:-$ZIP.sha256}"
TOOLS=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d /tmp/mhd-gate-XXXX); P=mhdgate$$; NAME=KAWA_VECTOR_MULTIHUB_DISPATCHER_V0_1_1
R=(); pass() { R+=("PASS  $1"); echo "PASS  $1"; }; failx() { R+=("FAIL  $1"); echo "FAIL  $1"; summary; exit 1; }
summary() { echo; echo "==== PHYSICAL GATE SUMMARY ($(( $(date +%s) - T0 )) s)"; printf '%s\n' "${R[@]}"; }
T0=$(date +%s)
dc() { (cd "$W/$NAME" && GATE_TOOLS="$TOOLS" docker compose -p $P -f docker-compose.yml -f "$TOOLS/gate-override.yml" "$@"); }
cleanup() { dc down -v --remove-orphans >/dev/null 2>&1; rm -rf "$W"; }
trap cleanup EXIT
ING=gate-ingress-token-0001; SA=gate-hub-a-secret-0001; SB=gate-hub-b-secret-0002
hook() { curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data-binary "$1" "http://127.0.0.1:${PORT}/webhook/$ING"; }
got() { curl -s "http://127.0.0.1:$1/received" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const a=JSON.parse(s);console.log(a.length+' '+a.map(x=>x.body).join('|'))}catch{console.log('0 -')}})"; }
waitfor() { local i; for i in $(seq 1 ${3:-60}); do [ "$(eval "$2")" = "$1" ] && return 0; sleep 1; done; return 1; }

# 1 · integrity + extraction into an EMPTY folder, owned like a File Station extraction (uid 1026:100)
[ "$(cut -d' ' -f1 "$SIDE")" = "$(sha256sum "$ZIP" | cut -d' ' -f1)" ] && pass "ZIP sha256 matches $(basename "$SIDE")" || failx "ZIP sha256"
unzip -q "$ZIP" -d "$W" && chown -R 1026:100 "$W/$NAME" || failx "extract"
(cd "$W/$NAME" && sha256sum -c --quiet MANIFEST.sha256) && pass "MANIFEST.sha256 verifies every shipped file" || failx "manifest"
for s in "$W/$NAME"/secrets/*; do [ -s "$s" ] && failx "shipped secret not empty: $s"; done; pass "shipped secrets/ are empty; no .env, no data/*.db"
[ ! -e "$W/$NAME/.env" ] && [ -z "$(ls "$W/$NAME/data" | grep -v '^$')" ] || failx "unexpected files"

# 2 · the only manual step on the NAS: edit config + fill secrets (here: point at the two mock Hubs)
C="$W/$NAME"
printf '%s\n' "$ING" > "$C/secrets/ingress_webhook_token"; printf '%s\n' "$SA" > "$C/secrets/hub_a_webhook_token"; printf '%s\n' "$SB" > "$C/secrets/hub_b_webhook_token"
cat > "$C/config/destinations.json" <<J
{ "retry": { "schedule_seconds": [1, 2, 3] },
  "destinations": [
    { "id": "HUB_A", "enabled": true, "host": "mock-a", "port": 9001, "webhook_secret_file": "hub_a_webhook_token" },
    { "id": "HUB_B", "enabled": true, "host": "mock-b", "port": 9002, "webhook_secret_file": "hub_b_webhook_token" } ] }
J
chown -R 1026:100 "$C"; PORT=18191; export DISPATCHER_PORT=$PORT

# 3 · compose config + classic build (BuildKit OFF)
(cd "$C" && docker compose -f docker-compose.yml config -q) && pass "docker compose config (shipped file, no .env)" || failx "compose config"
B0=$(date +%s)
(cd "$C" && DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker build --no-cache -t kawa-multihub-dispatcher:0.1.1 . > "$W/build.log" 2>&1) || { tail -20 "$W/build.log"; failx "classic build"; }
grep -q '^Step 1/' "$W/build.log" && grep -q 'Successfully built' "$W/build.log" && pass "classic builder (DOCKER_BUILDKIT=0), no cache: $(( $(date +%s) - B0 )) s" || failx "classic builder markers"
(cd "$C" && DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose -p $P build > "$W/cbuild.log" 2>&1) && pass "docker compose build with BuildKit OFF" || { tail -20 "$W/cbuild.log"; failx "compose build"; }

# 4 · start exactly like Container Manager (compose up -d), data/ owned by uid 1026
dc up -d > "$W/up.log" 2>&1 || { cat "$W/up.log"; failx "compose up"; }
waitfor healthy "docker inspect -f '{{.State.Health.Status}}' kawa-multihub-dispatcher 2>/dev/null" 90 && pass "container healthy (Docker HEALTHCHECK)" || { dc logs dispatcher | tail; failx "healthy"; }
H=$(curl -s "http://127.0.0.1:$PORT/health"); [ "$H" = '{"status":"healthy","db":"ok","destinations_enabled":2}' ] && pass "/health = $H" || failx "/health $H"
DC=$(docker inspect kawa-multihub-dispatcher --format '{{.HostConfig.Privileged}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.CapAdd}} {{.HostConfig.SecurityOpt}}')
[ "$DC" = "false true [ALL] [CAP_DAC_OVERRIDE] [no-new-privileges:true]" ] || [ "$DC" = "false true [ALL] [DAC_OVERRIDE] [no-new-privileges:true]" ] && pass "hardening: privileged=false read_only=true cap_drop=ALL (+DAC_OVERRIDE) no-new-privileges" || failx "hardening: $DC"

# 5 · POST → persisted → both Hubs
[ "$(hook '{"s":1}')" = 200 ] && pass "POST → 200" || failx "POST 1"
[ -s "$C/data/dispatcher.db" ] && pass "SQLite file persisted in ./data (owned by uid $(stat -c %u "$C/data"))" || failx "db file"
waitfor "1 {\"s\":1}" "got 19001" 20 && waitfor "1 {\"s\":1}" "got 19002" 20 && pass "HUB_A mock and HUB_B mock received the raw body" || failx "fan-out"
[ "$(curl -s http://127.0.0.1:19001/received | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].url))")" = "/webhook/$SA" ] && pass "HUB_A called with ITS own secret path" || failx "hub path"

# 6 · one Hub down, the other continues; it comes back and its backlog arrives in order
dc stop mock-b >/dev/null 2>&1
[ "$(hook '{"s":2}')" = 200 ] && [ "$(hook '{"s":3}')" = 200 ] || failx "POST while HUB_B down"
waitfor "3 {\"s\":1}|{\"s\":2}|{\"s\":3}" "got 19001" 20 && pass "HUB_B down: HUB_A keeps receiving (2 more)" || failx "independence"
waitfor yes "dc logs dispatcher 2>/dev/null | grep -q 'RETRY HUB_B' && echo yes" 20 && pass "dispatcher logs RETRY HUB_B" || failx "retry log"
dc start mock-b >/dev/null 2>&1
waitfor "2 {\"s\":2}|{\"s\":3}" "got 19002" 30 && pass "HUB_B back: backlog delivered in order (s2, s3)" || failx "backlog after recovery: $(got 19002)"

# 7 · durability across a container restart (existing volume)
dc stop mock-a >/dev/null 2>&1
[ "$(hook '{"s":4}')" = 200 ] || failx "POST 4"
dc restart dispatcher >/dev/null 2>&1; dc start mock-a >/dev/null 2>&1
waitfor "1 {\"s\":4}" "got 19001" 40 && pass "restart with an existing ./data: pending signal delivered after restart" || failx "restart durability: $(got 19001)"

# 8 · fresh data/ folder (removed): starts and works
dc logs dispatcher > "$W/logs-before-down.txt" 2>&1; dc down >/dev/null 2>&1; rm -rf "$C/data"
dc up -d >/dev/null 2>&1
waitfor healthy "docker inspect -f '{{.State.Health.Status}}' kawa-multihub-dispatcher" 90 && [ "$(hook '{"s":5}')" = 200 ] && waitfor "1 {\"s\":5}" "got 19001" 20 && pass "fresh (missing) data/ folder: created, healthy, delivers" || failx "fresh data dir"

# 9 · no secrets in logs, image or package
LOGS=$(cat "$W/logs-before-down.txt"; dc logs dispatcher 2>&1)
for s in "$ING" "$SA" "$SB" '"s":'; do echo "$LOGS" | grep -qF "$s" && failx "log leaks $s"; done
for k in RECEIVED PERSISTED "DELIVERED HUB_A" "RETRY HUB_B"; do echo "$LOGS" | grep -q "$k" || failx "log lacks $k"; done
pass "logs: RECEIVED/PERSISTED/DELIVERED/RETRY present; no secret, no payload"
IMG=$(docker run --rm --entrypoint sh kawa-multihub-dispatcher:0.1.1 -c 'ls -A /secrets /config /data; ls /app' | tr '\n' ' ')
echo "$IMG" | grep -q 'src' && ! echo "$IMG" | grep -qE 'token|destinations.json|dispatcher.db' && pass "image: no secrets, no config, no DB baked in ($IMG)" || failx "image contents: $IMG"
summary
