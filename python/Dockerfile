# ── Stage 1: build deps ───────────────────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /build

# Install build tools only in builder stage — not in final image
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libffi-dev \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --upgrade pip --no-cache-dir \
 && pip install --prefix=/install --no-cache-dir -r requirements.txt

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM python:3.12-slim AS production

# Security: run as non-root user
RUN groupadd -r raguser && useradd -r -g raguser -d /app -s /sbin/nologin raguser

WORKDIR /app

# Copy installed packages from builder — no build tools in final image
COPY --from=builder /install /usr/local

# Copy application source
COPY src/ ./src/

# Create directories app will need at runtime (owned by raguser)
RUN mkdir -p /app/.rag_sessions /app/.rag_cache \
 && chown -R raguser:raguser /app

USER raguser

ENV PYTHONPATH=/app/src \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

CMD ["uvicorn", "rag_api:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
