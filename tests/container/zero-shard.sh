#!/bin/sh
# The app's push endpoint writes Zero's per-client lastMutationID inside the
# mutation transaction, so the runtime role needs DML in the shard schema
# zero-cache owns. Nothing else in the suite covers it: the e2e stack runs the
# app as a superuser, and compose.sh only renders the compose file. A stack that
# reports every container healthy still fails every mutation without this.
set -eu

project=ditero-zero-shard-$$
compose_file=deploy/docker/docker-compose.yml
override_file=tests/container/no-ports.override.yml
storage_override=$(mktemp)
schema=zero_0

export POSTGRES_PASSWORD=zero-shard-postgres-password
export DITERO_MIGRATION_DB_PASSWORD=zero-shard-migration-password
export DITERO_RUNTIME_DB_PASSWORD=zero-shard-runtime-password
export BETTER_AUTH_SECRET=zero-shard-container-only-secret
export DITERO_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
export ZERO_ADMIN_PASSWORD=zero-shard-admin-password
if [ "${DITERO_CONTAINER_BUILD:-1}" = 1 ]; then
	export DITERO_IMAGE_TAG="${DITERO_IMAGE_TAG:-$project}"
	export DITERO_ZERO_IMAGE_TAG="${DITERO_ZERO_IMAGE_TAG:-$project-zero}"
fi

# Keep this probe private and disposable without creating or deleting volumes.
cat >"$storage_override" <<'YAML'
services:
  upstream-db:
    volumes: !override
      - ./secret-file.sh:/usr/local/lib/ditero/secret-file.sh:ro
      - ./postgres-init.sh:/docker-entrypoint-initdb.d/10-ditero-roles.sh:ro
      - ./postgres-healthcheck.sh:/usr/local/lib/ditero/postgres-healthcheck.sh:ro
    tmpfs:
      - /var/lib/postgresql
  app:
    volumes: !override []
    tmpfs:
      - /data/attachments:uid=1000,gid=1000
  zero-cache:
    volumes: !override []
    tmpfs:
      - /data:uid=1000,gid=1000
YAML

compose() {
	docker compose --file "$compose_file" --file "$override_file" \
		--file "$storage_override" \
		--project-name "$project" --profile bundled "$@"
}

cleanup() {
	compose down --remove-orphans >/dev/null 2>&1 || true
	rm -f "$storage_override"
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

# psql exits 0 on a query that matches no rows, so a wait built on its exit
# status alone passes immediately and asserts nothing. This one waits for
# output.
await_value() {
	label=$1
	attempts=$2
	shift 2
	n=0
	until [ -n "$("$@" 2>/dev/null)" ]; do
		n=$((n + 1))
		if [ "$n" -ge "$attempts" ]; then
			echo "timed out waiting for $label" >&2
			compose logs --tail 40 >&2
			exit 1
		fi
		sleep 2
	done
}

case ${DITERO_CONTAINER_BUILD:-1} in
1) compose up --build --detach >/dev/null ;;
0) compose up --no-build --detach >/dev/null ;;
*) echo "DITERO_CONTAINER_BUILD must be 0 or 1" >&2; exit 1 ;;
esac

await "the app to serve traffic" 90 \
	compose exec -T app bun -e 'const r = await fetch("http://localhost:3000/health"); if (!r.ok) process.exit(1)'

# zero-cache creates the shard tables on its first pass over upstream. Until
# they exist there is nothing to assert a grant against.
tables_query="select count(*) from pg_class c
	join pg_namespace n on n.oid = c.relnamespace
	where n.nspname = '$schema' and c.relkind = 'r'"
await_value "zero-cache to create tables in $schema" 90 \
	psql_as postgres "$POSTGRES_PASSWORD" --command "$tables_query having count(*) > 0"

