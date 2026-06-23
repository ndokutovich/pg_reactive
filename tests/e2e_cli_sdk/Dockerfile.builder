# Clean room for the dogfood test: node:22 has a global WebSocket (no ws polyfill),
# which is exactly what the browser-first @pgstack/sdk expects. The build context
# is tests/e2e_cli_sdk/ — app/ + entrypoint.sh, plus _artifacts/*.tgz in local mode.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY . /work
ENTRYPOINT ["bash", "/work/entrypoint.sh"]
