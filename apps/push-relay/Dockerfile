FROM oven/bun:1.4.5-alpine@sha256:da816670775f4c2b4e990b6b1847cf5540dcdc721a42033dd331ce7a88ba6a3b AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile --production
FROM oven/bun:1.4.5-alpine@sha256:da816670775f4c2b4e990b6b1847cf5540dcdc721a42033dd331ce7a88ba6a3b
RUN apk upgrade --no-cache libcrypto3 libssl3 zlib
RUN apk add --no-cache 'musl=1.2.5-r13' 'musl-utils=1.2.5-r13'
WORKDIR /app
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun apps/push-relay/src ./apps/push-relay/src
COPY --chown=bun:bun apps/push-relay/db ./apps/push-relay/db
COPY --chown=bun:bun apps/push-relay/scripts ./apps/push-relay/scripts
COPY --chown=bun:bun src/security/safe-http.ts src/security/field-encryption.ts ./src/security/
USER bun
EXPOSE 8080
CMD ["bun", "run", "apps/push-relay/src/index.ts"]
