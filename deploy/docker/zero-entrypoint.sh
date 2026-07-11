#!/bin/sh
set -eu

. /usr/local/lib/ditero/secret-file.sh

load_secret ZERO_UPSTREAM_DB optional
load_secret ZERO_CVR_DB optional
load_secret ZERO_CHANGE_DB optional
if [ -z "${ZERO_UPSTREAM_DB:-}" ]; then
	load_secret POSTGRES_PASSWORD required
	export ZERO_UPSTREAM_DB="postgres://postgres:${POSTGRES_PASSWORD}@upstream-db:5432/ditero"
fi
export ZERO_CVR_DB="${ZERO_CVR_DB:-$ZERO_UPSTREAM_DB}"
export ZERO_CHANGE_DB="${ZERO_CHANGE_DB:-$ZERO_UPSTREAM_DB}"
load_secret ZERO_ADMIN_PASSWORD required

exec "$@"
