#!/bin/sh
set -eu

. /usr/local/lib/ditero/secret-file.sh

load_secret ZERO_UPSTREAM_DB optional
load_secret ZERO_CVR_DB optional
load_secret ZERO_CHANGE_DB optional
if [ -z "${ZERO_UPSTREAM_DB:-}" ]; then
	load_secret POSTGRES_PASSWORD required
	ZERO_UPSTREAM_DB=$(node -e 'process.stdout.write(`postgres://postgres:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@upstream-db:5432/ditero`)')
	export ZERO_UPSTREAM_DB
fi
export ZERO_CVR_DB="${ZERO_CVR_DB:-$ZERO_UPSTREAM_DB}"
export ZERO_CHANGE_DB="${ZERO_CHANGE_DB:-$ZERO_UPSTREAM_DB}"
load_secret ZERO_ADMIN_PASSWORD required

# Do not let Zero's invalid-URL diagnostics print credentials.
node -e '
for (const name of ["ZERO_UPSTREAM_DB", "ZERO_CVR_DB", "ZERO_CHANGE_DB"]) {
  try {
    const url = new URL(process.env[name]);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) throw new Error();
  } catch {
    console.error(`ditero: invalid ${name}; use a PostgreSQL URL with percent-encoded credentials`);
    process.exit(1);
  }
}'

exec "$@"
