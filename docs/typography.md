# Interface typography

Geist Variable is the main self-hosted family. Arabic uses the self-hosted Noto Sans Arabic Variable companion. Font definitions and semantic colors live in `src/web/index.css`.

The base hierarchy uses rem units so browser text preferences and reading presets remain effective:

- Primary list, view, and dashboard titles: 1.125rem, weight 600, with wrapping for long names.
- Section headings: 1rem, weight 600.
- Task titles and body text: 0.875rem, weight 400.
- Action labels: 0.875rem, weight 500.
- Metadata, avatar initials, filter joiners, and Karma progress labels: 0.75rem.
- Phone text inputs: at least 1rem to avoid automatic focus zoom.

Compact exceptions are supporting marks, not instructions: keycaps use 0.6875rem and avatar overflow counts use 0.65rem. Small buttons and channel disclosure labels use 0.8rem. Meaningful names stay at the body or metadata size.

Standard retains the base hierarchy. Comfortable and Large enlarge the rem scale, completion marks, tap targets, and spacing together. High contrast is independent of reading size and theme. Long names and metadata reflow in the larger presets.

Priority flags carry semantic color; ordinary priority text uses foreground so it stays readable on both resting and hover surfaces. Spatial overlay animation is removed when reduced motion is requested.
