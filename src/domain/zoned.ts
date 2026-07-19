const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
	const cached = partsCache.get(timeZone);
	if (cached) return cached;
	const created = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	partsCache.set(timeZone, created);
	return created;
}

interface WallClockFields {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

function fieldsAt(at: Date, timeZone: string): WallClockFields {
	const raw: Record<string, number> = {};
	for (const part of formatter(timeZone).formatToParts(at)) {
		if (part.type !== "literal") raw[part.type] = Number(part.value);
	}
	const fields = raw as unknown as WallClockFields;
	// Some ICU versions render midnight as hour 24 of the same day instead of
	// hour 0 of the next; roll the date forward too, not just the hour.
	if (fields.hour === 24) {
		const rolled = new Date(
			Date.UTC(
				fields.year,
				fields.month - 1,
				fields.day,
				24,
				fields.minute,
				fields.second,
			),
		);
		fields.year = rolled.getUTCFullYear();
		fields.month = rolled.getUTCMonth() + 1;
		fields.day = rolled.getUTCDate();
		fields.hour = rolled.getUTCHours();
	}
	return fields;
}

export function offsetMsAt(at: Date, timeZone: string): number {
	const f = fieldsAt(at, timeZone);
	const asUTC = Date.UTC(
		f.year,
		f.month - 1,
		f.day,
		f.hour,
		f.minute,
		f.second,
	);
	return asUTC - Math.floor(at.getTime() / 1000) * 1000;
}

function parseWallClockDate(date: string): {
	year: number;
	month: number;
	day: number;
} {
	const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!found)
		throw new Error(`zoned: malformed date "${date}", expected YYYY-MM-DD`);
	const year = Number(found[1]);
	const month = Number(found[2]);
	const day = Number(found[3]);
	// Date.UTC silently rolls over out-of-range components; reject anything
	// that doesn't round-trip to a real calendar date.
	const rolled = new Date(Date.UTC(year, month - 1, day));
	if (
		rolled.getUTCFullYear() !== year ||
		rolled.getUTCMonth() !== month - 1 ||
		rolled.getUTCDate() !== day
	) {
		throw new Error(`zoned: invalid calendar date "${date}"`);
	}
	return { year, month, day };
}

function parseWallClockTime(time: string): { hour: number; minute: number } {
	const found = /^(\d{2}):(\d{2})$/.exec(time);
	if (!found)
		throw new Error(`zoned: malformed time "${time}", expected HH:MM`);
	const hour = Number(found[1]);
	const minute = Number(found[2]);
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
		throw new Error(`zoned: invalid wall-clock time "${time}"`);
	}
	return { hour, minute };
}

export function instantToWallClock(
	at: Date,
	timeZone: string,
): { date: string; time: string } {
	const f = fieldsAt(at, timeZone);
	const pad = (n: number) => String(n).padStart(2, "0");
	return {
		date: `${f.year}-${pad(f.month)}-${pad(f.day)}`,
		time: `${pad(f.hour)}:${pad(f.minute)}`,
	};
}

export const DAY_MS = 24 * 3_600_000;

// A wall-clock time in a zone maps to an instant only after resolving that zone's
// offset *at that instant* -- a chicken-and-egg. Probing a day on either side of the
// naive instant is enough to catch the (at most one) nearby transition, on the
// assumption that DST-style changes are spaced by months, not days -- true for
// ordinary annual DST, though a short-notice political zone change could in
// principle violate it.
// DST policy: a nonexistent time fires at the end of the gap; an ambiguous time
// fires at its first occurrence.
export function wallClockToInstant(
	date: string,
	time: string,
	timeZone: string,
): Date {
	const { year, month, day } = parseWallClockDate(date);
	const { hour, minute } = parseWallClockTime(time);
	const naive = Date.UTC(year, month - 1, day, hour, minute, 0);

	const offsetBefore = offsetMsAt(new Date(naive - DAY_MS), timeZone);
	const offsetAfter = offsetMsAt(new Date(naive + DAY_MS), timeZone);

	const candidates = new Set([naive - offsetBefore, naive - offsetAfter]);
	const valid = [...candidates].filter((ms) => {
		const back = instantToWallClock(new Date(ms), timeZone);
		return back.date === date && back.time === time;
	});

	// One valid candidate -> ordinary resolution. Two -> the wall-clock is
	// ambiguous (fall-back overlap); earliest wins.
	if (valid.length > 0) return new Date(Math.min(...valid));

	// Neither offset resolves it -> the wall-clock falls in a spring-forward gap.
	// Locate the transition instant itself and fire there (the gap's end).
	return findOffsetTransition(naive - DAY_MS, naive + DAY_MS, timeZone);
}

// Narrows to the millisecond, but offsetMsAt itself only samples at second
// granularity (Intl has no sub-second fields), so the returned boundary can be
// up to ~999ms after the true tzdb transition instant. Immaterial at the
// minute-granularity this module is used for.
function findOffsetTransition(
	loMs: number,
	hiMs: number,
	timeZone: string,
): Date {
	const loOffset = offsetMsAt(new Date(loMs), timeZone);
	const hiOffset = offsetMsAt(new Date(hiMs), timeZone);
	if (loOffset === hiOffset) {
		throw new Error(
			"zoned: no offset transition found in probe window -- caller passed a malformed wall-clock value",
		);
	}
	while (hiMs - loMs > 1) {
		const midMs = Math.floor((loMs + hiMs) / 2);
		if (offsetMsAt(new Date(midMs), timeZone) === loOffset) {
			loMs = midMs;
		} else {
			hiMs = midMs;
		}
	}
	return new Date(hiMs);
}
