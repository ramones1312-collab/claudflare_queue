#!/bin/bash
# GATE 2b · physical in-place UPGRADE V0.1 → V0.1.1 and ROLLBACK, with the same ./data (Docker, BuildKit OFF,
# shipped docker-compose.yml + the gate-only override that adds two mock Hubs).
#   tools/upgrade-gate.sh <V0.1 full zip> <V0.1.1 FILES_TO_REPLACE zip>
set -uo pipefail
V01ZIP=$(readlink -f "$1"); FTR=$(readlink -f "$2"); TOOLS=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d /tmp/mhd-up-XXXX); P=mhdup$$; F="$W/KAWA_VECTOR_MULTIHUB_DISPATCHER_V0_1"; PORT=18191; export DISPATCHER_PORT=$PORT
R=(); T0=$(date +%s)
pass() { R+=("PASS  $1"); echo "PASS  $1"; }; failx() { R+=("FAIL  $1"); echo "FAIL  $1"; summary; exit 1; }
summary() { echo; echo "==== UPGRADE / ROLLBACK GATE SUMMARY ($(( $(date +%s) - T0 )) s)"; printf '%s\n' "${R[@]}"; }
dc() { (cd "$F" && GATE_TOOLS="$TOOLS" docker compose -p $P -f docker-compose.yml -f "$TOOLS/gate-override.yml" "$@"); }
trap 'dc down -v --remove-orphans >/dev/null 2>&1; rm -rf "$W"' EXIT
ING=up-ingress-token-0001; SA=up-hub-a-secret-0001; SB=up-hub-b-secret-0002; AT=up-audit-admin-token-000001
hook() { curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data-binary "$1" "http://127.0.0.1:$PORT/webhook/$ING"; }
got() { curl -s "http://127.0.0.1:$1/received" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const a=JSON.parse(s);console.log(a.length+' '+a.map(x=>x.body).join('|'))}catch{console.log('0 -')}})"; }
waitfor() { local i; for i in $(seq 1 ${3:-60}); do [ "$(eval "$2")" = "$1" ] && return 0; sleep 1; done; return 1; }
health() { curl -s "http://127.0.0.1:$PORT/health"; }
fp() { (cd "$F" && sha256sum config/destinations.json secrets/ingress_webhook_token secrets/hub_a_webhook_token secrets/hub_b_webhook_token); }

# 1 · V0.1 as it runs in PROD today: two Hubs, a backlog left for HUB_B
unzip -q "$V01ZIP" -d "$W" && chown -R 1026:100 "$F" || failx "extract V0.1"
printf '%s\n' "$ING" > "$F/secrets/ingress_webhook_token"; printf '%s\n' "$SA" > "$F/secrets/hub_a_webhook_token"; printf '%s\n' "$SB" > "$F/secrets/hub_b_webhook_token"
cat > "$F/config/destinations.json" <<J
{ "retry": { "schedule_seconds": [1, 2, 3] },
  "destinations": [
    { "id": "HUB_A", "enabled": true, "host": "mock-a", "port": 9001, "webhook_secret_file": "hub_a_webhook_token" },
    { "id": "HUB_B", "enabled": true, "host": "mock-b", "port": 9002, "webhook_secret_file": "hub_b_webhook_token" } ] }
J
(cd "$F" && DOCKER_BUILDKIT=0 docker build -q -t kawa-multihub-dispatcher:0.1.0 . >/dev/null) && dc up -d >/dev/null 2>&1 || failx "V0.1 build/up"
waitfor '{"status":"healthy","db":"ok","destinations_enabled":2}' health 60 && pass "V0.1 running: /health $(health)" || failx "V0.1 health"
[ "$(hook '{"s":1}')" = 200 ] && waitfor "1 {\"s\":1}" "got 19002" 20 || failx "V0.1 fan-out"
dc stop mock-b >/dev/null 2>&1
[ "$(hook '{"s":2}')" = 200 ] && [ "$(hook '{"s":3}')" = 200 ] && waitfor "3 {\"s\":1}|{\"s\":2}|{\"s\":3}" "got 19001" 20 || failx "V0.1 backlog setup"
waitfor yes "dc logs dispatcher 2>/dev/null | grep -q 'RETRY HUB_B' && echo yes" 20 && pass "V0.1 left a HUB_B backlog (s2, s3) in ./data" || failx "backlog"

