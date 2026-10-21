#!/usr/bin/env bash
set -euo pipefail
out="$RUNNER_TEMP/desktop-journeys"
bundle="apps/desktop/src-tauri/target/$DESKTOP_TARGET/debug/bundle"
if [[ "$RUNNER_OS" == Linux ]]; then
  packages=("$bundle"/deb/*.deb)
  test "${#packages[@]}" -eq 1
  sudo apt-get install -y "$(realpath "${packages[0]}")"
  application=/usr/bin/ditero-desktop
else
  packages=("$bundle"/dmg/*.dmg)
  test "${#packages[@]}" -eq 1
  mkdir -p "$out/mount" "$HOME/Applications"
  { yes || true; } | PAGER=cat hdiutil attach "${packages[0]}" -nobrowse -readonly -mountpoint "$out/mount"
  ditto "$out/mount/Ditero.app" "$HOME/Applications/Ditero.app"
  hdiutil detach "$out/mount"
  codesign --verify --deep --strict "$HOME/Applications/Ditero.app"
  codesign -d --verbose=4 "$HOME/Applications/Ditero.app" > "$out/evidence/installed-signature.txt" 2>&1
  sw_vers > "$out/evidence/installed-system.txt"
  application="$HOME/Applications/Ditero.app/Contents/MacOS/ditero-desktop"
  cmp "$application" "$bundle/macos/Ditero.app/Contents/MacOS/ditero-desktop"
fi
if [[ "$RUNNER_OS" == Linux ]]; then
  cmp "$application" "apps/desktop/src-tauri/target/$DESKTOP_TARGET/debug/ditero-desktop"
fi
export JOURNEY_APPLICATION="$application"
python3 - <<'PY'
import json, os, pathlib
pathlib.Path(os.environ['RUNNER_TEMP'], 'desktop-journeys/installed.json').write_text(json.dumps({'application':os.environ['JOURNEY_APPLICATION']}))
PY
