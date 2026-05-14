# hello-go — reference polyglot edge function (runtime="http").
# Stdlib only, no dependencies — so no go.sum and no `go mod tidy` needed.

FROM golang:1.23-bookworm AS build
WORKDIR /src
COPY go.mod .
COPY main.go .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /hello-go .

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --no-log-init fn
COPY --from=build /hello-go /usr/local/bin/hello-go
USER fn
EXPOSE 9100
ENTRYPOINT ["/usr/local/bin/hello-go"]
