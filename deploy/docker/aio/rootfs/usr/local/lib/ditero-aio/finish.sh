#!/bin/sh
set -eu
PATH=/command:/usr/bin:/bin
rm -f /run/ditero/ready
# Official wantedup distinguishes requested shutdown from essential-child death.
wanted=$(s6-svstat -o wantedup .) || wanted=unknown
if [ "$wanted" = false ]; then exit 0; fi
printf '1\n' >/run/s6-linux-init-container-results/exitcode || printf 'ditero: cannot record failure exit code\n' >&2
/run/s6/basedir/bin/halt
exit 125
