# syntax=docker/dockerfile:1
# AI Activity server: see AGENTS.md, "Deploy (Docker + Caddy)".
# Node 22 on Debian (glibc): better-sqlite3 ships prebuilt binaries for it on
# amd64 and arm64, so nothing is compiled. Node >= 22.18 runs server/*.ts as is.
ARG NODE_IMAGE=node:22-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/dashboard.db \
    BACKUP_DIR=/data/backups
WORKDIR /app
COPY package.json package-lock.json ./
# Installed here, not copied from the build stage or the host: the native
# SQLite binding must match this image's platform.
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server server
COPY shared shared
COPY scripts scripts
COPY --from=build /app/web/dist web/dist
# The database, its -wal/-shm files and the backups live in /data: mount the
# directory (a volume), never the database file alone.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server/index.ts"]
