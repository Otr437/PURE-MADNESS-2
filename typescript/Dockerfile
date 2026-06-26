# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /build
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: production ───────────────────────────────────────────────────────
FROM node:20-slim AS production
RUN groupadd -r raguser && useradd -r -g raguser -d /app -s /sbin/nologin raguser
WORKDIR /app
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
RUN mkdir -p /app/.rag_sessions && chown -R raguser:raguser /app
USER raguser
ENV NODE_ENV=production
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8001/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"
CMD ["node", "dist/rag_api.js"]
