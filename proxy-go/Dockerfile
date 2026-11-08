# Build context must be the repository root (context: .).
# This is consistent with proxy/Dockerfile.
#
# Base images are pinned by SHA256 digest so a compromised or replaced tag
# upstream cannot silently change what we build (supply-chain hardening,
# L6). To refresh:
#
#   IMG=node:20-bookworm-slim
#   TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/${IMG%%:*}:pull" | jq -r .token)
#   curl -sI -H "Authorization: Bearer $TOKEN" \
#        -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json" \
#        "https://registry-1.docker.io/v2/library/${IMG%%:*}/manifests/${IMG##*:}" \
#     | tr -d '\r' | grep -i 'docker-content-digest:'

# ── Stage 1: Build Studio SPA ──────────────────────────────────────────────────
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS studio-builder
WORKDIR /studio-build
COPY studio/package.json studio/package-lock.json ./
# Shared npm cache (same id as proxy/Dockerfile) so the warm download cache survives
# across builds on the persistent buildx builder — --prefer-offline then serves the
# packages without hitting the registry, which is what kept flaking the candidate.
RUN --mount=type=cache,target=/root/.npm,id=npm-studio \
    npm ci --prefer-offline --no-audit --fetch-retries=6 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=180000 --fetch-timeout=600000
COPY studio/ .
RUN npm run build

# ── Stage 2: Build Docusaurus docs ────────────────────────────────────────────
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS docs-builder
ARG DOCS_BASE_URL=/docs/
WORKDIR /docs-build
COPY docs/site/package.json docs/site/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,id=npm-docs \
    npm ci --prefer-offline --no-audit --fetch-retries=6 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=180000 --fetch-timeout=600000
COPY docs/site/ .
ENV DOCS_URL=http://localhost:8080 DOCS_BASE_URL=${DOCS_BASE_URL}
RUN npm run build

# ── Stage 3: Build Go proxy ────────────────────────────────────────────────────
FROM golang:1.26.10-bookworm@sha256:5de7c99eb78ca5e515a4c340235d0955ec5964a5071c492c15503d7c267da473 AS builder
WORKDIR /app
ENV GOTOOLCHAIN=auto

# Download dependencies first (layer-cached separately from source).
ARG TARGETARCH
COPY proxy-go/go.mod proxy-go/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod,id=go-mod \
    go mod download

# Copy source and build a fully static binary. The Go module + build caches persist
# across builds on the kept buildx builder (build cache is per-arch).
COPY proxy-go/ .
RUN --mount=type=cache,target=/go/pkg/mod,id=go-mod \
    --mount=type=cache,target=/root/.cache/go-build,id=go-build-${TARGETARCH} \
    CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o pgstack-proxy-go .

# ── Stage 3: Runtime image ────────────────────────────────────────────────────
FROM debian:bookworm-slim@sha256:67b30a61dc87758f0caf819646104f29ecbda97d920aaf5edc834128ac8493d3
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --no-log-init --shell /bin/false appuser

COPY --from=builder /app/pgstack-proxy-go /usr/local/bin/pgstack-proxy
COPY --from=studio-builder /studio-build/dist /studio
COPY --from=docs-builder /docs-build/build /docs
# The pgStack marketing landing (public/index.html — the canonical pgstack.org
# apex source). Inert unless PUBLIC_DIR=/public is set: the general image leaves
# it unset so downstream `pgstack init` users serve their own SPA; only the
# pgstack.org apex deployment opts in (examples/docker-compose.prod.yml).
COPY public/ /public
# The live example pages (examples/NN/app.html + the shared config.js/demo-panel.js)
# served under /examples/* on the pgstack.org apex. config.js derives the WS base
# from location.host, so they talk to whatever host serves them. Inert unless
# PUBLIC_DIR is set. ~0.5MB of static HTML/JS/SQL — no node_modules.
COPY examples/ /public/examples

ENV STUDIO_DIR=/studio
ENV DOCS_DIR=/docs
EXPOSE 8080

USER appuser
CMD ["pgstack-proxy"]
