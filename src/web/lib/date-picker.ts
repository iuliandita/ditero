import { parseQuickAdd } from "../../domain/quick-add.ts";

// Pure helpers behind DuePicker and TimeField. Dates here are LOCAL calendar
// days, built with the local Date constructor, matching task-display's
// dueToInputs/inputsToDue: that pair is the storage contract and is not
// reframed. Formatters are built per call (see locale-freeze.test.ts).

type WeekInfoLocale = Intl.Locale & {
	getWeekInfo?: () => { firstDay: number };
	weekInfo?: { firstDay: number };
};

function weekInfoFirstDay(tag: string): number | null {
	try {
		const loc = new Intl.Locale(tag).maximize() as WeekInfoLocale;
		const info = loc.getWeekInfo?.() ?? loc.weekInfo;
		// Intl numbers ISO-style (1 = Monday .. 7 = Sunday); Date#getDay is 0 = Sunday.
		return info ? info.firstDay % 7 : null;
	} catch {
		return null;
	}
}

// CLDR weekData firstDay for engines without Intl week info (Firefox). Regions
// not listed start on Monday. Bare app locales resolve to CLDR's likely region.
const SUNDAY_REGIONS = new Set(
	"AG AS BD BR BS BT BW BZ CA CN CO DM DO ET GT GU HK HN ID IL IN JM JP KE KH KR LA MH MM MO MT MX MZ NI NP PA PE PH PK PR PT PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW".split(
		" ",
	),
);
const SATURDAY_REGIONS = new Set(
	"AE AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY".split(" "),
);
const LIKELY_REGION: Record<string, string> = {
	ar: "EG",
	de: "DE",
	en: "US",
	es: "ES",
	fr: "FR",
	ro: "RO",
};

export function cldrFirstDay(tag: string): number {
	const [lang, ...rest] = tag.split(/[-_]/);
	const region =
		rest.find((part) => /^[A-Za-z]{2}$/.test(part))?.toUpperCase() ??
		(Object.hasOwn(LIKELY_REGION, lang.toLowerCase())
			? LIKELY_REGION[lang.toLowerCase()]
			: undefined);
	if (region && SUNDAY_REGIONS.has(region)) return 0;
	if (region && SATURDAY_REGIONS.has(region)) return 6;
	return 1;
}

/**
 * First day of the week as a Date#getDay index. The app locale is a bare
 * language ("en"), which maximizes to one region (en -> US, Sunday); a browser
 * language with a region for the same language ("en-GB") is the better signal,
 * so it wins when present. Engines without Intl week info use CLDR's table.
 */
export function firstWeekday(
	locale: string,
	preferred: readonly string[] = [],
	weekInfo: (tag: string) => number | null = weekInfoFirstDay,
): number {
	const lang = locale.split("-")[0].toLowerCase();
	const regional = preferred.find(
		(tag) => tag.includes("-") && tag.split("-")[0].toLowerCase() === lang,
	);
	const tag = regional ?? locale;
	return weekInfo(tag) ?? cldrFirstDay(tag);
}

export function startOfDay(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, days: number): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

