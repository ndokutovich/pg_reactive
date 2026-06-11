# Upgrade Plan: C-tier → A

Generated: 2026-03-07

> **STATUS 2026-06: COMPLETED PLAN.** Every gap below has shipped except one nicety: `config.go` — no masked effective-config startup log. Kept for historical reference; the ✅ markers below record what landed.

> Several C ratings were underestimates after reading the actual code.

## Re-evaluation

| File | Rated | Actual | Why wrong |
|---|---|---|---|
| `error.go` | C | **B** | SQLSTATE mapping + security-conscious sanitization is real work |
| `template.go` | C | **B** | Dot-path JSON navigation with array indexing is non-trivial |
| `cli/src/commands/dev.ts` | C | **B** | `status` command: Docker health, proxy check, migration diff, sub count |
| `tests/perf/p3_e2e_latency.mjs` | C | **B** | Multi-level load with percentiles, psql pipe, PASS/FAIL thresholds |

Real C files: `config.go`, `mailer.go`, `state.go`, `bench/`, `studio/`.
Plus underrated B files need specific gaps filled to reach A.

---

## `config.go` → A

### Gap 1 — Silent swallowing of invalid env values ✅ DONE (envBoolOrDefault warns to stderr, config.go:343)
`envBoolOrDefault` accepts `"yes"`, `"TRUE"`, `"on"` — all fall through to the
default silently. `REQUIRE_EMAIL_VERIFICATION=yes` disables email verification
with no warning.

### Gap 2 — Panic vs. structured validation ✅ DONE (Config.Validate() collects all errors, config.go:361; main.go aborts)
JWT length check uses `panic()`. Other invalid configs (SMTP enabled without
host, `MaxConnections < 1`) are never caught. Errors should be collected and
returned together.

**Fix:**
```go
func (c Config) Validate() []string {
    var errs []string
    if c.JWTSecret != "" && len(c.JWTSecret) < 32 {
        errs = append(errs, "JWT_SECRET must be ≥32 chars")
    }
    if c.RequireEmailVerification && c.SMTPHost == "" {
        errs = append(errs, "REQUIRE_EMAIL_VERIFICATION=true but SMTP not configured")
    }
    if c.MaxConnections < 1 {
        errs = append(errs, "MAX_CONNECTIONS must be ≥1")
    }
    if c.AccessTokenExpirySecs < 60 {
        errs = append(errs, "ACCESS_TOKEN_EXPIRY_SECS should be ≥60")
    }
    return errs
}
```

Call `Validate()` at startup in `main.go`, log all errors, then `os.Exit(1)`.
Also add a startup log line printing effective config with secrets masked.

---

## `mailer.go` → A

### Gap 1 — HTML templates scattered in callers ✅ DONE (templates live in mailer.go:17-31; gomail replaced by net/smtp in audit L7)
Callers construct raw HTML strings and pass them in. Verification email,
password reset, and magic link templates live in `auth/` handlers — changing
email branding means hunting through multiple files.

### Gap 2 — No retry ✅ DONE (sendWithRetry 3x with backoff, mailer.go:100)
`DialAndSend` fails instantly on transient SMTP errors. One retry with 2s delay
handles 90% of real-world SMTP failures.

### Gap 3 — No context propagation ✅ DONE (ctx on Send path, DialContext + conn deadline, cancellable backoff; mailer_test.go)
`Send()` can't be cancelled — a slow SMTP server blocks the handler goroutine
indefinitely.

**Fix:**
```go
// Named methods own the templates — callers just provide data
func (m *Mailer) SendEmailVerification(ctx context.Context, to, link string) error
func (m *Mailer) SendPasswordReset(ctx context.Context, to, link string) error
func (m *Mailer) SendMagicLink(ctx context.Context, to, link string) error

// Internal retry
func (m *Mailer) sendWithRetry(ctx context.Context, msg *gomail.Message) error {
    for attempt := range 3 {
        if err := m.dialer.DialAndSend(msg); err == nil { return nil }
        select {
        case <-ctx.Done(): return ctx.Err()
        case <-time.After(time.Duration(1<<attempt) * time.Second):
        }
    }
    return lastErr
}
```

Define templates as `text/template` strings at the top of `mailer.go`, not in callers.

---

## `state.go` → A ✅ DONE (Catalog field state.go:49, Health() :82, Close() :98 — pool-only, does not drain WSSemaphore)

### Gap 1 — No `Health()` method
`PGConnected` is an `atomic.Bool` but there's no aggregated health response.
The `/health` endpoint reads it manually in `main.go`.

### Gap 2 — No graceful `Close()`
Nothing coordinates shutdown: drain in-flight WebSocket connections, close pool,
stop listener. Logic is scattered or missing in `main.go`.

### Gap 3 — Catalog lives outside AppState
`rest.Catalog` is constructed in `main.go` and passed as a separate parameter
to handlers rather than being part of `AppState`.

**Fix:**
```go
type AppState struct {
    // ... existing fields ...
    Catalog *rest.Catalog  // add this
}

func (s *AppState) Health() map[string]string {
    active := s.Config.MaxConnections - len(s.WSSemaphore)
    return map[string]string{
        "db":             healthBool(s.PGConnected.Load()),
        "ws_active":      strconv.Itoa(active),
        "ws_max":         strconv.Itoa(s.Config.MaxConnections),
        "catalog_tables": strconv.Itoa(s.Catalog.TableCount()),
    }
}

func (s *AppState) Close() {
    s.Pool.Close()
    for range s.Config.MaxConnections { s.WSSemaphore <- struct{}{} }
}
```

