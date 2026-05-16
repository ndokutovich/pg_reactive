# Contributing to pg_reactive / pgStack

Thanks for considering a contribution. This document covers the practical
mechanics — licensing, code style, tests, and how to get a PR merged.

## Licensing of contributions

This repository is dual-licensed:

| Directory                                 | License            | SPDX               |
|-------------------------------------------|--------------------|--------------------|
| `ext/`                                    | PostgreSQL License | `PostgreSQL`       |
| `proxy-go/`, `sdk/`, `studio/`, `cli/`, examples, docs, infra | Apache License 2.0 | `Apache-2.0` |

**By submitting a pull request you agree to license your contribution under
the license of the directory it lands in.** No CLA is required — this is a
straightforward "inbound = outbound" arrangement (DCO-style, no
ceremony). If your contribution spans both `ext/` and elsewhere, the parts
in each directory are licensed accordingly.

If you cannot agree to that, please open an issue describing your concern
before submitting code.

## Getting started

```bash
git clone https://github.com/ndokutovich/pg_reactive.git
cd pg_reactive
docker compose up -d --build
```

That brings up PostgreSQL with the extension installed, the Go proxy on
`127.0.0.1:8080`, and Studio at `127.0.0.1:8080/studio/`.

Read [`CLAUDE.md`](CLAUDE.md) — it documents day-to-day build, test, and
debug workflows in detail.

## Pull request checklist

Before opening a PR, please verify:

- [ ] The change is **minimal**. Don't refactor adjacent code unless the
      refactor is the point of the PR.
- [ ] Tests cover the new behavior. The test layer depends on the change:
  - C extension changes → add a `pg_regress` test under `ext/sql/` and
    update `ext/expected/` (regenerate from `ext/results/` inside the
    container — trailing whitespace matters).
  - Proxy changes → add a Go unit test (`go test ./proxy-go/...`) or an
    E2E script (`tests/e2e_*_test.mjs`).
  - SDK changes → add a vitest case under `sdk/src/*.test.ts`.
- [ ] No new lint warnings: `cd proxy-go && go vet ./...`,
      `cd sdk && npx tsc --noEmit`, `cd studio && npx tsc --noEmit`.
- [ ] **Commit messages use conventional format**: `feat:`, `fix:`,
      `docs:`, `refactor:`, `test:`, `chore:`, `perf:` — optionally with
      a scope (`fix(security): …`). The history is mined for release
      notes.
- [ ] **No emoji, no tool branding** in commit messages or code.
- [ ] **No `localhost`** in URLs — use `127.0.0.1`. Some browsers and
      Docker setups handle the two differently.
- [ ] If touching auth, RLS, secret storage, or any external HTTP — read
      [`SECURITY.md`](SECURITY.md) first. Security-sensitive changes get
      extra review.

## What kind of changes we accept

**Welcome**:

- Bug fixes with a reproducing test.
- Performance improvements with benchmark numbers.
- New examples under `examples/` (lessons or apps).
- Docs improvements — the Docusaurus site lives in `docs/site/`.
- New runtime support in `proxy-go/functions/` (we already have Deno,
  embedded goja, PL/v8, PL/Python, and `http`).
- Hardening: closing items in
  [`docs/SECURITY_AUDIT_2026-03-07.md`](docs/SECURITY_AUDIT_2026-03-07.md).

**Discuss first** (open an issue before writing the code):

- New SQL surface in the extension (new functions, GUCs, schema changes).
  These ship in extension `default_version` and we want to avoid churn.
- Breaking changes to wire formats (NOTIFY payload, WebSocket messages,
  REST shapes).
- New external dependencies in `proxy-go/go.mod` or `sdk/package.json`.

**Out of scope**:

- Rewrites of the C extension in another language.
- "I added support for $other_database" — this project is PostgreSQL-specific.

## Code style

- **C**: 4-space indent, K&R braces. `PG_CFLAGS = -Wall -Werror` is on —
  warnings will fail the build.
- **Go**: `gofmt` (run on save). No global state outside `main.go` and
  `state.go`. Prefer small constructor functions over package-level
  init.
- **TypeScript**: `npx tsc --noEmit` must pass. Avoid `any` — prefer
  `unknown` and narrow. No new ESLint disables without a reason.
- **SQL**: 2-space indent. Lowercase keywords (`select`, not `SELECT`)
  in migrations and tests; uppercase in extension internals where it
  matches PostgreSQL source style.
- **Comments**: explain *why*, not *what*. Don't restate what the code
  obviously does. Don't reference the current task, fix number, or
  reviewer in comments — those belong in the PR description.

## Review timeline

This is a small project. Expect a first response within a few days for
non-security PRs. Security reports get the timeline in
[`SECURITY.md`](SECURITY.md).

## Questions

Open a GitHub issue. For security, use the contact in
[`SECURITY.md`](SECURITY.md).
