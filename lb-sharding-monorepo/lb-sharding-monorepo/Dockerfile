# ── Stage 1: Build ────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json package-lock.json* ./
COPY packages/core/package.json ./packages/core/
COPY packages/load-balancer/package.json ./packages/load-balancer/
COPY packages/health-checker/package.json ./packages/health-checker/
COPY packages/shard-manager/package.json ./packages/shard-manager/
COPY packages/metrics/package.json ./packages/metrics/
COPY packages/cli/package.json ./packages/cli/
COPY apps/gateway/package.json ./apps/gateway/

RUN npm ci --ignore-scripts

# Copy source
COPY tsconfig.json tsconfig.build.json ./
COPY packages/ ./packages/
COPY apps/gateway/ ./apps/gateway/

# Build all packages in dependency order
RUN npm run build --workspace=packages/core && \
    npm run build --workspace=packages/load-balancer && \
    npm run build --workspace=packages/health-checker && \
    npm run build --workspace=packages/shard-manager && \
    npm run build --workspace=packages/metrics && \
    npm run build --workspace=apps/gateway

# ── Stage 2: Production ───────────────────────────────────────
FROM node:20-alpine AS production

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy built artifacts
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/load-balancer/dist ./packages/load-balancer/dist
COPY --from=builder /app/packages/load-balancer/package.json ./packages/load-balancer/
COPY --from=builder /app/packages/health-checker/dist ./packages/health-checker/dist
COPY --from=builder /app/packages/health-checker/package.json ./packages/health-checker/
COPY --from=builder /app/packages/shard-manager/dist ./packages/shard-manager/dist
COPY --from=builder /app/packages/shard-manager/package.json ./packages/shard-manager/
COPY --from=builder /app/packages/metrics/dist ./packages/metrics/dist
COPY --from=builder /app/packages/metrics/package.json ./packages/metrics/
COPY --from=builder /app/apps/gateway/dist ./apps/gateway/dist
COPY --from=builder /app/apps/gateway/package.json ./apps/gateway/

USER appuser

ENV NODE_ENV=production
ENV PORT=8080
ENV ADMIN_PORT=9000
ENV METRICS_PORT=9090

EXPOSE 8080 9000 9090

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:9000/health || exit 1

CMD ["node", "apps/gateway/dist/server.js"]
