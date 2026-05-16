# Security Policy

## Supported Versions

This project is on pre-1.0. Security fixes land on `master` and are released in
the next tagged version. We do not yet maintain backports — please upgrade to
the latest release.

| Component        | Versioning                                        |
|------------------|---------------------------------------------------|
| C extension      | Tracked in `ext/pg_reactive.control` (`default_version`) |
| Go proxy         | Tracked by git tag on the monorepo                |
| TypeScript SDK   | `sdk/package.json` (semver, published separately) |
| CLI              | `cli/package.json` (semver, published separately) |

## Reporting a Vulnerability

**Do not** open a public GitHub issue for security reports.

Email: **ndokutovich@gmail.com** with subject prefix `[pg_reactive security]`.

If you prefer encrypted communication, include a PGP key request in your
initial message and we will respond with a key fingerprint.

Please include:

- Affected component (`ext/`, `proxy-go/`, `sdk/`, `studio/`, `cli/`)
- Affected version or commit SHA
- A minimal reproduction (proof-of-concept code, request, or steps)
- Your assessment of impact (data exposure, RCE, auth bypass, DoS, etc.)
- Whether the issue is being actively exploited

### What to expect

- **Acknowledgement** within 72 hours.
- **Initial triage** within 7 days — confirming the issue, severity rating, and
  expected timeline.
- **Fix and disclosure** coordinated with the reporter. We aim for ≤ 30 days for
  high-severity issues and ≤ 90 days for medium/low. Critical issues may
  ship out-of-band.

We will credit reporters in release notes unless you ask to remain anonymous.

## Scope

In scope:

- The C extension (`ext/`) — SQL injection, RLS bypass, shared-memory safety,
  privilege escalation through `pgr.subscribe()` / `pgr.unsubscribe()`.
- The Go proxy (`proxy-go/`) — auth flows (JWT, OAuth, refresh tokens),
  PostgREST-compatible REST, RLS context handling, WebSocket auth and
  audience enforcement, edge function sandboxing, webhook delivery (SSRF),
  rate limiting, CORS / CSP / HSTS.
- The TypeScript SDK (`sdk/`) — token storage (sessionStorage discipline),
  XSS surface, realtime channel validation.
- The Studio UI (`studio/`) — XSS, CSRF, privilege checks.
- Infrastructure (`docker-compose.prod.yml`, deploy workflows) — secret
  handling, exposed ports, supply chain.

Out of scope:

- Issues that require physical access to the host or PostgreSQL superuser
  credentials.
- Self-XSS that requires the victim to paste malicious code into a console.
- Vulnerabilities in dependencies that are already disclosed upstream and have
  no exploitable surface in this codebase — please report those upstream.
- Best-practice deviations without a demonstrable exploit (e.g. "you should add
  HTTP header X"). Open a regular GitHub issue instead.

## Security Posture

See [`docs/SECURITY_AUDIT_2026-03-07.md`](docs/SECURITY_AUDIT_2026-03-07.md)
for the latest static-analysis audit and remediation status. All Critical,
High, and Medium findings have been resolved as of the round-7/round-8
hardening pass.

### Required production configuration

The proxy will refuse to start in `PGSTACK_ENV=production` mode without:

- Real secrets (`JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`,
  `POSTGRES_PASSWORD`, `SECRETS_ENCRYPTION_KEY`) — minimum 32 bytes each.
  Generate via `openssl rand -base64 32`.
- `SECRETS_ENCRYPTION_KEY` set if you intend to use edge function environment
  variables or webhook signing secrets — both are stored AES-256-GCM-encrypted
  at rest.
- `ENABLE_SQL_ENDPOINT=true` is gated to require `service_role` keys even when
  enabled. Leave it `false` unless you have a clear need.
- `ALLOW_PERMISSIVE_CORS=false` (default in production).
- `TRUSTED_PROXIES` configured if you sit behind a reverse proxy; otherwise
  `X-Forwarded-For` is ignored to prevent rate-limit bypass.

See `examples/docker-compose.prod.yml` for the canonical production overlay.
