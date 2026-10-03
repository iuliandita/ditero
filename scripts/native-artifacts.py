#!/usr/bin/env python3
"""Collect one native package of each expected kind under stable release names."""

import argparse
from pathlib import Path
import re
import shutil
import sys


PACKAGES = {
    "linux": (
        "linux-x64-unsigned",
        "apps/desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle",
        (("deb/*.deb", "deb"), ("appimage/*.AppImage", "AppImage")),
    ),
    "windows": (
        "windows-x64-unsigned",
        "apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle",
        (("nsis/*.exe", "exe"),),
    ),
    "macos": (
        "macos-arm64-adhoc",
        "apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle",
        (("dmg/*.dmg", "dmg"),),
    ),
    "android": (
        "android-independent-universal-signed",
        "apps/android/android/app/build/outputs",
        (
            ("apk/independent/release/*.apk", "apk"),
            ("bundle/independentRelease/*.aab", "aab"),
        ),
    ),
}
VERSION = re.compile(
    r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?"
)


def collect(root: Path, output: Path, platform: str, version: str) -> list[Path]:
    if not VERSION.fullmatch(version):
        raise ValueError("release version must be semantic without a v prefix or build metadata")
    label, directory, kinds = PACKAGES[platform]
    sources = []
    for pattern, extension in kinds:
        matches = sorted((root / directory).glob(pattern))
        if len(matches) != 1:
            raise ValueError(f"expected exactly one {platform} {extension} package, found {len(matches)}")
        source = matches[0]
        if source.is_symlink() or not source.is_file() or source.stat().st_size == 0:
            raise ValueError(f"{platform} {extension} package must be a nonempty regular file")
        sources.append((source, output / f"ditero-{version}-{label}.{extension}"))
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError("artifact output directory must be empty")
    output.mkdir(parents=True, exist_ok=True)
    for source, destination in sources:
        shutil.copyfile(source, destination)
    return [destination for _, destination in sources]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", required=True, choices=PACKAGES)
    parser.add_argument("--version", required=True)
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        for artifact in collect(args.root, args.output, args.platform, args.version):
            print(artifact.name)
    except (OSError, ValueError) as error:
        print(f"native artifact collection failed: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
