# Personal "What to Buy" shop deployment template

Drop-in template for running the shopping-cart app under your umbrella nginx
on its own subdomain (e.g. `shop.example.com`). Four containers, two networks
(private + shared gateway), one umbrella conf — and you swap frontend
frameworks by editing a single env variable.

## What's in this directory

| File                                | Role |
|-------------------------------------|------|
| `docker-compose.yml`                | `pgstack` + one-shot migration + frontend + Inbucket |
| `.env.example`                      | Required secrets (regenerate yours, never reuse the example) |
| `migration.sql`                     | Schema + RLS + SECURITY DEFINER functions, applied once at first up |

The umbrella nginx route for `shop.pgstack.org` is owned by the
**your reverse-proxy** repo (`nginx/conf.d/app-shop.conf` there), not
this one. A different subdomain = PR against that repo or hand-edit
the conf there before reload.

`migration.sql` is a bundled copy of `apps/shopping/shared/migration.sql` from
the repo. Keep them in sync manually if you patch one — there is currently no
automated parity check (a `scripts/sync-shop-migration.mjs` + CI step, mirroring
`scripts/sync-cli-bootstrap.mjs`, would be the right shape).

## First-time setup on a VPS

```bash
# 1. Copy the template
sudo mkdir -p /opt/apps/shop
sudo chown "$USER":"$USER" /opt/apps/shop
cp -r deploy/templates/shop/. /opt/apps/shop/
cd /opt/apps/shop

# 2. Generate secrets and edit the env
cp .env.example .env
for k in POSTGRES_PASSWORD JWT_SECRET ANON_KEY SERVICE_ROLE_KEY SECRETS_ENCRYPTION_KEY; do
  v=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)
  sed -i "s|^$k=$|$k=$v|" .env
done
# Then open .env in an editor and set SITE_URL to your subdomain.

# 3. Bring the stack up
docker network create gateway 2>/dev/null || true
docker compose up -d

# 4. Umbrella nginx route already lives in your reverse-proxy repo
#    at nginx/conf.d/app-shop.conf (server_name shop.pgstack.org).
#    On the VPS:
cd /opt/proxy && git pull
docker exec umbrella-proxy nginx -t \
  && docker exec umbrella-proxy nginx -s reload
# If you need a different subdomain — edit that file in the umbrella
# repo before pulling.

# 5. Verify
curl -sI -X POST https://YOUR_SUBDOMAIN.your.tld/auth/v1/anonymous \
  -H 'apikey: '"$(grep '^ANON_KEY=' .env | cut -d= -f2)" | head -3
# Expect: 503 (ALLOW_ANONYMOUS_SIGNIN=false in this template — users sign up /
# log in with email+password via the in-app form instead; flip the flag in .env
# if you want guest-JWT minting for short sessions).
```

## Swapping frontends

```bash
# Edit .env and change FRONTEND_IMAGE, then:
docker compose up -d shopping
```

Available variants — same wire contract, different framework:

| Variant   | Image                            |
|-----------|----------------------------------|
| Vanilla   | `pgstack/shopping-vanilla:latest`|
| React     | `pgstack/shopping-react:latest`  |
| Vue       | `pgstack/shopping-vue:latest`    |
| Svelte    | `pgstack/shopping-svelte:latest` |
| Angular   | `pgstack/shopping-angular:latest`|

All five hit `/rest/v1/shopping_items`, `/rest/v1/rpc/{create,join,my}_shopping_*`,
`/rest/v1/rpc/subscribe_list_items`, `/auth/v1/*` and
`/ws/items-{listId}-{uidNoDashes}` (uid = JWT sub with dashes stripped) — fully
interchangeable, no rebuild of the pgstack stack needed when you switch.

## Discipline preserved

This template ships with `PGSTACK_ENV=production`, `REQUIRE_AUTHENTICATED_WS=true`,
`ENABLE_SQL_ENDPOINT=false`, `ENABLE_DEMO_ENDPOINT=false`, `ALLOW_ANONYMOUS_SIGNIN=false`.
The migration's SECURITY DEFINER functions pin `search_path = pg_catalog, pg_temp`,
fully qualify every reference, and bind per-user audience on `pgr.subscribe` —
the round 26/28/33 hardening is on by default. Loosen any one of these only
when you know exactly why.

## Phone install (PWA)

`shared/manifest.json` + `shared/sw.js` are bundled in every variant image, so
once the subdomain is live and HTTPS reaches it, Safari/Chrome on phone will
offer "Add to Home Screen" with the icon under `shared/icon-512.png`. No
extra wiring required.
