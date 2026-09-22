# Production Dockerfile for MeshSync Microservices
FROM node:22-alpine AS base
WORKDIR /app

# Copy root manifests
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY packages/edge-sync/package*.json ./packages/edge-sync/
COPY packages/command-center/package*.json ./packages/command-center/

# Install dependencies across workspaces
RUN npm ci --omit=dev || npm install --omit=dev

# Copy source code and migrations
COPY packages/ ./packages/
COPY migrations/ ./migrations/

ENV NODE_ENV=production

# Expose default ports (4001: Edge Sync, 4002: Command Center, 8080: Internal API)
EXPOSE 4001 4002 8080

# Default command starts edge-sync (can be overridden by command in docker-compose)
CMD ["node", "packages/edge-sync/src/server.js"]
