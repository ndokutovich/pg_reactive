# Polyglot engine — Go reference.
#
# Build:
#   docker build -t pgstack/polyglot-engine-go:dev apps/polyglot/engines/go/
# Run (via deploy/templates/polyglot-showcase/docker-compose.yml).

FROM golang:1.26.11-bookworm AS build
WORKDIR /app
ENV GOTOOLCHAIN=auto

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o engine .

FROM gcr.io/distroless/static-debian12
COPY --from=build /app/engine /engine
USER 65534:65534
ENTRYPOINT ["/engine"]
