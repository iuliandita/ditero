#!/bin/sh
set -eu
PATH=/command:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
case "$1" in
postgres) exec env -i PATH="$PATH" s6-envdir -i -n -L /run/ditero/postgres/env s6-setuidgid postgres postgres -c config_file=/run/ditero/postgres/postgresql.conf ;;
api) cd /app; exec env -i PATH="$PATH" s6-envdir -i -n -L /run/ditero/api/env s6-setuidgid app bun run src/server/index.ts ;;
zero) cd /opt/app; exec env -i PATH="$PATH" s6-envdir -i -n -L /run/ditero/zero/env s6-setuidgid zero zero-cache ;;
*) exit 2 ;;
esac
