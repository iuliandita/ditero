// The engine's own name for a zone, which folds aliases together
// ("Asia/Kolkata" and "Asia/Calcutta" resolve to one id). An id the engine
// cannot resolve is returned as-is.
export function resolveTimeZone(zone: string): string {
	try {
		return new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
		}).resolvedOptions().timeZone;
	} catch {
		return zone;
	}
}

function listSupported(): readonly string[] {
	return typeof Intl.supportedValuesOf === "function"
		? Intl.supportedValuesOf("timeZone")
		: [];
}

/**
 * The zones a user can pick, one entry per real zone, plus which entry
 * stands for the stored value. A stored alias maps onto its listed
 * equivalent instead of appearing as a second, identical-looking choice; the
 * stored id itself is only rewritten when the user picks something. A stored
 * zone with no listed equivalent (older engines) is kept selectable so the
 * Select never renders empty.
 */
export function timeZoneOptions(
	current: string,
	supported: () => readonly string[] = listSupported,
	resolve: (zone: string) => string = resolveTimeZone,
): { zones: string[]; selected: string } {
	let listed: readonly string[] = [];
	try {
		listed = supported();
	} catch {
		listed = [];
	}
	const byKey = new Map<string, string>();
	for (const zone of [...listed, "UTC"]) {
		const key = resolve(zone);
		if (!byKey.has(key)) byKey.set(key, zone);
	}
	let selected = current;
	if (current) {
		const key = resolve(current);
		const listedEquivalent = byKey.get(key);
		if (listedEquivalent) selected = listedEquivalent;
		else byKey.set(key, current);
	}
	const zones = [...byKey.values()].sort((a, b) => a.localeCompare(b));
	return { zones, selected };
}

export function timeZoneLabel(zone: string): string {
	return zone.replaceAll("_", " ");
}
