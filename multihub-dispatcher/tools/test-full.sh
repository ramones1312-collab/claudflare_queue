#!/bin/sh
# Full offline suite ONCE; writes dist/test-evidence.json bound to the input hash (package reuses it).
set -eu
cd "$(dirname "$0")/.."
mkdir -p dist
T0=$(date +%s%N)
if node --disable-warning=ExperimentalWarning --test --test-concurrency=4 test/*.test.mjs > dist/test-full.log 2>&1; then R=PASS; else R=FAIL; fi
MS=$(( ($(date +%s%N) - T0) / 1000000 ))
PASS=$(grep -c '^ok ' dist/test-full.log || true); FAIL=$(grep -c '^not ok ' dist/test-full.log || true)
H=$(node -e "import('./tools/package.mjs').then(m=>process.stdout.write(m.inputHash()))")
printf '{"result":"%s","input_sha256":"%s","tests_pass":%s,"tests_fail":%s,"duration_ms":%s,"node":"%s"}\n' "$R" "$H" "$PASS" "$FAIL" "$MS" "$(node -v)" > dist/test-evidence.json
echo "$R · $PASS passed, $FAIL failed · ${MS} ms · input ${H}"
[ "$R" = PASS ]
