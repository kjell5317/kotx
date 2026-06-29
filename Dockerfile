# Builds the app + worker (shared workspace). One image, different CMDs in compose.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/app/package.json packages/app/
COPY packages/worker/package.json packages/worker/
RUN npm install --workspaces --include-workspace-root
COPY packages ./packages
RUN npm run build

FROM node:20-bookworm-slim AS runtime
# git: the worker runs all host-side git operations via execFile (SPEC §9).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json ./package.json
COPY config ./config
COPY prompts ./prompts
COPY migrations ./migrations
ENV NODE_ENV=production
# default; overridden per service in docker-compose
CMD ["node", "packages/app/dist/index.js"]
