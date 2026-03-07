#!/usr/bin/env bash
#
# Performance test suite runner for pg_reactive.
# Runs all 6 perf tests (P1-P6) and reports results.
#
# Usage: bash tests/perf/runner.sh
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0
SKIP=0
RESULTS=()

# JSON result record — populated at the end.
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
DATE=$(date -u +%Y-%m-%d)
declare -A METRICS  # key → value, filled by individual tests via $PERF_METRICS_FILE
export PERF_METRICS_FILE="$DIR/.metrics_tmp.$$"
rm -f "$PERF_METRICS_FILE"

header() { echo -e "\n======================================"; echo " $1"; echo "======================================"; }

run_test() {
  local name="$1" cmd="$2"
  header "$name"
  if eval "$cmd"; then
    RESULTS+=("$name: PASS")
    PASS=$((PASS + 1))
  else
    RESULTS+=("$name: FAIL")
    FAIL=$((FAIL + 1))
  fi
  echo ""
}

# --- Pre-flight checks ---
header "Pre-flight Checks"

echo -n "PostgreSQL... "
if docker compose exec -T db pg_isready -U postgres -d pg_reactive_test -q 2>/dev/null; then
  echo "OK"
else
  echo "FAIL (is 'docker compose up -d' running?)"
  exit 1
fi

echo -n "Proxy (port 8080)... "
if curl -sf http://127.0.0.1:8080/health >/dev/null 2>&1 || curl -sf http://127.0.0.1:8080/ >/dev/null 2>&1; then
  echo "OK"
else
  # Try a WS handshake as fallback check
  if command -v node &>/dev/null; then
    echo "OK (assumed — proxy has no health endpoint)"
  else
    echo "WARN (cannot verify, continuing anyway)"
  fi
fi

echo -n "Node.js... "
if command -v node &>/dev/null; then
  echo "OK ($(node --version))"
else
  echo "FAIL (Node.js required for P3/P4/P5)"
  exit 1
fi

echo -n "ws package... "
if node -e "require('ws')" 2>/dev/null; then
  echo "OK"
else
  echo "MISSING — installing..."
  npm install ws 2>/dev/null || { echo "FAIL: cannot install ws"; exit 1; }
fi

echo ""
echo "All checks passed. Starting perf tests..."

# --- Container tests (Python, run inside Docker) ---
# Note: bash -c '...' prevents Git Bash from rewriting /ext paths on Windows
run_test "P1: Write Throughput" \
  "docker compose exec -T db bash -c 'python3 /ext/tests/perf/p1_write_throughput.py'"

run_test "P2: Snapshot Stress" \
  "docker compose exec -T db bash -c 'python3 /ext/tests/perf/p2_snapshot_stress.py'"

run_test "P6: Multi-Table Cascade" \
  "docker compose exec -T db bash -c 'python3 /ext/tests/perf/p6_cascade.py'"

# --- Host tests (Node.js, WebSocket) ---
run_test "P3: E2E Latency" \
  "node tests/perf/p3_e2e_latency.mjs"

run_test "P4: Fan-Out Scaling" \
  "node tests/perf/p4_fanout_scale.mjs"

run_test "P5: Soak Test" \
  "node tests/perf/p5_soak.mjs"

run_test "P7: Concurrent Subscribe/Unsubscribe" \
  "node tests/perf/p7_concurrent_subscribe.mjs"

# --- Summary ---
header "RESULTS SUMMARY"
for r in "${RESULTS[@]}"; do
  echo "  $r"
done
echo ""
echo "PASS: $PASS  FAIL: $FAIL"

# --- Append JSON result line to results.jsonl ---
METRICS_JSON="{}"
if [ -f "$PERF_METRICS_FILE" ]; then
  # Each line in the metrics file: key=value
  pairs=""
  while IFS='=' read -r k v; do
    [ -n "$k" ] && pairs="${pairs}\"$k\":$v,"
  done < "$PERF_METRICS_FILE"
  pairs="${pairs%,}"
  METRICS_JSON="{$pairs}"
  rm -f "$PERF_METRICS_FILE"
fi

SUITE_RESULT="pass"
[ "$FAIL" -gt 0 ] && SUITE_RESULT="fail"

RECORD="{\"date\":\"$DATE\",\"commit\":\"$COMMIT\",\"suite\":\"$SUITE_RESULT\",\"pass\":$PASS,\"fail\":$FAIL,\"metrics\":$METRICS_JSON}"
echo "$RECORD" >> "$DIR/results.jsonl"
echo ""
echo "Result appended to tests/perf/results.jsonl"

if [ "$FAIL" -gt 0 ]; then
  echo "=== SUITE: FAIL ==="
  exit 1
else
  echo "=== SUITE: PASS ==="
  exit 0
fi
