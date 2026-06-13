#!/usr/bin/env bash
# Make the proxy's login roles LOGIN-able with operator-provided passwords.
#
# Runs in /docker-entrypoint-initdb.d AFTER 01-init.sql, which creates the two
# NOLOGIN, NOINHERIT, NOSUPERUSER proxy roles (gemini audit P2 + finding 6):
#   authenticator        — data plane, member of anon + authenticated only
#   authenticator_admin  — admin plane, member of service_role
# The proxy connects as these and SET ROLEs per request, so it never holds
# privileges by default and can never run as the PostgreSQL superuser. Splitting
# them means a data-plane compromise cannot reach service_role.
#
# Each role stays NOLOGIN until its password env is set — fail-closed, never a
# silent fall-back to a known/baked-in secret. Roles are cluster-global, so the
# target database is irrelevant; we use POSTGRES_DB because it exists at init.
# initdb.d runs against the socket-only temp server BEFORE the real server
# accepts TCP, so passwords are set before any external connection is possible.
set -euo pipefail

# psql-side :'apw' substitution safely quotes/escapes the value — never string
# interpolation into the SQL text.
if [ -n "${AUTHENTICATOR_PASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -v apw="$AUTHENTICATOR_PASSWORD" <<'EOSQL'
ALTER ROLE authenticator LOGIN PASSWORD :'apw';
EOSQL
  echo "20-authenticator-login: authenticator (data plane) is now LOGIN-able."
else
  echo "20-authenticator-login: AUTHENTICATOR_PASSWORD unset — authenticator stays NOLOGIN (proxy data pool can't connect)."
fi

if [ -n "${AUTHENTICATOR_ADMIN_PASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -v apw="$AUTHENTICATOR_ADMIN_PASSWORD" <<'EOSQL'
ALTER ROLE authenticator_admin LOGIN PASSWORD :'apw';
EOSQL
  echo "20-authenticator-login: authenticator_admin (admin plane) is now LOGIN-able."
else
  echo "20-authenticator-login: AUTHENTICATOR_ADMIN_PASSWORD unset — authenticator_admin stays NOLOGIN (proxy admin pool can't connect)."
fi
