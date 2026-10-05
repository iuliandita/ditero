#!/bin/sh
# Root preparation and empty-only initdb wrapper for the all-in-one image.
#
# Not a supervisor. Does not start PostgreSQL, run SQL, or run migrations.
# Steps: check prerequisites, run `config.mjs prepare` (validates every input
# before writing anything, stages /run, adopts proven-empty volumes), then on a
# fresh cluster only run initdb as the postgres UID with --pwfile. An existing
# cluster is left untouched. Nothing is replayed after an interrupted init.
set -eu
umask 077

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

readonly PG_UID=1001
readonly PG_GID=1001
readonly PG_OS_USER=postgres
readonly ADMIN_ROLE=ditero_pgadmin
readonly RUN_DIR=/run/ditero
readonly PG_TOP=/var/lib/ditero/pg18
readonly PG_DATA=$PG_TOP/data
readonly PG_STATE=$PG_TOP/ditero-init.state
readonly PWFILE=$RUN_DIR/postgres/initdb-password
readonly CLUSTER_STATE=$RUN_DIR/bootstrap/cluster-state

die() {
	echo "ditero-bootstrap: $1" >&2
	exit 1
}

# The initdb password file must never outlive this script.
trap 'rm -f -- "$PWFILE"' EXIT

[ "$(id -u)" = 0 ] || die "must run as root"

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
config=$script_dir/config.mjs
[ -f "$config" ] || die "config.mjs not found next to bootstrap.sh"

if command -v node >/dev/null 2>&1; then
	js=node
elif command -v bun >/dev/null 2>&1; then
	js=bun
else
	die "neither node nor bun found"
fi

for tool in s6-setuidgid initdb env; do
	command -v "$tool" >/dev/null 2>&1 || die "$tool not found"
done
initdb_bin=$(command -v initdb)

# Build-time collision checks are separate; this only refuses a wrong account.
[ "$(id -u "$PG_OS_USER" 2>/dev/null)" = "$PG_UID" ] ||
	die "account $PG_OS_USER must have uid $PG_UID"
[ "$(id -g "$PG_OS_USER" 2>/dev/null)" = "$PG_GID" ] ||
	die "account $PG_OS_USER must have gid $PG_GID"

case $("$initdb_bin" --version) in
*"(PostgreSQL) 18."*) ;;
*) die "initdb is not PostgreSQL major 18" ;;
esac

"$js" "$config" prepare

[ -f "$CLUSTER_STATE" ] && [ ! -L "$CLUSTER_STATE" ] ||
	die "config.mjs did not record a cluster state"
state=$(cat "$CLUSTER_STATE")
case $state in
reuse)
	echo "ditero-bootstrap: existing PostgreSQL 18 cluster, no initialisation"
	exit 0
	;;
init) ;;
*) die "unrecognised cluster state" ;;
esac

# Atomic marker update inside the (now postgres-owned, still unused) top
# directory. No PostgreSQL process exists yet, so nothing can race the rename.
write_marker() {
	tmp=$PG_TOP/.ditero-init.state.tmp
	rm -f -- "$tmp"
	(
		set -C
		printf '%s\n' "$1" >"$tmp"
	)
	chown -h "$PG_UID:$PG_GID" "$tmp"
	mv -f -- "$tmp" "$PG_STATE"
}

[ -f "$PWFILE" ] && [ ! -L "$PWFILE" ] || die "initdb password file was not staged"

write_marker initdb-started

s6-setuidgid "$PG_OS_USER" env -i PATH="$PATH" HOME="$RUN_DIR/postgres" \
	"$initdb_bin" \
	--pgdata="$PG_DATA" \
	--username="$ADMIN_ROLE" \
	--pwfile="$PWFILE" \
	--auth-local=peer \
	--auth-host=scram-sha-256 \
	--encoding=UTF8 \
	--locale-provider=builtin \
	--locale=C.UTF-8 \
	--no-instructions

[ "$(cat "$PG_DATA/PG_VERSION")" = 18 ] || die "initdb produced an unexpected PG_VERSION"

rm -f -- "$PWFILE"
write_marker initdb-complete
echo "ditero-bootstrap: initialised new PostgreSQL 18 cluster"
