#!/bin/sh
set -eu

. /usr/local/lib/ditero/secret-file.sh

load_secret DITERO_MIGRATION_DB_PASSWORD required
load_secret DITERO_RUNTIME_DB_PASSWORD required

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
	--set=migration_password="$DITERO_MIGRATION_DB_PASSWORD" \
	--set=runtime_password="$DITERO_RUNTIME_DB_PASSWORD" \
	--set=database_name="$POSTGRES_DB" <<'SQL'
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
SQL
