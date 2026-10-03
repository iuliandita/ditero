# Named themes

Display settings provide Default, Paper and Slate palettes. Each named palette
contains light and dark colors and follows the existing Light/Dark/System mode.
Reading size and high contrast remain independent. Task priorities, list kinds,
success and destructive states retain their semantic colors.

Select a named palette, then Customize to edit its name and paired colors.
Valid drafts preview immediately without saving. Save copies a built-in palette
or updates the selected custom palette. Cancel, Escape or leaving settings restores
the saved palette. Unreadable colors disable Save and retain the last valid preview.
A storage failure keeps the editor open and leaves the saved palette intact.

Theme palettes and selection are currently saved for the signed-in account on
this device. They do not sync to other devices. Each account can store 20 custom
palettes. Export theme JSON to share a palette; import the file on another device.
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
