# Stage 1: Build studio SPA
FROM node:20-bookworm-slim AS studio-builder
WORKDIR /studio-build
COPY studio/package.json studio/package-lock.json ./
RUN npm ci --prefer-offline
COPY studio/ .
RUN npm run build

# Stage 2: Build Rust proxy
FROM rust:1.88-bookworm AS builder
WORKDIR /app
COPY proxy/Cargo.toml proxy/Cargo.lock ./
COPY proxy/src/ src/
RUN cargo build --release

# Stage 3: Runtime image
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --no-log-init --shell /bin/false appuser
COPY --from=builder /app/target/release/pgstack-proxy /usr/local/bin/
COPY --from=studio-builder /studio-build/dist /studio
ENV RUST_LOG=pgstack_proxy=info
ENV STUDIO_DIR=/studio
EXPOSE 8080
USER appuser
CMD ["pgstack-proxy"]
