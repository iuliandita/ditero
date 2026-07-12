#!/bin/sh
set -eu

image=$1
expected_variant=$2

actual_id=$(docker run --rm --entrypoint sh "$image" -c '. /etc/os-release; printf %s "$ID"')
case "$expected_variant:$actual_id" in
  alpine:alpine|debian:debian) ;;
  *)
    echo "expected $expected_variant image, got $actual_id" >&2
    exit 1
    ;;
esac

configured_user=$(docker image inspect --format '{{.Config.User}}' "$image")
if [ "$configured_user" != "bun" ]; then
  echo "expected runtime user bun, got $configured_user" >&2
  exit 1
fi

docker run --rm --entrypoint bun "$image" --version >/dev/null

suffix=$$
network="ditero-smoke-$suffix"
database="ditero-smoke-db-$suffix"
app="ditero-smoke-app-$suffix"

cleanup() {
  docker rm -f "$app" "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker network create "$network" >/dev/null
docker run --detach --name "$database" --network "$network" \
  --env POSTGRES_DB=ditero --env POSTGRES_USER=postgres --env POSTGRES_PASSWORD=pass \
  postgres:18@sha256:4aabea78cf39b90e834caf3af7d602a18565f6fe2508705c8d01aa63245c2e20 \
  postgres -c wal_level=logical >/dev/null

attempt=0
until docker exec "$database" psql -U postgres -d ditero -c "select 1" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    docker logs "$database" >&2
    exit 1
  fi
  sleep 1
done

docker exec "$database" psql -U postgres -d ditero -v ON_ERROR_STOP=1 -c "
  create role ditero_runtime login password 'runtime-smoke' nosuperuser nobypassrls;
  grant usage on schema public to ditero_runtime;
  alter default privileges for role postgres in schema public
    grant select, insert, update, delete on tables to ditero_runtime;
" >/dev/null

docker run --detach --name "$app" --network "$network" \
	--env DATABASE_URL="postgres://ditero_runtime:runtime-smoke@$database:5432/ditero" \
	--env DATABASE_MIGRATION_URL="postgres://postgres:pass@$database:5432/ditero" \
  --env BETTER_AUTH_SECRET=container-smoke-only-secret-32-bytes \
	--env DITERO_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
  --env BETTER_AUTH_URL=http://localhost:3000 \
  "$image" >/dev/null

attempt=0
until docker exec "$app" bun -e '
  const required = [
    "content-security-policy",
    "strict-transport-security",
    "x-content-type-options",
    "x-frame-options",
    "referrer-policy",
    "permissions-policy",
  ];
  for (const path of ["/health", "/"]) {
    const response = await fetch(`http://localhost:3000${path}`);
    if (!response.ok) process.exit(1);
    if (required.some((name) => !response.headers.has(name))) process.exit(1);
  }
' >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    docker logs "$app" >&2
    exit 1
  fi
  sleep 1
done
