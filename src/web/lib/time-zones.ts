// The zones a user can pick. The stored zone always stays selectable, even
// when this runtime does not list it (older engines, or an alias such as
// "UTC" that some engines omit), or the Select would render empty.
export function timeZoneOptions(
	current: string,
	supported: () => readonly string[] = () =>
		typeof Intl.supportedValuesOf === "function"
			? Intl.supportedValuesOf("timeZone")
			: [],
): string[] {
	let zones: readonly string[] = [];
	try {
		zones = supported();
	} catch {
		zones = [];
	}
	const set = new Set(zones);
	set.add("UTC");
	if (current) set.add(current);
	return [...set].sort((a, b) => a.localeCompare(b));
}

export function timeZoneLabel(zone: string): string {
	return zone.replaceAll("_", " ");
}
