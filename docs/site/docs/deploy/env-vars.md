---
title: Environment Variables
sidebar_position: 2
description: Complete reference for all pgStack environment variables.
---

# Environment Variables

All pgStack configuration is done through environment variables. Copy `.env.example` to `.env` and fill in values before starting.

## Generating secrets

```bash
# Use this for JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY, POSTGRES_PASSWORD, SECRETS_ENCRYPTION_KEY
openssl rand -base64 32
```

Run it five times and use each output for a different secret.

## Required variables

These must be set for production. In development, the compose file provides insecure defaults.

| Variable | Example | Description |
|----------|---------|-------------|
| `POSTGRES_PASSWORD` | `Xk8mP2nQ9r...` | PostgreSQL superuser password. Must be strong. |
| `JWT_SECRET` | `Ym3vL5wK1t...` | Signing key for JWT access tokens. Must be 32+ characters. |
| `ANON_KEY` | `Nz6xB4cJ8p...` | API key for anonymous (unauthenticated) requests. |
| `SERVICE_ROLE_KEY` | `Qr1eD7hF3a...` | Admin API key. Bypasses RLS. Keep secret. |
| `SITE_URL` | `https://app.example.com` | Public URL of your app. Required for OAuth redirects. |
| `SECRETS_ENCRYPTION_KEY` | `Tn4vC9eB2k...` | 32 bytes base64. AES-256-GCM key for every at-rest secret the proxy holds. Required whenever you use: (a) edge function env vars; (b) webhook signing secrets (`pgstack.webhooks.secret_encrypted`). With the key missing, `CreateWebhook` with a non-empty secret returns 400, and existing encrypted-secret rows are dropped from the in-memory delivery cache at refresh (fail-closed). |

## Database variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_DB` | `app` | Database name. |
| `POSTGRES_USER` | `postgres` | PostgreSQL superuser username. Used only to bootstrap the database — the proxy does **not** connect as this role. |
| `AUTHENTICATOR_PASSWORD` | *(required in prod)* | Login password for the powerless `authenticator` role the proxy connects as (**not** the superuser) — see [SECURITY.md invariant 22]. The db image's `20-authenticator-login.sh` applies it at init; the proxy's `DATABASE_URL` uses it. Must be URL-safe. `bootstrap-env.sh` generates it; the production compose fails fast if it is unset. |
| `AUTHENTICATOR_ADMIN_PASSWORD` | *(required in prod)* | Login password for the separate `authenticator_admin` admin-plane role (member of `service_role`) — kept distinct from the data plane so a data-plane compromise cannot reach `service_role` (SECURITY.md invariant 24). The production compose fails fast if unset. Must be URL-safe. |
| `DATABASE_URL` | *(constructed)* | Full connection string, constructed by the compose file as `postgres://authenticator:$AUTHENTICATOR_PASSWORD@db:5432/$POSTGRES_DB`. The proxy connects as `authenticator` (NOSUPERUSER, NOINHERIT) and `SET ROLE`s per request, so a compromise cannot bypass RLS by default, run `COPY … FROM PROGRAM`, drop the database, or read `pg_authid`. Override only to point at an external PostgreSQL — keep the non-superuser role. |
| `ADMIN_DATABASE_URL` | *(constructed)* | Admin-plane connection string, `postgres://authenticator_admin:$AUTHENTICATOR_ADMIN_PASSWORD@db:5432/$POSTGRES_DB`. **Required in `PGSTACK_ENV=production`** — without it the admin pool falls back to the data DSN, which can't assume `service_role`. |

