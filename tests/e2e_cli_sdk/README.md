# CLI + SDK dogfood end-to-end

Proves the **published-or-packaged** `pgstack` CLI and `@pgstack/sdk` actually work
for a brand-new user — something the vitest unit suites can't see, because they
test `src/`, not the packed artifact, and never run against a live backend.

The backend is the **`pgstack-all-in-one`** image (PostgreSQL + pg_reactive +
proxy in one container), so this also exercises that published artifact. A clean
`node:22` "builder" container installs the CLI, `pgstack init`s a project,
compiles a tiny `@pgstack/sdk` app, and opens a **live query** — asserting a delta
arrives after an INSERT.

## One harness, two sources

```bash
# A — local artifacts (default): npm-pack the local cli/ + sdk/, build the
#     all-in-one from source. Catches regressions BEFORE publishing.
SOURCE=local bash tests/e2e_cli_sdk/runner.sh

# B — published: install pgstack + @pgstack/sdk from npm, pull the Docker Hub
#     all-in-one. Proves what users ACTUALLY get works.
SOURCE=published VERSION=0.2.0 bash tests/e2e_cli_sdk/runner.sh
```

## What it asserts

1. The CLI installs and `pgstack init` scaffolds a project (migrations + public + seed).
2. `@pgstack/sdk` installs and a TS app **compiles** against it (types + ESM resolution).
3. The app **connects** to the live backend and receives a live delta through the SDK.

## Files

- `runner.sh` — host orchestrator (resolve sources → backend → seed → builder → verdict).
- `Dockerfile.builder` / `entrypoint.sh` — the clean-room that installs CLI+SDK, scaffolds, compiles, runs the app.
- `app/` — the tiny `@pgstack/sdk` live-query app (the thing that must compile + run).

## Notes

- Runs on a clean host (CI: `ubuntu-latest`). The self-hosted runners are usually
  saturated (4 runners + multi-arch candidate builds), which starves a co-located
  PostgreSQL and makes heavy `CREATE EXTENSION` / `pgr.subscribe` calls flake — run
  it where the machine isn't already loaded.
- The all-in-one ships WITHOUT `pg_reactive` created (the deployment owns extension
  creation; the entrypoint only upgrades/restores a pre-existing one), so the runner
  does `CREATE EXTENSION pg_reactive` before seeding.
