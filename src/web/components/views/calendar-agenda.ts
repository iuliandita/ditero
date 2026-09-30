// The phone agenda is a month, not the desktop grid's spillover days. In the
// current month, everyday work starts today; earlier dates remain inspectable.
export function agendaDayKeys(
	keys: readonly string[],
	monthKey: string,
	today: string,
	includeEarlier: boolean,
): string[] {
	return keys
		.filter(
			(key) =>
				key.slice(0, 7) === monthKey.slice(0, 7) &&
				(includeEarlier ||
					monthKey.slice(0, 7) !== today.slice(0, 7) ||
					key >= today),
		)
		.sort();
}