## Proxy variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LISTEN_ADDR` | `0.0.0.0:8080` | Address and port the proxy listens on. |
| `PROXY_PORT` | `8080` | Host port mapping (for `docker compose`). |
| `ENABLE_SQL_ENDPOINT` | `false` | Enable `/api/sql` endpoint for raw SQL (dev only). **Never enable in production.** |
| `ENABLE_DEMO_ENDPOINT` | `false` | Mount `POST /api/demo` (mutates demo tables). Off by default; even when off the route is still mounted if a service_role key is configured (and then requires that key). **Never enable on a public host.** |
| `PUBLIC_DIR` | *(empty — disabled)* | Directory for serving static files at the root path. When set, files in this directory are served with SPA fallback (unknown paths serve `index.html`). |
| `PUBLIC_ALLOW_INLINE_SCRIPTS` | `false` | Add `'unsafe-inline'` to the `script-src` of the Content-Security-Policy sent with `PUBLIC_DIR` responses. Needed for single-file static apps that use inline `<script>` blocks. Default is strict (`script-src 'self'`); prefer external script files in production. |
| `STUDIO_DIR` | `/studio` | Directory containing the Studio SPA build, served at `/studio/` with a relaxed CSP. Point at your own build when customizing the image. |
| `DOCS_DIR` | `/docs` | Directory containing the built documentation site (Docusaurus static output), served at `/docs/`. |
| `PGSTACK_ENV` | `production` | **Defaults to `production`** (unset/empty → production, fail-secure). In production, security misconfigurations — placeholder/dev secrets, short `ANON_KEY`/`SERVICE_ROLE_KEY`, `ENABLE_SQL_ENDPOINT=true`, permissive CORS, `REQUIRE_AUTHENTICATED_WS=false`, missing SMTP when `EMAIL_ENABLED=true` — are **fatal startup errors**, not warnings. Set `PGSTACK_ENV=development` to opt into the relaxed dev posture (the dev compose files do). |
| `PROXY_RUST_PORT` | `8081` | Host port for the **Rust proxy** — a co-equal sibling to the Go proxy, security-hardened to parity (same SECURITY.md invariants) — which the dev compose starts alongside the Go proxy (on `PROXY_PORT`). Either proxy can serve a deployment. |

## Auth variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ACCESS_TOKEN_EXPIRY_SECS` | `3600` | JWT access token lifetime (1 hour). |
| `REFRESH_TOKEN_EXPIRY_DAYS` | `30` | Refresh token lifetime (30 days). |
| `AUTH_RATE_LIMIT` | `30` | Auth endpoint rate limit (requests per window). |
| `AUTH_RATE_WINDOW` | `60` | Rate limit window in seconds. |
| `REQUIRE_EMAIL_VERIFICATION` | `false` | Block login for unverified emails. Requires SMTP to be configured. |
| `ALLOW_ANONYMOUS_SIGNIN` | `false` | Enable `POST /auth/v1/anonymous` (SDK `auth.signInAnonymously()`), which mints a short-lived `role=anon` JWT without creating a user row. Default-deny: when `false` the endpoint returns `503`. |
| `ANONYMOUS_JWT_TTL` | `3600` | Lifetime in seconds of anonymous JWTs. No refresh token is issued — clients must re-mint before expiry. |
| `ANONYMOUS_RATE_LIMIT` | `300` | Per-IP rate limit for `/auth/v1/anonymous` (requests per window). Defaults to `10 × AUTH_RATE_LIMIT`; uses a limiter separate from the other auth endpoints. |
| `ANONYMOUS_RATE_WINDOW` | `60` | Anonymous sign-in rate limit window in seconds. |

## OAuth variables (optional)

Set these to enable social login. Each provider is independent — configure only the ones you need.

### Google and GitHub