# 2 · UPGRADE exactly as documented: backup, stop the project, overwrite FILES_TO_REPLACE, add the audit token
cp -a "$F" "$W/backup_V0_1" && pass "1. backup of the project folder" || failx "backup"
dc down >/dev/null 2>&1 && pass "2. project stopped (docker compose down; ./data is a bind mount, untouched)"
BEFORE=$(fp); DBSZ=$(stat -c %s "$F/data/dispatcher.db")
(cd "$F" && unzip -oq "$FTR") && pass "3. FILES_TO_REPLACE extracted over the folder ($(unzip -Z1 "$FTR" | grep -vc '/$') files)" || failx "overwrite"
[ "$(fp)" = "$BEFORE" ] && pass "5. config/destinations.json and the existing secrets are byte-identical after the overwrite" || failx "operator files changed"
[ -s "$F/data/dispatcher.db" ] && [ "$(stat -c %s "$F/data/dispatcher.db")" = "$DBSZ" ] && pass "6. data/dispatcher.db untouched by the upgrade" || failx "db touched"
printf '%s\n' "$AT" > "$F/secrets/audit_admin_token" && pass "4. secrets/audit_admin_token written (the only new secret)"
(cd "$F" && DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose -p $P build >/dev/null 2>&1) && pass "7. build V0.1.1 with BuildKit OFF (docker compose build)" || failx "build V0.1.1"
dc up -d >/dev/null 2>&1 || failx "up V0.1.1"
waitfor '{"status":"healthy","db":"ok","destinations_enabled":2,"audit":"ok","audit_url":"/audit"}' health 60 && pass "8-9. V0.1.1 started: /health $(health)" || failx "V0.1.1 health: $(health)"
dc start mock-b >/dev/null 2>&1
waitfor "2 {\"s\":2}|{\"s\":3}" "got 19002" 30 && pass "the V0.1 backlog (s2, s3) is delivered by V0.1.1, in order" || failx "backlog after upgrade: $(got 19002)"
C401=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/audit"); C200=$(curl -s -o /dev/null -w '%{http_code}' -u "audit:$AT" "http://127.0.0.1:$PORT/audit")
CCF=$(curl -s -o /dev/null -w '%{http_code}' -u "audit:$AT" -H 'cf-ray: 8a1b2c-FRA' "http://127.0.0.1:$PORT/audit")
[ "$C401" = 401 ] && [ "$C200" = 200 ] && [ "$CCF" = 403 ] && pass "10. /audit: no auth 401 · Basic Auth 200 (LAN) · with Cloudflare header 403" || failx "audit auth $C401/$C200/$CCF"
[ "$(hook '{"s":4,"ticker":"BTCUSDT","order_id":"UP-4"}')" = 200 ] && pass "11. fake signal accepted" || failx "fake signal"
# (mock Hubs keep what they received in memory; "down" in step 2 restarted them)
waitfor "1 {\"s\":4,\"ticker\":\"BTCUSDT\",\"order_id\":\"UP-4\"}" "got 19001" 20 && waitfor "3 {\"s\":2}|{\"s\":3}|{\"s\":4,\"ticker\":\"BTCUSDT\",\"order_id\":\"UP-4\"}" "got 19002" 20 && pass "12. fan-out A+B confirmed" || failx "fan-out after upgrade"
sleep 1
curl -s -u "audit:$AT" "http://127.0.0.1:$PORT/audit/export.json?event_id=4" > "$W/e.json"; curl -s -u "audit:$AT" "http://127.0.0.1:$PORT/audit/export.csv" > "$W/e.csv"
node -e "const j=require('$W/e.json');const d=j.events.filter(e=>e.event_type==='DELIVERED').map(e=>e.destination_id).sort().join();process.exit(j.schema_version===1&&d==='HUB_A,HUB_B'&&j.events.some(e=>e.symbol==='BTCUSDT')?0:1)" \
  && [ "$(head -1 "$W/e.csv" | tr -d '\r\357\273\277' | cut -d, -f1-5)" = "audit_id,ts_ms,request_id,event_id,event_type" ] && pass "13. CSV/JSON downloaded: event 4 → DELIVERED on HUB_A and HUB_B" || failx "exports"
[ "$(ls "$F/data/audit/exports" | wc -l)" -ge 2 ] && [ -s "$F/data/audit/dispatcher_status.json" ] && pass "exports kept in data/audit/exports; data/audit/dispatcher_status.json present" || failx "audit files"
ALL="$(dc logs dispatcher 2>&1; cat "$W/e.json" "$W/e.csv" "$F/data/audit/dispatcher_status.json" "$F"/data/audit/exports/*)"
for s in "$ING" "$SA" "$SB" "$AT"; do echo "$ALL" | grep -qF "$s" && failx "secret leaked"; done; pass "no secret in logs, exports or the status file"

# 3 · ROLLBACK exactly as documented: stop, restore only the replaced V0.1 files, build, start (audit_events stays)
dc down >/dev/null 2>&1
for f in $(unzip -Z1 "$FTR" | grep -v '/$'); do [ -e "$W/backup_V0_1/$f" ] && cp -p "$W/backup_V0_1/$f" "$F/$f"; done
RESTORED=$(for f in $(unzip -Z1 "$FTR" | grep -v '/$'); do [ -e "$W/backup_V0_1/$f" ] && echo "$f"; done)
[ "$(cd "$F" && sha256sum $RESTORED | sha256sum)" = "$(cd "$W/backup_V0_1" && sha256sum $RESTORED | sha256sum)" ] && pass "rollback: the $(echo $RESTORED | wc -w) replaced files restored from the V0.1 backup (added files left in place)" || failx "restore"
(cd "$F" && DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose -p $P build >/dev/null 2>&1) && dc up -d >/dev/null 2>&1 || failx "rollback build/up"
waitfor '{"status":"healthy","db":"ok","destinations_enabled":2}' health 60 && pass "V0.1 back: /health $(health) (image $(docker inspect -f '{{.Config.Image}}' kawa-multihub-dispatcher))" || failx "V0.1 health after rollback"
[ "$(hook '{"s":5}')" = 200 ] && waitfor '1 {"s":5}' "got 19001" 20 && waitfor '1 {"s":5}' "got 19002" 20 && pass "V0.1 after rollback delivers to A+B, ignoring the audit_events table" || failx "V0.1 delivery after rollback"
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('$F/data/dispatcher.db',{readOnly:true});const ok=d.prepare('PRAGMA integrity_check').get().integrity_check;const n=d.prepare('SELECT COUNT(*) n FROM audit_events').get().n;const e=d.prepare('SELECT MAX(event_id) m FROM events').get().m;console.log(ok,n,e);process.exit(ok==='ok'&&n>0&&e===5?0:1)" 2>/dev/null \
  && pass "dispatcher.db integrity ok; audit_events kept (ignored by V0.1); event_id continued 1..5 across upgrade and rollback" || failx "db after rollback"
summary
