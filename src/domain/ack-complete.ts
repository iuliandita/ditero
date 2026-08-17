// The completion an ack performs, shared by both entry points.
//
// The two paths cannot share a transaction: the public capability route owns a
// Drizzle transaction (ack_capability is deliberately absent from the Zero
// schema, so a Zero Transaction cannot touch it), while the in-app mutator runs
// inside Zero's. They share this instead -- all of the policy, none of the I/O
// -- behind a narrow store port each side implements over its own transaction.
//
// Pure by construction so it is safe for mutators.ts to import: that module is
// bundled into the web client, and pulling in node:crypto or Drizzle here would
// drag the server runtime with it.

import { karmaForCompletion } from "./karma.ts";
import { localDay } from "./local-day.ts";
import { nextDue } from "./recurrence.ts";
import { type Role, WRITE_ROLES } from "./role.ts";

// Reminder statuses a sibling termination must not overwrite: already terminal,
// or terminal for a reason acking does not undo.
export const ACK_TERMINAL_STATUSES = ["acked", "failed", "expired"] as const;

export type AckTask = {
	id: string;
	workspaceId: string;
	listKind: string;
	rrule: string | null;
	recurrenceRelative: boolean;
	dueAt: number | null;
	done: boolean;
	priority: number;
};

export type AckHabitLog = {
	id: string;
	status: string;
	karmaDelta: number;
};

export type AckStore = {
	task(taskId: string): Promise<AckTask | null>;
	role(userId: string, workspaceId: string): Promise<Role | null>;
	timezone(userId: string): Promise<string>;
	updateTask(
		id: string,
		patch: { dueAt?: number | null; done: boolean; completedAt: number | null },
	): Promise<void>;
	habitLog(habitId: string, date: string): Promise<AckHabitLog | null>;
	putHabitLog(row: {
		existingId: string | null;
		habitId: string;
		date: string;
		karmaDelta: number;
		completedAt: number;
	}): Promise<void>;
	awardKarma(
		userId: string,
		delta: number,
		reason: string,
		date: string,
	): Promise<void>;
};

// "ack_only" is the viewer outcome: the reminder is acked (escalation stops)
// but no content is written.
export type AckOutcome = "completed" | "logged" | "ack_only";

// The reminder_state shape an ack writes, shared by both entry points so a
// field cannot be set on one path and forgotten on the other -- which is
// exactly what nextAttemptAt did before this existed. Timestamps are ms here;
// the Drizzle caller maps them to Date.
export function ackedPatch(now: number, via: string, outcome: AckOutcome) {
	return {
		status: "acked" as const,
		ackedAt: now,
		ackedVia: via,
		ackOutcome: outcome,
		nextAttemptAt: null,
		deferredUntil: null,
	};
}

// Thrown when the acking user may not write. Both callers translate it into the
// uniform rejection, and the capability route lets it roll its transaction back
// so the token survives a denial that may later be fixed.
export class AckCompletionDenied extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AckCompletionDenied";
	}
}

export type AckReminder = {
	taskId: string;
	occurrenceAt: number;
	recipientUserId: string;
};

export async function completeForAck(
	store: AckStore,
	reminder: AckReminder,
	actorUserId: string,
	now: number = Date.now(),
): Promise<AckOutcome> {
	const task = await store.task(reminder.taskId);
	if (!task) throw new AckCompletionDenied("task not found");

	// The role check lives here rather than being inherited: only the mutator
	// path has Zero's context, so a caller-supplied gate would be one of two
	// implementations and could drift.
	const role = await store.role(actorUserId, task.workspaceId);
	if (!role) throw new AckCompletionDenied("access denied: not a member");
	// A viewer is a legitimate reminder recipient but cannot write content.
	// Acking is still honored so the escalation ladder stops; the task write is
	// skipped. The alternative -- an indistinguishable rejection -- would leave
	// them with no way to ever silence a repeating med reminder.
	if (!WRITE_ROLES.has(role)) return "ack_only";

	// Habit logs and karma events are both keyed to the actor's LOCAL calendar
	// day; the UTC day of the same instant is a different day every evening west
	// of UTC, which would score the completion against a day the user is not in.
	const timeZone = await store.timezone(actorUserId);

	// C22: habits are task rows in a kind=habits list and task.complete rejects
	// them outright. Med reminders and dog walks are habit-kind, so routing every
	// ack through the task path would break the button for exactly the reminders
	// that most need it.
	if (task.listKind === "habits") {
		const date = localDay(new Date(reminder.occurrenceAt), timeZone);
		const existing = await store.habitLog(task.id, date);
		// Idempotent per (habit, date), matching habit.log: an already-done date
		// must not re-award Karma.
		if (existing?.status === "done") return "logged";
		const karmaDelta = karmaForCompletion("habit", task.priority);
		await store.putHabitLog({
			existingId: existing?.id ?? null,
			habitId: task.id,
			date,
			karmaDelta,
			completedAt: now,
		});
		await store.awardKarma(actorUserId, karmaDelta, "habit_done", date);
		return "logged";
	}

	// Same shape as task.complete: an already-done non-recurring task is a
	// no-op, a recurring one advances to its next occurrence.
	if (!task.rrule && task.done) return "completed";
	if (task.rrule) {
		const next = nextDue(task.rrule, new Date(task.dueAt ?? now), {
			relative: task.recurrenceRelative,
			completedAt: new Date(now),
		});
		if (next !== null) {
			await store.updateTask(task.id, {
				dueAt: next.getTime(),
				done: false,
				completedAt: null,
			});
		} else {
			await store.updateTask(task.id, { done: true, completedAt: now });
		}
	} else {
		await store.updateTask(task.id, { done: true, completedAt: now });
	}
	await store.awardKarma(
		actorUserId,
		karmaForCompletion("task", task.priority),
		"task_complete",
		localDay(new Date(now), timeZone),
	);
	return "completed";
}
