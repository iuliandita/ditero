import { instantToWallClock } from "./zoned.ts";

// The single definition of which calendar day a user-facing "YYYY-MM-DD" key
// belongs to -- habit_log rows and karma_event rows alike: the user's LOCAL
// day, never UTC. An evening walk marked done at 21:00 in New York belongs to
// that evening, not to tomorrow -- which is what the UTC date of the same
// instant already reads. Every writer (ack, in-app done/skip, task.complete)
// and reader (streak, "done today" state, karma goal rings) must call this, or
// the two frames disagree and an evening completion scores against a day the
// user is not in. Invisible on UTC machines, wrong for everyone west of UTC in
// their evening.
export function localDay(at: Date, timeZone: string): string {
	if (!timeZone) throw new Error("localDay: missing timezone");
	return instantToWallClock(at, timeZone).date;
}
