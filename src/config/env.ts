export function positiveInt(
	name: string,
	raw: string | undefined,
	fallback: number,
): number {
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name}: expected a positive integer, got "${raw}"`);
	}
	return value;
}

// Strict on purpose: "yes", "1" and "TRUE" all read as intent to enable, and a
// silent false on one of them would disable a control the operator believes is
// on -- which for DITERO_SMTP_ALLOW_INSECURE would be the wrong direction of
// failure the one time it matters.
export function booleanFlag(
	name: string,
	raw: string | undefined,
	fallback: boolean,
): boolean {
	const value = raw?.trim();
	if (value === undefined || value === "") return fallback;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`${name}: expected "true" or "false", got "${raw}"`);
}
