import { instantToWallClock } from "./zoned.ts";

// The single definition of which calendar day a habit_log row belongs to: the
// user's LOCAL day, never UTC. An evening walk marked done at 21:00 in New York
// belongs to that evening, not to tomorrow -- which is what the UTC date of the
// same instant already reads. Every writer (ack, in-app done/skip) and reader
// (streak, "done today" state) must call this, or an acked habit shows as
// undone for the day the user is actually in. Invisible on UTC machines, wrong
// for everyone west of UTC in their evening.
export function habitDay(at: Date, timeZone: string): string {
	if (!timeZone) throw new Error("habitDay: missing timezone");
	return instantToWallClock(at, timeZone).date;
}
