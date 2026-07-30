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

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

// Calendar arithmetic on a day key, never on instants. Adding 86_400_000 ms to
// a timestamp is wrong across a DST boundary -- that day is 23 or 25 hours, so
// the result lands on the same or the next-but-one local day. Date.UTC here is
// not a timezone claim: the key is already date-only, so this is pure
// year/month/day rollover with no zone involved.
export function shiftDay(dayKey: string, days: number): string {
	const parts = dayKey.match(DAY_KEY);
	if (!parts) throw new Error(`shiftDay: invalid day key "${dayKey}"`);
	const [, year, month, day] = parts;
	const at = new Date(
		Date.UTC(Number(year), Number(month) - 1, Number(day) + days),
	);
	return at.toISOString().slice(0, 10);
}
