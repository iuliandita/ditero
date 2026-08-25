#!/bin/sh
# The app's push endpoint writes Zero's per-client lastMutationID inside the
# mutation transaction, so the runtime role needs DML in the shard schema
# zero-cache owns. Nothing else in the suite covers it: the e2e stack runs the
# app as a superuser, and compose.sh only renders the compose file. A stack that
# reports every container healthy still fails every mutation without this.
set -eu

project=ditero-zero-shard-$$
compose_file=deploy/docker/docker-compose.yml
schema=zero_0

export POSTGRES_PASSWORD=zero-shard-postgres-password
export DITERO_MIGRATION_DB_PASSWORD=zero-shard-migration-password
export DITERO_RUNTIME_DB_PASSWORD=zero-shard-runtime-password
export BETTER_AUTH_SECRET=zero-shard-container-only-secret
export DITERO_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
export ZERO_ADMIN_PASSWORD=zero-shard-admin-password

compose() {
	docker compose --file "$compose_file" --project-name "$project" --profile bundled "$@"
}

cleanup() {
	compose down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

psql_as() {
	role=$1
	password=$2
	shift 2
	compose exec -T --env PGPASSWORD="$password" upstream-db \
		psql --username "$role" --host 127.0.0.1 --dbname ditero --tuples-only \
		--no-align --set=ON_ERROR_STOP=1 "$@"
}

await() {
	label=$1
	attempts=$2
	shift 2
	n=0
	until "$@" >/dev/null 2>&1; do
		n=$((n + 1))
		if [ "$n" -ge "$attempts" ]; then
			echo "timed out waiting for $label" >&2
			compose logs --tail 40 >&2
			exit 1
		fi
		sleep 2
	done
}

compose up --build --detach >/dev/null

await "the app to serve traffic" 90 \
	compose exec -T app bun -e 'const r = await fetch("http://localhost:3000/health"); if (!r.ok) process.exit(1)'

# zero-cache creates the shard tables on its first pass over upstream. Until
# they exist there is nothing to assert a grant against.
await "zero-cache to create $schema.clients" 90 \
	psql_as postgres "$POSTGRES_PASSWORD" \
	--command "select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = '$schema' and c.relname = 'clients'"

usable=$(psql_as ditero_runtime "$DITERO_RUNTIME_DB_PASSWORD" \
	--command "select has_schema_privilege('$schema', 'USAGE')")
if [ "$usable" != "t" ]; then
	echo "the runtime role cannot use schema $schema; every mutation would fail" >&2
	exit 1
fi

writable=$(psql_as ditero_runtime "$DITERO_RUNTIME_DB_PASSWORD" \
	--command "select has_table_privilege('$schema.clients', 'SELECT, INSERT, UPDATE')")
if [ "$writable" != "t" ]; then
	echo "the runtime role cannot write $schema.clients; every mutation would fail" >&2
	exit 1
fi

# The grants above are what the app's boot check reads. Revoking them must stop
# the app from starting, or the check is decorative and this test proves nothing
# about it.
psql_as postgres "$POSTGRES_PASSWORD" \
	--command "revoke usage on schema $schema from ditero_runtime" >/dev/null
compose restart app >/dev/null

n=0
until compose logs app 2>&1 | grep -q "shard schema"; do
	n=$((n + 1))
	if [ "$n" -ge 30 ]; then
		echo "the app started without access to $schema; the boot check is not load-bearing" >&2
		compose logs --tail 40 app >&2
		exit 1
	fi
	sleep 2
done
