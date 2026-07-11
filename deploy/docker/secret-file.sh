#!/bin/sh

load_secret() {
	name=$1
	required=${2:-optional}
	eval "value=\${$name:-}"
	eval "file=\${${name}_FILE:-}"

	if [ -n "$value" ] && [ -n "$file" ]; then
		echo "ditero: $name and ${name}_FILE are both set" >&2
		return 1
	fi

	if [ -n "$file" ]; then
		if [ ! -f "$file" ] || [ ! -r "$file" ]; then
			echo "ditero: ${name}_FILE is not a readable file" >&2
			return 1
		fi
		value=$(cat "$file")
		if [ -z "$value" ]; then
			echo "ditero: ${name}_FILE is empty" >&2
			return 1
		fi
		export "${name}=${value}"
	fi

	if [ "$required" = required ] && [ -z "$value" ]; then
		echo "ditero: $name is required (or set ${name}_FILE)" >&2
		return 1
	fi
}
