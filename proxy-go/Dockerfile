# Build context must be the repository root (context: .).
# This is consistent with proxy/Dockerfile.

# ── Stage 1: Build Studio SPA ──────────────────────────────────────────────────
FROM node:20-bookworm-slim AS studio-builder
WORKDIR /studio-build
COPY studio/package.json studio/package-lock.json ./
RUN npm ci --prefer-offline
COPY studio/ .
RUN npm run build

# ── Stage 2: Build Docusaurus docs ────────────────────────────────────────────
FROM node:20-bookworm-slim AS docs-builder
ARG DOCS_BASE_URL=/docs/
WORKDIR /docs-build
COPY docs/site/package.json docs/site/package-lock.json ./
RUN npm ci --prefer-offline
COPY docs/site/ .
ENV DOCS_URL=http://localhost:8080 DOCS_BASE_URL=${DOCS_BASE_URL}
RUN npm run build

# ── Stage 3: Build Go proxy ────────────────────────────────────────────────────
FROM golang:1.23-bookworm AS builder
WORKDIR /app

# Download dependencies first (layer-cached separately from source).
COPY proxy-go/go.mod proxy-go/go.sum ./
RUN go mod download

# Copy source and build a fully static binary.
COPY proxy-go/ .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o pgstack-proxy-go .

# ── Stage 3: Runtime image ────────────────────────────────────────────────────
FROM debian:bookworm-slim
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
