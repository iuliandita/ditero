#!/usr/bin/env bash
# Runs a desktop build command from apps/desktop. On macOS only, retries (3 attempts total)
# when the attempt's output carries the hdiutil eject/busy signature. Any other failure exits
# immediately with its status; exhausting the attempts exits with the last status.
set -Eeuo pipefail

[[ ${1:-} == -- ]] && shift
[[ $# -gt 0 ]] || { echo "usage: desktop-tauri-build.sh -- <build command...>" >&2; exit 2; }

max_attempts=3
target_dir="src-tauri/target/${DESKTOP_TARGET:?DESKTOP_TARGET required}"
volumes_dir=${DESKTOP_VOLUMES_DIR:-/Volumes}
attempt_log=$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/desktop-tauri-build.XXXXXX")
trap 'rm -f "$attempt_log"' EXIT

cleanup_dmg() {
  local volume stale
  for volume in "$volumes_dir"/dmg.*; do
    [[ -d $volume ]] || continue
    hdiutil detach -force "$volume" || echo "could not detach $volume" >&2
  done
  while IFS= read -r -d '' stale; do
    rm -f -- "$stale"
  done < <(find "$target_dir" -path '*/bundle/macos/rw.*.dmg' -type f -print0 2>/dev/null)
}

attempt=1
while true; do
  set +e
  "$@" 2>&1 | tee "$attempt_log"
  status=${PIPESTATUS[0]}
  set -e
  [[ $status -eq 0 ]] && exit 0
  if [[ ${RUNNER_OS:-} == macOS && $attempt -lt $max_attempts ]] \
    && grep -q "couldn't eject" "$attempt_log" && grep -q 'Resource busy' "$attempt_log"; then
    echo "hdiutil eject busy (attempt $attempt of $max_attempts, status $status); cleaning up and retrying" >&2
    cleanup_dmg
    attempt=$((attempt + 1))
    continue
  fi
  exit "$status"
done
