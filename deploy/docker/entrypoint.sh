#!/bin/sh
# Apply pending migrations, then start the Ditero server. DATABASE_URL must
# point at a reachable Postgres (bundled or external).
set -eu

echo "ditero: running database migrations..."
bun run db:migrate

echo "ditero: starting server..."
exec bun run src/server/index.ts
