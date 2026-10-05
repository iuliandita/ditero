#!/bin/sh
set -eu
umask 077
PATH=/command:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
case "$1" in
pg-ready)
 i=0
 while [ "$i" -lt 60 ]; do
  out=$(timeout 2 env -i PATH="$PATH" s6-setuidgid postgres psql -X -h /run/ditero/postgres -U ditero_pgadmin -d postgres -Atqc "SELECT current_user || '|' || current_database() || '|1'" 2>/dev/null) || out=
  [ "$out" != 'ditero_pgadmin|postgres|1' ] || exit 0
  i=$((i+1)); sleep 1
 done
 exit 1 ;;
role-init)
 state=$(cat /run/ditero/bootstrap/cluster-state)
 [ "$state" != reuse ] || exit 0
 [ "$state" = init ] || exit 1
 env -i PATH="$PATH" s6-envdir -i -n -L /run/ditero/role-init/env s6-setuidgid postgres psql -X -v ON_ERROR_STOP=1 -f /run/ditero/role-init/role-init.sql >/dev/null 2>&1
 tmp=/var/lib/ditero/pg18/.roles-complete.tmp
 (set -C; printf 'roles-complete\n' >"$tmp")
 chown 1001:1001 "$tmp"; chmod 600 "$tmp"; mv "$tmp" /var/lib/ditero/pg18/ditero-init.state ;;
migrate)
 cd /app
 env -i PATH="$PATH" s6-envdir -i -n -L /run/ditero/migrate/env s6-setuidgid app bun run /app/aio/migrate-locked.ts
 # Exact staged ephemeral files only; retain directory for owner checks.
 rm -f /run/ditero/migrate/env/DATABASE_URL /run/ditero/migrate/env/NODE_ENV ;;
api-ready)
 i=0
 while [ "$i" -lt 60 ]; do
  if curl -fsS --max-time 2 --noproxy '*' http://127.0.0.1:3000/health >/dev/null; then
   q=$(curl -sS --max-time 2 --noproxy '*' -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3000/api/zero/query) || q=
   m=$(curl -sS --max-time 2 --noproxy '*' -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3000/api/zero/mutate) || m=
   [ "$q:$m" != 401:401 ] || exit 0
  fi
  i=$((i+1)); sleep 1
 done
 exit 1 ;;
ready)
 i=0
 while [ "$i" -lt 60 ]; do
  out=$(timeout 5 env -i PATH="$PATH" s6-envdir -i -n -L /run/ditero/healthcheck/env psql -X -Atqc "SELECT current_user || '|' || current_database() || '|1'" 2>/dev/null) || out=
  if [ "$out" = 'ditero_runtime|ditero|1' ] && curl -fsS --max-time 3 --noproxy '*' http://127.0.0.1:3000/health >/dev/null && curl -fsS --max-time 3 --noproxy '*' http://127.0.0.1:4848/keepalive >/dev/null; then
   : >/run/ditero/ready; exit 0
  fi
  i=$((i+1)); sleep 1
 done
 exit 1 ;;
unready) rm -f /run/ditero/ready ;;
*) exit 2 ;;
esac
