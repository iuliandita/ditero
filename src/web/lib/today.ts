// UTC "YYYY-MM-DD" day helpers. Shared so the client and the streak/
// recurrence domain (which expand/compare dates in the same UTC frame) agree on
// which calendar day a timestamp lands on, with no off-by-one at the timezone
// edge.
export function dateISO(d: Date): string {
	return d.toISOString().slice(0, 10);
}

export function todayISO(): string {
	return dateISO(new Date());
}
