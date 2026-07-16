import { type Options, RRule } from "rrule";

export type RecurrencePreset =
	| { freq: "daily"; interval: number }
	| { freq: "weekly"; interval: number; weekdays: number[] } // 0=Mon .. 6=Sun
	| { freq: "monthly"; interval: number; monthday: number } // 1..31
	| { freq: "yearly"; interval: number };

// 0=Mon .. 6=Sun, matching RRule.MO.weekday .. RRule.SU.weekday.
const DAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

const isInt = (n: number) => Number.isInteger(n);

export function presetToRRule(p: RecurrencePreset): string {
	if (!isInt(p.interval) || p.interval < 1) {
		throw new Error(`recurrence: interval must be >= 1, got ${p.interval}`);
	}
	switch (p.freq) {
		case "daily":
			return `FREQ=DAILY;INTERVAL=${p.interval}`;
		case "yearly":
			return `FREQ=YEARLY;INTERVAL=${p.interval}`;
		case "monthly":
			if (!isInt(p.monthday) || p.monthday < 1 || p.monthday > 31) {
				throw new Error(
					`recurrence: monthday must be 1..31, got ${p.monthday}`,
				);
			}
			return `FREQ=MONTHLY;INTERVAL=${p.interval};BYMONTHDAY=${p.monthday}`;
		case "weekly": {
			if (p.weekdays.length === 0) {
				throw new Error("recurrence: weekly needs at least one weekday");
			}
			// Stable, deduped 0..6 order so emitted BYDAY is deterministic.
			const days = [...new Set(p.weekdays)].sort((a, b) => a - b);
			for (const d of days) {
				if (!isInt(d) || d < 0 || d > 6) {
					throw new Error(`recurrence: weekday must be 0..6, got ${d}`);
				}
			}
			const byday = days.map((d) => DAY_CODES[d]).join(",");
			return `FREQ=WEEKLY;INTERVAL=${p.interval};BYDAY=${byday}`;
		}
	}
}

const FREQ_NAME: Record<number, RecurrencePreset["freq"] | undefined> = {
	[RRule.DAILY]: "daily",
	[RRule.WEEKLY]: "weekly",
	[RRule.MONTHLY]: "monthly",
	[RRule.YEARLY]: "yearly",
};

const asWeekday = (w: number | string | { weekday: number }): number => {
	if (typeof w === "number") return w;
	if (typeof w === "string") return DAY_CODES.indexOf(w as never);
	return w.weekday;
};

export function rruleToPreset(rrule: string): RecurrencePreset | null {
	const o = RRule.parseString(rrule); // throws on malformed input
	const freq = FREQ_NAME[o.freq as number];
	if (!freq) return null;
	const interval = o.interval ?? 1;

	const keys = Object.keys(o);
	const allowed =
		freq === "weekly"
			? ["freq", "interval", "byweekday"]
			: freq === "monthly"
				? ["freq", "interval", "bymonthday"]
				: ["freq", "interval"];
	// Any extra field (COUNT, UNTIL, BYSETPOS, BYMONTH, WKST, ...) means the rule
	// carries state a 4-shape preset cannot round-trip.
	if (keys.some((k) => !allowed.includes(k))) return null;

	if (freq === "weekly") {
		const raw = o.byweekday;
		if (raw == null) return null;
		const list = Array.isArray(raw) ? raw : [raw];
		if (list.length === 0) return null;
		const weekdays = list
			.map(asWeekday)
			.filter((d): d is number => isInt(d) && d >= 0 && d <= 6)
			.sort((a, b) => a - b);
		if (weekdays.length !== list.length) return null;
		return { freq, interval, weekdays };
	}
	if (freq === "monthly") {
		const raw = o.bymonthday;
		const md = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : null) : raw;
		if (md == null || !isInt(md)) return null;
		return { freq, interval, monthday: md };
	}
	return { freq, interval };
}

function parseOptions(rrule: string): Partial<Options> {
	const o = RRule.parseString(rrule); // throws on malformed input
	if (o.freq == null) {
		throw new Error(`recurrence: RRULE missing FREQ: ${rrule}`);
	}
	return o;
}

export function parseRule(rrule: string): RRule {
	return new RRule(parseOptions(rrule));
}

// Calendar add that clamps to the target month's last day instead of rolling
// over (Jan 31 +1mo -> Feb 28, not Mar 3; Feb 29 +1yr -> Feb 28).
const addCalendar = (base: Date, months: number): Date => {
	const day = base.getUTCDate();
	const d = new Date(base.getTime());
	d.setUTCDate(1);
	d.setUTCMonth(d.getUTCMonth() + months);
	const lastDay = new Date(
		Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
	).getUTCDate();
	d.setUTCDate(Math.min(day, lastDay));
	return d;
};
const addMonths = (base: Date, n: number): Date => addCalendar(base, n);
const addYears = (base: Date, n: number): Date => addCalendar(base, n * 12);
const addDays = (base: Date, n: number): Date =>
	new Date(base.getTime() + n * 86_400_000);

export function nextDue(
	rrule: string,
	from: Date,
	opts: { relative: boolean; completedAt: Date },
): Date | null {
	const o = parseOptions(rrule);
	const interval = o.interval ?? 1;

	if (opts.relative) {
		// One interval off completedAt, independent of `from`. UTC math keeps the
		// wall clock stable across DST (day/week are exact; month/year are calendar).
		const base = opts.completedAt;
		switch (o.freq) {
			case RRule.DAILY:
				return addDays(base, interval);
			case RRule.WEEKLY:
				return addDays(base, interval * 7);
			case RRule.MONTHLY:
				return addMonths(base, interval);
			case RRule.YEARLY:
				return addYears(base, interval);
			default:
				throw new Error(
					`recurrence: relative mode unsupported for FREQ ${o.freq}`,
				);
		}
	}

	// Fixed: anchor the series at `from` and take the first instance strictly
	// after it. UNTIL/COUNT exhaustion yields null (rrule returns null, not throw).
	const r = new RRule({ ...o, dtstart: from });
	return r.after(from, false);
}

export function expand(rrule: string, from: Date, to: Date, cap = 366): Date[] {
	const o = parseOptions(rrule);
	const r = new RRule({ ...o, dtstart: from });
	const out: Date[] = [];
	// Cap during iteration so a pathological rule (e.g. FREQ=SECONDLY) cannot
	// enumerate an unbounded window before we slice.
	r.between(from, to, true, (d) => {
		out.push(d);
		return out.length < cap;
	});
	return out;
}
