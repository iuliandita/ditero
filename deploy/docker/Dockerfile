# syntax=docker/dockerfile:1
# Ditero production image: builds the web bundle and serves it same-origin
# with the Elysia API from a single Bun runtime. Build context is the repo root
# (build with `context: .`); this file lives at deploy/docker/Dockerfile.

# --- build stage: install deps + build the web bundle -----------------------
FROM oven/bun:1.3-alpine AS build
WORKDIR /app

# Deps first for layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# App sources.
COPY . .

# The web client's zero-cache URL is baked at build time (SPA limitation for
# M0). Override with --build-arg VITE_ZERO_URL=... to point elsewhere.
ARG VITE_ZERO_URL=http://localhost:4848
ENV VITE_ZERO_URL=${VITE_ZERO_URL}
RUN bunx vite build

# --- runtime stage ----------------------------------------------------------
FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    API_PORT=3000 \
    SERVE_STATIC_DIR=/app/dist

# Built web + server sources + migrations + deps. node_modules is reused from
# the build stage (drizzle-kit lives there and runs migrations at startup).
COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --from=build --chown=bun:bun /app/src ./src
COPY --from=build --chown=bun:bun /app/drizzle ./drizzle
COPY --from=build --chown=bun:bun /app/package.json /app/bun.lock /app/drizzle.config.ts ./
COPY --chown=bun:bun deploy/docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO /dev/null http://localhost:3000/health || exit 1

# Run migrations, then start the server.
ENTRYPOINT ["./entrypoint.sh"]
