#!/usr/bin/env bash
# Validate that a release tag is strict SemVer AND that the SDK/CLI package.json
# versions match it. The git tag is the single source of truth for the release
# version; this aborts the release before any publish if it is malformed or the
# packages drift from it. Tested by EXECUTION in tests/release_scripts_test.mjs
# (the regex-analysis of an inline grep had hit its limit — gemini R26/R27).
#
# Usage: validate-release-version.sh <ref-or-version>
#   ref may be refs/tags/vX.Y.Z, vX.Y.Z, or X.Y.Z. Reads sdk/package.json and
#   cli/package.json relative to CWD. Echoes the bare version on success.
set -euo pipefail

ref="${1:?usage: validate-release-version.sh <ref-or-version>}"
V="${ref#refs/tags/}"
V="${V#v}"

# Full semver.org grammar, build metadata disallowed (Docker tags can't carry
# '+'): each prerelease identifier is 0 | [1-9]digits | <alnum-with-letter/hyphen>,
# dot-separated and non-empty — so 1.2.3-01, 1.2.3-., 1.2.3-a..b are all rejected.
if ! printf '%s' "$V" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*)?$'; then
  echo "::error::tag '${ref}' is not strict SemVer vMAJOR.MINOR.PATCH[-prerelease] (no leading zeros, no empty/dotted-empty prerelease ids, no +build)" >&2
  exit 1
fi

jq_cli="${JQ_CLI:-jq}"   # test seam: tests/release_scripts_test.mjs injects a stub
sdk_v="$("$jq_cli" -r .version sdk/package.json)"
cli_v="$("$jq_cli" -r .version cli/package.json)"
if [ "$sdk_v" != "$V" ] || [ "$cli_v" != "$V" ]; then
  echo "::error::tag ${V} != sdk@${sdk_v} / cli@${cli_v} — bump BOTH package.json versions to ${V} before tagging" >&2
  exit 1
fi

echo "$V"
