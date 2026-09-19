# pgStack

**An open-source Supabase alternative you can run on any VPS with one `docker compose up`.**

Auth (email + OAuth), PostgREST-compatible REST API, realtime subscriptions,
edge functions, file storage, a Studio admin UI — all backed by stock
PostgreSQL and shipped as a small set of containers. No managed-cloud
lock-in, no per-row pricing, no proprietary protocol on top of PG.

> **Looking for the PostgreSQL extension on its own?** pgStack's realtime
> layer is powered by [`pg_reactive`](ext/README.md) — a standalone PG
> extension that turns any `SELECT` into a live query. Use it without
> pgStack if all you need is reactive SQL.

## What's in the box

| Component | What it does | Where |
|-----------|--------------|-------|
| **Go proxy** (`proxy-go/`) | chi-based server: REST, Auth, Realtime, Edge Functions, Storage, RLS middleware, rate limiting, TLS via Let's Encrypt | One binary, one container |
| **Studio** (`studio/`) | React SPA: table editor, SQL editor, auth users, realtime channels, logs | Served at `/studio/` |
| **TypeScript SDK** (`sdk/`) | `PgStackClient` (REST + auth + realtime + functions), React hooks, server-side admin, generic query builder, DBOS-style job queue | `@pgstack/sdk` on npm |
| **CLI** (`cli/`) | `pgstack init`, `pgstack dev`, migration management, type generation, project scaffolding | `pgstack` on npm |
| **pg_reactive** (`ext/`) | PostgreSQL extension: live `SELECT` subscriptions with delta `NOTIFY`s. The realtime backend pgStack uses | Standalone — see [`ext/README.md`](ext/README.md) |

## Quick start

```bash
git clone https://github.com/ndokutovich/pg_reactive.git
cd pg_reactive
docker compose up -d --build
```

Then:

- REST: `http://127.0.0.1:8080/rest/v1/{table}`
- Auth: `http://127.0.0.1:8080/auth/v1/...`
- Realtime (WebSocket): `ws://127.0.0.1:8080/ws/{query_id}`
- Studio: `http://127.0.0.1:8080/studio/`
- Postgres: `127.0.0.1:15432`

Or scaffold a fresh project with the CLI:

```bash
npx pgstack init my-app
cd my-app
npx pgstack dev
```

