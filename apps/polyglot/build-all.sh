#!/usr/bin/env bash
# Build every polyglot image (6 engines + generator + dashboard + pgstack
# all-in-one) on the local Docker host. Tag everything pgstack/*:latest
# so the deploy template's compose can pull from local registry by name.
#
# Usage:
#   bash apps/polyglot/build-all.sh           # build all
#   bash apps/polyglot/build-all.sh node go   # build only listed targets

set -euo pipefail

# BuildKit features (COPY --chmod, secret/ssh mounts, parallel stages)
# are used by docker/Dockerfile.all-in-one and may be used by future
# engine Dockerfiles. Enable it globally for the script so a classic-
# builder host doesn't fail mid-build on a single step.
export DOCKER_BUILDKIT=1

cd "$(dirname "$0")"

ALL=(go node fastapi rust dotnet spring generator web pgstack)
TARGETS=("$@")
[ "${#TARGETS[@]}" -eq 0 ] && TARGETS=("${ALL[@]}")

build() {
  local name="$1"
  case "$name" in
    go|node|fastapi|rust|dotnet|spring)
      echo "▶ building pgstack/polyglot-engine-$name:latest"
      docker build -t "pgstack/polyglot-engine-$name:latest" "engines/$name/"
      ;;
    generator)
      echo "▶ building pgstack/polyglot-generator:latest"
      docker build -t pgstack/polyglot-generator:latest generator/
      ;;
    web)
      echo "▶ building pgstack/polyglot-web:latest"
      docker build -t pgstack/polyglot-web:latest web/
      ;;
    pgstack)
      echo "▶ building pgstack/pgstack:latest (all-in-one)"
      ( cd ../.. && docker build -f docker/Dockerfile.all-in-one -t pgstack/pgstack:latest . )
      ;;
    *)
      echo "unknown target: $name" >&2; exit 1;;
  esac
}

for t in "${TARGETS[@]}"; do
  build "$t"
done

echo "done."
