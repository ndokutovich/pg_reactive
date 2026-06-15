#!/usr/bin/env bash
# Print the `docker buildx imagetools create` -t arguments for a release version.
# A FINAL release gets the exact version + the floating MAJOR.MINOR + latest (+
# any fixed extra tag, e.g. the PostgreSQL major `16`); a PRE-RELEASE gets ONLY
# the exact-version tag — never the floating tags. Tested by execution in
# tests/release_scripts_test.mjs (gemini R27).
#
# Usage: compute-docker-tags.sh <repo> <ref-or-version> [extra-fixed-tag]
set -euo pipefail

repo="${1:?usage: compute-docker-tags.sh <repo> <ref-or-version> [extra]}"
V="${2:?usage: compute-docker-tags.sh <repo> <ref-or-version> [extra]}"
V="${V#refs/tags/}"
V="${V#v}"
extra="${3:-}"

printf -- '-t %s:%s' "$repo" "$V"
case "$V" in
  *-*) ;;  # pre-release: exact version only, no floating tags
  *)
    printf -- ' -t %s:%s -t %s:latest' "$repo" "${V%.*}" "$repo"
    [ -n "$extra" ] && printf -- ' -t %s:%s' "$repo" "$extra"
    ;;
esac
printf '\n'
