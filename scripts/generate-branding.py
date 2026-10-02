#!/usr/bin/env python3
"""Generate installed app assets from assets/branding/icon.svg.

Requires Python 3 and ImageMagick 7. Run from any directory; no package install.
PNG metadata is stripped so unchanged source reproduces identical output bytes.
"""

from pathlib import Path
import struct
import subprocess
import tempfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets/branding/icon.svg"
ANDROID = ROOT / "apps/android/android/app/src/main/res"
DESKTOP = ROOT / "apps/desktop/src-tauri/icons"
NS = "{http://www.w3.org/2000/svg}"
svg = ET.parse(SOURCE).getroot()
background = svg.find(f"{NS}rect").get("fill")
mark = svg.find(f"{NS}g")
paths = [path.get("d") for path in mark]
foreground = mark.get("stroke")
stroke = mark.get("stroke-width")


def run(*args: str) -> None:
    subprocess.run(["magick", *args], check=True)


def raster(source: str, target: Path, width: int, height: int) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".svg", mode="w") as temporary:
        temporary.write(source)
        temporary.flush()
        run("-background", "none", temporary.name, "-resize", f"{width}x{height}!",
            "-strip", "-define", "png:exclude-chunks=date,time", f"PNG32:{target}")


def tile(radius: int = 12) -> str:
    root = ET.fromstring(SOURCE.read_text())
    root.find(f"{NS}rect").set("rx", str(radius))
    return ET.tostring(root, encoding="unicode")


def vector(width: int, viewport: int, scale: float, offset: float,
           color: str) -> str:
    elements = "\n".join(
        f'    <path android:fillColor="#00000000" android:strokeColor="{color}" '
        f'android:strokeWidth="{stroke}" android:strokeLineCap="round" '
        f'android:strokeLineJoin="round" android:pathData="{path}"/>' for path in paths
    )
    return (f'<vector xmlns:android="http://schemas.android.com/apk/res/android" '
            f'android:width="{width}dp" android:height="{width}dp" '
            f'android:viewportWidth="{viewport}" android:viewportHeight="{viewport}">\n'
            f'  <group android:scaleX="{scale}" android:scaleY="{scale}" '
            f'android:translateX="{offset}" android:translateY="{offset}">\n'
            f'{elements}\n  </group>\n</vector>\n')


for size in (192, 512):
    raster(tile(), ROOT / f"public/icon-{size}.png", size, size)
for name, size in (("32x32", 32), ("128x128", 128), ("128x128@2x", 256), ("icon", 512)):
    raster(tile(), DESKTOP / f"{name}.png", size, size)

# PNG-compressed ICO entries and ICNS modern PNG elements are native container formats.
with tempfile.TemporaryDirectory() as temporary:
    images = {}
    for size in (16, 32, 48, 64, 128, 256, 512, 1024):
        path = Path(temporary) / f"{size}.png"
        raster(tile(), path, size, size)
        images[size] = path.read_bytes()
    sizes = (16, 32, 48, 64, 128, 256)
    offset = 6 + 16 * len(sizes)
    entries = []
    for size in sizes:
        data = images[size]
        entries.append(struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0,
                                   1, 32, len(data), offset))
        offset += len(data)
    (DESKTOP / "icon.ico").write_bytes(struct.pack("<HHH", 0, 1, len(sizes)) +
                                      b"".join(entries) + b"".join(images[s] for s in sizes))
    chunks = []
    for kind, size in ((b"icp4", 16), (b"icp5", 32), (b"icp6", 64), (b"ic07", 128),
                       (b"ic08", 256), (b"ic09", 512), (b"ic10", 1024)):
        data = images[size]
        chunks.append(kind + struct.pack(">I", len(data) + 8) + data)
    body = b"".join(chunks)
    (DESKTOP / "icon.icns").write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)

for density, size, adaptive in (("mdpi", 48, 108), ("hdpi", 72, 162),
                                ("xhdpi", 96, 216), ("xxhdpi", 144, 324),
                                ("xxxhdpi", 192, 432)):
    folder = ANDROID / f"mipmap-{density}"
    raster(tile(0), folder / "ic_launcher.png", size, size)
    raster(tile(24), folder / "ic_launcher_round.png", size, size)
    # 48dp mark inside the adaptive 108dp canvas stays within its 66dp safe zone.
    root = ET.fromstring(SOURCE.read_text())
    root.remove(root.find(f"{NS}rect"))
    root.set("viewBox", "0 0 108 108")
    root.find(f"{NS}g").set("transform", "translate(30 30) scale(2)")
    raster(ET.tostring(root, encoding="unicode"), folder / "ic_launcher_foreground.png",
           adaptive, adaptive)

(ANDROID / "drawable-v24/ic_launcher_foreground.xml").write_text(
    vector(108, 108, 2, 30, foreground))
(ANDROID / "drawable/ic_notification.xml").write_text(vector(24, 24, 1, 0, "#FFFFFF"))
(ANDROID / "drawable/ic_launcher_background.xml").write_text(
    '<vector xmlns:android="http://schemas.android.com/apk/res/android" '
    'android:width="108dp" android:height="108dp" '
    'android:viewportWidth="108" android:viewportHeight="108">\n'
    f'  <path android:fillColor="{background}" android:pathData="M0,0h108v108h-108z"/>\n'
    '</vector>\n')
(ANDROID / "values/ic_launcher_background.xml").write_text(
    f'<resources>\n  <color name="ic_launcher_background">{background}</color>\n</resources>\n')

# Preserve existing canvas dimensions, with a centered brand tile on white.
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
    inner = SOURCE.read_text().split(">", 1)[1].rsplit("</svg>", 1)[0]
    source = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
              f'viewBox="0 0 {width} {height}"><rect width="100%" height="100%" fill="white"/>'
              f'<g transform="translate({(width-logo)/2} {(height-logo)/2}) scale({logo/48})">'
              f'{inner}</g></svg>')
    raster(source, ANDROID / folder / "splash.png", width, height)
print("Generated PWA, desktop, Android launcher, splash, and notification assets.")
