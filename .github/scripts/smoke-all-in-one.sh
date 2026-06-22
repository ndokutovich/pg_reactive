#!/usr/bin/env bash
# Artifact smoke of the EXACT pgstack-all-in-one digest on BOTH published arches
# (via QEMU): the single container must boot PostgreSQL, load the pg_reactive
# extension, AND start the proxy (the lifecycle leader). Asserted by SPECIFIC
# signals — the proxy's "pgstack listening" log line AND a non-empty extversion —
# not a mere "container is up". docker is seam-injectable (DOCKER_CLI) so the
# control flow is execution-tested in tests/release_scripts_test.mjs; real Docker
# runs only on CI.
#
# The all-in-one is a DEMO / SINGLE-TENANT image (co-located PG + proxy, weaker
# than the split deployment's inv-22 isolation) — see docker/Dockerfile.all-in-one.
#
# Usage: smoke-all-in-one.sh <image-ref>   (a repo@sha256:… digest ref)
set -euo pipefail

img="${1:?usage: smoke-all-in-one.sh <image-ref>}"
docker_cli="${DOCKER_CLI:-docker}"
for plat in linux/amd64 linux/arm64; do
  echo "=== pgstack-all-in-one smoke on ${plat} ==="
  "$docker_cli" rm -f cand-aio >/dev/null 2>&1 || true
  # Dev mode: the proxy fail-closes in production without real secrets; this smoke
  # only proves the image boots PG + extension + proxy end-to-end.
  "$docker_cli" run -d --platform "$plat" --pull=always --name cand-aio \
    -e PGSTACK_ENV=development -e POSTGRES_PASSWORD=postgres \
    "$img" >/dev/null

  # 1. The proxy is the lifecycle leader — wait for its listen line.
  listening=
  for _ in $(seq 1 100); do
    if "$docker_cli" logs cand-aio 2>&1 | grep -q "pgstack listening"; then listening=1; break; fi
    sleep 3
  done
  if [ -z "$listening" ]; then
    "$docker_cli" logs cand-aio 2>&1 | tail -30 >&2
    "$docker_cli" rm -f cand-aio >/dev/null 2>&1 || true
    echo "::error::${plat} all-in-one proxy never reached 'pgstack listening' (PG/extension/proxy boot failed)" >&2
    exit 1
  fi

  # 2. pg_reactive must be loadable in the co-located PostgreSQL. Combined
  #    CREATE+SELECT retried so a transient connection error during init doesn't
  #    flap (same pattern as smoke-postgres.sh).
  ver=
  for _ in $(seq 1 30); do
    ver="$("$docker_cli" exec cand-aio psql -U postgres -tAc \
      "CREATE EXTENSION IF NOT EXISTS pg_reactive; SELECT extversion FROM pg_extension WHERE extname='pg_reactive'" 2>/dev/null)" || ver=
    [ -n "$ver" ] && break
    sleep 2
  done
  "$docker_cli" rm -f cand-aio >/dev/null 2>&1 || true
  [ -n "$ver" ] || { echo "::error::${plat} all-in-one: pg_reactive did not load" >&2; exit 1; }
  echo "✓ pgstack-all-in-one ${plat} boots: PostgreSQL + pg_reactive ${ver} + proxy listening"
done
