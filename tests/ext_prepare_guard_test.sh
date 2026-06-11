#!/bin/bash
# Automated test for round 37 F2: PREPARE TRANSACTION must be rejected when the
# transaction touched the pg_reactive subscription registry — the per-backend
# before-image journal cannot participate in two-phase commit, so a later
# ROLLBACK PREPARED would leave shmem diverged from the catalog. A
# subscription-free transaction must still prepare normally.
#
# CI's main PostgreSQL runs max_prepared_transactions=0 (PREPARE globally
# disabled), so this spins a throwaway instance with 2PC enabled and the
# installed pg_reactive.so. Run inside the db container (PG binaries on PATH).
#
#   bash tests/ext_prepare_guard_test.sh
set -u
export PATH="/usr/lib/postgresql/16/bin:$PATH"
D=/tmp/f2test

cleanup() { pg_ctl -D "$D" stop >/dev/null 2>&1 || true; rm -rf "$D" /tmp/f2.log; }
fail() { echo "FAIL: $1" >&2; cleanup; exit 1; }

rm -rf "$D" /tmp/f2.log
initdb -D "$D" -U postgres >/dev/null 2>&1 || { echo "FAIL: initdb"; exit 1; }
pg_ctl -D "$D" \
  -o "-p 5440 -c shared_preload_libraries=pg_reactive -c max_prepared_transactions=5 -c unix_socket_directories=/tmp" \
  -l /tmp/f2.log start >/dev/null 2>&1 || { echo "FAIL: pg_ctl start"; cat /tmp/f2.log; exit 1; }
sleep 2

PSQL="psql -p 5440 -h /tmp -U postgres -d postgres -tA"

$PSQL -q -c "CREATE EXTENSION pg_reactive;" -c "CREATE TABLE pt(id int PRIMARY KEY);" || fail "setup"

# TEST A — PREPARE after subscribe is rejected by the guard.
errA=$($PSQL -c "BEGIN;" \
             -c "SELECT pgr.subscribe('pq','SELECT id FROM pt');" \
             -c "PREPARE TRANSACTION 'tx1';" 2>&1)
echo "$errA" | grep -q "PREPARE TRANSACTION is not supported" \
  || fail "guard did not reject PREPARE-after-subscribe; got: $errA"

# The aborted PREPARE must leave NOTHING behind: catalog and shmem rolled back.
cat_rows=$($PSQL -c "SELECT count(*) FROM pgr.persisted_subscriptions WHERE query_id='pq';")
[ "$cat_rows" = "0" ] || fail "catalog not rolled back: $cat_rows row(s) for 'pq'"
shmem_rows=$($PSQL -c "SELECT count(*) FROM pgr.get_subscriptions() WHERE query_id='pq';")
[ "$shmem_rows" = "0" ] || fail "shmem not rolled back: $shmem_rows entr(ies) for 'pq'"

# TEST B — a subscription-free transaction still prepares and commits.
$PSQL -v ON_ERROR_STOP=1 \
      -c "BEGIN;" -c "SELECT 1;" \
      -c "PREPARE TRANSACTION 'tx2';" -c "COMMIT PREPARED 'tx2';" >/dev/null 2>&1 \
  || fail "PREPARE of a subscription-free transaction was wrongly rejected"

orphans=$($PSQL -c "SELECT count(*) FROM pg_prepared_xacts;")
[ "$orphans" = "0" ] || fail "$orphans orphaned prepared transaction(s) remain"

cleanup
echo "PASS: 2PC PREPARE guard rejects subscription txns, allows others, rolls back catalog+shmem"
