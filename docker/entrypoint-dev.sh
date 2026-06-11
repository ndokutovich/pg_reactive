#!/usr/bin/env bash
# pg_reactive db-container entrypoint (dev source-build image and the
# release ghcr.io/ndokutovich/pgstack-postgres image built from Dockerfile.dev).
#
# "background-and-wait" style: PostgreSQL is the lifecycle leader (this image
# ships no proxy — the proxy is a separate container in docker-compose.prod.yml).
# We start PostgreSQL in the background, wait for it to accept connections, then
# replay the durable pg_reactive subscription catalog into shared memory before
# handing control back. Without this, the two-container production stack lost
# every live query on each PostgreSQL restart, because the in-shmem dependency
# hash is wiped on restart while pgr.persisted_subscriptions survives (Codex
# round-36 #4). The all-in-one image already restores via its own entrypoint;
# this brings the two-container stack to parity.
#
# $@ is forwarded verbatim to docker-entrypoint.sh — the compose `command:`
# supplies `postgres -c shared_preload_libraries=pg_reactive ...`.
set -euo pipefail

# Build and install the extension before starting PostgreSQL (source-build
# dev image only; the prebuilt release image has no /ext/ext/Makefile).
if [ -f /ext/ext/Makefile ]; then
    echo "pg_reactive: building extension..."
    make -C /ext/ext clean 2>/dev/null || true
    make -C /ext/ext
    make -C /ext/ext install
    echo "pg_reactive: extension installed"
fi

PG_PID=""
shutdown() {
    echo "==> Shutting down PostgreSQL..."
    [ -n "$PG_PID" ] && kill "$PG_PID" 2>/dev/null || true
    wait 2>/dev/null || true
    exit 0
}
# Register the trap BEFORE starting PostgreSQL so initdb is covered too.
trap shutdown SIGTERM SIGINT

# ── Start PostgreSQL via the stock entrypoint (backgrounded) ────────────────
echo "==> Starting PostgreSQL..."
docker-entrypoint.sh "$@" &
PG_PID=$!

# Connection env for the readiness probe and the restore loop. Probe TCP (not
# the unix socket): the stock entrypoint runs a socket-only temp server while
# it runs initdb + /docker-entrypoint-initdb.d/*, so probing TCP waits for the
# REAL server and never races ahead of a large bootstrap.
export PGHOST=127.0.0.1
export PGPORT=5432
export PGUSER="${POSTGRES_USER:-postgres}"
export PGPASSWORD="${POSTGRES_PASSWORD:-postgres}"
export PGDATABASE="${POSTGRES_DB:-postgres}"

echo "==> Waiting for PostgreSQL (TCP ${PGHOST}:${PGPORT})..."
until pg_isready -q 2>/dev/null; do
    sleep 0.5
done
until psql -c "SELECT 1" &>/dev/null; do
    sleep 0.5
done
echo "==> PostgreSQL ready."

# ── Restore pg_reactive subscriptions from the durable catalog ──────────────
# Iterate every database that has the extension installed and replay
# pgr.persisted_subscriptions into shmem. Catalog-empty DBs return 0 cheaply.
echo "==> Restoring pg_reactive subscriptions..."
DBLIST=$(psql -tAc "SELECT datname FROM pg_database WHERE datallowconn AND datname NOT IN ('template0','template1','postgres');" 2>/dev/null || true)
DBLIST="$DBLIST $PGDATABASE"   # include the default DB
for db in $(echo "$DBLIST" | tr ' ' '\n' | sort -u); do
    [ -z "$db" ] && continue
    has_ext=$(psql -d "$db" -tAc "SELECT 1 FROM pg_extension WHERE extname='pg_reactive';" 2>/dev/null || true)
    [ "$has_ext" = "1" ] || continue
    restored=$(psql -d "$db" -tAc "SELECT pgr.restore_subscriptions();" 2>/dev/null || echo "n/a")
    echo "==>   $db: $restored subscriptions restored"
done

echo "==> pg_reactive ready. PostgreSQL is the lifecycle leader."

# Wait on PostgreSQL; exit with its code so the container reflects PG health.
wait "$PG_PID" 2>/dev/null
EXIT_CODE=$?
echo "==> PostgreSQL exited with code $EXIT_CODE."
exit "$EXIT_CODE"
