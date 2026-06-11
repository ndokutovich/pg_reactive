FROM nginx:alpine
WORKDIR /usr/share/nginx/html
COPY index.html ./
COPY config.js  ./
COPY favicon.svg ./
# Runtime ANON_KEY injection: replaces the dev placeholder in config.js with
# the deployment's ANON_KEY (passed as an env var) before nginx starts.
COPY inject-anon-key.sh /docker-entrypoint.d/40-inject-anon-key.sh
RUN chmod +x /docker-entrypoint.d/40-inject-anon-key.sh
