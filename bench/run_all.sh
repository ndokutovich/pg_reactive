#!/bin/bash
# bench/run_all.sh — Run all benchmark scenarios
# Usage:
#   bash bench/run_all.sh              # Tier 1 only
#   bash bench/run_all.sh --tier 2     # Full suite including Tier 2
#   bash bench/run_all.sh --approach pgr --scenario s2  # Single run
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE="docker compose -f $SCRIPT_DIR/docker-compose.bench.yml"
DURATION="${BENCH_DURATION:-10}"
TIER="1"
SINGLE_APPROACH=""
SINGLE_SCENARIO=""

# Wrapper: run command inside bench-db container via bash -c to prevent
# Git Bash from rewriting /bench paths on Windows.
db_exec() {
    $COMPOSE exec -T bench-db bash -c "$*"
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --tier) TIER="$2"; shift 2 ;;
        --approach) SINGLE_APPROACH="$2"; shift 2 ;;
        --scenario) SINGLE_SCENARIO="$2"; shift 2 ;;
        --duration) DURATION="$2"; shift 2 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

echo "======================================="
echo "  pg_reactive Benchmark Suite"
echo "  Tier: $TIER | Duration: ${DURATION}s"
echo "======================================="
echo ""

# --- Build and start DB ---
echo "Building benchmark container..."
$COMPOSE build bench-db
$COMPOSE up -d bench-db
echo "Waiting for PostgreSQL..."
sleep 12

# Install extensions
db_exec 'psql -U postgres -d bench_db -q -c "CREATE EXTENSION IF NOT EXISTS pg_reactive"' 2>/dev/null || true
db_exec 'psql -U postgres -d bench_db -q -c "CREATE EXTENSION IF NOT EXISTS pg_ivm"' 2>/dev/null || true

# Create schema
db_exec 'psql -U postgres -d bench_db -q -f /bench/schema.sql'

# Create results directory
mkdir -p "$SCRIPT_DIR/results/raw"

# --- Helper function ---
run_scenario() {
    local scenario=$1
    local approaches=${2:-"pgr,ivm,poll,notify"}
    local extra_params=${3:-""}

    echo ""
    echo "--- Scenario: $scenario ---"
    db_exec "python3 /bench/harness.py \
        --scenario $scenario \
        --approaches $approaches \
        --duration $DURATION \
        $extra_params \
        --output /bench/results/raw/${scenario}.json"
}

# --- Single run mode ---
if [[ -n "$SINGLE_SCENARIO" ]]; then
    APPROACHES="${SINGLE_APPROACH:-pgr,ivm,poll,notify}"
    db_exec 'psql -U postgres -d bench_db -q -v scale=100 -f /bench/seed.sql'
    run_scenario "$SINGLE_SCENARIO" "$APPROACHES"
    echo ""
    echo "=== Done ==="
    $COMPOSE down
    exit 0
fi

# ===== TIER 1: In-Database Approaches =====
echo ""
echo "===== TIER 1: pg_reactive vs pg_ivm vs Polling vs LISTEN/NOTIFY ====="

# S1: Write Overhead
db_exec 'psql -U postgres -d bench_db -q -v scale=100 -f /bench/seed.sql'
run_scenario "s1_write_overhead" "pgr,ivm,poll,notify"

# S2: Delta Latency
db_exec 'psql -U postgres -d bench_db -q -v scale=100 -f /bench/seed.sql'
run_scenario "s2_delta_latency" "pgr,ivm,poll,notify"

# S3: Query Complexity
db_exec 'psql -U postgres -d bench_db -q -v scale=100 -f /bench/seed.sql'
run_scenario "s3_query_complexity" "pgr,ivm,poll,notify"

# S4: Result Set Scaling
for scale in 100 1000 10000; do
    db_exec "psql -U postgres -d bench_db -q -v scale=$scale -f /bench/seed.sql"
    run_scenario "s4_result_set_scale" "pgr,ivm,poll" "--param scale=$scale"
    # Move result to scale-specific file
    mv "$SCRIPT_DIR/results/raw/s4_result_set_scale.json" \
       "$SCRIPT_DIR/results/raw/s4_scale_${scale}.json" 2>/dev/null || true
done

# S5: Subscription Count Scaling
db_exec 'psql -U postgres -d bench_db -q -v scale=1000 -f /bench/seed.sql'
run_scenario "s5_subscription_scale" "pgr,ivm"

# ===== TIER 2: External Services =====
if [[ "$TIER" == "2" ]]; then
    echo ""
    echo "===== TIER 2: Hasura, Debezium, Supabase, ElectricSQL ====="

    # Start Tier 2 services
    echo "Starting Hasura..."
    $COMPOSE --profile hasura up -d hasura
    sleep 10

    echo "Starting Debezium stack..."
    $COMPOSE --profile debezium up -d debezium
    sleep 15

    echo "Starting Supabase Realtime..."
    $COMPOSE --profile supabase up -d supabase-realtime
    sleep 10

    echo "Starting ElectricSQL..."
    $COMPOSE --profile electric up -d electric
    sleep 10

    # S2 with Tier 2 approaches
    db_exec 'psql -U postgres -d bench_db -q -v scale=100 -f /bench/seed.sql'
    run_scenario "s2_delta_latency" "hasura,debezium,supabase,electric"
    mv "$SCRIPT_DIR/results/raw/s2_delta_latency.json" \
       "$SCRIPT_DIR/results/raw/s2_tier2.json" 2>/dev/null || true

    # S3 with Tier 2 approaches
    run_scenario "s3_query_complexity" "hasura,debezium,supabase,electric"
    mv "$SCRIPT_DIR/results/raw/s3_query_complexity.json" \
       "$SCRIPT_DIR/results/raw/s3_tier2.json" 2>/dev/null || true

    # S6: Fan-out (requires proxy)
    echo ""
    echo "--- Scenario: S6 Fan-out ---"
    $COMPOSE --profile proxy up -d bench-proxy
    sleep 5
    db_exec 'psql -U postgres -d bench_db -q -v scale=100 -f /bench/seed.sql'
    # S6 runs from host as Node.js
    if command -v node &> /dev/null; then
        node "$SCRIPT_DIR/scenarios/s6_fanout.mjs" 2>&1 || echo "S6 fan-out failed (non-fatal)"
    else
        echo "Node.js not found, skipping S6 fan-out"
    fi
fi

# --- Generate Report ---
echo ""
echo "=== Generating Report ==="
db_exec 'python3 /bench/report.py \
    --input /bench/results/raw \
    --output /bench/results/report.md' 2>/dev/null || \
    python3 "$SCRIPT_DIR/report.py" \
        --input "$SCRIPT_DIR/results/raw" \
        --output "$SCRIPT_DIR/results/report.md"

echo ""
echo "======================================="
echo "  Benchmark Complete!"
echo "  Report: bench/results/report.md"
echo "======================================="

# Cleanup
$COMPOSE --profile proxy --profile hasura --profile debezium --profile supabase --profile electric down
