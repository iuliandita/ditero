#!/bin/sh
set -eu

compose_file=deploy/docker/docker-compose.yml
export BETTER_AUTH_SECRET=compose-test-secret
export ZERO_ADMIN_PASSWORD=compose-test-secret

external_services=$(
  DITERO_DATABASE_URL=postgres://user:pass@db.example.invalid:5432/ditero \
    docker compose --file "$compose_file" config --services
)
if printf '%s\n' "$external_services" | grep -qx upstream-db; then
  echo "external database mode includes upstream-db" >&2
  exit 1
fi

bundled_services=$(docker compose --file "$compose_file" --profile bundled config --services)
for service in upstream-db app zero-cache; do
  if ! printf '%s\n' "$bundled_services" | grep -qx "$service"; then
    echo "bundled mode is missing $service" >&2
    exit 1
  fi
done

dry_run=$(
  DITERO_DATABASE_URL=postgres://user:pass@db.example.invalid:5432/ditero \
    docker compose --file "$compose_file" --dry-run up --no-build app zero-cache 2>&1
)
if printf '%s\n' "$dry_run" | grep -q upstream-db; then
  echo "external database dry-run creates upstream-db" >&2
  exit 1
fi
