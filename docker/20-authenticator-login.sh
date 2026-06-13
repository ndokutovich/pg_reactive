#!/usr/bin/env bash
# Make the `authenticator` role LOGIN-able with the operator-provided password.
#
# Runs in /docker-entrypoint-initdb.d AFTER 01-init.sql, which creates
# `authenticator` NOLOGIN (member of anon/authenticated/service_role, NOINHERIT,
# NOSUPERUSER). The proxy connects as this role and SET ROLEs per request, so it
# never holds privileges by default and can never run as the PostgreSQL
# superuser (gemini audit P2).
#
# When AUTHENTICATOR_PASSWORD is unset the role stays NOLOGIN and the proxy fails
# to connect — fail-closed, never a silent fall-back to a known/baked-in secret.
#
# Roles are cluster-global, so the target database is irrelevant; we use
# POSTGRES_DB because it is guaranteed to exist at init time. initdb.d scripts
# run against the socket-only temp server BEFORE the real server accepts TCP, so
# the password is set before any external (proxy) connection is possible — there
# is no window in which authenticator is reachable without it.
set -euo pipefail

if [ -z "${AUTHENTICATOR_PASSWORD:-}" ]; then
  echo "20-authenticator-login: AUTHENTICATOR_PASSWORD unset — leaving authenticator NOLOGIN (proxy must connect with a non-superuser DSN that has a password)."
  exit 0
fi

# psql-side :'apw' substitution safely quotes/escapes the value — never string
# interpolation into the SQL text.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v apw="$AUTHENTICATOR_PASSWORD" <<'EOSQL'
ALTER ROLE authenticator LOGIN PASSWORD :'apw';
EOSQL

echo "20-authenticator-login: authenticator is now LOGIN-able (password from AUTHENTICATOR_PASSWORD)."
