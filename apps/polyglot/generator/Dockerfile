FROM golang:1.23-bookworm AS build
WORKDIR /app
ENV GOTOOLCHAIN=auto
COPY go.mod ./
RUN go mod download || true
COPY . .
RUN go mod tidy && CGO_ENABLED=0 go build -ldflags="-s -w" -o generator .

FROM gcr.io/distroless/static-debian12
COPY --from=build /app/generator /generator
USER 65534:65534
ENTRYPOINT ["/generator"]
