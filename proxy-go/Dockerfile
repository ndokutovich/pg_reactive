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
RUN npm ci --prefer-offline --no-audit --fetch-retries=6 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=180000 --fetch-timeout=600000
COPY studio/ .
RUN npm run build

# ── Stage 2: Build Docusaurus docs ────────────────────────────────────────────
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS docs-builder
ARG DOCS_BASE_URL=/docs/
WORKDIR /docs-build
COPY docs/site/package.json docs/site/package-lock.json ./
RUN npm ci --prefer-offline --no-audit --fetch-retries=6 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=180000 --fetch-timeout=600000
COPY docs/site/ .
ENV DOCS_URL=http://localhost:8080 DOCS_BASE_URL=${DOCS_BASE_URL}
RUN npm run build

# ── Stage 3: Build Go proxy ────────────────────────────────────────────────────
FROM golang:1.25.11-bookworm@sha256:60cdd53a9656379b55681e2832cbf29ca1bffca1e6e8263b41d3b50aca826191 AS builder
WORKDIR /app
ENV GOTOOLCHAIN=auto

# Download dependencies first (layer-cached separately from source).
COPY proxy-go/go.mod proxy-go/go.sum ./
RUN go mod download

# Copy source and build a fully static binary.
COPY proxy-go/ .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o pgstack-proxy-go .

# ── Stage 3: Runtime image ────────────────────────────────────────────────────
FROM debian:bookworm-slim@sha256:67b30a61dc87758f0caf819646104f29ecbda97d920aaf5edc834128ac8493d3
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --no-log-init --shell /bin/false appuser

COPY --from=builder /app/pgstack-proxy-go /usr/local/bin/pgstack-proxy
COPY --from=studio-builder /studio-build/dist /studio
COPY --from=docs-builder /docs-build/build /docs

ENV STUDIO_DIR=/studio
ENV DOCS_DIR=/docs
EXPOSE 8080

USER appuser
CMD ["pgstack-proxy"]
