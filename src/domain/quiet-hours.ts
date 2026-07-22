import { instantToWallClock, wallClockToInstant } from "./zoned.ts";

export type QuietHours = { start: string; end: string } | null;
export type QuietDecision = { kind: "fire" } | { kind: "defer"; until: Date };

function minutes(label: string, time: string): number {
	const found = /^(\d{2}):(\d{2})$/.exec(time);
	if (!found)
		throw new Error(
			`quiet-hours: malformed ${label} time "${time}", expected HH:MM`,
		);
	const hour = Number(found[1]);
	const minute = Number(found[2]);
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
		throw new Error(`quiet-hours: invalid ${label} time "${time}"`);
	}
	return hour * 60 + minute;
}

function addDays(date: string, days: number): string {
	const at = new Date(`${date}T00:00:00Z`);
	at.setUTCDate(at.getUTCDate() + days);
	return at.toISOString().slice(0, 10);
}

export function quietHoursDecision(
	quiet: QuietHours,
	timeZone: string,
	at: Date,
	urgent: boolean,
): QuietDecision {
	if (!quiet || urgent) return { kind: "fire" };

	const start = minutes("start", quiet.start);
	const end = minutes("end", quiet.end);
	if (start === end) return { kind: "fire" };

	const local = instantToWallClock(at, timeZone);
	const now = minutes("current", local.time);

	const inside =
		start > end ? now >= start || now < end : now >= start && now < end;
	if (!inside) return { kind: "fire" };

	const endDate =
		start > end && now >= start ? addDays(local.date, 1) : local.date;
	return {
		kind: "defer",
		until: wallClockToInstant(endDate, quiet.end, timeZone),
	};
}
