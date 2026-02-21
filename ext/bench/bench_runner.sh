#!/bin/bash
# pg_reactive benchmark: measure DML latency overhead
# Usage: docker compose exec db bash /ext/ext/bench/bench_runner.sh

set -e

PGUSER="postgres"
PGDB="pg_reactive_test"
DURATION=10  # seconds per benchmark
CLIENTS=4

psql -U "$PGUSER" -d "$PGDB" -q -c "CREATE EXTENSION IF NOT EXISTS pg_reactive" 2>/dev/null || true

echo "=== pg_reactive Benchmark ==="
echo "Duration: ${DURATION}s per test, Clients: ${CLIENTS}"
echo ""

# --- Setup ---
psql -U "$PGUSER" -d "$PGDB" -q <<'SQL'
DROP TABLE IF EXISTS bench_data CASCADE;
CREATE TABLE bench_data (id serial PRIMARY KEY, val int, label text);
INSERT INTO bench_data (val, label)
  SELECT i, 'row_' || i FROM generate_series(1, 100) i;
SQL

# Create pgbench scripts
cat > /tmp/bench_insert.sql <<'SQL'
INSERT INTO bench_data (val, label) VALUES (random() * 1000, 'bench');
SQL

cat > /tmp/bench_update.sql <<'SQL'
UPDATE bench_data SET val = random() * 1000 WHERE id = (SELECT id FROM bench_data ORDER BY random() LIMIT 1);
SQL

cat > /tmp/bench_delete_insert.sql <<'SQL'
DELETE FROM bench_data WHERE id = (SELECT id FROM bench_data WHERE label = 'bench' ORDER BY random() LIMIT 1);
INSERT INTO bench_data (val, label) VALUES (random() * 1000, 'bench');
SQL

# --- Baseline (no subscriptions) ---
echo "--- Baseline: 0 subscriptions ---"
pgbench -U "$PGUSER" -d "$PGDB" -T "$DURATION" -c "$CLIENTS" -j 2 \
  -f /tmp/bench_insert.sql --no-vacuum -P 5 2>&1 | grep -E "^(number|latency|tps)"

echo ""

# --- 1 subscription ---
echo "--- With 1 subscription ---"
psql -U "$PGUSER" -d "$PGDB" -q -c \
  "SELECT pgr.subscribe('bench_q1', 'SELECT id, val, label FROM bench_data')"

pgbench -U "$PGUSER" -d "$PGDB" -T "$DURATION" -c "$CLIENTS" -j 2 \
  -f /tmp/bench_insert.sql --no-vacuum -P 5 2>&1 | grep -E "^(number|latency|tps)"

psql -U "$PGUSER" -d "$PGDB" -q -c "SELECT pgr.unsubscribe('bench_q1')"
echo ""

# --- 10 subscriptions ---
echo "--- With 10 subscriptions ---"
for i in $(seq 1 10); do
  psql -U "$PGUSER" -d "$PGDB" -q -c \
    "SELECT pgr.subscribe('bench_q$i', 'SELECT id, val, label FROM bench_data')"
done

pgbench -U "$PGUSER" -d "$PGDB" -T "$DURATION" -c "$CLIENTS" -j 2 \
  -f /tmp/bench_insert.sql --no-vacuum -P 5 2>&1 | grep -E "^(number|latency|tps)"

for i in $(seq 1 10); do
  psql -U "$PGUSER" -d "$PGDB" -q -c "SELECT pgr.unsubscribe('bench_q$i')"
done
echo ""

# --- Cleanup ---
psql -U "$PGUSER" -d "$PGDB" -q -c "DROP TABLE bench_data CASCADE"

echo "=== Benchmark Complete ==="
