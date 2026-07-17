// Pure focus-panel aggregation over the caller's own synced focus_session
// rows. Day boundaries use the shared UTC "YYYY-MM-DD" frame (lib/today), the
// same frame the streak/recurrence domain compares dates in.
import { dateISO } from "../../lib/today.ts";

export type FocusStatsSession = {
	kind: string;
	startedAt: number;
	durationSec: number;
};

const DAY_MS = 86_400_000;

export function focusStats(
	sessions: readonly FocusStatsSession[],
	range: "today" | "week",
	now: Date,
): { count: number; minutes: number } {
	const today = dateISO(now);
	// week = last 7 days including today; UTC days are a fixed 24h, so plain
	// timestamp arithmetic is exact.
	const start =
		range === "today" ? today : dateISO(new Date(now.getTime() - 6 * DAY_MS));

	let count = 0;
	let seconds = 0;
	for (const s of sessions) {
		if (s.kind !== "work") continue;
		const day = dateISO(new Date(s.startedAt));
		if (day < start || day > today) continue;
		count++;
		seconds += s.durationSec;
	}
	return { count, minutes: Math.round(seconds / 60) };
}
