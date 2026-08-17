# syntax=docker/dockerfile:1

# Multi-stage build for the Astro node standalone server (pnpm).
# node:24-slim: better-sqlite3 (v13+) ships prebuilds in its npm tarball, so
# the install needs no native toolchain — as long as better-sqlite3 stays
# unapproved in pnpm-workspace.yaml allowBuilds, which would trigger a
# node-gyp source build.
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Non-interactive pnpm: image builds have no TTY for confirmation prompts.
ENV CI=true
RUN corepack enable
WORKDIR /app

# Full install (incl. dev deps) + build. Everything is SSR — no database
# needed at build time.
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
# Public hostname baked into the build: astro.config.mjs turns it into
# security.allowedDomains so forwarded headers from the proxy are trusted.
ARG SITE_HOSTNAME
ENV SITE_HOSTNAME=$SITE_HOSTNAME
RUN pnpm build

# Production-only dependencies, resolved separately so dev deps stay out of the image.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

# Slim runtime: prod node_modules + built output + migrations.
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321
# Migrations are applied at startup by the server itself (src/db/migrate.ts);
# the source tree isn't in the image, so point MIGRATIONS_DIR at this copy.
ENV MIGRATIONS_DIR=/app/migrations
ENV DATABASE_PATH=/app/data/lunch.db
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./migrations
COPY package.json ./
EXPOSE 4321
CMD ["node", "dist/server/entry.mjs"]
