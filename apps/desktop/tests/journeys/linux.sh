#!/usr/bin/env bash
set -euo pipefail
unset WAYLAND_DISPLAY
export GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1
eval "$(printf 'journey-keyring' | gnome-keyring-daemon --unlock --components=secrets)"
export GNOME_KEYRING_CONTROL
openbox > "$RUNNER_TEMP/desktop-journeys/evidence/openbox.log" 2>&1 &
window_manager=$!
dunst -config apps/desktop/tests/journeys/dunstrc > "$RUNNER_TEMP/desktop-journeys/evidence/dunst.log" 2>&1 &
notifications=$!
trap 'kill "$window_manager" "$notifications" 2>/dev/null || true' EXIT
node --experimental-strip-types apps/desktop/tests/journeys/run.ts
