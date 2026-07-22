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
