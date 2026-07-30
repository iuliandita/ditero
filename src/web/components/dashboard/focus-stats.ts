// Pure focus-panel aggregation over the caller's own synced focus_session rows.
// Days are the user's LOCAL calendar days (domain/local-day), the same frame
// habit logs and karma events are written in: "focus time today" has to mean
// the user's today, not UTC's.
import { localDay, shiftDay } from "../../../domain/local-day.ts";

export type FocusStatsSession = {
	kind: string;
	startedAt: number;
	durationSec: number;
};

export function focusStats(
	sessions: readonly FocusStatsSession[],
	range: "today" | "week",
	now: Date,
	timeZone: string,
): { count: number; minutes: number } {
	const today = localDay(now, timeZone);
	// week = last 7 days including today. Counted in calendar days, not by
	// subtracting 6 x 24h: a DST day is 23 or 25 hours, so timestamp arithmetic
	// would size the window wrong on the weeks that contain a transition.
	const start = range === "today" ? today : shiftDay(today, -6);

	let count = 0;
	let seconds = 0;
	for (const s of sessions) {
		if (s.kind !== "work") continue;
		const day = localDay(new Date(s.startedAt), timeZone);
		if (day < start || day > today) continue;
		count++;
		seconds += s.durationSec;
	}
	return { count, minutes: Math.round(seconds / 60) };
}
