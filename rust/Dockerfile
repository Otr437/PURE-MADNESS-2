# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM rust:1.82-slim AS builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml ./
COPY src/ ./src/
RUN cargo build --release --bin rag_engine

# ── Stage 2: production ───────────────────────────────────────────────────────
FROM debian:bookworm-slim AS production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && groupadd -r raguser && useradd -r -g raguser raguser
COPY --from=builder /build/target/release/rag_engine /usr/local/bin/rag_engine
RUN chown raguser:raguser /usr/local/bin/rag_engine
USER raguser
EXPOSE 8003
CMD ["rag_engine"]
