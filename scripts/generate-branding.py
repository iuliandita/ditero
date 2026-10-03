#!/usr/bin/env python3
"""Generate installed app assets from the approved Fridge Door PNG.

Requires Python 3 and ImageMagick 7. Run from any directory; no package install.
PNG metadata is stripped so unchanged source reproduces identical output bytes.
"""

import argparse
from pathlib import Path
import struct
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets/brand/ditero-symbol-teal.png"
BACKGROUND = "#F2F1ED"


def run(*args: str) -> None:
    subprocess.run(["magick", *args], check=True)


def raster(target: Path, width: int, height: int, symbol: int,
           background: str = "none", radius: int = 0, monochrome: bool = False) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    canvas = ["-size", f"{width}x{height}", "xc:transparent"]
    if background != "none":
        canvas += ["-fill", background, "-draw",
                   f"roundrectangle 0,0 {width - 1},{height - 1} {radius},{radius}"]
    mark = ["(", str(SOURCE)]
    if monochrome:
        mark += ["-fill", "white", "-colorize", "100"]
    mark += ["-resize", f"{symbol}x{symbol}", ")"]
    run(*canvas, *mark, "-gravity", "center", "-compose", "over", "-composite",
        "-strip", "-define", "png:exclude-chunks=date,time", f"PNG32:{target}")


def generate(root: Path) -> None:
    android = root / "apps/android/android/app/src/main/res"
    desktop = root / "apps/desktop/src-tauri/icons"
    for size in (192, 512):
        raster(root / f"public/icon-{size}.png", size, size, round(size * 0.8),
               BACKGROUND, round(size / 4))
    for name, size in (("32x32", 32), ("128x128", 128), ("128x128@2x", 256), ("icon", 512)):
        raster(desktop / f"{name}.png", size, size, round(size * 0.8),
               BACKGROUND, round(size / 4))

    # PNG-compressed ICO entries and ICNS modern PNG elements are native container formats.
    with tempfile.TemporaryDirectory() as temporary:
        images = {}
        for size in (16, 32, 48, 64, 128, 256, 512, 1024):
            path = Path(temporary) / f"{size}.png"
            raster(path, size, size, round(size * 0.8), BACKGROUND, round(size / 4))
            images[size] = path.read_bytes()
        sizes = (16, 32, 48, 64, 128, 256)
        offset = 6 + 16 * len(sizes)
        entries = []
        for size in sizes:
            data = images[size]
            entries.append(struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0,
                                       1, 32, len(data), offset))
            offset += len(data)
        (desktop / "icon.ico").write_bytes(struct.pack("<HHH", 0, 1, len(sizes)) +
                                           b"".join(entries) + b"".join(images[s] for s in sizes))
        chunks = []
        for kind, size in ((b"icp4", 16), (b"icp5", 32), (b"icp6", 64), (b"ic07", 128),
                           (b"ic08", 256), (b"ic09", 512), (b"ic10", 1024)):
            data = images[size]
            chunks.append(kind + struct.pack(">I", len(data) + 8) + data)
        body = b"".join(chunks)
        (desktop / "icon.icns").write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)

    for density, scale in (("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2),
                           ("xxhdpi", 3), ("xxxhdpi", 4)):
        size, adaptive = round(48 * scale), round(108 * scale)
        folder = android / f"mipmap-{density}"
        raster(folder / "ic_launcher.png", size, size, round(size * 0.8), BACKGROUND)
        raster(folder / "ic_launcher_round.png", size, size, round(size * 0.8),
               BACKGROUND, round(size / 2))
        # The source's transparent margins keep its 60dp canvas inside the 66dp safe circle.
        raster(folder / "ic_launcher_foreground.png", adaptive, adaptive, round(60 * scale))
        raster(android / f"drawable-{density}/ic_notification.png",
               round(24 * scale), round(24 * scale), round(24 * scale), monochrome=True)

    (android / "values").mkdir(parents=True, exist_ok=True)
    (android / "drawable").mkdir(parents=True, exist_ok=True)
    (android / "values/ic_launcher_background.xml").write_text(
        f'<resources>\n  <color name="ic_launcher_background">{BACKGROUND}</color>\n</resources>\n')
    (android / "drawable/ic_launcher_background.xml").write_text(
        '<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">\n'
        f'  <solid android:color="{BACKGROUND}"/>\n</shape>\n')
    for old in ("drawable/ic_notification.xml", "drawable-v24/ic_launcher_foreground.xml"):
        (android / old).unlink(missing_ok=True)

    splashes = [("drawable", 480, 320, 96)]
    for density, width, height, logo in (("mdpi", 480, 320, 96), ("hdpi", 800, 480, 144),
                                        ("xhdpi", 1280, 720, 192), ("xxhdpi", 1600, 960, 288),
                                        ("xxxhdpi", 1920, 1280, 384)):
        splashes.append((f"drawable-land-{density}", width, height, logo))
    for density, width, height, logo in (("mdpi", 320, 480, 96), ("hdpi", 480, 800, 144),
                                        ("xhdpi", 720, 1280, 192), ("xxhdpi", 960, 1600, 288),
                                        ("xxxhdpi", 1280, 1920, 384)):
        splashes.append((f"drawable-port-{density}", width, height, logo))
    for folder, width, height, logo in splashes:
        raster(android / folder / "splash.png", width, height, logo, "white")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", type=Path, default=ROOT,
                        help="Generate under another directory for isolated verification.")
    generate(parser.parse_args().output_root)
    print("Generated PWA, desktop, Android launcher, splash, and notification assets.")
