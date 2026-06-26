FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

# Non-root user — never run as root in production
RUN addgroup -S agent && adduser -S agent -G agent

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/logs && chown -R agent:agent /app

USER agent

EXPOSE 3001
CMD ["node", "dist/server.js"]
