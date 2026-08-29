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
# before the proxy starts, with PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE
# exported (loopback TCP, superuser). Use it to apply migrations, run
# seed/setup SQL, register edge functions, etc. It is SYNCHRONOUS and piped
# through tee — never background a daemon from it (the pipe would keep the
# entrypoint waiting forever); that is what services.d is for.
#
# Long-running sidecar processes (a game netcode server, a queue worker, a
# cron-ish loop) go in OPTIONAL /app/services.d/*.sh: every EXECUTABLE script
# there is started in the background once the proxy answers /health, with
# the same environment the proxy got (DATABASE_URL = the powerless
# `authenticator` role; note the PG* superuser vars are inherited too — a
# sidecar that should not hold them must drop or override them itself).
# Each script must `exec` its process in the foreground: the entrypoint owns
# the PID, forwards SIGTERM on shutdown (sidecars → proxy → PostgreSQL) and
# writes its output to $LOG_DIR/<script-name>.log. A sidecar exiting does
# NOT stop the container — the proxy stays the lifecycle leader and the
# static app keeps serving.
#
# The SIGTERM/SIGINT trap is registered BEFORE PostgreSQL starts, so initdb
# and the post-init hook are covered too.
set -euo pipefail

LOG_DIR=/var/log/pgstack
mkdir -p "$LOG_DIR"

PG_PID=""
PROXY_PID=""
SIDECAR_PIDS=()

# wait_bounded PID SECONDS NAME — wait for a child to exit, SIGKILL it if it
# hasn't within the budget. Polls /proc state instead of a bare `wait` so
# the budget is enforceable (bash `wait` has no timeout); a zombie ('Z') is
# an exited child that only needs reaping. The budgets below are sized so
# the whole handler fits in a 30s `stop_grace_period` (compose) — set that
# on all-in-one deployments; Docker's default is 10s.
wait_bounded() {
  local pid=$1 secs=$2 name=$3 i st
  for ((i = 0; i < secs * 10; i++)); do
    st=$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null || echo X)
    case "$st" in
      X|Z) wait "$pid" 2>/dev/null || true; return 0 ;;
    esac
    sleep 0.1
  done
  echo "==> $name did not exit within ${secs}s — SIGKILL" >&2
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

shutdown() {
  echo "==> Shutting down..."
  # Order: sidecars (may hold proxy/DB connections) → proxy → PostgreSQL,
  # each waited for (bounded) before the next is signalled, so PostgreSQL
  # sees its clients gone and does a clean fast shutdown. The proxy gets
  # its own drain budget (SHUTDOWN_TIMEOUT, default 15s) plus a little;
  # PostgreSQL gets 12s — a fast shutdown normally takes well under 1s.
  # ${arr[@]+...} keeps `set -u` happy on an empty array.
  for p in ${SIDECAR_PIDS[@]+"${SIDECAR_PIDS[@]}"}; do
    kill "$p" 2>/dev/null || true
  done
  for p in ${SIDECAR_PIDS[@]+"${SIDECAR_PIDS[@]}"}; do
    wait_bounded "$p" 5 "sidecar $p"
  done
  if [ -n "$PROXY_PID" ]; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait_bounded "$PROXY_PID" "$(( ${SHUTDOWN_TIMEOUT:-15} + 2 ))" "pgstack proxy"
  fi
  if [ -n "$PG_PID" ]; then
    kill "$PG_PID" 2>/dev/null || true
    wait_bounded "$PG_PID" 12 "PostgreSQL"
  fi
  wait 2>/dev/null || true
  echo "==> Shutdown complete."
  exit 0
}
trap shutdown SIGTERM SIGINT

# ── Start PostgreSQL via the stock entrypoint ───────────────────────────────
# $@ is forwarded to postgres — pass GUC flags via the compose `command:`.
#
# Logging via process substitution, NOT `cmd 2>&1 | tee … &`: in a
# background pipeline $! is the PID of the LAST stage (tee), so the old
# `kill "$PG_PID"` signalled tee while postgres itself never saw SIGTERM.
# The container then sat in `wait` until Docker's stop grace period ran
# out and SIGKILLed everything — exit 137 on every `docker stop`, and
# crash-recovery (WAL replay) on the next start. With `> >(tee …)` $! is
# the real process; the stock entrypoint exec's postgres, so the PID stays
# valid for the whole lifetime.
echo "==> Starting PostgreSQL..."
docker-entrypoint.sh postgres "$@" > >(tee "$LOG_DIR/postgres.log") 2>&1 &
PG_PID=$!

