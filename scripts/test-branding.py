#!/usr/bin/env python3
"""Verify generated Fridge Door artwork with Python 3 and ImageMagick 7."""

from pathlib import Path
import importlib.util
import struct
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("branding", Path(__file__).with_name("generate-branding.py"))
branding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(branding)


def dimensions(data: bytes) -> tuple[int, int]:
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    return struct.unpack(">II", data[16:24])


def pixels(path: Path, channel: str) -> bytes:
    return subprocess.run(["magick", str(path), "-channel", channel, "-separate",
                           "-depth", "8", "gray:-"], check=True, capture_output=True).stdout


class BrandingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.directory = tempfile.TemporaryDirectory()
        cls.root = Path(cls.directory.name)
        branding.generate(cls.root)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.directory.cleanup()

    def test_generation_is_reproducible_and_preserves_source(self) -> None:
        source = branding.SOURCE.read_bytes()
        first = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        branding.generate(self.root)
        second = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        self.assertEqual(first, second)
        self.assertEqual(branding.SOURCE.read_bytes(), source)

    def test_launcher_sizes_and_adaptive_safe_circle(self) -> None:
        resources = self.root / "apps/android/android/app/src/main/res"
        for density, scale in (("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2), ("xxhdpi", 3), ("xxxhdpi", 4)):
            folder = resources / f"mipmap-{density}"
            self.assertEqual(dimensions((folder / "ic_launcher.png").read_bytes()), (round(48 * scale),) * 2)
            path = folder / "ic_launcher_foreground.png"
            size = round(108 * scale)
            self.assertEqual(dimensions(path.read_bytes()), (size, size))
            alpha = pixels(path, "A")
            visible = [(i % size + 0.5, i // size + 0.5) for i, a in enumerate(alpha) if a]
            self.assertGreater(len(visible), 0)
            self.assertTrue(all((x - size / 2) ** 2 + (y - size / 2) ** 2 < (33 * scale) ** 2
                                for x, y in visible))

    def test_notification_is_white_with_the_source_alpha_shape(self) -> None:
        path = self.root / "apps/android/android/app/src/main/res/drawable-mdpi/ic_notification.png"
        self.assertEqual(dimensions(path.read_bytes()), (24, 24))
        alpha = pixels(path, "A")
        self.assertTrue(any(alpha))
        self.assertTrue(any(a == 0 for a in alpha))
        rgba = subprocess.run(["magick", str(path), "-depth", "8", "rgba:-"], check=True, capture_output=True).stdout
        self.assertTrue(all(rgba[i:i + 3] == b"\xff\xff\xff" for i in range(0, len(rgba), 4) if rgba[i + 3]))
        reference = self.root / "source-alpha.png"
        subprocess.run(["magick", str(branding.SOURCE), "-resize", "24x24", str(reference)], check=True)
        self.assertEqual(alpha, pixels(reference, "A"))
        reference.unlink()

    def test_desktop_containers_embed_complete_png_sizes(self) -> None:
        desktop = self.root / "apps/desktop/src-tauri/icons"
        ico = (desktop / "icon.ico").read_bytes()
        self.assertEqual(struct.unpack("<HHH", ico[:6]), (0, 1, 6))
        for i, size in enumerate((16, 32, 48, 64, 128, 256)):
            entry = struct.unpack("<BBBBHHII", ico[6 + i * 16:22 + i * 16])
            length, offset = entry[-2:]
            self.assertEqual(dimensions(ico[offset:offset + length]), (size, size))
        icns = (desktop / "icon.icns").read_bytes()
        self.assertEqual(icns[:4], b"icns")
        self.assertEqual(struct.unpack(">I", icns[4:8])[0], len(icns))
        offset = 8
        sizes = []
        while offset < len(icns):
            length = struct.unpack(">I", icns[offset + 4:offset + 8])[0]
            sizes.append(dimensions(icns[offset + 8:offset + length]))
            offset += length
        self.assertEqual(sizes, [(size, size) for size in (16, 32, 64, 128, 256, 512, 1024)])


if __name__ == "__main__":
    unittest.main()
