#!/bin/sh
set -eu

image=ditero-zero-smoke
docker build --file deploy/docker/Dockerfile --target zero-runtime --tag "$image" . >/dev/null

entrypoint=$(docker image inspect --format '{{json .Config.Entrypoint}}' "$image")
command=$(docker image inspect --format '{{json .Config.Cmd}}' "$image")
if [ "$entrypoint" != '["/usr/local/bin/ditero-zero-entrypoint"]' ]; then
	echo "unexpected Zero entrypoint: $entrypoint" >&2
	exit 1
fi
if [ "$command" != '["zero-cache"]' ]; then
	echo "unexpected Zero command: $command" >&2
	exit 1
fi

if output=$(docker run --rm "$image" 2>&1); then
	echo "Zero image started without required secrets" >&2
	exit 1
fi
if ! printf '%s\n' "$output" | grep -q "POSTGRES_PASSWORD is required"; then
	printf '%s\n' "$output" >&2
	exit 1
fi

docker run --rm --network none --entrypoint node \
	--mount "type=bind,src=$(pwd)/tests/container/zero-undici.mjs,dst=/tmp/zero-undici.mjs,readonly" \
	"$image" /tmp/zero-undici.mjs

tests/container/zero-backup.sh "$image"