# Export connection env UP FRONT — both the readiness probe below and the
# post-init hook need it to authenticate. With --auth-local/host=scram-sha-256
# psql requires a password; exporting PGPASSWORD only after the probe would
# deadlock the probe loop forever (the bug this replaces).
export PGHOST=127.0.0.1
export PGPORT=5432
export PGUSER="${POSTGRES_USER:-postgres}"
export PGPASSWORD="${POSTGRES_PASSWORD:-postgres}"
export PGDATABASE="${POSTGRES_DB:-postgres}"

# Probe TCP, NOT the unix socket. The stock entrypoint runs a TEMP server on
# the socket only (listen_addresses='') while it runs initdb +
# /docker-entrypoint-initdb.d/*. The REAL server has listen_addresses='*', so
# probing TCP waits for the real server and never races ahead of initdb —
# which matters when docker/init.sql is large.
echo "==> Waiting for PostgreSQL (TCP ${PGHOST}:${PGPORT})..."
until pg_isready -q 2>/dev/null; do
  sleep 0.5
done
until psql -c "SELECT 1" &>/dev/null; do
  sleep 0.5
done
echo "==> PostgreSQL ready."

# ── Restore pg_reactive subscriptions from durable catalog ──────────────────
# pg_reactive 0.1.4+ persists every pgr.subscribe call into pgr.persisted_subscriptions
# (a LOGGED table that survives restart). The in-shmem dependency hash is wiped
# on every postmaster restart, so without this step every restart would lose
# all live queries until clients manually re-subscribe.
#
# We iterate every database that has the pg_reactive extension installed and
# call pgr.restore_subscriptions(). Catalog-empty DBs return 0 and cost
# essentially nothing. Catalog-non-empty DBs get their shmem hash rebuilt
# before the proxy starts serving WS upgrades — so the first delta after
# restart is delivered correctly.
echo "==> Upgrading pg_reactive and restoring subscriptions..."
DBLIST=$(psql -tAc "SELECT datname FROM pg_database WHERE datallowconn AND datname NOT IN ('template0','template1','postgres');" 2>/dev/null || true)
# always include the default DB in case the catalog query above filtered it
DBLIST="$DBLIST $PGDATABASE"
restore_failures=0
for db in $(echo "$DBLIST" | tr ' ' '\n' | sort -u); do
  [ -z "$db" ] && continue
  has_ext=$(psql -d "$db" -tAc "SELECT 1 FROM pg_extension WHERE extname='pg_reactive';" 2>/dev/null || true)
  [ "$has_ext" = "1" ] || continue
  # Pull a persistent database up to the image's installed extension version
  # BEFORE restoring. The data volume survives image upgrades, so an extension
  # installed by an older image (e.g. 0.1.4 without pgr.subscription_meta) would
  # otherwise keep its old object set and the proxy would 503 every WS/presence
  # request (round 37 F1). ALTER EXTENSION ... UPDATE is a no-op when current.
  if ! upd=$(psql -d "$db" -v ON_ERROR_STOP=1 -tAc "ALTER EXTENSION pg_reactive UPDATE;" 2>&1); then
    echo "==>   $db: EXTENSION UPGRADE FAILED — $upd" >&2
    restore_failures=$((restore_failures + 1))
  fi
  # Surface restore failures (round 37 F2) — never swallow them as "n/a". A
  # container that came up without its live queries restored must be
  # diagnosable, not silently healthy.
  if restored=$(psql -d "$db" -v ON_ERROR_STOP=1 -tAc "SELECT pgr.restore_subscriptions();" 2>&1); then
    echo "==>   $db: $restored subscriptions restored"
  else
    echo "==>   $db: RESTORE FAILED — $restored" >&2
    restore_failures=$((restore_failures + 1))
  fi
done
if [ "$restore_failures" -gt 0 ]; then
  echo "==> WARNING: $restore_failures database(s) failed extension upgrade or subscription restore — live queries may be missing until re-subscribed." >&2
fi

# ── Deployment-specific post-init hook (optional) ───────────────────────────
if [ -x /app/post-init.sh ]; then
  echo "==> Running post-init hook..."
  /app/post-init.sh 2>&1 | tee "$LOG_DIR/post-init.log"
fi

# ── Point the proxy at the powerless `authenticator` role, NOT the superuser ─
# gemini audit P2: connecting the proxy as the bootstrap superuser means a
# compromised proxy could bypass RLS by default, COPY ... FROM PROGRAM (OS exec),
# DROP DATABASE, or read pg_authid. `authenticator` is NOSUPERUSER NOINHERIT and
# SET ROLEs per request, so it holds no privileges by default. We give it a login
# password here — generated when the operator didn't pin AUTHENTICATOR_PASSWORD,
# which is safe because PostgreSQL is loopback-only inside this container.
# Fall back to the superuser DSN ONLY when the role is absent (standalone
# pg_reactive without the pgStack CORE) — there is no RLS model to guard there.
if [ "$(psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='authenticator'" 2>/dev/null || true)" = "1" ]; then
  AUTHPW="${AUTHENTICATOR_PASSWORD:-}"
  if [ -z "$AUTHPW" ]; then
    AUTHPW="$(openssl rand -hex 24 2>/dev/null || tr -dc 'a-f0-9' < /dev/urandom | head -c 48)"
  fi
  # psql :'apw' substitution safely quotes the value — but interpolation only
  # happens when reading SQL from stdin/-f, NOT with -c, so feed it via heredoc.
  psql -v ON_ERROR_STOP=1 -v apw="$AUTHPW" > /dev/null <<'EOSQL'
