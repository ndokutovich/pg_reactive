#!/usr/bin/env bash
# Artifact smoke of the EXACT pgstack-postgres digest on BOTH published arches
# (via the job's QEMU): boot it and load pg_reactive. The docker calls are seam-
# injectable (DOCKER_CLI) so the control flow — both arches, boot, CREATE
# EXTENSION, version check — is execution-tested in tests/release_scripts_test.mjs
# with a stubbed docker (gemini R28-4). Real Docker runs only on CI.
#
# Usage: smoke-postgres.sh <image-ref>   (a repo@sha256:… digest ref)
set -euo pipefail

img="${1:?usage: smoke-postgres.sh <image-ref>}"
docker_cli="${DOCKER_CLI:-docker}"
for plat in linux/amd64 linux/arm64; do
  echo "=== pgstack-postgres smoke on ${plat} ==="
  "$docker_cli" rm -f cand-db >/dev/null 2>&1 || true
  "$docker_cli" run -d --platform "$plat" --pull=always --name cand-db -e POSTGRES_DB=pg_reactive_test \
    -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_HOST_AUTH_METHOD=trust \
    "$img" postgres -c shared_preload_libraries=pg_reactive -c log_min_messages=warning
  ready=
  for _ in $(seq 1 100); do "$docker_cli" exec cand-db pg_isready -U postgres -d pg_reactive_test && { ready=1; break; }; sleep 3; done
  [ -n "$ready" ] || { echo "::error::${plat} postgres never became ready" >&2; exit 1; }
  "$docker_cli" exec cand-db psql -U postgres -d pg_reactive_test -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS pg_reactive"
  ver="$("$docker_cli" exec cand-db psql -U postgres -d pg_reactive_test -tAc "SELECT extversion FROM pg_extension WHERE extname='pg_reactive'")"
  [ -n "$ver" ] || { echo "::error::pg_reactive did not load in the ${plat} image" >&2; exit 1; }
  "$docker_cli" rm -f cand-db >/dev/null 2>&1 || true
  echo "✓ pgstack-postgres ${plat} boots; pg_reactive ${ver} loaded"
done
