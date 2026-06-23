#!/usr/bin/env bash
# Runs INSIDE a clean node:22 container. Installs the CLI + SDK exactly as a new
# user would (from a packed tarball in local mode, or from npm in published mode),
# scaffolds a project, compiles a tiny app against the SDK, and runs it against
# the live backend. Exits 0 only when a live delta is received (DELTA_OK).
set -euo pipefail
echo "=== pgStack CLI+SDK dogfood (mode: ${MODE:-?}) ==="

# ── 1. Install the CLI and scaffold a project ───────────────────────────────
echo "--- install CLI: ${CLI_SOURCE} ---"
npm install -g "${CLI_SOURCE}" >/dev/null 2>&1
echo "pgstack version: $(pgstack --version 2>&1 | tail -1)"

cd /tmp && rm -rf demoapp
pgstack init demoapp >/dev/null
test -d demoapp/migrations            || { echo "::error::init produced no migrations/";        exit 1; }
ls demoapp/migrations/*.sql >/dev/null  2>&1 || { echo "::error::init produced no bootstrap migration"; exit 1; }
test -f demoapp/public/index.html     || { echo "::error::init produced no public/index.html";  exit 1; }
test -f demoapp/seed.sql              || { echo "::error::init produced no seed.sql";            exit 1; }
echo "✓ pgstack init scaffolded a project (migrations + public + seed)"

# ── 2. Compile a tiny app against the SDK ───────────────────────────────────
cd /work/app
echo "--- install SDK: ${SDK_SOURCE} ---"
npm install >/dev/null 2>&1
npm install "${SDK_SOURCE}" >/dev/null 2>&1
echo "--- tsc build (proves SDK types + ESM resolution) ---"
npm run build
test -f dist/index.js || { echo "::error::SDK app did not compile"; exit 1; }
echo "✓ app compiled against @pgstack/sdk"

# ── 3. Run the live-query app against the backend ───────────────────────────
echo "--- run live-query app against ${PGSTACK_URL} ---"
exec node dist/index.js
