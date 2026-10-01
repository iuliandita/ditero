import {
	projectRecurrence,
	type RecurrenceProjection,
	type RecurrenceSeries,
} from "./recurrence.ts";

export type HabitLogEntry = { date: string; status: "done" | "skipped" }; // date = "YYYY-MM-DD" (occurrence date)
export type StreakResult = {
	projectionStatus: RecurrenceProjection["status"];
	current: number;
	longest: number;
	// 0..100 over the tracked part of the window; null until one scheduled day
	// has passed, so a new habit has no score rather than a perfect or zero one.
	adherencePct: number | null;
	heatmap: { date: string; status: "done" | "skipped" | "missed" | "none" }[];
};

// Window bounds and supplied schedule dates use a UTC day-key frame, so dates
// and log dates compare as plain "YYYY-MM-DD" strings with no off-by-one.
const toYMD = (d: Date): string => d.toISOString().slice(0, 10);

const parseYMD = (s: string): Date => {
	const [y, m, d] = s.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d));
};

const addDaysYMD = (s: string, n: number): string =>
	toYMD(new Date(parseYMD(s).getTime() + n * 86_400_000));

// Tracking starts at the earlier caller lower bound or retained log. Neither
// supplies recurrence phase: the schedule anchor is a separate persisted value.
export type StreakSchedule = Omit<RecurrenceSeries, "rrule">;

export function computeStreak(
	rrule: string,
	logs: HabitLogEntry[],
	today: string, // "YYYY-MM-DD"
	windowDays = 30,
	since: string = today,
	schedule: StreakSchedule = {
		anchorAt: null,
		dueAt: null,
		consumed: null,
		relative: false,
		exhausted: false,
	},
): StreakResult {
	let tracked = since < today ? since : today;
	for (const l of logs) if (l.date < tracked) tracked = l.date;
	const windowStart = addDaysYMD(today, -(windowDays - 1));
	const start = tracked > windowStart ? tracked : windowStart;

	const projection = projectRecurrence(
		{ ...schedule, rrule },
		parseYMD(start),
		parseYMD(today),
		{ includePast: true },
	);
	if (projection.status !== "complete")
		return {
			projectionStatus: projection.status,
			current: 0,
			longest: 0,
			adherencePct: null,
			heatmap: [],
		};
	// Expected (scheduled) occurrence dates, ascending, deduped.
	const seen = new Set<string>();
	const expected: string[] = [];
	for (const d of projection.occurrences) {
		const ymd = toYMD(d);
		if (!seen.has(ymd)) {
			seen.add(ymd);
			expected.push(ymd);
		}
	}

	// Only logs landing on an expected date count; stray logs are ignored.
	const logByDate = new Map<string, HabitLogEntry["status"]>();
	for (const l of logs) {
		if (seen.has(l.date)) logByDate.set(l.date, l.status);
	}

	// current: walk backward over expected dates. done extends the run; skipped
	// and a still-pending today are neutral; a past date with no log breaks it.
	let current = 0;
	for (let i = expected.length - 1; i >= 0; i--) {
		const d = expected[i];
		const status = logByDate.get(d);
		if (status === "done") current++;
		else if (status === "skipped") continue;
		else if (d < today) break; // missed past occurrence
		// else d >= today with no log: pending, neutral -> keep walking
	}

	// longest: max run of done across the window; skips/pending neutral, misses reset.
	let longest = 0;
	let run = 0;
	for (const d of expected) {
		const status = logByDate.get(d);
		if (status === "done") {
			run++;
			if (run > longest) longest = run;
		} else if (status === "skipped") continue;
		else if (d < today) run = 0; // missed resets
		// else pending: neutral, run held
	}

	// adherence: done / (expected && date<=today), excluding skipped (planned-off)
	// and a still-pending today from BOTH numerator and denominator.
	let done = 0;
	let total = 0;
	for (const d of expected) {
		if (d > today) continue;
		const status = logByDate.get(d);
		if (status === "skipped") continue;
		if (status === "done") {
			done++;
			total++;
		} else if (d < today) total++; // missed
		// else pending today: excluded
	}
	const adherencePct = total === 0 ? null : Math.round((100 * done) / total);

	const heatmap = expected.map((d) => {
		const status = logByDate.get(d);
		if (status) return { date: d, status };
		return { date: d, status: d < today ? "missed" : "none" } as const;
	});

	return {
		projectionStatus: "complete",
		current,
		longest,
		adherencePct,
		heatmap,
	};
}