| Variable | Where to get it | Description |
|----------|----------------|-------------|
| `GOOGLE_CLIENT_ID` | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) | Google OAuth App client ID. |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console | Google OAuth App client secret. |
| `GITHUB_CLIENT_ID` | [GitHub Settings](https://github.com/settings/developers) | GitHub OAuth App client ID. |
| `GITHUB_CLIENT_SECRET` | GitHub Settings | GitHub OAuth App client secret. |

### Apple

| Variable | Where to get it | Description |
|----------|----------------|-------------|
| `APPLE_CLIENT_ID` | [Apple Developer](https://developer.apple.com/account/resources/identifiers/list/serviceId) | Services ID (reverse-domain, e.g. `com.example.auth`). |
| `APPLE_TEAM_ID` | Apple Developer account page (top-right) | 10-character Team ID. |
| `APPLE_KEY_ID` | Apple Developer > Keys | Key ID for the Sign in with Apple private key. |
| `APPLE_PRIVATE_KEY` | Apple Developer > Keys (download `.p8`) | ES256 private key contents. Used to generate the client secret JWT. |

### Microsoft

| Variable | Where to get it | Description |
|----------|----------------|-------------|
| `MICROSOFT_CLIENT_ID` | [Azure Portal](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps) > App registrations | Application (client) ID. |
| `MICROSOFT_CLIENT_SECRET` | Azure Portal > Certificates & secrets | Client secret value. |

### Generic OIDC

| Variable | Where to get it | Description |
|----------|----------------|-------------|
| `OIDC_CLIENT_ID` | Your OIDC provider dashboard | Client ID from any OpenID Connect provider. |
| `OIDC_CLIENT_SECRET` | Your OIDC provider dashboard | Client secret. |
| `OIDC_ISSUER_URL` | Your OIDC provider | Issuer URL (e.g. `https://auth.example.com`). Must serve `/.well-known/openid-configuration`. |

Redirect URI to register with OAuth providers: `https://your-app.example.com/auth/v1/callback`

## Email / SMTP variables

Email-based auth flows — email verification, password reset, magic link — need
SMTP to deliver. **In `PGSTACK_ENV=production`, SMTP is required by default**:
without it those flows would silently drop a token-bearing message (the proxy
refuses to boot rather than let that happen). For a deployment that uses no
email at all (e.g. OAuth-only), set `EMAIL_ENABLED=false` — production then boots
without SMTP, and the email routes (`POST /auth/v1/recover`, `/auth/v1/magiclink`)
return `503`. Do **not** drop `PGSTACK_ENV=production` to escape the SMTP check;
that also disables the dev-secret / SQL-endpoint / CORS / WS guards.

| Variable | Default | Description |
|----------|---------|-------------|
| `EMAIL_ENABLED` | `true` | Master switch for email-based flows. `false` → no SMTP required, email routes return 503. Incompatible with `REQUIRE_EMAIL_VERIFICATION=true`. |
| `SMTP_HOST` | — | SMTP server hostname (required in production unless `EMAIL_ENABLED=false`). Example: `smtp.sendgrid.net` |
| `SMTP_PORT` | `587` | SMTP port. Use `587` for STARTTLS, `465` for SSL, `25` for unencrypted. |
| `SMTP_USER` | — | SMTP authentication username. |
| `SMTP_PASS` | — | SMTP authentication password. |
| `SMTP_FROM` | `noreply@pgstack.local` | From address for all auth emails. |
| `ALLOW_INSECURE_SMTP` | `false` | Dev opt-out for the production TLS policy. Under `PGSTACK_ENV=production` the mailer refuses to send over an un-encrypted connection on **any** port (implicit TLS on 465, STARTTLS elsewhere) so AUTH credentials and reset/magic-link tokens never cross the wire in clear. Set `true` only for a trusted private-network relay. |

## CORS / Origin variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ALLOWED_ORIGINS` | *(empty)* | Comma-separated list of allowed CORS / WebSocket origins. For production set explicitly: `https://app.example.com,https://admin.example.com`. |
| `ALLOW_PERMISSIVE_CORS` | `false` | When `ALLOWED_ORIGINS` is empty AND this is `true`, the proxy reflects any `Origin` (or `*` when no Origin header is present) **without** `Access-Control-Allow-Credentials` — reflected Origin + credentials is the CSRF-amplifying combo the security audit removed, and Bearer/apikey header auth does not need it. Default is **strict**: no `Allow-Origin` header is emitted, cross-origin browsers are blocked, same-origin and non-browser clients still work. The proxy logs a loud WARN when this is enabled. **Never enable on a public host.** |

The strict default (since the 2026-05 security audit) prevents a CSRF/exfiltration footgun where any site could call your API with the user's credentials. Pre-audit deployments that relied on the permissive default must either set `ALLOWED_ORIGINS` or `ALLOW_PERMISSIVE_CORS=true` for dev.

## Reverse proxy variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TRUSTED_PROXIES` | *(empty)* | Comma-separated list of trusted reverse proxy IPs. When empty, `X-Forwarded-For` is ignored and rate limiting uses `RemoteAddr` directly. Set this when running behind a load balancer or reverse proxy (e.g., `10.0.0.1,172.17.0.1`). |

## Edge Functions variables

| Variable | Default | Description |
|----------|---------|-------------|
| `EDGE_RUNTIME_URL` | *(empty — disabled)* | URL of Supabase edge-runtime container. Example: `http://edge-runtime:9000`. Empty disables Deno backend. |
| `EMBEDDED_FUNCTIONS` | `true` | Enable embedded JS runtime (goja) for lightweight functions. |
| `EDGE_FN_TIMEOUT_MS` | `60000` | Per-invocation deadline (ms) applied to every edge function runtime (goja, plv8, plpython, Deno, http). |

## Batch transaction variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_BATCH_OPERATIONS` | `20` | Maximum operations per `POST /rest/v1/batch` request. |

## Realtime / WebSocket variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CONNECTIONS` | `10000` | Maximum concurrent WebSocket connections. Enforced as a semaphore on WebSocket upgrades; notifications are fanned out from a single dedicated PostgreSQL `LISTEN` connection, so WebSocket clients do not hold PG sessions. |
| `REQUIRE_AUTHENTICATED_WS` | `false` | When `true`, anon-key WS subscriptions are rejected — only real JWTs (`authenticated` or `service_role`) can open `/ws/{query_id}`. Closes the "public anon key + guessable query_id" read vector. Required under `PGSTACK_ENV=production`: the proxy refuses to start with `false` when JWT_SECRET and ANON_KEY are set, and `docker-compose.prod.yml` pins it to `true`. |
| `WS_MAX_PER_IP` | `10` | Maximum concurrent WebSocket connections per client IP (`0` disables the cap). Excess connections are rejected with `429` before the upgrade completes. Honours `TRUSTED_PROXIES` when resolving the client IP, like the auth rate limiter. Raise this when many users share a NAT or corporate proxy IP. |
| `BROADCAST_CAPACITY` | `1024` | Per-client buffered message capacity for NOTIFY fan-out. A client that falls further behind is disconnected rather than blocking the hub. |

## Connection / body size limits

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_BODY_SIZE` | `1048576` | Maximum request body size in bytes (default: 1 MB). |
| `MAX_FILE_SIZE` | `52428800` | Maximum storage upload size in bytes (default: 50 MB). |

## Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `STORAGE_BACKEND` | `database` | Storage backend for file uploads: `database` (bytea column) or `disk` (filesystem). |
| `STORAGE_DIR` | `/data/storage` | Filesystem path for uploaded files when `STORAGE_BACKEND=disk`. Mount as a Docker volume for persistence. |

## HTTP Server

| Variable | Default | Description |
|----------|---------|-------------|
| `READ_TIMEOUT` | `30` | HTTP read timeout in seconds |
| `WRITE_TIMEOUT` | `60` | HTTP write timeout in seconds |
| `IDLE_TIMEOUT` | `120` | HTTP keep-alive idle timeout in seconds |
| `SHUTDOWN_TIMEOUT` | `15` | Graceful shutdown deadline in seconds |
| `GZIP_LEVEL` | `5` | Gzip compression level (0=disabled, 1=fastest, 9=best) |

WebSocket connections may need longer `WRITE_TIMEOUT` values. The default 60s is sufficient for most use cases.

## Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Log verbosity: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `panic`. |
| `LOG_PRETTY` | *(unset)* | Set to `1` for human-readable console output instead of structured JSON. |

## PostgreSQL Connection Pool

| Variable | Default | Description |
|----------|---------|-------------|
| `PG_POOL_MAX_CONNS` | `50` | Maximum connections in the proxy's PG pool |
| `PG_POOL_MIN_CONNS` | `5` | Minimum idle connections kept warm |
| `PG_POOL_MAX_CONN_IDLE_TIME` | `300` | Seconds before an idle connection is closed |
| `PG_RECONNECT_MAX_BACKOFF` | `30` | Maximum backoff in seconds between reconnect attempts of the dedicated `LISTEN` connection |

This is the proxy's built-in pool. For advanced pooling (transaction mode, prepared statements), use PgBouncer in front of PostgreSQL.

## TLS / HTTPS

| Variable | Default | Description |
|----------|---------|-------------|
| `TLS_MODE` | `off` | TLS mode: `off` (use reverse proxy), `auto` (Let's Encrypt), `manual` (own certs) |
| `TLS_DOMAINS` | — | Comma-separated domains for auto mode (required when `TLS_MODE=auto`) |
| `TLS_CERT_DIR` | `/data/certs` | Directory to cache Let's Encrypt certificates |
| `TLS_ACME_EMAIL` | — | Email for Let's Encrypt expiry notifications (optional) |
| `TLS_CERT_FILE` | — | Path to TLS certificate (required when `TLS_MODE=manual`) |
| `TLS_KEY_FILE` | — | Path to TLS private key (required when `TLS_MODE=manual`) |
| `HTTPS_ADDR` | `:443` | Listen address for HTTPS (ignored when `TLS_MODE=off`) |
| `HTTP_ADDR` | `:80` | Listen address for ACME challenges + HTTP→HTTPS redirect |
| `HSTS_MAX_AGE_SECONDS` | `63072000` | `Strict-Transport-Security` max-age (2 years — the hstspreload.org minimum). Sent only on requests that demonstrably arrived over TLS: direct TLS, or `X-Forwarded-Proto: https` from a `TRUSTED_PROXIES` address. Lower it during initial TLS rollout to limit blast radius if TLS breaks. |
| `HSTS_PRELOAD` | `false` | Append `preload` to the HSTS header. Opt-in only: preload-list submission is effectively irreversible, so enable it only once you are committed to HTTPS-only. |

In `auto` mode the proxy handles Let's Encrypt certificate issuance and renewal automatically. Ports 80 and 443 must be publicly reachable. For most deployments behind a load balancer or CDN, use `TLS_MODE=off` with a reverse proxy (Caddy, nginx) handling TLS termination.

## PostgreSQL tuning (via docker-compose command flags)

These are set as PostgreSQL GUC parameters via the `command:` field in `docker-compose.prod.yml`, not as environment variables:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `pg_reactive.max_subscriptions` | `1024` | Maximum live query subscriptions (shared memory slots). Requires restart. |
| `max_connections` | `200` | PostgreSQL max client connections. |
| `shared_buffers` | `256MB` | PostgreSQL shared memory buffer. Set to 25% of RAM. |
| `effective_cache_size` | `768MB` | Estimated effective cache size. Set to 75% of RAM. |

Example in `docker-compose.prod.yml`:

```yaml
command: >
  postgres
    -c shared_preload_libraries=pg_reactive
    -c pg_reactive.max_subscriptions=4096
    -c max_connections=300
    -c shared_buffers=512MB
    -c effective_cache_size=1536MB
    -c log_min_messages=warning
    -c log_statement=none
```

## Environment variable precedence

1. Variables explicitly set in the shell environment
2. Variables in `.env` file (loaded by docker compose)
3. Default values in `docker-compose.yml`

## Security checklist

Before going to production:

- [ ] `POSTGRES_PASSWORD` is a strong random value (not the `.env.example` default)
- [ ] `JWT_SECRET` is a strong random value (32+ characters)
- [ ] `ANON_KEY` is a strong random value
- [ ] `SERVICE_ROLE_KEY` is a strong random value, treated like a database password
- [ ] `ENABLE_SQL_ENDPOINT` is `false` or unset
- [ ] `ENABLE_DEMO_ENDPOINT` is `false` or unset
- [ ] `ALLOWED_ORIGINS` is set to your specific domain(s); `ALLOW_PERMISSIVE_CORS` is `false` or unset
- [ ] `REQUIRE_AUTHENTICATED_WS` is `true` whenever realtime queries return user-scoped data
- [ ] `SITE_URL` is set to your production URL
- [ ] `.env` is in `.gitignore` (never committed)
- [ ] PostgreSQL port (`5432`) is not exposed to the internet
- [ ] `TRUSTED_PROXIES` is set if running behind a reverse proxy (prevents rate limit bypass via spoofed `X-Forwarded-For` headers)
- [ ] `JWT_SECRET` does not contain `dev-only` (the proxy warns on startup if it does, and refuses to start entirely when `PGSTACK_ENV=production`)
- [ ] `REQUIRE_EMAIL_VERIFICATION` is `true` if SMTP is configured
