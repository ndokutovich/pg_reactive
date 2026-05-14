# Polyglot edge functions (`runtime="http"`)

The `http` runtime makes pgStack edge functions **polyglot**: a function is
just a container that speaks HTTP, written in any language. The proxy
reverse-proxies to it and injects the caller's identity — no shared runtime,
no Deno requirement.

## How it works

1. The function is a container on the docker network listening on some port.
2. It is registered in `pgstack.edge_functions` with `runtime='http'` and an
   `upstream_url` pointing at it (a bare docker-network hostname).
3. A call to `POST /functions/v1/{name}` on the proxy is reverse-proxied to
   `{upstream_url}/functions/v1/{name}`.
4. The proxy injects the caller's identity as headers — the function trusts
   them (the proxy validated the JWT / anon key and stripped any inbound
   spoofed copies):

   | Header             | Meaning                                            |
   |--------------------|----------------------------------------------------|
   | `X-Pgstack-Role`   | `anon` \| `authenticated` \| `service_role`        |
   | `X-Pgstack-Sub`    | the authenticated user's id (empty for `anon`)     |
   | `X-Pgstack-Claims` | the full JWT claims JSON (when present)             |

5. `verify_jwt=true` on the row makes the proxy reject `anon` callers with
   401 *before* it ever reaches the container.

This is the same wire contract as the `deno` runtime — the difference is only
that `http` carries a **per-function** `upstream_url` instead of one global
`EDGE_RUNTIME_URL`, so each function is its own container.

## The contract a function must implement

- `POST /functions/v1/{name}` — the function logic. Read the body, read the
  `X-Pgstack-*` headers for identity, return JSON.
- `GET /healthz` — a cheap liveness endpoint for the container healthcheck.

## Reference: `hello-go/`

A minimal Go function — **stdlib only, zero dependencies** — that echoes the
request body and the identity headers it received. See `hello-go/main.go`.
The same ~80 lines would be a handful of lines in Python/Bun/Rust; the point
is that the boundary is HTTP.

## Adding your own function

1. Write a container that implements the contract above (any language).
2. Add it as a service in `examples/docker-compose.yml` on the same network
   as `db` and `proxy`, with a healthcheck.
3. Register it — add an `INSERT … ON CONFLICT DO UPDATE` to a `setup.sql`
   (see `setup.sql` here), or `INSERT` directly:

   ```sql
   INSERT INTO pgstack.edge_functions (name, runtime, verify_jwt, upstream_url)
   VALUES ('my-fn', 'http', true, 'http://my-fn:8000');
   ```

   The `pgstack_fn_changed` trigger fires `NOTIFY`, the proxy refreshes its
   catalog, and the function is live — no proxy restart.

## Security: `upstream_url` is constrained

To keep `upstream_url` from becoming an SSRF vector, the proxy enforces:

- the DB `CHECK` constraint requires an `http(s)://` scheme;
- the proxy's catalog validator requires the host to be a **bare
  docker-network hostname** — no IP literals (blocks loopback, link-local,
  and the cloud metadata endpoint) and no dotted FQDNs (keeps upstreams
  confined to sibling containers);
- a function whose `upstream_url` fails validation is **dropped from the
  catalog** — it 404s rather than ever proxying anywhere.
