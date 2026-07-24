import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
import type { Task } from "../../zero/schema.gen.ts";

// Thunks: resolving `m` at module scope would freeze the import-time locale.
const PRIORITY_LABELS: Record<number, () => string> = {
	0: m.priority_none,
	1: m.priority_low,
	2: m.priority_medium,
	3: m.priority_high,
};

export function priorityLabel(priority: number | null | undefined): string {
	const level = priority ?? 0;
	return Object.hasOwn(PRIORITY_LABELS, level)
		? PRIORITY_LABELS[level]()
		: m.priority_none();
}

// Abbreviated forms for width-constrained surfaces (the 4-across picker in the
// task detail). Only the level that has a shorter form appears here; the rest
// fall through to the full label.
const PRIORITY_LABELS_SHORT: Record<number, () => string> = {
	2: m.priority_medium_short,
};

export function priorityLabelShort(
	priority: number | null | undefined,
): string {
	const level = priority ?? 0;
	return Object.hasOwn(PRIORITY_LABELS_SHORT, level)
		? PRIORITY_LABELS_SHORT[level]()
		: priorityLabel(level);
}

// Priority: 0 none, 1 low, 2 med, 3 high (db default 0). Colors are the
// --priority-* design tokens (index.css); 0 renders no flag. `label` is a
// getter for the same import-time-locale reason as the map above.
export const PRIORITIES = [
	{
		value: 1,
		get label() {
			return priorityLabel(1);
		},
		color: "text-priority-1",
	},
	{
		value: 2,
		get label() {
			return priorityLabel(2);
		},
		color: "text-priority-2",
	},
	{
		value: 3,
		get label() {
			return priorityLabel(3);
		},
		color: "text-priority-3",
	},
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
	// Built per call: a cached formatter would freeze the import-time locale.
	if (sameDay(d, now)) day = m.due_today();
	else if (sameDay(d, tomorrow)) day = m.due_tomorrow();
	else
		day = new Intl.DateTimeFormat(getLocale(), {
			month: "short",
			day: "numeric",
		}).format(d);
	if (dueAllDay) return day;
	const time = new Intl.DateTimeFormat(getLocale(), {
		hour: "numeric",
		minute: "2-digit",
	}).format(d);
	return `${day} ${time}`;
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
	const [y, mo, d] = date.split("-").map(Number);
	if (time) {
		const [hh, mm] = time.split(":").map(Number);
		return {
			dueAt: new Date(y, mo - 1, d, hh, mm).getTime(),
			dueAllDay: false,
		};
	}
	return { dueAt: new Date(y, mo - 1, d).getTime(), dueAllDay: true };
}
