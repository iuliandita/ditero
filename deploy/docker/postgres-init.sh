#!/bin/sh
set -eu

. /usr/local/lib/ditero/secret-file.sh

load_secret DITERO_MIGRATION_DB_PASSWORD required
load_secret DITERO_RUNTIME_DB_PASSWORD required

# zero-cache keeps its per-shard bookkeeping in a schema it creates on first
# boot, owned by whichever role it connects as -- `postgres` here. Both app
# roles have to reach into it:
#
#   - the runtime role, because the push endpoint writes the client's
#     lastMutationID there inside the mutation's own transaction;
#   - the migration role, because zero-cache installs a DDL event trigger that
#     calls into the schema on every migration, and the trigger runs as the
#     role issuing the DDL.
#
# The schema is created here, before zero-cache exists, so the default
# privileges below can be scoped to it: zero-cache then creates its tables
# inside a schema that already grants both roles DML on whatever appears.
# Granting after the fact is not possible from an init script, and
# database-wide default privileges would also hand out the cdc and cvr
# internals neither role touches.
zero_shard_schema=${DITERO_ZERO_SHARD_SCHEMA:-zero_0}

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
	--set=migration_password="$DITERO_MIGRATION_DB_PASSWORD" \
	--set=runtime_password="$DITERO_RUNTIME_DB_PASSWORD" \
	--set=database_name="$POSTGRES_DB" \
	--set=zero_shard_schema="$zero_shard_schema" <<'SQL'
CREATE ROLE ditero_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'migration_password';
CREATE ROLE ditero_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'runtime_password';
ALTER DATABASE :"database_name" OWNER TO ditero_migrator;
ALTER SCHEMA public OWNER TO ditero_migrator;
GRANT CONNECT ON DATABASE :"database_name" TO ditero_runtime;
GRANT USAGE ON SCHEMA public TO ditero_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE ditero_migrator IN SCHEMA public
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ditero_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE ditero_migrator IN SCHEMA public
	GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ditero_runtime;

CREATE SCHEMA :"zero_shard_schema";
GRANT USAGE ON SCHEMA :"zero_shard_schema" TO ditero_runtime, ditero_migrator;
ALTER DEFAULT PRIVILEGES IN SCHEMA :"zero_shard_schema"
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ditero_runtime, ditero_migrator;
ALTER DEFAULT PRIVILEGES IN SCHEMA :"zero_shard_schema"
	GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ditero_runtime, ditero_migrator;
SQL
