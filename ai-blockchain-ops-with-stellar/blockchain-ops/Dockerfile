# ============================================================
# DOCKERFILE — AI Blockchain Ops
# Multi-stage build: deps → build → production
# Node.js 22 LTS, non-root user, minimal attack surface
# ============================================================

# ── Stage 1: Install dependencies ────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

# Install build tools needed for native modules (pg, etc.)
RUN apk add --no-cache python3 make g++ curl

COPY package.json ./
RUN npm install --omit=dev --prefer-offline && npm cache clean --force

# ── Stage 2: Build / typecheck ────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --prefer-offline

COPY . .
# Typecheck only — we run with tsx at runtime (no compile step needed)
RUN npx tsc --noEmit && echo "TypeScript OK"

# ── Stage 3: Production runtime ───────────────────────────────
FROM node:22-alpine AS production
WORKDIR /app

# Security: run as non-root
RUN addgroup -g 1001 -S aiops && adduser -u 1001 -S aiops -G aiops

# Install Foundry (forge/cast) for Solidity compilation
RUN apk add --no-cache curl bash git && \
    curl -L https://foundry.paradigm.xyz | bash || true && \
    echo "Foundry install attempted — may need manual install"

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source files
COPY --chown=aiops:aiops . .

# Remove dev files
RUN rm -rf .git .github tests coverage .env

# Create log directory
RUN mkdir -p /app/logs && chown aiops:aiops /app/logs

# Create blockchain workspace
RUN mkdir -p /app/.blockchain-workspace && chown aiops:aiops /app/.blockchain-workspace

# Switch to non-root user
USER aiops

# Expose all module ports
EXPOSE 3001 3002 3003 3004 3005 3006 3007 3008 3009 3010 3011 3012 3013 3014

# Health check — tests gateway is responding
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3004/health || exit 1

# Start all modules via main.ts
CMD ["node", "--import", "tsx/esm", "main.ts"]
