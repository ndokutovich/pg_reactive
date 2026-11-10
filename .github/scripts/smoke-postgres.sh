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
  # A manifest-list digest resolves to a different image per platform, but a
  # classic image store files both under the same repo@digest reference — the
  # second pull dies with "cannot overwrite digest". Drop the previous one.
  "$docker_cli" rmi "$img" >/dev/null 2>&1 || true
  "$docker_cli" run -d --platform "$plat" --pull=always --name cand-db -e POSTGRES_DB=pg_reactive_test \
    -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_HOST_AUTH_METHOD=trust \
    "$img" postgres -c shared_preload_libraries=pg_reactive -c log_min_messages=warning
  # The postgres entrypoint's FIRST-init temporary server (socket-only) accepts
  # connections, runs init, then SHUTS DOWN to restart the real server. Any single
  # statement can race into "the database system is shutting down" / "starting up"
  # — including a SELECT issued right after a CREATE that landed on the temp
  # server. So retry ONE combined `CREATE EXTENSION; SELECT extversion` until the
  # (stable) server returns a version; a transient failure just means "not fully
  # up yet". `|| ver=` keeps set -e from aborting on the expected transient errors.
  ver=
  for _ in $(seq 1 100); do
    ver="$("$docker_cli" exec cand-db psql -U postgres -d pg_reactive_test -tAc \
      "CREATE EXTENSION IF NOT EXISTS pg_reactive; SELECT extversion FROM pg_extension WHERE extname='pg_reactive'" 2>/dev/null)" || ver=
    [ -n "$ver" ] && break
    sleep 3
  done
  [ -n "$ver" ] || { echo "::error::${plat} postgres never loaded pg_reactive (boot/init failed or extension missing)" >&2; exit 1; }
  "$docker_cli" rm -f cand-db >/dev/null 2>&1 || true
  echo "✓ pgstack-postgres ${plat} boots; pg_reactive ${ver} loaded"
done
