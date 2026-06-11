#!/bin/sh
# nginx /docker-entrypoint.d hook: inject the deployment ANON_KEY into the
# served config.js at container start, replacing the dev placeholder.
#
# The frontend ships 'anon-key-12345' so it works against a local dev stack
# with no env. In production the backend is configured with a random ANON_KEY,
# and the page must present the SAME key or auth/REST/guest-mint all return
# 401. The deploy compose passes ANON_KEY into this container's environment;
# here we substitute it into config.js before nginx starts. Codex round-36 #8.
set -e
CONFIG=/usr/share/nginx/html/config.js
if [ -n "${ANON_KEY:-}" ] && [ -f "$CONFIG" ]; then
  # Escape sed-special chars in the replacement (& # \) so arbitrary key
  # values — base64 or otherwise — substitute literally.
  esc=$(printf '%s' "$ANON_KEY" | sed -e 's/[&#\\]/\\&/g')
  sed -i "s#anon-key-12345#${esc}#g" "$CONFIG"
  echo "config: injected ANON_KEY into config.js"
fi
