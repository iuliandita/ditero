# Named themes

Display settings provide Default, Paper and Slate palettes. Each named palette
contains light and dark colors and follows the existing Light/Dark/System mode.
Reading size and high contrast remain independent. Task priorities, list kinds,
success and destructive states retain their semantic colors.

Select a named palette, then Customize to edit its name and paired colors.
Valid drafts preview immediately without saving. Save copies a built-in palette
or updates the selected custom palette. Cancel, Escape or leaving settings restores
the saved palette. Unreadable colors disable Save and retain the last valid preview.
Save waits for the server to confirm. A rejected save keeps the editor and draft
available for retry. An accepted offline save stays queued until reconnecting;
leaving settings does not discard an already submitted change. Local startup-cache
failures are reported separately from a confirmed account save.

Theme palettes, selection and accent choices sync across devices for the signed-in
account. Reading size and high contrast stay on each device. Each account can store
20 custom palettes. Export theme JSON to share a palette with another account.
Removing a custom palette selects Default. Signing out removes its colors from
the active interface.

## JSON format

Version 1 has exactly `version`, `name`, `light` and `dark` fields. Names are
limited to 64 characters; files to 16 KiB. Each mode contains the same 23 allowed
shell tokens, listed in `src/domain/theme-document.ts`. Colors use `#RRGGBB`.
Import rejects arbitrary CSS, URLs, extra fields, missing colors, mismatched
light/dark surfaces and insufficient text contrast. Export a built-in palette
for a complete starting document.

Custom themes use their own primary color. Choosing an accent explicitly overrides
that color; the next export includes the selected accent. During an editor preview,
finish or cancel the edit before choosing an accent.

## Sync and existing device libraries

The server owns the appearance snapshot once preferences finish loading. Local
storage is only a startup hint. An account with no saved appearance uses Default;
its earlier device library is not uploaded automatically. The first explicit
palette, import, edit, removal or accent action migrates that device library with
the submitted change. Preview alone never uploads a draft.

Appearance uses one bounded JSON snapshot (350,000 UTF-8 bytes), including the
whole custom library. Concurrent saves use last-write-wins: a later snapshot can
replace earlier edits from another device. Refresh before editing a library that
someone else has changed. Light/Dark/System retains its existing preference.
Standalone invitation and native authorization pages use device hints because
they do not open the account sync connection.
