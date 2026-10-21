#!/bin/sh
set -eu

image=$1
expected_variant=$2
expected_revision=${3:-}

actual_id=$(docker run --rm --entrypoint sh "$image" -c '. /etc/os-release; printf %s "$ID"')
case "$expected_variant:$actual_id" in
  alpine:alpine|debian:debian) ;;
  *)
    echo "expected $expected_variant image, got $actual_id" >&2
    exit 1
    ;;
esac

# An undeclared ARG is dropped without a warning, so the only proof the build
# args survived is reading the stamp back off the image.
if [ -n "$expected_revision" ]; then
  actual_revision=$(docker image inspect \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
  if [ "$actual_revision" != "$expected_revision" ]; then
    echo "expected revision $expected_revision, got $actual_revision" >&2
    exit 1
  fi
fi

configured_user=$(docker image inspect --format '{{.Config.User}}' "$image")
if [ "$configured_user" != "bun" ]; then
  echo "expected runtime user bun, got $configured_user" >&2
  exit 1
fi

docker run --rm --entrypoint bun "$image" --version >/dev/null
docker run --rm --entrypoint bun "$image" -e '
  const path = "/data/attachments/.write-smoke";
  await Bun.write(path, "ciphertext");
  if (await Bun.file(path).text() !== "ciphertext") process.exit(1);
' >/dev/null

suffix=$$
prefix=${DITERO_CONTAINER_TEST_PREFIX:-ditero-smoke}
network="$prefix-$suffix"
database="$prefix-db-$suffix"
app="$prefix-app-$suffix"

cleanup() {
  docker rm -fv "$app" "$database" >/dev/null 2>&1 || true
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
  --env DITERO_SCHEDULER_TICK_MS=1000 \
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

# Exercise PID 1, actual database loss/recovery, and Docker's default stop budget.
docker exec "$app" bun -e '
  const args = (await Bun.file("/proc/1/cmdline").text()).split("\0");
  if (!args[0].endsWith("bun") || args[1] !== "src/server/index.ts") throw new Error("Bun is not PID 1");
  const response = await fetch("http://localhost:3000/api/auth/sign-up/email", {
    method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ name: "Lifecycle", email: "lifecycle@example.com", password: "lifecycle-fixture-password" }),
  });
  if (!response.ok) throw new Error(`Signup failed: ${response.status}`);
'
docker exec -i "$database" psql -U postgres -d ditero -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into list (id, workspace_id, owner_id, title, sort_key)
select 'lifecycle-list', w.id, u.id, 'Lifecycle', 'a0'
from "user" u join workspace w on w.owner_id=u.id and w.kind='personal'
where u.email='lifecycle@example.com';
insert into task (id, list_id, title, sort_key, due_at, reminder_time)
values ('lifecycle-before', 'lifecycle-list', 'Lifecycle', 'a0', now(), to_char(now() at time zone 'UTC','HH24:MI'));
SQL

wait_reminder() {
  attempt=0
  until [ "$(docker exec "$database" psql -U postgres -d ditero -Atc "select count(*) from reminder_state where task_id='$1' and fire_count=1")" = 1 ]; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then docker logs "$app" >&2; exit 1; fi
    sleep 1
  done
}
wait_reminder lifecycle-before
started=$(docker inspect --format '{{.State.StartedAt}}' "$app")
docker stop "$database" >/dev/null
sleep 3
test "$(docker inspect --format '{{.State.Running}}' "$app")" = true
docker exec "$app" bun -e 'if (!(await fetch("http://localhost:3000/health")).ok) process.exit(1)'
docker start "$database" >/dev/null
attempt=0
until docker exec "$database" psql -U postgres -d ditero -c 'select 1' >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then docker logs "$database" >&2; exit 1; fi
  sleep 1
done
docker exec -i "$database" psql -U postgres -d ditero -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into task (id, list_id, title, sort_key, due_at, reminder_time)
values ('lifecycle-after', 'lifecycle-list', 'Lifecycle', 'a1', now(), to_char(now() at time zone 'UTC','HH24:MI'));
SQL
wait_reminder lifecycle-after
docker exec "$app" bun -e '
  const response = await fetch("http://localhost:3000/api/auth/sign-in/email", {
    method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ email: "lifecycle@example.com", password: "lifecycle-fixture-password" }),
  });
  if (!response.ok) throw new Error(`Recovered sign-in failed: ${response.status}`);
'
test "$(docker inspect --format '{{.State.StartedAt}}' "$app")" = "$started"
echo 'database restart: process survived and reminder scans/requests recovered'
stop_started=$(date +%s)
docker stop "$app" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$app")" = 0
stop_elapsed=$(($(date +%s) - stop_started))
echo "docker stop: ${stop_elapsed}s, exit 0"
test "$stop_elapsed" -lt 9

# The startup controls stop the app and rotate its auth secret, so they run last.
docker start "$app" >/dev/null
attempt=0
until docker exec "$app" bun -e 'if (!(await fetch("http://localhost:3000/health")).ok) process.exit(1)' >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then docker logs "$app" >&2; exit 1; fi
  sleep 1
done
tests/container/startup.sh "$image" "$app" "$database" "$network"
