#!/usr/bin/env bash
# pgStack — one-command build & verify (Docker-first).
#
#   ./build.sh            Build the canonical all-in-one image.
#   ./build.sh verify     Build, boot, smoke-test the stack, tear down. CI-friendly.
#   ./build.sh up         Build + run; proxy stays up on :$PORT (default 8080).
#   ./build.sh down       Stop & remove the running container.
#   ./build.sh go         Host-side `go build` + `go test` for the proxy (no Docker).
#   ./build.sh examples   Build + run the 4-service examples stack (examples/docker-compose.yml).
#   ./build.sh clean      Remove the image and any leftover containers.
#
# Env overrides:  TAG (default latest)  PORT (default 8080)
set -euo pipefail
cd "$(dirname "$0")"

IMAGE=pgstack-all-in-one
TAG="${TAG:-latest}"
CONTAINER=pgstack
PORT="${PORT:-8080}"
DOCKERFILE=docker/Dockerfile.all-in-one

c_green() { printf '\033[32m%s\033[0m\n' "$1"; }
c_red()   { printf '\033[31m%s\033[0m\n' "$1"; }
c_blue()  { printf '\033[36m%s\033[0m\n' "$1"; }

build() {
  c_blue "==> Building $IMAGE:$TAG (PostgreSQL + pg_reactive extension + Go proxy)"
  docker build -f "$DOCKERFILE" -t "$IMAGE:$TAG" .
  c_green "==> Image $IMAGE:$TAG built."
}

run() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  c_blue "==> Starting $CONTAINER on :$PORT"
  docker run -d --name "$CONTAINER" -p "$PORT:8080" \
    -e POSTGRES_PASSWORD=postgres \
    "$IMAGE:$TAG" -c shared_preload_libraries=pg_reactive >/dev/null
  c_blue "==> Waiting for /health ..."
  for i in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      c_green "==> Healthy after ${i}s — $(curl -s http://127.0.0.1:$PORT/health)"
      return 0
    fi
    sleep 1
  done
  c_red "==> Container did not become healthy. Logs:"
  docker logs "$CONTAINER" | tail -30
  return 1
}

down() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 && c_green "==> $CONTAINER stopped." || echo "==> $CONTAINER not running."
}

# Schema + end-to-end smoke test against a running container.
smoke() {
  local fail=0
  c_blue "==> Schema checks"
  local schema
  schema=$(docker exec "$CONTAINER" psql -U postgres -d postgres -tA -c "
    SELECT 'webhook_notify='        || count(*) FROM pg_proc WHERE proname='webhook_notify';
    SELECT 'enable_webhook_trigger='|| count(*) FROM pg_proc WHERE proname='enable_webhook_trigger';
    SELECT 'edge_functions.upstream_url=' || count(*) FROM information_schema.columns
      WHERE table_schema='pgstack' AND table_name='edge_functions' AND column_name='upstream_url';
  ")
  echo "$schema"
  echo "$schema" | grep -q "webhook_notify=1"         || { c_red "  MISSING webhook_notify"; fail=1; }
  echo "$schema" | grep -q "enable_webhook_trigger=1" || { c_red "  MISSING enable_webhook_trigger"; fail=1; }
  echo "$schema" | grep -q "edge_functions.upstream_url=1" || { c_red "  MISSING edge_functions.upstream_url"; fail=1; }

  c_blue "==> End-to-end webhook trigger test (INSERT/UPDATE/DELETE -> pgstack_webhooks NOTIFY)"
  local notify
  notify=$(docker exec "$CONTAINER" psql -U postgres -d postgres -c "
    CREATE TABLE IF NOT EXISTS _bsmoke (id int, val text);
    SELECT pgstack.enable_webhook_trigger('_bsmoke');
    LISTEN pgstack_webhooks;
    INSERT INTO _bsmoke VALUES (1,'a');
    UPDATE _bsmoke SET val='b' WHERE id=1;
    DELETE FROM _bsmoke WHERE id=1;
    SELECT pgstack.disable_webhook_trigger('_bsmoke');
    DROP TABLE _bsmoke;
    SELECT 1;
  " 2>&1)
  local n
  n=$(echo "$notify" | grep -c 'Asynchronous notification "pgstack_webhooks"' || true)
  if [ "$n" -eq 3 ]; then
    c_green "  3/3 webhook events fired (INSERT, UPDATE, DELETE)"
  else
    c_red "  expected 3 webhook NOTIFY events, got $n"; echo "$notify"; fail=1
  fi

  if [ "$fail" -eq 0 ]; then c_green "==> SMOKE TEST PASSED"; else c_red "==> SMOKE TEST FAILED"; fi
  return "$fail"
}

case "${1:-build}" in
  build)   build ;;
  up)      build; run ;;
  down)    down ;;
  verify)
    build; run
    if smoke; then down; c_green "==> VERIFY OK"; else down; c_red "==> VERIFY FAILED"; exit 1; fi
    ;;
  go)
    c_blue "==> go build + vet + test (proxy-go)"
    ( cd proxy-go && go build ./... && go vet ./... && go test ./... )
    c_green "==> Go checks passed."
    ;;
  examples)
    c_blue "==> Building + running the examples stack"
    docker compose -f examples/docker-compose.yml up -d --build
    c_green "==> Examples stack up. Web on :3000, proxy on :8080."
    ;;
  clean)
    down
    docker rmi "$IMAGE:$TAG" >/dev/null 2>&1 && c_green "==> Image removed." || echo "==> No image to remove."
    ;;
  *)
    echo "usage: ./build.sh [build|verify|up|down|go|examples|clean]"; exit 1 ;;
esac
