#!/bin/sh
set -eu

compose_file=deploy/docker/docker-compose.yml
export BETTER_AUTH_SECRET=compose-test-secret
export DITERO_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
export DITERO_MIGRATION_DB_PASSWORD=compose-migration-password
export DITERO_RUNTIME_DB_PASSWORD=compose-runtime-password
export POSTGRES_PASSWORD=compose-postgres-password
export ZERO_ADMIN_PASSWORD=compose-test-secret

external_services=$(
  DITERO_DATABASE_URL=postgres://user:pass@db.example.invalid:5432/ditero \
  DITERO_MIGRATION_DATABASE_URL=postgres://owner:pass@db.example.invalid:5432/ditero \
  DITERO_ZERO_DATABASE_URL=postgres://zero:pass@db.example.invalid:5432/ditero \
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

bundled_config=$(docker compose --file "$compose_file" --profile bundled config)
if ! printf '%s\n' "$bundled_config" | grep -q 'DITERO_ATTACHMENT_FS_PATH: /data/attachments'; then
  printf '%s\n' "app is missing the persistent attachment path" >&2
  exit 1
fi
if ! printf '%s\n' "$bundled_config" | grep -q 'source: ditero-attachments'; then
  printf '%s\n' "app is missing the persistent attachment volume" >&2
  exit 1
fi
if ! printf '%s\n' "$bundled_config" | grep -q 'target: /data/attachments'; then
  printf '%s\n' "attachment volume is mounted at the wrong path" >&2
  exit 1
fi

s3_config=$(
  DITERO_ATTACHMENT_STORAGE_DRIVER=s3 \
  DITERO_ATTACHMENT_FS_PATH= \
    docker compose --file "$compose_file" --profile bundled config
)
if ! printf '%s\n' "$s3_config" | grep -q 'DITERO_ATTACHMENT_FS_PATH: ""'; then
  printf '%s\n' "S3 mode cannot clear the Compose filesystem path" >&2
  exit 1
fi

dry_run=$(
  DITERO_DATABASE_URL=postgres://user:pass@db.example.invalid:5432/ditero \
  DITERO_MIGRATION_DATABASE_URL=postgres://owner:pass@db.example.invalid:5432/ditero \
  DITERO_ZERO_DATABASE_URL=postgres://zero:pass@db.example.invalid:5432/ditero \
    docker compose --file "$compose_file" --dry-run up --no-build app zero-cache 2>&1
)
if printf '%s\n' "$dry_run" | grep -q upstream-db; then
  echo "external database dry-run creates upstream-db" >&2
  exit 1
fi
