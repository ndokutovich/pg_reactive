FROM rust:latest AS builder

WORKDIR /app
COPY Cargo.toml .
COPY src/ src/

RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/pgstack-proxy /usr/local/bin/

ENV RUST_LOG=pgstack_proxy=info
EXPOSE 8080

CMD ["pgstack-proxy"]
