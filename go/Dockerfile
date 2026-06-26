# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM golang:1.23-slim AS builder
WORKDIR /build
COPY go.mod ./
RUN go mod download
COPY src/ ./src/
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o rag_agent ./src/...

# ── Stage 2: production ───────────────────────────────────────────────────────
FROM gcr.io/distroless/static:nonroot AS production
COPY --from=builder /build/rag_agent /rag_agent
USER nonroot:nonroot
EXPOSE 8002
ENTRYPOINT ["/rag_agent"]
