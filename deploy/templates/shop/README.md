# Personal "What to Buy" shop deployment template

Drop-in template for running the shopping-cart app under your umbrella nginx
on its own subdomain (e.g. `shop.example.com`). Three containers, one network,
one umbrella conf — and you swap frontend frameworks by editing a single env
variable.

## What's in this directory

| File                                | Role |
|-------------------------------------|------|
| `docker-compose.yml`                | `pgstack` + one-shot migration + frontend + Inbucket |
| `.env.example`                      | Required secrets (regenerate yours, never reuse the example) |
| `migration.sql`                     | Schema + RLS + SECURITY DEFINER functions, applied once at first up |
| `umbrella/app-shop.conf.template`   | nginx server block — edit `server_name`, copy to umbrella conf.d |

`migration.sql` is a bundled copy of `apps/shopping/shared/migration.sql` from
the repo. Keep them in sync if you patch one — there is an intentional CI
parity check that flags drift (`scripts/sync-shop-migration.mjs` if/when added).

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

# 4. Wire the umbrella subdomain
sudo cp umbrella/app-shop.conf.template /opt/proxy/nginx/conf.d/app-shop.conf
sudo sed -i 's|shop.example.com|YOUR_SUBDOMAIN.your.tld|' /opt/proxy/nginx/conf.d/app-shop.conf
docker exec umbrella-proxy nginx -t \
  && docker exec umbrella-proxy nginx -s reload

# 5. Verify
curl -sI -X POST https://YOUR_SUBDOMAIN.your.tld/auth/v1/anonymous \
  -H 'apikey: '"$(grep '^ANON_KEY=' .env | cut -d= -f2)" | head -3
# Expect: 503 (ALLOW_ANONYMOUS_SIGNIN=false in this template — auto-signup
# with a generated email is used instead; flip the flag in .env if you want
# guest-JWT minting for short sessions).
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
`/auth/v1/*` and `/ws/items-{listId}-{uid}` — fully interchangeable, no rebuild
of the pgstack stack needed when you switch.

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
