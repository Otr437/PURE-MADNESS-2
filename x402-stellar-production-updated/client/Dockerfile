FROM node:20-alpine

# Security: non-root user
RUN addgroup -S x402 && adduser -S x402 -G x402

WORKDIR /app

COPY package.json ./
COPY shared/package.json ./shared/
COPY client/package.json ./client/

# Use npm ci — pinned, audited, reproducible
RUN npm ci --omit=dev --audit

COPY shared/ ./shared/
COPY client/ ./client/

# Create log dir with correct ownership
RUN mkdir -p /app/logs && chown -R x402:x402 /app

USER x402

WORKDIR /app/client

# Agent is one-shot — exits after run. No health check needed.
CMD ["node", "example.js"]
