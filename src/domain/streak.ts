import { expand } from "./recurrence.ts";

export type HabitLogEntry = { date: string; status: "done" | "skipped" }; // date = "YYYY-MM-DD" (occurrence date)
export type StreakResult = {
	current: number;
	longest: number;
	adherencePct: number; // 0..100 over the trailing window
	heatmap: { date: string; status: "done" | "skipped" | "missed" | "none" }[];
};

// Window bounds live in the same UTC frame `expand` uses, so occurrence dates
// and log dates compare as plain "YYYY-MM-DD" strings with no off-by-one.
const toYMD = (d: Date): string => d.toISOString().slice(0, 10);

const parseYMD = (s: string): Date => {
	const [y, m, d] = s.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d));
};

const addDaysYMD = (s: string, n: number): string =>
	toYMD(new Date(parseYMD(s).getTime() + n * 86_400_000));

// Assumes phase-independent schedules (e.g. FREQ=DAILY;INTERVAL=1,
// FREQ=WEEKLY;BYDAY=...), which cover the overwhelming majority of habits.
// `expand` anchors dtstart at the window start, so for INTERVAL>1 rules the
// occurrence phase follows the window edge, not the habit's true epoch; expected
// dates may then diverge from the real schedule. True epoch-anchoring for
// interval>1 is a known limitation, deferred (it needs a start anchor threaded
// through the recurrence contract, out of scope here).
export function computeStreak(
	rrule: string,
	logs: HabitLogEntry[],
	today: string, // "YYYY-MM-DD"
	windowDays = 30,
): StreakResult {
	const start = addDaysYMD(today, -(windowDays - 1));

	// Expected (scheduled) occurrence dates, ascending, deduped.
	const seen = new Set<string>();
	const expected: string[] = [];
	for (const d of expand(rrule, parseYMD(start), parseYMD(today))) {
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
	const adherencePct = total === 0 ? 100 : Math.round((100 * done) / total);

	const heatmap = expected.map((d) => {
		const status = logByDate.get(d);
		if (status) return { date: d, status };
		return { date: d, status: d < today ? "missed" : "none" } as const;
	});

	return { current, longest, adherencePct, heatmap };
}
