# Ditero identity

The Fridge Door symbol represents a shared checklist held by a magnet. Grid
Grotesque lettering stays neutral: off-black on light backgrounds and off-white
on dark backgrounds. Teal is the default symbol and application accent.

## Assets

- [Light-background wordmark](ditero-wordmark-light.png)
- [Dark-background wordmark](ditero-wordmark-dark.png)
- [Standalone teal symbol](ditero-symbol-teal.png)
- [Palette values](palettes.json)

All PNGs have transparent backgrounds. These are raster assets; editable vector
masters are not included. Keep the symbol and lettering proportions intact. The
horizontal wordmarks use a smaller symbol and wider gap than the palette studies.

The login and native server selector use these wordmarks. Installed PWA, desktop,
and Android artwork is generated from the standalone symbol with Python 3 and
ImageMagick 7:

```sh
python3 scripts/generate-branding.py
python3 scripts/test-branding.py
```

The generator preserves the raster geometry, centers the Android adaptive mark
inside its safe circle, and derives white notification artwork from the same alpha
shape. `--output-root` generates an isolated copy for verification. The earlier
`assets/branding/icon.svg` is not an installed artwork source.

## Accent themes

| Theme | Logo color | Light/dark identity sheet |
| --- | --- | --- |
| Teal (default) | `#1F8A7A` | [Teal](palette-01-kitchen-teal.png) |
| Blue | `#3B73C9` | [Blue](palette-02-harbor-blue.png) |
| Clay | `#C75B3F` | [Clay](palette-03-clay.png) |
| Violet | `#8061D0` | [Violet](palette-04-dusk-violet.png) |
| Berry | `#C2457A` | [Berry](palette-05-berry.png) |
| Ochre | `#A87A0C` | [Ochre](palette-06-ochre.png) |

The main logo color stays the same in both themes. Links, primary controls and
focus rings use darker or lighter shades for contrast. Ordinary surfaces and
borders stay neutral. Task flags, priorities, list colors and status colors keep
their own meanings and do not follow the accent theme.

Appearance offers all six accents independently of light/dark/system mode.
The choice is saved per account on this device.
