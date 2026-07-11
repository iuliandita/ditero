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