export function sameDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` for a local day, the date half of dueToInputs. */
export function dayKey(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DAY_KEY = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

export function parseDayKey(key: string): Date | null {
	const parts = key.match(DAY_KEY);
	if (!parts) return null;
	const [, y, mo, d] = parts.map(Number);
	const date = new Date(y, mo - 1, d);
	// Rejects 2026-02-31 rolling over into March.
	return date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}

/** First day of the week after the one containing `now`. */
export function nextWeekStart(now: Date, first: number): Date {
	const offset = (now.getDay() - first + 7) % 7;
	return addDays(now, 7 - offset);
}

/**
 * The month as whole weeks: leading nulls up to the 1st, then every day, then
 * trailing nulls to complete the last week.
 */
export function monthCells(
	year: number,
	month: number,
	first: number,
): (Date | null)[] {
	const lead = (new Date(year, month, 1).getDay() - first + 7) % 7;
	const days = new Date(year, month + 1, 0).getDate();
	const cells: (Date | null)[] = Array.from({ length: lead }, () => null);
	for (let d = 1; d <= days; d++) cells.push(new Date(year, month, d));
	while (cells.length % 7 !== 0) cells.push(null);
	return cells;
}

/** Weekday names in display order, starting at `first`. */
export function weekdayNames(
	locale: string,
	first: number,
): { short: string; long: string }[] {
	const short = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
	const long = new Intl.DateTimeFormat(locale, { weekday: "long" });
	// 2024-01-07 is a Sunday; local construction keeps getDay() and the
	// formatted name on the same day in every timezone.
	return Array.from({ length: 7 }, (_, i) => {
		const d = new Date(2024, 0, 7 + ((first + i) % 7));
		return { short: short.format(d), long: long.format(d) };
	});
}

/**
 * A typed date: an ISO day key, or anything the quick-add date grammar reads
 * ("tomorrow", "next friday 5pm"). `time` is null when the text named no time.
 */
export function parseDueText(
	text: string,
	locale: string,
	now: Date = new Date(),
): { date: string; time: string | null } | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const iso = parseDayKey(trimmed);
	if (iso) return { date: dayKey(iso), time: null };
	// A malformed day key ("2026-13-01") is a typo, not natural language: the
	// date grammar would happily read part of it and save some other day.
	if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(trimmed)) return null;
	const parsed = parseQuickAdd(trimmed, now, locale);
	if (!parsed.dueAt) return null;
	const at = parsed.dueAt;
	return {
		date: dayKey(at),
		time: parsed.dueAllDay
			? null
			: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
	};
}

function normalize(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Intl separates the day period with U+202F/U+00A0 in several locales.
			.replace(/[\u00a0\u202f]/g, " ")
			// Arabic-Indic digits, for anyone typing on an Arabic keyboard.
			.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660))
			.trim()
			.toLowerCase()
	);
}

function dayPeriodMarkers(locale: string): [string, "am" | "pm"][] {
	const markers: [string, "am" | "pm"][] = [
		["a.m.", "am"],
		["p.m.", "pm"],
		["am", "am"],
		["pm", "pm"],
		["a", "am"],
		["p", "pm"],
	];
	const fmt = new Intl.DateTimeFormat(locale, {
		hour: "numeric",
		hour12: true,
	});
	for (const [hour, period] of [
		[1, "am"],
		[13, "pm"],
	] as const) {
		const part = fmt
			.formatToParts(new Date(2024, 0, 1, hour))
			.find((p) => p.type === "dayPeriod");
		if (part) markers.push([normalize(part.value), period]);
	}
	return markers.sort((a, b) => b[0].length - a[0].length);
}

/**
 * Parse a typed time into the stored `HH:MM` form: "17:30", "5:30 pm", "5pm",
 * "1730", "8.15", or the locale's own formatted output. Null when unreadable.
 */
export function parseTimeText(raw: string, locale: string): string | null {
	let s = normalize(raw);
	if (!s) return null;
	let period: "am" | "pm" | null = null;
	for (const [marker, p] of dayPeriodMarkers(locale)) {
		if (marker && s.endsWith(marker)) {
			period = p;
			s = s.slice(0, -marker.length).trim();
			break;
		}
		if (marker && s.startsWith(marker)) {
			period = p;
			s = s.slice(marker.length).trim();
			break;
		}
	}
	let h: number;
	let min: number;
	const split = s.match(/^(\d{1,2})(?:\s*[:.h]\s*(\d{2}))?$/);
	const compact = s.match(/^(\d{1,2})(\d{2})$/);
	if (split) {
		h = Number(split[1]);
		min = split[2] ? Number(split[2]) : 0;
	} else if (compact) {
		h = Number(compact[1]);
		min = Number(compact[2]);
	} else {
		return null;
	}
	if (min > 59) return null;
	if (period) {
		if (h < 1 || h > 12) return null;
		if (period === "pm" && h < 12) h += 12;
		if (period === "am" && h === 12) h = 0;
	} else if (h > 23) {
		return null;
	}
	return `${pad(h)}:${pad(min)}`;
}

/** Display form of a stored `HH:MM` value in the locale's own clock style. */
export function formatTimeValue(value: string, locale: string): string {
	const parts = value.match(/^(\d{2}):(\d{2})$/);
	if (!parts) return value;
	return new Intl.DateTimeFormat(locale, {
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(2024, 0, 1, Number(parts[1]), Number(parts[2])));
}
