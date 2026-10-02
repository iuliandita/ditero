FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile --production
FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0
RUN apk upgrade --no-cache libcrypto3 libssl3
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
