# Static shopping-cart image. VARIANT is one of: vanilla, react, vue,
# svelte, angular — each loads its framework from a CDN, no build step.
#
# Build context = apps/shopping/:
#   docker build --build-arg VARIANT=vanilla -t pgstack/shopping-vanilla:dev apps/shopping/
#   docker build --build-arg VARIANT=react   -t pgstack/shopping-react:dev   apps/shopping/
#   docker build --build-arg VARIANT=vue     -t pgstack/shopping-vue:dev     apps/shopping/
#   docker build --build-arg VARIANT=svelte  -t pgstack/shopping-svelte:dev  apps/shopping/
#   docker build --build-arg VARIANT=angular -t pgstack/shopping-angular:dev apps/shopping/
#
# At runtime the page reads PGR.apiBase / PGR.wsBase from a config.js
# auto-detected from `location.origin` — see apps/shopping/shared/config.js.
# Nothing about the frontend's backend address is compiled in, so the
# same image works on shop.localhost as on shop.pgstack.org without a
# rebuild.

FROM nginx:alpine
ARG VARIANT=vanilla
RUN test -n "${VARIANT}"

WORKDIR /usr/share/nginx/html

# Runtime ANON_KEY injection: replaces the dev placeholder in config.js with
# the deployment's ANON_KEY (passed as an env var) before nginx starts.
COPY shared/inject-anon-key.sh /docker-entrypoint.d/40-inject-anon-key.sh
RUN chmod +x /docker-entrypoint.d/40-inject-anon-key.sh

# Shared assets first (config + PWA manifest + service worker + icons).
COPY shared/config.js     ./config.js
COPY shared/manifest.json ./manifest.json
COPY shared/sw.js         ./sw.js
COPY shared/icon.svg      ./icon.svg
COPY shared/icon-192.png  ./icon-192.png
COPY shared/icon-512.png  ./icon-512.png

# Variant's index.html on top — picks one of vanilla/react/vue/svelte/angular.
COPY ${VARIANT}/index.html ./index.html
