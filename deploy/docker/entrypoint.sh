#!/bin/sh
# Apply pending migrations, then start the Ditero server. DATABASE_URL must
# point at a reachable Postgres (bundled or external).
set -eu

. ./secret-file.sh

load_secret DATABASE_URL optional
if [ -z "${DATABASE_URL:-}" ]; then
	load_secret DITERO_RUNTIME_DB_PASSWORD required
	DATABASE_URL=$(bun -e 'process.stdout.write(`postgres://ditero_runtime:${encodeURIComponent(process.env.DITERO_RUNTIME_DB_PASSWORD)}@upstream-db:5432/ditero`)')
	export DATABASE_URL
fi
load_secret DATABASE_MIGRATION_URL optional
if [ -z "${DATABASE_MIGRATION_URL:-}" ]; then
	load_secret DITERO_MIGRATION_DB_PASSWORD required
	DATABASE_MIGRATION_URL=$(bun -e 'process.stdout.write(`postgres://ditero_migrator:${encodeURIComponent(process.env.DITERO_MIGRATION_DB_PASSWORD)}@upstream-db:5432/ditero`)')
	export DATABASE_MIGRATION_URL
fi
load_secret BETTER_AUTH_SECRET required
load_secret GOOGLE_CLIENT_SECRET optional
load_secret DITERO_ENCRYPTION_KEY required
load_secret DITERO_ENCRYPTION_KEY_NEXT optional
load_secret DITERO_ATTACHMENT_S3_ACCESS_KEY_ID optional
load_secret DITERO_ATTACHMENT_S3_SECRET_ACCESS_KEY optional

echo "ditero: running database migrations..."
DATABASE_URL="$DATABASE_MIGRATION_URL" bun run db:migrate
unset DATABASE_MIGRATION_URL DITERO_MIGRATION_DB_PASSWORD

echo "ditero: starting server..."
exec bun run src/server/index.ts