for role in ditero_runtime ditero_migrator; do
	case $role in
	ditero_runtime) password=$DITERO_RUNTIME_DB_PASSWORD ;;
	*) password=$DITERO_MIGRATION_DB_PASSWORD ;;
	esac

	case $role in
	ditero_runtime) consequence="every mutation would fail" ;;
	*) consequence="every migration would fail once zero-cache's DDL trigger exists" ;;
	esac

	usable=$(psql_as "$role" "$password" \
		--command "select has_schema_privilege('$schema', 'USAGE')")
	if [ "$usable" != "t" ]; then
		echo "$role cannot use schema $schema; $consequence" >&2
		exit 1
	fi

	# Every table, not a named one: an operator granting by hand covers one and
	# misses another, which is the mistake the app's boot check exists to catch.
	# One call per privilege: the comma-separated form of has_table_privilege is
	# true when ANY of them is held, so a read-only grant would pass it.
	unwritable=$(psql_as "$role" "$password" --command \
		"select coalesce(string_agg(c.relname::text, ', '), '')
		 from pg_class c join pg_namespace n on n.oid = c.relnamespace
		 where n.nspname = '$schema' and c.relkind = 'r'
		   and not (has_table_privilege(c.oid, 'SELECT')
		        and has_table_privilege(c.oid, 'INSERT')
		        and has_table_privilege(c.oid, 'UPDATE'))")
	if [ -n "$unwritable" ]; then
		echo "$role cannot write $schema tables: $unwritable; $consequence" >&2
		exit 1
	fi
done

# Timing evidence stays outside Zero and runtime has only the needed DML.
private_access=$(psql_as ditero_runtime "$DITERO_RUNTIME_DB_PASSWORD" --command "
 select has_schema_privilege('server_private', 'USAGE')
 and has_table_privilege('server_private.focus_interval_clock', 'SELECT')
 and has_table_privilege('server_private.focus_interval_clock', 'INSERT')
 and has_table_privilege('server_private.focus_interval_clock', 'UPDATE')
 and not has_table_privilege('server_private.focus_interval_clock', 'DELETE')
 and not has_schema_privilege('server_private', 'CREATE')
 and not rolsuper and not rolbypassrls
 from pg_roles where rolname=current_user")
[ "$private_access" = "t" ] || { echo "runtime private clock grants are incorrect" >&2; exit 1; }
published=$(psql_as postgres "$POSTGRES_PASSWORD" --command "
 select count(*) from pg_publication_tables where schemaname='server_private'
 or tablename='focus_interval_clock'")
[ "$published" = "0" ] || { echo "private focus clocks are published" >&2; exit 1; }

grant_access=$(psql_as ditero_runtime "$DITERO_RUNTIME_DB_PASSWORD" --command "
 select has_column_privilege('key_grant_request', 'state', 'UPDATE')
 and has_column_privilege('key_grant_request', 'granted_at', 'UPDATE')
 and has_column_privilege('key_grant_request', 'failure_reason', 'UPDATE')
 and not has_column_privilege('key_grant_request', 'membership_id', 'UPDATE')
 and not has_column_privilege('key_grant_request', 'user_id', 'UPDATE')
 and not has_column_privilege('key_grant_request', 'workspace_id', 'UPDATE')
 and not has_column_privilege('key_grant_request', 'requested_version', 'UPDATE')
 and has_column_privilege('membership_key', 'enc', 'UPDATE')
 and has_column_privilege('membership_key', 'ciphertext', 'UPDATE')
 and has_column_privilege('membership_key', 'recipient_public_key', 'UPDATE')
 and not has_column_privilege('membership_key', 'id', 'UPDATE')
 and not has_column_privilege('membership_key', 'membership_id', 'UPDATE')
 and not has_column_privilege('membership_key', 'user_id', 'UPDATE')
 and not has_column_privilege('membership_key', 'workspace_id', 'UPDATE')
 and not has_column_privilege('membership_key', 'key_version', 'UPDATE')
 and not has_column_privilege('membership_key', 'granted_by', 'UPDATE')
 and not has_column_privilege('membership_key', 'created_at', 'UPDATE')
 and has_function_privilege('public.prune_focus_intervals()', 'EXECUTE')")
[ "$grant_access" = "t" ] || { echo "runtime key-grant or pruning privileges are incorrect" >&2; exit 1; }
public_execute=$(psql_as postgres "$POSTGRES_PASSWORD" --command "
 select count(*) from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
 where p.oid='public.prune_focus_intervals()'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'
")
[ "$public_execute" = "0" ] || { echo "PUBLIC can prune focus intervals" >&2; exit 1; }

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
