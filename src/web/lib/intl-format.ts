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

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;

export function formatBytes(bytes: number): string {
	if (!Number.isSafeInteger(bytes) || bytes < 0) {
		throw new Error(
			"formatBytes: byte count must be a non-negative safe integer",
		);
	}
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return new Intl.NumberFormat(getLocale(), {
		style: "unit",
		unit: BYTE_UNITS[unit],
		unitDisplay: "short",
		maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0,
	}).format(value);
}
