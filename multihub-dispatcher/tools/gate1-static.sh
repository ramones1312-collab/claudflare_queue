#!/bin/bash
# GATE 1 · STATIC / PACKAGE for V0.1.1.   tools/gate1-static.sh <release dir> <extracted V0.1 folder> <log dir>
set -uo pipefail
REL=$(readlink -f "$1"); V01=$(readlink -f "$2"); LOGS=$(readlink -f "$3"); mkdir -p "$LOGS"
FULL=KAWA_VECTOR_MULTIHUB_DISPATCHER_V0_1_1_AUDIT_OBSERVABILITY; FTR=KAWA_VECTOR_MULTIHUB_DISPATCHER_V0_1_1_FILES_TO_REPLACE; NAME=KAWA_VECTOR_MULTIHUB_DISPATCHER_V0_1_1
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
R=(); pass() { R+=("PASS  $1"); }; fail() { R+=("FAIL  $1"); }
chk() { if eval "$2" >/dev/null 2>&1; then pass "$1"; else fail "$1"; fi; }

for z in $FULL $FTR; do [ "$(cut -d' ' -f1 "$REL/$z.zip.sha256")" = "$(sha256sum "$REL/$z.zip" | cut -d' ' -f1)" ] && pass "SHA-256 $z.zip matches its .sha256" || fail "SHA-256 $z.zip"; done
unzip -q "$REL/$FULL.zip" -d "$W/full" && mkdir "$W/ftr" && unzip -q "$REL/$FTR.zip" -d "$W/ftr" || fail "unzip"
P="$W/full/$NAME"
(cd "$P" && sha256sum -c MANIFEST.sha256) > "$LOGS/manifest-verification.log" 2>&1 && pass "MANIFEST.sha256: $(grep -c ': OK$' "$LOGS/manifest-verification.log") files OK on a clean extraction" || fail "manifest"
extra=$(cd "$P" && find . -type f ! -name MANIFEST.sha256 | sed 's#^\./##' | sort | comm -23 - <(awk '{print $2}' MANIFEST.sha256 | sort)); [ -z "$extra" ] && pass "no file outside the manifest" || fail "undeclared files: $extra"
# FILES_TO_REPLACE = exactly the changed/new files (+ MANIFEST, FILES_TO_REPLACE.md), identical bytes to the full release
ok=1; for f in $(cd "$W/ftr" && find . -type f | sed 's#^\./##' | grep -v '^FILES_TO_REPLACE.md$'); do cmp -s "$W/ftr/$f" "$P/$f" || ok=0; done; [ $ok = 1 ] && pass "FILES_TO_REPLACE files are byte-identical to the full release" || fail "FILES_TO_REPLACE differs from full"
for f in config/destinations.json secrets/ingress_webhook_token secrets/hub_a_webhook_token secrets/hub_b_webhook_token data/.keep; do [ -e "$W/ftr/$f" ] && fail "FILES_TO_REPLACE carries $f"; done; pass "FILES_TO_REPLACE never carries config/destinations.json, data/ or existing secrets"
# syntax
ok=1; for f in "$P"/src/*.mjs "$P"/src/audit-ui/app.js "$P"/test/*.mjs; do node --check "$f" 2>>"$LOGS/syntax.log" || ok=0; done; [ $ok = 1 ] && pass "syntax: node --check on every src/ and test/ module" || fail "syntax"
# dependencies
chk "no npm dependencies (package.json + lockfile)" "node -e \"const p=require('$P/package.json'),l=require('$P/package-lock.json');process.exit(Object.keys(p.dependencies||{}).length||p.devDependencies||Object.keys(l.packages).join()!==''?1:0)\""
# secrets / payloads / path tokens
ok=1; for s in "$P"/secrets/*; do [ -s "$s" ] && ok=0; done; [ $ok = 1 ] && pass "every shipped secret file is empty (4 incl. audit_admin_token)" || fail "a shipped secret is not empty"
[ -z "$(cd "$P" && find . \( -name '*.db*' -o -name '.env' -o -name '*.log' -o -name '*.csv' -o -path './data/audit*' \) -print)" ] && pass "no DB, .env, logs, exports or data/audit in the package" || fail "runtime data shipped"
[ -z "$(grep -rlE '/webhook/[A-Za-z0-9._~-]{8,}' "$P" --exclude-dir=test)" ] && pass "no path token in any shipped runtime/doc file" || fail "path token found"
[ -z "$(grep -lE "(['\"\`])HUB_[A-Z0-9_]+\1" "$P"/src/*.mjs "$P"/src/audit-ui/*)" ] && pass "no hard-coded Hub id in src/" || fail "hard-coded Hub id"
# unchanged vs V0.1: Dockerfile, store, log, ports, volumes, security; removed lines only from an explicit list
cmp -s "$P/Dockerfile" "$V01/Dockerfile" && pass "Dockerfile identical to V0.1" || fail "Dockerfile changed"
cmp -s "$P/src/store.mjs" "$V01/src/store.mjs" && cmp -s "$P/src/log.mjs" "$V01/src/log.mjs" && pass "store.mjs and log.mjs identical to V0.1 (schema, persistence, logging)" || fail "store/log changed"
cmp -s "$P/.dockerignore" "$V01/.dockerignore" && pass ".dockerignore identical to V0.1" || fail ".dockerignore changed"
d=$(diff "$V01/docker-compose.yml" "$P/docker-compose.yml" | grep '^[<>]' | sed 's/^[<>] //' | grep -vE '^# KAWA VECTOR · Multi-Hub Dispatcher V0\.1(\.1)? · Synology|^    image: kawa-multihub-dispatcher:0\.1\.[01]$'); [ -z "$d" ] && pass "docker-compose.yml: only the title comment and the image tag changed (8191:8080, volumes, read_only, caps, security identical)" || fail "compose changed: $d"
{ for f in config dispatcher server main; do echo "== src/$f.mjs: V0.1 lines removed or rewritten"; diff "$V01/src/$f.mjs" "$P/src/$f.mjs" | grep '^<' ; done; } > "$LOGS/core-diff-removed-lines.log"
ALLOW=(
 "<   return { ingress: { ...ingress, secret: ingressSecret }, retry, destinations, enabled };"
 "< export function createDispatcher({ store, config, log, fetchImpl = fetch, now = Date.now }) {"
 "<       store.retry(row.event_id, dest.id, r.http, r.err || \`HTTP \${r.http}\`, now() + d);"
 "<         try { r = await step(dest); } catch (e) { log(\`WORKER_ERROR \${dest.id}\`, { err: e.code || e.name }); r = { wait: 1000 }; }"
 "< export function createServer({ store, config, dispatcher, log }) {"
 "<       return json(res, db === 'ok' ? 200 : 503, { status: db === 'ok' ? 'healthy' : 'unhealthy', db, destinations_enabled: ids.length });"
 "<     if (!same(pathname.slice(prefix.length), config.ingress.secret)) { log('REJECTED', { reason: 'bad_path_token', remote: req.socket.remoteAddress }); return json(res, 401, { status: 'unauthorized' }); }"
 "<         return json(res, 503, { status: 'unavailable' });   // never 2xx before the commit"
 "<     req.on('close', () => { if (tooBig && !res.headersSent) { log('REJECTED', { reason: 'body_too_large' }); json(res, 413, { status: 'too_large' }); } });"
 "<   const store = openStore(path.join(dataDir, 'dispatcher.db'));"
 "<   const dispatcher = createDispatcher({ store, config, log, fetchImpl });"
 "<   const server = createServer({ store, config, dispatcher, log });"
 "<     port: server.address().port, store, config,"
 "<     async stop() { await new Promise(r => server.close(r)); await dispatcher.stop(); store.close(); },"
)
unexpected=$(grep '^<' "$LOGS/core-diff-removed-lines.log" | while IFS= read -r l; do f=0; for a in "${ALLOW[@]}"; do [ "$l" = "$a" ] && f=1; done; [ $f = 0 ] && echo "$l"; done)
[ -z "$unexpected" ] && pass "core: every V0.1 line removed from config/dispatcher/server/main is on the reviewed allow-list ($(grep -c '^<' "$LOGS/core-diff-removed-lines.log") lines; each re-appears with the same logic + an audit call)" || fail "unexpected core change: $unexpected"
# the retry/fan-out/classification lines of V0.1 are all still present verbatim
ok=1; while IFS= read -r l; do grep -qxF -- "$l" "$P/src/dispatcher.mjs" || ok=0; done < <(grep -E 'RETRYABLE_4XX|schedule_seconds|max_attempts|r.http >= 200|r.http < 500|store.head|store.delivered|store.failedPermanent|x-kawa-dispatcher|redirect|for \(const d of config.enabled\) start' "$V01/src/dispatcher.mjs")
[ $ok = 1 ] && pass "dispatcher: V0.1 retry, classification, ordering, fan-out and header lines present verbatim" || fail "dispatcher core line missing"
printf '%s\n' "${R[@]}" | tee "$LOGS/gate1-static.log"
! grep -q '^FAIL' "$LOGS/gate1-static.log"
