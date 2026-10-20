#!/usr/bin/env bash
# Bounded packaging checks; no account, server or credential-store qualification.
set -euo pipefail

if [[ ${1:-} == --linux-launch ]]; then
  unset WAYLAND_DISPLAY
  export GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1
  "$2" >"$3/startup-$4.log" 2>&1 &
  pid=$!
  trap 'kill "$pid" 2>/dev/null || true' EXIT
  sleep 20
  kill -0 "$pid"
  xwininfo -root -tree >"$3/window-$4.txt"
  grep -q '"Ditero"' "$3/window-$4.txt"
  exit
fi

platform=${1:?platform required}
target=${2:?Rust target required}
profile=${3:?build profile required}
case "$profile" in debug|release) ;; *) exit 1 ;; esac
repo=$(cd "$(dirname "$0")/.." && pwd)
bundle="$repo/apps/desktop/src-tauri/target/$target/$profile/bundle"
out="${RUNNER_TEMP:?}/desktop-smoke"
mkdir -p "$out"

one_package() {
  local matches=("$bundle/$1/"*".$2")
  [[ ${#matches[@]} == 1 && -s "${matches[0]}" ]]
  printf '%s\n' "${matches[0]}"
}

linux_contents() {
  local root=$1
  for path in usr/bin/ditero-desktop \
    usr/share/metainfo/io.ditero.desktop.metainfo.xml \
    usr/share/applications/io.ditero.desktop.desktop \
    usr/share/icons/hicolor/128x128/apps/io.ditero.desktop.png \
    usr/share/doc/ditero-desktop/LICENSE; do
    test -s "$root/$path"
  done
  cmp "$root/usr/share/metainfo/io.ditero.desktop.metainfo.xml" \
    "$repo/apps/desktop/linux/io.ditero.desktop.metainfo.xml"
  cmp "$root/usr/share/doc/ditero-desktop/LICENSE" "$repo/LICENSE"
  file "$root/usr/bin/ditero-desktop"
  readelf -h "$root/usr/bin/ditero-desktop" | tee "$out/elf-$(basename "$root").txt"
  grep -q 'Advanced Micro Devices X86-64' "$out/elf-$(basename "$root").txt"
}

linux_launch() {
  local command=$1 label=$2
  mkdir -p "$out/home-$label"
  # Separate D-Bus and HOME prevent the single-instance/vault state crossing runs.
  HOME="$out/home-$label" xvfb-run -a dbus-run-session -- \
    bash "$repo/scripts/desktop-smoke.sh" --linux-launch "$command" "$out" "$label"
}

case "$platform" in
  linux)
    [[ "$target" == x86_64-unknown-linux-gnu ]]
    deb=$(one_package deb deb)
    rpm=$(one_package rpm rpm)
    image=$(one_package appimage AppImage)
    mkdir "$out/deb" "$out/rpm" "$out/appimage"
    dpkg-deb -x "$deb" "$out/deb"
    (cd "$out/rpm" && rpm2cpio "$rpm" | cpio -idm --quiet)
    chmod +x "$image"
    (cd "$out/appimage" && "$image" --appimage-extract >"$out/appimage-contents.txt")
    linux_contents "$out/deb"
    linux_contents "$out/rpm"
    linux_contents "$out/appimage/squashfs-root"
    # DEB dependency resolution and installation are checked on the build baseline.
    sudo apt-get install --no-install-recommends -y "$deb"
    linux_launch /usr/bin/ditero-desktop deb
    # RPM payload runs against Ubuntu libraries; RPM-distro installation is separate.
    linux_launch "$out/rpm/usr/bin/ditero-desktop" rpm
    linux_launch "$out/appimage/squashfs-root/AppRun" appimage
    ;;
  macos)
    case "$target" in
      aarch64-apple-darwin) arch=arm64 ;;
      x86_64-apple-darwin) arch=x86_64 ;;
      *) exit 1 ;;
    esac
    dmg=$(one_package dmg dmg)
    mount="$out/mounted"
    mkdir "$mount"
    hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$dmg"
    trap 'hdiutil detach "$mount"' EXIT
    ditto "$mount/Ditero.app" "$out/Ditero.app"
    hdiutil detach "$mount"
    trap - EXIT
    app="$out/Ditero.app"
    binary="$app/Contents/MacOS/ditero-desktop"
    codesign --verify --deep --strict --verbose=2 "$app"
    codesign -dv "$app" 2>"$out/codesign.txt"
    grep -q 'Signature=adhoc' "$out/codesign.txt"
    lipo -verify_arch "$arch" "$binary"
    file "$binary" | tee "$out/binary.txt"
    "$binary" >"$out/startup.log" 2>&1 &
    pid=$!
    trap 'kill "$pid" 2>/dev/null || true' EXIT
    sleep 20
    kill -0 "$pid"
    ;;
  *) echo "Unknown platform: $platform" >&2; exit 1 ;;
esac