ALTER ROLE authenticator LOGIN PASSWORD :'apw';
EOSQL
  export DATABASE_URL="postgres://authenticator:${AUTHPW}@127.0.0.1:5432/${PGDATABASE}"
  echo "==> proxy DSN role = authenticator (data plane; NOSUPERUSER, SET ROLE per request)"

  # Admin plane (finding 6): the data role authenticator is NOT a member of
  # service_role, so the admin pool uses a SEPARATE login role authenticator_admin
  # (member of service_role) via ADMIN_DATABASE_URL. Present on a fresh CORE
  # volume; absent on an old volume (then ADMIN_DATABASE_URL stays unset and the
  # admin pool falls back to DATABASE_URL, where the legacy authenticator was a
  # service_role member).
  if [ "$(psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='authenticator_admin'" 2>/dev/null || true)" = "1" ]; then
    ADMINPW="${AUTHENTICATOR_ADMIN_PASSWORD:-}"
    if [ -z "$ADMINPW" ]; then
      ADMINPW="$(openssl rand -hex 24 2>/dev/null || tr -dc 'a-f0-9' < /dev/urandom | head -c 48)"
    fi
    psql -v ON_ERROR_STOP=1 -v apw="$ADMINPW" > /dev/null <<'EOSQL'
ALTER ROLE authenticator_admin LOGIN PASSWORD :'apw';
EOSQL
    export ADMIN_DATABASE_URL="postgres://authenticator_admin:${ADMINPW}@127.0.0.1:5432/${PGDATABASE}"
    echo "==> proxy admin DSN role = authenticator_admin (admin plane; member of service_role)"
  fi
else
  # Sanctioned superuser fallback: no `authenticator` role means standalone
  # pg_reactive without the pgStack CORE, so there is no RLS model to guard and
  # the proxy needs a working connection.
  export DATABASE_URL="postgres://${PGUSER}:${PGPASSWORD}@127.0.0.1:5432/${PGDATABASE}"  # lint:allow=SEC-R42
  echo "==> WARNING: 'authenticator' role absent — proxy connects as ${PGUSER} (no RLS isolation; standalone pg_reactive)"
fi

# ── Start the pgstack proxy (lifecycle leader) ──────────────────────────────
echo "==> Starting pgstack proxy..."
# Process substitution for the same reason as PostgreSQL above: $! must be
# the proxy itself so SIGTERM reaches it and `wait "$PROXY_PID"` tracks it.
pgstack-proxy > >(tee "$LOG_DIR/proxy.log") 2>&1 &
PROXY_PID=$!

# ── Sidecar services (optional) ─────────────────────────────────────────────
# See the header: executable /app/services.d/*.sh, started after the proxy is
# healthy, each logging to its own file, SIGTERM-forwarded on shutdown. Not
# piped through tee on purpose — $! must be the real process so the signal
# reaches it, and the log file is the durable record anyway.
if compgen -G "/app/services.d/*.sh" > /dev/null; then
  PROXY_PORT="${LISTEN_ADDR:-0.0.0.0:8080}"
  PROXY_PORT="${PROXY_PORT##*:}"
  if command -v curl >/dev/null 2>&1; then
    echo "==> Waiting for proxy /health on :${PROXY_PORT} before starting sidecars..."
    for _ in $(seq 1 60); do
      curl -fsS "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null 2>&1 && break
      sleep 0.5
    done
  fi
  for svc in /app/services.d/*.sh; do
    if [ ! -x "$svc" ]; then
      echo "==> services.d: skipping non-executable $svc" >&2
      continue
    fi
    name=$(basename "$svc" .sh)
    "$svc" > "$LOG_DIR/$name.log" 2>&1 &
    SIDECAR_PIDS+=("$!")
    echo "==> sidecar '$name' started (pid $!) — log: $LOG_DIR/$name.log"
  done
fi

echo "==> All services running. Logs in $LOG_DIR/"

wait "$PROXY_PID" 2>/dev/null
EXIT_CODE=$?
echo "==> Proxy exited with code $EXIT_CODE — stopping PostgreSQL."
[ -n "$PG_PID" ] && kill "$PG_PID" 2>/dev/null || true
wait 2>/dev/null || true
exit "$EXIT_CODE"
