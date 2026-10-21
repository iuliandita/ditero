#!/bin/sh
set -eu

image=$1
app=$2
database=$3
network=$4
probe="$app-startup"
cleanup() { docker rm -fv "$probe" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

run_probe() {
  docker run --detach --name "$probe" --network "$network" \
    --env DATABASE_URL="postgres://ditero_runtime:runtime-smoke@$database:5432/ditero" \
    --env BETTER_AUTH_SECRET=container-smoke-only-secret-32-bytes \
    --env DITERO_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    --env BETTER_AUTH_URL=http://localhost:3000 \
    --env DITERO_BACKGROUND_JOBS=0 \
    --env DITERO_ATTACHMENT_FS_PATH=/data/attachments \
    "$@" --entrypoint bun "$image" src/server/index.ts >/dev/null
}
rejected() {
  expected=$1
  shift
  run_probe "$@"
  attempt=0
  while [ "$(docker inspect --format '{{.State.Running}}' "$probe")" = true ]; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 15 ]; then docker logs "$probe" >&2; echo 'startup should have failed' >&2; exit 1; fi
    sleep 1
  done
  if [ "$(docker inspect --format '{{.State.ExitCode}}' "$probe")" != 1 ] ||
    ! docker logs "$probe" 2>&1 | grep -F "$expected" >/dev/null; then
    docker logs "$probe" >&2
    echo "expected startup failure: $expected" >&2
    exit 1
  fi
  echo "startup rejected: $expected"
  cleanup
}
healthy() {
  run_probe "$@"
  attempt=0
  until docker exec "$probe" bun -e 'if (!(await fetch("http://localhost:3000/health")).ok) process.exit(1)' >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then docker logs "$probe" >&2; exit 1; fi
    sleep 1
  done
  docker exec "$probe" bun -e '
    import { readdir } from "node:fs/promises";
    if ((await readdir("/data/attachments")).some(name => name.startsWith(".ditero-probe-"))) throw new Error("startup probe leaked");
  '
  cleanup
}

rejected 'BETTER_AUTH_SECRET must contain at least 32 characters' --env BETTER_AUTH_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
healthy --env BETTER_AUTH_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx --env DITERO_E2E_ENABLED=true
healthy --env DITERO_E2E_ENABLED=false --env DITERO_ATTACHMENT_FS_PATH=/missing-storage
rejected '"/missing-storage" is not writable (ENOENT)' --env DITERO_E2E_ENABLED=true --env DITERO_ATTACHMENT_FS_PATH=/missing-storage
rejected '"/etc" is not writable (EACCES)' --env DITERO_E2E_ENABLED=true --env DITERO_ATTACHMENT_FS_PATH=/etc
rejected '"/data/attachments" is not writable (EROFS)' --read-only --tmpfs /tmp --env DITERO_E2E_ENABLED=true --env DITERO_ATTACHMENT_FS_PATH=/data/attachments

# Retain a real Better Auth JWKS, then replace only the auth secret.
docker exec "$app" bun -e '
  import { auth } from "./src/auth/auth.ts";
  import { pool } from "./src/db/client.ts";
  await auth.api.signJWT({ body: { payload: { sub: "startup-fixture" } } });
  await pool.end();
'
rejected 'Stored JWKS private key cannot be decrypted' --env BETTER_AUTH_SECRET=changed-container-smoke-secret-32-bytes
healthy --env DITERO_E2E_ENABLED=true

# Maintenance rotation runs with all application replicas stopped.
docker stop --time 1 "$app" >/dev/null
docker run --rm --network "$network" --entrypoint bun \
  --env DATABASE_MIGRATION_URL="postgres://postgres:pass@$database:5432/ditero" \
  --env BETTER_AUTH_SECRET=container-smoke-only-secret-32-bytes \
  --env BETTER_AUTH_SECRET_NEXT=changed-container-smoke-secret-32-bytes \
  --env DITERO_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
  "$image" run security:rotate-auth-secrets
healthy --env BETTER_AUTH_SECRET=changed-container-smoke-secret-32-bytes --env DITERO_E2E_ENABLED=true
echo 'startup controls: 32-character and writable/disabled storage controls pass; retained JWKS recovers after rotation'
