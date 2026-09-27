FROM node:20.20.2-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/core-api/package.json apps/core-api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/console/package.json apps/console/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/policy/package.json packages/policy/package.json
COPY packages/rules/package.json packages/rules/package.json
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev && rm -rf apps/console tests

FROM node:20.20.2-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
# API by default; the worker and migration job override the command.
CMD ["node","apps/core-api/dist/server.js"]
