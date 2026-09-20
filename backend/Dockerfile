# Multi-stage Dockerfile: base / dev / build / prod
FROM node:20.19.5-alpine3.22 AS base
WORKDIR /app
COPY package*.json ./

FROM base AS dev
ENV NODE_ENV=development
# git is required by the repo indexer (backend/src/repos) to clone registered
# repositories for code search.
RUN apk add --no-cache git
RUN npm ci
COPY . .
EXPOSE 8080
CMD ["npm", "run", "dev"]

FROM base AS build
RUN npm ci
COPY . .
RUN npm run build

FROM node:20.19.5-alpine3.22 AS prod
WORKDIR /app
ENV NODE_ENV=production
# git is required by the repo indexer (backend/src/repos) to clone registered
# repositories for code search.
RUN apk add --no-cache git && mkdir -p /data/repos /data/repos-local && chown node:node /data/repos /data/repos-local
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# npm run build copies src/db/migrations into dist/src/db/migrations, where the
# compiled dist/src/db/migrate.js resolves them. No extra COPY needed.
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "dist/src/server.js"]