---

## `error.go` → A *(already B — one gap from A)*

### Gap — 4 missing SQLSTATE codes ✅ DONE (23503→409, 23502/23514/22P02→400 in error.go:54-65)

| Code | Meaning | Current response | Correct response |
|---|---|---|---|
| `23503` | FK violation | 500 "internal database error" | 409 "foreign key constraint violation" |
| `23502` | NOT NULL violation | 500 "internal database error" | 400 "null value not allowed" |
| `23514` | CHECK constraint | 500 "internal database error" | 400 "value violates check constraint" |
| `22P02` | Invalid input syntax | 500 "internal database error" | 400 "invalid input value" |

A user DELETEing a parent row with children gets "internal database error"
instead of "foreign key constraint violation". That's a UX cliff.

**Fix:** Add those 4 cases to the `pgErrorStatus` switch. Also extract
`pgError.Detail()` into the structured log (not the response) so you can
debug which constraint fired.

---

## `template.go` → A *(already B — two gaps from A)*

### Gap 1 — Error stops at first miss ✅ DONE (ResolveTemplates accumulates all errors, template.go:27)
`resolveErr` is set on first failure and subsequent `{{refs}}` are left as-is.
For a batch request with 5 broken references, you get one error, fix it, get
another. All resolution errors should be returned together.

### Gap 2 — No wildcard path ✅ DONE (navigatePath handles `*`, template.go:123)
`{{op1.*.name}}` — collect a field from all elements of an array result — is
the missing case that makes template resolution feel complete. Without it,
callers must do their own post-processing for one-to-many results.

**Fix:** Return `[]error` instead of stopping early. Add `*` segment handling
in `navigatePath` that maps over arrays.

---

## `bench/` → A

### Current state
6 Python/JS benchmark scripts with multi-level load and `runner.sh`. Real work.
But output is ephemeral stdout with no history.

### Gap — No baseline tracking ✅ DONE (results.jsonl in runner.sh:115, tests/perf/compare.sh, p7_concurrent_subscribe.mjs)
Results print to stdout and disappear. No way to know if a refactor regressed
P3 latency by 20%.

**Fix — `results.jsonl`:**
`runner.sh` appends a JSON line after each run:
```json
{"date":"2026-03-07","commit":"a3ddbc7","p1_tps":222,"p3_p50_ms":3.1,"p4_miss_200":0}
```
Add `bench/compare.sh <commit1> <commit2>` that reads `results.jsonl` and
prints a regression diff table.

**Fix — `p7_concurrent_subscribe.mjs`:**
Stress test subscribe/unsubscribe churn: create 50 subscriptions, fire
simultaneous inserts, unsubscribe half while inserts land. This is exactly
the race condition `hub.go` just fixed — a perf test that exercises it prevents
regression.

---

## `studio/src/` → A

The page list (`SqlEditorPage`, `TableEditorPage`, `RealtimePage`,
`AuthUsersPage`, `LogsPage`) shows the bones are there. Studio is the
first-impression component — what demo viewers open first.

### Gap 1 — SQL editor lacks execution plan view ✅ DONE (Explain button: EXPLAIN ANALYZE+BUFFERS for SELECT/WITH, plain EXPLAIN otherwise)
`SqlEditorPage.tsx` probably runs `SELECT` and shows results. `EXPLAIN ANALYZE`
output formatted as a tree makes it genuinely useful for debugging slow queries.

### Gap 2 — Realtime page ✅ MOSTLY DONE (per-sub rate + 20-sample sparkline in SubscriptionTable.tsx; seq-gap/overflow not surfaced)
If it just prints messages, it misses: seq gap detection, message rate, overflow
count. A sparkline of delta frequency per subscription would be A-level UX.

### Gap 3 — Table editor filter UI ✅ DONE (FilterBar.tsx, per-column filters via table store)
An inline filter row (PostgREST-style `column=value`) that generates the REST
query closes the loop between the REST API and the UI.

Read `TableEditorPage.tsx` and `RealtimePage.tsx` to confirm. If those gaps
exist, filling them is a weekend of React work.

---

## Priority order

| File | Effort | Impact | Notes |
|---|---|---|---|
| `error.go` | 30 min | **High** — stops 500s on FK/null violations | Already B, gap is tiny |
| `config.go` | 2h | Medium — better operator UX at startup | `Validate()` + startup log |
| `state.go` | 2h | Medium — health endpoint, clean shutdown | `Health()` + `Close()` + Catalog |
| `mailer.go` | 3h | Medium — email branding centralized | Templates + retry + context |
| `template.go` | 2h | Low-medium — batch DX improvement | Multi-error + wildcard |
| `bench/` | 3h | **High** for long-term quality | `results.jsonl` + compare + p7 |
| `studio/` | 1-2 days | **High** — first-impression component | EXPLAIN, sparklines, filter UI |

**Start with `error.go`** — 30 minutes, highest immediate user-facing impact.
