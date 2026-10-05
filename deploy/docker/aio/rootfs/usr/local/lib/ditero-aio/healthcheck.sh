#!/bin/sh
# Bounded, read-only combined healthcheck for the all-in-one image.
#
# Checks, in order, and fails closed on the first miss:
#   1. the graph-created readiness marker exists;
#   2. PostgreSQL answers as the non-admin runtime role on the loopback;
#   3. the API health route answers on the loopback;
#   4. zero-cache /keepalive answers on the loopback.
# The marker is a precondition, not proof of anything. Nothing here is a ready
# default: the graph must qualify readiness before creating the marker.
set -eu
umask 077

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

readonly READY_MARKER=/run/ditero/ready
readonly ENV_DIR=/run/ditero/healthcheck/env
readonly EXPECTED='ditero_runtime|ditero|1'
readonly API_BASE=http://127.0.0.1:3000
# Process health only; combined checks and graph readiness are still required.
readonly API_HEALTH_PATH=/health
# Existing zero-cache route, as used by the current compose healthcheck.
readonly ZERO_KEEPALIVE=http://127.0.0.1:4848/keepalive

fail() {
	echo "ditero-healthcheck: $1" >&2
	exit 1
}

[ -f "$READY_MARKER" ] && [ ! -L "$READY_MARKER" ] || fail "readiness marker is absent"

# Strict envdir presence, preserved trailing spaces and bounded config values.
# Clear ambient credentials before loading the runtime-role dictionary.
out=$(timeout 5 env -i PATH="$PATH" s6-envdir -i -n -L "$ENV_DIR" \
	psql -X -Atqc "SELECT current_user || '|' || current_database() || '|' || (SELECT 1)" \
	2>/dev/null) || fail "database check failed"
[ "$out" = "$EXPECTED" ] || fail "database identity check did not match"

curl --silent --show-error --fail --max-time 3 --noproxy '*' --output /dev/null \
	"$API_BASE$API_HEALTH_PATH" || fail "API health check failed"

curl --silent --show-error --fail --max-time 3 --noproxy '*' --output /dev/null \
	"$ZERO_KEEPALIVE" || fail "zero-cache keepalive failed"
