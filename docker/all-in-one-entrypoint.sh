#!/usr/bin/env bash
# Canonical all-in-one entrypoint for pgStack deployments.
#
# Runs PostgreSQL + the pgstack proxy in a single container, "background-and-
# wait" style — the proxy is the lifecycle leader; if it exits, PostgreSQL is
# stopped and the container exits with the proxy's code.
#
# Arguments to this script ($@) are forwarded verbatim to `postgres` — set GUC
# flags (e.g. `-c shared_preload_libraries=pg_reactive`) via the compose
# `command:`.
#
# Deployment-specific setup goes in an OPTIONAL post-init hook: if an
# executable /app/post-init.sh exists, it runs after PostgreSQL is ready and
# before the proxy starts, with PGHOST/PGUSER/PGPASSWORD/PGDATABASE exported
# (unix socket, superuser). Use it to apply migrations, run seed/setup SQL,
# register edge functions, etc.
#
# The SIGTERM/SIGINT trap is registered BEFORE PostgreSQL starts, so initdb
# and the post-init hook are covered too.
set -euo pipefail

LOG_DIR=/var/log/pgstack
mkdir -p "$LOG_DIR"

PG_PID=""
PROXY_PID=""

shutdown() {
  echo "==> Shutting down..."
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true
  [ -n "$PG_PID" ]    && kill "$PG_PID"    2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}
trap shutdown SIGTERM SIGINT

# ── Start PostgreSQL via the stock entrypoint ───────────────────────────────
# $@ is forwarded to postgres — pass GUC flags via the compose `command:`.
echo "==> Starting PostgreSQL..."
docker-entrypoint.sh postgres "$@" 2>&1 | tee "$LOG_DIR/postgres.log" &
PG_PID=$!

# Wait for the Unix socket first — TCP is not up during initdb.
echo "==> Waiting for PostgreSQL socket..."
until pg_isready -h /var/run/postgresql -U "${POSTGRES_USER:-postgres}" -q 2>/dev/null; do
  sleep 0.5
done
# Wait for the database itself — docker-entrypoint creates it asynchronously.
until psql -h /var/run/postgresql -U "${POSTGRES_USER:-postgres}" \
           -d "${POSTGRES_DB:-postgres}" -c "SELECT 1" &>/dev/null; do
  sleep 0.5
done
echo "==> PostgreSQL ready."

# ── Deployment-specific post-init hook (optional) ───────────────────────────
export PGHOST=/var/run/postgresql
export PGUSER="${POSTGRES_USER:-postgres}"
export PGPASSWORD="${POSTGRES_PASSWORD:-postgres}"
export PGDATABASE="${POSTGRES_DB:-postgres}"
if [ -x /app/post-init.sh ]; then
  echo "==> Running post-init hook..."
  /app/post-init.sh 2>&1 | tee "$LOG_DIR/post-init.log"
fi

# ── Start the pgstack proxy (lifecycle leader) ──────────────────────────────
echo "==> Starting pgstack proxy..."
export DATABASE_URL="postgres://${PGUSER}:${PGPASSWORD}@127.0.0.1:5432/${PGDATABASE}"
pgstack-proxy 2>&1 | tee "$LOG_DIR/proxy.log" &
PROXY_PID=$!

echo "==> All services running. Logs in $LOG_DIR/"

wait "$PROXY_PID" 2>/dev/null
EXIT_CODE=$?
echo "==> Proxy exited with code $EXIT_CODE — stopping PostgreSQL."
[ -n "$PG_PID" ] && kill "$PG_PID" 2>/dev/null || true
wait 2>/dev/null || true
exit "$EXIT_CODE"