Or take just the PostgreSQL extension (no proxy/pgStack) from
[PGXN](https://pgxn.org/dist/pg_reactive/) into an existing 15–18 cluster:

```bash
pgxn install pg_reactive
```

## Use it from your app

```typescript
import { createClient } from "@pgstack/sdk/pgstack";

const client = createClient("http://127.0.0.1:8080", process.env.PGSTACK_ANON_KEY!);

// Auth
await client.auth.signUp({ email, password });
const { data: auth } = await client.auth.signInWithPassword({ email, password }); // session at auth.session

// REST (PostgREST-compatible)
const { data: orders } = await client.from("orders")
  .select("id, total, status, customer:customers(name)")
  .eq("status", "open")
  .order("total", { ascending: false })
  .limit(20);

// Realtime — same wire format as pg_reactive (root entry, not the pgstack client)
import { createClient as createLiveClient } from "@pgstack/sdk";
const live = createLiveClient({ url: "ws://127.0.0.1:8080" }).subscribe("orders_q");
live.on((event, data) => { /* delta / overflow / invalidated */ });

// Edge functions
const { data } = await client.functions.invoke("process-order", {
  body: { orderId: 123 },
});
```

## Production deployment

`examples/docker-compose.prod.yml` is the canonical production overlay:
fail-fast on missing secrets, `PGSTACK_ENV=production` strict validator,
no host ports by default (traffic enters only through the umbrella nginx
over the shared `gateway` network), scram-sha-256 auth,
`REQUIRE_AUTHENTICATED_WS=true`. For a standalone single-box deploy with
`127.0.0.1` port bindings and `TLS_MODE=auto` (autocert), use the root
`docker-compose.prod.yml` instead.

A fresh VPS bootstrap is one script:

```bash
bash scripts/bootstrap-env.sh   # idempotent: generates real secrets via openssl rand
docker compose --env-file .env -f examples/docker-compose.yml \
                                -f examples/docker-compose.prod.yml up -d
```

Push to `master` triggers `.github/workflows/deploy.yml` which SSHes to
the VPS and re-deploys. See [`docs/site/`](docs/site/) for the full
deployment guide.

## Architecture at a glance

```
+--------------------+           +-----------------------+           +-------------------+
|  PostgreSQL        |           |  Go proxy (chi)       |           |  Browser / Node   |
|                    |   NOTIFY  |                       |    WS     |                   |
|  pg_reactive ext   | --------> |  Realtime backend     | --------> |  @pgstack/sdk  |
|  (realtime         |           |                       |           |  React hooks      |
|   backend)         |           |  Auth / OAuth         |   REST    |  Studio           |
|                    |           |  REST + RLS           | <-------> |                   |
|                    |  pgx pool |  Edge Functions       |           |                   |
|                    | <-------- |  Storage              |           |                   |
+--------------------+           +-----------------------+           +-------------------+
                                          |
                                          | static
                                          v
                                  +---------------+
                                  |  Studio SPA   |
                                  |  (React)      |
                                  +---------------+
```

Realtime today is `pg_reactive` (LISTEN/NOTIFY, low-latency, column-level
invalidation). Polling, logical-replication, or CDC backends could be added
behind the same proxy in the future for workloads where NOTIFY's profile
doesn't fit.

## Features

**Auth**
- Email + password (Argon2id), OAuth (Google, GitHub, Apple, Microsoft, generic OIDC), magic links,
  email verification, password reset, admin user CRUD.
- Refresh-token rotation with family-based reuse detection.
- JWT issuance, RLS context injection.

**REST (PostgREST-compatible)**
- CRUD on any table.
- Filter operators: `eq`, `neq`, `gt`/`gte`/`lt`/`lte`, `like`, `ilike`,
  `in`, `is`, `cs`/`cd` (array contains), `fts`, `not.*`, `or()`, `and()`.
- Resource embedding via FK joins: `select=id,title,authors(name)`.
- Pagination, ordering, column selection, `Content-Range` + `Prefer: count=exact`.
- RPC for SQL functions (scalar and set-returning).
- Transaction batching: `POST /rest/v1/batch` with `{{op.field}}` templates
  (atomic + partial modes).

**Realtime**
- Live queries via `pg_reactive`: subscribe to any `SELECT`, receive deltas
  on insert/update/delete. Column-level invalidation tracking.
- Audience-bound subscriptions: server-side enforcement that only matching
  JWTs receive a delta.
- Multi-client fan-out, presence channels, broadcast.

**Edge Functions**
- Five runtimes: Deno reverse-proxy (Supabase-compatible), embedded goja
  JS, PL/v8, PL/Python, and `http` (per-function container in any language).
- Env vars encrypted at rest (AES-256-GCM under `SECRETS_ENCRYPTION_KEY`).
- Uniform `EDGE_FN_TIMEOUT_MS` deadline.

**Storage**
- File upload/download with MIME validation, size limits, RLS-aware
  bucket/object permissions.
- Database-backed or filesystem-backed.

**Webhooks**
- Outbound HTTP webhooks on table events.
- Signing secret stored encrypted; SSRF-hardened delivery (refuses
  loopback, private, link-local, IANA-reserved IPs); fail-closed refresh.

**Studio UI**
- Table editor (CRUD), SQL editor with history, auth user management,
  database browser, realtime channel inspector, logs viewer.

**Operability**
- HSTS, CSP, `Permissions-Policy`, strict CORS by default.
- Rate limiting (per-IP, with `TRUSTED_PROXIES` for X-Forwarded-For).
- `LOG_LEVEL` env, structured JSON logs (zerolog).
- Graceful shutdown, healthcheck endpoint.

## Documentation

- **Full docs site** (Docusaurus 3): [`docs/site/`](docs/site/)
- **Architecture & dev workflow**: [`CLAUDE.md`](CLAUDE.md)
- **Security policy**: [`SECURITY.md`](SECURITY.md)
- **Security audit** (Critical/High/Medium remediated): [`docs/SECURITY_AUDIT_2026-03-07.md`](docs/SECURITY_AUDIT_2026-03-07.md)
- **Contributing**: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- **Changelog**: [`CHANGELOG.md`](CHANGELOG.md)

## Testing

Per-component test commands and the full E2E matrix (~350 tests) are
documented in [`CLAUDE.md`](CLAUDE.md). At the highest level:

```bash
# Extension (pg_regress + isolation)
docker compose exec -T db bash -c 'su - postgres -c "cd /ext/ext && make installcheck && make isolation_installcheck"'

# Go proxy unit tests
cd proxy-go && go test ./...

# SDK + CLI
cd sdk && npm test
cd cli && npm test

# E2E (requires docker compose up)
node tests/e2e_ws_test.mjs       # …and 13 other E2E suites
bash tests/perf/runner.sh         # full perf suite (~10 min)
```

## Project layout

```
ext/                  pg_reactive PostgreSQL extension (own README, own LICENSE)
proxy-go/             Go proxy: REST, Auth, Realtime, Edge Functions, Storage
studio/               React Studio SPA
sdk/                  TypeScript SDK (@pgstack/sdk)
cli/                  pgstack CLI tool
docker/               Production Dockerfiles + init.sql + entrypoint
examples/             Demo apps + production compose overlay
tests/                E2E, integration, performance
docs/                 Docusaurus site + security audit + plans
scripts/              bootstrap-env.sh and friends
```

## Requirements

- PostgreSQL 15–18 for the extension itself (each major CI-proven: full
  pg_regress + isolation on bare PGDG images); the bundled pgStack images ship
  PostgreSQL 16
- Go 1.25.11 or a patched newer toolchain (for proxy) — the CI-verified build pins `go1.25.11`, on which `govulncheck` is clean; older 1.25.x patch releases may carry unpatched stdlib advisories
- Node.js 18+ (for SDK and CLI)
- Docker and Docker Compose (for development)

## License

This repository is dual-licensed because it ships two different things:

- **PostgreSQL extension** (`ext/`) is licensed under the **PostgreSQL License**
  — the same license PostgreSQL itself uses. See [`ext/LICENSE`](ext/LICENSE).
  This is the right license for an extension distributed via PGXN or installed
  into a vanilla PostgreSQL cluster.
- **Everything else** — Go proxy, TypeScript SDK, Studio, CLI, examples,
  infrastructure, docs — is licensed under the **Apache License 2.0**. See
  [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

Both licenses are permissive and mutually compatible. If you redistribute a
bundled product (e.g. a single Docker image containing both components), you
must comply with both. By submitting a pull request you agree to license your
contribution under the license of the directory it lands in — see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

Security reports: see [`SECURITY.md`](SECURITY.md).
