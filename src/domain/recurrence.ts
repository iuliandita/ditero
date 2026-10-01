import {
	type IterationLimitReason,
	type IterationLimits,
	type Options,
	RRule,
} from "rrule";

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

export const DAILY_RRULE = presetToRRule({ freq: "daily", interval: 1 });

// A habit is tracked against its recurrence, so one created without a rule has
// nothing to track. Top-level habits therefore start daily; subtasks and every
// other kind start without a rule.
export function initialRRule(
	listKind: string | null | undefined,
	parentId: string | null | undefined,
): string | null {
	return listKind === "habits" && parentId == null ? DAILY_RRULE : null;
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

export type RecurrenceSeries = {
	rrule: string;
	relative: boolean;
	anchorAt: Date | null;
	dueAt: Date | null;
	consumed: number | null;
	exhausted: boolean;
};
export type RecurrenceProjection = {
	status: "complete" | "capped" | "needs-start";
	occurrences: Date[];
	reason?: IterationLimitReason;
};
export type RecurrenceTransition = {
	status: "advanced" | "exhausted" | "capped" | "needs-start";
	series: RecurrenceSeries;
	reason?: IterationLimitReason;
};

function validateSeries(series: RecurrenceSeries): void {
	for (const d of [series.anchorAt, series.dueAt])
		if (d && !Number.isFinite(d.getTime()))
			throw new Error("recurrence: invalid date");
	if (
		series.consumed != null &&
		(!Number.isSafeInteger(series.consumed) || series.consumed < 0)
	)
		throw new Error("recurrence: invalid consumption");
	if ((series.anchorAt == null) !== (series.consumed == null))
		throw new Error("recurrence: incomplete schedule state");
}
function seriesAnchor(
	series: RecurrenceSeries,
	o: Partial<Options>,
	from: Date,
): Date | null {
	if (series.anchorAt) return series.anchorAt;
	if (series.dueAt) return series.dueAt;
	// Only this phase-invariant legacy habit can project without a known start.
	if (
		!series.relative &&
		o.freq === RRule.DAILY &&
		(o.interval ?? 1) === 1 &&
		o.count == null &&
		o.until == null &&
		Object.keys(o).every((key) => ["freq", "interval"].includes(key))
	)
		return new Date(
			Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
		);
	return null;
}

function fixedRule(
	o: Partial<Options>,
	anchor: Date,
	virtual: boolean,
	limits: IterationLimits,
) {
	const original = new RRule({ ...o, dtstart: anchor });
	if (virtual)
		return { status: "complete" as const, rule: original, initialSlot: false };
	// Selected task due is actionable even when a selector excludes DTSTART.
	const first = original.afterBounded(anchor, true, limits);
	if (first.status === "capped")
		return { status: "capped" as const, reason: first.reason };
	const initialSlot = first.value?.getTime() !== anchor.getTime();
	return {
		status: "complete" as const,
		initialSlot,
		rule: new RRule({
			...o,
			dtstart: anchor,
			...(o.count != null && initialSlot ? { count: o.count - 1 } : {}),
		}),
	};
}

/** Inclusive window; includePast projects eligible virtual-habit history. */
export function projectRecurrence(
	series: RecurrenceSeries,
	from: Date,
	to: Date,
	options: IterationLimits & { includePast?: boolean } = {},
): RecurrenceProjection {
	validateSeries(series);
	if (
		!Number.isFinite(from.getTime()) ||
		!Number.isFinite(to.getTime()) ||
		to < from
	)
		throw new Error("recurrence: invalid window");
	const { includePast = false, ...limits } = options;
	const o = parseOptions(series.rrule);
	const empty: RecurrenceProjection = { status: "complete", occurrences: [] };
	if (
		!includePast &&
		(series.exhausted || (o.count != null && (series.consumed ?? 0) >= o.count))
	)
		return empty;
	if (series.relative && !includePast) {
		if (!series.dueAt) return { status: "needs-start", occurrences: [] };
		if (
			series.exhausted ||
			(o.count != null && (series.consumed ?? 0) >= o.count) ||
			(o.until && series.dueAt > o.until)
		)
			return empty;
		return {
			status: "complete",
			occurrences:
				series.dueAt >= from && series.dueAt <= to
					? [new Date(series.dueAt)]
					: [],
		};
	}
	const anchor = seriesAnchor(
		includePast ? { ...series, relative: false } : series,
		o,
		from,
	);
	if (!anchor) return { status: "needs-start", occurrences: [] };
	if (!includePast && o.count === 1)
		return {
			status: "complete",
			occurrences:
				anchor >= from && anchor <= to && (!o.until || anchor <= o.until)
					? [new Date(anchor)]
					: [],
		};
	const fixed = fixedRule(o, anchor, includePast, limits);
	if (fixed.status === "capped")
		return { status: "capped", occurrences: [], reason: fixed.reason };
	let lower = Math.max(
		from.getTime(),
		anchor.getTime(),
		includePast ? anchor.getTime() : (series.dueAt ?? anchor).getTime(),
	);
	const consumed = includePast ? 0 : (series.consumed ?? 0);
	const eligibleConsumed = Math.max(0, consumed - (fixed.initialSlot ? 1 : 0));
	if (eligibleConsumed > 0) {
		// Determine spent ordinal boundary using the same bounded evaluator, not
		// the possibly stale due cursor. No unbounded counting or private API.
		const spent = new RRule({
			...fixed.rule.origOptions,
			count: eligibleConsumed,
		}).betweenBounded(anchor, to, true, limits);
		if (spent.status === "capped")
			return { status: "capped", occurrences: [], reason: spent.reason };
		if (spent.value.length < eligibleConsumed) return empty;
		lower = Math.max(lower, spent.value[spent.value.length - 1].getTime() + 1);
	}
	const initial =
		fixed.initialSlot &&
		consumed === 0 &&
		anchor.getTime() >= lower &&
		anchor <= to &&
		(!o.until || anchor <= o.until)
			? [new Date(anchor)]
			: [];
	if (lower > to.getTime()) return { status: "complete", occurrences: initial };
	const maxOutput = limits.maxOutput ?? 366;
	// Reserve capacity for the extra selected slot; query one candidate to
	// distinguish a genuinely complete one-slot window from truncated output.
	const result = fixed.rule.betweenBounded(new Date(lower), to, true, {
		...limits,
		maxOutput: Math.max(1, maxOutput - initial.length),
	});
	const occurrences = [...initial, ...result.value];
	if (occurrences.length > maxOutput)
		return {
			status: "capped",
			occurrences: occurrences.slice(0, maxOutput),
			reason: "output-limit",
		};
	return result.status === "capped"
		? { status: "capped", occurrences, reason: result.reason }
		: { status: "complete", occurrences };
}

/** Complete and skip share this transition; writers decide Karma effects. */
export function transitionRecurrence(
	series: RecurrenceSeries,
	actionAt: Date,
	limits: IterationLimits = {},
): RecurrenceTransition {
	validateSeries(series);
	if (!Number.isFinite(actionAt.getTime()))
		throw new Error("recurrence: invalid action date");
	if (series.exhausted) return { status: "exhausted", series };
	const o = parseOptions(series.rrule);
	const anchor = seriesAnchor(series, o, actionAt);
	if (!anchor || !series.dueAt) return { status: "needs-start", series };
	if (o.count != null && (series.consumed ?? 0) >= o.count)
		return { status: "exhausted", series: { ...series, exhausted: true } };
	const consumed = (series.consumed ?? 0) + 1;
	if (!Number.isSafeInteger(consumed))
		throw new Error("recurrence: consumption overflow");
	const adopted = { ...series, anchorAt: new Date(anchor), consumed };
	const exhausted = (): RecurrenceTransition => ({
		status: "exhausted",
		series: { ...adopted, exhausted: true },
	});
	if (o.count != null && consumed >= o.count) return exhausted();
	let next: Date | null;
	if (series.relative)
		next = nextDue(series.rrule, series.dueAt, {
			relative: true,
			completedAt: actionAt,
		});
	else {
		const fixed = fixedRule(o, anchor, false, limits);
		if (fixed.status === "capped")
			return { status: "capped", series, reason: fixed.reason };
		let currentDue = series.dueAt;
		const eligibleConsumed = Math.max(
			0,
			(series.consumed ?? 0) - (fixed.initialSlot ? 1 : 0),
		);
		if ((series.consumed ?? 0) > 0) {
			// A stale cursor must first select the first unspent eligible slot.
			// A cap aborts the action before returning any changed state.
			const current = new RRule({
				...fixed.rule.origOptions,
				count: eligibleConsumed + 1,
			}).betweenBounded(
				anchor,
				new Date(Date.UTC(9999, 11, 31, 23, 59, 59)),
				true,
				limits,
			);
			if (current.status === "capped")
				return { status: "capped", series, reason: current.reason };
			const firstUnspent = current.value[eligibleConsumed];
			if (!firstUnspent) return exhausted();
			if (firstUnspent > currentDue) currentDue = firstUnspent;
		}
		const result = fixed.rule.afterBounded(currentDue, false, limits);
		if (result.status === "capped")
			return { status: "capped", series, reason: result.reason };
		next = result.value;
	}
	if (!next || (o.until && next > o.until)) return exhausted();
	return { status: "advanced", series: { ...adopted, dueAt: next } };
}
