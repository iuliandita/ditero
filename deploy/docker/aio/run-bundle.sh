#!/bin/sh
# Host lifecycle owner; never mounted into a service container.
set -eu
: "${DITERO_AIO_IMAGE:?Set the immutable bundle image digest}"
printf '%s' "$DITERO_AIO_IMAGE" | grep -Eq '^[-a-zA-Z0-9./_:]+@sha256:[0-9a-f]{64}$' || exit 2
readonly here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
readonly project=${DITERO_AIO_PROJECT:-ditero-aio}
case "$project" in ''|*[!a-z0-9_-]*) exit 2;; esac
compose() { docker compose --project-name "$project" --file "$here/compose.yml" "$@"; }
compose config --quiet
compose_pid=
cleanup() {
 status=$?
 trap - EXIT INT TERM HUP
 compose stop --timeout 30 || { [ "$status" -ne 0 ] || status=1; }
 if [ -n "$compose_pid" ]; then
  kill -TERM "$compose_pid" 2>/dev/null || :
  wait "$compose_pid" 2>/dev/null || :
 fi
 exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
# Background plus builtin wait makes wrapper-only signals immediately observable.
# Successful migration is expected; sustained health failure exits its role nonzero.
docker compose --project-name "$project" --file "$here/compose.yml" up --no-build --pull never --abort-on-container-failure &
compose_pid=$!
status=0
wait "$compose_pid" || status=$?
compose_pid=
exit "$status"
