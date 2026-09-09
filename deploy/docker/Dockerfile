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

# The bundle carries no deployment addresses: the web client fetches the
# zero-cache URL from /api/config at startup, so one image serves any hostname.
RUN bunx vite build

FROM ${RUNTIME_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --omit=optional --omit=peer

FROM rocicorp/zero:1.9.0@sha256:f80683bf3ddf08be26c68ddd94589fada29a0b8a4597668b090006c09041d4cd AS zero-base

# Keep upstream's runtime and PostgreSQL patch, but rebuild its dependency tree
# from the reviewed lock so the vulnerable packages are actually replaced.
FROM zero-base AS zero-deps
WORKDIR /opt/zero-deps
COPY deploy/docker/zero-runtime/package.json deploy/docker/zero-runtime/pnpm-lock.yaml deploy/docker/zero-runtime/pnpm-workspace.yaml ./
COPY deploy/docker/zero-runtime/patches ./patches
RUN pnpm install --prod --frozen-lockfile
COPY deploy/docker/zero-runtime/verify.mjs ./

# Rebuild the exact backup sources Zero ships, preserving both backup formats.
FROM golang:1.26.8-alpine3.23@sha256:33ce311e5eecedee48ec1b84419c1306e9fbd71009f0d5c3f2a6904b579c1ecc AS litestream-build
RUN apk add --no-cache build-base
ENV GOTOOLCHAIN=local
WORKDIR /src

FROM litestream-build AS litestream-legacy
ADD --checksum=sha256:977ce9aa14a3d1e68e2b8cec6369dda7528c230401236c804543606c1d661d16 https://codeload.github.com/rocicorp/litestream/tar.gz/5efae7df64aebc3247a739360232f908d2bc47e2 /tmp/source.tar.gz
RUN tar -xzf /tmp/source.tar.gz --strip-components=1 -C /src
COPY deploy/docker/zero-runtime/litestream/legacy/go.mod deploy/docker/zero-runtime/litestream/legacy/go.sum ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg \
    go build -mod=readonly -trimpath -ldflags "-s -w -X main.Version=v0.3.13+z0.0.9-ditero.1 -extldflags '-static'" \
    -tags osusergo,netgo,sqlite_omit_load_extension -o /out/litestream ./cmd/litestream

FROM litestream-build AS litestream-v5
ADD --checksum=sha256:6d5a3adaf237c2d60923f11a2d834b796ba6ab770aaa86fa10b61673fa243f4d https://codeload.github.com/benbjohnson/litestream/tar.gz/4e3f0c0f98a8808788c721b3637b41e7f9ce4a9c /tmp/source.tar.gz
RUN tar -xzf /tmp/source.tar.gz --strip-components=1 -C /src
COPY deploy/docker/zero-runtime/litestream/v5/go.mod deploy/docker/zero-runtime/litestream/v5/go.sum ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg \
    go build -mod=readonly -trimpath -ldflags "-s -w -X main.Version=v0.5.15-ditero.1 -extldflags '-static'" \
    -tags osusergo,netgo,sqlite_omit_load_extension -o /out/litestream-v5 ./cmd/litestream

FROM alpine:3.23.5@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40 AS zero-runtime
RUN apk upgrade --no-cache \
	&& apk add --no-cache ca-certificates 'curl>=8.22.0-r0' \
		'libcrypto3>=3.5.8-r0' 'libssl3>=3.5.8-r0' libstdc++ readline
COPY --from=zero-base /usr/local/bin/node /usr/local/bin/node
COPY --from=litestream-legacy /out/litestream /usr/local/bin/litestream
COPY --from=litestream-v5 /out/litestream-v5 /usr/local/bin/litestream-v5
COPY --from=zero-base /etc/litestream.yml /etc/litestream.yml
COPY --from=zero-deps /opt/zero-deps /opt/app
WORKDIR /opt/app
ENV PATH="/opt/app/node_modules/.bin:${PATH}" \
    ZERO_IN_CONTAINER=1 \
    ZERO_LITESTREAM_CONFIG_PATH=/etc/litestream.yml \
    ZERO_LITESTREAM_EXECUTABLE=/usr/local/bin/litestream \
    ZERO_LITESTREAM_EXECUTABLE_V5=/usr/local/bin/litestream-v5 \
    ZERO_LOG_FORMAT=json \
    ZERO_SERVER_VERSION=1.9.0
RUN node verify.mjs
COPY --chmod=755 deploy/docker/secret-file.sh /usr/local/lib/ditero/secret-file.sh
COPY --chmod=755 deploy/docker/zero-entrypoint.sh /usr/local/bin/ditero-zero-entrypoint
ENTRYPOINT ["/usr/local/bin/ditero-zero-entrypoint"]
CMD ["zero-cache"]

ARG DITERO_GIT_SHA=""
ARG DITERO_CHANNEL=""
LABEL org.opencontainers.image.title="Ditero zero-cache" \
      org.opencontainers.image.description="zero-cache for Ditero, with the Ditero secret-file entrypoint" \
      org.opencontainers.image.source="https://github.com/iuliandita/ditero" \
      org.opencontainers.image.url="https://github.com/iuliandita/ditero" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${DITERO_GIT_SHA}" \
      org.opencontainers.image.version="${DITERO_CHANNEL}" \
      ditero.channel="${DITERO_CHANNEL}"

# --- runtime bases ----------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS runtime-alpine
RUN mkdir -p /data/attachments && chown bun:bun /data/attachments

# Debian fallback: distroless is the only Debian base whose packages scan clean
# of unfixed HIGH/CRITICAL CVEs (debian:*-slim carries them in essential
# packages). It ships no shell, coreutils, or bun user, so stage the minimal
# extras from the glibc bun image: sh (dash) + cat cover everything
# entrypoint.sh/secret-file.sh invoke. Requires RUNTIME_IMAGE=oven/bun:*-slim
# when RUNTIME_VARIANT=debian.
FROM ${RUNTIME_IMAGE} AS debian-prep
RUN mkdir -p /rootfs/etc /rootfs/usr/bin /rootfs/usr/local/bin /rootfs/home/bun /rootfs/data/attachments \
	&& cp /etc/passwd /etc/group /rootfs/etc/ \
	&& cp /bin/sh /rootfs/usr/bin/sh \
	&& cp /bin/cat /rootfs/usr/bin/cat \
	&& cp /usr/local/bin/bun /rootfs/usr/local/bin/bun \
	&& chown 1000:1000 /rootfs/home/bun /rootfs/data/attachments

# gcr.io/distroless/base-debian13 (multi-arch index digest)
FROM gcr.io/distroless/base-debian13@sha256:9ef50bca108839d5986e4d84b7f7b2d79024c9293b7c35b162c6c55485bd5868 AS runtime-debian
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

# Without these the image inherits the base image's OCI labels, so asking a
# published image which commit it is answers with a bun revision. An empty
# value means the build passed none, which beats a confidently wrong one.
ARG DITERO_GIT_SHA=""
ARG DITERO_CHANNEL=""
LABEL org.opencontainers.image.title="Ditero" \
      org.opencontainers.image.description="Self-hosted, local-first, group-scale todo app" \
      org.opencontainers.image.source="https://github.com/iuliandita/ditero" \
      org.opencontainers.image.url="https://github.com/iuliandita/ditero" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${DITERO_GIT_SHA}" \
      org.opencontainers.image.version="${DITERO_CHANNEL}" \
      ditero.channel="${DITERO_CHANNEL}"
