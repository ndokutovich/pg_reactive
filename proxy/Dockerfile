# Build speed: the cargo build + npm installs use BuildKit cache mounts (the CI
# uses buildx, so the BuildKit frontend is active without a pinned `# syntax`
# directive — kept off to avoid referencing an unpinned frontend image). So a
# code-only change no longer recompiles the ~300 Rust dependency crates — the
# cargo registry + the per-arch target dir persist across builds on the runner and
# cargo does an incremental compile of only the changed crates. arm64 stays
# multi-arch via QEMU per project decision; the cache mounts cut the dominant cost.
#
# Base images are digest-pinned for supply-chain parity with the Go proxy
# (proxy-go/Dockerfile): the Rust proxy ships as a co-equal released artifact, so
# its bases must be immutable too. node + debian reuse the Go proxy's verified
# digests (same tags). Re-pin together when bumping a tag.

# Stage 1: Build studio SPA
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS studio-builder
WORKDIR /studio-build
COPY studio/package.json studio/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,id=npm-studio \
    npm ci --prefer-offline --no-audit --fetch-retries=6 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=180000 --fetch-timeout=600000
COPY studio/ .
RUN npm run build

# Stage 2: Build Docusaurus docs (mirror of proxy-go/Dockerfile's docs-builder)
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS docs-builder
ARG DOCS_BASE_URL=/docs/
WORKDIR /docs-build
COPY docs/site/package.json docs/site/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,id=npm-docs \
    npm ci --prefer-offline --no-audit --fetch-retries=6 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=180000 --fetch-timeout=600000
COPY docs/site/ .
ENV DOCS_URL=http://localhost:8080 DOCS_BASE_URL=${DOCS_BASE_URL}
RUN npm run build

# Stage 3: Build Rust proxy
FROM rust:1.99-bookworm@sha256:e6f2cff35d0f309acf8433b4f05878ed77092602c5065cc81801177da0bb3a9c AS builder
ARG TARGETARCH
WORKDIR /app
COPY proxy/Cargo.toml proxy/Cargo.lock ./
COPY proxy/src/ src/
# The registry cache is the shared crate download cache; the target dir is per-arch
# + sharing=locked (cargo is not concurrency-safe on one target). The release binary
# lives in the non-layer target cache mount, so it is copied out before the RUN ends.
RUN --mount=type=cache,target=/usr/local/cargo/registry,id=cargo-registry,sharing=locked \
    --mount=type=cache,target=/app/target,id=rust-target-${TARGETARCH},sharing=locked \
    cargo build --release && cp target/release/pgstack-proxy /pgstack-proxy

# Stage 4: Runtime image
FROM debian:bookworm-slim@sha256:67b30a61dc87758f0caf819646104f29ecbda97d920aaf5edc834128ac8493d3
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --no-log-init --shell /bin/false appuser
COPY --from=builder /pgstack-proxy /usr/local/bin/pgstack-proxy
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
