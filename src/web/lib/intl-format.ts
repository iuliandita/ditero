import { getLocale } from "../../paraglide/runtime.js";

// Locale-aware wrappers for the values that reach users outside the message
// catalog: day keys and joined name lists. Every formatter is constructed per
// call -- a module-scope Intl instance would freeze the import-time locale
// exactly like a module-scope `m.x()` does (see locale-freeze.test.ts).

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Format a `YYYY-MM-DD` day key (as written by domain/local-day.ts) for
 * display. The parts are read directly rather than through `new Date(key)`,
 * which parses as UTC midnight and renders the previous day for anyone west of
 * UTC -- the day key is already the user's local day and must not be reframed.
 * Returns the key unchanged when it is not a day key, so a caller never renders
 * "Invalid Date".
 */
export function formatDayKey(
	dayKey: string,
	options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" },
): string {
	const parts = dayKey.match(DAY_KEY);
	if (!parts) return dayKey;
	const [, year, month, day] = parts;
	const date = new Date(Number(year), Number(month) - 1, Number(day));
	return new Intl.DateTimeFormat(getLocale(), options).format(date);
}

/**
 * Join names with the locale's own list separator. Arabic uses "، " and most
 * locales add a conjunction before the final item, neither of which a literal
 * ", " produces.
 */
export function formatList(
	items: string[],
	type: Intl.ListFormatType = "conjunction",
): string {
	return new Intl.ListFormat(getLocale(), { style: "long", type }).format(
		items,
	);
}
