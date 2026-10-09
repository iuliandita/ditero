#!/bin/sh
# PostgreSQL-owner initialization; retained state is never repaired or replayed.
set -eu
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly top=/var/lib/ditero/pg18
readonly data=$top/data
readonly run=/run/ditero/postgres
readonly state=$top/ditero-init.state
[ "$(id -u):$(id -g)" = 1001:1001 ] || exit 1
started=false
cleanup() {
 if [ "$started" = true ]; then timeout 20 pg_ctl -D "$data" -m fast -w stop >/dev/null 2>&1 || return 1; fi
 rm -f "$run/initdb-password" "$run/role-init.sql"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
marker() {
 (set -C; printf '%s\n' "$1" >"$top/.ditero-init.state.tmp")
 mv "$top/.ditero-init.state.tmp" "$state"
}
case $(cat /run/ditero/cluster-state) in
 init)
  marker initdb-started
  initdb --pgdata="$data" --username=ditero_pgadmin --pwfile="$run/initdb-password" --auth-local=peer --auth-host=scram-sha-256 --encoding=UTF8 --locale-provider=builtin --locale=C.UTF-8 --no-instructions
  rm "$run/initdb-password"
  marker initdb-complete
  started=true
  timeout 30 pg_ctl -D "$data" -o "-c config_file=$run/postgresql.conf -c listen_addresses=''" -w start
  timeout 30 psql -X -v ON_ERROR_STOP=1 -f "$run/role-init.sql" >/dev/null 2>&1
  cleanup
  started=false
  marker roles-complete
  ;;
 reuse) ;;
 *) exit 1 ;;
esac
trap - EXIT HUP INT TERM
# Bootstrap credentials do not enter the steady PostgreSQL environment.
exec env -i PATH="$PATH" HOME=/run/ditero postgres -c config_file="$run/postgresql.conf"
