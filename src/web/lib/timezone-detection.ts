// Which zone, if any, browser detection should write. A stored "UTC" is the
// column default unless the user picked it in settings (timezoneChosen), so
// only an unchosen UTC is replaced, and only with a real, non-UTC zone. Rows
// from before the flag existed read as unchosen, which keeps their old
// behavior.
export function timeZoneToDetect(
	stored: { timezone: string; timezoneChosen: boolean },
	detected: string | null,
): string | null {
	if (stored.timezoneChosen) return null;
	if (stored.timezone !== "UTC") return null;
	if (!detected || detected === "UTC") return null;
	return detected;
}
