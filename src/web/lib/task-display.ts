import type { Task } from "../../zero/schema.gen.ts";

// Priority: 0 none, 1 low, 2 med, 3 high (db default 0). Colors are the
// --priority-* design tokens (index.css); 0 renders no flag.
export const PRIORITIES = [
	{ value: 1, label: "Low", color: "text-priority-1" },
	{ value: 2, label: "Medium", color: "text-priority-2" },
	{ value: 3, label: "High", color: "text-priority-3" },
] as const;

export function priorityMeta(priority: number | null | undefined) {
	return PRIORITIES.find((p) => p.value === priority) ?? null;
}

// All-day tasks are overdue only once the calendar day has passed; timed tasks
// the moment their instant passes.
export function isOverdue(task: Pick<Task, "done" | "dueAt" | "dueAllDay">) {
	if (task.done || task.dueAt == null) return false;
	if (task.dueAllDay) {
		const due = new Date(task.dueAt);
		due.setHours(0, 0, 0, 0);
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		return due.getTime() < today.getTime();
	}
	return task.dueAt < Date.now();
}

const dayFmt = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
});
const timeFmt = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});

function sameDay(a: Date, b: Date) {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

// Short due label: Today / Tomorrow / "Mon 15", plus the time for timed tasks.
export function formatDue(
	dueAt: number,
	dueAllDay: boolean | null | undefined,
) {
	const d = new Date(dueAt);
	const now = new Date();
	const tomorrow = new Date(now);
	tomorrow.setDate(now.getDate() + 1);
	let day: string;
	if (sameDay(d, now)) day = "Today";
	else if (sameDay(d, tomorrow)) day = "Tomorrow";
	else day = dayFmt.format(d);
	return dueAllDay ? day : `${day} ${timeFmt.format(d)}`;
}

// Split epoch millis into the <input type=date>/<input type=time> string pair.
export function dueToInputs(dueAt: number | null | undefined): {
	date: string;
	time: string;
} {
	if (dueAt == null) return { date: "", time: "" };
	const d = new Date(dueAt);
	const pad = (n: number) => String(n).padStart(2, "0");
	return {
		date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
		time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
	};
}

// Recompose the date + optional time inputs into { dueAt, dueAllDay }. No date
// clears the due; date without time is all-day (local midnight).
export function inputsToDue(
	date: string,
	time: string,
): { dueAt: number | null; dueAllDay: boolean } {
	if (!date) return { dueAt: null, dueAllDay: true };
	const [y, m, d] = date.split("-").map(Number);
	if (time) {
		const [hh, mm] = time.split(":").map(Number);
		return { dueAt: new Date(y, m - 1, d, hh, mm).getTime(), dueAllDay: false };
	}
	return { dueAt: new Date(y, m - 1, d).getTime(), dueAllDay: true };
}
