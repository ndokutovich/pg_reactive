#!/usr/bin/env bash
# Promote the EXACT image CI built and smoke-tested for a commit to the release
# version tags — never a rebuild from a mutable base (gemini finding 7). Resolves
# the immutable sha-<sha> staging tag to a digest and `imagetools create`s the
# version tags from that digest (a manifest copy). Runs on GHCR; the docker/jq
# calls are seam-injectable so the control flow is execution-tested in
# tests/release_scripts_test.mjs (gemini R28-4).
#
# Usage: promote-image.sh <repo> <sha> <ref-or-version> [extra-fixed-tag]
set -euo pipefail

repo="${1:?usage: promote-image.sh <repo> <sha> <ref> [extra]}"
sha="${2:?usage: promote-image.sh <repo> <sha> <ref> [extra]}"
ref="${3:?usage: promote-image.sh <repo> <sha> <ref> [extra]}"
extra="${4:-}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
docker_cli="${DOCKER_CLI:-docker}"   # test seams
jq_cli="${JQ_CLI:-jq}"

src="${repo}:sha-${sha}"
# `{{ .Manifest.Digest }}` prints the whole human-readable inspect on current
# Buildx, not the digest (buildx #1175) — extract from JSON.
digest="$("$docker_cli" buildx imagetools inspect "$src" --format '{{json .Manifest}}' | "$jq_cli" -r '.digest')"
case "$digest" in sha256:*) ;; *) echo "::error::could not resolve digest for ${src} (got '${digest}')" >&2; exit 1 ;; esac

# Invoke the tag-computer via `bash` (NOT directly) so it need not carry the +x
# bit — a core.filemode=false checkout stores it 100644 and a direct exec would
# be Permission denied on Linux, which the old `read <<< "$(…)"` swallowed,
# leaving the tag list empty and promoting nothing (gemini R28-2). Fail closed.
tags_line="$(bash "$here/compute-docker-tags.sh" "$repo" "$ref" "$extra")" \
  || { echo "::error::compute-docker-tags.sh failed for ${ref}" >&2; exit 1; }
read -r -a tags <<< "$tags_line"
[ "${#tags[@]}" -ge 2 ] || { echo "::error::no -t tag args computed for ${ref} (refusing to promote with zero tags)" >&2; exit 1; }

echo "promoting ${src} (${digest}) as: ${tags[*]}"
"$docker_cli" buildx imagetools create "${tags[@]}" "${repo}@${digest}"
