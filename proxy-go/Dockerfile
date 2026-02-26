# Build context must be the repository root (context: .).
# This is consistent with proxy/Dockerfile.

# ── Stage 1: Build Studio SPA ──────────────────────────────────────────────────
FROM node:20-bookworm-slim AS studio-builder
WORKDIR /studio-build
COPY studio/package.json studio/package-lock.json ./
RUN npm ci --prefer-offline
COPY studio/ .
RUN npm run build

# ── Stage 2: Build Go proxy ────────────────────────────────────────────────────
FROM golang:1.23-bookworm AS builder
WORKDIR /app

# Download dependencies first (layer-cached separately from source).
COPY proxy-go/go.mod proxy-go/go.sum ./
RUN go mod download

# Copy source and build a fully static binary.
COPY proxy-go/ .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o pgstack-proxy-go .

# ── Stage 3: Minimal runtime image ─────────────────────────────────────────────
FROM gcr.io/distroless/static-debian12

COPY --from=builder /app/pgstack-proxy-go /pgstack-proxy-go
COPY --from=studio-builder /studio-build/dist /studio

ENV STUDIO_DIR=/studio
EXPOSE 8080

ENTRYPOINT ["/pgstack-proxy-go"]
