# syntax=docker/dockerfile:1
# Ditero production image: builds the web bundle and serves it same-origin
# with the Elysia API from a single Bun runtime. Build context is the repo root
# (build with `context: .`); this file lives at deploy/docker/Dockerfile.

ARG RUNTIME_IMAGE=oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0
ARG RUNTIME_VARIANT=alpine

# --- build stage: install deps + build the web bundle -----------------------
FROM ${RUNTIME_IMAGE} AS build
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

FROM ${RUNTIME_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --omit=optional --omit=peer

FROM rocicorp/zero:1.7.0@sha256:114363cd8ae889862c283dabc88fdb62fe183a46fe4ed0ea35ebeca8d325dba3 AS zero-runtime
COPY --chmod=755 deploy/docker/secret-file.sh /usr/local/lib/ditero/secret-file.sh
COPY --chmod=755 deploy/docker/zero-entrypoint.sh /usr/local/bin/ditero-zero-entrypoint
ENTRYPOINT ["/usr/local/bin/ditero-zero-entrypoint"]
CMD ["zero-cache"]

# --- runtime bases ----------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS runtime-alpine

# Debian fallback: distroless is the only Debian base whose packages scan clean
# of unfixed HIGH/CRITICAL CVEs (debian:*-slim carries them in essential
# packages). It ships no shell, coreutils, or bun user, so stage the minimal
# extras from the glibc bun image: sh (dash) + cat cover everything
# entrypoint.sh/secret-file.sh invoke. Requires RUNTIME_IMAGE=oven/bun:*-slim
# when RUNTIME_VARIANT=debian.
FROM ${RUNTIME_IMAGE} AS debian-prep
RUN mkdir -p /rootfs/etc /rootfs/usr/bin /rootfs/usr/local/bin /rootfs/home/bun \
	&& cp /etc/passwd /etc/group /rootfs/etc/ \
	&& cp /bin/sh /rootfs/usr/bin/sh \
	&& cp /bin/cat /rootfs/usr/bin/cat \
	&& cp /usr/local/bin/bun /rootfs/usr/local/bin/bun \
	&& chown 1000:1000 /rootfs/home/bun

# gcr.io/distroless/base-debian13 (multi-arch index digest)
FROM gcr.io/distroless/base-debian13@sha256:7c4468db5fea18a1630860619be640c4c0ad158c0d63f12951b96b7d0f5ddd62 AS runtime-debian
COPY --from=debian-prep /rootfs/ /

# --- runtime stage ----------------------------------------------------------
FROM runtime-${RUNTIME_VARIANT} AS runtime
WORKDIR /app

RUN if command -v apk >/dev/null 2>&1; then \
		apk upgrade --no-cache libcrypto3 libssl3; \
	fi

ENV NODE_ENV=production \
    API_PORT=3000 \
    SERVE_STATIC_DIR=/app/dist

# Built web + server sources + migrations + production dependencies.
COPY --from=prod-deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --from=build --chown=bun:bun /app/src ./src
COPY --from=build --chown=bun:bun /app/drizzle ./drizzle
COPY --from=build --chown=bun:bun /app/package.json /app/bun.lock ./
COPY --chmod=755 --chown=bun:bun deploy/docker/entrypoint.sh ./entrypoint.sh
COPY --chown=bun:bun deploy/docker/secret-file.sh ./secret-file.sh

USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch('http://localhost:3000/health'); if (!r.ok) process.exit(1)"]

# Run migrations, then start the server.
ENTRYPOINT ["./entrypoint.sh"]
