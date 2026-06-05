# Polyglot Matching Engines — deploy template

Six independent matching engines (Go, Node, Python/FastAPI, Rust, .NET,
Spring Boot) running against the same order stream from pgstack, with a
live dashboard at the root of the chosen subdomain. The pitch is the
**side-by-side comparison** — same input, six implementations, visibly
different fills / latency / book state.

See [`apps/polyglot/SPEC.md`](../../../apps/polyglot/SPEC.md) for the
architecture and the engine contract.

## What's in this directory

| File                                | Role |
|-------------------------------------|------|
| `docker-compose.yml`                | pgstack + one-shot migration + generator + 6 engines + static web + Inbucket |
| `.env.example`                      | Required secrets and image pins |
| `migration.sql`                     | Schema + roles + RLS + RPC + `pgr.subscribe` registrations |
| `umbrella/app-polyglot.conf.template` | Manual-setup variant of the umbrella server-name block |

The repo also tracks the canonical umbrella conf at
[`deploy/umbrella/app-polyglot.conf`](../../umbrella/app-polyglot.conf),
which the `deploy.yml` workflow auto-installs on every push for
`polyglot.pgstack.org`.

## Build the 8 images on a Docker host

The engines, generator, and dashboard are not yet published to a public
registry — for now, build each one locally from the repo:

```bash
# from repo root
cd apps/polyglot

# 6 matching engines
docker build -t pgstack/polyglot-engine-go:latest      engines/go/
docker build -t pgstack/polyglot-engine-node:latest    engines/node/
docker build -t pgstack/polyglot-engine-fastapi:latest engines/fastapi/
docker build -t pgstack/polyglot-engine-rust:latest    engines/rust/
docker build -t pgstack/polyglot-engine-dotnet:latest  engines/dotnet/
docker build -t pgstack/polyglot-engine-spring:latest  engines/spring/

# generator + dashboard
docker build -t pgstack/polyglot-generator:latest      generator/
docker build -t pgstack/polyglot-web:latest            web/

# pgstack all-in-one (PG + pg_reactive + Go proxy) — from repo root
cd ../..
docker build -f docker/Dockerfile.all-in-one -t pgstack/pgstack:latest .
```

The .NET, Rust, and Spring Boot builds are slowest (Maven download, Cargo
compile, NuGet restore). Plan ~15–25 minutes for a cold build of the
entire matrix on a typical VPS.

## First-time setup on a VPS

```bash
sudo mkdir -p /opt/apps/polyglot
sudo chown "$USER":"$USER" /opt/apps/polyglot
cp -r deploy/templates/polyglot-showcase/. /opt/apps/polyglot/
cd /opt/apps/polyglot

cp .env.example .env
for k in POSTGRES_PASSWORD JWT_SECRET ANON_KEY SERVICE_ROLE_KEY \
         SECRETS_ENCRYPTION_KEY POLYGLOT_ENGINE_PASSWORD; do
  v=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)
  sed -i "s|^$k=$|$k=$v|" .env
done
# Open .env in an editor: set SITE_URL to your subdomain. Image pins
# stay on :latest; if you tag iterating builds with :dev, override here.

docker network create gateway 2>/dev/null || true
docker compose up -d
```

The first up will be slow — `polyglot-migration` runs once against the
freshly-booted pgstack, then the six engines connect, LISTEN, and start
consuming whatever the generator emits.

The umbrella nginx config installs itself automatically via the
deploy.yml pipeline. Until that runs, drop the manual variant:

```bash
sudo cp umbrella/app-polyglot.conf.template /opt/proxy/nginx/conf.d/app-polyglot.conf
sudo sed -i 's|polyglot\.example\.com|YOUR_SUBDOMAIN.your.tld|' \
  /opt/proxy/nginx/conf.d/app-polyglot.conf
docker exec umbrella-proxy nginx -t \
  && docker exec umbrella-proxy nginx -s reload
```

## Knobs

`.env`:

| var                | meaning |
|--------------------|---------|
| `ORDERS_PER_SEC`   | generator rate — default 4 |
| `MID_PRICE`        | random-walk centre — default 50000 |
| `SPREAD`           | ± from `MID_PRICE` for limit orders |
| `MAX_QTY`          | per-order ceiling |
| `CANCEL_RATE`      | fraction of events that are cancels |
| `ENGINE_*_IMAGE`   | per-engine image pin |

To pause the ambient flow, scale the generator to zero:

```bash
docker compose stop polyglot-generator
```

The manual "Send order" form on the dashboard stays alive — it calls the
`public.place_order` RPC via the guest JWT minted by `signInAnonymously`.

## Discipline preserved

`PGSTACK_ENV=production`, `REQUIRE_AUTHENTICATED_WS=true`,
`ENABLE_SQL_ENDPOINT=false`, `ENABLE_DEMO_ENDPOINT=false`. The
showcase intentionally enables `ALLOW_ANONYMOUS_SIGNIN=true` so the
dashboard works without an account; everything else stays strict.

The `polyglot_engine` role has GRANTs only on the tables it needs —
SELECT on `order_events`, full CRUD on `engine_*`. The frontend role
sees the same data SELECT-only, with mutation gated by the `place_order`
RPC. Round 26/28/33 hardening on every SECURITY DEFINER as usual.
