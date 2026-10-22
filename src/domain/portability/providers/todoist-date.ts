// Todoist accepts date/time and recurrence text; real account export spelling is
// not guaranteed by its CSV help. Unsupported natural-language dates stay explicit.
const MONTHS: Record<string, readonly string[]> = {
	en: [
		"jan january",
		"feb february",
		"mar march",
		"apr april",
		"may",
		"jun june",
		"jul july",
		"aug august",
		"sep sept september",
		"oct october",
		"nov november",
		"dec december",
	],
	de: [
		"jan januar",
		"feb februar",
		"mar marz maerz",
		"apr april",
		"mai",
		"jun juni",
		"jul juli",
		"aug august",
		"sep sept september",
		"okt oktober",
		"nov november",
		"dez dezember",
	],
	es: [
		"ene enero",
		"feb febrero",
		"mar marzo",
		"abr abril",
		"may mayo",
		"jun junio",
		"jul julio",
		"ago agosto",
		"sep sept septiembre setiembre",
		"oct octubre",
		"nov noviembre",
		"dic diciembre",
	],
	fr: [
		"janv janvier",
		"fevr fevrier",
		"mars",
		"avr avril",
		"mai",
		"juin",
		"juil juillet",
		"aout",
		"sept septembre",
		"oct octobre",
		"nov novembre",
		"dec decembre",
	],
	ro: [
		"ian ianuarie",
		"feb februarie",
		"mar martie",
		"apr aprilie",
		"mai",
		"iun iunie",
		"iul iulie",
		"aug august",
		"sep sept septembrie",
		"oct octombrie",
		"nov noiembrie",
		"dec decembrie",
	],
};
const WEEKDAYS = [
	"sunday sun",
	"monday mon",
	"tuesday tue tues",
	"wednesday wed",
	"thursday thu thur thurs",
	"friday fri",
	"saturday sat",
];
const RRULE_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const FILLER = new Set(["at", "of", "the", "on"]);

export type ParsedTodoistDate =
	| { kind: "none" }
	| { kind: "unsupported-date" }
	| { kind: "unsupported-recurrence" }
	| {
			kind: "date";
			// Date-only "YYYY-MM-DD" or wall time "YYYY-MM-DDTHH:MM".
			value: string;
			rule: string | null;
			anchored: boolean;
	  };

function plain(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[.,]/g, " ")
		.replace(/(\d)\s*(am|pm)\b/g, "$1$2")
		.replace(/\s+/g, " ")
		.trim();
}
function pad(value: number) {
	return String(value).padStart(2, "0");
}
function validDay(year: number, month: number, day: number): string | null {
	const stamp = Date.UTC(year, month - 1, day);
	const date = new Date(stamp);
	return date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
		? `${year}-${pad(month)}-${pad(day)}`
		: null;
}
function clock(token: string): string | null {
	const match = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(token);
	if (!match || (!match[2] && !match[3])) return null;
	let hour = Number(match[1]);
	const minute = Number(match[2] ?? "0");
	if (match[3]) {
		if (hour < 1 || hour > 12) return null;
		hour = (hour % 12) + (match[3] === "pm" ? 12 : 0);
	}
	return hour < 24 && minute < 60 ? `${pad(hour)}:${pad(minute)}` : null;
}
function monthIndex(token: string, lang: string): number {
	for (const names of [MONTHS[lang] ?? [], ...Object.values(MONTHS)]) {
		const index = names.findIndex((entry) => entry.split(" ").includes(token));
		if (index >= 0) return index + 1;
	}
	return 0;
}
function isWeekday(token: string): number {
	return WEEKDAYS.findIndex((entry) => entry.split(" ").includes(token));
}

// Absolute date with optional time; null when it is not a recognizable date.
function absolute(
	raw: string,
	lang: string,
	anchorDay: string,
): { day: string; time: string | null; anchored: boolean } | null {
	const text = plain(raw);
	const iso = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{1,2}):(\d{2}))?$/.exec(text);
	if (iso) {
		const day = validDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
		const time = iso[4] ? clock(`${iso[4]}:${iso[5]}`) : null;
		return day && (!iso[4] || time) ? { day, time, anchored: false } : null;
	}
	let year = 0;
	let month = 0;
	let day = 0;
	let time: string | null = null;
	for (const token of text.split(" ")) {
		if (FILLER.has(token) || isWeekday(token) >= 0) continue;
		const stamp = clock(token);
		if (stamp && !time) time = stamp;
		else if (/^\d{4}$/.test(token) && !year) year = Number(token);
		else if (/^\d{1,2}(st|nd|rd|th)?$/.test(token) && !day)
			day = Number.parseInt(token, 10);
		else if (monthIndex(token, lang) && !month) month = monthIndex(token, lang);
		else return null;
	}
	if (!day || !month) return null;
	const result = validDay(year || Number(anchorDay.slice(0, 4)), month, day);
	return result ? { day: result, time, anchored: !year } : null;
}

function nextWeekday(from: string, wanted: number[]): string {
	const [y, m, d] = from.split("-").map(Number);
	const base = Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
	for (let offset = 0; offset < 7; offset++) {
		const date = new Date(base + offset * 86_400_000);
		if (wanted.includes(date.getUTCDay()))
			return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
	}
	return from;
}
function nextMonthDay(from: string, monthDay: number, month?: number): string {
	const [y, m, d] = from.split("-").map(Number);
	let year = y ?? 0;
	let cursor = (month ?? m ?? 1) - 1;
	for (let step = 0; step < 48; step++) {
		const last = new Date(Date.UTC(year, cursor + 1, 0)).getUTCDate();
		const wanted = monthDay < 0 ? last + monthDay + 1 : monthDay;
		const found =
			wanted >= 1 && wanted <= last ? validDay(year, cursor + 1, wanted) : null;
		if (found && found >= from) return found;
		if (month) year++;
		else {
			cursor++;
			if (cursor > 11) {
				cursor = 0;
				year++;
			}
		}
	}
	return `${y}-${pad(m ?? 1)}-${pad(d ?? 1)}`;
}

