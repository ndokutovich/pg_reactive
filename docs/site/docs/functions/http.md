---
title: HTTP Runtime
sidebar_position: 5
description: Polyglot edge functions — a per-function container in any language, reverse-proxied to with the caller's identity.
---

# HTTP Runtime

The `http` runtime makes edge functions **polyglot**. A function is just a
container that serves HTTP — written in Go, Rust, Python, Bun, or anything
else — and the proxy reverse-proxies to it, injecting the caller's identity.

It is the same wire contract as the [Deno runtime](./deno.md), with one
difference: `deno` shares a single global `EDGE_RUNTIME_URL`, while `http`
carries a **per-function `upstream_url`** — so each function is its own
container, in its own language.

## The contract

A function container must implement:

| Route | Purpose |
|-------|---------|
| `POST /functions/v1/{name}` | the function logic |
| `GET /healthz` | container liveness for the healthcheck |

On every call, the proxy injects the caller's identity as headers — the
function trusts them (the proxy validated the JWT / anon key and stripped any
inbound spoofed copies):

| Header | Meaning |
|--------|---------|
| `X-Pgstack-Role` | `anon` \| `authenticated` \| `service_role` |
| `X-Pgstack-Sub` | the authenticated user's id (empty for `anon`) |
| `X-Pgstack-Claims` | the full JWT claims JSON, when present |

`verify_jwt = true` makes the proxy reject `anon` callers with `401` *before*
the request ever reaches your container.

## Setup

### 1. Write the container

Any language. A minimal Go reference lives in `examples/functions/hello-go/`
— stdlib only, ~80 lines, echoes the body and the identity headers.

### 2. Run it on the docker network

Add it as a service alongside `db` and `proxy`, with a healthcheck:

```yaml
my-fn:
  build:
    context: ./functions/my-fn
  healthcheck:
    test: ["CMD", "curl", "-fsS", "http://localhost:8000/healthz"]
    interval: 5s
    timeout: 3s
    retries: 5
```

### 3. Register it

```sql
INSERT INTO pgstack.edge_functions (name, runtime, verify_jwt, upstream_url)
VALUES ('my-fn', 'http', true, 'http://my-fn:8000');
```

The `pgstack_fn_changed` trigger fires `NOTIFY`, the proxy refreshes its
catalog and builds the reverse proxy — no restart. To update the upstream or
toggle `verify_jwt`, just `UPDATE` the row.

### 4. Invoke it

```bash
curl -X POST http://127.0.0.1:8080/functions/v1/my-fn \
  -H "Authorization: Bearer <your-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"hello": "world"}'
```

## Security: `upstream_url` constraints

`upstream_url` is operator-controlled, so the proxy treats it as a potential
SSRF vector and constrains it in depth:

- the DB `CHECK` constraint requires an `http(s)://` scheme;
- the proxy's catalog validator requires the host to be a **bare
  docker-network hostname** — no IP literals (which blocks loopback,
  link-local, and the cloud metadata endpoint `169.254.169.254`) and no
  dotted FQDNs (which keeps upstreams confined to sibling containers);
- a function whose `upstream_url` fails validation is **dropped from the
  catalog** on refresh — it returns `404`, never proxies anywhere;
- the proxy uses a bounded HTTP transport (dial + response-header timeouts)
  and a per-request deadline; an unreachable or slow upstream returns `502`.

If you genuinely need a function to call an external FQDN, do it *from inside
the function container* (outbound), not by pointing `upstream_url` at it.
