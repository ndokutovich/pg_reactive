#!/usr/bin/env bash
# Require that a SUCCESSFUL CI run exists for an exact commit SHA on a master
# push (not a fork/PR run that merely shares the SHA). Shared by release.yml's
# ci-gate and deploy.yml's manual-dispatch gate, so the CI-green contract lives
# in ONE tested place. Exits non-zero if no such run exists. Tested by execution
# with a stubbed `gh` in tests/release_scripts_test.mjs (gemini R27).
#
# Usage: require-green-ci.sh <owner/repo> <sha>   (needs gh + $GH_TOKEN)
set -euo pipefail

repo="${1:?usage: require-green-ci.sh <owner/repo> <sha>}"
sha="${2:?usage: require-green-ci.sh <owner/repo> <sha>}"
gh_cli="${GH_CLI:-gh}"   # test seam: tests/release_scripts_test.mjs injects a stub

n="$("$gh_cli" api \
  "repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&status=completed&event=push&branch=master" \
  --jq '[.workflow_runs[] | select(.conclusion=="success" and .event=="push" and .head_branch=="master")] | length')"

if [ "${n:-0}" -lt 1 ]; then
  echo "::error::no successful CI run for ${sha} (push to master) — only release/deploy a commit that is green on master" >&2
  exit 1
fi
echo "CI is green for ${sha} (${n} successful run(s))"
