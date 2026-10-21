#!/bin/sh
set -eu

pg_isready --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" >/dev/null
missing=$(psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
	--username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
SELECT string_agg(required.name, ', ' ORDER BY required.name)
FROM (VALUES ('ditero_migrator'), ('ditero_runtime')) AS required(name)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = required.name);
SQL
)
if [ -n "$missing" ]; then
	echo "ditero: incomplete bundled database initialization; missing role(s): $missing. Fix secret readability and restore or reinitialize the database; see docs/runbooks/database-roles.md" >&2
	exit 1
fi
