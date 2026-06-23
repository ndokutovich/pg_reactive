#!/usr/bin/env bash
# pgStack CLI + SDK dogfood end-to-end — ONE harness, TWO sources.
#
#   SOURCE=local      (default) npm-pack the local cli/ + sdk/, build the all-in-one
#                     from source → catches regressions BEFORE publishing (CI gate).
#   SOURCE=published  install `pgstack` + `@pgstack/sdk` from npm, pull the Docker
#                     Hub all-in-one → proves what users ACTUALLY get works.
#
# The backend is the all-in-one image (PG + pg_reactive + proxy in one container),
# so the test also exercises that published artifact. The builder is a clean
# node:22 container that installs the CLI, `pgstack init`s a project, compiles a
# tiny @pgstack/sdk app, and opens a live query — asserting a delta arrives.
#
# Env: SOURCE=local|published, VERSION=<npm/docker tag> (published), AIO_IMAGE=<ref>.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SOURCE="${SOURCE:-local}"
NET="pgr_clisdk_e2e"
BACKEND="clisdk-backend"
BUILDER="clisdk-builder"
ANON="dev-only-anon-key-do-not-use-in-production"
JWT="dev-only-jwt-secret-do-not-use-in-production"

cleanup() {
  docker rm -f "$BACKEND" "$BUILDER" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$HERE/_artifacts"
}
trap cleanup EXIT
cleanup

# ── Resolve where the CLI / SDK / backend image come from ────────────────────
if [ "$SOURCE" = "published" ]; then
  ver="${VERSION:-latest}"
  AIO_IMAGE="${AIO_IMAGE:-docker.io/pgstack/pgstack-all-in-one:${ver}}"
  CLI_SOURCE="pgstack@${ver}"
  SDK_SOURCE="@pgstack/sdk@${ver}"
  echo "=== pulling published all-in-one: $AIO_IMAGE ==="
  docker pull "$AIO_IMAGE"
else
  mkdir -p "$HERE/_artifacts"
  echo "=== packing local cli/ + sdk/ (the real packaged artifacts) ==="
  ( cd "$ROOT/cli" && npm run build >/dev/null 2>&1 && npm pack --pack-destination "$HERE/_artifacts" >/dev/null )
  ( cd "$ROOT/sdk" && npm pack --pack-destination "$HERE/_artifacts" >/dev/null )
  cli_tgz="$(cd "$HERE/_artifacts" && ls pgstack-*.tgz | grep -v -- '-sdk-' | head -1)"
  sdk_tgz="$(cd "$HERE/_artifacts" && ls pgstack-sdk-*.tgz | head -1)"
  CLI_SOURCE="/work/_artifacts/${cli_tgz}"
  SDK_SOURCE="/work/_artifacts/${sdk_tgz}"
  AIO_IMAGE="${AIO_IMAGE:-pgstack-all-in-one:e2e-local}"
  echo "=== building all-in-one from source: $AIO_IMAGE ==="
  docker build -f "$ROOT/docker/Dockerfile.all-in-one" -t "$AIO_IMAGE" "$ROOT"
fi

docker network create "$NET" >/dev/null

# ── Backend: the all-in-one, dev mode with anon WS enabled ───────────────────
echo "=== starting backend ==="
docker run -d --name "$BACKEND" --network "$NET" \
  -e PGSTACK_ENV=development -e POSTGRES_PASSWORD=postgres \
  -e JWT_SECRET="$JWT" -e ANON_KEY="$ANON" -e REQUIRE_AUTHENTICATED_WS=false \
  "$AIO_IMAGE" >/dev/null

# "pgstack listening" is the proxy's last-mile readiness: it only starts the
# HTTP listener after PostgreSQL is up, the pgr schema is present, and both
# connection pools verify their roles — so it covers PG + extension + proxy.
echo "=== waiting for the proxy to listen (PG + extension + proxy all up) ==="
ready=
for _ in $(seq 1 90); do
  if docker logs "$BACKEND" 2>&1 | grep -q "pgstack listening"; then ready=1; break; fi
  [ "$(docker inspect -f '{{.State.Status}}' "$BACKEND" 2>/dev/null || echo gone)" = "exited" ] && break
  sleep 2
done
[ -n "$ready" ] || { echo "::error::backend never became ready"; docker logs "$BACKEND" 2>&1 | tail -30; exit 1; }

# ── Enable pg_reactive (the all-in-one ships WITHOUT it — the deployment owns
#    extension creation; the entrypoint only upgrades/restores a pre-existing one).
#    Retried because a transient hiccup during CREATE EXTENSION must not flake.
echo "=== enabling pg_reactive ==="
ext_ok=
for _ in $(seq 1 20); do
  if docker exec -e PGPASSWORD=postgres "$BACKEND" psql -U postgres -tAc "CREATE EXTENSION IF NOT EXISTS pg_reactive" >/dev/null 2>&1; then ext_ok=1; break; fi
  sleep 2
done
[ -n "$ext_ok" ] || { echo "::error::could not enable pg_reactive in the all-in-one"; docker logs "$BACKEND" 2>&1 | tail -20; exit 1; }

# ── Seed a table + register the live query the app subscribes to ─────────────
echo "=== seeding table + pgr.subscribe ==="
docker exec -e PGPASSWORD=postgres "$BACKEND" psql -U postgres -v ON_ERROR_STOP=1 -c \
  "CREATE TABLE cli_sdk_e2e(id serial PRIMARY KEY, name text); SELECT pgr.subscribe('cli_sdk_e2e_q', 'SELECT id, name FROM cli_sdk_e2e');"

# ── Builder: install CLI+SDK, scaffold, compile, run the live-query app ───────
echo "=== building builder image ==="
docker build -f "$HERE/Dockerfile.builder" -t "${BUILDER}:img" "$HERE" >/dev/null
echo "=== running CLI+SDK dogfood (source=$SOURCE) ==="
docker run -d --name "$BUILDER" --network "$NET" \
  -e MODE="$SOURCE" -e CLI_SOURCE="$CLI_SOURCE" -e SDK_SOURCE="$SDK_SOURCE" \
  -e PGSTACK_URL="ws://${BACKEND}:8080" -e ANON_KEY="$ANON" \
  "${BUILDER}:img" >/dev/null

# Wait until the app has subscribed (or the builder died during init/build).
echo "=== waiting for SUBSCRIBED ==="
subscribed=
for _ in $(seq 1 120); do
  if docker logs "$BUILDER" 2>&1 | grep -q "SUBSCRIBED"; then subscribed=1; break; fi
  [ "$(docker inspect -f '{{.State.Status}}' "$BUILDER" 2>/dev/null || echo gone)" = "exited" ] && break
  sleep 2
done

if [ -n "$subscribed" ]; then
  sleep 2
  echo "=== INSERT to trigger a live delta ==="
  docker exec -e PGPASSWORD=postgres "$BACKEND" psql -U postgres -c "INSERT INTO cli_sdk_e2e(name) VALUES ('cli_sdk_e2e_row');"
fi

# ── Verdict: the builder exits 0 only on DELTA_OK ────────────────────────────
echo "=== waiting for verdict ==="
code="$(docker wait "$BUILDER" 2>/dev/null || echo 1)"
echo "----- builder logs -----"
docker logs "$BUILDER" 2>&1 | tail -30
echo "------------------------"
if [ "$code" = "0" ]; then
  echo "PASS: pgstack init scaffolded + @pgstack/sdk app compiled + live delta received (source=$SOURCE)"
else
  echo "::error::FAIL: CLI/SDK dogfood failed (builder exit $code, source=$SOURCE)"
  exit 1
fi
