# Base images are digest-pinned for supply-chain parity with the Go proxy
# (proxy-go/Dockerfile): the Rust proxy ships as a co-equal released artifact, so
# its bases must be immutable too. node + debian reuse the Go proxy's verified
# digests (same tags). Re-pin together when bumping a tag.

# Stage 1: Build studio SPA
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS studio-builder
WORKDIR /studio-build
COPY studio/package.json studio/package-lock.json ./
RUN npm ci --prefer-offline --no-audit --fetch-retries=6 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=180000 --fetch-timeout=600000
COPY studio/ .
RUN npm run build

# Stage 2: Build Docusaurus docs (mirror of proxy-go/Dockerfile's docs-builder)
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS docs-builder
ARG DOCS_BASE_URL=/docs/
WORKDIR /docs-build
COPY docs/site/package.json docs/site/package-lock.json ./
RUN npm ci --prefer-offline --no-audit --fetch-retries=6 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=180000 --fetch-timeout=600000
COPY docs/site/ .
ENV DOCS_URL=http://localhost:8080 DOCS_BASE_URL=${DOCS_BASE_URL}
RUN npm run build

# Stage 3: Build Rust proxy
FROM rust:1.88-bookworm@sha256:af306cfa71d987911a781c37b59d7d67d934f49684058f96cf72079c3626bfe0 AS builder
WORKDIR /app
COPY proxy/Cargo.toml proxy/Cargo.lock ./
COPY proxy/src/ src/
RUN cargo build --release

# Stage 4: Runtime image
FROM debian:bookworm-slim@sha256:67b30a61dc87758f0caf819646104f29ecbda97d920aaf5edc834128ac8493d3
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --no-log-init --shell /bin/false appuser
COPY --from=builder /app/target/release/pgstack-proxy /usr/local/bin/
COPY --from=studio-builder /studio-build/dist /studio
COPY --from=docs-builder /docs-build/build /docs
# The pgStack marketing landing (public/index.html). Inert unless PUBLIC_DIR=/public
# is set: the general image leaves it unset so downstream users serve their own SPA.
# Mirror of proxy-go/Dockerfile.
COPY public/ /public
# The live example pages served under /examples/* when PUBLIC_DIR is set.
COPY examples/ /public/examples
ENV RUST_LOG=pgstack_proxy=info
ENV STUDIO_DIR=/studio
ENV DOCS_DIR=/docs
EXPOSE 8080
USER appuser
CMD ["pgstack-proxy"]
