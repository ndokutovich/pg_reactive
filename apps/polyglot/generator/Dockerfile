FROM golang:1.25.13-bookworm AS build
WORKDIR /app
ENV GOTOOLCHAIN=auto
# Reproducible build: pin to committed go.mod + go.sum. Previously this did
# `go mod download || true` (swallowing download failures) and `go mod tidy`
# at build time (mutating go.mod and re-resolving from the network every
# build, with no go.sum to verify against). Now the build fails loudly on a
# missing/*changed* dependency and never edits the module files.
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o generator .

FROM gcr.io/distroless/static-debian12
COPY --from=build /app/generator /generator
USER 65534:65534
ENTRYPOINT ["/generator"]
