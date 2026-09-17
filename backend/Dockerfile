# Multi-stage Dockerfile: base / dev / build / prod
FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./

FROM base AS dev
ENV NODE_ENV=development
RUN npm install
COPY . .
EXPOSE 8080
CMD ["npm", "run", "dev"]

FROM base AS build
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS prod
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY src/db/migrations ./src/db/migrations
EXPOSE 8080
USER node
CMD ["node", "dist/src/server.js"]
