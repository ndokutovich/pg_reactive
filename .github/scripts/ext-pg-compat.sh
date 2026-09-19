#!/usr/bin/env bash
# Prove the PGXN support claim: build (-Wall -Werror) + the full pg_regress +
# isolation suite on a bare PGDG container for EVERY claimed PostgreSQL major
# (ext/META.json prereq is 15.0.0). The consolidated install script is the
# default CREATE EXTENSION path in these runs (DATA ships pg_reactive--<V>.sql)
# and 13_extension_upgrade walks the chain, so one pass exercises both install
# paths. Round 48 origin: PG 18 removed TupleDescData.attrs and the tree only
# ever built against 16 — this matrix is what catches the next such removal.
#
# Usage: ext-pg-compat.sh "15 16 17 18"
set -euo pipefail
cd "$(dirname "$0")/../.."

VERSIONS="${1:-15 16 17 18}"
FAIL=0

for V in $VERSIONS; do
  C="ext-compat-$V"
  docker rm -f "$C" >/dev/null 2>&1 || true
  echo "════ PostgreSQL $V ════"
  docker run -d --name "$C" --entrypoint bash "postgres:$V-bookworm" -c 'sleep infinity' >/dev/null
  docker exec "$C" bash -c "apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -yqq --no-install-recommends build-essential postgresql-server-dev-$V >/dev/null"
  docker cp ext "$C":/ext >/dev/null
  # a Windows checkout materializes CRLF; the backend script reader and
  # pg_regress expected-output diffs both need LF
  docker exec "$C" bash -c "find /ext -type f \( -name '*.sql' -o -name '*.out' -o -name '*.c' -o -name '*.h' -o -name '*.spec' -o -name 'Makefile' -o -name '*.control' \) -exec sed -i 's/\r\$//' {} +"
  docker exec "$C" bash -c 'cd /ext && make clean >/dev/null && make >/dev/null && make install >/dev/null && chown -R postgres:postgres /ext'
  docker exec -u postgres "$C" bash -c 'initdb -D /tmp/data >/dev/null && pg_ctl -D /tmp/data -l /tmp/pg.log -o "-c shared_preload_libraries=pg_reactive -c log_min_messages=warning" -w start >/dev/null'

  LOG=$(mktemp)
  if docker exec -u postgres "$C" bash -c 'cd /ext && make installcheck' > "$LOG" 2>&1; then
    grep -E "All .+ tests passed" "$LOG" | sed "s/^/[PG $V] /"
  else
    echo "[PG $V] FAILED:"
    tail -20 "$LOG"
    docker exec "$C" bash -c 'head -80 /ext/regression.diffs 2>/dev/null' || true
    FAIL=1
  fi
  rm -f "$LOG"
  docker rm -f "$C" >/dev/null 2>&1 || true
done

exit $FAIL
