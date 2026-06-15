#!/usr/bin/env bash
# Artifact smoke of the EXACT pgstack-proxy digest on BOTH published arches (via
# QEMU): the image must REACH its production validator and reject a placeholder
# JWT_SECRET — asserted by the SPECIFIC rejection string, not a mere non-zero exit
# (a missing binary / loader error / panic also exits non-zero). No DB needed.
# docker is seam-injectable (DOCKER_CLI) for the execution test (gemini R28-4);
# real Docker runs only on CI.
#
# Usage: smoke-proxy.sh <image-ref>   (a repo@sha256:… digest ref)
set -euo pipefail

img="${1:?usage: smoke-proxy.sh <image-ref>}"
docker_cli="${DOCKER_CLI:-docker}"
for plat in linux/amd64 linux/arm64; do
  echo "=== pgstack-proxy smoke on ${plat} ==="
  set +e
  out="$("$docker_cli" run --rm --platform "$plat" --pull=always -e PGSTACK_ENV=production \
    -e JWT_SECRET=dev-only-jwt-secret-do-not-use-in-production \
    -e ANON_KEY="$(openssl rand -base64 32)" \
    -e SERVICE_ROLE_KEY="$(openssl rand -base64 32)" \
    -e SECRETS_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
    -e SMTP_HOST=smtp.example.com -e SMTP_USER=u -e SMTP_PASS=p \
    "$img" 2>&1)"
  status=$?
  set -e
  echo "$out"
  [ "$status" -ne 0 ] || { echo "::error::${plat} proxy ACCEPTED a placeholder JWT_SECRET in production" >&2; exit 1; }
  echo "$out" | grep -qF "JWT_SECRET still contains 'dev-only'" \
    || { echo "::error::${plat} proxy did not reach its production validator (no JWT_SECRET rejection — missing binary / loader error / panic?)" >&2; exit 1; }
  echo "✓ pgstack-proxy ${plat} ran its production validator and rejected the placeholder secret"
done