function recurrence(body: string): {
	rule: string;
	weekdays?: number[];
	monthDay?: number;
	month?: number;
} | null {
	const unit = /^(?:(other)|(\d+))?\s*(day|week|month|year)s?$/.exec(body);
	if (unit) {
		const freq = {
			day: "DAILY",
			week: "WEEKLY",
			month: "MONTHLY",
			year: "YEARLY",
		}[unit[3] as "day"];
		const interval = unit[1] ? 2 : Number(unit[2] ?? "1");
		if (!Number.isSafeInteger(interval) || interval < 1) return null;
		return {
			rule: `FREQ=${freq}${interval > 1 ? `;INTERVAL=${interval}` : ""}`,
		};
	}
	if (body === "weekday" || body === "workday")
		return {
			rule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
			weekdays: [1, 2, 3, 4, 5],
		};
	if (body === "weekend")
		return { rule: "FREQ=WEEKLY;BYDAY=SA,SU", weekdays: [0, 6] };
	const days = body.split(/\s*(?:,|&|\band\b)\s*|\s+/).filter(Boolean);
	if (days.length && days.every((day) => isWeekday(day) >= 0)) {
		const indexes = [...new Set(days.map(isWeekday))];
		return {
			rule: `FREQ=WEEKLY;BYDAY=${indexes.map((i) => RRULE_DAYS[i]).join(",")}`,
			weekdays: indexes,
		};
	}
	const monthDay =
		/^(?:month )?(?:on )?(?:the )?(\d{1,2})(?:st|nd|rd|th)?$/.exec(body) ??
		/^(?:month )?(?:on )?(?:the )?last day$/.exec(body);
	if (monthDay) {
		const value = monthDay[1] ? Number(monthDay[1]) : -1;
		if ((value >= 1 && value <= 31) || value === -1)
			return { rule: `FREQ=MONTHLY;BYMONTHDAY=${value}`, monthDay: value };
	}
	const yearly =
		/^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?$/.exec(body) ??
		/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)$/.exec(body);
	if (yearly) {
		const month = monthIndex(
			/^\d/.test(yearly[1] ?? "") ? (yearly[2] ?? "") : (yearly[1] ?? ""),
			"en",
		);
		const dayNumber = Number(
			/^\d/.test(yearly[1] ?? "") ? yearly[1] : yearly[2],
		);
		if (month && dayNumber >= 1 && dayNumber <= 31)
			return {
				rule: `FREQ=YEARLY;BYMONTH=${month};BYMONTHDAY=${dayNumber}`,
				monthDay: dayNumber,
				month,
			};
	}
	return null;
}

export function parseTodoistDate(
	raw: string,
	lang: string,
	anchorDay: string,
): ParsedTodoistDate {
	const original = raw.trim();
	if (!original) return { kind: "none" };
	// Preserve ISO clocks, seconds and offsets for the shared contentDate validator.
	if (
		/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(
			original,
		)
	)
		return { kind: "date", value: original, rule: null, anchored: false };
	const text = plain(original);
	if (/^(every|jeden|jede|alle|cada|chaque|tous|fiecare)\b/.test(text)) {
		if (lang && lang !== "en" && !text.startsWith("every"))
			return { kind: "unsupported-recurrence" };
		// "every!" repeats from completion, which Ditero's rules cannot express.
		if (/^every!/.test(original.toLowerCase()))
			return { kind: "unsupported-recurrence" };
		let rest = text.slice("every".length).trim();
		let start: string | null = null;
		let time: string | null = null;
		const starting = /\s(?:starting|starts|from)\s(.+)$/.exec(rest);
		if (starting) {
			start = starting[1] ?? null;
			rest = rest.slice(0, starting.index).trim();
		}
		const at = /\sat\s(\S+(?:\s?(?:am|pm))?)$/.exec(rest);
		if (at) {
			time = clock(at[1] ?? "");
			if (!time) return { kind: "unsupported-recurrence" };
			rest = rest.slice(0, at.index).trim();
		}
		if (
			/\b(until|ending|for|after|before|last|other)\b/.test(rest) &&
			!/^(other )?(day|week|month|year)s?$/.test(rest) &&
			!/last day$/.test(rest)
		)
			return { kind: "unsupported-recurrence" };
		const parsed = recurrence(rest);
		if (!parsed) return { kind: "unsupported-recurrence" };
		let day: string;
		let anchored = false;
		if (start) {
			const begin = absolute(start, lang, anchorDay);
			if (!begin) return { kind: "unsupported-recurrence" };
			day = begin.day;
			anchored = begin.anchored;
			time ??= begin.time;
		} else {
			anchored = true;
			day = parsed.weekdays
				? nextWeekday(anchorDay, parsed.weekdays)
				: parsed.monthDay !== undefined
					? nextMonthDay(anchorDay, parsed.monthDay, parsed.month)
					: anchorDay;
		}
		return {
			kind: "date",
			value: time ? `${day}T${time}` : day,
			rule: parsed.rule,
			anchored,
		};
	}
	const found = absolute(original, lang, anchorDay);
	if (!found) return { kind: "unsupported-date" };
	return {
		kind: "date",
		value: found.time ? `${found.day}T${found.time}` : found.day,
		rule: null,
		anchored: found.anchored,
	};
}
