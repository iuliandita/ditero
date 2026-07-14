// UTC "YYYY-MM-DD" for the current day. Shared so the client and the streak/
// recurrence domain (which expand/compare dates in the same UTC frame) agree on
// which calendar day "today" is, with no off-by-one at the timezone edge.
export function todayISO(): string {
	return new Date().toISOString().slice(0, 10);
}
