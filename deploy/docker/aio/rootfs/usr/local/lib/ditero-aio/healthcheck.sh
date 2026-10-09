#!/bin/sh
set -eu
[ "$#" = 1 ] || exit 2
exec node /usr/local/lib/ditero-aio/config.mjs health "$1"
